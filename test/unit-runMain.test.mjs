//runMain 單元測試(主入口 g_updateAndPublic.mjs 之離開碼; 入口檔不可執行, 故邏輯抽在 src/runMain.mjs 測試)
//對應需求(帳本 CLAUDE_rulebook.md 1.3): R16 主入口離開碼
import assert from 'assert'
import fs from 'fs'
import path from 'path'
import runMain, { exitAfterFlush } from '../src/runMain.mjs'


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


describe('runMain(R16 主入口離開碼)', function() {

    it('R16.1 publishFn resolve → 印 >>> finish all 並回傳 0', async function() {
        let code = await quiet(() => runMain(async () => {}))
        assert.strictEqual(code, 0)
        assert.deepStrictEqual(logs, ['>>> finish all'])
    })

    it('R16.1 publishFn reject(Error)→ 印出錯誤(含訊息)並回傳 1, 不印 finish all', async function() {
        let code = await quiet(() => runMain(async () => {
            throw new Error('[w-x] node指令失敗(code[1]): node toolg/gDistRollup.mjs')
        }))
        assert.strictEqual(code, 1)
        assert.ok(logs.some((s) => s.indexOf('[w-x] node指令失敗(code[1])') >= 0), JSON.stringify(logs))
        assert.ok(!logs.some((s) => s.indexOf('>>> finish all') >= 0))
    })

    it('R16.1 publishFn reject(非 Error 值, 如字串)→ 回傳 1 並印出該值', async function() {
        let code = await quiet(() => runMain(() => Promise.reject('invalid fpSrc: x'))) // eslint-disable-line prefer-promise-reject-errors
        assert.strictEqual(code, 1)
        assert.ok(logs.some((s) => s.indexOf('invalid fpSrc: x') >= 0))
    })

    it('R16.1 publishFn 同步拋錯(非 async 函數)→ 同樣回傳 1, 不 throw 出 runMain', async function() {
        let code = await quiet(() => runMain(() => {
            throw new Error('sync boom')
        }))
        assert.strictEqual(code, 1)
        assert.ok(logs.some((s) => s.indexOf('sync boom') >= 0))
    })

    it('R16.1 publishFn 回傳非 Promise 之值 → 視為成功, 回傳 0', async function() {
        assert.strictEqual(await quiet(() => runMain(() => 123)), 0)
    })

    it('R16.3 成功時 finish all 字樣完全相同(CLAUDE.md §7.3 判讀不變): 行內容恰為 ">>> finish all"', async function() {
        await quiet(() => runMain(async () => {}))
        assert.strictEqual(logs[0], '>>> finish all')
    })

    it('R16.4(第二輪 N2) exitAfterFlush: 排空 stdout/stderr 後以給定離開碼呼叫 exitFn 恰一次, 並 resolve', async function() {
        let calls = []
        await exitAfterFlush(3, (c) => calls.push(c))
        assert.deepStrictEqual(calls, [3])
        await exitAfterFlush(0, (c) => calls.push(c))
        assert.deepStrictEqual(calls, [3, 0])
    })

    it('R16.4(靜態; 入口不可執行) g_updateAndPublic.mjs 在設定 process.exitCode 之後呼叫 exitAfterFlush(process.exitCode)', function() {
        let src = fs.readFileSync(path.resolve('./g_updateAndPublic.mjs'), 'utf8')
        let code = src.split('\n').filter((s) => !/^\s*\/\//.test(s)).join('\n')
        assert.ok(/import runMain, \{ exitAfterFlush \} from '\.\/src\/runMain\.mjs'/.test(code))
        assert.ok(/process\.exitCode\s*=\s*await\s+runMain\([\s\S]*await\s+exitAfterFlush\(process\.exitCode\)/.test(code))
    })

    //R16.2 入口檔不可在測試中執行(會連動發布); 以靜態斷言確認它經由 runMain 設 process.exitCode, 且不再有「catch 只印出」之舊寫法
    it('R16.2 (靜態; 入口不可執行) g_updateAndPublic.mjs 以 process.exitCode 接 runMain 之回傳, 且無 .catch 吞掉 publishPackages 之錯誤', function() {
        let src = fs.readFileSync(path.resolve('./g_updateAndPublic.mjs'), 'utf8')
        let code = src.split('\n').filter((s) => !/^\s*\/\//.test(s)).join('\n') //去整行註解
        assert.ok(/import runMain(?:, \{ exitAfterFlush \})? from '\.\/src\/runMain\.mjs'/.test(code))
        assert.ok(/process\.exitCode\s*=\s*await\s+runMain\(/.test(code))
        assert.ok(!/\.catch\(/.test(code), '入口不得再有 .catch(只印出而離開碼為 0)')
    })

})
