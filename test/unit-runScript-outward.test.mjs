//對外列判別(純函式)、deploy 指令樣式與逾時不重試、script.txt 列序與參數形(loadScript; fixture 於 test/_tmp/unit-runScript-outward)
//對應需求(帳本 CLAUDE_rulebook.md 1.3): R9 deploy 判別與逾時不重試(外審 O-06、F05)、R10/R17.1 對外列之定義(外審 F07、F04、F05)、R20.5 列序(外審 F03、O-09)、R20.6 參數形
//所有 fixture 的 script.txt 以 stubbed:true 寫入(含 git、publish 列僅供解析, 本檔不執行任何列)
import assert from 'assert'
import fs from 'fs'
import path from 'path'
import { isReadonlyGitCmd, isLocalGitCmd, isRemoteCmd, hasShellControl, classifyLine, isDeployCmd, isPublishCmd, isAddVersionCmd, isOutwardCmd, getRetryPolicy, getRetryMessage, runWithRetry, loadScript } from '../src/runScript.mjs'
import { mkFixturePkg, writeScript, cleanTmpRoot } from './tools/mkFixturePkg.mjs'
import { reFatal } from './tools/fatalWords.mjs'


describe('runScript 對外列判別(R17.1、R10、R20.6; 純函式)', function() {

    it('唯讀 git 查詢列(R17.1 外審 F07): status、diff、log、show、rev-parse、ls-files、describe、rev-list、cat-file、shortlog、blame、grep 皆為唯讀', function() {
        for (let v of [
            'git status', 'git status --porcelain -- dist', 'git diff', 'git diff --stat HEAD', 'git log --oneline', 'git show HEAD',
            'git rev-parse HEAD', 'git ls-files', 'git describe --tags', 'git rev-list HEAD', 'git cat-file -p HEAD', 'git shortlog -sn', 'git blame x.js', 'git grep foo',
        ]) {
            assert.strictEqual(isReadonlyGitCmd(v), true, v)
            assert.strictEqual(isOutwardCmd(v), false, v)
        }
    })

    it('第二輪 N5: 帶全域選項的唯讀查詢(-C <路徑>、-c <k=v>、--no-pager、-P、--git-dir=、--work-tree=、--no-optional-locks)亦為唯讀; 同樣的選項接寫入類子命令仍是對外列', function() {
        for (let v of ['git -C . status', 'git -C ../x log -1', 'git --no-pager log -1', 'git -c core.quotepath=false status', 'git --git-dir=.git status', 'git --git-dir .git --work-tree . diff', 'git -P diff', 'git --no-optional-locks status', 'git -C . --no-pager show HEAD']) {
            assert.strictEqual(isReadonlyGitCmd(v), true, v)
            assert.strictEqual(isOutwardCmd(v), false, v)
        }
        for (let v of ['git -C . push', 'git --no-pager commit -m x', 'git -c user.name=x commit -m y', 'git -C "a b" status', 'git -C', 'git --no-pager', 'git -C . statusx']) {
            assert.strictEqual(isReadonlyGitCmd(v), false, v) //含引號路徑等無法確認者保守視為對外列
            assert.strictEqual(isOutwardCmd(v), true, v)
        }
    })

    it('非唯讀 git 列(add、commit、push、pull、tag、checkout、reset、rm、mv、clean)與近似字樣(statusx、logx、difftool)皆不是唯讀', function() {
        for (let v of ['git add .', 'git add .  -A', `git commit -m 'modify: x'`, 'git push', 'git pull', 'git tag v1', 'git checkout .', 'git reset --hard', 'git rm x', 'git mv a b', 'git clean -fd', 'git statusx', 'git logx', 'git difftool', 'git showx']) {
            assert.strictEqual(isReadonlyGitCmd(v), false, v)
            assert.strictEqual(isOutwardCmd(v), true, v)
        }
    })

    it('npm run deploy 後可接參數(R17.1、R9); deployx、deploy:prod、build 不是 deploy', function() {
        for (let v of ['npm run deploy', 'npm run deploy -- --message x', 'npm run deploy --silent']) {
            assert.strictEqual(isDeployCmd(v), true, v)
            assert.strictEqual(isOutwardCmd(v), true, v)
        }
        for (let v of ['npm run deployx', 'npm run deploy:prod', 'npm run build', 'npm publish', 'xnpm run deploy', '#npm run deploy']) {
            assert.strictEqual(isDeployCmd(v), false, v)
        }
    })

    it('外審 sol F2: npm 的等價寫法(連續空白、tab、引號、單一記號之全域選項、run-script 別名)與標準形同義, 皆為 deploy/publish 且為對外列; 近似字(deployx、publishx、run publish)仍不是', function() {
        for (let v of ['npm run  deploy', 'npm   run   deploy', 'npm\trun\tdeploy', 'npm run "deploy"', "npm run 'deploy'", 'npm "run" deploy', 'npm --silent run deploy', 'npm --loglevel=warn run deploy -- --message x', 'npm run-script deploy', 'npm run-script  deploy --silent']) {
            assert.strictEqual(isDeployCmd(v), true, v)
            assert.strictEqual(isOutwardCmd(v), true, v)
            assert.deepStrictEqual(getRetryPolicy(v), { times: 2, delayMs: 30000 }, v) //deploy 重試與判別同一來源
        }
        for (let v of ['npm  publish', 'npm "publish"', "npm 'publish' --tag x", 'npm --silent publish', 'npm\tpublish --access public']) {
            assert.strictEqual(isPublishCmd(v), true, v)
            assert.strictEqual(isOutwardCmd(v), true, v)
        }
        for (let v of ['npm run  deployx', 'npm run "deployx"', 'npm run build deploy', 'npm run build -- deploy', 'npm  publishx', 'npm  run  publish', 'npm "run" "publish"', 'npm', 'npm --silent', 'npm run']) {
            assert.strictEqual(isDeployCmd(v), false, v)
            assert.strictEqual(isPublishCmd(v), false, v)
        }
        assert.deepStrictEqual(getRetryPolicy('npm  run  deployx'), { times: 0, delayMs: 0 })
    })

    it('npm publish 後可接參數(R17.1、R20.6); publishx、run publish、註解形不是發布列', function() {
        for (let v of ['npm publish', 'npm publish --tag next', 'npm publish --access public']) {
            assert.strictEqual(isPublishCmd(v), true, v)
            assert.strictEqual(isOutwardCmd(v), true, v)
        }
        for (let v of ['npm publishx', 'npm run publish', '#npm publish', 'npm pack', 'npm run deploy']) {
            assert.strictEqual(isPublishCmd(v), false, v)
        }
    })

    it('node toolg/addVersion.mjs 後可接參數(R20.6); addVersionX.mjs、.mjs.bak、註解形、其他 node 列不是版本遞增列', function() {
        for (let v of ['node toolg/addVersion.mjs', 'node toolg/addVersion.mjs --dry']) {
            assert.strictEqual(isAddVersionCmd(v), true, v)
        }
        for (let v of ['node toolg/addVersionX.mjs', 'node toolg/addVersion.mjs.bak', '#node toolg/addVersion.mjs', 'node toolg/mark.mjs', 'node toolg/addVersion.mjs2']) {
            assert.strictEqual(isAddVersionCmd(v), false, v)
        }
    })

    it('建置列(node、.bin、npm run build、rm -r)與空字串、非字串輸入不是對外列', function() {
        for (let v of ['node toolg/build.mjs', './node_modules/.bin/jsdoc -c .jsdoc', 'npm run build', 'npm i', 'rm -r docs', '', null, undefined]) {
            assert.strictEqual(isOutwardCmd(v), false, String(v))
        }
    })

})


