import fs from 'fs'
import path from 'path'
import _ from 'lodash-es'
import getFolders from './getFolders.mjs'
import parseProject from './parseProject.mjs'
import getUpdate from './getUpdate.mjs'
import updatePackage from './updatePackage.mjs'
import ectScripts from './ectScripts.mjs'
import runScript, { loadScript } from './runScript.mjs'
import { normalizeRegistryUrl } from './registryConfig.mjs'
import { requireInjected, assertConfinedToTestTmp, assertSingleLink } from './testGuard.mjs'


/**
 * 還原 package.json 與 package-lock.json 為備份之位元組並印訊息(帳本 R21.2、R21.5–R21.7); 還原失敗不遮蔽原錯誤, 只印警告
 *
 * @param {Object} pdi 輸入套件資訊物件, 須含 name
 * @param {String} stage 輸入中止階段, 'update package.json'、'npm i'或'script'(runScript 於第一個遠端列之前)
 * @param {*} err 輸入中止之原錯誤(訊息含『仍未落定』時另印殘留程序注意)
 * @param {Object} bak 輸入備份物件 { fpPj, fpLock, bakPj, bakLock }, bakLock 為 null 表原本不存在 lock
 */
function restoreFiles(pdi, stage, err, bak) {
    let { fpPj, fpLock, bakPj, bakLock } = bak
    try {
        fs.writeFileSync(fpPj, bakPj)
        if (bakLock !== null) {
            fs.writeFileSync(fpLock, bakLock)
        }
        else {
            fs.rmSync(fpLock, { force: true }) //原不存在, 失敗前可能已建立(npm i)
        }
        if (stage === 'script') {
            console.log(`[${pdi.name}] script 於首個遠端列(git push、deploy、publish)之前中止, 已還原 package.json(與 package-lock.json)為更新前內容(版本號隨之回退), 重跑將重新判定為落後; node_modules、dist、docs、本機 git 之 index 與 commit 不還原, 重跑時會重建`)
        }
        else {
            console.log(`[${pdi.name}] ${stage} 失敗, 已還原 package.json(與 package-lock.json)為更新前內容, 重跑將重新判定為落後`)
        }
        if (String(_.get(err, 'message', err)).indexOf('仍未落定') >= 0) {
            //R18.6寬限到期: 殺樹未確認, 子程序可能仍在執行, 還原之檔可能被再度覆寫(第二輪N2; 此行不含致命字樣)
            if (stage === 'npm i') {
                console.log(`[${pdi.name}] 注意: npm 逾時後仍未落定, npm 可能仍在執行, 已還原之 package-lock.json 可能被再度覆寫, 重跑前請先確認無殘留之 npm/node 程序`)
            }
            else {
                console.log(`[${pdi.name}] 注意: 逾時後仍未落定, 殘留之子程序可能仍在執行(建置腳本可能仍在寫 dist/docs 或改 package.json), 已還原之檔可能被再度覆寫, 重跑前請先確認無殘留之 npm/node 程序`)
            }
        }
    }
    catch (errRestore) {
        console.log(`[${pdi.name}] 還原失敗: ${_.get(errRestore, 'message') || String(errRestore)}`)
    }
}


/**
 * 找出第一個需更新之套件, 更新其 package.json、npm i、執行 script.txt, 發布後回傳 true(須跳出重算依賴資訊清單); 無需更新者回傳 false
 *
 * 第一個遠端列(git push、npm run deploy、npm publish 等; 本機 git add、git commit 不算)交給 exec 之前的任一中止(updatePackage、`npm i`、script 內遠端列之前的各列與閘門),
 * 把 package.json 與 package-lock.json 還原為 updatePackage 之前的位元組後再 throw 原錯誤(帳本 R21):
 * updatePackage 已把依賴寫成現行版、addVersion 已遞增版本, 不還原則重跑時 getUpdate 判為已對齊而略過該套件並跳號(CLAUDE.md §7.6; ETARGET 為最常見成因).
 * 第一個遠端列交出之後(含其自身失敗; runScript 以 opt.onRemote 通知)的失敗不還原, 遠端動作可能已發生, 仍依 §7.6 降版重觸發.
 * node_modules、dist、docs、本機 git 之 index 與 commit 不還原(重跑時重建).
 *
 * @param {Array} names 輸入套件名稱陣列, 空陣列表全部套件
 * @param {Object} opt 輸入設定物件
 * @param {Object} opt.registryConfig 輸入倉庫設定(必給, 由 resolveRegistryConfig 取得; 帳本 R27): { main, mirrors }, main 為主倉庫位址, mirrors 為同時發布之鏡像位址陣列; 缺 main 即 throw, 不退回任何預設倉庫
 * @param {Function} [opt.onMirrorResult] 輸入鏡像發布結果回呼(轉交 runScript), 供呼叫端彙整結束摘要
 * @param {Object} [opt.deps] 輸入相依函數覆寫物件(供測試注入), 可含 getFolders、parseProject、getUpdate、updatePackage、ectScripts、loadScript、runScript, 未給者用正式實作; 測試環境下除 loadScript 外皆須給(帳本 R25)
 * @param {Boolean} [opt.checkRelease=true] 輸入是否檢查必要列與版本遞增(帳本 R20), 轉交 loadScript 與 runScript, 僅供測試夾具關閉
 * @returns {Promise} 回傳 Promise, resolve 回傳是否有發布
 */
