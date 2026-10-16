//ectScripts 整合測試(真 PowerShell 子程序; fixture 於 test/_tmp/ectScripts-ps, before 建立、after 刪除)
//對應需求: R01 組法(cd 失敗不執行、找不到指令不遮蔽、原生離開碼傳出)、R02、R03、R04、R05; 帳本(CLAUDE_rulebook.md 1.3) R12 失敗摘要、R13 未判定列之留痕
//不含任何 git、deploy、npm publish、npm i
import assert from 'assert'
import fs from 'fs'
import path from 'path'
import cp from 'child_process'
import { ectReal as ectScripts } from './tools/realExec.mjs' //刻意走真實 PowerShell(帳本 R25.5): 限 test/_tmp 內 fixture、拒絕對外型指令; git 列須 PATH 首項為墊片
import { getRealPath } from './tools/testEnv.mjs' //全域測試環境預設從 PATH 移除 PowerShell(R25.6), 本檔明確取回原 PATH(opt-in)
import { mkFixturePkg, readTrace, cleanTmpRoot } from './tools/mkFixturePkg.mjs'


let fdTmp = path.resolve('./test/_tmp/ectScripts-ps')
let fdPkg = path.join(fdTmp, 'pkg')
let pdi = { name: 'sbx-ect-test', path: fdPkg }


//執行期間把 ectScripts 之即時輸出收進 logs(每次呼叫前清空), 不印到測試報告; 供留痕斷言(R13)
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
let unjudged = () => logs.filter((s) => s.indexOf('未判定(') >= 0)


//暫時自 PATH 移除含 powershell.exe 之目錄(prog 'powershell' 因而無法啟動), 結束後還原
let withoutPowerShell = async (fn) => {
    let pathOri = process.env.PATH
    process.env.PATH = pathOri.split(';').filter((s) => s && !fs.existsSync(path.join(s, 'powershell.exe'))).join(';')
    try {
        return await fn()
    }
    finally {
        process.env.PATH = pathOri
    }
}


