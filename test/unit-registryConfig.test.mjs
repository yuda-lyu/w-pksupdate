//registryConfig 單元測試(純函式與注入; 不啟動 npm、不連網)
//對應需求(帳本 sgud/rule/rulebook.md 二 R27): R27.1 主倉庫預設取 npm 設定、可覆寫、解析失敗明確報錯且不退回 npmjs; R27.1 鏡像預設無、選項與環境變數可開、可多個; R27.2 位址正規化與非 http(s) 拒收
//所有位址皆為虛構之 localhost 或 *.example.test; 不含任何內網位址
import assert from 'assert'
import fs from 'fs'
import path from 'path'
import {
    ENV_REGISTRY,
    ENV_MIRRORS,
    normalizeRegistryUrl,
    parseMirrorList,
    getNpmConfigRegistry,
    resolveRegistryConfig,
    formatRegistryConfig
} from '../src/registryConfig.mjs'


let NPM = 'http://localhost:48731/' //樁:『本機 npm 設定之 registry』
let getNpm = (v = NPM) => () => v
//不從行程環境取值: 每案明確給 env
let rc = (opt = {}) => resolveRegistryConfig({ env: {}, getNpmRegistry: getNpm(), ...opt })


describe('normalizeRegistryUrl(R27.2; 純函式)', function() {

    it('R27.2 正規化: 結尾補 /、主機轉小寫、預設埠移除、前後空白去除、路徑前綴保留; 冪等', function() {
        let cases = {
            'http://localhost:48731': 'http://localhost:48731/',
            'http://localhost:48731/': 'http://localhost:48731/',
            'HTTP://LocalHost:48731/': 'http://localhost:48731/',
            '  https://registry.example.test:443  ': 'https://registry.example.test/',
            'http://registry.example.test:80/': 'http://registry.example.test/',
            'https://registry.example.test/sub/path': 'https://registry.example.test/sub/path/',
            'https://registry.npmjs.org': 'https://registry.npmjs.org/',
        }
        for (let [raw, want] of Object.entries(cases)) {
            let got = normalizeRegistryUrl(raw)
            assert.strictEqual(got, want, raw)
            assert.strictEqual(normalizeRegistryUrl(got), got, `${raw} 冪等`)
        }
    })

    it('R27.2 拒收: 非字串、空字串、非 http(s)、無 scheme、無法解析', function() {
        for (let bad of [undefined, null, 0, {}, [], '', '   ', 'localhost:48731', 'registry.example.test', 'ftp://registry.example.test/', 'file:///c:/x/', 'git+https://x/y', 'npm://x', 'http://']) {
            assert.throws(() => normalizeRegistryUrl(bad), /^Error: \[registry\] /, JSON.stringify(bad))
        }
    })

    it('R27.2 拒收: 帳密、查詢字串、片段、空白、引號、反引號、$、; | & < > ( ) { }、IPv6 字面位址(位址會被組進交給 PowerShell 之指令列)', function() {
        for (let bad of [
            'http://user:pw@localhost:48731/', 'http://user@localhost/', 'http://localhost:48731/?x=1', 'http://localhost:48731/#frag',
            'http://local host/', 'http://localhost/a b', 'http://localhost/\'', 'http://localhost/"', 'http://localhost/`x', 'http://localhost/$x', 'http://localhost/$(calc)',
            'http://localhost/;x', 'http://localhost/|x', 'http://localhost/&x', 'http://localhost/<x', 'http://localhost/>x', 'http://localhost/(x)', 'http://localhost/{x}',
            'http://[::1]:48731/', 'http://localhost:48731/a,b', 'http://localhost,evil.example.test/',
        ]) {
            assert.throws(() => normalizeRegistryUrl(bad), /^Error: \[registry\] /, bad)
        }
    })

    it('R27.2 錯誤訊息引述被拒位址時遮蔽帳密並截短', function() {
        let err = null
        try {
            normalizeRegistryUrl('ftp://user:secretpw@registry.example.test/' + 'x'.repeat(300))
        }
        catch (e) {
            err = e
        }
        assert.ok(err)
        assert.ok(err.message.indexOf('secretpw') < 0, err.message)
        //評審 F17: 帳密含空白或多個 @ 時亦須遮蔽(原遮蔽比對不跨空白)
        for (let bad of ['ftp://user:my password@registry.example.test/', 'ftp://user:p@ss@registry.example.test/', 'http://us er:pw@registry.example.test/']) {
            let e2 = null
            try {
                normalizeRegistryUrl(bad)
            }
            catch (e) {
                e2 = e
            }
            assert.ok(e2, bad)
            assert.ok(/^\[registry\] /.test(e2.message), e2.message)
            for (let leak of ['my password', 'user', 'p@ss', 'pw', 'us er']) {
                assert.ok(e2.message.indexOf(leak) < 0, `${bad} → 訊息洩漏[${leak}]: ${e2.message}`)
            }
        }
        assert.ok(err.message.length < 200, `訊息過長 ${err.message.length}`)
    })

})


