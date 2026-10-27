//mirrorPublish 單元測試(純函式與注入的 exec 樁; 不執行任何列、不 publish、不連網)
//對應需求(帳本 sgud/rule/rulebook.md 二 R27.4): 主倉庫 publish 成功後對每個鏡像再發布; 鏡像失敗不使套件失敗、不中止, 記為警告並於摘要列出『哪個套件版本沒發到哪個鏡像、錯誤原文(截短)』; 已存在同版本視為已同步
import assert from 'assert'
import {
    MIRROR_TIMEOUT_MS,
    buildMirrorRow,
    isAlreadyPublished,
    summarizeError,
    publishToMirrors,
    createMirrorLog,
    formatMirrorSummary
} from '../src/mirrorPublish.mjs'
import { reFatal } from './tools/fatalWords.mjs'


let MA = 'https://mirror-a.example.test/'
let MB = 'https://mirror-b.example.test/'
let pdi = { name: 'sbx-mir', path: 'C:/not-used' }

//擷取 console.log
let logs = []
let quiet = async (fn) => {
    let logOri = console.log
    logs = []
    console.log = (...args) => {
        logs.push(args.join(' '))
    }
    try {
        return await fn()
    }
    finally {
        console.log = logOri
    }
}

//仿 ectScripts 的失敗訊息: '[套件] npm指令失敗(code[1]): 指令\n輸出'
let fail = (cmd, out) => new Error(`[sbx-mir] npm指令失敗(code[1]): ${cmd}\n${out}`)


describe('buildMirrorRow(R27.4; 純函式)', function() {

    it('原發布列之後附 --registry=<鏡像>, 保留原列其他參數與全域選項', function() {
        assert.strictEqual(buildMirrorRow('npm publish', MA), `npm publish --registry=${MA}`)
        assert.strictEqual(buildMirrorRow('npm publish --tag next', MA), `npm publish --tag next --registry=${MA}`)
        assert.strictEqual(buildMirrorRow('  npm publish --access public  ', MB), `npm publish --access public --registry=${MB}`)
    })

    it('評審 F08: 原列含獨立的 `--`(其後為位置參數)→ 鏡像旗標插在 `--` 之前, 不放到位置參數區; 含 `--tag` 之 `--tag` 不誤判', function() {
        assert.strictEqual(buildMirrorRow('npm publish --', MA), `npm publish --registry=${MA} --`)
        assert.strictEqual(buildMirrorRow('npm publish --tag next -- ./pkg', MA), `npm publish --tag next --registry=${MA} -- ./pkg`)
        assert.strictEqual(buildMirrorRow('npm publish --tag next', MA), `npm publish --tag next --registry=${MA}`)
        assert.strictEqual(buildMirrorRow('npm publish --access=public', MA), `npm publish --access=public --registry=${MA}`)
    })

})


describe('isAlreadyPublished(R27.4; 純函式)', function() {

    it('npmjs 與 Verdaccio 之「已存在同版本」字樣 → true', function() {
        let yes = [
            'npm error code E403\nnpm error 403 403 Forbidden - PUT https://registry.npmjs.org/x - You cannot publish over the previously published versions: 1.0.0.',
            'npm error You cannot publish over the previously published versions: 1.0.0.',
            'npm error code E409\nnpm error 409 Conflict - PUT http://localhost:4873/x - this package is already present',
            'npm error 409 Conflict - PUT http://localhost:4873/x',
            'this package is already present',
        ]
        for (let s of yes) {
            assert.strictEqual(isAlreadyPublished(s), true, s)
        }
    })

    it('單獨的 403(權限、停權)、認證失敗、逾時、本機 EEXIST、網路錯誤 → false(不得誤判為已同步)', function() {
        let no = [
            //評審 F11: npm publish.js 另一則訊息含 "previously published version"(單數)但表示『較高版本已存在』而非本版已存在
            'npm error Cannot implicitly apply the "latest" tag because previously published version 2.0.0 is higher than the new version 1.0.0. You must specify a tag using --tag.',
            'Cannot implicitly apply the "latest" tag because previously published version 9.9.9 is higher than the new version 1.0.0.',
            'npm error code E403\nnpm error 403 403 Forbidden - PUT https://registry.npmjs.org/x - You do not have permission to publish "x". Are you logged in as the correct user?',
            'npm error code E403\nnpm error 403 Forbidden - this account has been suspended',
            'npm error code E401\nnpm error Unable to authenticate, need: Basic',
            'npm error code ETIMEDOUT',
            'npm error code ENOTFOUND',
            'EEXIST: file already exists, mkdir x',
            'timeout[600000ms]',
            '',
        ]
        for (let s of no) {
            assert.strictEqual(isAlreadyPublished(s), false, s)
        }
    })

})


