import path from 'path'
import fs from 'fs'
import cp from 'child_process'
import _ from 'lodash-es'
import w from 'wsemi'
import ectScripts from './ectScripts.mjs'
import checkNpmVersion from './checkNpmVersion.mjs'


/**
 * 判斷 rm 列之目標是否為套件內之相對路徑(純函式, 只看字串, 不碰檔案系統)
 *
 * 允許: 由英數、底線、連字號、點與路徑分隔字元組成之相對路徑, 如'docs'、'docs/'、'dist/sub'.
 * 不允許: 絕對路徑或磁碟機代號('C:\x'、'/x'、'\x')、含'..'或'.'之路徑段、萬用字元與 shell 特殊字元、空字串(三者皆可能刪到套件外或整個套件).
 *
 * @param {String} target 輸入目標路徑字串
 * @returns {Boolean} 回傳是否為安全之相對路徑
 */
function isSafeRmTarget(target) {
    if (!w.isestr(target)) {
        return false
    }
    if (path.isAbsolute(target) || /^[a-zA-Z]:/.test(target)) {
        return false
    }
    if (!/^[A-Za-z0-9_\-./\\]+$/.test(target)) {
        return false
    }
    let segs = _.filter(target.split(/[\\/]+/), (s) => s !== '')
    if (_.size(segs) === 0) {
        return false
    }
    if (_.some(segs, (s) => s === '.' || s === '..')) {
        return false
    }
    return true
}


/**
 * 判別單一指令列之類型(純函式)
 *
 * 支援之指令: 'node '、'./node_modules/.bin/'、'git '、'npm '開頭者, 以及'rm -r <套件內相對路徑>'; '#'開頭為註解.
 * 其他一律為非預期指令(如'npx ...'、'rm -rf ...'、'rm docs'), 由執行前檢查於任何副作用之前中止.
 *
 * @param {String} v 輸入指令列字串(已 trim)
 * @returns {Object} 回傳 { kind, target, reason }, kind 為'comment'、'node'、'bin'、'git'、'npm'、'rm'或'unexpected', target 僅 rm 有, reason 僅 unexpected 有
 */
function classifyLine(v) {
    if (w.strleft(v, 1) === '#') {
        return { kind: 'comment' }
    }
    if (w.strleft(v, 5) === 'node ') {
        return { kind: 'node' }
    }
    if (w.strleft(v, 20) === './node_modules/.bin/') {
        return { kind: 'bin' }
    }
    if (w.strleft(v, 4) === 'git ') {
        return { kind: 'git' }
    }
    if (w.strleft(v, 4) === 'npm ') {
        return { kind: 'npm' }
    }
    let m = String(v).match(/^rm -r (\S+)$/)
    if (m) {
        if (isSafeRmTarget(m[1])) {
            return { kind: 'rm', target: m[1] }
        }
        return { kind: 'unexpected', reason: 'rm之目標須為套件內之相對路徑' }
    }
    return { kind: 'unexpected', reason: '不支援之指令' }
}


/**
 * 解析 script.txt 內容(純函式): 依行切開並 trim、略過空行, 套用既有改寫後判別每列類型
 *
 * 既有改寫: '#node toolg/addVersion.mjs'與'#npm publish'去掉'#'改為執行; "git commit -m 'modify: '"補上訊息.
 *
 * @param {String} c 輸入 script.txt 內容字串
 * @param {String} [msg='update pks'] 輸入 git commit 訊息字串
 * @returns {Array} 回傳列物件陣列, 每列為 { no, raw, cmd, kind, target, reason }, no 為略過空行後之序號(由1起)
 */
