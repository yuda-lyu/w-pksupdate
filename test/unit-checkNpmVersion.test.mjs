//checkNpmVersion 單元測試(以 globalThis.fetch 樁, 不連網; opt.maxTry、opt.delayMs 縮短等待)
//對應需求(帳本 CLAUDE_rulebook.md 1.3): R19 例外重試(含通過條件四項不變)
import assert from 'assert'
import checkNpmVersion, { AUTH_FAIL_MAX } from '../src/checkNpmVersion.mjs'
import { reFatal } from './tools/fatalWords.mjs'


//帳本 R27.3: 倉庫由 opt.registry 指定(虛構之本機位址, 不連網); 不再有寫死之 npmjs
let REG = 'http://localhost:48731/'
let NAME = 'sbx-pkg'
let VER = '9.9.9'
let TARBALL = `${REG}${NAME}/-/${NAME}-${VER}.tgz`

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
    let urls = [] //每次 fetch 之網址(R27.3: 驗證請求都打指定倉庫)
    let signals = [] //每次 fetch 是否帶了 AbortSignal
    let hang = (init) => new Promise((resolve, reject) => {
        if (init.signal) {
            init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })
        }
    })
    let stub = async (url, init = {}) => {
        fetchCalls++
        urls.push(String(url))
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
            if (typeof p === 'number') {
                return { ok: false, status: p } //404(傳播中)、401/403(認證類, R27.3)等任意狀態碼
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
            if (p === 'list403') {
                return { ok: false, status: 403 }
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
            if (p === 'head401') {
                return { ok: false, status: 401 }
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
        return { result, logs, attempts, fetchCalls, urls, signals }
    }
    finally {
        console.log = oriLog
    }
}

let run = (plan, opt = { maxTry: 20, delayMs: 1 }) => withFetch(plan, (stub) => checkNpmVersion(NAME, VER, { registry: REG, ...opt, fetch: stub }))
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
                let p = checkNpmVersion(NAME, VER, { registry: REG, maxTry: 5, delayMs: 20, fetch: stub })
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


//帳本 R27.3: 上架確認打 opt.registry 指定之主倉庫(原寫死 https://registry.npmjs.org/ , 改走私有倉庫後發到私有倉庫之版本永遠查不到而一直等)
describe('checkNpmVersion 倉庫位址(R27.3)', function() {

    it('R27.3 四項檢查之請求全部打指定倉庫: <倉庫><name>/<version>?t=、<倉庫><name>?t=、tarball(取自 metadata)HEAD; 沒有任何請求打 npmjs', async function() {
        let r = await run(['ok'])
        assert.strictEqual(r.result, true)
        assert.strictEqual(r.urls.length, 3)
        assert.ok(r.urls[0].startsWith(`${REG}${NAME}/${VER}?t=`), r.urls[0])
        assert.ok(r.urls[1].startsWith(`${REG}${NAME}?t=`), r.urls[1])
        assert.strictEqual(r.urls[2], TARBALL)
        assert.ok(!r.urls.some((u) => u.indexOf('npmjs.org') >= 0), JSON.stringify(r.urls))
    })

    it('R27.2 位址正規化: 結尾無斜線、主機大寫、帶預設埠者皆正規化後再組網址(不出現雙斜線或缺斜線)', async function() {
        for (let reg of ['http://localhost:48731', 'HTTP://LOCALHOST:48731/', '  http://localhost:48731/  ']) {
            let r = await run(['ok'], { registry: reg, maxTry: 0, delayMs: 1 })
            assert.ok(r.urls[0].startsWith(`${REG}${NAME}/${VER}?t=`), `${reg} → ${r.urls[0]}`)
            assert.ok(r.urls[1].startsWith(`${REG}${NAME}?t=`), `${reg} → ${r.urls[1]}`)
        }
        let r2 = await run(['ok'], { registry: 'https://registry.example.test:443/sub/', maxTry: 0, delayMs: 1 })
        assert.ok(r2.urls[0].startsWith(`https://registry.example.test/sub/${NAME}/${VER}?t=`), r2.urls[0]) //倉庫位址可含路徑前綴; https 預設埠被標準化掉
    })

    it('R27.3 未給 opt.registry → throw [registry] 且完全不發請求(不退回預設倉庫)', async function() {
        let r = null
        await assert.rejects(withFetch(['ok'], async (stub) => {
            r = stub
            return checkNpmVersion(NAME, VER, { maxTry: 0, delayMs: 1, fetch: stub })
        }), /^Error: \[registry\] checkNpmVersion 需 opt\.registry/)
        assert.ok(r)
        for (let bad of ['', '   ', null, undefined, 0]) {
            let res = await withFetch(['ok'], async (stub) => {
                try {
                    await checkNpmVersion(NAME, VER, { registry: bad, maxTry: 0, delayMs: 1, fetch: stub })
                    return 'no-throw'
                }
                catch (err) {
                    return err.message
                }
            })
            assert.ok(/^\[registry\] checkNpmVersion 需 opt\.registry/.test(res.result), JSON.stringify(bad))
            assert.strictEqual(res.fetchCalls, 0, JSON.stringify(bad))
        }
    })

    it('R27.2 非 http(s) 或含帳密/查詢字串/空白/特殊字元之位址 → throw [registry] 且不發請求', async function() {
        for (let bad of ['ftp://localhost/', 'file:///c:/x/', 'localhost:48731', 'registry.example.test', 'http://user:pw@localhost:48731/', 'http://localhost:48731/?a=1', 'http://localhost:48731/#x', 'http://local host/', "http://localhost/'x", 'http://localhost/$(x)', 'http://localhost/;x', 'http://[::1]:48731/']) {
            let res = await withFetch(['ok'], async (stub) => {
                try {
                    await checkNpmVersion(NAME, VER, { registry: bad, maxTry: 0, delayMs: 1, fetch: stub })
                    return 'no-throw'
                }
                catch (err) {
                    return err.message
                }
            })
            assert.ok(/^\[registry\] /.test(res.result), `${bad} → ${res.result}`)
            assert.strictEqual(res.fetchCalls, 0, bad)
        }
    })

    //評審 F05: 本檢測的請求不帶 npm 認證; 認證類錯誤不是傳播延遲, 空等 2~3 小時無意義
    it('評審 F05 主倉庫在 metadata 步驟連續回 401/403 → 連續 AUTH_FAIL_MAX 次即停止等待並回 false(不跑滿 maxTry), 印一次診斷與一次停止行', async function() {
        for (let code of [401, 403]) {
            let r = await run([code], { maxTry: 500, delayMs: 1 })
            assert.strictEqual(r.result, false, String(code))
            assert.strictEqual(r.attempts, AUTH_FAIL_MAX, String(code))
            assert.strictEqual(r.logs.filter((s) => s.indexOf(`主倉庫回 ${code}(本檢測的請求不帶 npm 認證`) >= 0).length, 1)
            assert.strictEqual(r.logs.filter((s) => s.indexOf('判定為認證問題而非傳播延遲, 停止等待') >= 0).length, 1)
            for (let s of r.logs) {
                assert.ok(!reFatal.test(s), s)
            }
        }
        assert.strictEqual(AUTH_FAIL_MAX, 20)
    })

    it('評審 F05 versions list / tarball HEAD 步驟的 401/403 同樣計入連續認證失敗', async function() {
        let r1 = await run(['list403'], { maxTry: 500, delayMs: 1 })
        assert.strictEqual(r1.result, false)
        assert.strictEqual(r1.attempts, AUTH_FAIL_MAX)
        let r2 = await run(['head401'], { maxTry: 500, delayMs: 1 })
        assert.strictEqual(r2.result, false)
        assert.strictEqual(r2.attempts, AUTH_FAIL_MAX)
    })

    it('評審 F05 未達門檻或中間夾雜非認證結果則不停止: 19 次 403 後成功 → true; 403 與 404 交錯(連續計數歸零)跑滿 maxTry', async function() {
        let plan = Array.from({ length: AUTH_FAIL_MAX - 1 }, () => 403).concat(['ok'])
        let r = await run(plan, { maxTry: 500, delayMs: 1 })
        assert.strictEqual(r.result, true)
        assert.strictEqual(r.attempts, AUTH_FAIL_MAX)
        let alt = []
        for (let i = 0; i < 100; i++) {
            alt.push(i % 2 === 0 ? 403 : 404)
        }
        let r2 = await run(alt, { maxTry: 59, delayMs: 1 })
        assert.strictEqual(r2.result, false)
        assert.strictEqual(r2.attempts, 60) //maxTry + 1: 未被認證類停止
    })

    it('評審 F05 一般傳播中(404)不受影響: 仍重試至 maxTry', async function() {
        let r = await run([404], { maxTry: 30, delayMs: 1 })
        assert.strictEqual(r.result, false)
        assert.strictEqual(r.attempts, 31)
    })

    it('R27.2 被拒絕之位址若含帳密, 錯誤訊息遮蔽之(不洩漏)', async function() {
        let res = await withFetch(['ok'], async (stub) => {
            try {
                await checkNpmVersion(NAME, VER, { registry: 'ftp://user:secretpw@localhost/', maxTry: 0, delayMs: 1, fetch: stub })
                return 'no-throw'
            }
            catch (err) {
                return err.message
            }
        })
        assert.ok(res.result.indexOf('secretpw') < 0, res.result)
    })

})
