//全域測試環境(帳本 R25.6): 設測試旗標, 並從 PATH 移除含 powershell.exe 之目錄(預設任何測試都無法啟動 PowerShell, 啟動即 spawn ENOENT)
//由 test/unit-testGuard.test.mjs 以 root hook 呼叫(涵蓋同一次執行之所有測試檔); 需真 PowerShell 之測試檔明確以 getRealPath() 取得原 PATH(opt-in, 可 grep)
import fs from 'fs'
import path from 'path'


let pathReal = null //安裝前之 PATH; null 表尚未安裝

//視為 PowerShell 的執行檔名(本專案只起 powershell, pwsh 與 .com 一併防: libuv 會補 .com/.exe 解析; 外審 sol A09)
const PS_NAMES = ['powershell.exe', 'powershell.com', 'pwsh.exe', 'pwsh.com']

function hasPsIn(dir) {
    return PS_NAMES.some((n) => fs.existsSync(path.join(dir, n)))
}


/**
 * 移除含 powershell.exe 之目錄(純函式)
 *
 * @param {String} p 輸入 PATH 字串
 * @returns {String} 回傳移除後之 PATH 字串
 */
function stripPowerShell(p) {
    return String(p || '').split(path.delimiter).filter((s) => s && !hasPsIn(s)).join(path.delimiter)
}


/**
 * PATH 中是否仍有目錄含 powershell.exe
 *
 * @param {String} [p=process.env.PATH] 輸入 PATH 字串
 * @returns {Boolean} 回傳是否仍有
 */
function hasPowerShell(p = process.env.PATH) {
    return String(p || '').split(path.delimiter).some((s) => s && hasPsIn(s))
}


/**
 * 安裝全域測試環境: 設 W_PKSUPDATE_TEST=1, PATH 移除 PowerShell; 重複呼叫不重複安裝
 */
function installTestEnv() {
    if (pathReal !== null) {
        return
    }
    pathReal = process.env.PATH
    process.env.W_PKSUPDATE_TEST = '1'
    process.env.PATH = stripPowerShell(pathReal)
}


/**
 * 還原 PATH 為安裝前之值(旗標保留: 同一行程內之測試環境判別不應中途消失)
 */
function uninstallTestEnv() {
    if (pathReal === null) {
        return
    }
    process.env.PATH = pathReal
    pathReal = null
}


/**
 * 取得含 PowerShell 之原 PATH(明確 opt-in 真實 PowerShell 之測試檔使用); 未安裝全域環境(如單檔執行)時即目前之 process.env.PATH
 *
 * @returns {String} 回傳原 PATH 字串
 */
function getRealPath() {
    return pathReal !== null ? pathReal : process.env.PATH
}


export { stripPowerShell, hasPowerShell, installTestEnv, uninstallTestEnv, getRealPath }
