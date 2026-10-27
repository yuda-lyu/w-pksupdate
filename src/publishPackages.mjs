import _ from 'lodash-es'
import checkGit from './checkGit.mjs'
import publishPackage from './publishPackage.mjs'
import { resolveRegistryConfig, formatRegistryConfig } from './registryConfig.mjs'
import { createMirrorLog } from './mirrorPublish.mjs'
import { requireInjected } from './testGuard.mjs'


/**
 * 連動發布入口(g_updateAndPublic.mjs 之唯一入口, 全庫連動與指定 names 之單套件發布皆經此)
 *
 * 進入迴圈前先解析倉庫設定一次(帳本 R27: 主倉庫與鏡像倉庫, 全套件之安裝、查版、發布皆用此份結果), 解析失敗即 throw, 此時尚未對任何套件做任何事;
 * 再預檢 git 一次(帳本 R24): git 不可用即 throw, 此時尚未對任何套件做任何事.
 * 啟用鏡像時於結束(含中止)印鏡像摘要: 哪些套件版本沒發到哪個鏡像、錯誤原文(截短), 供日後補發.
 *
 * @param {Array} names 輸入套件名稱陣列, 空陣列表全部套件
 * @param {Object} [opt={}] 輸入設定物件
 * @param {String} [opt.registry] 輸入主倉庫位址, 覆寫環境變數 W_PKSUPDATE_REGISTRY 與 npm 設定(見 resolveRegistryConfig)
 * @param {String|Array} [opt.mirrors] 輸入同時發布之鏡像倉庫位址(字串或陣列), 覆寫環境變數 W_PKSUPDATE_MIRRORS; 預設無
 * @param {Object} [opt.deps] 輸入相依函數覆寫物件(供測試注入), 可含 checkGit、publishPackage、resolveRegistryConfig, 未給者用正式實作; 測試環境下三者皆須給(帳本 R25)
 * @returns {Promise} 回傳 Promise
 */
async function publishPackages(names, opt = {}) {
    // names = [
    //   'w-converhp',
    //   'w-serv-broadcast',
    //   'w-serv-orm',
    //   'w-sync-webdata',
    //   'w-serv-webdata',
    //   'w-serv-hapi',
    // ]

    //測試環境下未注入 checkGit、publishPackage 與 resolveRegistryConfig 即 throw, 不掃描套件區、不執行任何列、不啟動 npm(帳本 R25; 2026-10-17 事故: 測試誤走真實全庫連動)
    requireInjected('publishPackages', _.get(opt, 'deps'), ['checkGit', 'publishPackage', 'resolveRegistryConfig'])

    let deps = {
        checkGit,
        publishPackage,
        resolveRegistryConfig,
        ..._.get(opt, 'deps', {}),
    }

    //倉庫設定: 只解析一次, 往下傳給每次 publishPackage(安裝依賴、發布、確認上架、鏡像皆用同一份); 起跑即印出, log 可查本輪用了哪個倉庫
    let registryConfig = deps.resolveRegistryConfig({ registry: _.get(opt, 'registry'), mirrors: _.get(opt, 'mirrors') })
    console.log(formatRegistryConfig(registryConfig))

    let mirrorLog = createMirrorLog()
    try {

        //起跑預檢: 任何列執行前確認git可用(R24); 只做一次, 不在while迴圈內重複
        await deps.checkGit()

        let optPkg = { registryConfig, onMirrorResult: mirrorLog.add }
        let b = await deps.publishPackage(names, optPkg)
        while (b) { //有更新就繼續, 直到無法更新為止
            b = await deps.publishPackage(names, optPkg)
        }

    }
    finally {
        //鏡像摘要: 正常結束與中止皆印(中止時已發到鏡像或未同步之紀錄仍須讓使用者看到); 摘要行已中和致命字樣, 不會被守望器誤判
        for (let s of mirrorLog.summarize(registryConfig.mirrors)) {
            console.log(s)
        }
    }

}


export default publishPackages
