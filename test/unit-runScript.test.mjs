//runScript 之純函式與檔案層單元測試: 列類型判別、rm 目標檢查、script.txt 解析與執行前檢查、重試政策、rm 執行
//對應需求: R06 deploy 重試、R07 執行前檢查、R08 rm -r
import assert from 'assert'
import fs from 'fs'
import path from 'path'
import { isSafeRmTarget, classifyLine, parseScript, loadScript, getRetryPolicy, getRetryMessage, runWithRetry, removeTarget } from '../src/runScript.mjs'
import { mkFixturePkg, writeScript, cleanTmpRoot } from './tools/mkFixturePkg.mjs'


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

    for (let v of ['npm publish', 'npm run build', 'npm i --registry=https://registry.npmjs.org/', 'npm run deploy2', 'node toolg/gDistRollup.mjs', 'git push origin master:master', './node_modules/.bin/jsdoc -c .jsdoc']) {
        it(`'${v}' → 不重試`, function() {
            assert.deepStrictEqual(getRetryPolicy(v), { times: 0, delayMs: 0 })
        })
    }

    it('重試訊息含套件名、次數、間隔與指令, 且不含守望器比對之致命字樣(避免可自癒之重試被誤當中止)', function() {
        let s = getRetryMessage('w-sync-webdata', 'npm run deploy', 1, 2)
        assert.strictEqual(s, 'w-sync-webdata >>> 重試(第 1/2 次, 間隔 30 秒): npm run deploy')
        let reFatal = /npm指令失敗|node指令失敗|rollup編譯失敗|建置產物遭刪除|npm上找不到|非預期指令|rm指令失敗|Vue packages version mismatch/
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

    it('loadScript: 合法 script.txt 回傳解析後之列', function() {
        writeScript(fdPkg, ['#node toolg/addVersion.mjs', 'rm -r docs', 'npm run build-ok'])
        let ls = loadScript({ name: 'sbx-ect-test', path: fdPkg })
        assert.deepStrictEqual(ls.map((ln) => ln.kind), ['node', 'rm', 'npm'])
    })

    it('loadScript: script.txt 不存在即 throw(ENOENT)', function() {
        assert.throws(() => loadScript({ name: 'x', path: fdOutside }), /ENOENT/)
    })

})
