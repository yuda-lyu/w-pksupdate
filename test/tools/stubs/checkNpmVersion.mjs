//checkNpmVersion 之樁: 直接回 true 並記錄被呼叫(證明 runScript 走到最終閘門)
import record from './record.mjs'


async function checkNpmVersion(name, version) {
    record(`checkNpmVersion|${name}@${version}`)
    return true
}


export default checkNpmVersion
