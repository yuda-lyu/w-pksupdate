import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import _ from 'lodash-es'


//測試環境判別與真實執行守衛(帳本 R25): 測試環境下, 真實執行路徑(啟動 PowerShell、git、npm、網路、掃描真實套件區)未經注入一律於任何副作用之前 throw.
//不用 .mocharc 或 package.json 之 mocha 鍵(全域規範禁用), 以四個訊號判別, 任何以 mocha 或 npm test 執行之測試檔(含單檔執行)皆涵蓋.

const ENV_FLAG = 'W_PKSUPDATE_TEST'



/**
 * 判斷 argv 是否為 mocha 執行(純函式)
 *
 * @param {Array} argv 輸入 process.argv 形態之陣列
 * @returns {Boolean} 回傳任一元素檔名為 mocha 或 _mocha(可帶 .js/.cjs/.mjs)
 */
function isMochaArgv(argv) {
    return _.some(argv, (s) => /^_?mocha(\.c?js|\.mjs)?$/i.test(path.basename(String(s))))
}


/**
 * 判斷目前是否為測試環境(帳本 R25.1): 任一成立即是
 * ①環境變數 W_PKSUPDATE_TEST 非空; ②npm_lifecycle_event 為 test; ③mocha 全域 describe+it(BDD)或 suite+test(TDD)皆為函式; ④argv 含 mocha 或位於 node_modules/mocha 下(含 worker);
 * ⑤node --test(NODE_TEST_CONTEXT、execArgv 含 --test*); ⑥argv 含 *.test.* / *.spec.* 檔(測試檔被直接執行)
 *
 * @param {Object} [p={}] 輸入設定物件(供測試注入)
 * @param {Object} [p.env=process.env] 輸入環境變數物件
 * @param {Object} [p.globals=globalThis] 輸入全域物件
 * @param {Array} [p.argv=process.argv] 輸入 argv 陣列
 * @param {Array} [p.execArgv=process.execArgv] 輸入 execArgv 陣列
 * @returns {Boolean} 回傳是否為測試環境
 */
function detectTestEnv(p = {}) {
    let env = _.get(p, 'env', process.env)
    let g = _.get(p, 'globals', globalThis)
    let argv = _.get(p, 'argv', process.argv)
    let execArgv = _.get(p, 'execArgv', process.execArgv)
    if (_.get(env, ENV_FLAG, '') !== '') {
        return true
    }
    if (_.get(env, 'npm_lifecycle_event') === 'test') {
        return true
    }
    if (_.get(env, 'NODE_TEST_CONTEXT', '') !== '') {
        return true //node --test 之測試行程(其子行程繼承)
    }
    if (_.isFunction(_.get(g, 'describe')) && _.isFunction(_.get(g, 'it'))) {
        return true //mocha BDD
    }
    if (_.isFunction(_.get(g, 'suite')) && _.isFunction(_.get(g, 'test'))) {
        return true //mocha TDD
    }
    if (_.some(execArgv, (s) => s === '--test' || String(s).indexOf('--test-') === 0)) {
        return true
    }
    if (isMochaArgv(argv)) {
        return true
    }
    //mocha 之 worker(--parallel)、位於 node_modules/mocha 下之任何入口, 以及測試檔(*.test.*、*.spec.*)本身被直接執行
    return _.some(argv, (s) => /[\\/]node_modules[\\/]mocha[\\/]/i.test(String(s)) || /\.(test|spec)\.(m?js|cjs)$/i.test(String(s)))
}


//鎖存: 本行程一旦以實際環境(不傳參數)判為測試環境, 之後即使測試自己清掉旗標、環境變數或 argv 也仍是測試環境(第 5 次外審 sol F08)
let latched = false


/**
 * 判斷目前是否為測試環境(帳本 R25.1); 判別規則見 detectTestEnv
 *
 * 不傳參數時判實際環境並鎖存(一旦為真即永遠為真); 傳參數時為純函式(供單元測試)
 *
 * @param {Object} [p] 輸入設定物件, 見 detectTestEnv; 不傳或傳空物件表示判實際環境
 * @returns {Boolean} 回傳是否為測試環境
 */
function isTestEnv(p = {}) {
    let real = _.isEmpty(p)
    if (real && latched) {
        return true
    }
    let r = detectTestEnv(p)
    if (real && r) {
        latched = true
    }
    return r
}


//測試環境下設旗標, 使測試所產生之子行程(整合案例)繼承
if (isTestEnv()) {
    process.env[ENV_FLAG] = '1'
}


function throwBlocked(site, detail) {
    let err = new Error(`[testGuard] 測試環境下禁止走未注入之真實執行路徑[${site}]: ${detail}(帳本 R25; 需刻意走真實執行者經 test/tools/realExec.mjs)`)
    err.testGuard = true //標記: 呼叫端若有「吞掉例外後略過」的 catch(如 runScript 的 dist 閘門), 須先 isTestGuardError 判別並原樣重拋, 守衛不得被吞
    throw err
}


/**
 * 是否為本模組守衛所拋之錯誤(帳本 R25.2)
 *
 * @param {*} err 輸入錯誤值
 * @returns {Boolean} 回傳是否為守衛錯誤
 */
