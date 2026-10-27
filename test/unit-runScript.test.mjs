//runScript 之純函式與檔案層單元測試: 列類型判別、rm 目標檢查、script.txt 解析與執行前檢查、重試政策、rm 執行與暫時占用重試、dist 閘門判定、建置主檔閘門
//對應需求: R06 deploy 重試、R07 執行前檢查、R08 rm -r; 帳本(CLAUDE_rulebook.md 1.3) R10 dist 閘門、R14 rm 暫時占用重試、R17 建置主檔閘門、R20 發布列與版本遞增(loadScript 部分)
import assert from 'assert'
import fs from 'fs'
import path from 'path'
import { isSafeRmTarget, classifyLine, parseScript, loadScript, getRetryPolicy, getRetryMessage, runWithRetry, removeTarget, isPushCmd, isNetworkPushError, RM_RETRIES, RM_DELAY_MS, RM_RETRY_CODES, judgeDistStatus, checkMainFiles } from '../src/runScript.mjs'
import { GIT_ALLOWED_SUBS, GIT_LENIENT_SUBS, getGitSubcommand } from '../src/gitSubcommand.mjs'
import { mkFixturePkg, writeScript, cleanTmpRoot } from './tools/mkFixturePkg.mjs'
import { reFatal } from './tools/fatalWords.mjs'


let fdTmp = path.resolve('./test/_tmp/unit-runScript')


describe('runScript classifyLine(列類型)', function() {

    //套件區 118 個 script.txt 實際出現之各類列(2026-10-13 全庫掃描)
    let cases = [
        ['node toolg/addVersion.mjs', 'node'],
        ['node toolg/gDistRollup.mjs', 'node'],
        ['node toolfp/gDistRollup.mjs', 'node'],
        ['./node_modules/.bin/jsdoc -c .jsdoc', 'bin'],
        ['./node_modules/.bin/pkg -t win src/compile.js --output bin/wb.exe', 'bin'],
        ['git add .  -A', 'git'],
        [`git commit -m 'modify: update pks'`, 'git'],
        ['git push origin master:master', 'git'],
        ['npm run deploy', 'npm'],
        ['npm run build', 'npm'],
        ['npm publish', 'npm'],
        ['#npm test', 'comment'],
        ['#rm -r test-screenshot', 'comment'],
        ['#npx http-server ./test-mp3', 'comment'],
        ['rm -r docs', 'rm'],
    ]
    for (let [v, kind] of cases) {
        it(`'${v}' → ${kind}`, function() {
            assert.strictEqual(classifyLine(v).kind, kind)
        })
    }

    it(`'rm -r docs' 之目標為 docs`, function() {
        assert.deepStrictEqual(classifyLine('rm -r docs'), { kind: 'rm', target: 'docs' })
    })

    let unexpected = [
        ['npx something', '不支援之指令'],
        ['rm -rf docs', '不支援之指令'],
        ['rm docs', '不支援之指令'],
        ['rm -r docs dist', '不支援之指令'],
        ['rm  -r docs', '不支援之指令'],
        ['Remove-Item -Recurse docs', '不支援之指令'],
        ['node', '不支援之指令'],
        ['rm -r ../x', 'rm之目標須為套件內之相對路徑'],
        ['rm -r C:\\x', 'rm之目標須為套件內之相對路徑'],
        ['rm -r /x', 'rm之目標須為套件內之相對路徑'],
        ['rm -r .', 'rm之目標須為套件內之相對路徑'],
        ['rm -r *', 'rm之目標須為套件內之相對路徑'],
        ['rm -r docs/../..', 'rm之目標須為套件內之相對路徑'],
    ]
    for (let [v, reason] of unexpected) {
        it(`'${v}' → unexpected(${reason})`, function() {
            assert.deepStrictEqual(classifyLine(v), { kind: 'unexpected', reason })
        })
    }

    //R7.2 git 子命令白名單(2026-10-17 第 5 次執行): 允許集合 = add、commit、push 與 11 個唯讀查詢(GIT_LENIENT_SUBS ∪ {commit, push}); 其餘於執行前檢查即判非預期指令
    it('R7.2 GIT_ALLOWED_SUBS 恰為 GIT_LENIENT_SUBS(add + 12 個唯讀查詢)加上 commit、push', function() {
        assert.deepStrictEqual([...GIT_ALLOWED_SUBS].sort(), [...GIT_LENIENT_SUBS, 'commit', 'push'].sort())
        assert.strictEqual(GIT_ALLOWED_SUBS.size, GIT_LENIENT_SUBS.size + 2)
    })

    let reasonOf = (sub) => `git 子命令[${sub}]不在允許集合(add、commit、push 與唯讀查詢)`
    let gitAllowed = [
        'git add .  -A', 'git add -A', 'git commit -m \'modify: update pks\'', 'git push origin master:master', 'git push',
        'git status', 'git diff', 'git log -1', 'git show HEAD', 'git rev-parse HEAD', 'git ls-files', 'git describe', 'git rev-list HEAD', 'git cat-file -p HEAD', 'git shortlog', 'git blame a.js', 'git grep x',
        'git -C docs push', 'git -c core.autocrlf=false commit -m x', 'git --no-pager log', 'git -P diff', 'git --git-dir=.git status', 'git "push"', 'git \'commit\' -m x',
    ]
    for (let v of gitAllowed) {
        it(`R7.2 '${v}' → git(子命令在允許集合內)`, function() {
            assert.deepStrictEqual(classifyLine(v), { kind: 'git' })
        })
    }

    let gitDenied = [
        ['git pusj origin master:master', 'pusj'], ['git psuh', 'psuh'], ['git comit -m x', 'comit'], ['git ad .', 'ad'],
        ['git pull', 'pull'], ['git fetch origin', 'fetch'], ['git tag v1', 'tag'], ['git merge x', 'merge'], ['git rebase x', 'rebase'], ['git reset --hard', 'reset'], ['git checkout -- .', 'checkout'], ['git stash', 'stash'], ['git remote add a b', 'remote'], ['git clean -fd', 'clean'], ['git config user.name x', 'config'],
        ['git --version', 'unknown'], ['git -C x', 'unknown'], ['git --no-pager', 'unknown'],
        ['git PUSH', 'PUSH'], ['git Commit -m x', 'Commit'], //git 子命令區分大小寫: 大小寫錯字 git 自己會拒絕, 不當成 push/commit 放行
        ['git "pusj"', 'pusj'], ['git -C docs pusj', 'pusj'],
    ]
    for (let [v, sub] of gitDenied) {
        it(`R7.2 '${v}' → unexpected(${reasonOf(sub)})`, function() {
            assert.deepStrictEqual(classifyLine(v), { kind: 'unexpected', reason: reasonOf(sub) })
        })
    }

    it('R7.2 getGitSubcommand 的 keepCase 選項: 預設小寫(R6.1 判定用), keepCase 保留原大小寫(R7.2 白名單用)', function() {
        assert.strictEqual(getGitSubcommand('git PUSH'), 'push')
        assert.strictEqual(getGitSubcommand('git PUSH', { keepCase: true }), 'PUSH')
        assert.strictEqual(getGitSubcommand('git push', { keepCase: true }), 'push')
        assert.strictEqual(getGitSubcommand('git --version', { keepCase: true }), 'unknown')
    })

    //第 5 次外審 opus F09: 這些全域選項記號使 git 印出說明/版本/路徑後即結束(不執行後面的子命令), 不可當一般選項略過而把其後的 push 當子命令(exit 0 會被誤認推送成功)
    it('R7.2/R6.1 使 git 印出即結束之記號(-h、--help、-v、--version、無 = 之 --exec-path、--html-path、--man-path、--info-path、--list-cmds=…)→ 子命令為 unknown → 非預期指令', function() {
        for (let opt of ['-h', '--help', '-v', '--version', '--exec-path', '--html-path', '--man-path', '--info-path', '--list-cmds=main', '--list-cmds=builtins,parseopt']) {
            for (let v of [`git ${opt} push`, `git -C docs ${opt} push`, `git ${opt}`]) {
                assert.strictEqual(getGitSubcommand(v), 'unknown', v)
                assert.deepStrictEqual(classifyLine(v), { kind: 'unexpected', reason: reasonOf('unknown') }, v)
            }
        }
    })

    it('R6.1 帶 = 之 --exec-path=<路徑> 是一般全域選項(設定路徑, 不印出即結束)→ 其後的 push 仍為子命令; --no-pager、-P、--no-optional-locks 亦然', function() {
        for (let v of ['git --exec-path=/x push', 'git --exec-path=C:\\x push', 'git --no-pager push', 'git -P push', 'git --no-optional-locks push', 'git --git-dir=x push']) {
            assert.strictEqual(getGitSubcommand(v), 'push', v)
            assert.deepStrictEqual(classifyLine(v), { kind: 'git' }, v)
        }
    })

    it('R7.2 shell 控制運算子之 git 列仍先被判含運算子(原因不變); 非 git 列不受白名單影響', function() {
        assert.strictEqual(classifyLine('git status ; git push').kind, 'unexpected')
        assert.ok(/shell 控制運算子/.test(classifyLine('git status ; git push').reason))
        assert.strictEqual(classifyLine('npm publish').kind, 'npm')
        assert.strictEqual(classifyLine('node toolg/x.mjs push').kind, 'node')
    })

})


