//checkNpmVersion 單元測試(以 globalThis.fetch 樁, 不連網; opt.maxTry、opt.delayMs 縮短等待)
//對應需求(帳本 CLAUDE_rulebook.md 1.3): R19 例外重試(含通過條件四項不變)
import assert from 'assert'
import checkNpmVersion from '../src/checkNpmVersion.mjs'
import { reFatal } from './tools/fatalWords.mjs'


let NAME = 'sbx-pkg'
let VER = '9.9.9'
let TARBALL = `https://registry.npmjs.org/${NAME}/-/${NAME}-${VER}.tgz`

//plan 為各次檢測(attempt)之走向, 超出後沿用最後一項:
//  'ok'            四項檢查全過
//  404             metadata 回 404(傳播中)
//  'throw'         第一個 fetch(metadata)拋 TypeError('fetch failed')
//  'throwList'     versions list 的 fetch 拋例外
//  'throwHead'     tarball HEAD 的 fetch 拋例外
//  'badJson'       metadata 回 200 但 json() 拋解析例外
//  'throwString'   第一個 fetch 拋非 Error 的字串
//  'noVersion'     versions list 不含該版
//  'noTarball'     metadata 無 dist.tarball
//  'headFail'      tarball HEAD 回 404
//  'hangMeta'      metadata 的 fetch 永不落定(只在 init.signal 中止時 reject; 未帶 signal 則永遠卡住)
//  'hangList'      versions list 的 fetch 永不落定
//  'hangHead'      tarball HEAD 的 fetch 永不落定
//  'hangJson'      metadata 回 200 但 json() 永不落定(body 讀不完; 只在 signal 中止時 reject)
//  'fatalJson'     metadata 回 200 但 json() 拋 SyntaxError, 訊息引述本文且含致命字樣與換行(外來訊息)
//第 5 次外審 opus F03: 網路接縫改為顯式注入 opt.fetch(帳本 R25.2), 不再改動 globalThis.fetch——以全域身分推斷是否為樁, 委派型包裝、載入順序、迴圈比測試活得久三種寫法都會讓守衛失效
let withFetch = async (plan, fn) => {
    let oriLog = console.log
    let logs = []
    let attempts = 0
    let fetchCalls = 0
    let signals = [] //每次 fetch 是否帶了 AbortSignal
    let hang = (init) => new Promise((resolve, reject) => {
        if (init.signal) {
            init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })
        }
    })
    let stub = async (url, init = {}) => {
        fetchCalls++
        signals.push(init.signal instanceof AbortSignal)
        let isMeta = String(url).indexOf(`/${NAME}/${VER}?`) >= 0
        let isList = !isMeta && String(url).indexOf(`/${NAME}?`) >= 0
        let isHead = init.method === 'HEAD'
        if (isMeta) {
            attempts++
        }
        let p = plan[Math.min(attempts, plan.length) - 1]
        if (isMeta) {
            if (p === 'throw') {
                throw new TypeError('fetch failed')
            }
            if (p === 'throwString') {
                throw 'plain string failure' // eslint-disable-line no-throw-literal
            }
            if (p === 404) {
                return { ok: false, status: 404 }
            }
            if (p === 'hangMeta') {
                return hang(init)
            }
            if (p === 'hangJson') {
                return { ok: true, status: 200, json: () => hang(init) }
            }
            if (p === 'fatalJson') {
                return { ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token \'n\', "node指令失敗\nnpm上找不到" is not valid JSON ' + 'x'.repeat(400)) } }
            }
            if (p === 'badJson') {
                return { ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token < in JSON') } }
            }
            return { ok: true, status: 200, json: async () => (p === 'noTarball' ? { dist: {} } : { dist: { tarball: TARBALL } }) }
        }
        if (isList) {
            if (p === 'throwList') {
                throw new TypeError('fetch failed')
            }
            if (p === 'hangList') {
                return hang(init)
            }
            return { ok: true, status: 200, json: async () => ({ versions: p === 'noVersion' ? {} : { [VER]: {} } }) }
        }
        if (isHead) {
            if (p === 'throwHead') {
                throw new TypeError('fetch failed')
            }
            if (p === 'hangHead') {
                return hang(init)
            }
            return { ok: p !== 'headFail', status: p === 'headFail' ? 404 : 200 }
        }
        throw new Error(`未預期之 fetch: ${url}`)
    }
    console.log = (...args) => {
        logs.push(args.join(' '))
    }
    try {
        let result = await fn(stub)
        return { result, logs, attempts, fetchCalls, signals }
    }
    finally {
        console.log = oriLog
    }
}

