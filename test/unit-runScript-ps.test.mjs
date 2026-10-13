//runScript 與 publishPackage 整合測試(子程序; fixture 於 test/_tmp/runScript-ps, before 建立、after 刪除)
//子程序以 test/tools/hooksStub.mjs 換掉 checkNpmVersion(publishPackage 另換套件區相關模組), 不碰套件區, 失敗時亦不會卡住 mocha
//對應需求: R07 執行前檢查(runScript 與 publishPackage 之副作用順序)、R08 rm -r、R02 失敗列之後不執行
//不含任何 git、deploy、npm publish、npm i
import assert from 'assert'
import fs from 'fs'
import path from 'path'
import cp from 'child_process'
import { mkFixturePkg, mkDocs, writeScript, readTrace, cleanTmpRoot } from './tools/mkFixturePkg.mjs'


let fdTmp = path.resolve('./test/_tmp/runScript-ps')
let fdPkg = path.join(fdTmp, 'pkg')
let fdOutside = path.join(fdTmp, 'outside')
let fpCalls = path.join(fdTmp, 'calls.txt')


let runCase = (mode, script, opt = {}) => {
    fs.rmSync(path.join(fdPkg, '_trace.txt'), { force: true })
    fs.rmSync(fpCalls, { force: true })
    fs.rmSync(path.join(fdPkg, 'docs'), { recursive: true, force: true })
    if (opt.docs) {
        mkDocs(fdPkg)
    }
    writeScript(fdPkg, script)
    let r = cp.spawnSync(process.execPath, ['--import', './test/tools/hooksStub.mjs', 'test/tools/runCase.mjs', mode], {
        env: { ...process.env, STUB_MODE: mode, FIXTURE_PKG: fdPkg, FIXTURE_NAME: 'sbx-ect-test', CALLS_FILE: fpCalls },
        encoding: 'utf8',
        timeout: 120000,
    })
    let line = String(r.stdout || '').split(/\r?\n/).reverse().find((s) => s.indexOf('RESULT_JSON:') === 0)
    if (!line) {
        throw new Error(`子程序無結果(status ${r.status}): ${String(r.stderr || '').slice(0, 800)}`)
    }
    let res = JSON.parse(line.slice('RESULT_JSON:'.length))
    res.trace = readTrace(fdPkg)
    res.calls = fs.existsSync(fpCalls) ? fs.readFileSync(fpCalls, 'utf8').split(/\r?\n/).filter((s) => s !== '') : []
    res.docsExists = fs.existsSync(path.join(fdPkg, 'docs'))
    return res
}


