//updatePackage 之樁: 不改寫 package.json, 只記錄被呼叫
import record from './record.mjs'


function updatePackage(pdi) {
    record('updatePackage')
    return 'ok'
}


export default updatePackage
