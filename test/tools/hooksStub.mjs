//模組解析掛鉤(以 node --import 載入, 只供整合測試之子程序): 不改動 src, 於子程序內把部分模組換成樁
//  STUB_MODE=runScript     : 只換 src/checkNpmVersion.mjs(沙箱套件不在 npm, 原樣會重試 2 小時)
//  STUB_MODE=publishPackage: 另換 getFolders、parseProject、getUpdate、updatePackage、ectScripts, 只記錄呼叫順序, 不碰套件區
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import path from 'node:path'


let fdStubs = path.resolve('./test/tools/stubs')
let mode = process.env.STUB_MODE || 'runScript'

let names = ['checkNpmVersion.mjs']
if (mode === 'publishPackage') {
    names = [...names, 'getFolders.mjs', 'parseProject.mjs', 'getUpdate.mjs', 'updatePackage.mjs', 'ectScripts.mjs']
}

registerHooks({
    resolve(specifier, context, nextResolve) {
        let r = nextResolve(specifier, context)
        for (let name of names) {
            if (r.url.endsWith('/src/' + name)) {
                return { ...r, url: pathToFileURL(path.join(fdStubs, name)).href, shortCircuit: true }
            }
        }
        return r
    },
})
