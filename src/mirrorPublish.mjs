import { stripVTControlCharacters } from 'node:util'
import _ from 'lodash-es'
import { neutralizeFatal } from './fatalWords.mjs'
import { isTestGuardError } from './testGuard.mjs'


//同時發布(鏡像)之處理(帳本 R27.4): 主倉庫之 npm publish 成功後, 對每個鏡像倉庫再執行同一列加 --registry=<鏡像>.
//鏡像失敗不使該套件失敗、不中止連動: 記為警告並彙整於結束摘要, 供日後補發; 已存在同版本視為已同步.

//鏡像發布單列之逾時(毫秒): 10 分鐘. 鏡像不在等待條件內, 不應像主列(60 分鐘)那樣久等
const MIRROR_TIMEOUT_MS = 600000

//鏡像回報『該版本已存在』之特徵(僅限明確字樣): npmjs 於重複發布回 403 並附 'You cannot publish over the previously published versions: <版本>';
//Verdaccio 於重複發布回 409('this package is already present'). 單獨的 403(權限、停權)、'already exists'(可能是本機 EEXIST)不算已同步.
//注意 npm 另有訊息 'Cannot implicitly apply the "latest" tag because previously published version X is higher than the new version Y'(npm publish.js): 含 'previously published version' 但不表示本版已存在, 故不可只比對該片語
const RE_ALREADY_PUBLISHED = /cannot publish over (?:the )?previously published versions?\b|already present|\bE409\b|409 Conflict/i

//單筆錯誤摘要之長度上限
const MAX_ERROR_LENGTH = 300


/**
 * 組出鏡像發布列(純函式): 原發布列之後附 --registry=<鏡像>, 保留原列之其他參數(如 --tag next)
 *
 * 原列若含獨立的 '--'(其後記號 npm 視為位置參數而非旗標), 鏡像旗標插在 '--' 之前, 否則 '--registry=…' 會被當成套件目錄而不生效.
 *
 * @param {String} v 輸入主倉庫之發布列字串(如'npm publish')
 * @param {String} mirror 輸入已正規化之鏡像位址
 * @returns {String} 回傳鏡像發布列字串
 */
function buildMirrorRow(v, mirror) {
    let s = String(v).trim()
    let m = s.match(/\s--(?=\s|$)/)
    if (m) {
        return `${s.slice(0, m.index)} --registry=${mirror}${s.slice(m.index)}`
    }
    return `${s} --registry=${mirror}`
}


/**
 * 判斷鏡像發布失敗訊息是否表示該版本已存在(純函式)
 *
 * @param {*} msg 輸入錯誤訊息
 * @returns {Boolean} 回傳是否為已存在同版本
 */
function isAlreadyPublished(msg) {
    return RE_ALREADY_PUBLISHED.test(String(msg))
}


/**
 * 摘要錯誤訊息(純函式): 優先取 'npm error' 行, 無則取整段; 去控制碼、收成單行、中和致命字樣、截短
 *
 * 錯誤原文來自外部程式輸出與 ectScripts 之失敗訊息(含'npm指令失敗'等致命字樣), 中和後才可印出, 否則守望器會把可容忍之鏡像失敗誤當連動中止.
 * 取 npm error 行時, 失敗標頭中的離開狀態(code[N]、timeout[Nms]、spawn[…])仍冠於前, 逾時後仍未落定者另註明『狀態未知』(子程序樹可能仍在執行, 鏡像可能稍後才發布完成).
 *
 * @param {*} msg 輸入錯誤訊息
 * @returns {String} 回傳單行摘要, 至多 MAX_ERROR_LENGTH 字元
 */
function summarizeError(msg) {
    let s = stripVTControlCharacters(String(msg === null || msg === undefined ? '' : msg))
    let lines = _.filter(s.split(/\r?\n/), (x) => /npm error/i.test(x))
    let t = _.size(lines) > 0 ? _.join(_.map(lines, (x) => x.replace(/^\s*npm error\s*/i, '').trim()), ' | ') : s
    t = t.replace(/\s+/g, ' ').trim()
    let st = ''
    if (_.size(lines) > 0) {
        let m = s.split(/\r?\n/)[0].match(/\(([a-z]+\[[^\]]*\])/) //失敗標頭 '[套件] npm指令失敗(code[1]): 指令' 的括號內離開狀態, 如 code[1]、timeout[600000ms]、spawn 類啟動失敗
        st = m ? `${m[1]}: ` : ''
    }
    let unknown = s.indexOf('仍未落定') >= 0 ? '(狀態未知: 逾時後仍未落定, 子程序樹可能仍在執行, 鏡像可能稍後才發布完成) ' : ''
    return neutralizeFatal(`${st}${unknown}${t}`).slice(0, MAX_ERROR_LENGTH)
}