describe('summarizeError(R27.4; 純函式)', function() {

    it('優先取 npm error 行(去前綴、以 | 連接); 無則取整段; 收成單行並截短', function() {
        assert.strictEqual(summarizeError('[x] msg\nnpm error code E401\nnpm error Unable to authenticate\nother'), 'code E401 | Unable to authenticate')
        assert.strictEqual(summarizeError('plain   text\nline2'), 'plain text line2')
        assert.strictEqual(summarizeError(null), '')
        let long = summarizeError('npm error ' + 'x'.repeat(1000))
        assert.ok(long.length <= 300, `長度 ${long.length}`)
    })

    it('評審 F14: 取 npm error 行時, 失敗標頭的離開狀態(code[N]、timeout[Nms]、spawn[…])仍冠於前; 逾時後仍未落定者標「狀態未知」且不被截斷', function() {
        assert.strictEqual(summarizeError('[x] npm指令失敗(code[1]): npm publish\nnpm error code E401\nnpm error Unable to authenticate'), 'code[1]: code E401 | Unable to authenticate')
        let t = summarizeError('[x] npm指令失敗(timeout[600000ms]):\n逾時後仍未落定, 子程序樹可能未清除\nnpm error ' + 'y'.repeat(1000))
        assert.ok(t.startsWith('timeout[600000ms]: (狀態未知: 逾時後仍未落定'), t)
        assert.ok(t.length <= 300, `長度 ${t.length}`)
        assert.ok(!reFatal.test(t), t)
        let s = summarizeError('[x] npm指令失敗(spawn[ENOENT] spawn powershell ENOENT): npm publish')
        assert.ok(s.indexOf('spawn[ENOENT]') >= 0, s)
        //無 npm error 行時整段原文已含標頭, 不重複冠
        assert.ok(summarizeError('timeout[1ms] plain').startsWith('timeout[1ms] plain'))
    })

    it('中和致命字樣(守望器不得把鏡像失敗誤當連動中止); 去 ANSI 控制碼', function() {
        let s = summarizeError('[sbx-mir] npm指令失敗(code[1]): npm publish\nnpm error 建置主檔異常 node指令失敗 \u001b[31mred\u001b[0m')
        assert.ok(!reFatal.test(s), s)
        assert.ok(s.indexOf('\u001b') < 0)
        let s2 = summarizeError('[sbx-mir] npm指令失敗(code[1]): npm publish\n(無 npm error 行, 取整段)')
        assert.ok(!reFatal.test(s2), s2)
    })

})


