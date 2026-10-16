import _ from 'lodash-es'
import w from 'wsemi'
import { neutralizeFatal } from './fatalWords.mjs'
import { requireInjected } from './testGuard.mjs'


//每次請求(含讀取 body)之預設時限(帳本 R19.6)與整個等待之牆鐘上限(R19.7)
const REQUEST_TIMEOUT_MS = 30000
const MAX_WAIT_MS = 10800000 //3小時


async function checkNpmVersionCore(name, version, requestTimeoutMs = REQUEST_TIMEOUT_MS, fx = globalThis.fetch) {

    //每個請求各自帶 AbortSignal.timeout: 涵蓋連線、等回應與讀取 body, 逾時即拋出例外, 由 checkNpmVersion 視為尚未就緒並重試(R19.6)
    let sig = () => AbortSignal.timeout(requestTimeoutMs)

    //查主清單內是否有指定name與version
    //url帶時變query繞過CDN快取(packument之Cache-Control為max-age=300, 重試打同一URL會一直命中舊快取; 帶不同query使CF-Cache-Status由HIT變MISS直達origin, 2026-07-27實測)
    console.log(`checking metadata...${name}@${version}`)
    let urlNV = `https://registry.npmjs.org/${encodeURIComponent(name)}/${version}?t=${Date.now()}`
    let resNV = await fx(urlNV, { signal: sig() })
    if (!resNV.ok) {
        console.log(`${name}@${version} metadata not found: ${resNV.status}`)
        return false
    }
    let body = await resNV.json() //於此即讀完, 不拖到其後的請求之後(其 signal 時限會先到)

    //查主清單內是否有包含version
    console.log(`checking versions list...${name}@${version}`)
    let urlList = `https://registry.npmjs.org/${encodeURIComponent(name)}?t=${Date.now()}`
    let resList = await fx(urlList, {
        headers: { 'accept': 'application/vnd.npm.install-v1+json' },
        signal: sig(),
    })
    if (!resList.ok) {
        console.log(`${name} versions list not ready: ${resList.status}`)
        return false
    }
    let listJson = await resList.json()
    if (!listJson?.versions?.[version]) {
        console.log(`${name}@${version} not in versions list`)
        return false
    }

    //查tarball
    console.log(`checking tarball...${name}@${version}`)
    let tarball = body.dist?.tarball
    if (!tarball) {
        console.log(`${name}@${version} tarball missing`)
        return false
    }

    //查tarball是否可抓
    console.log(`checking tarball head...${name}@${version}`)
    let headRes = await fx(tarball, { method: 'HEAD', signal: sig() })
    if (!headRes.ok) {
        console.log(`${name}@${version} tarball not ready yet: ${headRes.status}`)
        return false
    }

    return true
}

/**
 * 等待套件版本可由 npm 取得(metadata、versions list、tarball、tarball head 四項檢查全過才算)
 *
 * 單次檢測拋出例外(fetch failed 等網路暫時性錯誤、json 解析失敗、請求逾時等)視為本次尚未就緒, 印一行後計入重試, 不中止整個等待(帳本 R19.1);
 * 否則 2 小時之重試預算會被單次網路抖動繞過, 使整輪連動在已發布成功之套件上中止.
 * 每次請求帶時限(R19.6), 整個等待另有牆鐘上限(R19.7): 次數上限只計等待間隔, 不計每次檢測耗時, 慢速失敗時會無界放大.
 * 例外訊息為外來文字(如 HTTP 回應本文被 SyntaxError 引述), 截為單行至多 160 字元並中和致命字樣後才印出(R19.4).
 *
 * @param {String} name 輸入套件名稱字串
 * @param {String} version 輸入版本字串
 * @param {Object} [opt={}] 輸入設定物件(供測試注入)
 * @param {Number} [opt.maxTry=2400] 輸入最大重試次數(檢測次數為 maxTry + 1)
 * @param {Number} [opt.delayMs=3000] 輸入每次重試前等待毫秒數
 * @param {Number} [opt.requestTimeoutMs=30000] 輸入每次請求之時限毫秒數
 * @param {Number} [opt.maxMs=10800000] 輸入整個等待之牆鐘上限毫秒數, 已逾即停止重試
 * @param {Function} [opt.fetch=globalThis.fetch] 輸入 fetch 函式(簽名同 fetch(url, init)); 測試環境下必須給(帳本 R25.2), 未給即 throw、不連網
 * @returns {Promise} 回傳 Promise, resolve 回傳是否已可取得(預算耗盡仍未就緒為 false)
 */
async function checkNpmVersion(name, version, opt = {}) {

    //網路接縫(帳本 R25.2): 測試環境下須顯式注入 opt.fetch, 否則 throw, 不連網; 不以 globalThis.fetch 之身分推斷是否為樁(委派型包裝、載入順序、迴圈比測試活得久皆可使之失效, 第 5 次外審 opus F03)
    requireInjected('checkNpmVersion', opt, ['fetch'])
    let fx = _.isFunction(_.get(opt, 'fetch')) ? opt.fetch : globalThis.fetch //入口即固定, 迴圈內不再讀 globalThis.fetch

    let maxTry = _.isFinite(_.get(opt, 'maxTry')) ? opt.maxTry : 2400 //2400次×3s=2hr(業主2026-10-03調整; 沿革300次≈15分→1200次=1hr→2400次=2hr, 因2026-10-02實測單套件讀取副本延遲達50分鐘, 1hr餘裕不足)
    let delayMs = _.isFinite(_.get(opt, 'delayMs')) ? opt.delayMs : 3000
    let requestTimeoutMs = _.isFinite(_.get(opt, 'requestTimeoutMs')) ? opt.requestTimeoutMs : REQUEST_TIMEOUT_MS
    let maxMs = _.isFinite(_.get(opt, 'maxMs')) ? opt.maxMs : MAX_WAIT_MS

    let t0 = Date.now()
    let b = false
    for (let i = 0; i <= maxTry; i++) {
        if (i >= 1) {
            console.log(`重新檢測第 ${i} 次...`)
        }

        //checkNpmVersionCore, 例外視為尚未就緒(R19.1); 訊息為外來文字, 截短並中和致命字樣(R19.4)
        try {
            b = await checkNpmVersionCore(name, version, requestTimeoutMs, fx)
        }
        catch (err) {
            b = false
            let msg = String(_.get(err, 'message') || err).replace(/\s+/g, ' ').trim().slice(0, 160)
            console.log(`檢測例外(視為尚未就緒): ${neutralizeFatal(msg)}`)
        }

        //check
        if (b) {
            break
        }

        //牆鐘上限(R19.7)
        if (Date.now() - t0 > maxMs) {
            console.log(`等待已逾牆鐘上限(${maxMs}ms), 停止重試`)
            break
        }

        if (i < maxTry) {
            await w.delay(delayMs)
        }
    }

    return b
}


export { REQUEST_TIMEOUT_MS, MAX_WAIT_MS }
export default checkNpmVersion