/**
 * 對每個鏡像倉庫執行發布(帳本 R27.4)
 *
 * 逐一以 gate()(對外列閘門: 版本與建置主檔)再檢查後才發布; gate 或發布失敗皆不 throw, 記為 failed 並印一行警告; 測試環境守衛錯誤(R25)原樣重拋.
 * 每個鏡像產生一筆結果 { name, version, mirror, status, error }: status 為 'ok'(發布成功)、'exists'(已存在同版本, 視為已同步)、'failed'(未同步, error 為摘要).
 *
 * @param {Object} p 輸入設定物件
 * @param {Object} p.pdi 輸入套件資訊物件, 須含 name 與 path
 * @param {String} p.version 輸入本次發布之版本字串
 * @param {String} p.v 輸入主倉庫之發布列字串
 * @param {Array} p.mirrors 輸入已正規化之鏡像位址陣列
 * @param {Function} p.exec 輸入執行函式(簽名同 ectScripts(pdi, 指令, opt))
 * @param {Function} [p.gate] 輸入閘門函式, 不通過時 throw; 預設無
 * @param {Function} [p.onResult] 輸入收集結果之回呼, 簽名 onResult(rec)
 * @param {Number} [p.timeoutMs=MIRROR_TIMEOUT_MS] 輸入單列逾時毫秒數
 * @returns {Promise} 回傳 Promise, resolve 結果陣列
 */
async function publishToMirrors(p) {
    let { pdi, version, v, mirrors, exec } = p
    let timeoutMs = _.isFinite(p.timeoutMs) ? p.timeoutMs : MIRROR_TIMEOUT_MS
    let out = []
    for (let mirror of mirrors) {
        let rec = { name: pdi.name, version, mirror, status: 'ok', error: '' }
        try {
            if (_.isFunction(p.gate)) {
                p.gate()
            }
            console.log(`${pdi.name} >>> 鏡像發布: ${mirror}`)
            await exec(pdi, buildMirrorRow(v, mirror), { main: 'npm', timeoutMs })
        }
        catch (err) {
            if (isTestGuardError(err)) {
                throw err //守衛錯誤不得被當成鏡像失敗吞掉(R25.2)
            }
            let msg = String(_.get(err, 'message', err))
            if (isAlreadyPublished(msg)) {
                rec.status = 'exists'
            }
            else {
                rec.status = 'failed'
                rec.error = summarizeError(msg)
            }
        }
        if (rec.status === 'ok') {
            console.log(`${pdi.name} >>> 鏡像發布完成: ${mirror}`)
        }
        else if (rec.status === 'exists') {
            console.log(`${pdi.name} >>> 鏡像已存在同版本[${version}], 視為已同步: ${mirror}`)
        }
        else {
            console.log(`[${pdi.name}] 警告: 鏡像未同步(不影響本次連動), ${pdi.name}@${version} → ${mirror}: ${rec.error}`)
        }
        out.push(rec)
        if (_.isFunction(p.onResult)) {
            p.onResult(rec)
        }
    }
    return out
}


/**
 * 建立鏡像結果收集器(連動全程共用, 結束時印摘要)
 *
 * @returns {Object} 回傳 { add(rec), list(), summarize(mirrors) }; summarize 回傳摘要行陣列, 未啟用鏡像且無結果時回傳 []
 */
function createMirrorLog() {
    let recs = []
    return {
        add: (rec) => {
            recs.push(rec)
        },
        list: () => _.slice(recs),
        summarize: (mirrors) => formatMirrorSummary(recs, mirrors),
    }
}


/**
 * 格式化鏡像結束摘要(純函式)
 *
 * 啟用鏡像時一律印摘要(含全部同步之情形), 讓使用者確認; 失敗者逐筆列出『套件@版本 → 鏡像: 錯誤原文(截短)』, 並附補發方式.
 *
 * @param {Array} recs 輸入結果陣列
 * @param {Array} mirrors 輸入啟用之鏡像位址陣列
 * @returns {Array} 回傳摘要行陣列; 未啟用鏡像且無結果時回傳 []
 */
function formatMirrorSummary(recs, mirrors) {
    if (_.size(mirrors) === 0 && _.size(recs) === 0) {
        return []
    }
    let nOk = _.size(_.filter(recs, (r) => r.status === 'ok'))
    let nExists = _.size(_.filter(recs, (r) => r.status === 'exists'))
    let fails = _.filter(recs, (r) => r.status === 'failed')
    let head = `[mirror] 摘要: 鏡像 ${_.join(mirrors, ', ')}; 發布成功 ${nOk} 筆、已存在視為已同步 ${nExists} 筆、未同步 ${_.size(fails)} 筆`
    let lines = [head]
    if (_.size(fails) > 0) {
        lines.push('[mirror] 未同步清單(補發: 於該套件目錄執行 npm publish --registry=<鏡像>):')
        for (let r of fails) {
            lines.push(`[mirror]   ${r.name}@${r.version} → ${r.mirror}: ${r.error}`)
        }
    }
    return lines
}


export { MIRROR_TIMEOUT_MS, buildMirrorRow, isAlreadyPublished, summarizeError, publishToMirrors, createMirrorLog, formatMirrorSummary }
