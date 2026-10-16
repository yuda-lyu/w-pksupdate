//帳本 R25 守衛測試之 spy: 只記錄被呼叫, fixture 套件一律判為需更新
import record from '../record.mjs'


function getUpdate(ps, nameTar) {
    record('getUpdate')
    return {
        name: nameTar,
        path: process.env.FIXTURE_PKG,
        version: '0.0.1',
        update: true,
        dependencies: [],
        devDependencies: [],
    }
}


export default getUpdate