async function publishPackage(names, opt = {}) {
    // names = [
    //   'w-converhp',
    //   'w-serv-broadcast',
    //   'w-serv-orm',
    //   'w-sync-webdata',
    //   'w-serv-webdata',
    //   'w-serv-hapi',
    // ]

    //測試環境下未注入會掃描套件區、改寫 package.json、執行 npm i 與 script 之相依即 throw, 於任何副作用之前(帳本 R25)
    requireInjected('publishPackage', _.get(opt, 'deps'), ['getFolders', 'parseProject', 'getUpdate', 'updatePackage', 'ectScripts', 'runScript'])

    //倉庫設定(帳本 R27): 必須由呼叫端給定(publishPackages 解析一次後傳入), 缺主倉庫即於任何副作用之前 throw, 不退回預設倉庫; 位址入口即正規化與驗證(之後組進指令列)
    if (!_.get(opt, 'registryConfig.main')) {
        throw new Error('[registry] publishPackage 需 opt.registryConfig(由 resolveRegistryConfig 取得之 { main, mirrors }), 不退回預設倉庫')
    }
    let regMain = normalizeRegistryUrl(opt.registryConfig.main)
    let regMirrors = _.map(_.get(opt, 'registryConfig.mirrors', []), (x) => normalizeRegistryUrl(x))

    let deps = {
        getFolders,
        parseProject,
        getUpdate,
        updatePackage,
        ectScripts,
        loadScript,
        runScript,
        ..._.get(opt, 'deps', {}),
    }
    let checkRelease = _.get(opt, 'checkRelease', true) !== false

    let fds = deps.getFolders()
    // console.log('fds', fds)

    let ps = deps.parseProject(fds)
    // console.log('ps', ps)

    if (_.size(names) === 0) {
        names = _.map(ps, 'name')
    }
    // console.log('names', names)

    let publish = false
    for (let k = 0; k < _.size(names); k++) {

        let name = names[k]

        let pdi = deps.getUpdate(ps, name)

        if (pdi.update) {
            assertConfinedToTestTmp('publishPackage', pdi.path) //測試環境下套件路徑須在 test/_tmp 內, 改寫/還原 package.json 只作用於測試 fixture(帳本 R25.2)
            console.log('pdi', pdi)

            //執行前檢查script.txt: 有非預期指令或缺必要列(版本遞增列、發布列)即於任何副作用(update package.json、npm i、addVersion等)之前中止, 否則package.json已被改寫, 重跑時會被getUpdate判為已對齊而略過
            deps.loadScript(pdi, 'update pks', { checkRelease })

            //備份package.json與package-lock.json(位元組原樣), 第一個遠端列交出之前中止時還原(R21)
            let fpPj = path.resolve(pdi.path, 'package.json')
            let fpLock = path.resolve(pdi.path, 'package-lock.json')
            assertSingleLink('publishPackage', fpPj) //測試環境下被改寫/還原的檔案不得是硬連結(R25.2; 第 5 次外審 sol F02)
            assertSingleLink('publishPackage', fpLock)
            let bakPj = fs.readFileSync(fpPj)
            let bakLock = fs.existsSync(fpLock) ? fs.readFileSync(fpLock) : null

            //目前階段與遠端旗標: runScript於第一個遠端列(git push、deploy、publish; git add/commit不算)通過全部閘門、交給exec之前呼叫onRemote(R21.3); 此後之失敗不還原(遠端動作可能已發生, 維持CLAUDE.md §7.6)
            let stage = 'update package.json'
            let remote = false

            try {

                //執行[update package.json]
                console.log(`${pdi.name} >>> update package.json...`)
                deps.updatePackage(pdi)

                //執行[npm i]
                stage = 'npm i'
                console.log(`${pdi.name} >>> npm i...`)
                // await ectScripts(pdi, `npm i`)
                await deps.ectScripts(pdi, `npm i --registry=${regMain}`, { main: 'npm', registry: regMain }) //安裝依賴時請求可能會使用 registry / mirror / CDN, 故有可能會出現發布完卻無法安裝問題, 故固定指定主倉庫(發布與確認上架所用之同一倉庫, 帳本R27; 原寫死 npmjs, 改走私有倉庫後剛發布之新版從 npmjs 裝不到而 ETARGET), 不走執行機設定之其他倉庫或鏡像; main='npm'使安裝失敗(如gyp原生編譯錯誤)立即中止, 不帶病走到git push
                console.log('')

                //執行[script]
                stage = 'script'
                console.log(`${pdi.name} >>> update pks...`)
                await deps.runScript(pdi, `update pks`, {
                    checkRelease,
                    registryConfig: { main: regMain, mirrors: regMirrors },
                    onMirrorResult: _.get(opt, 'onMirrorResult'),
                    onRemote: () => {
                        remote = true
                    },
                    onRemoteRevoke: () => {
                        remote = false //第一個遠端列(git push)於第一次嘗試即spawn失敗: git根本沒執行, 遠端確定未動, 視同未交出而照常還原(帳本R26.2)
                    },
                })
                console.log('')

            }
            catch (err) {
                if (!remote) {
                    //第一個遠端列之前之中止: 還原package.json與package-lock.json, 重跑將重新判定為落後; 還原失敗不遮蔽原錯誤(R21.6)
                    restoreFiles(pdi, stage, err, { fpPj, fpLock, bakPj, bakLock })
                }
                throw err
            }

            publish = true
            console.log(`${pdi.name} >>> finish`)
            console.log('')

            break //更新套件須跳出, 因為更新依賴資訊清單須重算
        }
    }

    return publish
}


export default publishPackage