function parseScript(c, msg = 'update pks') {

    let t1 = '#node toolg/addVersion.mjs'
    let t2 = `git commit -m 'modify: '`
    let t3 = '#npm publish'

    let scps = w.sep(c, '\n')

    let lines = _.map(scps, (raw, k) => {
        let v = raw
        if (v === t1) {
            v = w.strdelleft(v, 1)
            // console.log('t1', v)
        }
        else if (v === t3) {
            v = w.strdelleft(v, 1)
            // console.log('t3', v)
        }
        else if (v === t2) {
            v = `git commit -m 'modify: ${msg}'`
            // console.log('t2', v)
        }
        return {
            no: k + 1,
            raw,
            cmd: v,
            ...classifyLine(v),
        }
    })

    return lines
}


/**
 * 讀取並檢查套件之 script.txt, 有非預期指令即 throw
 *
 * 須於任何副作用(update package.json、npm i、addVersion 等)之前呼叫: publishPackage 於 updatePackage 前呼叫, runScript 於執行第一列前呼叫.
 * 若於副作用之後才中止, 套件之 package.json 已被改寫, 重跑時會被 getUpdate 判為已對齊而略過.
 *
 * @param {Object} pdi 輸入套件資訊物件, 須含 name 與 path
 * @param {String} [msg='update pks'] 輸入 git commit 訊息字串
 * @returns {Array} 回傳 parseScript 之列物件陣列
 */
function loadScript(pdi, msg = 'update pks') {

    let fpscp = path.resolve(pdi.path, 'script.txt')

    let c = fs.readFileSync(fpscp, 'utf8')
    // console.log('c', c)

    let lines = parseScript(c, msg)

    let us = _.filter(lines, (ln) => ln.kind === 'unexpected')
    if (_.size(us) > 0) {
        let s = _.join(_.map(us, (ln) => `第${ln.no}列[${ln.raw}](${ln.reason})`), ', ')
        throw new Error(`[${pdi.name}] 非預期指令(執行前檢查, 尚未執行任何列): ${s}`)
    }

    return lines
}


/**
 * 取指令列之重試政策(純函式)
 *
 * 只有'npm run deploy'失敗時重試2次、間隔30秒(推送 gh-pages 之網路暫時性失敗, 重試多可自癒; gh-pages 腳本每次自清暫存重來, 重試安全), 其他列不重試.
 *
 * @param {String} v 輸入指令列字串
 * @returns {Object} 回傳 { times, delayMs }
 */
function getRetryPolicy(v) {
    if (v === 'npm run deploy') {
        return { times: 2, delayMs: 30000 }
    }
    return { times: 0, delayMs: 0 }
}


/**
 * 重試時之顯示訊息(純函式)
 *
 * 不可含守望器比對之致命字樣(npm指令失敗、node指令失敗、rollup編譯失敗、建置產物遭刪除、npm上找不到、非預期指令、rm指令失敗), 否則可自癒之重試會被誤當中止; 失敗之輸出已於上方即時印出.
 *
 * @param {String} name 輸入套件名稱字串
 * @param {String} v 輸入指令列字串
 * @param {Number} k 輸入第幾次重試
 * @param {Number} n 輸入共幾次重試
 * @returns {String} 回傳訊息字串
 */
function getRetryMessage(name, v, k, n) {
    let delayMs = getRetryPolicy(v).delayMs
    return `${name} >>> 重試(第 ${k}/${n} 次, 間隔 ${delayMs / 1000} 秒): ${v}`
}


/**
 * 依重試政策執行非同步函數: 失敗時等待 delayMs 後重試, 最多重試 times 次, 仍失敗則 throw 最後一次之錯誤
 *
 * @param {Function} fn 輸入回傳 Promise 之函數
 * @param {Object} [opt={}] 輸入設定物件
 * @param {Number} [opt.times=0] 輸入重試次數
 * @param {Number} [opt.delayMs=0] 輸入每次重試前之等待毫秒數
 * @param {Function} [opt.onRetry=null] 輸入每次重試前之回調函數, 傳入(第幾次, 共幾次, 錯誤)
 * @returns {Promise} 回傳 Promise, resolve 回傳 fn 之結果
 */
