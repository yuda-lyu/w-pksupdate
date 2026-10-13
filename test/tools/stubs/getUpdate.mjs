//getUpdate 之樁: fixture 套件一律判為需更新
function getUpdate(ps, nameTar) {
    return {
        name: nameTar,
        path: process.env.FIXTURE_PKG,
        version: '0.0.1',
        update: true,
        dependencies: [],
        devDependencies: [{ name: 'w-x', verOld: '^1.0.0', verNew: '^1.0.1' }],
    }
}


export default getUpdate