describe('ectScripts 整合(真 PowerShell 子程序)', function() {

    let pathSaved = null

    before(function() {
        pathSaved = process.env.PATH
        process.env.PATH = getRealPath()
        fs.rmSync(fdTmp, { recursive: true, force: true })
        mkFixturePkg(fdPkg)
    })

    after(function() {
        process.env.PATH = pathSaved
        fs.rmSync(fdTmp, { recursive: true, force: true })
        cleanTmpRoot()
    })

    it('node 列成功且 stderr 有警告 → 通過, 回傳之輸出含 stdout 與 stderr, 不留痕(R13: 成功不印)', async function() {
        let c = await quiet(() => ectScripts(pdi, 'node toolg/okStderr.mjs', { main: 'node' }))
        assert.ok(c.indexOf('built ok') >= 0)
        assert.ok(c.indexOf('Browserslist') >= 0)
        assert.deepStrictEqual(unjudged(), [])
    })

    it('node 列未捕捉例外 → node指令失敗(code[1])', async function() {
        await assert.rejects(quiet(() => ectScripts(pdi, 'node toolg/throwErr.mjs', { main: 'node' })), /^Error: \[sbx-ect-test\] node指令失敗\(code\[1\]\): node toolg\/throwErr\.mjs/)
    })

    it('node 列 process.exit(3) → node指令失敗(code[3])(原生離開碼原樣傳出), 不留痕(R13: 判定為失敗之列改為 throw)', async function() {
        await assert.rejects(quiet(() => ectScripts(pdi, 'node toolg/exit3.mjs', { main: 'node' })), /node指令失敗\(code\[3\]\)/)
        assert.deepStrictEqual(unjudged(), [])
    })

    it('node 列自接 catch 印出 [RollupError] 而 exit 0 → rollup編譯失敗', async function() {
        await assert.rejects(quiet(() => ectScripts(pdi, 'node toolg/rollupMarker.mjs', { main: 'node' })), /\] rollup編譯失敗: node toolg\/rollupMarker\.mjs/)
    })

    it('node 列判定字樣跨 64KB 讀取邊界(65524 位元組後) → 仍判 rollup編譯失敗', async function() {
        await assert.rejects(quiet(() => ectScripts(pdi, 'node toolg/bigThenMarker.mjs 65524', { main: 'node' })), /rollup編譯失敗/)
    })

    it('找不到 node(PATH 遺失) → node指令失敗(code[1]), 不被遮成成功', async function() {
        let pathOri = process.env.PATH
        let nodeDir = path.dirname(process.execPath).toLowerCase().replace(/\\+$/, '')
        process.env.PATH = pathOri.split(';').filter((s) => s && s.toLowerCase().replace(/\\+$/, '') !== nodeDir).join(';')
        try {
            await assert.rejects(quiet(() => ectScripts(pdi, 'node toolg/ok.mjs', { main: 'node' })), /node指令失敗\(code\[1\]\)/)
        }
        finally {
            process.env.PATH = pathOri
        }
    })

    it('套件路徑不存在(cd 失敗) → 指令不執行且 node指令失敗(code[1])', async function() {
        let pdiNone = { name: 'sbx-none', path: path.join(fdTmp, 'no-such-dir') }
        await assert.rejects(quiet(() => ectScripts(pdiNone, `node -e "console.log('cwd=' + process.cwd())"`, { main: 'node' })), (err) => {
            //訊息會回顯指令本身(含字樣 cwd=), 故以「cwd= 後接磁碟機代號」判斷指令是否真的執行過
            return /node指令失敗\(code\[1\]\)/.test(err.message) && !/cwd=[A-Za-z]:/.test(err.message)
        })
    })

    it('npm run 之腳本 exit 3(npm 不印 npm error) → npm指令失敗(code[3])', async function() {
        await assert.rejects(quiet(() => ectScripts(pdi, 'npm run build-exit3', { main: 'npm' })), /npm指令失敗\(code\[3\]\)/)
    })

    it('.bin 列 exit 5(無 main) → 不判定, 通過, 並留痕一行 未判定(code[5])(R13)', async function() {
        let c = await quiet(() => ectScripts(pdi, './node_modules/.bin/fakebin 5'))
        assert.ok(c.indexOf('fakebin exit=5') >= 0)
        assert.deepStrictEqual(unjudged(), ['[sbx-ect-test] 未判定(code[5]): ./node_modules/.bin/fakebin 5'])
    })

    it('PATH 無 PowerShell(程序無法啟動) × node 列 → node指令失敗(spawn[ENOENT] spawn powershell ENOENT), 指令未執行(R1＋R12)', async function() {
        let traceBefore = readTrace(fdPkg)
        await withoutPowerShell(async () => {
            await assert.rejects(quiet(() => ectScripts(pdi, 'node toolg/ok.mjs', { main: 'node' })), (err) => {
                return err.message.indexOf('[sbx-ect-test] node指令失敗(spawn[ENOENT] spawn powershell ENOENT): node toolg/ok.mjs') === 0
            })
        })
        assert.deepStrictEqual(readTrace(fdPkg), traceBefore)
        assert.deepStrictEqual(unjudged(), [])
    })

    it('指令含空字元(node 參數檢查) × node 列 → 摘要接上說明, 且不外洩組好之 PowerShell 指令(R1＋R12)', async function() {
        let traceBefore = readTrace(fdPkg)
        await assert.rejects(quiet(() => ectScripts(pdi, 'node toolg/ok.mjs a\u0000b', { main: 'node' })), (err) => {
            let m = err.message
            return m.indexOf(`[sbx-ect-test] node指令失敗(spawn[ERR_INVALID_ARG_VALUE] The argument 'args[1]' must be a string without null bytes): node toolg/ok.mjs`) === 0 &&
                m.indexOf('$ErrorActionPreference') < 0
        })
        assert.deepStrictEqual(readTrace(fdPkg), traceBefore)
    })

    it('PATH 無 PowerShell × .bin 列(無 main) → 不判定、回傳空字串, 並留痕 未判定(spawn[ENOENT] spawn powershell ENOENT)(R5＋R13)', async function() {
        let c = await withoutPowerShell(() => quiet(() => ectScripts(pdi, './node_modules/.bin/fakebin 0')))
        assert.strictEqual(c, '')
        assert.deepStrictEqual(unjudged(), ['[sbx-ect-test] 未判定(spawn[ENOENT] spawn powershell ENOENT): ./node_modules/.bin/fakebin 0'])
    })

})