describe('runScript isSafeRmTarget(R08 rm 目標須為套件內相對路徑)', function() {

    for (let t of ['docs', 'docs/', 'dist/sub', 'dist\\sub', 'a_b-c.d', '.nyc_output']) {
        it(`'${t}' → 允許`, function() {
            assert.strictEqual(isSafeRmTarget(t), true)
        })
    }
    for (let t of ['', '.', '..', './', '../x', 'a/../b', 'a/./b', 'C:\\x', 'C:x', '/x', '\\x', '*', 'docs*', `a'b`, 'a b', '$x', '~', 'a;b', null, undefined, 1]) {
        it(`${JSON.stringify(t)} → 不允許`, function() {
            assert.strictEqual(isSafeRmTarget(t), false)
        })
    }

})


describe('runScript parseScript(既有改寫與列序號)', function() {

    it('CRLF、空行、前後空白; t1/t3 去 # 改為執行, t2 補訊息, 其他 # 為註解', function() {
        let c = `\r\n#node toolg/addVersion.mjs\r\n  node toolg/modifyReadme.mjs  \r\nrm -r docs\r\n\r\ngit commit -m 'modify: '\r\n#npm test\r\n#npm publish\r\n`
        let ls = parseScript(c, 'audit')
        assert.deepStrictEqual(ls.map((ln) => [ln.no, ln.raw, ln.cmd, ln.kind]), [
            [1, '#node toolg/addVersion.mjs', 'node toolg/addVersion.mjs', 'node'],
            [2, 'node toolg/modifyReadme.mjs', 'node toolg/modifyReadme.mjs', 'node'],
            [3, 'rm -r docs', 'rm -r docs', 'rm'],
            [4, `git commit -m 'modify: '`, `git commit -m 'modify: audit'`, 'git'],
            [5, '#npm test', '#npm test', 'comment'],
            [6, '#npm publish', 'npm publish', 'npm'],
        ])
    })

    it('msg 預設為 update pks', function() {
        let ls = parseScript(`git commit -m 'modify: '`)
        assert.strictEqual(ls[0].cmd, `git commit -m 'modify: update pks'`)
    })

    it('w-package-tools-e2e 之 script.txt 內容(含 rm -r docs)解析後無非預期指令', function() {
        let c = '\r\n#node toolg/addVersion.mjs\r\nnode toolg/modifyReadme.mjs\r\nrm -r docs\r\n./node_modules/.bin/jsdoc -c .jsdoc\r\ngit add .  -A\r\ngit commit -m \'modify: \'\r\ngit push origin master:master\r\nnpm run deploy\r\n#npm test\r\n#npm publish\r\n'
        let ls = parseScript(c)
        assert.strictEqual(ls.filter((ln) => ln.kind === 'unexpected').length, 0)
        assert.deepStrictEqual(ls.filter((ln) => ln.kind === 'rm').map((ln) => ln.target), ['docs'])
    })

})


