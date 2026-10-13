//ectScripts 整合測試(真 PowerShell 子程序; fixture 於 test/_tmp/ectScripts-ps, before 建立、after 刪除)
//對應需求: R01 組法(cd 失敗不執行、找不到指令不遮蔽、原生離開碼傳出)、R02、R03、R04、R05; 帳本(CLAUDE_rulebook.md 1.3) R12 失敗摘要、R13 未判定列之留痕
//不含任何 git、deploy、npm publish、npm i
import assert from 'assert'
import fs from 'fs'
import path from 'path'
import ectScripts from '../src/ectScripts.mjs'
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

    before(function() {
        fs.rmSync(fdTmp, { recursive: true, force: true })
        mkFixturePkg(fdPkg)
    })

    after(function() {
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