function isTestGuardError(err) {
    return _.get(err, 'testGuard') === true
}


/**
 * 測試環境下要求呼叫端已注入指定函式, 缺任一即 throw(帳本 R25.2); 正式環境不檢查
 *
 * @param {String} site 輸入站點名稱
 * @param {Object} obj 輸入注入物件(opt 或 opt.deps), 可為 undefined
 * @param {Array} keys 輸入必須注入之鍵名陣列
 */
function requireInjected(site, obj, keys) {
    if (!isTestEnv()) {
        return
    }
    //須為 obj 自身可列舉的函式值: 原型上的方法或不可列舉屬性在物件 spread 合併預設依賴時會被丟掉而落回真實預設實作(第 5 次外審 sol F10: 驗證的與實際使用的不是同一份)
    let own = (k) => Boolean(obj) && Object.prototype.propertyIsEnumerable.call(obj, k)
    let miss = _.filter(keys, (k) => !(own(k) && _.isFunction(obj[k])))
    if (_.size(miss) > 0) {
        throwBlocked(site, `未注入 ${_.join(miss, '、')}`)
    }
}


/**
 * 測試環境下無條件 throw(帳本 R25.2), 用於站點之真實預設實作被使用時; 正式環境不檢查
 *
 * @param {String} site 輸入站點名稱
 * @param {String} [detail='使用了真實預設實作'] 輸入說明
 */
function assertRealExecAllowed(site, detail = '使用了真實預設實作') {
    if (!isTestEnv()) {
        return
    }
    throwBlocked(site, detail)
}


//專案根: 由本檔位置推得, 不取 process.cwd()(測試中 process.chdir 會使 cwd 相對的錨點搬家, 第 5 次外審 opus F08)
const FD_PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')


/**
 * 取得測試暫存根 <專案根>/test/_tmp 之實體路徑(帳本 R25.2); 測試 fixture 一律建在其下
 *
 * @returns {String} 回傳實體路徑字串
 */
function testTmpRoot() {
    return realPathOf(path.join(FD_PROJECT, 'test', '_tmp'))
}


/**
 * 取路徑的實體路徑(解開 junction、符號連結、8.3 短名), 路徑尚不存在時取最近的既存祖先之實體路徑再接回其餘段
 *
 * 路徑比對若只做字面比對, test/_tmp 內放一個指向真實套件的 junction 即可通過限制(帳本 R25.2).
 *
 * @param {String} p 輸入路徑字串
 * @returns {String} 回傳絕對的實體路徑字串
 */
function realPathOf(p) {
    let a = path.resolve(String(p))
    let rest = []
    for (;;) {
        try {
            return path.join(fs.realpathSync.native(a), ...rest)
        }
        catch (err) {
            let parent = path.dirname(a)
            if (parent === a) {
                return path.resolve(String(p))
            }
            rest.unshift(path.basename(a))
            a = parent
        }
    }
}


/**
 * 測試環境下要求即將被改寫的檔案不是硬連結(nlink 大於 1)(帳本 R25.2), 否則 throw; 正式環境不檢查
 *
 * fixture 內的 package.json 若是 test/_tmp 之外某檔案的硬連結, 實體路徑檢查仍會通過, 但寫入會改到外側檔案(第 5 次外審 sol F02).
 *
 * @param {String} site 輸入站點名稱
 * @param {String} fp 輸入檔案路徑; 不存在或不是檔案者放行(沒有東西可被別名改寫)
 */
function assertSingleLink(site, fp) {
    if (!isTestEnv()) {
        return
    }
    let st = null
    try {
        st = fs.statSync(fp)
    }
    catch (err) {
        return
    }
    if (st.isFile() && st.nlink > 1) {
        throwBlocked(site, `檔案[${fp}]為硬連結(nlink=${st.nlink}), 寫入會改到別名檔案(測試環境下只可改寫 fixture 專有之檔案)`)
    }
}


/**
 * 測試環境下要求套件路徑在 test/_tmp 內(帳本 R25.2), 否則 throw; 正式環境不檢查
 *
 * 測試環境下 getFolders 已被擋, 取不到真實 pdi; 此檢查再擋「手工組出指向真實套件之 pdi」: runScript 的 rm -r、publishPackage 的改寫與還原 package.json 只可能作用於測試自建 fixture.
 *
 * @param {String} site 輸入站點名稱
 * @param {String} p 輸入套件資料夾路徑
 */
function assertConfinedToTestTmp(site, p) {
    if (!isTestEnv()) {
        return
    }
    let root = testTmpRoot().toLowerCase()
    let a = _.isString(p) && p !== '' ? realPathOf(p).toLowerCase() : ''
    if (a !== root && !a.startsWith(root + path.sep)) {
        throwBlocked(site, `套件路徑[${p}]不在 test/_tmp 內(測試環境下只可作用於測試自建之 fixture)`)
    }
}


export { ENV_FLAG, isMochaArgv, isTestEnv, isTestGuardError, requireInjected, assertRealExecAllowed, assertConfinedToTestTmp, assertSingleLink, realPathOf, testTmpRoot }
