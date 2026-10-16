//ectScripts 之樁: 不執行任何指令, 只記錄指令與 main
import record from './record.mjs'


async function ectScripts(pdi, scps, opt = {}) {
    let s = Array.isArray(scps) ? scps.join(' ; ') : scps
    record(`ectScripts|${s}|${(opt && opt.main) || ''}`)
    return ''
}

//runScript 另自 ectScripts.mjs 匯入 isTimeoutMessage(deploy 逾時不重試之判斷, R9); 樁不會產生任何失敗, 恆為否
function isTimeoutMessage() {
    return false
}


//runScript 另匯入 GIT_FATAL_EXIT_CODE(dist 閘門取 git status 自身 exit >= 128 時中止, 帳本 R10、R6), 樁須提供同名常數
const GIT_FATAL_EXIT_CODE = 128

//標記: 使用此樁之子程序(runCase.mjs 的 publishPackage 模式)以此確認 ectScripts 確為掛鉤換入之樁, 才注入為相依(帳本 R25)
const isStub = true

export { isStub, isTimeoutMessage, GIT_FATAL_EXIT_CODE }
export default ectScripts