let run = (plan, opt = { maxTry: 20, delayMs: 1 }) => withFetch(plan, (stub) => checkNpmVersion(NAME, VER, { ...opt, fetch: stub }))
let excLines = (logs) => logs.filter((s) => s.indexOf('檢測例外(視為尚未就緒)') === 0)


describe('checkNpmVersion 例外重試(R19)', function() {

    it('R19.3 四項檢查全過 → true, 只檢測 1 次、無例外行', async function() {
        let r = await run(['ok'])
        assert.strictEqual(r.result, true)
        assert.strictEqual(r.attempts, 1)
        assert.deepStrictEqual(excLines(r.logs), [])
    })

    it('R19.1 傳播中(404, 404)之後單次網路例外, 再恢復 → true; 例外不中止, 印一行 檢測例外(視為尚未就緒): fetch failed', async function() {
        let r = await run([404, 404, 'throw', 'ok'])
        assert.strictEqual(r.result, true)
        assert.strictEqual(r.attempts, 4)
        assert.deepStrictEqual(excLines(r.logs), ['檢測例外(視為尚未就緒): fetch failed'])
    })

    it('R19.1 例外發生在各階段(metadata、versions list、tarball HEAD、json 解析)皆視為尚未就緒並重試', async function() {
        for (let bad of ['throw', 'throwList', 'throwHead', 'badJson']) {
            let r = await run([bad, 'ok'])
            assert.strictEqual(r.result, true, bad)
            assert.strictEqual(r.attempts, 2, bad)
            assert.strictEqual(excLines(r.logs).length, 1, bad)
        }
    })

    it('R19.1 非 Error 之例外值(字串)亦視為尚未就緒, 訊息取該字串', async function() {
        let r = await run(['throwString', 'ok'])
        assert.strictEqual(r.result, true)
        assert.deepStrictEqual(excLines(r.logs), ['檢測例外(視為尚未就緒): plain string failure'])
    })

    it('R19.2 例外持續到預算耗盡 → 回傳 false(不 throw); 檢測次數 = maxTry + 1, 每次計入重試', async function() {
        let r = await run(['throw'], { maxTry: 3, delayMs: 1 })
        assert.strictEqual(r.result, false)
        assert.strictEqual(r.attempts, 4)
        assert.strictEqual(excLines(r.logs).length, 4)
    })

    it('R19.3 通過條件不變: versions list 不含該版、metadata 無 tarball、tarball HEAD 失敗 → 各自 false(不因改動而放寬)', async function() {
        for (let bad of ['noVersion', 'noTarball', 'headFail', 404]) {
            let r = await run([bad], { maxTry: 1, delayMs: 1 })
            assert.strictEqual(r.result, false, String(bad))
            assert.strictEqual(r.attempts, 2, String(bad))
            assert.deepStrictEqual(excLines(r.logs), [], String(bad)) //非例外, 不印例外行
        }
    })

    it('R19.4 例外訊息行不含守望器致命字樣(避免可自癒之重試被誤當中止)', async function() {
        let r = await run(['throw', 'throwString', 'ok'])
        for (let s of excLines(r.logs)) {
            assert.ok(!reFatal.test(s), s)
        }
        assert.strictEqual(excLines(r.logs).length, 2)
    })

    it('R19.6 三個 fetch 皆帶 AbortSignal(requestTimeoutMs 預設 30 秒)', async function() {
        let r = await run(['ok'])
        assert.deepStrictEqual(r.signals, [true, true, true])
    })

    it('R19.6 每次請求有時限: metadata、versions list、tarball HEAD 的 fetch 永不落定, 或 json body 讀不完, 皆於 requestTimeoutMs 後視為例外並重試, 之後恢復即通過', async function() {
        for (let bad of ['hangMeta', 'hangList', 'hangHead', 'hangJson']) {
            let r = await run([bad, 'ok'], { maxTry: 5, delayMs: 1, requestTimeoutMs: 60 })
            assert.strictEqual(r.result, true, bad)
            assert.strictEqual(r.attempts, 2, bad)
            assert.strictEqual(excLines(r.logs).length, 1, bad)
        }
    })

    it('R19.7 牆鐘上限: 每次檢測都卡到請求時限時, 超過 maxMs 即停止重試回傳 false(不論 maxTry 還剩多少)', async function() {
        let t0 = Date.now()
        let r = await run(['hangMeta'], { maxTry: 1000, delayMs: 5, requestTimeoutMs: 30, maxMs: 250 })
        let dt = Date.now() - t0
        assert.strictEqual(r.result, false)
        assert.ok(r.attempts >= 2 && r.attempts < 30, `attempts=${r.attempts}`)
        assert.ok(dt < 3000, `耗時 ${dt}ms`)
    })

    it('R19.4 外來訊息: SyntaxError 引述含致命字樣與換行之本文 → 例外行為單行、至多 160 字元之外來訊息, 且不命中守望器正規式', async function() {
        let r = await run(['fatalJson', 'ok'])
        assert.strictEqual(r.result, true)
        let ls = excLines(r.logs)
        assert.strictEqual(ls.length, 1)
        assert.ok(!reFatal.test(ls[0]), ls[0])
        assert.ok(ls[0].indexOf('\n') < 0)
        assert.ok(ls[0].replace(/​/g, '').length <= '檢測例外(視為尚未就緒): '.length + 160 + 1, `長度 ${ls[0].length}`)
        assert.ok(ls[0].indexOf('Unexpected token') >= 0) //仍保留可診斷之前段
    })

    it('R19.5 maxTry=0 → 只檢測 1 次; 重試之間依 delayMs 等待(delayMs=60 時 3 次檢測至少 100ms)', async function() {
        let r0 = await run([404], { maxTry: 0, delayMs: 1 })
        assert.strictEqual(r0.attempts, 1)
        let t0 = Date.now()
        let r = await run(['throw', 'throw', 'ok'], { maxTry: 5, delayMs: 60 })
        assert.strictEqual(r.result, true)
        assert.ok(Date.now() - t0 >= 100, `耗時 ${Date.now() - t0}ms`)
    })

})