describe('parseMirrorList(R27.1; 純函式)', function() {

    it('字串以逗號、分號、空白(含換行)分隔; 陣列元素亦再切; 空項去除', function() {
        assert.deepStrictEqual(parseMirrorList('https://a.example.test/, https://b.example.test/;https://c.example.test/\nhttps://d.example.test/'), ['https://a.example.test/', 'https://b.example.test/', 'https://c.example.test/', 'https://d.example.test/'])
        //陣列元素各為一個完整位址, 不再切分(評審 F16: 元素內含分隔符者留給正規化拒收, 不悄悄變成兩個位址)
        assert.deepStrictEqual(parseMirrorList(['https://a.example.test/', ' https://b.example.test/ ', '', '  ']), ['https://a.example.test/', 'https://b.example.test/'])
        assert.deepStrictEqual(parseMirrorList(['https://b.example.test/,https://c.example.test/', 'https://d.example.test/ https://e.example.test/']), ['https://b.example.test/,https://c.example.test/', 'https://d.example.test/ https://e.example.test/'])
    })

    it('非字串、非陣列、陣列內非字串 → 視為無', function() {
        for (let v of [undefined, null, 0, {}, true]) {
            assert.deepStrictEqual(parseMirrorList(v), [], JSON.stringify(v))
        }
        assert.deepStrictEqual(parseMirrorList([1, null, 'https://a.example.test/']), ['https://a.example.test/'])
        assert.deepStrictEqual(parseMirrorList(''), [])
    })

})


