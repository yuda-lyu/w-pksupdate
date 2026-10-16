import _ from 'lodash-es'
import checkGit from './checkGit.mjs'
import publishPackage from './publishPackage.mjs'
import { requireInjected } from './testGuard.mjs'


/**
 * 連動發布入口(g_updateAndPublic.mjs 之唯一入口, 全庫連動與指定 names 之單套件發布皆經此)
 *
 * 進入迴圈前先預檢 git 一次(帳本 R24): git 不可用即 throw, 此時尚未對任何套件做任何事.
 *
 * @param {Array} names 輸入套件名稱陣列, 空陣列表全部套件
 * @param {Object} [opt={}] 輸入設定物件(供測試注入)
 * @param {Object} [opt.deps] 輸入相依函數覆寫物件, 可含 checkGit、publishPackage, 未給者用正式實作; 測試環境下兩者皆須給(帳本 R25)
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

    //測試環境下未注入 checkGit 與 publishPackage 即 throw, 不掃描套件區、不執行任何列(帳本 R25; 2026-10-17 事故: 測試誤走真實全庫連動)
    requireInjected('publishPackages', _.get(opt, 'deps'), ['checkGit', 'publishPackage'])

    let deps = {
        checkGit,
        publishPackage,
        ..._.get(opt, 'deps', {}),
    }

    //起跑預檢: 任何列執行前確認git可用(R24); 只做一次, 不在while迴圈內重複
    await deps.checkGit()

    let b = await deps.publishPackage(names)
    while (b) { //有更新就繼續, 直到無法更新為止
        b = await deps.publishPackage(names)
    }

}


export default publishPackages