//帳本 R25.2(第 5 次外審 opus F03): 網路接縫為顯式注入 opt.fetch; 測試環境下未注入即 throw, 不以 globalThis.fetch 之身分推斷
describe('checkNpmVersion 網路接縫之顯式注入(R25.2)', function() {

    it('測試環境下未給 opt.fetch → throw [testGuard] 且完全不呼叫任何 fetch(即使 globalThis.fetch 被換成委派型樁或任何函式)', async function() {
        let fetchOri = globalThis.fetch
        let calls = 0
        globalThis.fetch = async (...args) => { //委派型 spy: 記錄後轉呼叫真 fetch——原『身分比對』守衛對此失效
            calls++
            return fetchOri(...args)
        }
        try {
            await assert.rejects(checkNpmVersion(NAME, VER, { maxTry: 0, delayMs: 1 }), /^Error: \[testGuard\] 測試環境下禁止走未注入之真實執行路徑\[checkNpmVersion\]: 未注入 fetch/)
            await assert.rejects(checkNpmVersion(NAME, VER), /\[checkNpmVersion\]: 未注入 fetch/)
            await assert.rejects(checkNpmVersion(NAME, VER, { fetch: 'x' }), /未注入 fetch/)
            assert.strictEqual(calls, 0)
        }
        finally {
            globalThis.fetch = fetchOri
        }
    })

    it('opt.fetch 在入口即固定: 迴圈中途 globalThis.fetch 被換掉或還原也不影響; 全程不碰 globalThis.fetch', async function() {
        let fetchOri = globalThis.fetch
        let globalCalls = 0
        globalThis.fetch = async () => {
            globalCalls++
            throw new Error('不應呼叫 globalThis.fetch')
        }
        try {
            let r = await withFetch(['throw', 'throw', 'ok'], async (stub) => {
                let p = checkNpmVersion(NAME, VER, { maxTry: 5, delayMs: 20, fetch: stub })
                globalThis.fetch = fetchOri //迴圈進行中換回真 fetch(原守衛只在入口檢查一次, 之後的請求會用到真 fetch)
                return p
            })
            assert.strictEqual(r.result, true)
            assert.strictEqual(globalCalls, 0)
            assert.ok(r.fetchCalls >= 3)
        }
        finally {
            globalThis.fetch = fetchOri
        }
    })

})
