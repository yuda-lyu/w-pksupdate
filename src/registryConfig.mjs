import path from 'path'
import cp from 'child_process'
import { fileURLToPath } from 'url'
import _ from 'lodash-es'
import { assertRealExecAllowed } from './testGuard.mjs'


//倉庫設定解析(帳本 R27): 安裝依賴、確認新版已上架、發布(含同時發布之鏡像)所用之倉庫位址一律由本模組取得, 全套件不得再寫死任何倉庫位址(含 npmjs).
//主倉庫: 選項 registry > 環境變數 W_PKSUPDATE_REGISTRY > 本機 npm 設定(npm config get registry); 解析失敗明確報錯, 不退回 npmjs.
//鏡像倉庫(同時發布之對象): 選項 mirrors > 環境變數 W_PKSUPDATE_MIRRORS(逗號、分號或空白分隔); 預設無.

const ENV_REGISTRY = 'W_PKSUPDATE_REGISTRY'
const ENV_MIRRORS = 'W_PKSUPDATE_MIRRORS'

//npm config get registry 之時限(毫秒)
const NPM_CONFIG_TIMEOUT_MS = 30000

//專案根: 由本檔位置推得, 不取 process.cwd()(npm 設定含專案層 .npmrc, 須以固定位置解析)
const FD_PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

//倉庫位址正規化後僅容許之字元(整串): 位址會被組進交給 PowerShell 之指令列(npm i --registry=…、npm publish --registry=…),
//故不容許空白、引號、反引號、$、; | & < > ( ) { }、?、#、@(使用者資訊)、逗號(PowerShell 未加引號之逗號為陣列運算子,且與鏡像清單分隔符衝突)等; 不支援 IPv6 字面位址(含 [ ])
const RE_URL_SAFE = /^https?:\/\/[A-Za-z0-9._~:/%+-]+$/i


/**
 * 遮蔽位址內之使用者資訊並截短(純函式), 供錯誤訊息引述被拒絕之位址時不洩漏帳密
 *
 * @param {*} s 輸入任意值
 * @returns {String} 回傳遮蔽後之單行字串, 至多 80 字元
 */
function maskUrl(s) {
    //'//' 至其後第一個 '/' 之間若含 '@',該段整段視為使用者資訊(帳密中可能含空白或多個 '@'),一律遮蔽
    return String(s).replace(/\/\/[^/]*@/g, '//***@').replace(/\s+/g, ' ').trim().slice(0, 80)
}


/**
 * 正規化倉庫位址(純函式; 帳本 R27.2)
 *
 * 只收 http(s) 位址: 主機轉小寫、預設埠與多餘斜線依 URL 標準化、結尾補 '/'; 拒收非 http(s)、含使用者資訊(帳密)、含查詢字串或片段、含空白與 shell 特殊字元者.
 * 冪等: 已正規化者再次呼叫不變.
 *
 * @param {*} s 輸入倉庫位址字串
 * @returns {String} 回傳正規化後之位址字串(結尾必為 '/')
 */
function normalizeRegistryUrl(s) {
    if (typeof s !== 'string' || s.trim() === '') {
        throw new Error('[registry] 倉庫位址須為非空字串')
    }
    let t = s.trim()
    if (!/^https?:\/\//i.test(t)) {
        throw new Error(`[registry] 倉庫位址僅接受 http(s)://, 收到[${maskUrl(t)}]`)
    }
    let u = null
    try {
        u = new URL(t)
    }
    catch (err) {
        throw new Error(`[registry] 倉庫位址無法解析[${maskUrl(t)}]`)
    }
    if (u.username !== '' || u.password !== '') {
        throw new Error('[registry] 倉庫位址不得含使用者資訊(帳密請放 npm 設定檔, 不放位址)')
    }
    if (u.search !== '' || u.hash !== '') {
        throw new Error(`[registry] 倉庫位址不得含查詢字串或片段[${maskUrl(t)}]`)
    }
    //輸入原文與標準化後之位址都須只含容許字元: 只檢查標準化後者會讓 URL 解析器把空白、引號等悄悄改寫成 %20、%22 而放行, 使用者以為指定了 A 實際用了 B
    let h = u.href
    if (!h.endsWith('/')) {
        h += '/'
    }
    if (!RE_URL_SAFE.test(t) || !RE_URL_SAFE.test(h)) {
        throw new Error(`[registry] 倉庫位址含不容許之字元[${maskUrl(t)}](僅容許英數與 . _ ~ : / % + -)`)
    }
    return h
}


