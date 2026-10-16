//帳本 R25 守衛測試之 spy: 只記錄被呼叫並回傳 fixture 套件
import record from '../record.mjs'


function parseProject() {
    record('parseProject')
    return [{ name: process.env.FIXTURE_NAME, path: process.env.FIXTURE_PKG, level: '3' }]
}


export default parseProject