describe('resolveRegistryConfig 主倉庫(R27.1)', function() {

    it('R27.1 預設取本機 npm 設定(getNpmRegistry), 來源標示 npm config get registry; 預設無鏡像', function() {
        let r = rc()
        assert.strictEqual(r.main, NPM)
        assert.deepStrictEqual(r.mirrors, [])
        assert.strictEqual(r.source, 'npm config get registry')
        assert.deepStrictEqual(r.notes, [])
    })

    it('R27.1 npm 設定值亦經正規化(無結尾斜線者補上)', function() {
        assert.strictEqual(rc({ getNpmRegistry: getNpm('http://localhost:48731') }).main, NPM)
    })

    it('R27.1 優先序: 選項 registry > 環境變數 > npm 設定; 覆寫時不呼叫 getNpmRegistry(不啟動 npm)', function() {
        let called = 0
        let spy = () => {
            called++
            return NPM
        }
        let r1 = resolveRegistryConfig({ registry: 'http://localhost:48732', env: { [ENV_REGISTRY]: 'http://localhost:48733/' }, getNpmRegistry: spy })
        assert.strictEqual(r1.main, 'http://localhost:48732/')
        assert.strictEqual(r1.source, '選項 registry')
        let r2 = resolveRegistryConfig({ env: { [ENV_REGISTRY]: 'http://localhost:48733' }, getNpmRegistry: spy })
        assert.strictEqual(r2.main, 'http://localhost:48733/')
        assert.strictEqual(r2.source, `環境變數 ${ENV_REGISTRY}`)
        assert.strictEqual(called, 0)
        let r3 = resolveRegistryConfig({ env: {}, getNpmRegistry: spy })
        assert.strictEqual(r3.main, NPM)
        assert.strictEqual(called, 1)
    })

    it('R27.1 空字串之選項或環境變數視為未給, 落到下一順位', function() {
        let r = resolveRegistryConfig({ registry: '  ', env: { [ENV_REGISTRY]: '' }, getNpmRegistry: getNpm() })
        assert.strictEqual(r.main, NPM)
        assert.strictEqual(r.source, 'npm config get registry')
    })

    it('R27.1 解析失敗明確報錯、不默默退回 npmjs: getNpmRegistry 拋錯原樣向上; 回傳 undefined/空/非 http(s) 皆 throw [registry], 訊息含來源', function() {
        let sent = new Error('[registry] 無法取得 npm 設定之 registry(x)')
        assert.throws(() => resolveRegistryConfig({
            env: {},
            getNpmRegistry: () => {
                throw sent
            }
        }), (e) => e === sent)
        for (let bad of [undefined, null, '', 'undefined', 'localhost:48731', 'ftp://x/']) {
            let msg = ''
            try {
                resolveRegistryConfig({ env: {}, getNpmRegistry: () => bad })
            }
            catch (e) {
                msg = e.message
            }
            assert.ok(/^\[registry\] /.test(msg), `${bad} → ${msg}`)
            assert.ok(msg.indexOf('主倉庫來源: npm config get registry') >= 0, msg)
            assert.ok(msg.indexOf('registry.npmjs.org') < 0, '訊息不得出現退回 npmjs 的痕跡')
        }
    })

    it('R27.1 選項或環境變數給了無效位址 → throw, 且不退回 npm 設定(明確報錯優先於默默改道)', function() {
        let called = 0
        let spy = () => {
            called++
            return NPM
        }
        assert.throws(() => resolveRegistryConfig({ registry: 'not-a-url', env: {}, getNpmRegistry: spy }), /主倉庫來源: 選項 registry/)
        assert.throws(() => resolveRegistryConfig({ env: { [ENV_REGISTRY]: 'ftp://x/' }, getNpmRegistry: spy }), /主倉庫來源: 環境變數 W_PKSUPDATE_REGISTRY/)
        assert.strictEqual(called, 0)
    })

})


describe('resolveRegistryConfig 鏡像(R27.1)', function() {

    it('R27.1 預設無鏡像', function() {
        assert.deepStrictEqual(rc().mirrors, [])
    })

    it('R27.1 以選項(陣列或字串)或環境變數開啟, 可多個, 正規化並去重', function() {
        let r1 = rc({ mirrors: ['https://registry.npmjs.org', 'https://mirror-b.example.test/', 'https://registry.npmjs.org/'] })
        assert.deepStrictEqual(r1.mirrors, ['https://registry.npmjs.org/', 'https://mirror-b.example.test/'])
        let r2 = rc({ mirrors: 'https://registry.npmjs.org/, https://mirror-b.example.test' })
        assert.deepStrictEqual(r2.mirrors, ['https://registry.npmjs.org/', 'https://mirror-b.example.test/'])
        let r3 = rc({ env: { [ENV_MIRRORS]: 'https://registry.npmjs.org/;https://mirror-b.example.test/' } })
        assert.deepStrictEqual(r3.mirrors, ['https://registry.npmjs.org/', 'https://mirror-b.example.test/'])
    })

    it('R27.1 優先序: 選項 mirrors 給了即採用(含空陣列 = 明確無鏡像, 覆蓋環境變數); 否則環境變數', function() {
        let env = { [ENV_MIRRORS]: 'https://registry.npmjs.org/' }
        assert.deepStrictEqual(rc({ env }).mirrors, ['https://registry.npmjs.org/'])
        assert.deepStrictEqual(rc({ env, mirrors: [] }).mirrors, [])
        assert.deepStrictEqual(rc({ env, mirrors: ['https://mirror-b.example.test/'] }).mirrors, ['https://mirror-b.example.test/'])
        assert.deepStrictEqual(rc({ env, mirrors: '' }).mirrors, [])
    })

    it('R27.1 與主倉庫相同之鏡像略過並留提示(同一倉庫發兩次無意義)', function() {
        let r = rc({ mirrors: [NPM, 'http://localhost:48731', 'https://registry.npmjs.org/'] })
        assert.deepStrictEqual(r.mirrors, ['https://registry.npmjs.org/'])
        assert.strictEqual(r.notes.length, 2)
        assert.ok(r.notes[0].indexOf('與主倉庫相同') >= 0)
    })

    it('R27.2 無效鏡像位址 → throw [registry] 且訊息含鏡像來源', function() {
        assert.throws(() => rc({ mirrors: ['ftp://x/'] }), /\[registry\] .*鏡像來源: 選項 mirrors/)
        assert.throws(() => rc({ env: { [ENV_MIRRORS]: 'https://ok.example.test/ nope' } }), /鏡像來源: 環境變數 W_PKSUPDATE_MIRRORS/)
    })

})


