import fs from 'fs'
import _ from 'lodash-es'
import w from 'wsemi'
import JSON5 from 'json5'
import getFolders from './src/getFolders.mjs'
import parseProject from './src/parseProject.mjs'
import getUpdate from './src/getUpdate.mjs'


//唯讀預覽: 列出「依賴連動」下應被更新發布的套件, 不做任何 update / publish

let ps = parseProject(getFolders())
let names = _.map(ps, 'name') //等同 g_updateAndPublic.mjs 內 names=[] 展開後的全部套件
let known = new Set(names)

//kpDep: 每個套件對「同層套件」的相依(dependencies + devDependencies), 用於連鎖閉包
let kpDep = {}
_.each(ps, (p) => {
    let o = JSON5.parse(fs.readFileSync(`${p.path}/package.json`, 'utf8'))
    let deps = { ...o.dependencies, ...o.devDependencies }
    kpDep[p.name] = _.keys(deps).filter((d) => known.has(d))
})

//第一波: 現在依賴版本就對不上的套件(publishPackage 的偵測邏輯)
//getUpdate 拋錯者(如依賴層級順序違規、無法取得 version)為「未能判定」(帳本 R23): 不計入第一波、連鎖與穩定, 另列一節, 離開碼為 1
let wave1 = []
let failed = []
_.each(names, (name) => {
    let pdi
    try {
        pdi = getUpdate(ps, name)
    } catch (e) {
        console.log(`!! getUpdate(${name}) throw: ${e.message}`)
        failed.push({ name, message: e.message })
        return
    }
    if (pdi.update) {
        let ds = [...pdi.dependencies, ...pdi.devDependencies].map((d) => `${d.name} ${d.verOld}→${d.verNew}`)
        wave1.push({ name, ds })
    }
})
let wave1Names = new Set(_.map(wave1, 'name'))
let failedNames = new Set(_.map(failed, 'name'))

//連鎖閉包: 第一波發布後會 bump 版本, 依賴它們的套件跟著過期 → 逐層加入直到收斂
let willPublish = new Set(wave1Names)
let grow = true
while (grow) {
    grow = false
    _.each(names, (name) => {
        if (willPublish.has(name) || failedNames.has(name)) {
            return
        }
        //只要有任一同層相依已在發布集合內, 此套件之後也會過期
        if (kpDep[name].some((d) => willPublish.has(d))) {
            willPublish.add(name)
            grow = true
        }
    })
}

//不會被連動的套件(穩定套件)
//受未能判定者影響(帳本 R23.1, 第二輪 N6): 不在發布集合、也非未能判定, 但直接或間接相依於未能判定者 → 狀態無法確定, 不算穩定(未能判定者修好後可能落後而連鎖)
let uncertain = new Set()
grow = true
while (grow) {
    grow = false
    _.each(names, (name) => {
        if (willPublish.has(name) || failedNames.has(name) || uncertain.has(name)) {
            return
        }
        if (kpDep[name].some((d) => failedNames.has(d) || uncertain.has(d))) {
            uncertain.add(name)
            grow = true
        }
    })
}
let stable = names.filter((n) => !willPublish.has(n) && !failedNames.has(n) && !uncertain.has(n))

//輸出
let pct = (willPublish.size / names.length * 100).toFixed(1)
console.log(`\n===== 依賴連動發布預覽 =====`)
console.log(`全部套件            : ${names.length}`)
console.log(`第一波(現已過期)  : ${wave1.length}`)
console.log(`連鎖後最終發布集合  : ${willPublish.size}  (${pct}%)`)
console.log(`不受影響(穩定)    : ${stable.length}`)
if (failed.length > 0) {
    console.log(`未能判定(getUpdate 拋錯): ${failed.length}`)
}

console.log(`\n----- 第一波(現在就需更新, 附依賴版本差異) -----`)
wave1.forEach((h) => {
    console.log(`● ${h.name}`)
    h.ds.forEach((d) => console.log(`    ${d}`))
})

let onlyCascade = [...willPublish].filter((n) => !wave1Names.has(n))
console.log(`\n----- 僅因連鎖才需發布(第一波下游, 共 ${onlyCascade.length} 個) -----`)
console.log(onlyCascade.length ? onlyCascade.join(', ') : '(無)')

console.log(`\n----- 完全不受影響的穩定套件(共 ${stable.length} 個) -----`)
console.log(stable.length ? stable.join(', ') : '(無)')

//未能判定者獨立一節列出(不在上列任何清單內), 並以離開碼 1 告知(帳本 R23); 全部可判定時不輸出此節、離開碼 0
if (failed.length > 0) {
    console.log(`\n----- 未能判定(getUpdate 拋錯, 共 ${failed.length} 個; 不計入第一波、連鎖與穩定) -----`)
    failed.forEach((f) => {
        console.log(`● ${f.name}: ${f.message}`)
    })
}
if (uncertain.size > 0) {
    console.log(`\n----- 受未能判定者影響(下游, 共 ${uncertain.size} 個; 狀態無法確定, 不算穩定) -----`)
    console.log([...uncertain].join(', '))
}
process.exitCode = failed.length > 0 ? 1 : 0


//node g_listUpdates.mjs
