import path from 'path'
import { fileURLToPath } from 'url'
import _ from 'lodash-es'
import ectScripts from './ectScripts.mjs'
import { requireInjected } from './testGuard.mjs'


//預檢之 Set-Location 目標預設為本檔所在之 src 資料夾(必存在): 不用 process.cwd(), 以免 cwd 失效時把 Set-Location 失敗誤報成「git 不可用」(帳本 R24.4)
const DEFAULT_PATH = path.dirname(fileURLToPath(import.meta.url))


/**
 * 起跑預檢 git(帳本 R24): 於任何套件之任何列執行前, 確認 git 可用
 *
 * 經 ectScripts(與正式列相同之 PowerShell 組法與 PATH 解析)以 main='git' 執行 `git --version`: 子命令無法辨識(unknown), 故任何非 0 離開碼與 spawn 失敗皆判失敗
 * (git 不在 PATH、profile 以函式遮蔽而失敗、PowerShell 無法啟動等), 失敗訊息為`[preflight] git指令失敗(<摘要>): git --version`, 含既有守望字樣.
 * 離開碼 0 但輸出不含'git version'(函式遮蔽、空輸出)亦判失敗.
 *
 * @param {Object} [opt={}] 輸入設定物件(供測試注入)
 * @param {Function} [opt.exec] 輸入取代 ectScripts 之函式, 簽名同 ectScripts(pdi, scps, opt); 測試環境下必須給(帳本 R25)
 * @param {String} [opt.path] 輸入執行目錄(Set-Location 目標), 預設為 src 資料夾(必存在)
 * @param {Number} [opt.timeoutMs=120000] 輸入逾時毫秒數
 * @returns {Promise} 回傳 Promise, resolve 回傳 ectScripts 之輸出文字; git 不可用時 reject
 */
async function checkGit(opt = {}) {
    requireInjected('checkGit', opt, ['exec']) //測試環境下未注入 exec 即 throw, 不啟動 PowerShell(帳本 R25)
    let exec = _.isFunction(_.get(opt, 'exec')) ? opt.exec : ectScripts
    let pdi = { name: 'preflight', path: _.get(opt, 'path', DEFAULT_PATH) }
    let timeoutMs = _.isFinite(_.get(opt, 'timeoutMs')) ? opt.timeoutMs : 120000

    let c = await exec(pdi, 'git --version', { main: 'git', timeoutMs })

    if (String(c).indexOf('git version') < 0) {
        throw new Error(`[preflight] git指令失敗(輸出不含[git version]): git --version\n${c === null || c === undefined ? '' : String(c)}`)
    }

    return c
}


export default checkGit
