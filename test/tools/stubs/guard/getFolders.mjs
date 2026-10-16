//帳本 R25 守衛測試之 spy: 只記錄被呼叫並回傳 fixture 套件資料夾, 不掃描套件區
import record from '../record.mjs'


function getFolders() {
    record('getFolders')
    return [process.env.FIXTURE_PKG]
}


export default getFolders
