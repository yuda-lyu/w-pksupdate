//模組解析掛鉤(以 node --import 載入, 只供整合測試之子程序): 不改動 src, 於子程序內把部分模組換成樁
//  STUB_MODE=runScript     : 只換 src/checkNpmVersion.mjs(沙箱套件不在 npm, 原樣會重試 2 小時)
//  STUB_MODE=publishPackage: 另換 getFolders、parseProject、getUpdate、updatePackage、ectScripts, 只記錄呼叫順序, 不碰套件區
//  STUB_MODE=listUpdates   : 只換 getFolders、parseProject(樁在 stubs/listUpdates/, 由環境變數 FIXTURE_PKGS 給定套件清單), 其餘用真的(帳本 R23 測 g_listUpdates.mjs; R22 測 g_checkBuildScripts.mjs 進入點)
//  STUB_MODE=guard         : 帳本 R25 守衛測試(test/tools/guardCase.mjs)專用. 把被測站點「之下一層」換成只寫呼叫紀錄的 spy(樁在 stubs/guard/),
//                            換哪些由環境變數 GUARD_STUBS(src 內檔名, 逗號分隔)給定; GUARD_EXEC_SPY=1 另把 wsemi/src/execProcess.mjs 換成 spy(ectScripts 站點用).
//                            spy 不執行任何東西, 故即使被測站點之守衛被拿掉(變異驗證), 也不會有任何真實執行
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import path from 'node:path'


let fdStubs = path.resolve('./test/tools/stubs')
let mode = process.env.STUB_MODE || 'runScript'

//經本掛鉤啟動的子行程一律是測試行程(帳本 R25.1; 第 5 次外審 opus F01): 不依賴父測試檔是否碰巧載入過 testGuard——單檔執行、
//父檔未 import src 時, 子行程四個訊號原本皆無而守衛全關. guard 模式例外: 該模式的對照組(正式模式)由父行程決定旗標有無
if (mode !== 'guard') {
    process.env.W_PKSUPDATE_TEST = '1'
}

let names = ['checkNpmVersion.mjs']
let spyExecProcess = false
if (mode === 'publishPackage') {
    names = [...names, 'getFolders.mjs', 'parseProject.mjs', 'getUpdate.mjs', 'updatePackage.mjs', 'ectScripts.mjs']
}
if (mode === 'listUpdates') {
    fdStubs = path.join(fdStubs, 'listUpdates')
    names = ['getFolders.mjs', 'parseProject.mjs']
}
if (mode === 'guard') {
    fdStubs = path.join(fdStubs, 'guard')
    names = String(process.env.GUARD_STUBS || '').split(',').filter((s) => s !== '')
    spyExecProcess = process.env.GUARD_EXEC_SPY === '1'
}

registerHooks({
    resolve(specifier, context, nextResolve) {
        let r = nextResolve(specifier, context)
        for (let name of names) {
            if (r.url.endsWith('/src/' + name)) {
                return { ...r, url: pathToFileURL(path.join(fdStubs, name)).href, shortCircuit: true }
            }
        }
        if (spyExecProcess && r.url.endsWith('/wsemi/src/execProcess.mjs')) {
            return { ...r, url: pathToFileURL(path.join(fdStubs, 'execProcess.mjs')).href, shortCircuit: true }
        }
        return r
    },
})