describe('runScript getRetryPolicy(R06 只有 npm run deploy 重試)', function() {

    it(`'npm run deploy' → 重試 2 次、間隔 30 秒`, function() {
        assert.deepStrictEqual(getRetryPolicy('npm run deploy'), { times: 2, delayMs: 30000 })
    })

    for (let v of ['npm publish', 'npm run build', 'npm i --registry=http://localhost:48731/', 'npm run deploy2', 'node toolg/gDistRollup.mjs', './node_modules/.bin/jsdoc -c .jsdoc', 'git add .  -A', `git commit -m 'modify: update pks'`, 'git status', 'git pull', 'git fetch origin', 'git pusj origin master:master', 'git --version']) {
        it(`'${v}' → 不重試`, function() {
            assert.deepStrictEqual(getRetryPolicy(v), { times: 0, delayMs: 0 })
        })
    }

    //R26.1 git push 同 deploy: 重試 2 次、間隔 30 秒(是否值得重試另由 isNetworkPushError 逐錯判斷)
    for (let v of ['git push', 'git push origin master:master', 'git push --force-with-lease origin master:master', 'git -C docs push', 'git --no-pager push', 'git "push"']) {
        it(`R26.1 '${v}' → 重試 2 次、間隔 30 秒`, function() {
            assert.deepStrictEqual(getRetryPolicy(v), { times: 2, delayMs: 30000 })
        })
    }

    it('R26.1 isPushCmd: push 各形(全域選項、引號、參數)為真; 其他 git 子命令、npm run deploy、含 shell 控制運算子、非字串為假', function() {
        for (let v of ['git push', 'git push origin master:master', 'git -C x push', 'git -c a=b push', 'git "push"']) {
            assert.strictEqual(isPushCmd(v), true, v)
        }
        for (let v of ['git add .', 'git commit -m x', 'git status', 'git pull', 'git pusj', 'git --version', 'npm run deploy', 'npm publish', 'node push.mjs', 'git status ; git push', 'git push | cat', '', null, undefined, 123]) {
            assert.strictEqual(isPushCmd(v), false, String(v))
        }
    })

    it('R26.1 isNetworkPushError: 五個網路類特徵各自成立(unable to access、Could not resolve host、RPC failed、remote end hung up、Empty reply); 接受 Error 或字串', function() {
        let msgs = [
            `fatal: unable to access 'https://github.com/yuda-lyu/x.git/': Failed to connect to github.com port 443`,
            `fatal: unable to access 'https://github.com/x/y.git/': Could not resolve host: github.com`,
            'error: RPC failed; HTTP 500 curl 22 The requested URL returned error: 500',
            'fatal: the remote end hung up unexpectedly',
            `fatal: unable to access 'https://github.com/x/y.git/': Empty reply from server`,
            'error: RPC failed; curl 55 Send failure: Connection was reset',
            'Could not resolve host: github.com',
            'Empty reply from server',
        ]
        for (let m of msgs) {
            assert.strictEqual(isNetworkPushError(new Error(`[w-x] git指令失敗(code[128]): git push origin master:master\n${m}`)), true, m)
            assert.strictEqual(isNetworkPushError(`[w-x] git指令失敗(code[128]): git push\n${m}`), true, m)
        }
    })

    //第 5 次外審 sol F12: 原比對整個人類可讀訊息(含回顯的指令文字), 路徑含特徵字樣的 spawn 失敗會被重試(nTry 被放大而不撤回); 且 unable to access 亦涵蓋 401/403/憑證錯誤(非暫時性)
    it('R26.1 isNetworkPushError 只看 git 的輸出部分(訊息首行之後), 不看首行回顯的指令; 輸出含認證/權限/憑證/規則拒絕字樣者即使同時含網路特徵也不重試; HTTP 5xx 屬暫時性仍重試', function() {
        let hdr = (cmd, d = 'code[128]') => `[w-x] git指令失敗(${d}): ${cmd}\n`
        //指令文字(首行)含特徵字樣: 不算
        assert.strictEqual(isNetworkPushError(new Error(hdr('git -C C:\\RPC failed\\repo push', 'spawn[ENOENT] spawn powershell ENOENT'))), false)
        assert.strictEqual(isNetworkPushError(new Error(hdr('git push https://unable-to-access.example/Empty reply.git') + '! [rejected] master -> master (non-fast-forward)')), false)
        assert.strictEqual(isNetworkPushError(new Error(hdr('git push origin master:master'))), false) //無輸出
        assert.strictEqual(isNetworkPushError(new Error('[w-x] git指令失敗(code[128]): git push unable to access')), false) //無換行=無輸出部分
        //非暫時性(同時含 unable to access / RPC failed): 認證、權限、憑證、規則拒絕、404 找不到
        for (let m of [
            `fatal: unable to access 'https://github.com/x/y.git/': The requested URL returned error: 403`,
            `fatal: unable to access 'https://github.com/x/y.git/': The requested URL returned error: 401`,
            `fatal: unable to access 'https://github.com/x/y.git/': The requested URL returned error: 404`,
            `fatal: unable to access 'https://github.com/x/y.git/': SSL certificate problem: certificate has expired`,
            `fatal: unable to access 'x': schannel: SEC_E_UNTRUSTED_ROOT certificate verify failed`,
            `remote: Permission to x/y.git denied to someone.\nfatal: unable to access 'https://github.com/x/y.git/': The requested URL returned error: 403`,
            `remote: Invalid username or password.\nfatal: Authentication failed for 'https://github.com/x/y.git/'\nerror: RPC failed`,
            `remote: error: GH013: Repository rule violations found for refs/heads/master.\nerror: RPC failed; HTTP 500`,
            `remote: Repository not found.\nfatal: unable to access 'https://github.com/x/y.git/'`,
        ]) {
            assert.strictEqual(isNetworkPushError(new Error(hdr('git push origin master:master') + m)), false, m)
        }
        //HTTP 5xx 與連線類: 暫時性, 重試
        for (let m of [
            'error: RPC failed; HTTP 500 curl 22 The requested URL returned error: 500',
            'error: RPC failed; HTTP 502 curl 22 The requested URL returned error: 502',
            `fatal: unable to access 'https://github.com/x/y.git/': Failed to connect to github.com port 443 after 21000 ms: Couldn't connect to server`,
            `fatal: unable to access 'https://github.com/x/y.git/': OpenSSL SSL_read: Connection was reset, errno 10054`,
        ]) {
            assert.strictEqual(isNetworkPushError(new Error(hdr('git push origin master:master') + m)), true, m)
        }
    })

    it('R26.1 isNetworkPushError: 非網路類不重試——被拒(non-fast-forward、遠端規則 GH001)、認證失敗、權限、spawn、無輸出、逾時(即使輸出含網路特徵)、非 push 錯誤、null/undefined', function() {
        let msgs = [
            '[w-x] git指令失敗(code[1]): git push origin master:master\n ! [rejected]        master -> master (non-fast-forward)\nerror: failed to push some refs',
            '[w-x] git指令失敗(code[1]): git push\nremote: error: GH001: Large files detected. You may want to try Git Large File Storage',
            '[w-x] git指令失敗(code[128]): git push\nfatal: Authentication failed for \'https://github.com/x/y.git/\'',
            '[w-x] git指令失敗(code[128]): git push\ngit@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.',
            '[w-x] git指令失敗(spawn[ENOENT] spawn powershell ENOENT): git push\n',
            '[w-x] git指令失敗(code[128]): git push\nfatal: Unable to create \'C:/p/.git/index.lock\': File exists.',
            '[w-x] git指令失敗(code[1]): git push\n',
            '[w-x] 指令逾時(timeout[3600000ms]): git push\nfatal: unable to access x: Empty reply from server',
            'Error: [w-x] 指令逾時(timeout[3600000ms]): git push\nRPC failed',
        ]
        for (let m of msgs) {
            assert.strictEqual(isNetworkPushError(new Error(m)), false, m)
        }
        for (let v of [null, undefined, '', {}, 0]) {
            assert.strictEqual(isNetworkPushError(v), false, String(v))
        }
    })

    it('重試訊息含套件名、次數、間隔與指令, 且不含守望器比對之致命字樣(避免可自癒之重試被誤當中止)', function() {
        let s = getRetryMessage('w-sync-webdata', 'npm run deploy', 1, 2)
        assert.strictEqual(s, 'w-sync-webdata >>> 重試(第 1/2 次, 間隔 30 秒): npm run deploy')
        assert.strictEqual(reFatal.test(s), false)
    })

})


