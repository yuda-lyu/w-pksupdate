import _ from 'lodash-es'
import w from 'wsemi'
import { neutralizeFatal } from './fatalWords.mjs'
import { requireInjected } from './testGuard.mjs'
import { normalizeRegistryUrl } from './registryConfig.mjs'


//每次請求(含讀取 body)之預設時限(帳本 R19.6)與整個等待之牆鐘上限(R19.7)
const REQUEST_TIMEOUT_MS = 30000
const MAX_WAIT_MS = 10800000 //3小時

//主倉庫連續回 401/403 之停止門檻(帳本 R27.3): 本函式的請求不帶 npm 認證(只適用允許匿名讀取之倉庫); 認證類錯誤不是傳播延遲, 繼續等 2~3 小時毫無意義, 連續達此次數即停止等待(≈1 分鐘)
const AUTH_FAIL_MAX = 20


async function checkNpmVersionCore(registry, name, version, requestTimeoutMs = REQUEST_TIMEOUT_MS, fx = globalThis.fetch, st = {}) {

    //每個請求各自帶 AbortSignal.timeout: 涵蓋連線、等回應與讀取 body, 逾時即拋出例外, 由 checkNpmVersion 視為尚未就緒並重試(R19.6)
    let sig = () => AbortSignal.timeout(requestTimeoutMs)

    //記錄認證類狀態碼(401/403)供 checkNpmVersion 判斷是否連續認證失敗
    let noteAuth = (status) => {
        if (status === 401 || status === 403) {
            st.auth = status
        }
    }

    //查主清單內是否有指定name與version(registry 為已正規化之主倉庫位址, 結尾有'/', 帳本 R27)
    //url帶時變query繞過CDN快取(packument之Cache-Control為max-age=300, 重試打同一URL會一直命中舊快取; 帶不同query使CF-Cache-Status由HIT變MISS直達origin, 2026-07-27實測)
    console.log(`checking metadata...${name}@${version}`)
    let urlNV = `${registry}${encodeURIComponent(name)}/${version}?t=${Date.now()}`
    let resNV = await fx(urlNV, { signal: sig() })
    if (!resNV.ok) {
        console.log(`${name}@${version} metadata not found: ${resNV.status}`)
        noteAuth(resNV.status)
        return false
    }
    let body = await resNV.json() //於此即讀完, 不拖到其後的請求之後(其 signal 時限會先到)

    //查主清單內是否有包含version
    console.log(`checking versions list...${name}@${version}`)
    let urlList = `${registry}${encodeURIComponent(name)}?t=${Date.now()}`
    let resList = await fx(urlList, {
        headers: { 'accept': 'application/vnd.npm.install-v1+json' },
        signal: sig(),
    })
    if (!resList.ok) {
        console.log(`${name} versions list not ready: ${resList.status}`)
        noteAuth(resList.status)
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
        noteAuth(headRes.status)
        return false
    }

    return true
}

/**
 * 等待套件版本可由指定倉庫取得(metadata、versions list、tarball、tarball head 四項檢查全過才算)
 *
 * 倉庫由 opt.registry 指定(主倉庫, 由 resolveRegistryConfig 取得; 帳本 R27.3): 查 <倉庫><name>/<version> 與 <倉庫><name> 兩個端點(npmjs 與 Verdaccio 皆支援),
 * 未給即 throw, 不退回任何預設倉庫. 鏡像倉庫不列入等待條件.
 *
 * 單次檢測拋出例外(fetch failed 等網路暫時性錯誤、json 解析失敗、請求逾時等)視為本次尚未就緒, 印一行後計入重試, 不中止整個等待(帳本 R19.1);
 * 否則 2 小時之重試預算會被單次網路抖動繞過, 使整輪連動在已發布成功之套件上中止.
 * 每次請求帶時限(R19.6), 整個等待另有牆鐘上限(R19.7): 次數上限只計等待間隔, 不計每次檢測耗時, 慢速失敗時會無界放大.
 * 例外訊息為外來文字(如 HTTP 回應本文被 SyntaxError 引述), 截為單行至多 160 字元並中和致命字樣後才印出(R19.4).
 *
 * @param {String} name 輸入套件名稱字串
 * @param {String} version 輸入版本字串
 * @param {Object} opt 輸入設定物件
 * @param {String} opt.registry 輸入主倉庫位址(必給; 會經 normalizeRegistryUrl 正規化, 非 http(s) 位址 throw)
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

    //倉庫位址(帳本 R27.3): 必須由呼叫端給定, 不寫死、不退回預設倉庫; 入口即正規化並固定
    if (!_.isString(_.get(opt, 'registry')) || opt.registry.trim() === '') {
        throw new Error('[registry] checkNpmVersion 需 opt.registry(主倉庫位址, 由 resolveRegistryConfig 取得), 不退回預設倉庫')
    }
    let registry = normalizeRegistryUrl(opt.registry)

    let maxTry = _.isFinite(_.get(opt, 'maxTry')) ? opt.maxTry : 2400 //2400次×3s=2hr(業主2026-10-03調整; 沿革300次≈15分→1200次=1hr→2400次=2hr, 因2026-10-02實測單套件讀取副本延遲達50分鐘, 1hr餘裕不足)
    let delayMs = _.isFinite(_.get(opt, 'delayMs')) ? opt.delayMs : 3000
    let requestTimeoutMs = _.isFinite(_.get(opt, 'requestTimeoutMs')) ? opt.requestTimeoutMs : REQUEST_TIMEOUT_MS
    let maxMs = _.isFinite(_.get(opt, 'maxMs')) ? opt.maxMs : MAX_WAIT_MS

    let t0 = Date.now()
    let b = false
    let nAuth = 0 //連續認證類(401/403)失敗次數
    for (let i = 0; i <= maxTry; i++) {
        if (i >= 1) {
            console.log(`重新檢測第 ${i} 次...`)
        }

        //checkNpmVersionCore, 例外視為尚未就緒(R19.1); 訊息為外來文字, 截短並中和致命字樣(R19.4)
        let st = { auth: 0 }
        try {
            b = await checkNpmVersionCore(registry, name, version, requestTimeoutMs, fx, st)
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

        //連續認證類失敗(帳本 R27.3): 非傳播延遲, 達門檻即停止(回 false, 呼叫端照常判為上架失敗)
        if (st.auth !== 0) {
            nAuth++
            if (nAuth === 1) {
                console.log(`${name}@${version} 主倉庫回 ${st.auth}(本檢測的請求不帶 npm 認證, 倉庫須允許匿名讀取); 連續 ${AUTH_FAIL_MAX} 次仍如此將停止等待`)
            }
            if (nAuth >= AUTH_FAIL_MAX) {
                console.log(`${name}@${version} 主倉庫連續 ${nAuth} 次回 ${st.auth}, 判定為認證問題而非傳播延遲, 停止等待`)
                break
            }
        }
        else {
            nAuth = 0
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


export { REQUEST_TIMEOUT_MS, MAX_WAIT_MS, AUTH_FAIL_MAX }
export default checkNpmVersion
