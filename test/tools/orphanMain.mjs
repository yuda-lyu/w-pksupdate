//子程序入口(由 test/unit-ectScripts-ps.test.mjs 以 spawnSync 呼叫): 以與 g_updateAndPublic.mjs 相同的收尾(runMain + exitAfterFlush)執行一個「留下孤兒孫程序」的 node 列
//環境變數: FIXTURE_PKG(含 toolg/orphan.mjs 之 fixture 套件絕對路徑)、HANG_ID(孤兒的唯一標記)、SKIP_EXIT=1 時不呼叫 exitAfterFlush(僅供手動對照: 行程會被孤兒拖住)
//刻意走真實 PowerShell(帳本 R25.5): 經 realExec 之 ectReal, 限 test/_tmp 內 fixture
import { ectReal as ectScripts } from './realExec.mjs'
import runMain, { exitAfterFlush } from '../../src/runMain.mjs'

let pdi = { name: 'sbx-orphan-main', path: process.env.FIXTURE_PKG }
process.exitCode = await runMain(async () => {
    await ectScripts(pdi, `node toolg/orphan.mjs ${process.env.HANG_ID}`, { main: 'node', timeoutMs: 1500, timeoutGraceMs: 1500 })
})
if (process.env.SKIP_EXIT !== '1') {
    await exitAfterFlush(process.exitCode, process.exit) //顯式傳 process.exit: 此子行程刻意驗證真實結束行為(帳本 R25: 測試環境下 exitAfterFlush 不給 exitFn 會 throw)
}
