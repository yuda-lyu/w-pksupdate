//runScript 與 publishPackage 整合測試(子程序; fixture 於 test/_tmp/runScript-ps, before 建立、after 刪除)
//子程序以 test/tools/hooksStub.mjs 換掉 checkNpmVersion(publishPackage 另換套件區相關模組), 不碰套件區, 失敗時亦不會卡住 mocha
//對應需求: R07 執行前檢查(runScript 與 publishPackage 之副作用順序)、R08 rm -r、R02 失敗列之後不執行; 帳本(CLAUDE_rulebook.md 1.3) R13 未判定列之留痕
//不含任何 git、deploy、npm publish、npm i
import assert from 'assert'
import fs from 'fs'
import path from 'path'
import cp from 'child_process'
import { mkFixturePkg, mkDocs, writeScript, readTrace, cleanTmpRoot } from './tools/mkFixturePkg.mjs'
import { getRealPath } from './tools/testEnv.mjs' //子程序的 runScript 模式刻意走真實 PowerShell(帳本 R25.5), 須明確給原 PATH(全域測試環境預設從 PATH 移除 PowerShell, R25.6)


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
    return spawnCase(mode, opt)
}

//不重建 docs 與 script.txt(呼叫端已備妥, 如占用情境), 只清 trace 與 calls 後執行子程序
let runCaseNoDocs = (mode, opt = {}) => {
    fs.rmSync(path.join(fdPkg, '_trace.txt'), { force: true })
    fs.rmSync(fpCalls, { force: true })
    return spawnCase(mode, opt)
}

let spawnCase = (mode, opt = {}) => {
    let r = cp.spawnSync(process.execPath, ['--import', './test/tools/hooksStub.mjs', 'test/tools/runCase.mjs', mode], {
        env: { ...process.env, PATH: getRealPath(), W_PKSUPDATE_TEST: '1', STUB_MODE: mode, FIXTURE_PKG: fdPkg, FIXTURE_NAME: 'sbx-ect-test', CALLS_FILE: fpCalls, ...(opt.env || {}) },
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
        //Windows 下占用者(R14 案例之 cwd 占用行程)剛結束時資料夾句柄可能尚未釋放(EPERM/EBUSY): 重試約 5 秒再放棄, 清理的暫時失敗不應使整個測試檔失敗(第二輪實跑偶發)
        let t0 = Date.now()
        for (;;) {
            try {
                fs.rmSync(fdTmp, { recursive: true, force: true })
                break
            }
            catch (err) {
                if (Date.now() - t0 > 5000) {
                    throw err
                }
                Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250)
            }
        }
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
        assert.deepStrictEqual(r.unjudged, []) //R13: 成功之 .bin 列不留痕
    })

    it('runScript: .bin 列 exit 5 → 不中止, 留痕一行後續行下一列並走到最終閘門(R5＋R13)', function() {
        let r = runCase('runScript', ['node toolg/mark.mjs A', './node_modules/.bin/fakebin 5', 'node toolg/mark.mjs B'])
        assert.strictEqual(r.ok, true, r.message)
        assert.deepStrictEqual(r.trace, ['mark.mjs A', 'mark.mjs B'])
        assert.deepStrictEqual(r.unjudged, ['[sbx-ect-test] 未判定(code[5]): ./node_modules/.bin/fakebin 5'])
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

    //---- 帳本 R14: rm -r 遇真實之資料夾占用(子行程 cwd 設在 docs/sub; 占用者為獨立 OS 行程, 不受本行程同步阻塞影響) ----
    //占用者在占用成立後寫 marker, 並於 ms 毫秒後自行結束
    let startHolder = (ms) => {
        let marker = path.join(fdTmp, `holder-${Date.now()}.ready`)
        let code = `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ready'); setTimeout(() => {}, ${ms})`
        let h = cp.spawn(process.execPath, ['-e', code], { cwd: path.join(fdPkg, 'docs', 'sub'), stdio: 'ignore' })
        let t0 = Date.now()
        while (!fs.existsSync(marker) && Date.now() - t0 < 10000) {
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)
        }
        assert.ok(fs.existsSync(marker), '占用者未就緒')
        return h
    }
    //結束占用者並等到它確實消失(同步輪詢; 避免它仍占用 docs 而使後續案例之清理失敗)
    let killHolder = (h) => {
        try {
            h.kill()
        }
        catch (err) { /* 已結束 */ }
        let t0 = Date.now()
        for (;;) {
            try {
                process.kill(h.pid, 0)
            }
            catch (err) {
                return
            }
            if (Date.now() - t0 > 8000) {
                return
            }
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)
        }
    }

    it('R14.1 rm -r docs 遇暫時占用(約 1.2 秒後釋放)→ 重試後成功並續行下一列', function() {
        fs.rmSync(path.join(fdPkg, 'docs'), { recursive: true, force: true })
        mkDocs(fdPkg)
        let h = startHolder(1200)
        try {
            writeScript(fdPkg, ['rm -r docs', 'node toolg/mark.mjs B'])
            let r = runCaseNoDocs('runScript')
            assert.strictEqual(r.ok, true, r.message)
            assert.deepStrictEqual(r.trace, ['mark.mjs B']) //rm 列成功後續行
            assert.strictEqual(r.docsExists, false)
        }
        finally {
            killHolder(h)
        }
    })

    it('R14.2 rm -r docs 遇持續占用 → 用盡 20 次×500ms 後 throw rm指令失敗(含路徑、碼、已重試20次), 其後之列不執行, 耗時約 10 秒', function() {
        fs.rmSync(path.join(fdPkg, 'docs'), { recursive: true, force: true })
        mkDocs(fdPkg)
        let h = startHolder(120000)
        try {
            let t0 = Date.now()
            writeScript(fdPkg, ['rm -r docs', 'node toolg/mark.mjs B'])
            let r = runCaseNoDocs('runScript')
            let dt = Date.now() - t0
            assert.strictEqual(r.ok, false)
            assert.ok(/^\[sbx-ect-test\] rm指令失敗: 無法移除\[.*docs\]: (EPERM|EBUSY)\((rm|rmdir|unlink)\), 已重試20次\(間隔500ms\); 目標可能已部分刪除/.test(r.message), r.message)
            assert.deepStrictEqual(r.trace, []) //其後之列未執行
            assert.strictEqual(r.docsExists, true)
            assert.ok(dt >= 9000 && dt < 60000, `耗時 ${dt}ms`)
        }
        finally {
            killHolder(h)
        }
    })

})