describe('runScript runWithRetry(R06 重試序列)', function() {

    let mkFn = (fails) => {
        let n = 0
        let errs = []
        let fn = async () => {
            n++
            if (n <= fails) {
                let e = new Error(`fail-${n}`)
                errs.push(e)
                throw e
            }
            return `ok-${n}`
        }
        return { fn, calls: () => n, errs }
    }

    it('首次即成功: 呼叫 1 次, 不呼叫 onRetry', async function() {
        let f = mkFn(0)
        let rs = []
        let r = await runWithRetry(f.fn, { times: 2, delayMs: 0, onRetry: (...a) => rs.push(a) })
        assert.strictEqual(r, 'ok-1')
        assert.strictEqual(f.calls(), 1)
        assert.strictEqual(rs.length, 0)
    })

    it('失敗 1 次後成功: 呼叫 2 次, onRetry 1 次(1/2)', async function() {
        let f = mkFn(1)
        let rs = []
        let r = await runWithRetry(f.fn, { times: 2, delayMs: 0, onRetry: (k, n, err) => rs.push([k, n, err.message]) })
        assert.strictEqual(r, 'ok-2')
        assert.strictEqual(f.calls(), 2)
        assert.deepStrictEqual(rs, [[1, 2, 'fail-1']])
    })

    it('失敗 2 次後成功: 呼叫 3 次', async function() {
        let f = mkFn(2)
        let r = await runWithRetry(f.fn, { times: 2, delayMs: 0 })
        assert.strictEqual(r, 'ok-3')
        assert.strictEqual(f.calls(), 3)
    })

    it('三次皆失敗: 呼叫 3 次後 throw 最後一次之錯誤, onRetry 2 次', async function() {
        let f = mkFn(99)
        let rs = []
        await assert.rejects(runWithRetry(f.fn, { times: 2, delayMs: 0, onRetry: (k, n) => rs.push([k, n]) }), (err) => err === f.errs[2])
        assert.strictEqual(f.calls(), 3)
        assert.deepStrictEqual(rs, [[1, 2], [2, 2]])
    })

    it('times 為 0(其他列): 失敗即 throw, 只呼叫 1 次', async function() {
        let f = mkFn(99)
        await assert.rejects(runWithRetry(f.fn, { times: 0, delayMs: 0 }), /fail-1/)
        assert.strictEqual(f.calls(), 1)
    })

    it('未給設定物件: 等同不重試', async function() {
        let f = mkFn(99)
        await assert.rejects(runWithRetry(f.fn), /fail-1/)
        assert.strictEqual(f.calls(), 1)
    })

    it('每次重試前等待 delayMs', async function() {
        let f = mkFn(1)
        let t0 = Date.now()
        await runWithRetry(f.fn, { times: 1, delayMs: 60 })
        assert.ok(Date.now() - t0 >= 50, `elapsed ${Date.now() - t0}`)
    })

})


