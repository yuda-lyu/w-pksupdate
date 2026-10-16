//帳本 R25 守衛測試之 spy: 只記錄被呼叫, 不執行任何東西
import record from '../record.mjs'


async function publishPackage() {
    record('publishPackage')
    return false
}


export default publishPackage
