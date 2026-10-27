//測試環境守衛單元與整合測試(帳本 R25): 測試環境下真實執行路徑不可達
//  ①判別四訊號 ②requireInjected 語意 ③root hook(全域旗標與 PATH 安全網) ④各站點「未注入即拋錯且未 spawn」(子程序 + spy, 對照組證明 spy 有接上)
//  ⑤realExec(刻意真實執行 helper)之拒絕 ⑥盤點(新接縫未登錄即紅)
//本檔自身須對變異安全(R25.7): 絕不在測試行程內呼叫真實站點; 站點案一律在子程序內, 站點之下一層已換成只寫紀錄之 spy, 且子程序 PATH 已移除 PowerShell(雙保險)
//fixture 於 test/_tmp/unit-testGuard, before 建立、after 刪除
import assert from 'assert'
import fs from 'fs'
import path from 'path'
import cp from 'child_process'
import { ENV_FLAG, isMochaArgv, isTestEnv, isTestGuardError, requireInjected, assertRealExecAllowed, assertConfinedToTestTmp, assertSingleLink, realPathOf, testTmpRoot } from '../src/testGuard.mjs'
import { installTestEnv, uninstallTestEnv, hasPowerShell, stripPowerShell, getRealPath } from './tools/testEnv.mjs'
import { makeEctReal, assertConfined, assertCommandsAllowed, gitCeiling, gitStatusDistReal } from './tools/realExec.mjs'
import publishPackage from '../src/publishPackage.mjs'
import updatePackage from '../src/updatePackage.mjs'
import { mkFixturePkg, writeScript, cleanTmpRoot } from './tools/mkFixturePkg.mjs'


//---- root hook(R25.6): 不屬任何 describe, 涵蓋同一次執行之所有測試檔 ----
before(function() {
    installTestEnv()
})

after(function() {
    uninstallTestEnv()
})


let fdTmp = path.resolve('./test/_tmp/unit-testGuard')
let fdPkg = path.join(fdTmp, 'pkg')
let fdShim = path.join(fdTmp, 'gitshim')
let fpCalls = path.join(fdTmp, 'calls.txt')