describe('runScript removeTarget 與 loadScript(R07、R08; fixture 於 test/_tmp/unit-runScript)', function() {

    let fdPkg = path.join(fdTmp, 'pkg')
    let fdOutside = path.join(fdTmp, 'outside')

    before(function() {
        fs.rmSync(fdTmp, { recursive: true, force: true })
        mkFixturePkg(fdPkg, { docs: true })
        fs.mkdirSync(fdOutside, { recursive: true })
        fs.writeFileSync(path.join(fdOutside, 'keep.txt'), 'keep', 'utf8')
    })

    after(function() {
        fs.rmSync(fdTmp, { recursive: true, force: true })
        cleanTmpRoot()
    })

    it('目標資料夾存在(含子資料夾與檔案): 遞迴移除, 回傳 removed 且已不存在', function() {
        let r = removeTarget(fdPkg, 'docs')
        assert.strictEqual(r.state, 'removed')
        assert.strictEqual(r.path, path.join(fdPkg, 'docs'))
        assert.strictEqual(fs.existsSync(path.join(fdPkg, 'docs')), false)
    })

    it('目標不存在: 視為成功, 回傳 absent, 不 throw', function() {
        let r = removeTarget(fdPkg, 'docs')
        assert.strictEqual(r.state, 'absent')
    })

    it('目標為檔案: 移除該檔', function() {
        fs.writeFileSync(path.join(fdPkg, 'one.txt'), '1', 'utf8')
        let r = removeTarget(fdPkg, 'one.txt')
        assert.strictEqual(r.state, 'removed')
        assert.strictEqual(fs.existsSync(path.join(fdPkg, 'one.txt')), false)
    })

    it('目標在套件外(../outside)或為套件本身: throw rm指令失敗且不刪任何東西', function() {
        assert.throws(() => removeTarget(fdPkg, '../outside'), /rm指令失敗/)
        assert.throws(() => removeTarget(fdPkg, '.'), /rm指令失敗/)
        assert.throws(() => removeTarget(fdPkg, path.join(fdTmp, 'outside')), /rm指令失敗/)
        assert.strictEqual(fs.existsSync(path.join(fdOutside, 'keep.txt')), true)
        assert.strictEqual(fs.existsSync(fdPkg), true)
    })

    it('loadScript: 含非預期指令即 throw, 訊息含「非預期指令(執行前檢查」與列號、原文、原因', function() {
        writeScript(fdPkg, ['#node toolg/addVersion.mjs', 'node toolg/mark.mjs A', 'npx something', 'rm -r ../outside'])
        assert.throws(() => loadScript({ name: 'sbx-ect-test', path: fdPkg }), (err) => {
            let m = err.message
            return m.indexOf('[sbx-ect-test] 非預期指令(執行前檢查, 尚未執行任何列)') === 0 &&
                m.indexOf('第3列[npx something](不支援之指令)') >= 0 &&
                m.indexOf('第4列[rm -r ../outside](rm之目標須為套件內之相對路徑)') >= 0
        })
    })

    it('loadScript: 合法 script.txt 回傳解析後之列(含 R20 必要列: #node toolg/addVersion.mjs 與 #npm publish; 寫檔用 stubbed, 本測試不執行任何列)', function() {
        writeScript(fdPkg, ['#node toolg/addVersion.mjs', 'rm -r docs', 'npm run build-ok', '#npm publish'], { stubbed: true })
        let ls = loadScript({ name: 'sbx-ect-test', path: fdPkg })
        assert.deepStrictEqual(ls.map((ln) => ln.kind), ['node', 'rm', 'npm', 'npm'])
        assert.strictEqual(ls[3].cmd, 'npm publish') //t3 改寫: #npm publish 去 # 後執行
    })

    it('loadScript: script.txt 不存在即 throw(ENOENT)', function() {
        assert.throws(() => loadScript({ name: 'x', path: fdOutside }), /ENOENT/)
    })

})


