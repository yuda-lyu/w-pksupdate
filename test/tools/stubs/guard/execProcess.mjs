//帳本 R25 守衛測試之 spy(取代 wsemi/src/execProcess.mjs): 只記錄 prog 與參數, 不啟動任何行程; 回報 git version 使預檢型呼叫可通過
import record from '../record.mjs'


async function execProcess(prog, args, opt = {}) {
    record(`execProcess|${prog}|${(args || []).join(' ')}`)
    if (opt && typeof opt.cbStdout === 'function') {
        opt.cbStdout('git version spy\n')
    }
    return ''
}


export default execProcess