describe('testGuard 判別與守衛語意(R25.1、R25.2)', function() {

    it('R25.1 四個訊號各自成立即為測試環境; 全無則否', function() {
        let none = { env: {}, globals: {}, argv: ['node', 'g_updateAndPublic.mjs'] }
        assert.strictEqual(isTestEnv(none), false)
        assert.strictEqual(isTestEnv({ ...none, env: { [ENV_FLAG]: '1' } }), true) //①旗標
        assert.strictEqual(isTestEnv({ ...none, env: { npm_lifecycle_event: 'test' } }), true) //②npm test
        assert.strictEqual(isTestEnv({ ...none, globals: { describe() {}, it() {} } }), true) //③mocha 全域
        assert.strictEqual(isTestEnv({ ...none, argv: ['node', 'C:\\x\\node_modules\\mocha\\bin\\mocha.js', 'a.test.mjs'] }), true) //④argv
    })

    it('R25.1 邊界: 旗標空字串不算; npm_lifecycle_event 為其他值(如 start)不算; 只有 describe 或只有 it 不算; 檔名含 mocha 字樣但不是 mocha 不算', function() {
        let none = { env: {}, globals: {}, argv: ['node', 'g_updateAndPublic.mjs'] }
        assert.strictEqual(isTestEnv({ ...none, env: { [ENV_FLAG]: '' } }), false)
        for (let v of ['1', 'yes', 'true', '0', 'false', ' ', 'x']) {
            assert.strictEqual(isTestEnv({ ...none, env: { [ENV_FLAG]: v } }), true, `旗標任何非空值皆算(含 '0'、'false'; 外審 sol 變異 M01): [${v}]`)
        }
        assert.strictEqual(isTestEnv({ ...none, env: { npm_lifecycle_event: 'start' } }), false)
        assert.strictEqual(isTestEnv({ ...none, globals: { describe() {} } }), false)
        assert.strictEqual(isTestEnv({ ...none, globals: { it() {} } }), false)
        assert.strictEqual(isTestEnv({ ...none, globals: { describe: 1, it: 2 } }), false)
        assert.strictEqual(isTestEnv({ ...none, argv: ['node', 'C:\\x\\mocha-notes.mjs'] }), false)
        assert.strictEqual(isTestEnv({ ...none, argv: ['node', 'C:\\x\\mochaccino.js'] }), false)
    })

    //第 5 次外審 opus F04: 非 mocha-BDD 的執行方式也應被判為測試環境
    it('R25.1 其他 runner 之訊號: node --test(NODE_TEST_CONTEXT、execArgv 含 --test*)、mocha TDD 全域 suite+test、mocha worker/任何 node_modules/mocha 下的入口、測試檔(*.test.*、*.spec.*)被直接執行 → 皆為測試環境', function() {
        let none = { env: {}, globals: {}, argv: ['node', 'g_updateAndPublic.mjs'], execArgv: [] }
        assert.strictEqual(isTestEnv(none), false)
        assert.strictEqual(isTestEnv({ ...none, env: { NODE_TEST_CONTEXT: 'child-v8' } }), true)
        for (let a of ['--test', '--test-reporter=spec', '--test-only']) {
            assert.strictEqual(isTestEnv({ ...none, execArgv: [a] }), true, a)
        }
        assert.strictEqual(isTestEnv({ ...none, globals: { suite() {}, test() {} } }), true)
        assert.strictEqual(isTestEnv({ ...none, globals: { suite() {} } }), false)
        assert.strictEqual(isTestEnv({ ...none, argv: ['node', 'C:\\x\\node_modules\\mocha\\lib\\nodejs\\worker.js'] }), true)
        assert.strictEqual(isTestEnv({ ...none, argv: ['node', '/x/node_modules/mocha/bin/mocha.js'] }), true)
        for (let f of ['a.test.mjs', 'C:\\x\\test\\b.spec.mjs', 'c.test.cjs', 'd.spec.js', 'E.TEST.MJS']) {
            assert.strictEqual(isTestEnv({ ...none, argv: ['node', f] }), true, f)
        }
        for (let f of ['g_updateAndPublic.mjs', 'testimony.mjs', 'a.test.json', 'mytest.mjs', 'spec.mjs', 'node_modules_mocha.mjs']) {
            assert.strictEqual(isTestEnv({ ...none, argv: ['node', f] }), false, f)
        }
    })

    it('R25.1 isMochaArgv: mocha、_mocha 與 .js/.cjs/.mjs 變體、含路徑; 非 mocha 否', function() {
        for (let s of ['mocha', 'mocha.js', 'mocha.cjs', 'mocha.mjs', '_mocha', '_mocha.js', 'C:\\a\\node_modules\\mocha\\bin\\mocha.js', 'C:/a/node_modules/.bin/mocha', 'MOCHA.JS']) {
            assert.strictEqual(isMochaArgv(['node', s]), true, s)
        }
        for (let s of ['node', 'mocha-x.js', 'xmocha.js', 'mocha.json', 'g_updateAndPublic.mjs', '']) {
            assert.strictEqual(isMochaArgv(['node', s]), false, s)
        }
        assert.strictEqual(isMochaArgv([]), false)
        assert.strictEqual(isMochaArgv(undefined), false)
    })

    it('R25.1 本行程(mocha 執行)判為測試環境, 且 testGuard 載入時已設旗標供子行程繼承', function() {
        assert.strictEqual(isTestEnv(), true)
        assert.strictEqual(process.env[ENV_FLAG], '1')
    })

    it('R25.2 requireInjected: 缺任一鍵、值非函式、obj 為 undefined/null 皆 throw 並列出缺的鍵與站點; 全給則不 throw', function() {
        assert.throws(() => requireInjected('siteX', {}, ['a', 'b']), /^Error: \[testGuard\] 測試環境下禁止走未注入之真實執行路徑\[siteX\]: 未注入 a、b/)
        assert.throws(() => requireInjected('siteX', { a() {}, b: 1 }, ['a', 'b']), /未注入 b\(/)
        assert.throws(() => requireInjected('siteX', undefined, ['a']), /未注入 a/)
        assert.throws(() => requireInjected('siteX', null, ['a']), /未注入 a/)
        requireInjected('siteX', { a() {}, b() {} }, ['a', 'b'])
        requireInjected('siteX', { a() {} }, [])
    })

    it('R25.2 requireInjected 只認 obj 自身可列舉的函式值(第 5 次外審 sol F10): 原型上的方法、不可列舉屬性、getter 回傳函式的不可列舉屬性皆視為未注入, 因物件 spread 合併預設依賴時它們會被丟掉', function() {
        let fn = () => {}
        assert.throws(() => requireInjected('siteO', Object.create({ a: fn }), ['a']), /未注入 a/)
        assert.throws(() => requireInjected('siteO', Object.defineProperty({}, 'a', { value: fn, enumerable: false }), ['a']), /未注入 a/)
        class Deps {
            a() {}
        }
        assert.throws(() => requireInjected('siteO', new Deps(), ['a']), /未注入 a/)
        requireInjected('siteO', { a: fn }, ['a'])
        requireInjected('siteO', Object.assign(Object.create(null), { a: fn }), ['a'])
        //spread 合併後的實際使用值 = 驗證的值
        let merged = { a: 'REAL', ...{ a: fn } }
        assert.strictEqual(merged.a, fn)
    })

    it('R25.2 assertRealExecAllowed: 測試環境下無條件 throw, 訊息含站點與說明', function() {
        assert.throws(() => assertRealExecAllowed('siteY'), /^Error: \[testGuard\] 測試環境下禁止走未注入之真實執行路徑\[siteY\]: 使用了真實預設實作/)
        assert.throws(() => assertRealExecAllowed('siteY', '自訂說明'), /\[siteY\]: 自訂說明/)
    })

    it('R25.2 assertConfinedToTestTmp: test/_tmp 及其子孫放行; 專案根、套件區、上層、同名前綴旁支(test/_tmpx)、空字串、非字串、無值皆 throw 並含站點與路徑', function() {
        for (let p of [path.resolve('./test/_tmp'), path.resolve('./test/_tmp/a/b'), path.resolve('./test/_tmp/a/..\\b')]) {
            assertConfinedToTestTmp('siteP', p)
        }
        for (let p of [path.resolve('.'), 'C:\\opensrc\\開源-JS-001-1-w-package-tools\\w-package-tools', path.resolve('./test'), path.resolve('./test/_tmp/..'), path.resolve('./test/_tmpx'), '', undefined, null, 5]) {
            assert.throws(() => assertConfinedToTestTmp('siteP', p), /^Error: \[testGuard\] 測試環境下禁止走未注入之真實執行路徑\[siteP\]: 套件路徑\[.*\]不在 test\/_tmp 內/, String(p))
        }
    })

    //路徑以實體路徑比對(外審 sol: 原只做字面比對, test/_tmp 內放一個指向真實套件的 junction 即可通過): 最近的既存祖先取實體路徑再接回其餘段
    it('R25.2 assertConfinedToTestTmp 以實體路徑比對: test/_tmp 內指向外部的 junction(連同其下尚不存在的子路徑)一律 throw; 指向 test/_tmp 內者放行', function() {
        let fdJ = path.resolve('./test/_tmp/unit-testGuard-junction')
        fs.rmSync(fdJ, { recursive: true, force: true })
        fs.mkdirSync(path.join(fdJ, 'inside'), { recursive: true })
        let linkOut = path.join(fdJ, 'to-outside')
        let linkIn = path.join(fdJ, 'to-inside')
        fs.symlinkSync(path.resolve('.'), linkOut, 'junction') //指向專案根(test/_tmp 之外)
        fs.symlinkSync(path.join(fdJ, 'inside'), linkIn, 'junction')
        try {
            for (let p of [linkOut, path.join(linkOut, 'src'), path.join(linkOut, 'not-yet', 'child')]) {
                assert.throws(() => assertConfinedToTestTmp('siteJ', p), /不在 test\/_tmp 內/, p)
            }
            for (let p of [linkIn, path.join(linkIn, 'not-yet', 'child'), path.join(fdJ, 'inside')]) {
                assertConfinedToTestTmp('siteJ', p)
            }
        }
        finally {
            fs.rmdirSync(linkOut) //junction 本身, 不遞迴
            fs.rmdirSync(linkIn)
            fs.rmSync(fdJ, { recursive: true, force: true })
            cleanTmpRoot()
        }
    })

    //第 5 次外審 sol F02: fixture 內 package.json 若是 test/_tmp 之外某檔案的硬連結, 實體路徑檢查通過但寫入會改到外側檔案. 此處的『外側』檔案也建在 test/_tmp 內(同磁碟), 全程不碰任何真實檔案
    describe('硬連結(R25.2 assertSingleLink; 外審 sol F02)', function() {

        let fdH = path.resolve('./test/_tmp/unit-testGuard-hardlink')
        let fpTarget = path.join(fdH, 'outside', 'package.json') //被別名的『外側』檔案
        let fdPkgH = path.join(fdH, 'pkg')
        let fpPkgJson = path.join(fdPkgH, 'package.json')

        beforeEach(function() {
            fs.rmSync(fdH, { recursive: true, force: true })
            fs.mkdirSync(path.dirname(fpTarget), { recursive: true })
            fs.mkdirSync(fdPkgH, { recursive: true })
            fs.writeFileSync(fpTarget, JSON.stringify({ name: 'sbx-hl', version: '0.0.1', devDependencies: { 'w-x': '^1.0.0' } }), 'utf8')
            fs.linkSync(fpTarget, fpPkgJson) //硬連結: 兩個名字同一個 inode
            fs.writeFileSync(path.join(fdPkgH, 'script.txt'), 'node toolg/x.mjs\r\n', 'utf8')
        })

        afterEach(function() {
            fs.rmSync(fdH, { recursive: true, force: true })
            cleanTmpRoot()
        })

        it('assertSingleLink: nlink>1 的檔案 throw 並含站點與檔名; 單一連結、不存在、資料夾放行', function() {
            assert.strictEqual(fs.statSync(fpPkgJson).nlink, 2)
            assert.throws(() => assertSingleLink('siteH', fpPkgJson), /^Error: \[testGuard\] 測試環境下禁止走未注入之真實執行路徑\[siteH\]: 檔案\[.*package\.json\]為硬連結\(nlink=2\)/)
            fs.rmSync(fpTarget) //移除另一個名字後 nlink 回到 1
            assertSingleLink('siteH', fpPkgJson)
            assertSingleLink('siteH', path.join(fdH, 'no-such-file.json'))
            assertSingleLink('siteH', fdPkgH)
        })

        it('updatePackage 對硬連結的 package.json 在寫入前 throw: 兩個別名檔案內容皆不變', function() {
            let before = fs.readFileSync(fpTarget, 'utf8')
            let pdi = { name: 'sbx-hl', path: fdPkgH, update: true, dependencies: [], devDependencies: [{ name: 'w-x', verOld: '^1.0.0', verNew: '^2.0.0' }] }
            assert.throws(() => updatePackage(pdi), /\[updatePackage\]: 檔案\[.*package\.json\]為硬連結/)
            assert.strictEqual(fs.readFileSync(fpTarget, 'utf8'), before)
            assert.strictEqual(fs.readFileSync(fpPkgJson, 'utf8'), before)
        })

        it('publishPackage 對硬連結的 package.json / package-lock.json 在備份與 updatePackage 之前 throw(唯讀的 loadScript 解析已先執行; deps 皆為 spy)', async function() {
            for (let which of ['package.json', 'package-lock.json']) {
                if (which === 'package-lock.json') {
                    fs.rmSync(fpPkgJson)
                    fs.writeFileSync(fpPkgJson, '{"name":"sbx-hl","version":"0.0.1"}', 'utf8')
                    fs.writeFileSync(path.join(fdH, 'outside', 'lock.json'), '{}', 'utf8')
                    fs.linkSync(path.join(fdH, 'outside', 'lock.json'), path.join(fdPkgH, 'package-lock.json'))
                }
                let calls = []
                let rec = (n, ret) => (...a) => {
                    calls.push(n)
                    return ret
                }
                let pdi = { name: 'sbx-hl', path: fdPkgH, version: '0.0.1', update: true, dependencies: [], devDependencies: [] }
                let deps = {
                    getFolders: rec('getFolders', [fdPkgH]),
                    parseProject: rec('parseProject', [{ name: 'sbx-hl', path: fdPkgH, level: '3' }]),
                    getUpdate: rec('getUpdate', pdi),
                    updatePackage: rec('updatePackage', 'ok'),
                    ectScripts: async () => calls.push('ectScripts'),
                    runScript: async () => calls.push('runScript'),
                    loadScript: rec('loadScript', []),
                }
                let logOri = console.log
                console.log = () => {}
                try {
                    await assert.rejects(publishPackage(['sbx-hl'], { deps, checkRelease: false, registryConfig: { main: 'http://localhost:48731/', mirrors: [] } }), new RegExp(`\\[publishPackage\\]: 檔案\\[.*${which.replace('.', '\\.')}\\]為硬連結`), which)
                }
                finally {
                    console.log = logOri
                }
                assert.deepStrictEqual(calls, ['getFolders', 'parseProject', 'getUpdate', 'loadScript'], which) //updatePackage / ectScripts / runScript 皆未被呼叫
            }
        })

    })

    it('R25.2 守衛所拋之錯誤帶標記, isTestGuardError 可辨識(供有「吞掉例外後略過」之 catch 原樣重拋); 一般錯誤與非錯誤值不是', function() {
        let e1 = null
        let e2 = null
        try {
            requireInjected('siteZ', {}, ['a'])
        }
        catch (err) {
            e1 = err
        }
        try {
            assertRealExecAllowed('siteZ')
        }
        catch (err) {
            e2 = err
        }
        assert.strictEqual(isTestGuardError(e1), true)
        assert.strictEqual(isTestGuardError(e2), true)
        for (let v of [new Error('x'), Object.assign(new Error('x'), { testGuard: 'yes' }), null, undefined, 'x', {}]) {
            assert.strictEqual(isTestGuardError(v), false)
        }
    })

})


//測試旗標必須能獨立於 root hook、也獨立於父測試檔是否載入過 testGuard 而成立(第 5 次外審 opus F01、F06 MUT1/MUT2)
describe('測試旗標之各設定來源與子行程繼承(R25.1)', function() {

    let probe = (args, { hooks = false } = {}) => {
        let env = { ...process.env }
        delete env[ENV_FLAG]
        delete env.npm_lifecycle_event
        delete env.NODE_TEST_CONTEXT
        env.STUB_MODE = 'runScript'
        let a = [...(hooks ? ['--import', './test/tools/hooksStub.mjs'] : []), 'test/tools/envProbe.mjs', ...args]
        let r = cp.spawnSync(process.execPath, a, { env, encoding: 'utf8', timeout: 60000 })
        let line = String(r.stdout || '').split(/\r?\n/).reverse().find((s) => s.indexOf('RESULT_JSON:') === 0)
        assert.ok(line, `子程序無結果: ${String(r.stderr || '').slice(0, 400)}`)
        return JSON.parse(line.slice('RESULT_JSON:'.length))
    }

    it('單獨載入 src/testGuard.mjs 即設旗標(判為測試環境時; 此例以 argv 帶 mocha 模擬), 不靠 root hook 也不靠 testEnv', function() {
        let r = probe(['import-testGuard', 'mocha'])
        assert.strictEqual(r.flagBefore, '')
        assert.strictEqual(r.isTestEnv, true)
        assert.strictEqual(r.flagAfter, '1')
    })

    it('單獨載入 test/tools/testEnv.mjs 並 installTestEnv() 即設旗標, 不靠 testGuard 載入', function() {
        let r = probe(['import-testEnv-install'])
        assert.strictEqual(r.flagBefore, '')
        assert.strictEqual(r.flagAfter, '1')
    })

    it('鎖存: 一旦判為測試環境, 測試自己清掉旗標與 argv 訊號後仍為測試環境(實際環境判別); 純函式傳參重算不受鎖存影響', function() {
        let r = probe(['latch', 'mocha'])
        assert.strictEqual(r.isTestEnvBefore, true)
        assert.strictEqual(r.signalsGone, false) //訊號確已清空
        assert.strictEqual(r.isTestEnvAfter, true) //但鎖存使實際環境判別仍為真
        //正式模式不鎖存: 無訊號之子行程前後皆為假
        let r2 = probe(['import-testGuard'])
        assert.strictEqual(r2.isTestEnv, false)
    })

    it('正式模式對照: 無任何訊號之子行程載入 testGuard → 不是測試環境、不設旗標', function() {
        let r = probe(['import-testGuard'])
        assert.strictEqual(r.isTestEnv, false)
        assert.strictEqual(r.flagAfter, '')
    })

    it('經 hooksStub 啟動的子行程(非 guard 模式)一律帶旗標, 即使父行程環境被洗淨、父測試檔未載入 testGuard (外審 opus F01)', function() {
        let r = probe(['import-testGuard'], { hooks: true })
        assert.strictEqual(r.flagBefore, '1') //由 hooksStub 在任何 src 載入之前設定
        assert.strictEqual(r.isTestEnv, true)
    })

})


describe('全域 root hook: 旗標與 PATH 安全網(R25.6)', function() {

    it('root hook 生效中: 旗標已設, PATH 不含任何含 powershell.exe 之目錄(任何測試預設無法啟動 PowerShell)', function() {
        assert.strictEqual(process.env[ENV_FLAG], '1')
        assert.strictEqual(hasPowerShell(process.env.PATH), false)
    })

    it('getRealPath 取回含 PowerShell 之原 PATH(明確 opt-in 用); stripPowerShell 為其子集', function() {
        let real = getRealPath()
        if (!hasPowerShell(real)) {
            this.skip() //本機 PATH 本來就沒有 PowerShell
        }
        assert.strictEqual(hasPowerShell(real), true)
        assert.strictEqual(stripPowerShell(real), process.env.PATH)
    })

    it('stripPowerShell 一併移除含 pwsh.exe / powershell.com 之目錄(惰性檔案於 test/_tmp 內自建; 第 5 次外審 sol A09), 不含 PowerShell 者保留', function() {
        let fdP = path.resolve('./test/_tmp/unit-testGuard-psnames')
        fs.rmSync(fdP, { recursive: true, force: true })
        let dirs = { a: 'pwsh.exe', b: 'powershell.com', c: 'powershell.exe', d: 'pwsh.com', e: 'other.exe' }
        try {
            for (let [d, f] of Object.entries(dirs)) {
                fs.mkdirSync(path.join(fdP, d), { recursive: true })
                fs.writeFileSync(path.join(fdP, d, f), '', 'utf8') //惰性空檔, 不會被執行
            }
            let p = Object.keys(dirs).map((d) => path.join(fdP, d)).join(path.delimiter)
            assert.strictEqual(stripPowerShell(p), path.join(fdP, 'e'))
            assert.strictEqual(hasPowerShell(path.join(fdP, 'a')), true)
            assert.strictEqual(hasPowerShell(path.join(fdP, 'e')), false)
        }
        finally {
            fs.rmSync(fdP, { recursive: true, force: true })
            cleanTmpRoot()
        }
    })

    it('install/uninstall 可重複呼叫(冪等), 且 uninstall 還原 PATH、旗標保留; 事後恢復 root 狀態', function() {
        let pathNow = process.env.PATH
        let real = getRealPath()
        try {
            installTestEnv() //已安裝, 不得二次保存(否則 pathReal 會被已移除 PowerShell 的 PATH 蓋掉)
            assert.strictEqual(getRealPath(), real)
            uninstallTestEnv()
            assert.strictEqual(process.env.PATH, real)
            assert.strictEqual(process.env[ENV_FLAG], '1')
            uninstallTestEnv() //未安裝時呼叫無害
            assert.strictEqual(process.env.PATH, real)
        }
        finally {
            installTestEnv()
            assert.strictEqual(process.env.PATH, pathNow)
        }
    })

})


//---- 各站點: 子程序 + spy(R25.7) ----
//stubs: 該站點「之下一層」換成 spy 的 src 檔名; execSpy: 另換 wsemi execProcess; ctl: 對照組(正式模式)應見到之 spy 紀錄(子字串)
let SITES = [
    { site: 'publishPackages', stubs: ['checkGit.mjs', 'publishPackage.mjs'], ctl: ['checkGit', 'publishPackage'] },
    { site: 'publishPackage', stubs: ['getFolders.mjs', 'parseProject.mjs', 'getUpdate.mjs', 'updatePackage.mjs', 'ectScripts.mjs', 'checkNpmVersion.mjs'], ctl: ['getFolders', 'updatePackage', 'ectScripts|npm i --registry=http://localhost:48731/|npm'] },
    { site: 'runScript', stubs: ['ectScripts.mjs', 'checkNpmVersion.mjs'], ctl: ['ectScripts|node toolg/mark.mjs A|node'] },
    { site: 'runScript.checkNpm', stubs: ['ectScripts.mjs', 'checkNpmVersion.mjs'], ctl: ['checkNpmVersion|sbx-ect-test@'] }, //exec 已注入、checkNpm 未注入: 預設 checkNpm(網路)被使用時才擋
    //exec 已注入(spy 記錄)、gitStatusDist 未注入: dist 閘門使用預設 git status 時擋, 擋下時 exec 從未被呼叫; 此站點之守衛曾被 dist 閘門的『其他例外跳過檢查』catch 吞掉(須 isTestGuardError 重拋)
    //對照組(正式模式)會真的執行唯讀 `git status`(GIT_DIR 指向不存在之路徑 → fatal 128, 不碰任何倉庫), 以其 R10 的 git指令失敗(code[128]) 證明預設實作確實被走到
    { site: 'runScript.gitStatusDist', stubs: ['ectScripts.mjs', 'checkNpmVersion.mjs'], ctl: [], ctlMsg: /git指令失敗\(code\[128\]\): git status --porcelain -- dist/ },
    //套件路徑須在 test/_tmp 內(R25.2 assertConfinedToTestTmp): exec/deps 皆已注入, 擋的是『手工組出指向真實套件之 pdi』; calls 為擋下前合法被呼叫的注入函式; 對照組(正式模式)走到真實 loadScript 而 ENOENT(路徑不存在, 無任何寫入)
    { site: 'runScript.path', stubs: [], ctl: [], calls: [], ctlMsg: /ENOENT/ },
    { site: 'publishPackage.path', stubs: [], ctl: ['getFolders', 'parseProject', 'getUpdate'], calls: ['getFolders', 'parseProject', 'getUpdate'], ctlMsg: /ENOENT/ },
    { site: 'ectScripts', stubs: [], execSpy: true, ctl: ['execProcess|powershell|-Command'] },
    //ectScripts 的『已注入』判定: 值須為函式, 且不得是未包裝的真實 execProcess(須經 realExec 包裝; 外審 opus F05、F06 MUT6); 對照組走(已被換成 spy 的)真實預設
    { site: 'ectScripts.realIdentity', guardSite: 'ectScripts', stubs: [], execSpy: true, ctl: ['execProcess|powershell|-Command'] },
    { site: 'ectScripts.undefExec', guardSite: 'ectScripts', stubs: [], execSpy: true, ctl: ['execProcess|powershell|-Command'] },
    { site: 'ectScripts.nonFnExec', guardSite: 'ectScripts', stubs: [], execSpy: true, ctl: ['execProcess|powershell|-Command'] },
    //寫/刪類匯出函式與 exitAfterFlush(外審 opus F07、F13); 對照組(正式模式)的 removeTarget 對不存在目錄回 absent、updatePackage 讀不到 package.json 而 ENOENT、exitAfterFlush 呼叫 process.exit(spy)
    { site: 'removeTarget.path', guardSite: 'removeTarget', stubs: [], ctl: [] },
    { site: 'updatePackage.path', guardSite: 'updatePackage', stubs: [], ctl: [], ctlMsg: /ENOENT/ },
    { site: 'exitAfterFlush', guardSite: 'exitAfterFlush', stubs: [], ctl: ['exit|0'] },
    { site: 'checkGit', stubs: ['ectScripts.mjs'], ctl: ['ectScripts|git --version|git'] },
    //網路接縫: 以不通之代理使 fetch 不離機; 對照組以子程序印出之行證明確實走到 fetch 核心(checking metadata / 檢測例外), 擋下時這些行不得出現(外審 sol 變異 M09)
    { site: 'checkNpmVersion', stubs: [], ctl: ['fetch|http://localhost:48731/sbx-guard-pkg/0.0.1'], ctlLog: /checking metadata|檢測例外\(視為尚未就緒\)/ },
    //倉庫設定解析之 npm 子行程接縫(帳本 R27、R25): child_process.execSync 換成只記錄的 spy(不起任何行程); 擋下時 spy 不得被呼叫, 對照組(正式模式)須呼叫到 `npm config get registry`
    { site: 'registryConfig.npmConfig', stubs: [], ctl: ['execSync|npm config get registry'] },
    //無法換成下一層 spy 的兩個接縫: 子程序內把 fs 讀取類 / child_process.execSync 換成『記錄(再轉呼叫 / 不執行)』的包裝來觀測(外審 opus F06: 原兩站點對照組無正面證據, 守衛移到掃描/執行之後仍綠)
    { site: 'getFolders', stubs: [], ctl: ['fs|'] },
    { site: 'checkGitStatus', stubs: [], ctl: ['execSync|git status --short'] },
]

//逐鍵驗證守衛的鍵清單(R25.2; 外審 sol 變異 M02 存活): 其他鍵都給記錄用 spy、只缺一個鍵; 測試環境下須列出該鍵缺漏而 throw, 且沒有任何 spy 被呼叫; 正式模式該鍵走(已被換成 spy 的)預設實作, 其紀錄證明確實用了預設
let MISSING = [
    //resolveRegistryConfig 的預設實作是真函式(非 spy): 對照組(W_PKSUPDATE_REGISTRY 已給, 不啟動 npm)以其印出之『[registry] 主倉庫:』行證明走了預設實作(值為 { log: 正則 })
    { fn: 'publishPackages', keys: { checkGit: 'checkGit', publishPackage: 'publishPackage', resolveRegistryConfig: { log: /\[registry\] 主倉庫: http:\/\/localhost:48731\// } }, stubs: ['checkGit.mjs', 'publishPackage.mjs'] },
    {
        fn: 'publishPackage',
        keys: { getFolders: 'getFolders', parseProject: 'parseProject', getUpdate: 'getUpdate', updatePackage: 'updatePackage', ectScripts: 'ectScripts|npm i --registry=http://localhost:48731/|npm', runScript: 'ectScripts|node toolg/mark.mjs A|node' },
        stubs: ['getFolders.mjs', 'parseProject.mjs', 'getUpdate.mjs', 'updatePackage.mjs', 'ectScripts.mjs', 'checkNpmVersion.mjs'],
    },
    { fn: 'runScript', keys: { exec: 'ectScripts|node toolg/mark.mjs A|node' }, stubs: ['ectScripts.mjs', 'checkNpmVersion.mjs'] },
    { fn: 'checkGit', keys: { exec: 'ectScripts|git --version|git' }, stubs: ['ectScripts.mjs'] },
]
for (let m of MISSING) {
    for (let [key, ctl] of Object.entries(m.keys)) {
        let isLog = ctl !== null && typeof ctl === 'object'
        SITES.push({ site: `missing:${m.fn}:${key}`, guardSite: m.fn, missingKey: key, stubs: m.stubs, ctl: isLog ? [] : [ctl], ...(isLog ? { ctlLog: ctl.log } : {}) })
    }
}

//子程序環境: 旗標有無由 flagged 決定; 先清除可能由本 mocha 行程繼承的測試訊號, PATH 一律移除 PowerShell(雙保險)
let spawnSite = (c, flagged) => {
    fs.rmSync(fpCalls, { force: true })
    writeScript(fdPkg, ['node toolg/mark.mjs A']) //每案重寫 fixture 之 script.txt(有的站點案會改寫它)
    let env = { ...process.env }
    delete env[ENV_FLAG]
    delete env.npm_lifecycle_event
    env.PATH = stripPowerShell(getRealPath())
    if (flagged) {
        env[ENV_FLAG] = '1'
    }
    Object.assign(env, {
        STUB_MODE: 'guard',
        GUARD_STUBS: c.stubs.join(','),
        GUARD_EXEC_SPY: c.execSpy ? '1' : '0',
        FIXTURE_PKG: fdPkg,
        FIXTURE_NAME: 'sbx-ect-test',
        CALLS_FILE: fpCalls,
        NODE_USE_ENV_PROXY: '1',
        HTTP_PROXY: 'http://127.0.0.1:9',
        HTTPS_PROXY: 'http://127.0.0.1:9',
        NO_PROXY: '',
        W_PKSUPDATE_REGISTRY: 'http://localhost:48731/', //倉庫設定(帳本 R27): 對照組(正式模式)的 resolveRegistryConfig 取此值而不啟動 npm config get registry; 虛構之本機位址
        GIT_DIR: path.join(fdTmp, 'no-such-git-dir'), //雙保險: 若有 git 被啟動, 只會 fatal 而不碰任何倉庫
        OUTSIDE_PKG: path.resolve('./no-such-guard-pkg'), //不在 test/_tmp 內、也不存在之套件路徑(runScript.path / publishPackage.path 案)
    })
    let r = cp.spawnSync(process.execPath, ['--import', './test/tools/hooksStub.mjs', 'test/tools/guardCase.mjs', c.site], { env, encoding: 'utf8', timeout: 60000 })
    let line = String(r.stdout || '').split(/\r?\n/).reverse().find((s) => s.indexOf('RESULT_JSON:') === 0)
    if (!line) {
        throw new Error(`子程序無結果(site ${c.site}, status ${r.status}): ${String(r.stderr || '').slice(0, 800)}`)
    }
    let res = JSON.parse(line.slice('RESULT_JSON:'.length))
    res.calls = fs.existsSync(fpCalls) ? fs.readFileSync(fpCalls, 'utf8').split(/\r?\n/).filter((s) => s !== '') : []
    return res
}


//掛鉤握手: 該站點宣告要換成 spy 的每個模組(c.stubs、c.execSpy)在子程序內都解析到 test/tools/stubs/guard 下; 宣告之外的模組一個都沒被換(hookResolved 的鍵恰等於宣告)
let assertHooked = (c, r) => {
    let want = [...c.stubs, ...(c.execSpy ? ['wsemi/src/execProcess.mjs'] : [])].sort()
    assert.deepStrictEqual(Object.keys(r.hookResolved || {}).sort(), want, `站點[${c.site}]掛鉤握手: 回報的被換模組與宣告不符`)
    for (let [k, url] of Object.entries(r.hookResolved || {})) {
        assert.ok(/\/test\/tools\/stubs\/guard\/[^/]+\.mjs$/.test(String(url)), `站點[${c.site}]之 ${k} 未解析到 stubs/guard 的 spy: ${url}`)
    }
}


describe('各站點: 測試環境下未注入即呼叫 → throw 且未 spawn(R25.2、R25.3、R25.7; 子程序 + spy)', function() {

    before(function() {
        fs.rmSync(fdTmp, { recursive: true, force: true })
        mkFixturePkg(fdPkg)
        writeScript(fdPkg, ['node toolg/mark.mjs A'])
    })

    after(function() {
        fs.rmSync(fdTmp, { recursive: true, force: true })
        cleanTmpRoot()
    })

    for (let c of SITES) {

        it(`${c.site}: 測試旗標下未注入 → throw [testGuard] 含站點名, spy 無任何呼叫(未掃描套件區、未執行任何列、未啟動行程)`, function() {
            let r = spawnSite(c, true)
            assertHooked(c, r) //掛鉤握手: 帶旗標的負例子行程也確實接上了 spy(否則拿掉守衛的變異即不安全)
            assert.strictEqual(r.threw, true, JSON.stringify(r))
            assert.ok(r.message.indexOf('[testGuard]') >= 0, r.message)
            assert.ok(r.message.indexOf(`[${c.guardSite || c.site.replace(/\.path$/, '')}]`) >= 0, r.message)
            if (c.missingKey) {
                assert.ok(r.message.indexOf(`未注入 ${c.missingKey}(`) >= 0, `應只列缺漏之鍵[${c.missingKey}]: ${r.message}`)
            }
            if (c.ctlLog) {
                assert.ok(!c.ctlLog.test((r.logs || []).join('\n')), `擋下時不得走到真實核心(印出行): ${JSON.stringify(r.logs)}`)
            }
            assert.deepStrictEqual(r.calls, c.calls || [], `spy 被呼叫: ${JSON.stringify(r.calls)}`)
        })

        it(`${c.site}: 對照組(正式模式, 無測試旗標)→ 不 throw [testGuard]` + (c.ctl.length > 0 ? ', spy 有呼叫(證明 spy 有接上, 上一案的「無呼叫」不是空轉)' : ''), function() {
            let r = spawnSite(c, false)
            assertHooked(c, r)
            assert.ok(r.message.indexOf('[testGuard]') < 0, `正式模式不應被守衛擋下: ${JSON.stringify(r)}`)
            if (c.ctlMsg) {
                assert.ok(c.ctlMsg.test(r.message), `對照組應走到真實預設實作(訊息比對 ${c.ctlMsg}): ${JSON.stringify(r)}`)
            }
            if (c.ctlLog) {
                assert.ok(c.ctlLog.test((r.logs || []).join('\n')), `對照組應走到真實核心(印出行比對 ${c.ctlLog}): ${JSON.stringify(r.logs)}`)
            }
            for (let s of c.ctl) {
                assert.ok(r.calls.some((x) => x.indexOf(s) >= 0), `對照組應見 spy 紀錄[${s}]: ${JSON.stringify(r.calls)}`)
            }
        })

    }

    it('站點矩陣涵蓋帳本 R25.3 站點表之全部入口與接縫(含 R27 新增之 registryConfig.npmConfig; 另逐鍵缺漏 11 列: publishPackages 3、publishPackage 6、runScript 1、checkGit 1)', function() {
        assert.deepStrictEqual(SITES.filter((c) => !c.missingKey).map((c) => c.site).sort(), ['checkGit', 'checkGitStatus', 'checkNpmVersion', 'ectScripts', 'ectScripts.nonFnExec', 'ectScripts.realIdentity', 'ectScripts.undefExec', 'exitAfterFlush', 'getFolders', 'publishPackage', 'publishPackage.path', 'publishPackages', 'registryConfig.npmConfig', 'removeTarget.path', 'runScript', 'runScript.checkNpm', 'runScript.gitStatusDist', 'runScript.path', 'updatePackage.path'])
        assert.deepStrictEqual(SITES.filter((c) => c.missingKey).map((c) => c.site).sort(), [
            'missing:checkGit:exec',
            'missing:publishPackage:ectScripts', 'missing:publishPackage:getFolders', 'missing:publishPackage:getUpdate', 'missing:publishPackage:parseProject', 'missing:publishPackage:runScript', 'missing:publishPackage:updatePackage',
            'missing:publishPackages:checkGit', 'missing:publishPackages:publishPackage', 'missing:publishPackages:resolveRegistryConfig',
            'missing:runScript:exec',
        ])
    })

})


describe('realExec 刻意真實執行 helper 之拒絕(R25.5; 注入 spy 底層, 不啟動任何行程)', function() {

    let mk = () => {
        let seen = []
        let f = makeEctReal({
            ect: async (pdi, scps, opt) => {
                seen.push({ pdi, scps, execProcessIsFn: typeof opt.execProcess === 'function' })
                return 'ok'
            },
            execProcess: async () => '',
        })
        return { f, seen }
    }
    let pdiOk = { name: 'sbx', path: fdPkg }

    before(function() {
        fs.mkdirSync(fdShim, { recursive: true })
        fs.writeFileSync(path.join(fdShim, 'git.cmd'), '@echo off\r\nexit /b 0\r\n', 'utf8')
    })

    after(function() {
        fs.rmSync(fdTmp, { recursive: true, force: true })
        cleanTmpRoot()
    })

    //第 5 次外審 opus F02: 原為黑名單正則(引號、帶值選項、縮寫、絕對路徑 git.exe、alias、npx、呼叫運算子…等等價寫法皆通過), 改為白名單並與正式路徑共用 parseNpmCmd/getGitSubcommand
    it('npm 白名單: 只放行 run <fixture 腳本名>; publish、deploy、安裝、版本、帳號權限, 以及所有等價寫法(引號、帶值選項、縮寫、別名、npx、npm-cli.js、呼叫運算子、.cmd、陣列夾帶)一律拒絕, 底層 ectScripts 從未被呼叫', async function() {
        let cmds = [
            'npm publish', 'npm publish --tag next', 'npm run deploy', 'npm run deploy -- --message x', 'npm run-script deploy', 'npm i', 'npm i --registry=http://localhost:48731/', 'npm install x', 'npm ci', 'npm version patch', 'npm --silent publish', 'npm dist-tag add a@1 latest', 'npm unpublish a@1', 'npm login',
            //外審 opus 實測放行者
            'npm "publish"', 'npm \'publish\'', 'npm --loglevel warn publish', 'npm pu', 'npm publ', 'npm rum deploy', 'npm urn deploy', 'npm run "deploy"', 'npm --prefix x run deploy', 'npx -y npm@11 publish', '& \'npm\' publish', 'node node_modules/npm/bin/npm-cli.js publish', 'node ./node_modules/npm/bin/npx-cli.js publish', 'npm ins', 'npm isntall', 'npm cit', 'npm it',
            'npm rum build-ok', 'npm ru build-ok', 'npm runx build-ok', 'npm rn build-ok', 'npm test', 'npm start', 'npm exec x', 'npm x build-ok',
            'npm.cmd publish', 'npm.cmd run build-ok', 'C:\\Program Files\\nodejs\\npm.cmd publish', 'cmd /c npm publish', 'powershell -Command npm publish', 'npm run deploy:prod', 'npm run', 'npm', 'npm run ../x', ['node a.mjs', 'npm publish'], 'npm run build-ok ; npm publish', 'npm run build-ok && npm publish', 'npm run build-ok | cat',
        ]
        for (let cmd of cmds) {
            let { f, seen } = mk()
            await assert.rejects(f(pdiOk, cmd), /^Error: \[realExec\] 指令不在允許集合\(/, JSON.stringify(cmd))
            assert.deepStrictEqual(seen, [], JSON.stringify(cmd))
        }
    })

    it('fixture 內建置/唯讀指令放行, 且底層收到注入之 execProcess(npm run <腳本>、node、.bin、git --version、無墊片時之 git 唯讀子命令)', async function() {
        for (let cmd of ['npm run build-ok', 'npm run hang', 'npm run build-exit3', 'npm "run" "build-ok"', 'npm --silent run build-ok', 'npm run-script build-ok', 'node toolg/ok.mjs', 'node -e "console.log(1)"', 'node --unhandled-rejections=warn toolg/unhandled.mjs', './node_modules/.bin/fakebin 0', 'git --version', 'git status', 'git diff', 'git log -1', 'git show HEAD', 'git rev-parse HEAD', 'git ls-files']) {
            let { f, seen } = mk()
            await f(pdiOk, cmd, { main: 'node' })
            assert.deepStrictEqual(seen.map((x) => [x.scps, x.execProcessIsFn]), [[cmd, true]], cmd)
        }
    })

    it('git 無墊片: 只放行唯讀子命令與 git --version; 其餘(寫入/對外、等價寫法、alias、子命令外掛、絕對路徑與副檔名、會寫檔或起程式之選項)一律拒絕, 底層未被呼叫', async function() {
        let cmds = [
            'git push', 'git push origin master:master', 'git commit -m x', 'git add .  -A', 'git tag v1', 'git remote add a b', 'git fetch', 'git pull', 'git merge x', 'git reset --hard', 'git checkout -- .', 'git stash', 'git clean -fd', 'git -C x push', 'git -c a=b commit', 'git --no-pager push', 'git pusj',
            //外審 opus 實測放行者
            'git "push"', 'git -C "a b" push', 'git -c "user.name=a b" commit -m x', 'git -c alias.p=push p', 'git subtree push', 'git lfs push', 'git send-pack', 'git http-push', 'git update-index', 'git.exe push', 'git.cmd push', '& "C:\\Program Files\\Git\\cmd\\git.exe" push', 'C:\\Program Files\\Git\\cmd\\git.exe push', '/usr/bin/git push',
            'git diff --output=x.txt', 'git diff --output x.txt', 'git grep -Ocalc x', 'git diff --ext-diff', 'git log --textconv', 'git -c core.pager=x log', 'git --exec-path=x status', 'git -C . status', 'git --version x', 'git --help', 'git', 'git status ; git push', 'git status && git push',
        ]
        let pathNow = process.env.PATH
        try {
            process.env.PATH = stripPowerShell(getRealPath()) //首項非墊片目錄(fdShim 不在其中)
            for (let cmd of cmds) {
                let { f, seen } = mk()
                await assert.rejects(f(pdiOk, cmd), /^Error: \[realExec\] 指令不在允許集合\(/, cmd)
                assert.deepStrictEqual(seen, [], cmd)
            }
        }
        finally {
            process.env.PATH = pathNow
        }
    })

    it('PATH 首項目錄含 git.cmd 墊片 → 裸 git 之任何子命令放行(實際執行的是墊片); 但 git.exe / git.cmd / 絕對路徑 / 引號包住之程式記號 / npm 對外型仍拒絕', async function() {
        let pathNow = process.env.PATH
        try {
            process.env.PATH = `${fdShim};${pathNow}`
            for (let cmd of ['git push origin master:master', 'git commit -m x', 'git add .  -A', 'git "push"', 'git -c alias.p=push p', 'git tag v1', 'git pusj', 'git --shim-probe']) {
                let { f, seen } = mk()
                await f(pdiOk, cmd, { main: 'git' })
                assert.strictEqual(seen.length, 1, cmd)
            }
            for (let cmd of ['git.exe push', 'git.cmd push', '"git" push', '\'git\' push', '& git push', 'C:\\Program Files\\Git\\cmd\\git.exe push', 'npm publish', 'npm "publish"']) {
                let { f, seen } = mk()
                await assert.rejects(f(pdiOk, cmd), /^Error: \[realExec\] 指令不在允許集合\(/, cmd)
                assert.deepStrictEqual(seen, [], cmd)
            }
        }
        finally {
            process.env.PATH = pathNow
        }
    })

    it('墊片不在 PATH 首項(第二項以後)→ 視同無墊片(真 git 先被解析), 寫入型 git 拒絕', async function() {
        let pathNow = process.env.PATH
        try {
            process.env.PATH = `C:\\Windows\\System32;${fdShim};${pathNow}`
            let { f, seen } = mk()
            await assert.rejects(f(pdiOk, 'git push'), /^Error: \[realExec\] 指令不在允許集合\(/)
            assert.deepStrictEqual(seen, [])
        }
        finally {
            process.env.PATH = pathNow
        }
    })

    it('ectReal 執行期間設 GIT_CEILING_DIRECTORIES 為專案根(真 git 自 fixture 往上找不到本工具倉庫), 呼叫結束(含失敗)即還原原值', async function() {
        let ceilOri = process.env.GIT_CEILING_DIRECTORIES
        let seenCeil = []
        let f = makeEctReal({ ect: async () => {
            seenCeil.push(process.env.GIT_CEILING_DIRECTORIES)
            return 'ok'
        }, execProcess: async () => '' })
        let fFail = makeEctReal({ ect: async () => {
            seenCeil.push(process.env.GIT_CEILING_DIRECTORIES)
            throw new Error('boom')
        }, execProcess: async () => '' })
        try {
            delete process.env.GIT_CEILING_DIRECTORIES
            await f(pdiOk, 'node -v')
            assert.strictEqual(process.env.GIT_CEILING_DIRECTORIES, undefined)
            process.env.GIT_CEILING_DIRECTORIES = 'X:\\orig'
            await assert.rejects(fFail(pdiOk, 'node -v'), /boom/)
            assert.strictEqual(process.env.GIT_CEILING_DIRECTORIES, 'X:\\orig')
            assert.deepStrictEqual(seenCeil, [gitCeiling(), gitCeiling()])
            assert.strictEqual(gitCeiling(), realPathOf(path.resolve('.')))
        }
        finally {
            if (ceilOri === undefined) {
                delete process.env.GIT_CEILING_DIRECTORIES
            }
            else {
                process.env.GIT_CEILING_DIRECTORIES = ceilOri
            }
        }
    })

    it('環境事實: 以專案根為 GIT_CEILING_DIRECTORIES 時, 真 git 在 test/_tmp 內探索不到任何倉庫(唯讀 git rev-parse; 無 git 則略過)', function() {
        let fdProbe = path.resolve('./test/_tmp/unit-testGuard-ceiling')
        fs.rmSync(fdProbe, { recursive: true, force: true })
        fs.mkdirSync(fdProbe, { recursive: true })
        try {
            let run = (env) => cp.spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: fdProbe, env, encoding: 'utf8', timeout: 30000 })
            let envPlain = { ...process.env }
            delete envPlain.GIT_CEILING_DIRECTORIES
            delete envPlain.GIT_DIR
            let r0 = run(envPlain)
            if (r0.error || r0.status !== 0) {
                this.skip() //無 git 或不在倉庫內: 無從對照
            }
            assert.ok(r0.stdout.trim() !== '', '對照組: 無 ceiling 時 git 應探索到本工具倉庫')
            let r1 = run({ ...envPlain, GIT_CEILING_DIRECTORIES: gitCeiling() })
            assert.notStrictEqual(r1.status, 0, `有 ceiling 時不應探索到倉庫: ${r1.stdout}`)
        }
        finally {
            fs.rmSync(fdProbe, { recursive: true, force: true })
            cleanTmpRoot()
        }
    })

    it('執行目錄不在 <專案根>/test/_tmp 內 → 拒絕: 專案根、src、套件區、上層目錄、同名前綴旁支(test/_tmpx)、無 path、空字串', async function() {
        for (let p of [path.resolve('.'), path.resolve('./src'), 'C:\\opensrc\\開源-JS-001-1-w-package-tools\\w-package-tools', path.resolve('./test/_tmp/..'), path.resolve('./test/_tmp/../..'), path.resolve('./test/_tmpx'), path.resolve('./srcx'), path.resolve('./test'), '']) {
            let { f, seen } = mk()
            await assert.rejects(f({ name: 'sbx', path: p }, 'node -v'), /^Error: \[realExec\] 執行目錄\[.*\]不在 test\/_tmp 內/, p)
            assert.deepStrictEqual(seen, [], p)
        }
        let { f, seen } = mk()
        await assert.rejects(f({ name: 'sbx' }, 'node -v'), /不在 test\/_tmp 內/)
        assert.deepStrictEqual(seen, [])
    })

    it('assertConfined 放行 test/_tmp 與其子孫(未正規化輸入亦先正規化再比對); 錨點由程式位置推得, process.chdir 後不搬家', function() {
        for (let p of [path.resolve('./test/_tmp'), fdPkg, path.join(fdPkg, 'docs'), `${path.resolve('./test/_tmp')}\\a\\..\\b`]) {
            assertConfined(p)
        }
        for (let p of [`${path.resolve('./test/_tmp')}\\..\\..`, `${path.resolve('./test/_tmp')}\\..`, `${path.resolve('./test/_tmp')}/../../src`]) {
            assert.throws(() => assertConfined(p), /^Error: \[realExec\] 執行目錄/, p)
        }
        let cwdOri = process.cwd()
        let fdOther = path.resolve('./test/_chdirprobe') //在專案內、但不在 test/_tmp 之下; 內含另一個 test/_tmp(原本取 cwd 相對之錨點時, chdir 到此後它會被放行、真正的 fixture 反被拒)
        fs.rmSync(fdOther, { recursive: true, force: true })
        fs.mkdirSync(path.join(fdOther, 'test', '_tmp'), { recursive: true })
        try {
            process.chdir(fdOther)
            assertConfined(fdPkg)
            assert.throws(() => assertConfined(path.join(fdOther, 'test', '_tmp')), /^Error: \[realExec\] 執行目錄/)
            assert.doesNotThrow(() => assertConfinedToTestTmp('x', fdPkg))
            assert.throws(() => assertConfinedToTestTmp('x', path.join(fdOther, 'test', '_tmp')), /不在 test\/_tmp 內/)
        }
        finally {
            process.chdir(cwdOri)
            fs.rmSync(fdOther, { recursive: true, force: true })
        }
    })

    it('assertConfined 同樣以實體路徑比對: test/_tmp 內指向專案其他資料夾(非 src)的 junction → throw; 指向 test/_tmp 內者放行', function() {
        let fdJ = path.resolve('./test/_tmp/unit-testGuard-junction2')
        fs.rmSync(fdJ, { recursive: true, force: true })
        fs.mkdirSync(path.join(fdJ, 'inside'), { recursive: true })
        let linkOut = path.join(fdJ, 'to-test')
        let linkIn = path.join(fdJ, 'to-inside')
        fs.symlinkSync(path.resolve('./test'), linkOut, 'junction') //指向 test(在 test/_tmp 之上一層, 且不是 src)
        fs.symlinkSync(path.join(fdJ, 'inside'), linkIn, 'junction')
        try {
            for (let p of [linkOut, path.join(linkOut, 'tools'), path.join(linkOut, 'no-such', 'child')]) {
                assert.throws(() => assertConfined(p), /^Error: \[realExec\] 執行目錄/, p)
            }
            assertConfined(linkIn)
            assertConfined(path.join(linkIn, 'not-yet'))
        }
        finally {
            fs.rmdirSync(linkOut)
            fs.rmdirSync(linkIn)
            fs.rmSync(fdJ, { recursive: true, force: true })
            cleanTmpRoot()
        }
    })

    it('assertCommandsAllowed 為純檢查: 單一字串與陣列皆可, 不啟動任何行程', function() {
        assertCommandsAllowed('node -v')
        assertCommandsAllowed(['node -v', 'npm run build-ok'])
        assert.throws(() => assertCommandsAllowed(['node -v', 'npm publish']), /指令不在允許集合\(npm 只放行 run/)
    })

    it('gitStatusDistReal 的目錄限制先於任何 git 執行: 專案根/套件區 → throw [realExec]', function() {
        assert.throws(() => gitStatusDistReal(path.resolve('.')), /^Error: \[realExec\] 執行目錄/)
        assert.throws(() => gitStatusDistReal('C:\\opensrc'), /^Error: \[realExec\] 執行目錄/)
    })

})


describe('盤點: 真實執行接縫與守衛(R25.4; 新增接縫而未登錄即紅)', function() {

    //站點表: 檔案 → { guards: 必須出現於該檔之守衛文字, reason: 未守衛之理由, exports: 該檔匯出名稱之完整清單(釘死) }
    //exports 釘死的理由(外審 sol 變異 M07): 已登錄的接縫檔內新增一個未守衛的匯出函式(同檔內新接縫)時, 檔案層級的登錄不會變紅; 匯出清單一變即紅, 迫使逐一審查該匯出是否為接縫
    let TABLE = {
        'src/ectScripts.mjs': { guards: ['assertRealExecAllowed(\'ectScripts\'', 'opt.execProcess === execProcess'], exports: ['DEFAULT_TIMEOUT_MS', 'GIT_FATAL_EXIT_CODE', 'GIT_LENIENT_SUBS', 'PRINTED_FAIL_STRINGS', 'RE_GIT_NO_CHANGE', 'TIMEOUT_GRACE_MS', 'composeCommand', 'createOutputCollector', 'default', 'detectPrintedFailure', 'getExecDetail', 'getGitSubcommand', 'getTimeoutGraceMs', 'getTimeoutMs', 'getUnjudgedMessage', 'isTimeoutMessage', 'judgeResult'] },
        'src/runScript.mjs': { guards: ['requireInjected(\'runScript\'', 'assertConfinedToTestTmp(\'runScript\'', 'assertRealExecAllowed(\'runScript.checkNpm\'', 'assertRealExecAllowed(\'runScript.gitStatusDist\'', 'assertConfinedToTestTmp(\'removeTarget\''], exports: ['RM_DELAY_MS', 'RM_RETRIES', 'RM_RETRY_CODES', 'checkMainFiles', 'classifyLine', 'default', 'getPublishTargetIssue', 'getRetryMessage', 'getRetryPolicy', 'hasNpmRegistryOverride', 'hasShellControl', 'isAddVersionCmd', 'isDeployCmd', 'isLocalGitCmd', 'isNetworkPushError', 'isOutwardCmd', 'isPublishCmd', 'isPushCmd', 'isReadonlyGitCmd', 'isRemoteCmd', 'isSafeRmTarget', 'judgeDistStatus', 'loadScript', 'parseNpmCmd', 'parseScript', 'removeTarget', 'runWithRetry'] },
        'src/publishPackage.mjs': { guards: ['requireInjected(\'publishPackage\'', 'assertConfinedToTestTmp(\'publishPackage\'', 'assertSingleLink(\'publishPackage\''], exports: ['default'] },
        'src/publishPackages.mjs': { guards: ['requireInjected(\'publishPackages\''], exports: ['default'] },
        'src/checkGit.mjs': { guards: ['requireInjected(\'checkGit\''], exports: ['default'] },
        'src/registryConfig.mjs': { guards: ['assertRealExecAllowed(\'registryConfig.npmConfig\''], exports: ['ENV_MIRRORS', 'ENV_REGISTRY', 'formatRegistryConfig', 'getNpmConfigRegistry', 'normalizeRegistryUrl', 'parseMirrorList', 'resolveRegistryConfig'] },
        'src/checkNpmVersion.mjs': { guards: ['requireInjected(\'checkNpmVersion\''], exports: ['AUTH_FAIL_MAX', 'MAX_WAIT_MS', 'REQUEST_TIMEOUT_MS', 'default'] },
        'src/getFolders.mjs': { guards: ['assertRealExecAllowed(\'getFolders\''], exports: ['default'] },
        'src/checkGitStatus.mjs': { guards: ['assertRealExecAllowed(\'checkGitStatus\''], exports: ['default'] },
        'src/updatePackage.mjs': { guards: ['assertConfinedToTestTmp(\'updatePackage\'', 'assertSingleLink(\'updatePackage\''], exports: ['default'] },
        'src/runMain.mjs': { guards: ['assertRealExecAllowed(\'exitAfterFlush\''], exports: ['default', 'exitAfterFlush'] },
        'src/checkProjectLevels.mjs': { reason: '唯讀; 經 getFolders 傳遞守衛', exports: ['default'] },
        'g_checkAndCommit.mjs': { reason: '手動入口(commit/push), 測試不載入; 其 ectScripts 與 checkGitStatus 接縫皆已守衛', exports: [] },
        'g_checkBuildScripts.mjs': { reason: '唯讀入口; 子程序測試經掛鉤換入 getFolders 樁', exports: [] },
        'g_checkProjectLevels.mjs': { reason: '唯讀入口; getFolders 已守衛', exports: [] },
        'g_listUpdates.mjs': { reason: '唯讀入口; 子程序測試經掛鉤換入 getFolders 樁', exports: [] },
        'g_updateAndPublic.mjs': { reason: '正式發布入口; 測試環境下載入即經 checkProjectLevels → getFolders 守衛而 throw, 測試不載入(下方案釘住)', exports: [] },
    }

    //接縫特徵(去註解後): 子行程/執行、網路、寫檔刪檔、真實套件區、動態載入或 require 這些模組(外審 sol 變異 M05、M06、M08: 原正則漏了 http 等網路模組、子資料夾與動態 import)
    let RE_SEAM = new RegExp([
        'child_process', 'worker_threads', '\\bcluster\\b', 'execProcess', 'execCli', 'execSync', 'execFileSync', 'spawn', '\\bfetch\\(', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'undici',
        '[\'"`](?:node:)?(?:https?|http2|net|tls|dgram|dns)[\'"`]',
        'writeFileSync', 'appendFileSync', 'copyFileSync', 'cpSync', 'rmSync', 'rmdirSync', 'unlinkSync', 'renameSync', 'symlinkSync', 'linkSync', 'truncateSync', 'utimesSync', 'chmodSync', 'mkdirSync',
        '\\bfs\\.promises\\b', 'fs/promises',
        '\\bfs\\.(?:writeFile|appendFile|copyFile|cp|rm|rmdir|unlink|rename|symlink|link|truncate|mkdir)\\b',
        'process\\.binding', 'process\\.dlopen', 'process\\.exit\\b', 'createWriteStream',
        '\\bw\\.(?:exec|fsDelete|fsWrite|fsCopy|fsDownload|fsCleanFolder|fsMerge|fsRename|fsMove|fsCreate)\\w*',
        '\\bgetFolders\\b',
    ].join('|'))

    let strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
    let ls = (fd, re) => fs.readdirSync(path.resolve(fd)).filter((n) => re.test(n)).map((n) => fd === '.' ? n : `${fd}/${n}`)
    //遞迴列檔(排除 node_modules 與 test/_tmp)
    let lsRec = (fd, re) => {
        let out = []
        for (let d of fs.readdirSync(path.resolve(fd), { withFileTypes: true })) {
            let rel = `${fd}/${d.name}`
            if (d.name === 'node_modules' || rel === 'test/_tmp') {
                continue
            }
            if (d.isDirectory()) {
                out.push(...lsRec(rel, re))
            }
            else if (re.test(d.name)) {
                out.push(rel)
            }
        }
        return out
    }
    //匯出名稱(去註解後): export { a, b as c }、export default、export function/const/let/var/class
    let exportsOf = (code) => {
        let out = new Set()
        let m
        let re1 = /export\s*\{([^}]*)\}/g
        while ((m = re1.exec(code)) !== null) {
            for (let x of m[1].split(',').map((t) => t.trim()).filter(Boolean)) {
                out.add(x.split(/\s+as\s+/).pop().trim())
            }
        }
        if (/export\s+default\b/.test(code)) {
            out.add('default')
        }
        let re3 = /export\s+(?:async\s+)?(?:function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g
        while ((m = re3.exec(code)) !== null) {
            out.add(m[1])
        }
        return [...out].sort()
    }

    it('src/**(遞迴)與 g_*.mjs 中凡含接縫特徵者, 皆已登錄於站點表(附守衛或未守衛理由)', function() {
        let found = []
        for (let rel of [...lsRec('src', /\.(mjs|cjs|js)$/), ...ls('.', /^g_.*\.mjs$/)]) {
            if (rel === 'src/testGuard.mjs') {
                continue //守衛本身
            }
            let code = strip(fs.readFileSync(path.resolve(rel), 'utf8'))
            if (RE_SEAM.test(code)) {
                found.push(rel)
            }
        }
        let missing = found.filter((rel) => !TABLE[rel])
        assert.deepStrictEqual(missing, [], `新增接縫未登錄(須同時補守衛與帳本 R25.3): ${missing.join(', ')}`)
        assert.ok(found.length >= 8, `掃描到的接縫檔過少(掃描失效?): ${found.join(', ')}`)
    })

    it('接縫特徵正則本身: 各類接縫寫法都命中(防止正則被改弱而盤點空轉); 無關程式碼不命中', function() {
        for (let s of [
            'import cp from \'child_process\'', 'await import(\'node:child_process\')', 'require("child_process")', 'import { Worker } from \'worker_threads\'', 'import http from \'node:http\'', 'import https from "https"', 'import net from \'net\'', 'const t = \'tls\'', 'import dgram from \'dgram\'',
            'execProcess(a)', 'w.execCli(x)', 'cp.execFileSync(a)', 'cp.execSync(a)', 'cp.spawn(a)', 'await fetch(u)', 'new XMLHttpRequest()', 'new WebSocket(u)', 'import { request } from \'undici\'',
            'fs.writeFileSync(a)', 'fs.cpSync(a, b)', 'fs.symlinkSync(a, b)', 'fs.promises.rm(a)', 'import fsp from \'fs/promises\'', 'fs.rename(a, b, cb)', 'fs.mkdirSync(a)', 'process.binding(\'spawn_sync\')', 'getFolders()',
            'fs.rmSync(a)', 'fs.rmdirSync(a)', 'fs.unlinkSync(a)', 'fs.renameSync(a, b)', 'fs.appendFileSync(a, b)', 'fs.copyFileSync(a, b)', 'fs.linkSync(a, b)', 'fs.truncateSync(a)', 'fs.utimesSync(a, 1, 1)', 'fs.chmodSync(a, 0)', 'process.dlopen(m, f)',
            'process.exit(1)', 'fs.createWriteStream(a)', 'w.fsDeleteFolder(a)', 'w.fsWriteText(a, b)', 'w.execJsCode(a)', 'w.fsDownloadFile(u, f)', 'w.fsCleanFolder(a)',
            'new EventSource(u)', 'cluster.fork()', 'import dns from \'dns\'', 'import h2 from \'http2\'', 'import { execFileSync } from \'x\'', 'fs.writeFile(a, b, cb)', 'fs.appendFile(a, b, cb)', 'fs.copyFile(a, b, cb)', 'fs.cp(a, b, cb)', 'fs.rm(a, cb)', 'fs.rmdir(a, cb)', 'fs.unlink(a, cb)', 'fs.symlink(a, b, cb)', 'fs.link(a, b, cb)', 'fs.truncate(a, cb)', 'fs.mkdir(a, cb)',
        ]) {
            assert.ok(RE_SEAM.test(s), s)
        }
        for (let s of ['let a = 1', 'import path from \'path\'', 'fs.readFileSync(a)', 'fs.existsSync(a)', 'let fetchOk = true', 'const httpStatus = 200', 'import _ from \'lodash-es\'', 'process.exitCode = 1', 'w.fsGetFoldersInFolder(a)', 'w.isestr(a)']) {
            assert.ok(!RE_SEAM.test(s), s)
        }
    })

    it('exportsOf(釘住匯出清單的剖析器): 各種匯出寫法皆辨識', function() {
        let code = 'export { a, b as c, d }\nexport default function x() {}\nexport const K = 1\nexport async function f() {}\nexport let L = 2\nexport class C {}\nexport function* g() {}'
        assert.deepStrictEqual(exportsOf(code), ['C', 'K', 'L', 'a', 'c', 'd', 'default', 'f', 'g'])
        assert.deepStrictEqual(exportsOf('let a = 1'), [])
    })

    it('已登錄接縫檔的匯出清單釘死: 清單一變(新增/刪除/改名匯出)即紅, 須逐一審查該匯出是否為接縫並同步更新本表與帳本 R25.3', function() {
        for (let [rel, e] of Object.entries(TABLE)) {
            let got = exportsOf(strip(fs.readFileSync(path.resolve(rel), 'utf8')))
            assert.deepStrictEqual(got, [...e.exports].sort(), `${rel} 匯出清單變動`)
        }
    })

    it('站點表每一列: 有守衛者, 守衛文字必須實際存在於該檔; 無守衛者必須附理由', function() {
        for (let [rel, e] of Object.entries(TABLE)) {
            let code = fs.readFileSync(path.resolve(rel), 'utf8')
            if (e.guards) {
                for (let g of e.guards) {
                    assert.ok(code.indexOf(g) >= 0, `${rel} 缺守衛[${g}]`)
                }
            }
            else {
                assert.ok(typeof e.reason === 'string' && e.reason.length > 0, `${rel} 未守衛須附理由`)
            }
        }
    })

    it('守衛的呼叫不得只存在於註解或字串: 站點表守衛文字於去註解後仍存在', function() {
        for (let [rel, e] of Object.entries(TABLE)) {
            if (!e.guards) {
                continue
            }
            let code = strip(fs.readFileSync(path.resolve(rel), 'utf8'))
            for (let g of e.guards) {
                assert.ok(code.indexOf(g) >= 0, `${rel} 之守衛[${g}]只出現在註解`)
            }
        }
    })

    it('「刻意真實執行」完整清單: 引用 realExec.mjs 之檔案恰為下列(新增者須先列入並經審查)', function() {
        let users = usersOf(/realExec\.mjs/).filter((rel) => rel !== 'test/tools/realExec.mjs') //遞迴(含 test/tools/stubs/**)
        assert.deepStrictEqual(users, ['test/tools/orphanMain.mjs', 'test/tools/runCase.mjs', 'test/unit-checkGit.test.mjs', 'test/unit-ectScripts-ps.test.mjs', 'test/unit-testGuard.test.mjs'])
    })

    //test/** 遞迴、去註解後的字樣掃描(含動態 import、require; 外審 sol 變異 M08: 原只認靜態 import 行)
    let testFiles = () => lsRec('test', /\.(mjs|cjs|js)$/)
    //只濾掉整行註解(不用 strip 的區塊註解移除: 測試檔的字串內常有 /* 或 // 字樣, 區塊移除會誤吞真實程式碼而漏列)
    let stripLines = (s) => s.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
    let usersOf = (re) => testFiles().filter((rel) => re.test(stripLines(fs.readFileSync(path.resolve(rel), 'utf8')))).sort()

    it('含 child_process 字樣(靜態/動態 import、require、字串)之測試檔與工具完整清單(新增者須先列入並經審查): 只起 node 子程序(經 hooksStub/guardCase)、fixture 內真 PowerShell(經 realExec)、PowerShell 之 CIM 唯讀查詢與 Stop-Process 清除標記孤兒', function() {
        assert.deepStrictEqual(usersOf(/child_process/), [
            'test/tools/guardCase.mjs', //子程序內把 child_process.execSync 換成只記錄的 spy 以觀測 checkGitStatus 守衛(不起任何行程)
            'test/tools/mkFixturePkg.mjs', //fixture 腳本 toolg/orphan.mjs 之內容字串(測試自建的孤兒孫程序腳本, 於 test/_tmp 內由 ectReal 執行); 非本檔自己啟動行程
            'test/tools/realExec.mjs', //ectReal 的底層限制與 gitStatusDistReal(限 test/_tmp)
            'test/unit-checkBuildScripts-entry.test.mjs', //node 子程序(g_checkBuildScripts.mjs, 唯讀; getFolders 換樁)
            'test/unit-ectScripts-ps.test.mjs', //node 子程序(orphanMain) + 以標記查詢/清除自己產生的 hang 孤兒程序(PowerShell CIM)
            'test/unit-listUpdates.test.mjs', //node 子程序(g_listUpdates.mjs, 唯讀; getFolders 換樁)
            'test/unit-runScript-ps.test.mjs', //node 子程序(runCase)與資料夾占用者(node -e)
            'test/unit-testGuard.test.mjs', //node 子程序(guardCase; 站點之下一層為 spy, PATH 無 PowerShell)
        ])
    })

    it('含其他行程/網路/多執行緒模組字樣之測試檔與工具: 無(worker_threads、cluster、http/https/net/tls/dgram/dns、undici、execCli、wsemi 的 execProcess 直接匯入僅 realExec)', function() {
        assert.deepStrictEqual(usersOf(/worker_threads|\bcluster\b|['"`](?:node:)?(?:https?|http2|net|tls|dgram|dns)['"`]|undici|\bexecCli\b|process\.binding|process\.dlopen/), ['test/unit-testGuard.test.mjs']) //本檔之正則字面值與案例字串
        assert.deepStrictEqual(usersOf(/from\s+['"]wsemi\/src\/execProcess(\.mjs)?['"]/), ['test/tools/realExec.mjs'])
        assert.deepStrictEqual(usersOf(/\bw\.execProcess\b/), [])
    })

    //外審 opus F01: 原只比『import/require 與檔名在同一列』, 以變數持有檔名或獨立一列的寫法漏網; 改為整個 test/** 內(去整行註解)完全不得出現這兩個正式發布入口的名稱——
    //起子行程跑它們(例如替 R16 補『進入點離開碼』整合測試)在單檔執行且父檔未載入 testGuard 時守衛全關, 即 run04 事故重演. 例外僅下列兩檔: 本檔(規則字面值與案例)與 unit-runMain(只以 fs 讀入原始碼做靜態斷言, 不載入也不起行程)
    it('測試檔與工具完全不得出現正式入口 g_updateAndPublic、g_checkAndCommit 之名稱(載入即執行全庫連動/commit); 例外僅 unit-runMain(靜態讀碼)與本檔', function() {
        assert.deepStrictEqual(usersOf(/g_(?:updateAndPublic|checkAndCommit)/), ['test/unit-ectScripts-ps.test.mjs', 'test/unit-ectScripts.test.mjs', 'test/unit-runMain.test.mjs', 'test/unit-testGuard.test.mjs'])
        //ectScripts 兩檔只在 it('…') 測試標題文字內提及『g_checkAndCommit 合併列』(列種類之說明), 不得出現在任何程式敘述
        for (let rel of ['test/unit-ectScripts-ps.test.mjs', 'test/unit-ectScripts.test.mjs']) {
            let lines = stripLines(fs.readFileSync(path.resolve(rel), 'utf8')).split('\n').filter((l) => /g_(?:updateAndPublic|checkAndCommit)/.test(l))
            assert.ok(lines.length > 0 && lines.every((l) => /^\s*it\(/.test(l)), `${rel} 提及正式入口名稱處須僅為 it() 標題: ${lines.filter((l) => !/^\s*it\(/.test(l)).join(' | ')}`)
        }
        let code = stripLines(fs.readFileSync(path.resolve('test/unit-runMain.test.mjs'), 'utf8'))
        assert.ok(!/child_process|spawn|import\s*\(|\brequire\s*\(/.test(code), 'unit-runMain 不得起行程或動態載入')
        assert.ok(/readFileSync\([^)]*g_updateAndPublic\.mjs/.test(code.replace(/\s+/g, ' ')) || /g_updateAndPublic\.mjs/.test(code), 'unit-runMain 僅讀其原始碼')
    })

    it('測試檔與工具不得使用 wsemi 之寫檔/刪檔/複製/下載/執行類 API(w.exec*、w.fsDelete*、w.fsWrite*、w.fsCopy*、w.fsDownload*、w.fsCleanFolder*…): 僅本檔之正則案例字串', function() {
        assert.deepStrictEqual(usersOf(/\bw\.(?:exec|fsDelete|fsWrite|fsCopy|fsDownload|fsCleanFolder|fsMerge|fsRename|fsMove|fsCreate)\w*/), ['test/unit-testGuard.test.mjs'])
    })

})