/**
 * 解析鏡像倉庫清單(純函式)
 *
 * @param {*} v 輸入字串(以逗號、分號或空白分隔)或字串陣列(每個元素視為一個完整位址,不再切分,含分隔符者留給正規化拒收); 其他型別視為無
 * @returns {Array} 回傳未正規化之位址字串陣列(已去空項)
 */
function parseMirrorList(v) {
    if (typeof v === 'string') {
        return _.filter(v.split(/[\s,;]+/), (x) => x !== '')
    }
    if (Array.isArray(v)) {
        return _.filter(_.map(_.filter(v, (x) => typeof x === 'string'), (x) => x.trim()), (x) => x !== '')
    }
    return []
}


/**
 * 取本機 npm 設定之 registry(以 npm config get registry; 帳本 R27.1)
 *
 * 真實預設實作: 啟動 npm 子行程, 測試環境下未注入即 throw(帳本 R25); 取輸出最後一個非空行.
 * 失敗(npm 不在 PATH、非 0 離開碼、逾時、無輸出)明確 throw, 不退回任何預設位址.
 *
 * @returns {String} 回傳 npm 設定之 registry 字串(未正規化)
 */
function getNpmConfigRegistry() {
    assertRealExecAllowed('registryConfig.npmConfig', '使用了真實預設實作 npm config get registry(子行程)')
    let out = ''
    try {
        out = cp.execSync('npm config get registry', {
            cwd: FD_PROJECT,
            encoding: 'utf8',
            windowsHide: true,
            timeout: NPM_CONFIG_TIMEOUT_MS,
            stdio: ['ignore', 'pipe', 'pipe'],
        })
    }
    catch (err) {
        let m = String(_.get(err, 'message', err)).replace(/\s+/g, ' ').trim().slice(0, 160)
        throw new Error(`[registry] 無法取得 npm 設定之 registry(npm config get registry 失敗: ${m}); 請改以環境變數 ${ENV_REGISTRY} 或 g_updateAndPublic.mjs 之 registry 選項指定主倉庫`)
    }
    let lines = _.filter(String(out).split(/\r?\n/), (s) => s.trim() !== '')
    let last = _.size(lines) > 0 ? lines[_.size(lines) - 1].trim() : ''
    if (last === '' || last === 'undefined') {
        throw new Error(`[registry] npm 設定無 registry(npm config get registry 輸出[${maskUrl(last)}]); 請改以環境變數 ${ENV_REGISTRY} 或 g_updateAndPublic.mjs 之 registry 選項指定主倉庫`)
    }
    return last
}


/**
 * 解析倉庫設定(帳本 R27.1): 主倉庫與鏡像倉庫
 *
 * 主倉庫優先序: opt.registry > 環境變數 W_PKSUPDATE_REGISTRY > getNpmRegistry()(預設為 npm config get registry); 皆無法得到有效位址則 throw, 不退回 npmjs.
 * 鏡像優先序: opt.mirrors(給了即採用, 空陣列表明確無鏡像) > 環境變數 W_PKSUPDATE_MIRRORS > 無; 去重, 與主倉庫相同者略過並記入 notes.
 *
 * @param {Object} [opt={}] 輸入設定物件
 * @param {String} [opt.registry] 輸入主倉庫位址(g_updateAndPublic.mjs 之選項)
 * @param {String|Array} [opt.mirrors] 輸入鏡像倉庫位址(字串或陣列)
 * @param {Object} [opt.env=process.env] 輸入環境變數物件(供測試注入)
 * @param {Function} [opt.getNpmRegistry=getNpmConfigRegistry] 輸入取得 npm 設定 registry 之函式(供測試注入); 測試環境下預設實作即 throw(帳本 R25)
 * @returns {Object} 回傳 { main, mirrors, source, notes }: main 為正規化主倉庫, mirrors 為正規化鏡像陣列, source 為主倉庫來源說明, notes 為提示字串陣列
 */