//帳本 R15(離開碼 0 時之輸出特徵)、R18(逾時): 真 PowerShell 子程序; fixture 於 test/_tmp/ectScripts-ps-r15
describe('ectScripts 整合 R15 自接 catch 與 R18 逾時(真 PowerShell 子程序)', function() {

    let fdTmp2 = path.resolve('./test/_tmp/ectScripts-ps-r15')
    let fdPkg2 = path.join(fdTmp2, 'pkg')
    let pdi2 = { name: 'sbx-r15', path: fdPkg2 }

    //每個逾時測試用唯一標記當 hang.mjs 的參數, 殘留計數只看自己的標記: 其他並行的 mocha、其他測試或外部程序的 hang.mjs 不會被算進來(外審 F14、O-11)
    let hangSeq = 0
    let newHangId = () => `H${process.pid}x${Date.now()}x${++hangSeq}`
    let hangFilter = (id) => `$_.Name -eq 'node.exe' -and $_.CommandLine -like '*hang.mjs*${id}*'`
    //該標記之 node 子孫程序數(逾時後應為 0); CIM/WMI 查詢失敗或輸出非數字時回傳 null(呼叫端據此 skip, 不當成失敗也不當成通過)
    //$ErrorActionPreference='Stop': Get-CimInstance 的非終止錯誤(PermissionDenied、命名空間不存在)改為終止錯誤 → PowerShell 以 1 結束 → execFileSync 拋出 → 回 null;
    //否則非終止錯誤只印 stderr、Measure-Object 仍輸出 0、exit 0, 「無殘留」斷言假綠(第二輪 N3, 外審 F14 未修好處); opt.namespace 僅供測試以不存在之命名空間造出查詢失敗
    let countHang = (id, opt = {}) => {
        try {
            let ns = opt.namespace ? ` -Namespace '${opt.namespace}'` : ''
            let s = cp.execFileSync('powershell', ['-NoProfile', '-Command', `$ErrorActionPreference = 'Stop'; (Get-CimInstance${ns} Win32_Process | Where-Object { ${hangFilter(id)} } | Measure-Object).Count`], { encoding: 'utf8', timeout: 30000 })
            let c = Number(String(s).trim())
            return Number.isInteger(c) ? c : null
        }
        catch (err) {
            return null
        }
    }
    //測試失敗時盡力清掉自己標記的殘留(hang.mjs 會活 120 秒), 避免干擾後續測試
    let killHang = (id) => {
        try {
            cp.execFileSync('powershell', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process | Where-Object { ${hangFilter(id)} } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`], { timeout: 30000 })
        }
        catch (err) { /* 無殘留或查詢失敗 */ }
    }
    let esc = (s) => s.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')
    //逾時 1 個測試的共同流程: 執行 → 驗拒絕 → 驗無殘留(查詢失敗則 skip)
    let expectTimeout = async (ctx, id, runFn, re) => {
        try {
            let t0 = Date.now()
            await assert.rejects(quiet(runFn), re)
            assert.ok(Date.now() - t0 < 10000, `耗時 ${Date.now() - t0}ms`)
            await new Promise((r) => setTimeout(r, 800))
            let c = countHang(id)
            if (c === null) {
                ctx.skip() //CIM 查詢失敗: 無法確認殘留, 標為 pending 而非通過或失敗
            }
            assert.strictEqual(c, 0)
        }
        finally {
            killHang(id)
        }
    }

    let pathSaved2 = null

    before(function() {
        pathSaved2 = process.env.PATH
        process.env.PATH = getRealPath()
        fs.rmSync(fdTmp2, { recursive: true, force: true })
        mkFixturePkg(fdPkg2)
    })

    after(function() {
        process.env.PATH = pathSaved2
        fs.rmSync(fdTmp2, { recursive: true, force: true })
        cleanTmpRoot()
    })

    it('R15.1 node 列自接 catch 以 console.log(err) 印出 Error 物件而 exit 0 → node指令失敗(exit 0 但輸出含錯誤堆疊)', async function() {
        await assert.rejects(quiet(() => ectScripts(pdi2, 'node toolg/throwCaught.mjs', { main: 'node' })), /^Error: \[sbx-r15\] node指令失敗\(exit 0 但輸出含錯誤堆疊\): node toolg\/throwCaught\.mjs/)
        assert.deepStrictEqual(unjudged(), []) //判定為失敗之列改為 throw, 不留痕(R13)
    })

    it('R15.2 node 列自接 catch 印出字串 reject(invalid fpSrc, 無堆疊)而 exit 0 → node指令失敗(exit 0 但輸出含[invalid fpSrc])', async function() {
        await assert.rejects(quiet(() => ectScripts(pdi2, 'node toolg/rejectStringCaught.mjs', { main: 'node' })), /node指令失敗\(exit 0 但輸出含\[invalid fpSrc\]\): node toolg\/rejectStringCaught\.mjs/)
    })

    it('R15.5(第二輪 N1) 真 Node: --unhandled-rejections=warn 下未處理的建置失敗以 exit 0 結束並印 UnhandledPromiseRejectionWarning 與堆疊 → 仍判 node指令失敗(exit 0 但輸出含錯誤堆疊); 預設(不加旗標)則 exit 1 → code[1]', async function() {
        await assert.rejects(quiet(() => ectScripts(pdi2, 'node --unhandled-rejections=warn toolg/unhandled.mjs', { main: 'node' })), /node指令失敗\(exit 0 但輸出含錯誤堆疊\)/)
        await assert.rejects(quiet(() => ectScripts(pdi2, 'node toolg/unhandled.mjs', { main: 'node' })), /node指令失敗\(code\[1\]\)/)
    })

    it('R15.4 同樣的輸出於未給 main 之列(git、.bin 同型)不判定 → 通過', async function() {
        let c = await quiet(() => ectScripts(pdi2, 'node toolg/throwCaught.mjs'))
        assert.ok(c.indexOf('boom-caught') >= 0)
    })

    it('R15.5 良性: stderr 警告與 Browserslist 提示之 node 列 → 通過', async function() {
        let c = await quiet(() => ectScripts(pdi2, 'node toolg/okStderr.mjs', { main: 'node' }))
        assert.ok(c.indexOf('built ok') >= 0)
    })

    //R15.7 設計限制: 靜默 catch 無任何文字特徵, 現行判定無法攔下; 以 pending 標記指向 R22(g_checkBuildScripts)與源頭修改, 不把『通過』寫成 baseline
    it.skip('R15.7(已知落差, 設計限制) 靜默 catch(()=>{}) 而 exit 0 → 應判失敗, 但無任何文字特徵; 由 g_checkBuildScripts(R22)與源頭修改處理', async function() {
        await assert.rejects(quiet(() => ectScripts(pdi2, 'node toolg/silentCatch.mjs', { main: 'node' })))
    })

    it('R18.2 node 列卡住超過 timeoutMs → node指令失敗(timeout[1500ms]), 耗時 < 10 秒, 且無殘留之 node 子孫程序 (R18.4)', async function() {
        let id = newHangId()
        await expectTimeout(this, id, () => ectScripts(pdi2, `node toolg/hang.mjs ${id}`, { main: 'node', timeoutMs: 1500 }), new RegExp(`node指令失敗\\(timeout\\[1500ms\\]\\): node toolg/hang\\.mjs ${esc(id)}`))
    })

    it('R18.2 未給 main 之列(git、.bin 同型)卡住超過 timeoutMs → 指令逾時(timeout[1500ms]), 且無殘留', async function() {
        let id = newHangId()
        await expectTimeout(this, id, () => ectScripts(pdi2, `node toolg/hang.mjs ${id}`, { timeoutMs: 1500 }), new RegExp(`^Error: \\[sbx-r15\\] 指令逾時\\(timeout\\[1500ms\\]\\): node toolg/hang\\.mjs ${esc(id)}`))
    })

    it('R18.2 npm 列逾時 → npm指令失敗(timeout[…]) (以 npm run 呼叫卡住腳本; 無殘留)', async function() {
        let id = newHangId()
        fs.writeFileSync(path.join(fdPkg2, 'package.json'), JSON.stringify({ name: 'sbx-r15', version: '0.0.1', private: true, scripts: { hang: `node toolg/hang.mjs ${id}` } }), 'utf8')
        await expectTimeout(this, id, () => ectScripts(pdi2, 'npm run hang', { main: 'npm', timeoutMs: 2500 }), /npm指令失敗\(timeout\[2500ms\]\): npm run hang/)
    })

    it('R18.6 孤兒孫程序持有輸出管道(父程序已結束、孫程序脫離並繼承 stdout)→ execProcess 不落定; ectScripts 於 timeoutMs + timeoutGraceMs 後判逾時失敗並註明仍未落定, 不等孤兒結束(孤兒須另行清除; 已知限制)', async function() {
        let id = newHangId()
        let t0 = Date.now()
        try {
            await assert.rejects(
                quiet(() => ectScripts(pdi2, `node toolg/orphan.mjs ${id}`, { main: 'node', timeoutMs: 1500, timeoutGraceMs: 1500 })),
                (err) => {
                    assert.ok(new RegExp(`^Error: \\[sbx-r15\\] node指令失敗\\(timeout\\[1500ms\\]\\): node toolg/orphan\\.mjs ${esc(id)}`).test(String(err)), String(err))
                    assert.ok(err.message.indexOf('逾時後仍未落定, 子程序樹可能未清除') >= 0, err.message)
                    return true
                }
            )
            let dt = Date.now() - t0
            assert.ok(dt >= 2800 && dt < 15000, `耗時 ${dt}ms`) //約 1500 + 1500; 遠小於孤兒存活的 120 秒
        }
        finally {
            killHang(id) //孤兒不會自行消失(已知限制), 測試自行清除
        }
    })

    it('第二輪 N2 孤兒持有管道、寬限到期後: 以入口相同之收尾(runMain + exitAfterFlush)執行 → 約 3 秒內以離開碼 1 結束且輸出錯誤(R16.4); 不呼叫 exitAfterFlush 的對照則會被孤兒拖住(見 tmp 手動探測)', async function() {
        let id = newHangId()
        let t0 = Date.now()
        try {
            let r = cp.spawnSync(process.execPath, [path.resolve('./test/tools/orphanMain.mjs')], {
                cwd: path.resolve('.'),
                env: { ...process.env, FIXTURE_PKG: fdPkg2, HANG_ID: id },
                encoding: 'utf8',
                timeout: 30000,
            })
            let dt = Date.now() - t0
            assert.strictEqual(r.error, undefined, String(r.error)) //spawnSync 逾時(行程未結束)會有 r.error
            assert.strictEqual(r.status, 1, (r.stdout || '') + (r.stderr || ''))
            assert.ok(dt < 12000, `耗時 ${dt}ms`) //孤兒存活 120 秒; 未強制結束時行程會一直等
            assert.ok((r.stdout || '').indexOf('逾時後仍未落定, 子程序樹可能未清除') >= 0, r.stdout)
        }
        finally {
            killHang(id)
        }
    })

    it('第二輪 N3(F14 補修) 查詢失敗(CIM 命名空間不存在, 與 PermissionDenied 同為非終止錯誤)時, 殘留計數回 null 而不是 0, 即不會假綠; 目標程序存活與否不影響', async function() {
        let id = newHangId()
        let child = cp.spawn(process.execPath, [path.join(fdPkg2, 'toolg', 'hang.mjs'), id], { cwd: fdPkg2, stdio: 'ignore' })
        try {
            await new Promise((r) => setTimeout(r, 1200))
            let ok = countHang(id)
            if (ok === null) {
                this.skip() //本機 CIM 本就不可用
            }
            assert.strictEqual(ok, 1) //正常查詢看得到存活的程序
            assert.strictEqual(countHang(id, { namespace: 'root\\nonexistent_ns' }), null) //查詢失敗 → null(原回 0)
        }
        finally {
            child.kill()
            killHang(id)
        }
    })

    it('F14 兩個測試的殘留計數互不干擾: 以另一標記啟動的 hang.mjs 活著時, 本標記的計數仍為 0', async function() {
        let idOther = newHangId()
        let idMine = newHangId()
        let child = cp.spawn(process.execPath, [path.join(fdPkg2, 'toolg', 'hang.mjs'), idOther], { cwd: fdPkg2, stdio: 'ignore' })
        try {
            await new Promise((r) => setTimeout(r, 1200))
            let cOther = countHang(idOther)
            if (cOther === null) {
                this.skip()
            }
            assert.strictEqual(cOther, 1)
            assert.strictEqual(countHang(idMine), 0)
        }
        finally {
            child.kill()
            killHang(idOther)
        }
    })

    it('R18.3 未逾時之判定不變: timeoutMs 夠長、timeoutMs 為 null 或 0(不限制)之短列皆通過', async function() {
        for (let timeoutMs of [60000, null, 0]) {
            let c = await quiet(() => ectScripts(pdi2, 'node toolg/ok.mjs', { main: 'node', timeoutMs }))
            assert.ok(c.indexOf('ok 中文輸出') >= 0, `timeoutMs=${timeoutMs}`)
        }
    })

})


//R6 git 列依子命令判定: 以墊片 git.cmd 取代真 git(PATH 最前), 絕不執行真 git; 墊片印標記後依環境變數 GIT_SHIM_EXIT 結束、GIT_SHIM_OUT 另印一行 stdout;
//指令以 `git push`/`git commit`/`git add` 等實際形態送入, 但因 PATH 最前為墊片, 實際執行的是墊片(以輸出含 shim-git 標記斷言墊片確實被執行, 若失效落到真 git 即紅且 push/commit 無遠端/無變更可能有副作用——故每案先斷言 PATH 前提)
describe('ectScripts 整合 R6 git 列依子命令判定(真 PowerShell 子程序 + 墊片 git.cmd, 不執行真 git)', function() {

    let fdTmp3 = path.resolve('./test/_tmp/ectScripts-ps-git')
    let fdPkg3 = path.join(fdTmp3, 'pkg')
    let fdShim = path.join(fdTmp3, 'gitshim')
    let pdi3 = { name: 'sbx-git-test', path: fdPkg3 }
    let pathOri = null //含 PowerShell 之原 PATH(墊片目錄接於其前)
    let pathSaved3 = null //進入本組前之 PATH(全域環境下不含 PowerShell), after 還原
    let exitOri = null
    let outOri = null

    let gitDirOri = null

    before(async function() {
        fs.rmSync(fdTmp3, { recursive: true, force: true })
        mkFixturePkg(fdPkg3)
        fs.mkdirSync(fdShim, { recursive: true })
        //墊片: 印標記(stdout)後, GIT_SHIM_OUT 非空則另印該行(stdout); 128 時 fatal 寫 stderr(同真 git 的 die(); 外審 opus F4:
        //若墊片寫 stdout, 日後組法在 PowerShell 內重導 stderr〔2>&1〕而使真 git 的 128 被壓成 1 時, 本測試仍會綠; 寫 stderr 則該回歸會轉紅); 最後以 %GIT_SHIM_EXIT% 結束
        fs.writeFileSync(path.join(fdShim, 'git.cmd'), '@echo off\r\necho shim-git called: %*\r\nif defined GIT_SHIM_OUT echo %GIT_SHIM_OUT%\r\nif defined GIT_SHIM_ERR echo %GIT_SHIM_ERR% 1>&2\r\nif "%GIT_SHIM_EXIT%"=="128" echo fatal: Unable to create index.lock: File exists. 1>&2\r\nexit /b %GIT_SHIM_EXIT%\r\n', 'utf8')
        pathSaved3 = process.env.PATH
        pathOri = getRealPath()
        exitOri = process.env.GIT_SHIM_EXIT
        outOri = process.env.GIT_SHIM_OUT
        process.env.PATH = `${fdShim};${pathOri}`
        //雙重保險: GIT_DIR 指向不存在之路徑, 即使墊片未被解析而落到真 git, 真 git 也只會 fatal 而不碰任何倉庫(本檔含 git push/commit 指令字串)
        gitDirOri = process.env.GIT_DIR
        process.env.GIT_DIR = path.join(fdTmp3, 'no-such-git-dir')
        //前提探測: 以無害參數確認 PowerShell 解析到的 git 是墊片(輸出含 shim-git 標記); 否則整組測試中止
        process.env.GIT_SHIM_EXIT = '0'
        delete process.env.GIT_SHIM_OUT
        let c = await quiet(() => ectScripts(pdi3, 'git --shim-probe', {})).catch((e) => String(e.message))
        if (String(c).indexOf('shim-git called: --shim-probe') < 0) {
            throw new Error(`墊片 git.cmd 未被 PowerShell 解析到, 中止本組測試以免執行真 git: ${String(c).slice(0, 200)}`)
        }
    })

    after(function() {
        process.env.PATH = pathSaved3
        if (gitDirOri === undefined) {
            delete process.env.GIT_DIR
        }
        else {
            process.env.GIT_DIR = gitDirOri
        }
        delete process.env.GIT_SHIM_ERR
        for (let [k, v] of [['GIT_SHIM_EXIT', exitOri], ['GIT_SHIM_OUT', outOri]]) {
            if (v === undefined) {
                delete process.env[k]
            }
            else {
                process.env[k] = v
            }
        }
        fs.rmSync(fdTmp3, { recursive: true, force: true })
        cleanTmpRoot()
    })

    let runGit = (cmd, code, opt, outLine = '', errLine = '') => {
        process.env.GIT_SHIM_EXIT = String(code)
        for (let [k, v] of [['GIT_SHIM_OUT', outLine], ['GIT_SHIM_ERR', errLine]]) {
            if (v === '') {
                delete process.env[k]
            }
            else {
                process.env[k] = v
            }
        }
        return quiet(() => ectScripts(pdi3, cmd, opt))
    }
    let G = { main: 'git' }

    it('墊片確實先於真 git 被執行(測試前提): exit 0 通過且輸出含 shim-git 標記與實際參數', async function() {
        let c = await runGit('git status', 0, G)
        assert.ok(c.indexOf('shim-git called: status') >= 0, c)
        assert.deepStrictEqual(unjudged(), [])
    })

    it('git push × exit 1(push 被拒、遠端規則拒絕同形)→ throw git指令失敗(code[1]), 不留痕(C1)', async function() {
        await assert.rejects(runGit('git push origin master:master', 1, G), (err) => {
            return /^\[sbx-git-test\] git指令失敗\(code\[1\]\): git push origin master:master/.test(err.message) && err.message.indexOf('shim-git called: push origin master:master') >= 0
        })
        assert.deepStrictEqual(unjudged(), [])
    })

    it('外審 opus F8 git push × exit 0 且 stderr 有 To https://… 進度輸出(真 git 的正常形態)→ 通過, 不留痕(經真 PowerShell 組法: 原生程式寫 stderr 不因 Stop 而中止)', async function() {
        let c = await runGit('git push origin master:master', 0, G, '', 'To https://github.com/x/y')
        assert.ok(c.indexOf('To https://github.com/x/y') >= 0, c)
        assert.deepStrictEqual(unjudged(), [])
    })

    it('外審 opus F1 git pusj(錯字)× exit 1 與 git tag × exit 1 → throw(非白名單子命令嚴格)', async function() {
        await assert.rejects(runGit('git pusj origin master:master', 1, G), /git指令失敗\(code\[1\]\): git pusj/)
        await assert.rejects(runGit('git tag v1', 1, G), /git指令失敗\(code\[1\]\): git tag v1/)
    })

    it('git push × exit 0 通過; × exit 128(fatal 寫 stderr)→ throw 且訊息含 fatal 輸出', async function() {
        await runGit('git push origin master:master', 0, G)
        await assert.rejects(runGit('git push origin master:master', 128, G), (err) => /git指令失敗\(code\[128\]\): git push/.test(err.message) && err.message.indexOf('index.lock') >= 0)
    })

    it('git commit × exit 1 且 stdout 含 nothing to commit → 通過並留痕 未判定(code[1]) (C1 良性片語)', async function() {
        let c = await runGit(`git commit -m "modify: update pks"`, 1, G, 'nothing to commit, working tree clean')
        assert.ok(c.indexOf('nothing to commit') >= 0)
        assert.strictEqual(unjudged().length, 1)
        assert.ok(unjudged()[0].indexOf('[sbx-git-test] 未判定(code[1]): git commit') === 0, unjudged()[0])
    })

    it('git commit × exit 1 且無無變更片語(hook 失敗同形)→ throw git指令失敗(code[1])', async function() {
        await assert.rejects(runGit(`git commit -m "modify: update pks"`, 1, G, 'pre-commit hook failed'), /git指令失敗\(code\[1\]\): git commit/)
        await assert.rejects(runGit(`git commit -m "modify: update pks"`, 1, G), /git指令失敗\(code\[1\]\)/)
    })

    it('git commit × exit 128/255 → throw; × exit 127 → throw(commit 除良性 exit 1 外一律失敗)', async function() {
        for (let n of [128, 255, 127, 2]) {
            await assert.rejects(runGit(`git commit -m "x"`, n, G), new RegExp(`git指令失敗\\(code\\[${n}\\]\\)`), String(n))
        }
    })

    it('git add × exit 1 → 通過並留痕(add 維持 ≥128); × exit 127 → 通過; × exit 128/255 → throw', async function() {
        await runGit('git add .  -A', 1, G)
        assert.strictEqual(unjudged().length, 1)
        await runGit('git add .  -A', 127, G)
        assert.strictEqual(unjudged().length, 1)
        for (let n of [128, 255]) {
            await assert.rejects(runGit('git add .  -A', n, G), new RegExp(`git指令失敗\\(code\\[${n}\\]\\): git add`), String(n))
        }
    })

    it('git -C . push(帶全域選項)× exit 1 → throw(子命令辨識略過全域選項)', async function() {
        await assert.rejects(runGit('git -C . push', 1, G), /git指令失敗\(code\[1\]\): git -C \. push/)
    })

    it('未給 main(.bin、g_checkAndCommit 同型)× exit 1/128 → 仍不判定, 通過並留痕 (R6.3)', async function() {
        await runGit('git push', 1, {})
        assert.deepStrictEqual(unjudged(), ['[sbx-git-test] 未判定(code[1]): git push'])
        await runGit('git push', 128, {})
        assert.deepStrictEqual(unjudged(), ['[sbx-git-test] 未判定(code[128]): git push'])
    })

})
