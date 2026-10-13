//ectScripts 整合測試(真 PowerShell 子程序; fixture 於 test/_tmp/ectScripts-ps, before 建立、after 刪除)
//對應需求: R01 組法(cd 失敗不執行、找不到指令不遮蔽、原生離開碼傳出)、R02、R03、R04、R05
//不含任何 git、deploy、npm publish、npm i
import assert from 'assert'
import fs from 'fs'
import path from 'path'
import ectScripts from '../src/ectScripts.mjs'
import { mkFixturePkg, cleanTmpRoot } from './tools/mkFixturePkg.mjs'


let fdTmp = path.resolve('./test/_tmp/ectScripts-ps')
let fdPkg = path.join(fdTmp, 'pkg')
let pdi = { name: 'sbx-ect-test', path: fdPkg }


//執行期間把 ectScripts 之即時輸出收起來, 不印到測試報告
let quiet = async (fn) => {
    let logOri = console.log
    console.log = () => {}
    try {
        return await fn()
    }
    finally {
        console.log = logOri
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

    it('node 列成功且 stderr 有警告 → 通過, 回傳之輸出含 stdout 與 stderr', async function() {
        let c = await quiet(() => ectScripts(pdi, 'node toolg/okStderr.mjs', { main: 'node' }))
        assert.ok(c.indexOf('built ok') >= 0)
        assert.ok(c.indexOf('Browserslist') >= 0)
    })

    it('node 列未捕捉例外 → node指令失敗(code[1])', async function() {
        await assert.rejects(quiet(() => ectScripts(pdi, 'node toolg/throwErr.mjs', { main: 'node' })), /^Error: \[sbx-ect-test\] node指令失敗\(code\[1\]\): node toolg\/throwErr\.mjs/)
    })

    it('node 列 process.exit(3) → node指令失敗(code[3])(原生離開碼原樣傳出)', async function() {
        await assert.rejects(quiet(() => ectScripts(pdi, 'node toolg/exit3.mjs', { main: 'node' })), /node指令失敗\(code\[3\]\)/)
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

    it('.bin 列 exit 5(無 main) → 不判定, 通過', async function() {
        let c = await quiet(() => ectScripts(pdi, './node_modules/.bin/fakebin 5'))
        assert.ok(c.indexOf('fakebin exit=5') >= 0)
    })

})
