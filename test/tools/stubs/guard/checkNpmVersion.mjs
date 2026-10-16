//帳本 R25 守衛測試之 spy: 只記錄被呼叫, 不連網
import record from '../record.mjs'


async function checkNpmVersion(name, version) {
    record(`checkNpmVersion|${name}@${version}`)
    return true
}


export default checkNpmVersion
