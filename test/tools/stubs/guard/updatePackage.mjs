//帳本 R25 守衛測試之 spy: 只記錄被呼叫, 不改寫 package.json
import record from '../record.mjs'


function updatePackage() {
    record('updatePackage')
    return 'ok'
}


export default updatePackage