describe('runScript removeTarget 暫時占用重試(R14; 以注入之假 rm 與 sleep 驗證重試語意, 不依賴時間)', function() {

    let fdRoot = path.resolve('./test/_tmp/unit-runScript-r14')
    let fdPkg = path.join(fdRoot, 'pkg')

    //每案重建 docs, 並回傳注入用物件: seq 為各次呼叫應拋之錯誤碼陣列('' 表該次成功), 超出後依 tail
    let mk = (seq, tail = '') => {
        fs.rmSync(path.join(fdPkg, 'docs'), { recursive: true, force: true })
        fs.mkdirSync(path.join(fdPkg, 'docs', 'sub'), { recursive: true })
        fs.writeFileSync(path.join(fdPkg, 'docs', 'sub', 'a.js'), 'a', 'utf8')
        let calls = []
        let sleeps = []
        let rm = (fp) => {
            let k = calls.length
            calls.push(fp)
            let code = k < seq.length ? seq[k] : tail
            if (code) {
                //模擬 Windows 下 fs.rmSync 之錯誤: message 與 path 內含非 ASCII 路徑之亂碼
                let err = new Error(`${code}, 假訊息: \\\\?\\C:\\opensrc\\¶}·½-JS-亂碼`)
                err.code = code
                err.syscall = 'rm'
                err.path = '\\\\?\\C:\\opensrc\\\uFFFD}\uFFFD\uFFFD-JS'
                throw err
            }
            fs.rmSync(fp, { recursive: true, force: true })
        }
        let sleep = (ms) => {
            sleeps.push(ms)
        }
        return { calls, sleeps, opt: { rm, sleep } }
    }

    before(function() {
        fs.rmSync(fdRoot, { recursive: true, force: true })
        fs.mkdirSync(fdPkg, { recursive: true })
    })

    after(function() {
        fs.rmSync(fdRoot, { recursive: true, force: true })
        cleanTmpRoot()
    })

    it('預設預算為 20 次 × 500ms, 可重試碼為 EBUSY、EPERM、ENOTEMPTY、EACCES (R14.1)', function() {
        assert.strictEqual(RM_RETRIES, 20)
        assert.strictEqual(RM_DELAY_MS, 500)
        assert.deepStrictEqual([...RM_RETRY_CODES].sort(), ['EACCES', 'EBUSY', 'ENOTEMPTY', 'EPERM'])
    })

    it('EPERM 連續 3 次後成功 → removed、retried=3、rm 呼叫 4 次、每次重試前等待預設 500ms (R14.1)', function() {
        let m = mk(['EPERM', 'EPERM', 'EPERM'])
        let r = removeTarget(fdPkg, 'docs', m.opt)
        assert.strictEqual(r.state, 'removed')
        assert.strictEqual(r.retried, 3)
        assert.strictEqual(m.calls.length, 4)
        assert.deepStrictEqual(m.sleeps, [500, 500, 500])
        assert.strictEqual(fs.existsSync(path.join(fdPkg, 'docs')), false)
    })

    it('第一次即成功 → retried=0、不等待 (R14.1)', function() {
        let m = mk([])
        let r = removeTarget(fdPkg, 'docs', m.opt)
        assert.deepStrictEqual([r.state, r.retried, m.sleeps.length], ['removed', 0, 0])
    })

    it('ENOTEMPTY 1 次、EACCES 2 次後成功 → 各重試 1、2 次 (R14.1 碼集合)', function() {
        let m1 = mk(['ENOTEMPTY'])
        assert.strictEqual(removeTarget(fdPkg, 'docs', m1.opt).retried, 1)
        let m2 = mk(['EACCES', 'EACCES'])
        assert.strictEqual(removeTarget(fdPkg, 'docs', m2.opt).retried, 2)
    })

    it('EBUSY 永久 → 用盡預算(rm 呼叫 21 次、等待 20 次)後 throw, 訊息含絕對路徑、EBUSY(rm)、已重試20次(間隔500ms)、目標可能已部分刪除 (R14.2)', function() {
        let m = mk([], 'EBUSY')
        assert.throws(() => removeTarget(fdPkg, 'docs', m.opt), (err) => {
            let s = err.message
            return s.indexOf(`rm指令失敗: 無法移除[${path.join(fdPkg, 'docs')}]: EBUSY(rm), 已重試20次(間隔500ms); 目標可能已部分刪除`) === 0
        })
        assert.strictEqual(m.calls.length, 21)
        assert.strictEqual(m.sleeps.length, 20)
        assert.strictEqual(fs.existsSync(path.join(fdPkg, 'docs')), true) //失敗不假裝移除
    })

    it('其他錯誤碼(EINVAL)不重試: rm 呼叫 1 次、不等待, 訊息為已重試0次 (R14.3)', function() {
        let m = mk([], 'EINVAL')
        assert.throws(() => removeTarget(fdPkg, 'docs', m.opt), /rm指令失敗: 無法移除\[.*\]: EINVAL\(rm\), 已重試0次\(間隔500ms\)/)
        assert.strictEqual(m.calls.length, 1)
        assert.strictEqual(m.sleeps.length, 0)
    })

    it('訊息不引用 err.message 與 err.path(其路徑為亂碼), 只用已知之絕對路徑與 err.code (R14.4)', function() {
        let m = mk([], 'EPERM')
        let msg = ''
        try {
            removeTarget(fdPkg, 'docs', { ...m.opt, retries: 1 })
        }
        catch (err) {
            msg = err.message
        }
        assert.ok(msg.indexOf('rm指令失敗') === 0, msg)
        assert.ok(msg.indexOf('¶}·½') < 0 && msg.indexOf('\uFFFD') < 0 && msg.indexOf('假訊息') < 0, msg)
        assert.ok(msg.indexOf(path.join(fdPkg, 'docs')) >= 0, msg)
    })

    it('opt.retries / opt.delayMs 覆寫預算: retries=2、delayMs=7 → 等待 [7,7]、rm 呼叫 3 次 (R14.8)', function() {
        let m = mk([], 'EBUSY')
        assert.throws(() => removeTarget(fdPkg, 'docs', { ...m.opt, retries: 2, delayMs: 7 }), /已重試2次\(間隔7ms\)/)
        assert.deepStrictEqual(m.sleeps, [7, 7])
        assert.strictEqual(m.calls.length, 3)
    })

    it('retries=0 → 第一次失敗即 throw (R14.8)', function() {
        let m = mk([], 'EPERM')
        assert.throws(() => removeTarget(fdPkg, 'docs', { ...m.opt, retries: 0 }), /已重試0次/)
        assert.strictEqual(m.calls.length, 1)
    })

    it('目標不存在 → absent 且 rm 未被呼叫; 非法目標 → throw 且 rm 未被呼叫 (R14.6 沿用 R8)', function() {
        let m = mk([])
        fs.rmSync(path.join(fdPkg, 'docs'), { recursive: true, force: true })
        assert.strictEqual(removeTarget(fdPkg, 'docs', m.opt).state, 'absent')
        assert.throws(() => removeTarget(fdPkg, '../x', m.opt), /rm指令失敗: 目標須為套件內之相對路徑/)
        assert.throws(() => removeTarget(fdPkg, '.', m.opt), /rm指令失敗/)
        assert.strictEqual(m.calls.length, 0)
    })

    it('假 rm 回報成功但目標仍在 → 回驗 throw 移除後仍存在 (R14.7)', function() {
        let m = mk([])
        let rmNoop = () => {} //不真的刪
        assert.throws(() => removeTarget(fdPkg, 'docs', { ...m.opt, rm: rmNoop }), /rm指令失敗: 移除後仍存在\[/)
    })

    it('預設刪除實作呼叫 fs.rmSync 時不帶 maxRetries 與 retryDelay (R14.5)', function() {
        mk([])
        let seen = []
        let ori = fs.rmSync
        fs.rmSync = (p, o) => {
            seen.push(o)
            return ori(p, o)
        }
        try {
            let r = removeTarget(fdPkg, 'docs')
            assert.strictEqual(r.state, 'removed')
        }
        finally {
            fs.rmSync = ori
        }
        assert.deepStrictEqual(seen, [{ recursive: true, force: true }])
    })

    it('錯誤訊息含守望字樣 rm指令失敗 (R14.2; 與 CLAUDE.md §7.4 一致)', function() {
        let m = mk([], 'EBUSY')
        assert.throws(() => removeTarget(fdPkg, 'docs', { ...m.opt, retries: 0 }), (err) => reFatal.test(err.message))
    })

})


describe('runScript judgeDistStatus(R10 dist 閘門判定; 輸入為 git status --porcelain -- dist 之輸出, 不執行 git)', function() {

    it('僅有刪除(D)而零產出 → fatal (R10)', function() {
        let r = judgeDistStatus(' D dist/a.umd.js\n D dist/a.umd.js.map\n')
        assert.strictEqual(r.fatal, true)
        assert.strictEqual(r.dels.length, 2)
        assert.strictEqual(r.outs.length, 0)
    })

    it('有刪除且有新增(??)→ 不 fatal(hash 檔名 rebuild: 舊 hash 刪、新 hash 增)', function() {
        let r = judgeDistStatus(' D dist/js/app.1111.js\n?? dist/js/app.2222.js\n')
        assert.strictEqual(r.fatal, false)
        assert.strictEqual(r.dels.length, 1)
        assert.strictEqual(r.outs.length, 1)
    })

    it('AD(曾 staged 後又被刪)算刪除 → 僅此一行時 fatal', function() {
        assert.strictEqual(judgeDistStatus('AD dist/a.js\n').fatal, true)
    })

    it('空輸出(dist 無變動或非 git 倉庫)→ 不 fatal', function() {
        let r = judgeDistStatus('')
        assert.deepStrictEqual([r.fatal, r.dels.length, r.outs.length], [false, 0, 0])
        assert.strictEqual(judgeDistStatus('\n  \n').fatal, false)
    })

    it('僅有修改(M)→ 不 fatal; 檔名含大寫 D 者不誤算刪除', function() {
        assert.strictEqual(judgeDistStatus(' M dist/a.umd.js\n').fatal, false)
        let r = judgeDistStatus(' M dist/Dockerfile\n M dist/D.js\n')
        assert.strictEqual(r.dels.length, 0)
        assert.strictEqual(r.fatal, false)
    })

})


describe('runScript checkMainFiles(R17 建置主檔閘門; fixture 於 test/_tmp/unit-runScript-r17)', function() {

    let fdRoot = path.resolve('./test/_tmp/unit-runScript-r17')
    let n = 0
    let startMs = Date.UTC(2026, 9, 16, 12, 0, 0) //固定起點; 檔案 mtime 以 utimes 設定相對於它
    let slackMs = 2000

    //建 fixture 套件: pj 為 package.json 物件(或字串原文, 或 null 表不建), files 為 { 相對路徑: { content, mtimeMs? } }; 回傳套件資料夾
    let mk = (pj, files = {}) => {
        let fd = path.join(fdRoot, `p${++n}`)
        fs.mkdirSync(fd, { recursive: true })
        if (pj !== null) {
            fs.writeFileSync(path.join(fd, 'package.json'), typeof pj === 'string' ? pj : JSON.stringify(pj), 'utf8')
        }
        for (let [rel, o] of Object.entries(files)) {
            let fp = path.join(fd, rel)
            fs.mkdirSync(path.dirname(fp), { recursive: true })
            if (o === 'dir') {
                fs.mkdirSync(fp, { recursive: true })
                continue
            }
            fs.writeFileSync(fp, o.content, 'utf8')
            if (o.mtimeMs !== undefined) {
                fs.utimesSync(fp, new Date(o.mtimeMs), new Date(o.mtimeMs))
            }
        }
        return fd
    }
    let fresh = { content: 'built', mtimeMs: startMs + 5000 }

    before(function() {
        fs.rmSync(fdRoot, { recursive: true, force: true })
        fs.mkdirSync(fdRoot, { recursive: true })
    })

    after(function() {
        fs.rmSync(fdRoot, { recursive: true, force: true })
        cleanTmpRoot()
    })

    it('main 存在、非空、於本輪重寫 → 無 fatal 無 warn (R17.1 正向)', function() {
        let fd = mk({ main: 'dist/a.umd.js' }, { 'dist/a.umd.js': fresh })
        assert.deepStrictEqual(checkMainFiles(fd, { startMs, slackMs }), { fatal: [], warn: [] })
    })

    it('main 不存在 → fatal, 訊息含欄位、相對路徑與原因 (R17.1)', function() {
        let fd = mk({ main: 'dist/a.umd.js' })
        let r = checkMainFiles(fd, { startMs, slackMs })
        assert.strictEqual(r.fatal.length, 1)
        assert.ok(r.fatal[0].indexOf('main[dist/a.umd.js]') >= 0 && r.fatal[0].indexOf('不存在') >= 0, r.fatal[0])
    })

    it('main 為空檔 → fatal 為空檔; main 為資料夾 → fatal 不是檔案 (R17.1)', function() {
        let fd1 = mk({ main: 'dist/a.js' }, { 'dist/a.js': { content: '', mtimeMs: startMs + 5000 } })
        assert.ok(checkMainFiles(fd1, { startMs, slackMs }).fatal[0].indexOf('為空檔') >= 0)
        let fd2 = mk({ main: 'dist' }, { dist: 'dir' })
        assert.ok(checkMainFiles(fd2, { startMs, slackMs }).fatal[0].indexOf('不是檔案') >= 0)
    })

    it('module、browser 同樣檢查; 多項缺失逐項列出 (R17.1)', function() {
        let fd = mk({ main: 'dist/a.js', module: 'dist/a.mjs', browser: 'dist/a.browser.js' }, { 'dist/a.js': fresh })
        let r = checkMainFiles(fd, { startMs, slackMs })
        assert.strictEqual(r.fatal.length, 2)
        assert.ok(r.fatal[0].indexOf('module[dist/a.mjs]') >= 0 && r.fatal[1].indexOf('browser[dist/a.browser.js]') >= 0, JSON.stringify(r.fatal))
    })

    it('三欄位皆無(w-package-tools、w-package-tools-e2e、w-demores 同型)→ 不檢查 (R17.3)', function() {
        let fd = mk({ name: 'x', version: '1.0.0' })
        assert.deepStrictEqual(checkMainFiles(fd, { startMs, slackMs }), { fatal: [], warn: [] })
    })

    it('欄位值非字串(browser 為物件)→ 略過 (R17.4)', function() {
        let fd = mk({ main: 'dist/a.js', browser: { 'fs': false } }, { 'dist/a.js': fresh })
        assert.deepStrictEqual(checkMainFiles(fd, { startMs, slackMs }), { fatal: [], warn: [] })
    })

    it('指向套件外 → 只留痕不中止, 且不去檢查該外部檔 (R17.4)', function() {
        let fd = mk({ main: '../outside.js' })
        let r = checkMainFiles(fd, { startMs, slackMs })
        assert.deepStrictEqual(r.fatal, [])
        assert.strictEqual(r.warn.length, 1)
        assert.ok(r.warn[0].indexOf('主檔路徑不在套件內, 略過') >= 0, r.warn[0])
    })

    it('dist 內之 main mtime 早於起點(減容差)→ 只留痕, 不 fatal (R17.2)', function() {
        let fd = mk({ main: 'dist/a.js' }, { 'dist/a.js': { content: 'old', mtimeMs: startMs - 3600000 } })
        let r = checkMainFiles(fd, { startMs, slackMs })
        assert.deepStrictEqual(r.fatal, [])
        assert.strictEqual(r.warn.length, 1)
        assert.ok(r.warn[0].indexOf('main[dist/a.js]') >= 0 && r.warn[0].indexOf('未於本輪重寫') >= 0, r.warn[0])
    })

    it('mtime 落在容差內(起點前 1 秒; 容差 2 秒)→ 不留痕; 剛好早於容差(2.5 秒)→ 留痕 (R17.2 邊界)', function() {
        let fd1 = mk({ main: 'dist/a.js' }, { 'dist/a.js': { content: 'x', mtimeMs: startMs - 1000 } })
        assert.deepStrictEqual(checkMainFiles(fd1, { startMs, slackMs }).warn, [])
        let fd2 = mk({ main: 'dist/a.js' }, { 'dist/a.js': { content: 'x', mtimeMs: startMs - 2500 } })
        assert.strictEqual(checkMainFiles(fd2, { startMs, slackMs }).warn.length, 1)
    })

    it('main 不在 dist 內(如 src/index.js)且 mtime 很舊 → 不留痕 (R17.2 只看 dist 內)', function() {
        let fd = mk({ main: 'src/index.js' }, { 'src/index.js': { content: 'x', mtimeMs: startMs - 86400000 } })
        assert.deepStrictEqual(checkMainFiles(fd, { startMs, slackMs }), { fatal: [], warn: [] })
    })

    it('package.json 不存在或無法解析 → fatal 建置主檔異常之原因 package.json 無法讀取 (R17.5)', function() {
        let fd1 = mk(null)
        assert.ok(checkMainFiles(fd1, { startMs, slackMs }).fatal[0].indexOf('package.json 無法讀取') >= 0)
        let fd2 = mk('{ 這不是 json')
        assert.ok(checkMainFiles(fd2, { startMs, slackMs }).fatal[0].indexOf('package.json 無法讀取') >= 0)
    })

    it('留痕訊息不含守望器致命字樣 (R17.6); fatal 訊息本身由 runScript 加上 建置主檔異常 前綴', function() {
        let fd1 = mk({ main: 'dist/a.js' }, { 'dist/a.js': { content: 'old', mtimeMs: startMs - 3600000 } })
        let fd2 = mk({ main: '../x.js' })
        for (let fd of [fd1, fd2]) {
            for (let s of checkMainFiles(fd, { startMs, slackMs }).warn) {
                assert.ok(!reFatal.test(s), s)
            }
        }
    })

})


describe('runScript loadScript 必要列(R20.1; fixture 於 test/_tmp/unit-runScript-r20)', function() {

    let fdRoot = path.resolve('./test/_tmp/unit-runScript-r20')
    let fdPkg = path.join(fdRoot, 'pkg')
    let pdi = { name: 'sbx-r20', path: fdPkg }

    before(function() {
        fs.rmSync(fdRoot, { recursive: true, force: true })
        mkFixturePkg(fdPkg)
    })

    after(function() {
        fs.rmSync(fdRoot, { recursive: true, force: true })
        cleanTmpRoot()
    })

    let w = (lines) => writeScript(fdPkg, lines, { stubbed: true }) //只寫檔不執行, publish 列僅供解析

    it('缺發布列 → throw script.txt缺少必要列(執行前檢查, 尚未執行任何列), 只指出缺發布列 (R20.1)', function() {
        w(['#node toolg/addVersion.mjs', 'node toolg/mark.mjs A'])
        assert.throws(() => loadScript(pdi), (err) => {
            let m = err.message
            return m.indexOf('[sbx-r20] script.txt缺少必要列(執行前檢查, 尚未執行任何列): ') === 0 && m.indexOf('發布列[npm publish]') >= 0 && m.indexOf('版本遞增列') < 0
        })
    })

    it('缺版本遞增列 → 只指出缺版本遞增列[node toolg/addVersion.mjs] (R20.1)', function() {
        w(['node toolg/mark.mjs A', '#npm publish'])
        assert.throws(() => loadScript(pdi), (err) => err.message.indexOf('版本遞增列[node toolg/addVersion.mjs]') >= 0 && err.message.indexOf('發布列') < 0)
    })

    it('兩者皆缺 → 兩者皆指出 (R20.1)', function() {
        w(['node toolg/mark.mjs A'])
        assert.throws(() => loadScript(pdi), (err) => err.message.indexOf('版本遞增列') >= 0 && err.message.indexOf('發布列') >= 0)
    })

    it('註解形(#node toolg/addVersion.mjs、#npm publish)與已去 # 形(node toolg/addVersion.mjs、npm publish)皆接受 (R20.1)', function() {
        w(['#node toolg/addVersion.mjs', '#npm publish'])
        assert.strictEqual(loadScript(pdi).length, 2)
        w(['node toolg/addVersion.mjs', 'npm publish'])
        assert.strictEqual(loadScript(pdi).length, 2)
    })

    it('帶額外參數之註解 #npm publish --tag next 不是 t3 改寫對象(runScript 不會執行它)→ 視為缺發布列 (R20.1 邊界)', function() {
        w(['#node toolg/addVersion.mjs', '#npm publish --tag next'])
        assert.throws(() => loadScript(pdi), /發布列\[npm publish\]/)
    })

    it('非預期指令之檢查優先於必要列檢查(兩者同時存在時先報非預期指令; 沿用 R7 訊息)', function() {
        w(['npx something'])
        assert.throws(() => loadScript(pdi), /^Error: \[sbx-r20\] 非預期指令\(執行前檢查/)
    })

    it('opt.checkRelease=false 時略過必要列檢查 (R20.3; 僅供測試夾具)', function() {
        w(['node toolg/mark.mjs A'])
        assert.strictEqual(loadScript(pdi, 'update pks', { checkRelease: false }).length, 1)
    })

    it('新守望字樣 script.txt缺少必要列 已納入 reFatal (R20.1)', function() {
        assert.ok(reFatal.test('[x] script.txt缺少必要列(執行前檢查'))
    })

})
