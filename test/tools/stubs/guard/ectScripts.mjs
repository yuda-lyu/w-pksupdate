//帳本 R25 守衛測試之 spy: 只記錄指令與 main, 不執行任何指令
import record from '../record.mjs'


async function ectScripts(pdi, scps, opt = {}) {
    let s = Array.isArray(scps) ? scps.join(' ; ') : scps
    record(`ectScripts|${s}|${(opt && opt.main) || ''}`)
    return ''
}

//runScript 另自 ectScripts.mjs 匯入下列名稱, spy 須提供同名匯出
function isTimeoutMessage() {
    return false
}
const GIT_FATAL_EXIT_CODE = 128


export { isTimeoutMessage, GIT_FATAL_EXIT_CODE }
export default ectScripts