async function runWithRetry(fn, opt = {}) {
    let times = _.get(opt, 'times', 0)
    let delayMs = _.get(opt, 'delayMs', 0)
    let onRetry = _.get(opt, 'onRetry', null)
    for (let i = 0; ; i++) {
        try {
            return await fn()
        }
        catch (err) {
            if (i >= times) {
                throw err
            }
            if (_.isFunction(onRetry)) {
                onRetry(i + 1, times, err)
            }
            await w.delay(delayMs)
        }
    }
}


/**
 * 執行'rm -r <目標>': 移除套件資料夾內之檔案或資料夾(遞迴)
 *
 * 目標不存在時視為成功(略過): 用途為清掉舊產物(如重建前之 docs), 不存在即已達成, 與 rm -rf、rimraf 之語意相同.
 * 目標存在時遞迴移除(Windows 之 EBUSY、EPERM 等內建重試), 移除後回驗確實不存在.
 * 目標須為套件內之相對路徑(見 isSafeRmTarget), 解析後須位於套件資料夾之內且不等於套件資料夾本身.
 *
 * @param {String} pathPkg 輸入套件資料夾路徑字串
 * @param {String} target 輸入目標相對路徑字串
 * @returns {Object} 回傳 { state, path }, state 為'removed'(已移除)或'absent'(不存在而略過), path 為目標絕對路徑
 */