function resolveRegistryConfig(opt = {}) {
    let env = _.get(opt, 'env', process.env)
    let getNpm = _.isFunction(_.get(opt, 'getNpmRegistry')) ? opt.getNpmRegistry : getNpmConfigRegistry
    let notes = []

    //已提供但型別不對之選項明確報錯, 不當成未設定而悄悄落到下一順位(或悄悄關閉鏡像); 空字串視為未設定(契約)
    if (opt.registry !== undefined && opt.registry !== null && typeof opt.registry !== 'string') {
        throw new Error(`[registry] 選項 registry 須為字串, 收到型別[${typeof opt.registry}]`)
    }
    if (opt.mirrors !== undefined && opt.mirrors !== null && !(typeof opt.mirrors === 'string' || (Array.isArray(opt.mirrors) && _.every(opt.mirrors, (x) => typeof x === 'string')))) {
        throw new Error('[registry] 選項 mirrors 須為字串或字串陣列')
    }

    //主倉庫
    let rawMain = ''
    let source = ''
    if (typeof opt.registry === 'string' && opt.registry.trim() !== '') {
        rawMain = opt.registry
        source = '選項 registry'
    }
    else if (typeof _.get(env, ENV_REGISTRY) === 'string' && env[ENV_REGISTRY].trim() !== '') {
        rawMain = env[ENV_REGISTRY]
        source = `環境變數 ${ENV_REGISTRY}`
    }
    else {
        rawMain = getNpm()
        source = 'npm config get registry'
    }
    let main = ''
    try {
        main = normalizeRegistryUrl(rawMain)
    }
    catch (err) {
        throw new Error(`${err.message}(主倉庫來源: ${source})`)
    }

    //鏡像倉庫
    let rawMirrors = []
    let sourceMirrors = ''
    if (opt.mirrors !== undefined && opt.mirrors !== null) {
        rawMirrors = parseMirrorList(opt.mirrors)
        sourceMirrors = '選項 mirrors'
    }
    else if (typeof _.get(env, ENV_MIRRORS) === 'string') {
        rawMirrors = parseMirrorList(env[ENV_MIRRORS])
        sourceMirrors = `環境變數 ${ENV_MIRRORS}`
    }
    let mirrors = []
    for (let r of rawMirrors) {
        let m = ''
        try {
            m = normalizeRegistryUrl(r)
        }
        catch (err) {
            throw new Error(`${err.message}(鏡像來源: ${sourceMirrors})`)
        }
        if (m === main) {
            notes.push(`鏡像[${m}]與主倉庫相同, 已略過`)
            continue
        }
        if (!mirrors.includes(m)) {
            mirrors.push(m)
        }
    }

    return { main, mirrors, source, notes }
}


/**
 * 格式化倉庫設定為一行說明(純函式), 供起跑時印出
 *
 * @param {Object} cfg 輸入 resolveRegistryConfig 之回傳值
 * @returns {String} 回傳單行字串
 */
function formatRegistryConfig(cfg) {
    let ms = _.size(cfg.mirrors) > 0 ? _.join(cfg.mirrors, ', ') : '無'
    let s = `[registry] 主倉庫: ${cfg.main}(來源: ${cfg.source}); 同時發布之鏡像: ${ms}`
    if (_.size(cfg.notes) > 0) {
        s += `; 提示: ${_.join(cfg.notes, '; ')}`
    }
    return s
}


export { ENV_REGISTRY, ENV_MIRRORS, normalizeRegistryUrl, parseMirrorList, getNpmConfigRegistry, resolveRegistryConfig, formatRegistryConfig }
