//ectScripts 之樁: 不執行任何指令, 只記錄指令與 main
import record from './record.mjs'


async function ectScripts(pdi, scps, opt = {}) {
    let s = Array.isArray(scps) ? scps.join(' ; ') : scps
    record(`ectScripts|${s}|${(opt && opt.main) || ''}`)
    return ''
}


export default ectScripts