describe('publishToMirrors(R27.4)', function() {

    let mkExec = (impl = async () => '') => {
        let calls = []
        let exec = async (p, scps, o) => {
            calls.push({ scps, o })
            return impl(scps, o, calls.length)
        }
        return { calls, exec }
    }

    it('R27.4 每個鏡像各執行一次 <原列> --registry=<鏡像>, main=npm, 逾時為 MIRROR_TIMEOUT_MS(10 分鐘), 依鏡像清單順序; 全成功 → status ok', async function() {
        let m = mkExec()
        let got = []
        let rs = await quiet(() => publishToMirrors({ pdi, version: '1.2.3', v: 'npm publish', mirrors: [MA, MB], exec: m.exec, onResult: (r) => got.push(r) }))
        assert.deepStrictEqual(m.calls.map((c) => c.scps), [`npm publish --registry=${MA}`, `npm publish --registry=${MB}`])
        for (let c of m.calls) {
            assert.deepStrictEqual(c.o, { main: 'npm', timeoutMs: MIRROR_TIMEOUT_MS })
        }
        assert.strictEqual(MIRROR_TIMEOUT_MS, 600000)
        assert.deepStrictEqual(rs.map((r) => [r.mirror, r.status]), [[MA, 'ok'], [MB, 'ok']])
        assert.deepStrictEqual(got, rs)
        assert.deepStrictEqual(rs[0], { name: 'sbx-mir', version: '1.2.3', mirror: MA, status: 'ok', error: '' })
    })

    it('R27.4 鏡像失敗不 throw: 記為 failed 並印一行警告(含套件@版本、鏡像、錯誤摘要, 不含致命字樣); 其後的鏡像仍繼續發布', async function() {
        let m = mkExec(async (scps, o, n) => {
            if (n === 1) {
                throw fail(scps, 'npm error code E401\nnpm error Unable to authenticate')
            }
            return ''
        })
        let rs = await quiet(() => publishToMirrors({ pdi, version: '1.2.3', v: 'npm publish', mirrors: [MA, MB], exec: m.exec }))
        assert.strictEqual(m.calls.length, 2)
        assert.deepStrictEqual(rs.map((r) => r.status), ['failed', 'ok'])
        assert.strictEqual(rs[0].error, 'code[1]: code E401 | Unable to authenticate')
        let warn = logs.filter((s) => s.indexOf('警告: 鏡像未同步') >= 0)
        assert.strictEqual(warn.length, 1)
        assert.ok(warn[0].indexOf(`sbx-mir@1.2.3 → ${MA}: code[1]: code E401 | Unable to authenticate`) >= 0, warn[0])
        for (let s of logs) {
            assert.ok(!reFatal.test(s), s)
        }
    })

    it('R27.4 已存在同版本(npmjs 403 cannot publish over / Verdaccio 409)→ status exists, 視為已同步, 不印警告', async function() {
        let m = mkExec(async (scps, o, n) => {
            throw fail(scps, n === 1 ? 'npm error code E403\nnpm error 403 403 Forbidden - PUT https://registry.npmjs.org/x - You cannot publish over the previously published versions: 1.2.3.' : 'npm error code E409\nnpm error 409 Conflict - PUT http://localhost:4873/x - this package is already present')
        })
        let rs = await quiet(() => publishToMirrors({ pdi, version: '1.2.3', v: 'npm publish', mirrors: [MA, MB], exec: m.exec }))
        assert.deepStrictEqual(rs.map((r) => r.status), ['exists', 'exists'])
        assert.strictEqual(logs.filter((s) => s.indexOf('警告') >= 0).length, 0)
        assert.strictEqual(logs.filter((s) => s.indexOf('視為已同步') >= 0).length, 2)
    })

    it('R27.4 單獨 403(權限/停權)不是已同步 → failed', async function() {
        let m = mkExec(async (scps) => {
            throw fail(scps, 'npm error code E403\nnpm error 403 Forbidden - this account has been suspended')
        })
        let rs = await quiet(() => publishToMirrors({ pdi, version: '1.2.3', v: 'npm publish', mirrors: [MA], exec: m.exec }))
        assert.strictEqual(rs[0].status, 'failed')
    })

    it('R27.4 逾時、spawn 失敗等任何非守衛錯誤皆記為 failed 而不 throw', async function() {
        for (let e of [new Error('[sbx-mir] npm指令失敗(timeout[600000ms]): npm publish'), new Error('[sbx-mir] npm指令失敗(spawn[ENOENT] spawn powershell ENOENT): npm publish'), 'plain string', null]) {
            let m = mkExec(async () => {
                throw e
            })
            let rs = await quiet(() => publishToMirrors({ pdi, version: '1.2.3', v: 'npm publish', mirrors: [MA], exec: m.exec }))
            assert.strictEqual(rs[0].status, 'failed', String(e))
        }
    })

    it('R27.4 閘門(gate)不通過 → 該鏡像不執行 exec、記為 failed(摘要含閘門訊息, 致命字樣已中和); 閘門每個鏡像重過一次', async function() {
        let m = mkExec()
        let n = 0
        let gate = () => {
            n++
            if (n === 2) {
                throw new Error('[sbx-mir] 建置主檔異常: main[dist/a.umd.js]不存在')
            }
        }
        let rs = await quiet(() => publishToMirrors({ pdi, version: '1.2.3', v: 'npm publish', mirrors: [MA, MB], exec: m.exec, gate }))
        assert.strictEqual(n, 2)
        assert.strictEqual(m.calls.length, 1)
        assert.deepStrictEqual(rs.map((r) => r.status), ['ok', 'failed'])
        assert.ok(rs[1].error.indexOf('main[dist/a.umd.js]不存在') >= 0)
        assert.ok(!reFatal.test(rs[1].error), rs[1].error)
    })

    it('R25.2 測試環境守衛錯誤(testGuard 標記)原樣重拋, 不得被當成鏡像失敗吞掉', async function() {
        let g = Object.assign(new Error('[testGuard] blocked'), { testGuard: true })
        let m = mkExec(async () => {
            throw g
        })
        await assert.rejects(quiet(() => publishToMirrors({ pdi, version: '1.2.3', v: 'npm publish', mirrors: [MA], exec: m.exec })), (e) => e === g)
    })

    it('mirrors 為空 → 不執行任何列、回傳空陣列', async function() {
        let m = mkExec()
        let rs = await quiet(() => publishToMirrors({ pdi, version: '1.2.3', v: 'npm publish', mirrors: [], exec: m.exec }))
        assert.deepStrictEqual(rs, [])
        assert.strictEqual(m.calls.length, 0)
    })

})