describe('runScript 本機 git 列與遠端列判別、shell 控制運算子(R21 不可回頭點、R10 唯讀判別防逃逸; 純函式)', function() {

    it('hasShellControl: 引號外之 ; | & < > ( ) { }、換行、反引號、$( 皆為 shell 控制運算子', function() {
        for (let v of ['git status ; git add .', 'git status;git add .', 'git log | more', 'git status && git push', 'git status & git push', 'git log > out.txt', 'git log < in.txt', 'git commit -m "$(npm publish)"', 'git status `npm publish`', 'node a.mjs\nnpm publish', 'git log (npm publish)', 'git log {x}', 'git status || git push', 'git commit -m "a`b"', 'git $env:SUB push', 'git status $x', 'git commit -m "cost $5"']) {
            assert.strictEqual(hasShellControl(v), true, JSON.stringify(v))
        }
    })

    it('hasShellControl: 單引號內任何字元、雙引號內之 ; | & < > ( ) 皆不算; 正式 script.txt 的實際列不含運算子', function() {
        for (let v of [
            'git add .  -A', `git commit -m 'modify: update pks'`, 'git push origin master:master', 'npm run deploy', 'npm publish', 'node toolg/addVersion.mjs', './node_modules/.bin/jsdoc -c .jsdoc', 'npm run build',
            `git commit -m 'a; b | c && d > e $(f) \`g\` (h)'`, `git commit -m '$HOME $env:X'`, 'git commit -m "a; b | c && d > e (h)"', 'git -C "a b" status', `git log --format='%h (%an)'`, '', null, undefined,
        ]) {
            assert.strictEqual(hasShellControl(v), false, String(v))
        }
    })

    it('外審 sol F1: 唯讀前綴後接 shell 運算子的列不是唯讀(isReadonlyGitCmd 假、isOutwardCmd 真、isRemoteCmd 真), 不得漏掉閘門與遠端列判斷', function() {
        for (let v of ['git status ; git add . ; git commit -m release ; git push', 'git status ; npm publish', 'git --no-pager log -1 ; git push', 'git status && git push origin master:master', 'git log | git push', 'git diff > x.patch', 'git status `git push`']) {
            assert.strictEqual(isReadonlyGitCmd(v), false, v)
            assert.strictEqual(isOutwardCmd(v), true, v)
            assert.strictEqual(isLocalGitCmd(v), false, v)
            assert.strictEqual(isRemoteCmd(v), true, v)
        }
    })

    it('isLocalGitCmd: git add、git commit(子命令前可有全域選項)為本機 git; push、tag、fetch、pull、remote、checkout、reset、近似字、含運算子者不是', function() {
        for (let v of ['git add .', 'git add .  -A', `git commit -m 'modify: update pks'`, 'git commit', 'git -C . add .', 'git --no-pager commit -m x', 'git -c user.name=x commit -m y', 'git --git-dir=.git --work-tree=. add -A']) {
            assert.strictEqual(isLocalGitCmd(v), true, v)
            assert.strictEqual(isOutwardCmd(v), true, v) //仍是對外列(閘門照觸發)
            assert.strictEqual(isRemoteCmd(v), false, v) //但不是遠端列
        }
        for (let v of ['git push', 'git push origin master:master', 'git -C . push', 'git tag v1', 'git fetch', 'git pull', 'git remote add x y', 'git checkout .', 'git reset --hard', 'git rm x', 'git adds', 'git addx .', 'git committed', 'git commitx', 'git add . ; git push', 'git commit -m x && git push', 'git -C "a b" add .', 'git status', 'git log', 'npm publish', 'node a.mjs', '', null, undefined]) {
            assert.strictEqual(isLocalGitCmd(v), false, String(v))
        }
    })

    it('isRemoteCmd: git push、npm run deploy、npm publish(含等價寫法)與無法確認為本機之非唯讀 git 是遠端列; add/commit、唯讀 git、建置列、rm -r 不是', function() {
        for (let v of ['git push', 'git push origin master:master', 'git -C . push', 'git --no-pager push', 'npm run deploy', 'npm run deploy -- --message x', 'npm run  deploy', 'npm publish', 'npm publish --tag next', 'npm  publish', 'git tag v1', 'git fetch origin', 'git remote add a b', 'git -C "a b" push']) {
            assert.strictEqual(isRemoteCmd(v), true, v)
        }
        for (let v of ['git add .  -A', `git commit -m 'modify: update pks'`, 'git status', 'git -C . log -1', 'node toolg/build.mjs', './node_modules/.bin/jsdoc -c .jsdoc', 'npm run build', 'npm i', 'rm -r docs', '#npm publish', '', null, undefined]) {
            assert.strictEqual(isRemoteCmd(v), false, String(v))
        }
    })

    it('classifyLine: node/bin/git/npm 列含 shell 控制運算子 → unexpected(原因含「shell 控制運算子」), 其餘照舊; 註解與 rm -r 不受影響', function() {
        for (let v of ['node toolg/a.mjs ; npm publish', 'node toolg/a.mjs && git push', 'git status ; git add .', 'npm run build | tee x', './node_modules/.bin/jsdoc > x.txt', `git commit -m "$(npm publish)"`, 'git push `x`', 'node toolg/a.mjs (x)']) {
            let r = classifyLine(v)
            assert.strictEqual(r.kind, 'unexpected', v)
            assert.ok(r.reason.indexOf('shell 控制運算子') >= 0, `${v}: ${r.reason}`)
        }
        assert.deepStrictEqual(classifyLine('node toolg/a.mjs --flag=1'), { kind: 'node' })
        assert.deepStrictEqual(classifyLine(`git commit -m 'modify: update pks'`), { kind: 'git' })
        assert.deepStrictEqual(classifyLine('git add .  -A'), { kind: 'git' })
        assert.deepStrictEqual(classifyLine('git push origin master:master'), { kind: 'git' })
        assert.deepStrictEqual(classifyLine('npm run deploy'), { kind: 'npm' })
        assert.deepStrictEqual(classifyLine('./node_modules/.bin/jsdoc -c .jsdoc'), { kind: 'bin' })
        assert.deepStrictEqual(classifyLine('#node a.mjs ; npm publish'), { kind: 'comment' })
        assert.deepStrictEqual(classifyLine('rm -r docs'), { kind: 'rm', target: 'docs' })
    })

})