function removeTarget(pathPkg, target) {

    let root = path.resolve(pathPkg)
    let fp = path.resolve(root, String(target))
    if (!isSafeRmTarget(target) || fp === root || !fp.startsWith(root + path.sep)) {
        throw new Error(`rm指令失敗: 目標須為套件內之相對路徑[${target}]`)
    }

    if (!fs.existsSync(fp)) {
        return { state: 'absent', path: fp }
    }

    try {
        fs.rmSync(fp, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
    }
    catch (err) {
        throw new Error(`rm指令失敗: ${err.message}`)
    }

    //回驗
    if (fs.existsSync(fp)) {
        throw new Error(`rm指令失敗: 移除後仍存在[${fp}]`)
    }

    return { state: 'removed', path: fp }
}


async function runScript(pdi, msg = 'update pks') {
    // pdi {
    //   name: 'w-serv-broadcast',
    //   path: 'D:\\- 006 -        開源\\開源-JS-007-4-w-serv-broadcast/w-serv-broadcast',
    //   version: '1.0.17',
    //   update: true,
    //   dependencies: [],
    //   devDependencies: [ { name: 'w-converhp', verOld: '^2.0.17', verNew: '^2.0.18' } ]
    // }

    //執行前檢查全部列: 有非預期指令即於第一列之前中止, 不在addVersion等改動之後才中止
    let lines = loadScript(pdi, msg)
    console.log('scps', _.map(lines, 'raw'))

    let bCheckDist = false //首次執行git指令前檢查建置產物之旗標

    await w.pmSeries(lines, async (ln) => {

        let v = ln.cmd //t1/t2/t3之改寫已於parseScript完成

        // console.log('cmd', v)
        if (ln.kind === 'comment') {
            return //直接跳出
        }
        // console.log('cmd(det)', v)

        let useNode = ln.kind === 'node'
        if (useNode) {
            console.log(`${pdi.name} >>> exec: `, v)
            let msg = await ectScripts(pdi, v, { main: 'node' }) //main='node'使node指令失敗(離開碼非0、程序無法啟動, 或輸出含[RollupError])於ectScripts內立即throw
            // .catch((err) => {
            //     console.log('useNode', err)

            //     // let e1 = `Browserslist: caniuse-lite is outdated.`
            //     // if (err.indexOf(e1) >= 0) {
            //     //     //rollup編譯提示Browserslist報錯, 不視為錯誤
            //     //     console.log(err) //err為正常訊息
            //     //     return
            //     // }

            //     // let e2 = `Browserslist: browsers data` //Browserslist: browsers data (caniuse-lite) is 6 months old.
            //     // if (err.indexOf(e2) >= 0) {
            //     //     //rollup編譯提示Browserslist報錯, 不視為錯誤
            //     //     console.log(err) //err為正常訊息
            //     //     return
            //     // }

            //     // let e3 = `Creating a browser bundle that depends on Node.js built-in modules`
            //     // if (err.indexOf(e3) >= 0) {
            //     //     //rollup編譯提示前端套件會依賴Node.js內建模組報錯, 不視為錯誤
            //     //     console.log(err) //err為正常訊息
            //     //     return
            //     // }

            //     // throw new Error(err)
            // })
            console.log('useNode:::', msg)
            return //直接跳出
        }

        let useBin = ln.kind === 'bin'
        if (useBin) {
            console.log(`${pdi.name} >>> exec: `, v)
            let msg = await ectScripts(pdi, v) //不判定成敗: jsdoc有ERROR時exit 1但文件照常產出; 有拒絕值時ectScripts只留痕一行(未判定(...))
            // .catch((err) => {
            //     console.log('useBin', err)

            //     // let e1 = `ERROR: Unable to find the source file or directory`
            //     // if (w.strleft(err, _.size(e1)) === e1) {
            //     //     //jsdoc報錯, 不視為錯誤
            //     //     console.log(err) //err為正常訊息
            //     //     return
            //     // }

            //     // throw new Error(err)
            // })
            console.log('useBin:::', msg)
            return //直接跳出
        }

        let useGit = ln.kind === 'git'
        if (useGit) {

            //首次執行git指令前檢查dist內有無[已被刪除且未重建]之git追蹤檔(建置失敗徵兆: cleanFolder刪除後建置未重建, git狀態為D; 殷鑑w-highcharts空殼上架), 有即中止避免push/publish空殼
            //註: 不可改用[main檔案存在]檢查, 套件區多套件main欄位指向從未存在之檔名(長期狀態, 如w-fft/w-batch/w-pubsub/w-converhp), 會誤擋
            if (!bCheckDist) {
                bCheckDist = true
                let rd = ''
                try {
                    rd = cp.execSync('git status --porcelain -- dist', { cwd: pdi.path }).toString()
                }
                catch (e) {
                    rd = '' //非git倉庫等情況跳過檢查
                }
                let lns = _.filter(_.split(rd, '\n'), (s) => _.trim(s) !== '')
                let dels = _.filter(lns, (s) => _.trim(s).slice(0, 2).indexOf('D') >= 0) //遭刪除(含AD: 曾staged後又被刪)
                let outs = _.filter(lns, (s) => _.trim(s).slice(0, 2).indexOf('D') < 0) //有產出(??新檔, M修改, A新增)
                //判準: 有刪除且完全無產出=建置失敗空殼(殷鑑w-highcharts: 僅2行D零產出); hash檔名rebuild(舊hash刪+新hash增, 如w-web-api)有產出不誤擋
                if (_.size(dels) > 0 && _.size(outs) === 0) {
                    throw new Error(`[${pdi.name}] 建置產物遭刪除且無任何產出:\n${_.join(dels, '\n')}\n中止git與publish`)
                }
            }

            console.log(`${pdi.name} >>> exec: `, v)
            let msg = await ectScripts(pdi, v) //不判定成敗: git commit無變更時exit 1; 有拒絕值時ectScripts只留痕一行(未判定(...))
            // .catch((err) => {
            //     console.log('useGit', err)

            //     // let e1 = `warning: LF will be replaced by CRLF`
            //     // if (err.indexOf(e1) >= 0) {
            //     //     //git自動取代crlf報錯, 不視為錯誤
            //     //     console.log(err) //err為正常訊息
            //     //     return
            //     // }

            //     // let e2a = `remote: GitHub found`
            //     // let e2b = `vulnerabil` //可能有單數, 不要用複數vulnerabilities偵測
            //     // if (err.indexOf(e2a) >= 0 && err.indexOf(e2b) >= 0) {
            //     //     //git push時偵測vulnerabilities報錯, 不視為錯誤
            //     //     console.log(err) //err為正常訊息
            //     //     return
            //     // }

            //     // let e3 = `To https://github.com/yuda-lyu/`
            //     // if (err.indexOf(e3) >= 0) {
            //     //     //git push至倉庫時訊息報錯, 不視為錯誤
            //     //     console.log(err) //err為正常訊息
            //     //     return
            //     // }

            //     // throw new Error(err)
            // })
            console.log('useGit:::', msg)
            return //直接跳出
        }

        let useNpm = ln.kind === 'npm'
        if (useNpm) {
            console.log(`${pdi.name} >>> exec: `, v)
            let msg = await runWithRetry(() => {
                return ectScripts(pdi, v, { main: 'npm' }) //main='npm'使npm指令失敗(輸出含npm error, 或離開碼非0、程序無法啟動)於ectScripts內立即throw
            }, {
                ...getRetryPolicy(v), //npm run deploy失敗重試2次、間隔30秒, 其他不重試
                onRetry: (k, n, err) => {
                    console.log(getRetryMessage(pdi.name, v, k, n)) //訊息不含致命字樣, 避免守望器誤當中止
                },
            })
            // .catch((err) => {
            //     console.log('useNpm', err)

            //     // let e1 = `npm notice Publishing to https://registry.npmjs.org/ with tag latest and default access`
            //     // if (err.indexOf(e1) >= 0) {
            //     //     //npm publish會用stdout報錯, 不視為錯誤
            //     //     console.log(err) //err為正常訊息
            //     //     return
            //     // }

            //     // let e2 = `You cannot publish over the previously published versions`
            //     // if (err.indexOf(e2) >= 0) {
            //     //     //npm publish先前版本報錯, 要視為錯誤
            //     //     throw new Error(err)
            //     // }

            //     // throw new Error(err)
            // })
            console.log('useNpm:::', msg)
            // let cerr
            // cerr = 'You cannot publish over the previously published versions'
            // if (msg.indexOf(cerr) >= 0) {
            //     throw new Error(cerr)
            // }
            return //直接跳出
        }

        let useRm = ln.kind === 'rm'
        if (useRm) {
            console.log(`${pdi.name} >>> exec: `, v)
            let r
            try {
                r = removeTarget(pdi.path, ln.target) //不存在視為成功(略過), 存在則遞迴移除並回驗
            }
            catch (err) {
                throw new Error(`[${pdi.name}] ${err.message}: ${v}`)
            }
            console.log('useRm:::', r.state === 'removed' ? `已移除 ${r.path}` : `不存在, 略過 ${r.path}`)
            return //直接跳出
        }

        throw new Error(`非預期指令: ${v}`) //執行前已由loadScript檢查, 正常不會到此
    })
    // .catch((err) => {
    //     console.log('runScript catch', err) //僅顯示不向外報錯
    // })

    //偵測npm, 確認套件已能取得與安裝
    if (true) {

        let fppkg = path.resolve(pdi.path, 'package.json')

        let j = fs.readFileSync(fppkg, 'utf8')

        let o = w.j2o(j)

        let versionNew = o.version

        let b = await checkNpmVersion(pdi.name, versionNew)

        if (!b) {
            throw new Error(`npm上找不到[${pdi.name}@${versionNew}]`) //須用versionNew(addVersion已bump), pdi.version為掃描時舊版號會誤導
        }

    }

    // console.log('runScript finish')
}


export {
    isSafeRmTarget,
    classifyLine,
    parseScript,
    loadScript,
    getRetryPolicy,
    getRetryMessage,
    runWithRetry,
    removeTarget
}
export default runScript