describe('createMirrorLog 與 formatMirrorSummary(R27.4; 純函式)', function() {

    it('未啟用鏡像且無結果 → 無摘要', function() {
        assert.deepStrictEqual(formatMirrorSummary([], []), [])
        assert.deepStrictEqual(createMirrorLog().summarize([]), [])
    })

    it('啟用鏡像但無結果(本輪無套件需發布)→ 仍印一行摘要(0 筆), 讓使用者確認鏡像確實啟用', function() {
        let ls = formatMirrorSummary([], [MA])
        assert.strictEqual(ls.length, 1)
        assert.ok(ls[0].indexOf(`鏡像 ${MA}; 發布成功 0 筆、已存在視為已同步 0 筆、未同步 0 筆`) >= 0, ls[0])
    })

    it('摘要格式: 首行統計; 有未同步者附補發方式與逐筆『套件@版本 → 鏡像: 錯誤原文』', function() {
        let log = createMirrorLog()
        log.add({ name: 'w-a', version: '1.0.1', mirror: MA, status: 'ok', error: '' })
        log.add({ name: 'w-a', version: '1.0.1', mirror: MB, status: 'failed', error: 'code E401 | Unable to authenticate' })
        log.add({ name: 'w-b', version: '2.0.0', mirror: MA, status: 'exists', error: '' })
        log.add({ name: 'w-c', version: '3.1.0', mirror: MB, status: 'failed', error: 'ETIMEDOUT' })
        let ls = log.summarize([MA, MB])
        assert.deepStrictEqual(ls, [
            `[mirror] 摘要: 鏡像 ${MA}, ${MB}; 發布成功 1 筆、已存在視為已同步 1 筆、未同步 2 筆`,
            '[mirror] 未同步清單(補發: 於該套件目錄執行 npm publish --registry=<鏡像>):',
            `[mirror]   w-a@1.0.1 → ${MB}: code E401 | Unable to authenticate`,
            `[mirror]   w-c@3.1.0 → ${MB}: ETIMEDOUT`,
        ])
        assert.strictEqual(log.list().length, 4)
    })

    it('全部同步 → 只有首行, 不印未同步清單', function() {
        let log = createMirrorLog()
        log.add({ name: 'w-a', version: '1.0.1', mirror: MA, status: 'ok', error: '' })
        assert.strictEqual(log.summarize([MA]).length, 1)
    })

})