describe('resolveRegistryConfig 選項型別(評審 F15: 已提供但無效之設定須報錯, 不悄悄改道或關閉鏡像)', function() {

    it('registry 為非字串(數字、物件、陣列、布林)→ throw [registry], 不落到環境變數或 npm 設定; 空字串/空白仍視為未設定(契約)', function() {
        let called = 0
        let spy = () => {
            called++
            return NPM
        }
        for (let bad of [42, {}, [], true, ['http://localhost:48731/']]) {
            assert.throws(() => resolveRegistryConfig({ registry: bad, env: { [ENV_REGISTRY]: 'http://localhost:48733/' }, getNpmRegistry: spy }), /^Error: \[registry\] 選項 registry 須為字串/, JSON.stringify(bad))
        }
        assert.strictEqual(called, 0)
        assert.strictEqual(resolveRegistryConfig({ registry: '', env: {}, getNpmRegistry: spy }).main, NPM)
        assert.strictEqual(resolveRegistryConfig({ registry: null, env: {}, getNpmRegistry: spy }).main, NPM)
    })

    it('mirrors 為非字串且非字串陣列(數字、物件、布林、含非字串元素之陣列)→ throw [registry], 不丟棄元素、不覆蓋環境變數成「無鏡像」', function() {
        let env = { [ENV_MIRRORS]: 'https://registry.npmjs.org/' }
        for (let bad of [42, {}, true, [42], ['https://a.example.test/', null], [['https://a.example.test/']]]) {
            assert.throws(() => rc({ env, mirrors: bad }), /^Error: \[registry\] 選項 mirrors 須為字串或字串陣列/, JSON.stringify(bad))
        }
        assert.deepStrictEqual(rc({ env, mirrors: undefined }).mirrors, ['https://registry.npmjs.org/'])
        assert.deepStrictEqual(rc({ env, mirrors: null }).mirrors, ['https://registry.npmjs.org/'])
    })

    it('mirrors 陣列元素含分隔符(逗號)→ 整個元素視為一個位址而被正規化拒收(不悄悄切成兩個)', function() {
        assert.throws(() => rc({ mirrors: ['https://a.example.test/,https://b.example.test/'] }), /\[registry\] .*鏡像來源: 選項 mirrors/)
        assert.deepStrictEqual(rc({ mirrors: 'https://a.example.test/,https://b.example.test/' }).mirrors, ['https://a.example.test/', 'https://b.example.test/']) //字串形式才以分隔符切分
    })

})


describe('formatRegistryConfig(純函式)', function() {

    it('一行說明含主倉庫、來源、鏡像(無則「無」)與提示', function() {
        assert.strictEqual(formatRegistryConfig(rc()), `[registry] 主倉庫: ${NPM}(來源: npm config get registry); 同時發布之鏡像: 無`)
        let s = formatRegistryConfig(rc({ mirrors: ['https://registry.npmjs.org/', 'https://mirror-b.example.test/', NPM] }))
        assert.ok(s.indexOf('同時發布之鏡像: https://registry.npmjs.org/, https://mirror-b.example.test/') >= 0, s)
        assert.ok(s.indexOf('提示: ') >= 0, s)
        assert.ok(s.indexOf('\n') < 0)
    })

})