describe('runScript getRetryPolicy 與 runWithRetry(R9: deploy 判別為指令樣式; 逾時不重試)', function() {

    it('npm run deploy 後接參數亦重試 2 次、間隔 30 秒; deployx、deploy:prod 與其他列不重試 (R9 外審 O-06)', function() {
        for (let v of ['npm run deploy', 'npm run deploy -- --message x', 'git push', 'git push origin master:master']) { //git push: R26.1(2026-10-17 起同 deploy 重試; 是否為網路類失敗另由 isNetworkPushError 判斷)
            assert.deepStrictEqual(getRetryPolicy(v), { times: 2, delayMs: 30000 }, v)
        }
        for (let v of ['npm run deployx', 'npm run deploy:prod', 'npm publish', 'git pull', 'git add .', 'git commit -m x', 'node toolg/x.mjs', 'npm run build']) {
            assert.deepStrictEqual(getRetryPolicy(v), { times: 0, delayMs: 0 }, v)
        }
    })

    it('重試訊息對帶參數之 deploy 同樣顯示 30 秒間隔, 且不含致命字樣', function() {
        let s = getRetryMessage('w-x', 'npm run deploy -- --message x', 1, 2)
        assert.strictEqual(s, 'w-x >>> 重試(第 1/2 次, 間隔 30 秒): npm run deploy -- --message x')
        assert.ok(!reFatal.test(s))
    })

    let make = (errs) => {
        let calls = 0
        return { fn: async () => { let e = errs[calls++]; if (e) { throw e } return 'ok' }, calls: () => calls }
    }

    it('shouldRetry 回 false 的錯誤(逾時)→ 第一次失敗即 throw 該錯誤, 只呼叫 1 次, onRetry 不被呼叫 (R9 逾時不重試)', async function() {
        let m = make([new Error('[x] npm指令失敗(timeout[60ms]): npm run deploy'), null])
        let retries = []
        await assert.rejects(runWithRetry(m.fn, { times: 2, delayMs: 1, onRetry: (k) => retries.push(k), shouldRetry: (err) => !/timeout\[/.test(err.message) }), /timeout\[60ms\]/)
        assert.strictEqual(m.calls(), 1)
        assert.deepStrictEqual(retries, [])
    })

    it('shouldRetry 回 true(其他失敗)→ 照常重試至成功; 未給 shouldRetry 等同一律重試 (R9 既有行為不變)', async function() {
        let m1 = make([new Error('code[1]'), null])
        assert.strictEqual(await runWithRetry(m1.fn, { times: 2, delayMs: 1, shouldRetry: () => true }), 'ok')
        assert.strictEqual(m1.calls(), 2)
        let m2 = make([new Error('a'), new Error('b'), null])
        assert.strictEqual(await runWithRetry(m2.fn, { times: 2, delayMs: 1 }), 'ok')
        assert.strictEqual(m2.calls(), 3)
    })

    it('shouldRetry 逐錯判斷: 第一次非逾時(重試)、第二次逾時(不再重試, throw 第二次之錯誤)', async function() {
        let m = make([new Error('code[1]'), new Error('timeout[60ms]'), null])
        await assert.rejects(runWithRetry(m.fn, { times: 2, delayMs: 1, shouldRetry: (err) => !/timeout\[/.test(err.message) }), /timeout\[60ms\]/)
        assert.strictEqual(m.calls(), 2)
    })

})


describe('runScript loadScript 列序與參數形(R20.5、R20.6; fixture 於 test/_tmp/unit-runScript-outward)', function() {

    let fdRoot = path.resolve('./test/_tmp/unit-runScript-outward')
    let fdPkg = path.join(fdRoot, 'pkg')
    let pdi = { name: 'sbx-r205', path: fdPkg }
    let w = (lines) => writeScript(fdPkg, lines, { stubbed: true })

    before(function() {
        fs.rmSync(fdRoot, { recursive: true, force: true })
        mkFixturePkg(fdPkg)
    })

    after(function() {
        fs.rmSync(fdRoot, { recursive: true, force: true })
        cleanTmpRoot()
    })

    it('版本遞增列與發布列接受後接參數的形態 (R20.6)', function() {
        w(['node toolg/addVersion.mjs --dry', 'npm publish --tag next'])
        assert.strictEqual(loadScript(pdi).length, 2)
    })

    it('版本遞增列在首個對外列之前 → 通過: 唯讀 git 查詢可在其前; 之後有 add、commit、push、deploy 皆可 (R20.5)', function() {
        w(['git status', '#node toolg/addVersion.mjs', 'node toolg/mark.mjs A', 'git add .', `git commit -m 'modify: '`, 'git push', 'npm run deploy', '#npm publish'])
        assert.strictEqual(loadScript(pdi).length, 8)
    })

    it('版本遞增列在 git add 之後 → throw script.txt列序不符(執行前檢查, 尚未執行任何列), 指出首個對外列 (R20.5)', function() {
        w(['git add .', '#node toolg/addVersion.mjs', '#npm publish'])
        assert.throws(() => loadScript(pdi), (err) => err.message === '[sbx-r205] script.txt列序不符(執行前檢查, 尚未執行任何列): 版本遞增列[node toolg/addVersion.mjs]須在首個對外列[git add .]之前')
    })

    it('版本遞增列在 npm publish 之後(發布列本身是對外列)→ throw, 首個對外列為 npm publish (R20.5)', function() {
        w(['#npm publish', '#node toolg/addVersion.mjs'])
        assert.throws(() => loadScript(pdi), /首個對外列\[npm publish\]之前/)
    })

    it('版本遞增列在 npm run deploy 之後 → throw, 訊息引述帶參數之完整指令 (R20.5)', function() {
        w(['npm run deploy -- --message x', '#node toolg/addVersion.mjs', '#npm publish'])
        assert.throws(() => loadScript(pdi), /首個對外列\[npm run deploy -- --message x\]之前/)
    })

    it('以首個版本遞增列為準: 先有一個在對外列之前者即通過(其後再有一個不影響) (R20.5)', function() {
        w(['#node toolg/addVersion.mjs', 'git add .', 'node toolg/addVersion.mjs', '#npm publish'])
        assert.strictEqual(loadScript(pdi).length, 4)
    })

    it('註解列(#git add .)不是對外列 (R20.5)', function() {
        w(['#git add .', '#node toolg/addVersion.mjs', '#npm publish'])
        assert.strictEqual(loadScript(pdi).length, 3)
    })

    it('必要列缺漏之檢查先於列序檢查(缺版本遞增列時報缺少必要列, 不報列序) (R20.1 先於 R20.5)', function() {
        w(['git add .', '#npm publish'])
        assert.throws(() => loadScript(pdi), /script\.txt缺少必要列/)
    })

    it('opt.checkRelease=false 略過列序檢查 (R20.3)', function() {
        w(['git add .', '#node toolg/addVersion.mjs', '#npm publish'])
        assert.strictEqual(loadScript(pdi, 'update pks', { checkRelease: false }).length, 3)
    })

    it('新守望字樣 script.txt列序不符 已納入 reFatal (R20.5)', function() {
        assert.ok(reFatal.test('[x] script.txt列序不符(執行前檢查'))
    })

})
