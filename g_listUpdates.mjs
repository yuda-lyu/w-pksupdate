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
let wave1 = []
_.each(names, (name) => {
    let pdi
    try {
        pdi = getUpdate(ps, name)
    } catch (e) {
        console.log(`!! getUpdate(${name}) throw: ${e.message}`)
        return
    }
    if (pdi.update) {
        let ds = [...pdi.dependencies, ...pdi.devDependencies].map((d) => `${d.name} ${d.verOld}→${d.verNew}`)
        wave1.push({ name, ds })
    }
})
let wave1Names = new Set(_.map(wave1, 'name'))

//連鎖閉包: 第一波發布後會 bump 版本, 依賴它們的套件跟著過期 → 逐層加入直到收斂
let willPublish = new Set(wave1Names)
let grow = true
while (grow) {
    grow = false
    _.each(names, (name) => {
        if (willPublish.has(name)) {
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
let stable = names.filter((n) => !willPublish.has(n))

//輸出
let pct = (willPublish.size / names.length * 100).toFixed(1)
console.log(`\n===== 依賴連動發布預覽 =====`)
console.log(`全部套件            : ${names.length}`)
console.log(`第一波(現已過期)  : ${wave1.length}`)
console.log(`連鎖後最終發布集合  : ${willPublish.size}  (${pct}%)`)
console.log(`不受影響(穩定)    : ${stable.length}`)

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


//node g_listUpdates.mjs