//R27.8 盤點(靜態): 全套件(src/**、g_*.mjs)之可執行程式碼(去註解後)不得出現寫死的倉庫位址; 倉庫一律經 registryConfig 取得. 對應規則帳本〈二〉之盤點指令
describe('R27.8 盤點: 程式碼不得寫死倉庫位址(靜態掃描)', function() {

    let strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
    //src 遞迴(含子資料夾, 評審 F22)與專案根的 g_*.mjs
    let lsRec = (fd) => fs.readdirSync(path.resolve(fd), { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? lsRec(`${fd}/${d.name}`) : (/\.(?:mjs|cjs|js)$/.test(d.name) ? [`${fd}/${d.name}`] : [])))
    let files = () => [
        ...lsRec('src'),
        ...fs.readdirSync(path.resolve('.')).filter((n) => /^g_.*\.mjs$/.test(n)),
    ]

    it('掃描涵蓋 src 與 g_*.mjs 全部 .mjs(掃描未空轉)', function() {
        let fs_ = files()
        assert.ok(fs_.includes('src/registryConfig.mjs') && fs_.includes('src/checkNpmVersion.mjs') && fs_.includes('src/publishPackage.mjs') && fs_.some((n) => /^g_u.*\.mjs$/.test(n)), fs_.join(','))
        assert.ok(fs_.length >= 20, `掃描檔數過少 ${fs_.length}`)
    })

    it('去註解後無 npmjs 位址(registry.npmjs.org、npmjs.org、npmjs.com)', function() {
        let hits = []
        for (let rel of files()) {
            let code = strip(fs.readFileSync(path.resolve(rel), 'utf8'))
            if (/registry\.npmjs\.org|\bnpmjs\.(?:org|com)\b/i.test(code)) {
                hits.push(rel)
            }
        }
        assert.deepStrictEqual(hits, [])
    })

    it('去註解後無任何 http(s):// 位址字面值(倉庫位址只能來自設定; 其餘外部位址本套件原本就沒有)', function() {
        let hits = []
        for (let rel of files()) {
            let code = strip(fs.readFileSync(path.resolve(rel), 'utf8'))
            let m = code.match(/https?:\/\/[A-Za-z0-9[]/g)
            if (m) {
                hits.push(`${rel}: ${m.join(',')}`)
            }
        }
        assert.deepStrictEqual(hits, [])
    })

    it('掃描正則本身有效: 寫死位址之各種寫法都命中, 註解與無關程式碼不命中(防止盤點空轉)', function() {
        let re1 = /registry\.npmjs\.org|\bnpmjs\.(?:org|com)\b/i
        for (let s of ['let u = \'https://registry.npmjs.org/\'', 'let u = `https://registry.npmjs.org/${name}`', 'x = \'npmjs.com\'', 'fetch(\'https://REGISTRY.NPMJS.ORG/x\')']) { // eslint-disable-line no-template-curly-in-string
            assert.ok(re1.test(strip(s)), s)
        }
        for (let s of ['// https://registry.npmjs.org/', '/* registry.npmjs.org */', 'let a = 1 //npmjs.org', 'let u = \'http://localhost:4873/\'']) {
            assert.ok(!re1.test(strip(s)), s)
        }
        let re2 = /https?:\/\/[A-Za-z0-9[]/g
        for (let s of ['a(\'http://localhost:4873/\')', 'a(`https://x.example.test/${b}`)', 'a(\'http://[::1]/\')']) { // eslint-disable-line no-template-curly-in-string
            assert.ok(strip(s).match(re2), s)
        }
        assert.ok(!strip('// http://localhost/').match(re2))
    })

})


describe('getNpmConfigRegistry 真實實作之守衛(帳本 R25; 子程序 + spy 見 unit-testGuard registryConfig 站點)', function() {

    it('測試環境下直接呼叫真實預設實作 → throw [testGuard], 不啟動 npm', function() {
        assert.throws(() => getNpmConfigRegistry(), /\[testGuard\].*\[registryConfig\.npmConfig\]/)
    })

    it('resolveRegistryConfig 未注入 getNpmRegistry 且選項、環境變數皆未給 → 走真實預設實作而被守衛擋下(不默默啟動 npm)', function() {
        assert.throws(() => resolveRegistryConfig({ env: {} }), /\[testGuard\]/)
    })

})
