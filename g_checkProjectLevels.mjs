import path from 'path'
import fs from 'fs'
import _ from 'lodash-es'
import w from 'wsemi'
import getFolders from './src/getFolders.mjs'
import parseProject from './src/parseProject.mjs'
import checkProjectLevels from './src/checkProjectLevels.mjs'
import getLevelWant from './src/getLevelWant.mjs'


//唯讀檢查: 驗證資料夾名之Level標記是否正確, 不做任何 update / publish
//用於 g_updateAndPublic.mjs 開跑前之預檢, 提前確認第一道閘門會不會擋住


//一、跑主程序閘門(與 g_updateAndPublic.mjs 第一行完全相同), 確認會不會被擋
console.log('===== checkProjectLevels(主程序閘門) =====')
let bGate = true
try {
    let ps = checkProjectLevels()
    console.log(`PASS: 共 ${_.size(ps)} 個套件, 無 Level 錯誤`)
}
catch (err) {
    bGate = false
    console.log(`FAIL: ${err.message}`)
    console.log('(閘門遇錯即throw, 僅報第一個; 完整清單見下方依賴圖重算)')
}


//二、用依賴圖重算「應有Level」, 找出全部標錯
//閘門只報第一個, 但Level標錯常是連鎖的(源頭錯→其下游全錯), 逐個修要修很多輪才收斂
//殷鑑: w-data-scheduler由L5降L4後, 閘門只報w-dwdata-builder, 實際整條dwdata鏈共5個要改
console.log('')
console.log('===== 依賴圖重算應有 Level =====')

let ps = parseProject(getFolders())

let ls = []
let kpLevel = {}
_.each(ps, (v) => {
    let o = w.j2o(fs.readFileSync(path.resolve(v.path, 'package.json'), 'utf8'))
    let deps = {
        ...o.dependencies,
        ...o.devDependencies,
    }
    ls.push({ ...v, deps })
    kpLevel[v.name] = w.cint(v.level)
})

//kpInner: 只保留「套件區內」的依賴(external套件不參與Level計算)
let names = new Set(_.map(ls, 'name'))
let kpInner = {}
_.each(ls, (v) => {
    kpInner[v.name] = _.filter(_.keys(v.deps), (d) => names.has(d))
})

//want: 迭代求解應有Level
let want = {}
_.each(ls, (v) => {
    want[v.name] = null
})

//基準: 無區內依賴者為根(如w-package-tools=1), 其Level由使用者定義, 重算時沿用現有標籤
_.each(ls, (v) => {
    if (_.size(kpInner[v.name]) === 0) {
        want[v.name] = kpLevel[v.name]
    }
})

//其餘: 待其全部依賴皆已求出, 取 max(依賴Level)+1
let guard = 0
while (_.some(want, (v) => v === null)) {
    guard++
    if (guard > 100) {
        console.log('!! 迭代未收斂(可能有循環依賴), 中止重算')
        break
    }
    _.each(ls, (v) => {
        if (want[v.name] !== null) {
            return
        }
        let ds = kpInner[v.name]
        if (_.every(ds, (d) => want[d] !== null)) {
            let mx = _.max(_.map(ds, (d) => want[d]))

            //與checkProjectLevels共用同一判準, 不可各自手寫(見CLAUDE.md §4)
            want[v.name] = getLevelWant(v.name, mx)
        }
    })
}

//bad: 現有標籤與重算結果不符者
let bad = []
_.each(ls, (v) => {
    if (want[v.name] === null) {
        return
    }
    if (kpLevel[v.name] === want[v.name]) {
        return
    }
    let mxName = ''
    let mx = -1
    _.each(kpInner[v.name], (d) => {
        if (want[d] > mx) {
            mx = want[d]
            mxName = d
        }
    })
    bad.push({
        name: v.name,
        fd: path.basename(path.dirname(v.path)),
        now: kpLevel[v.name],
        want: want[v.name],
        by: mxName,
        byLevel: mx,
    })
})

if (_.size(bad) === 0) {
    console.log(`PASS: 共 ${_.size(ls)} 個套件, 標籤 Level 與依賴圖重算結果完全一致`)
}
else {
    console.log(`發現 ${_.size(bad)} 個 Level 標錯:`)
    console.log('')
    console.log('套件名'.padEnd(24), '現有'.padEnd(6), '應為'.padEnd(6), '最高依賴(其Level)')
    console.log('-'.repeat(80))
    _.each(_.sortBy(bad, ['want', 'name']), (b) => {
        console.log(String(b.name).padEnd(24), String(b.now).padEnd(6), String(b.want).padEnd(6), `${b.by}(${b.byLevel})`)
        console.log(`    改前: ${b.fd}`)
        let ssFd = _.split(b.fd, '-') //開源-JS-<號段>-<Level>-<套件名>, 套件名本身含'-'故只改index3
        ssFd[3] = String(b.want)
        console.log(`    改後: ${_.join(ssFd, '-')}`)
    })
    console.log('')
    console.log('※ Level為資料夾名之第2個數字, 由使用者手動改名修正(僅動Level段, 號段與套件名不動)')
}


//三、根套件(其Level為使用者定義之基準, 非由依賴推導)
console.log('')
console.log('===== 根套件(無套件區內依賴, Level 沿用現有標籤) =====')
_.each(ls, (v) => {
    if (_.size(kpInner[v.name]) === 0) {
        console.log(`  ${v.name}  Level=${kpLevel[v.name]}`)
    }
})


//exit code: 任一檢查未過即回傳1, 方便自動化與shell判斷
if (!bGate || _.size(bad) > 0) {
    process.exit(1)
}