describe('runScript 與 publishPackage 整合(子程序)', function() {

    before(function() {
        fs.rmSync(fdTmp, { recursive: true, force: true })
        mkFixturePkg(fdPkg)
        fs.mkdirSync(fdOutside, { recursive: true })
        fs.writeFileSync(path.join(fdOutside, 'keep.txt'), 'keep', 'utf8')
    })

    after(function() {
        fs.rmSync(fdTmp, { recursive: true, force: true })
        cleanTmpRoot()
    })

    it('runScript: node 列失敗即中止, 其後之列不執行', function() {
        let r = runCase('runScript', ['node toolg/mark.mjs A', 'node toolg/throwErr.mjs', 'node toolg/mark.mjs B'])
        assert.strictEqual(r.ok, false)
        assert.ok(/node指令失敗\(code\[1\]\)/.test(r.message), r.message)
        assert.deepStrictEqual(r.trace, ['mark.mjs A', 'throwErr.mjs'])
    })

    it('runScript: 含非預期指令即於第一列之前中止, addVersion 未執行', function() {
        let r = runCase('runScript', ['#node toolg/addVersion.mjs', 'node toolg/mark.mjs A', 'npx something'])
        assert.strictEqual(r.ok, false)
        assert.ok(r.message.indexOf('[sbx-ect-test] 非預期指令(執行前檢查, 尚未執行任何列): 第3列[npx something]') === 0, r.message)
        assert.deepStrictEqual(r.trace, [])
        assert.deepStrictEqual(r.calls, [])
    })

    it('runScript: rm -r 之目標在套件外即於第一列之前中止, 套件外檔案不受影響', function() {
        let r = runCase('runScript', ['node toolg/mark.mjs A', 'rm -r ../outside'])
        assert.strictEqual(r.ok, false)
        assert.ok(/非預期指令\(執行前檢查/.test(r.message), r.message)
        assert.deepStrictEqual(r.trace, [])
        assert.strictEqual(fs.existsSync(path.join(fdOutside, 'keep.txt')), true)
    })

    it('runScript: rm -r docs 於 docs 存在時移除並續行下一列', function() {
        let r = runCase('runScript', ['rm -r docs', 'node toolg/throwErr.mjs'], { docs: true })
        assert.strictEqual(r.ok, false)
        assert.ok(/node指令失敗/.test(r.message), r.message) //中止於下一列, 證明 rm 列成功續行
        assert.strictEqual(r.docsExists, false)
        assert.deepStrictEqual(r.trace, ['throwErr.mjs'])
    })

    it('runScript: rm -r docs 於 docs 不存在時視為成功並續行下一列', function() {
        let r = runCase('runScript', ['rm -r docs', 'node toolg/throwErr.mjs'], { docs: false })
        assert.strictEqual(r.ok, false)
        assert.ok(/node指令失敗/.test(r.message) && r.message.indexOf('rm指令失敗') < 0, r.message)
        assert.deepStrictEqual(r.trace, ['throwErr.mjs'])
    })

    it('runScript: 全部良性(含 stderr 警告、rm、.bin、npm run)即跑完並走到最終閘門', function() {
        let r = runCase('runScript', ['node toolg/mark.mjs A', 'node toolg/okStderr.mjs', 'rm -r docs', './node_modules/.bin/fakebin 0', 'npm run build-ok', 'node toolg/mark.mjs B'], { docs: true })
        assert.strictEqual(r.ok, true, r.message)
        assert.deepStrictEqual(r.trace, ['mark.mjs A', 'okStderr.mjs', 'ok.mjs', 'mark.mjs B'])
        assert.strictEqual(r.docsExists, false)
        assert.deepStrictEqual(r.calls, ['checkNpmVersion|sbx-ect-test@0.0.1'])
    })

    it('publishPackage: 含非預期指令即於 update package.json 與 npm i 之前中止', function() {
        let r = runCase('publishPackage', ['#node toolg/addVersion.mjs', 'node toolg/mark.mjs A', 'npx something'])
        assert.strictEqual(r.ok, false)
        assert.ok(r.message.indexOf('[sbx-ect-test] 非預期指令(執行前檢查') === 0, r.message)
        assert.deepStrictEqual(r.calls, [])
    })

    it('publishPackage: 合法 script.txt 依序 update package.json → npm i → 各列 → 最終閘門', function() {
        let r = runCase('publishPackage', ['#node toolg/addVersion.mjs', 'node toolg/mark.mjs A', 'rm -r docs', './node_modules/.bin/fakebin 0', 'npm run build-ok'], { docs: true })
        assert.strictEqual(r.ok, true, r.message)
        assert.strictEqual(r.publish, true)
        assert.deepStrictEqual(r.calls, [
            'updatePackage',
            'ectScripts|npm i --registry=https://registry.npmjs.org/|npm',
            'ectScripts|node toolg/addVersion.mjs|node',
            'ectScripts|node toolg/mark.mjs A|node',
            'ectScripts|./node_modules/.bin/fakebin 0|',
            'ectScripts|npm run build-ok|npm',
            'checkNpmVersion|sbx-ect-test@0.0.1',
        ])
        assert.strictEqual(r.docsExists, false) //rm 列由 runScript 以 Node 執行, 不經 ectScripts
    })

})
