import path from 'path'
import fs from 'fs'
import cp from 'child_process'
import _ from 'lodash-es'
import w from 'wsemi'
import ectScripts, { isTimeoutMessage, GIT_FATAL_EXIT_CODE } from './ectScripts.mjs'
import checkNpmVersion from './checkNpmVersion.mjs'
import { normalizeRegistryUrl } from './registryConfig.mjs'
import { publishToMirrors } from './mirrorPublish.mjs'
import { requireInjected, assertRealExecAllowed, assertConfinedToTestTmp, isTestGuardError } from './testGuard.mjs'
import { GIT_ALLOWED_SUBS, getGitSubcommand } from './gitSubcommand.mjs'


//rm -r 遇暫時占用(帳本 R14): 可重試之錯誤碼與預設預算(20 次 × 500ms ≈ 10 秒; 主控 2026-10-16 裁示, 失敗代價〔limbo、版本跳號、整輪重跑〕遠大於多等數秒)
const RM_RETRY_CODES = new Set(['EBUSY', 'EPERM', 'ENOTEMPTY', 'EACCES'])
const RM_RETRIES = 20
const RM_DELAY_MS = 500

//同步等待(removeTarget 維持同步函式; 本流程序列執行, 阻塞事件迴圈無影響; 比照 w-package-tools buildCheck.mjs 之 sleepSync)
const sleepSync = (ms) => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

//指令列樣式(帳本 R17.1、R9、R20.6): 指令名之後可接參數(須以空白分隔, 故 'npm run deployx'、'npm publishx' 不算)
//唯讀查詢: 不改動倉庫、不對外(外審 F07); 子命令前可有全域選項(-C <路徑>、-c <k=v>、--no-pager、-P、--git-dir=、--work-tree=、--no-optional-locks; 第二輪 N5),
//含引號之值等無法確認者不符合本樣式, 保守視為對外列
const GIT_GLOBAL_OPTS = String.raw`(?:\s+(?:-C\s+[^\s"']+|-c\s+[^\s"']+|--no-pager|-P|--no-optional-locks|--git-dir(?:=|\s+)[^\s"']+|--work-tree(?:=|\s+)[^\s"']+))*`
const RE_READONLY_GIT = new RegExp(String.raw`^git${GIT_GLOBAL_OPTS}\s+(?:status|diff|log|show|rev-parse|ls-files|describe|rev-list|cat-file|shortlog|blame|grep)(?=\s|$)`)
//本機 git 列(帳本 R21): add、commit 只改本機 index 與 commit, 不連遠端; 其餘非唯讀 git(push、tag、fetch、remote…)一律視為遠端列
const RE_LOCAL_GIT = new RegExp(String.raw`^git${GIT_GLOBAL_OPTS}\s+(?:add|commit)(?=\s|$)`)
const RE_ADD_VERSION = /^node toolg\/addVersion\.mjs(?=\s|$)/

/**
 * 判斷 npm 指令列是否自帶倉庫旗標(純函式; 帳本 R27.5)
 *
 * 命令列旗標優先於 w-pksupdate 以 npm_config_registry 指定之主倉庫, 會使發布/安裝落到設定以外之倉庫, 故於執行前檢查拒絕; 倉庫一律由倉庫設定決定.
 * 先去引號(PowerShell 去引號後 npm 才收到, 與 parseNpmCmd 同法)再逐記號比對: --registry、其唯一前綴縮寫(npm 的 nopt 接受 --reg、--regi…; 至少 3 字元)、--@scope:registry.
 *
 * @param {String} v 輸入指令列字串
 * @returns {Boolean} 回傳是否自帶倉庫旗標
 */
function hasNpmRegistryOverride(v) {
    let ts = String(v).replace(/["']/g, '').replace(/\s+/g, ' ').trim().split(' ')
    return _.some(ts, (t) => {
        if (!t.startsWith('--')) {
            return false
        }
        let name = t.slice(2).split('=')[0].toLowerCase()
        return (name.length >= 3 && 'registry'.startsWith(name)) || /^@[^:]+:registry$/.test(name)
    })
}


/**
 * 取套件 package.json 中會使發布落到倉庫設定以外之設定(純函式以外: 讀 package.json; 讀不到或無法剖析者視為無)
 *
 * npm publish 會把 package.json 的 publishConfig 套到發布選項, 其優先於環境變數(僅命令列旗標更高): publishConfig.registry 會壓過 w-pksupdate 指定之主倉庫;
 * scoped 套件(@scope/name)則適用 scope 專屬的 registry 設定(@scope:registry), 同樣壓過 registry. 本工具僅支援無 scope 且無 publishConfig.registry 之套件, 其餘於執行前檢查拒絕(帳本 R27.5).
 *
 * @param {Object} pdi 輸入套件資訊物件, 須含 path
 * @returns {String} 回傳原因字串; 無問題回傳''
 */
function getPublishTargetIssue(pdi) {
    let o = null
    try {
        o = w.j2o(fs.readFileSync(path.resolve(pdi.path, 'package.json'), 'utf8'))
    }
    catch (err) {
        return ''
    }
    let name = _.get(o, 'name')
    if (typeof name === 'string' && name.startsWith('@')) {
        return `套件名[${name}]為 scoped 套件, scope 專屬之 registry 設定(@scope:registry)會壓過主倉庫設定; 本工具僅支援無 scope 套件`
    }
    let r = _.get(o, 'publishConfig.registry')
    if (r !== undefined && r !== null && r !== '') {
        return 'package.json 之 publishConfig.registry 會壓過主倉庫設定(npm 規則: publishConfig 優先於環境變數); 請移除, 倉庫一律由倉庫設定決定'
    }
    return ''
}

//入口解析時補的副檔名與資料夾 index(帳本 R17.8, 比照 Node 的 LOAD_AS_FILE、LOAD_AS_DIRECTORY; Node 不補 .mjs、.cjs, 第二輪 N4)
const MAIN_EXTS = ['.js', '.json', '.node']
const MAIN_INDEXES = ['index.js', 'index.json', 'index.node']


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
 * 判斷指令列是否含 shell(PowerShell)控制運算子(純函式; 帳本 R10)
 *
 * 整列原樣交給 PowerShell 執行, 若含分隔/管線/重導/子運算式, 單看列首無法確定它只做一件事(如'git status ; git push'列首是唯讀查詢, 實際會 push).
 * 引號外之 ; | & < > ( ) { } 與換行、單引號外之反引號與 $(含$變數展開, 其可藏子命令)視為控制運算子; 單引號內任何字元、雙引號內之 ; | & < > ( ) { } 不算.
 *
 * @param {String} v 輸入指令列字串
 * @returns {Boolean} 回傳是否含 shell 控制運算子; 非字串回傳 false
 */
function hasShellControl(v) {
    if (!w.isestr(v)) {
        return false
    }
    let q = '' //目前所在引號: ''(無)、"'"、'"'
    for (let i = 0; i < v.length; i++) {
        let c = v[i]
        if (q === "'") {
            if (c === "'") {
                q = ''
            }
            continue
        }
        if (c === '`' || c === '$') {
            return true //反引號、$(子運算式)與$變數展開(單引號外): 變數可藏子命令, 如'git $env:X push'
        }
        if (q === '"') {
            if (c === '"') {
                q = ''
            }
            continue
        }
        if (c === "'" || c === '"') {
            q = c
            continue
        }
        if (';|&<>(){}\r\n'.indexOf(c) >= 0) {
            return true
        }
    }
    return false
}


/**
 * 判斷指令列是否為唯讀 git 查詢(純函式; 帳本 R17.1、R10): status、diff、log、show、rev-parse、ls-files、describe、rev-list、cat-file、shortlog、blame、grep
 *
 * 含 shell 控制運算子者(如'git status ; git push')不是唯讀, 保守視為對外列(外審 sol F1).
 *
 * @param {String} v 輸入指令列字串(parseScript 改寫後之 cmd)
 * @returns {Boolean} 回傳是否為唯讀 git 查詢
 */
function isReadonlyGitCmd(v) {
    return RE_READONLY_GIT.test(String(v)) && !hasShellControl(String(v))
}


/**
 * 判斷指令列是否為本機 git 列(純函式; 帳本 R21): git add、git commit(子命令前可有全域選項), 只改本機 index 與 commit, 不連遠端
 *
 * 含 shell 控制運算子或無法確認之寫法(含引號之全域選項值等)不是本機 git 列, 保守視為遠端列.
 *
 * @param {String} v 輸入指令列字串
 * @returns {Boolean} 回傳是否為本機 git 列
 */
function isLocalGitCmd(v) {
    return w.isestr(v) && RE_LOCAL_GIT.test(v) && !hasShellControl(v)
}


/**
 * 取 npm 指令列之子命令與其第一個引數(純函式; 帳本 R9、R20.6、R21)
 *
 * 先去引號並把連續空白(含 tab)收成一個, 再以空白切記號: 首記號須為 npm; 其後以 - 開頭之記號視為全域選項而略過(須為單一記號, 如--silent、--loglevel=warn),
 * 第一個非選項記號為子命令, 其後第一個非選項記號為引數. 'npm run  deploy'、'npm "publish"'、'npm --silent run deploy'經 PowerShell 與標準形同義(外審 sol F2).
 *
 * @param {String} v 輸入指令列字串
 * @returns {Object} 回傳 { sub, arg }; 非 npm 列、無子命令時 sub 為''; 無引數時 arg 為''
 */
function parseNpmCmd(v) {
    if (!w.isestr(v)) {
        return { sub: '', arg: '' }
    }
    let ts = String(v).replace(/["']/g, '').replace(/\s+/g, ' ').trim().split(' ')
    if (ts[0] !== 'npm') {
        return { sub: '', arg: '' }
    }
    let rest = _.filter(_.slice(ts, 1), (t) => t !== '')
    let sub = ''
    let arg = ''
    let i = 0
    while (i < _.size(rest) && w.strleft(rest[i], 1) === '-') {
        i++
    }
    if (i < _.size(rest)) {
        sub = rest[i]
        i++
        while (i < _.size(rest) && w.strleft(rest[i], 1) === '-') {
            i++
        }
        if (i < _.size(rest)) {
            arg = rest[i]
        }
    }
    return { sub, arg }
}


/**
 * 判斷指令列是否為 npm run deploy(純函式; 帳本 R9、R17.1): 指令之後可接參數, 如'npm run deploy -- --message x'
 *
 * 等價寫法(連續空白、引號、單一記號之全域選項、run-script 別名)視同標準形; 'npm run deployx'、'npm run deploy:prod'不算.
 *
 * @param {String} v 輸入指令列字串
 * @returns {Boolean} 回傳是否為 deploy 列
 */
function isDeployCmd(v) {
    let { sub, arg } = parseNpmCmd(v)
    return (sub === 'run' || sub === 'run-script') && arg === 'deploy'
}


/**
 * 判斷指令列是否為 npm publish(純函式; 帳本 R17.1、R20.6): 指令之後可接參數, 如'npm publish --tag next'
 *
 * 等價寫法(連續空白、引號、單一記號之全域選項)視同標準形; 'npm publishx'、'npm run publish'不算.
 *
 * @param {String} v 輸入指令列字串
 * @returns {Boolean} 回傳是否為發布列
 */
function isPublishCmd(v) {
    return parseNpmCmd(v).sub === 'publish'
}


/**
 * 判斷指令列是否為版本遞增列(純函式; 帳本 R20.6): 'node toolg/addVersion.mjs'之後可接參數
 *
 * @param {String} v 輸入指令列字串
 * @returns {Boolean} 回傳是否為版本遞增列
 */
function isAddVersionCmd(v) {
    return RE_ADD_VERSION.test(String(v))
}


/**
 * 判斷指令列是否為對外列(純函式; 帳本 R17.1): 非唯讀之 git 列、npm run deploy、npm publish
 *
 * 對外列執行前須通過 R10(僅 git)、R20.2、R17.1 閘門; 唯讀 git 查詢、建置列、rm -r 不算.
 *
 * @param {String} v 輸入指令列字串
 * @returns {Boolean} 回傳是否為對外列
 */
function isOutwardCmd(v) {
    if (!w.isestr(v)) {
        return false
    }
    if (isDeployCmd(v) || isPublishCmd(v)) {
        return true
    }
    return w.strleft(v, 4) === 'git ' && !isReadonlyGitCmd(v)
}


/**
 * 判斷指令列是否為遠端列(純函式; 帳本 R21): 對外列且不是本機 git 列, 即 git push、npm run deploy、npm publish 及無法確認為本機之非唯讀 git(tag、fetch、remote…)
 *
 * 第一個遠端列是「不可回頭點」: 其 exec 之前的中止由 publishPackage 還原 package.json 與 lock, 其後(含該列自身失敗)不還原.
 * 對外列(含 git add、git commit)仍照舊觸發 R10/R17/R20.2 閘門, 只有還原邊界取遠端列.
 *
 * @param {String} v 輸入指令列字串
 * @returns {Boolean} 回傳是否為遠端列
 */
function isRemoteCmd(v) {
    return isOutwardCmd(v) && !isLocalGitCmd(v)
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
    //node/bin/git/npm 列整列原樣交給 PowerShell: 含 shell 控制運算子者可把另一個指令(如 npm publish)藏在這一列裡而逃過列類型、列序與閘門判斷, 一律於執行前拒絕(外審 sol F1、opus F6)
    let kindRaw = ''
    if (w.strleft(v, 5) === 'node ') {
        kindRaw = 'node'
    }
    else if (w.strleft(v, 20) === './node_modules/.bin/') {
        kindRaw = 'bin'
    }
    else if (w.strleft(v, 4) === 'git ') {
        kindRaw = 'git'
    }
    else if (w.strleft(v, 4) === 'npm ') {
        kindRaw = 'npm'
    }
    if (kindRaw !== '') {
        if (hasShellControl(v)) {
            return { kind: 'unexpected', reason: '含 shell 控制運算子(; | & < > ( ) { }、反引號、$( ), 無法判定為單一指令, 請拆成多列' }
        }
        if (kindRaw === 'npm' && hasNpmRegistryOverride(v)) {
            return { kind: 'unexpected', reason: 'npm 列不得自帶 --registry(倉庫一律由 w-pksupdate 之倉庫設定決定, 見 README〈倉庫設定〉)' }
        }
        //git 列之子命令須在允許集合內(帳本 R7.2): 錯字(git pusj)、無子命令(git --version)、尚未納管之子命令(pull、tag…)於任何副作用之前攔下; 區分大小寫(git 自己亦然)
        if (kindRaw === 'git') {
            let sub = getGitSubcommand(v, { keepCase: true })
            if (!GIT_ALLOWED_SUBS.has(sub)) {
                return { kind: 'unexpected', reason: `git 子命令[${sub}]不在允許集合(add、commit、push 與唯讀查詢)` }
            }
        }
        return { kind: kindRaw }
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
 * 另要求 script.txt 含版本遞增列(node toolg/addVersion.mjs, 後可接參數)與發布列(npm publish, 後可接參數; 註解形 #… 於 parseScript 改寫後計入), 缺任一 throw(帳本 R20.1、R20.6),
 * 否則 runScript 走完所有列後最終閘門查到的是未遞增之舊版(必在 npm 上), 會把「什麼都沒發布」判成功;
 * 版本遞增列並須在首個對外列(非唯讀 git、npm run deploy、npm publish)之前, 否則 throw 列序不符(R20.5); opt.checkRelease=false 時兩項皆略過(僅供測試夾具).
 *
 * @param {Object} pdi 輸入套件資訊物件, 須含 name 與 path
 * @param {String} [msg='update pks'] 輸入 git commit 訊息字串
 * @param {Object} [opt={}] 輸入設定物件
 * @param {Boolean} [opt.checkRelease=true] 輸入是否檢查必要列, 預設 true
 * @returns {Array} 回傳 parseScript 之列物件陣列
 */
function loadScript(pdi, msg = 'update pks', opt = {}) {

    let fpscp = path.resolve(pdi.path, 'script.txt')

    let c = fs.readFileSync(fpscp, 'utf8')
    // console.log('c', c)

    let lines = parseScript(c, msg)

    let us = _.filter(lines, (ln) => ln.kind === 'unexpected')
    if (_.size(us) > 0) {
        let s = _.join(_.map(us, (ln) => `第${ln.no}列[${ln.raw}](${ln.reason})`), ', ')
        throw new Error(`[${pdi.name}] 非預期指令(執行前檢查, 尚未執行任何列): ${s}`)
    }

    //發布目標檢查(帳本R27.5): publishConfig.registry 與 scoped 套件名會使發布落到倉庫設定以外之倉庫, 於任何副作用之前拒絕(沿用『非預期指令』守望字樣)
    let issue = getPublishTargetIssue(pdi)
    if (issue !== '') {
        throw new Error(`[${pdi.name}] 非預期指令(執行前檢查, 尚未執行任何列): ${issue}`)
    }

    //必要列(帳本R20.1、R20.6)與列序(R20.5): 以改寫後之指令比對, 故註解形與已去#形皆接受, 指令之後可接參數; 帶額外參數之註解(#npm publish --tag next)不是改寫對象, 視為缺
    if (_.get(opt, 'checkRelease', true) !== false) {
        let rows = _.filter(lines, (ln) => ln.kind !== 'comment')
        let iAdd = _.findIndex(rows, (ln) => isAddVersionCmd(ln.cmd))
        let miss = []
        if (iAdd < 0) {
            miss.push('缺版本遞增列[node toolg/addVersion.mjs]')
        }
        if (!_.some(rows, (ln) => isPublishCmd(ln.cmd))) {
            miss.push('缺發布列[npm publish]')
        }
        if (_.size(miss) > 0) {
            throw new Error(`[${pdi.name}] script.txt缺少必要列(執行前檢查, 尚未執行任何列): ${_.join(miss, '、')}`)
        }

        //版本遞增列須在首個對外列之前: 否則 git push、deploy、publish 帶著舊版本號發生(R20.5)
        let iOut = _.findIndex(rows, (ln) => isOutwardCmd(ln.cmd))
        if (iOut >= 0 && iAdd > iOut) {
            throw new Error(`[${pdi.name}] script.txt列序不符(執行前檢查, 尚未執行任何列): 版本遞增列[node toolg/addVersion.mjs]須在首個對外列[${rows[iOut].cmd}]之前`)
        }
    }

    return lines
}


/**
 * 取指令列之重試政策(純函式)
 *
 * 'npm run deploy'(後可接參數, 見 isDeployCmd)與'git push'(R26, 見 isPushCmd)失敗時重試2次、間隔30秒(推送 gh-pages / 遠端之網路暫時性失敗, 重試多可自癒; gh-pages 腳本每次自清暫存重來、push 可重送, 重試安全), 其他列不重試.
 * 逾時失敗不重試(R9), 由呼叫端以 runWithRetry 之 shouldRetry 判斷; git push 另須為網路類失敗才重試(isNetworkPushError).
 *
 * @param {String} v 輸入指令列字串
 * @returns {Object} 回傳 { times, delayMs }
 */
function getRetryPolicy(v) {
    if (isDeployCmd(v) || isPushCmd(v)) {
        return { times: 2, delayMs: 30000 }
    }
    return { times: 0, delayMs: 0 }
}


/**
 * 判斷指令列是否為 git push(純函式; 帳本 R26.1): 子命令前可有全域選項, 後可接參數與引號
 *
 * 含 shell 控制運算子者(如'git status ; git push')不算(執行前檢查已拒絕此類列).
 *
 * @param {String} v 輸入指令列字串
 * @returns {Boolean} 回傳是否為 git push 列; 非字串回傳 false
 */
function isPushCmd(v) {
    return w.isestr(v) && !hasShellControl(v) && getGitSubcommand(v) === 'push'
}


//git push 值得重試之網路類失敗特徵(帳本 R26.1): 這些訊息出現時 push 多半尚未送達遠端或可安全重送, 比照 deploy 重試; 被拒(non-fast-forward、GH001)、認證、index.lock 等非網路類不在此列
const RE_PUSH_NETWORK_ERROR = /unable to access|Could not resolve host|RPC failed|remote end hung up|Empty reply/

//輸出同時含下列字樣者屬非暫時性(認證、權限、憑證、規則拒絕、倉庫不存在), 即使也含網路特徵(unable to access 亦涵蓋 401/403/404/憑證錯誤; RPC failed 亦可伴隨 GH013)不重試(第 5 次外審 sol F12)
const RE_PUSH_NOT_TRANSIENT = /returned error:\s*(?:401|403|404|407)|Authentication failed|Permission (?:to .+ )?denied|SSL certificate problem|certificate verify failed|UNTRUSTED_ROOT|GH\d{3}|Invalid username or password|Repository not found|access denied/i


/**
 * 判斷 git push 之失敗是否為網路類而值得重試(純函式; 帳本 R26.1)
 *
 * 比對 err.message(ectScripts 之失敗訊息尾端附 git 之輸出, 故 stderr 之 fatal: 行可見); 逾時(R18)一律否——60 分鐘逾時不屬網路暫時性失敗, 且重試會使單列最壞達 181 分鐘.
 *
 * @param {*} err 輸入 push 失敗之錯誤(Error 或字串)
 * @returns {Boolean} 回傳是否為網路類失敗; null、undefined、無訊息者為 false
 */
function isNetworkPushError(err) {
    if (err === null || err === undefined || isTimeoutMessage(err)) {
        return false
    }
    let s = err instanceof Error ? err.message : String(err)
    //只看 git 的輸出部分(首行 `[套件] git指令失敗(摘要): 指令` 之後): 首行回顯指令文字, 路徑或參數含特徵字樣的 spawn 失敗不得被誤判為網路失敗而重試(第 5 次外審 sol F12)
    let i = s.indexOf('\n')
    if (i < 0) {
        return false
    }
    let out = s.slice(i + 1)
    return RE_PUSH_NETWORK_ERROR.test(out) && !RE_PUSH_NOT_TRANSIENT.test(out)
}

/**
 * 重試時之顯示訊息(純函式)
 *
 * 不可含守望器比對之致命字樣(清單見 src/fatalWords.mjs 之 FATAL_WORDS), 否則可自癒之重試會被誤當中止; 失敗之輸出已於上方即時印出.
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
 * @param {Function} [opt.shouldRetry=null] 輸入判斷此錯誤是否值得重試之函數, 傳入(錯誤), 回傳 false 即不重試並 throw 該錯誤; 未給一律重試(逾時不重試, 帳本 R9)
 * @returns {Promise} 回傳 Promise, resolve 回傳 fn 之結果
 */
async function runWithRetry(fn, opt = {}) {
    let times = _.get(opt, 'times', 0)
    let delayMs = _.get(opt, 'delayMs', 0)
    let onRetry = _.get(opt, 'onRetry', null)
    let shouldRetry = _.get(opt, 'shouldRetry', null)
    for (let i = 0; ; i++) {
        try {
            return await fn()
        }
        catch (err) {
            if (i >= times || (_.isFunction(shouldRetry) && !shouldRetry(err))) {
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
 * 目標存在時遞迴移除, 遇暫時占用(RM_RETRY_CODES: EBUSY、EPERM、ENOTEMPTY、EACCES)於預算內自行重試(預設 RM_RETRIES 次 × RM_DELAY_MS), 移除後回驗確實不存在(帳本 R14).
 * 不使用 fs.rmSync 之 maxRetries/retryDelay: Windows+Node 24.19 對 EPERM 不重試(0~1ms 即拋); 也不用 fs.promises.rm: 其重試不受 maxRetries 約束而無界(永久占用時 122 秒才返回). 兩者皆實測.
 * 失敗訊息只用已知之絕對路徑、err.code、err.syscall: Windows 下 rmSync 之 err.message 與 err.path 含非 ASCII 路徑(如「開源」)之亂碼.
 * 目標須為套件內之相對路徑(見 isSafeRmTarget), 解析後須位於套件資料夾之內且不等於套件資料夾本身.
 * 存在判斷與回驗用 lstat(不跟隨連結; 懸空 junction 屬存在, 帳本 R14.10); 目標之祖先經連結逸出套件(父資料夾實體路徑不在套件實體路徑內)時拒絕且不刪任何東西(R14.9);
 * 目標本身為連結時只移除連結本身, 連結指向之內容不動.
 *
 * @param {String} pathPkg 輸入套件資料夾路徑字串
 * @param {String} target 輸入目標相對路徑字串
 * @param {Object} [opt={}] 輸入設定物件(供測試注入, 未給用預設)
 * @param {Number} [opt.retries=RM_RETRIES] 輸入重試次數
 * @param {Number} [opt.delayMs=RM_DELAY_MS] 輸入每次重試前等待毫秒數
 * @param {Function} [opt.rm] 輸入刪除函數, 傳入目標絕對路徑, 失敗須拋出帶 code 之錯誤, 預設 fs.rmSync(fp, { recursive: true, force: true })
 * @param {Function} [opt.sleep] 輸入同步等待函數, 傳入毫秒數, 預設 Atomics.wait
 * @param {Function} [opt.realpath] 輸入解析實體路徑之函數, 傳入路徑字串, 預設 fs.realpathSync.native
 * @returns {Object} 回傳 { state, path, retried }, state 為'removed'(已移除)或'absent'(不存在而略過), path 為目標絕對路徑, retried 為重試次數
 */
function removeTarget(pathPkg, target, opt = {}) {

    //測試環境下只可作用於 test/_tmp 內之 fixture(帳本 R25.2; 第 5 次外審 opus F07: 寫/刪類匯出函式與唯讀的 checkGitStatus 有守衛不對稱)
    assertConfinedToTestTmp('removeTarget', pathPkg)

    let retries = _.isFinite(_.get(opt, 'retries')) ? opt.retries : RM_RETRIES
    let delayMs = _.isFinite(_.get(opt, 'delayMs')) ? opt.delayMs : RM_DELAY_MS
    let rm = _.isFunction(_.get(opt, 'rm')) ? opt.rm : (fp) => fs.rmSync(fp, { recursive: true, force: true })
    let sleep = _.isFunction(_.get(opt, 'sleep')) ? opt.sleep : sleepSync
    let realpath = _.isFunction(_.get(opt, 'realpath')) ? opt.realpath : fs.realpathSync.native

    let root = path.resolve(pathPkg)
    let fp = path.resolve(root, String(target))
    if (!isSafeRmTarget(target) || fp === root || !fp.startsWith(root + path.sep)) {
        throw new Error(`rm指令失敗: 目標須為套件內之相對路徑[${target}]`)
    }

    //存在判斷用lstat(目錄項是否存在), 不跟隨連結: existsSync對懸空junction回false, 會誤回報absent而留下連結(R14.10)
    let lexists = (p) => {
        try {
            fs.lstatSync(p)
            return true
        }
        catch (err) {
            return !(_.get(err, 'code') === 'ENOENT' || _.get(err, 'code') === 'ENOTDIR')
        }
    }

    if (!lexists(fp)) {
        return { state: 'absent', path: fp, retried: 0 }
    }

    //目標之祖先經連結逸出套件時拒絕(R14.9): 父資料夾之實體路徑須位於套件資料夾之實體路徑內; 目標本身為連結時不跟隨(只移除連結)
    //比對用realpathSync.native(JS版保留輸入大小寫), Windows下不分大小寫
    let low = (s) => (process.platform === 'win32' ? s.toLowerCase() : s)
    let realRoot = ''
    let realParent = ''
    try {
        realRoot = low(realpath(root))
        realParent = low(realpath(path.dirname(fp)))
    }
    catch (err) {
        throw new Error(`rm指令失敗: 無法確認目標位置[${fp}]: ${_.get(err, 'code') || 'ERR'}`) //只引err.code(同R14.4)
    }
    if (realParent !== realRoot && !realParent.startsWith(realRoot + low(path.sep))) {
        throw new Error(`rm指令失敗: 目標經連結位於套件外[${fp}]`)
    }

    let last = null
    let retried = 0
    for (let i = 0; i <= retries; i++) {
        if (i > 0) {
            retried++
            sleep(delayMs)
        }
        try {
            rm(fp)
            last = null
            break
        }
        catch (err) {
            last = err
            if (!RM_RETRY_CODES.has(_.get(err, 'code'))) {
                break //非暫時性錯誤碼不重試
            }
        }
    }
    if (last !== null) {
        let code = _.get(last, 'code') || 'ERR'
        let syscall = _.get(last, 'syscall') ? `(${last.syscall})` : ''
        throw new Error(`rm指令失敗: 無法移除[${fp}]: ${code}${syscall}, 已重試${retried}次(間隔${delayMs}ms); 目標可能已部分刪除, 請先釋放占用該資料夾之程式(終端機、編輯器、檔案總管)`)
    }

    //回驗(同樣用lstat, 不跟隨連結)
    if (lexists(fp)) {
        throw new Error(`rm指令失敗: 移除後仍存在[${fp}]`)
    }

    return { state: 'removed', path: fp, retried }
}


/**
 * 判定 dist 閘門(純函式; 帳本 R10): 輸入 git status --porcelain -- dist 之輸出, 不執行 git
 *
 * 有刪除(D, 含 AD: 曾 staged 後又被刪)且完全無產出(??新檔、M修改、A新增)=建置失敗空殼(殷鑑 w-highcharts: 僅 2 行 D 零產出);
 * hash 檔名 rebuild(舊 hash 刪+新 hash 增, 如 w-web-api)有產出不誤擋.
 *
 * @param {String} [porcelain=''] 輸入 git status --porcelain -- dist 之輸出字串
 * @returns {Object} 回傳 { dels, outs, fatal }, dels 為刪除行陣列, outs 為其餘行陣列, fatal 為是否應中止
 */
function judgeDistStatus(porcelain = '') {
    let lns = _.filter(_.split(String(porcelain), '\n'), (s) => _.trim(s) !== '')
    let dels = _.filter(lns, (s) => _.trim(s).slice(0, 2).indexOf('D') >= 0) //遭刪除(含AD)
    let outs = _.filter(lns, (s) => _.trim(s).slice(0, 2).indexOf('D') < 0) //有產出(??新檔, M修改, A新增)
    return { dels, outs, fatal: _.size(dels) > 0 && _.size(outs) === 0 }
}


/**
 * 建置主檔閘門(帳本 R17): 檢查 package.json 之 main、module、browser(僅字串值)與 exports(所有以 ./ 開頭、不含 * 之字串目標)所指檔是否存在、為檔案、非空; 位於 dist/ 內者另比對 mtime 是否於本輪重寫
 *
 * 存在、為檔案、非空為硬閘(fatal); mtime 早於起點(減容差)只留痕(warn), 第一輪實跑確認 0 誤判後再議升硬閘.
 * main、module、browser 比照 Node 解析入口(R17.8): 字面檔不存在時依序補 .js、.json、.node、.mjs、.cjs, 為資料夾時試其 index.js、index.json、index.node; exports 為精確路徑不補(R17.9).
 * 三欄位與 exports 皆無(w-package-tools、w-package-tools-e2e、w-demores)、欄位值非字串(browser 物件)者略過; 指向套件外者(以路徑段判定, R17.4)留痕略過.
 * 不執行任何指令, 只讀檔案系統.
 *
 * @param {String} pathPkg 輸入套件資料夾路徑字串
 * @param {Object} [opt={}] 輸入設定物件
 * @param {Number} [opt.startMs] 輸入本輪起點(毫秒時間戳), 未給則不比對 mtime
 * @param {Number} [opt.slackMs=2000] 輸入 mtime 比對之容差毫秒數
 * @returns {Object} 回傳 { fatal, warn }, 皆為字串陣列(不含套件名前綴與「建置主檔異常」「主檔留痕」前綴, 由 runScript 加上)
 */
function checkMainFiles(pathPkg, opt = {}) {
    let startMs = _.get(opt, 'startMs')
    let slackMs = _.isFinite(_.get(opt, 'slackMs')) ? opt.slackMs : 2000
    let fatal = []
    let warn = []

    let root = path.resolve(pathPkg)
    let o
    try {
        o = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8').replace(/^﻿/, ''))
    }
    catch (err) {
        fatal.push(`package.json 無法讀取(${_.get(err, 'code') || _.get(err, 'name') || 'ERR'})`)
        return { fatal, warn }
    }

    let statOrNull = (p) => {
        try {
            return fs.statSync(p)
        }
        catch (err) {
            return null
        }
    }

    //入口解析比照Node(R17.8; tryFile → tryExtensions → index): 字面為檔案直接用; 否則(不存在或為資料夾)依序補副檔名; 資料夾再試其index; 回傳 { fp, st }, st 為 null 表不存在
    let resolveEntry = (fp) => {
        let st = statOrNull(fp)
        if (st !== null && st.isFile()) {
            return { fp, st }
        }
        for (let ext of MAIN_EXTS) {
            let s = statOrNull(fp + ext)
            if (s !== null && s.isFile()) {
                return { fp: fp + ext, st: s }
            }
        }
        if (st !== null && st.isDirectory()) {
            for (let name of MAIN_INDEXES) {
                let s = statOrNull(path.join(fp, name))
                if (s !== null && s.isFile()) {
                    return { fp: path.join(fp, name), st: s }
                }
            }
        }
        return { fp, st }
    }

    //檢查單一入口: label 為欄位名(main、module、browser、exports), v 為欄位值字串, probe 表示是否比照Node補副檔名與index(exports 為精確路徑, 不補)
    let checkOne = (label, v, probe) => {
        let fp = path.resolve(root, v)
        let rel = path.relative(root, fp)
        //套件外以路徑段判定(R17.4補): 僅'..'或以'..'加分隔符起頭者為向外, '..cache/x.js'之類以兩個點開頭的普通名稱屬套件內
        if (rel === '' || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) {
            warn.push(`${label}[${v}]主檔路徑不在套件內, 略過`)
            return
        }
        let relDisp = rel.replace(/\\/g, '/')
        let r = probe ? resolveEntry(fp) : { fp, st: statOrNull(fp) }
        if (r.st === null) {
            fatal.push(`${label}[${relDisp}]不存在`)
            return
        }
        if (!r.st.isFile()) {
            fatal.push(`${label}[${relDisp}]不是檔案`)
            return
        }
        if (r.st.size === 0) {
            fatal.push(`${label}[${relDisp}]為空檔`)
            return
        }
        let relRes = path.relative(root, r.fp).replace(/\\/g, '/')
        if (_.isFinite(startMs) && w.strleft(relRes, 5) === 'dist/' && r.st.mtimeMs < startMs - slackMs) {
            warn.push(`${label}[${relDisp}]未於本輪重寫(mtime 早於本輪起點)`)
        }
    }

    _.each(['main', 'module', 'browser'], (field) => {
        let v = _.get(o, field)
        if (!w.isestr(v)) {
            return true //無此欄位或非字串(如 browser 為物件)
        }
        checkOne(field, v, true)
    })

    //exports(R17.9): 取所有以 ./ 開頭、不含 * 之字串目標(含子路徑與條件巢狀、陣列; types、typings 條件不算), 各須存在、為檔案、非空(精確路徑)
    let targets = []
    let collect = (x) => {
        if (w.isestr(x)) {
            targets.push(x)
        }
        else if (_.isArray(x)) {
            _.each(x, collect)
        }
        else if (_.isPlainObject(x)) {
            _.each(x, (e, k) => {
                if (k !== 'types' && k !== 'typings') {
                    collect(e)
                }
            })
        }
    }
    collect(_.get(o, 'exports'))
    _.each(_.uniq(targets), (t) => {
        if (w.strleft(t, 2) === './' && t.indexOf('*') < 0) {
            checkOne('exports', t, false)
        }
    })

    return { fatal, warn }
}


/**
 * 讀取套件 package.json 之 version 字串
 *
 * @param {String} pathPkg 輸入套件資料夾路徑字串
 * @returns {String} 回傳 version 字串
 */
function readVersion(pathPkg) {
    let j = fs.readFileSync(path.resolve(pathPkg, 'package.json'), 'utf8')
    return w.j2o(j).version
}


async function runScript(pdi, msg = 'update pks', opt = {}) {
    // pdi {
    //   name: 'w-serv-broadcast',
    //   path: 'D:\\- 006 -        開源\\開源-JS-007-4-w-serv-broadcast/w-serv-broadcast',
    //   version: '1.0.17',
    //   update: true,
    //   dependencies: [],
    //   devDependencies: [ { name: 'w-converhp', verOld: '^2.0.17', verNew: '^2.0.18' } ]
    // }

    //注入點(僅供測試, 未給用正式實作; 見帳本1.5): exec取代ectScripts, checkNpm取代checkNpmVersion, gitStatusDist取代dist閘門之git status, nowMs取代Date.now, checkRelease=false略過必要列與版本遞增檢查(R20), retryDelayMs縮短deploy重試間隔(R9)
    //  例外: opt.onRemote為正式路徑使用(publishPackage傳入, 帳本R21.3), 於第一個遠端列(git push、deploy、publish; git add/commit不算)通過全部閘門後、exec之前呼叫一次
    //  opt.registryConfig({ main, mirrors })與opt.onMirrorResult亦為正式路徑使用(publishPackage傳入, 帳本R27): 主倉庫經環境變數套用於每個exec並供最終閘門查詢, 鏡像於主發布列成功後逐一發布
    //  opt.onRemoteRevoke同為正式路徑使用(publishPackage傳入, 帳本R26.2): 第一個遠端列為git列且第一次嘗試即spawn失敗(git根本沒執行)時, 於throw前呼叫一次, 撤回『已交出遠端列』旗標
    //測試環境下未注入 exec 即 throw, 於 loadScript、rm -r 等任何副作用之前(帳本 R25); 預設 checkNpm(網路)與 gitStatusDist(git)於被使用時才擋
    requireInjected('runScript', opt, ['exec'])
    assertConfinedToTestTmp('runScript', _.get(pdi, 'path')) //測試環境下套件路徑須在 test/_tmp 內, rm -r 等本機動作只作用於測試 fixture
    let exec = _.isFunction(_.get(opt, 'exec')) ? opt.exec : ectScripts
    let checkNpm = _.isFunction(_.get(opt, 'checkNpm')) ? opt.checkNpm : (...args) => {
        assertRealExecAllowed('runScript.checkNpm', '使用了真實預設實作 checkNpmVersion(網路)')
        return checkNpmVersion(...args)
    }
    let gitStatusDist = _.isFunction(_.get(opt, 'gitStatusDist')) ? opt.gitStatusDist : (cwd) => {
        assertRealExecAllowed('runScript.gitStatusDist', '使用了真實預設實作 git status')
        return cp.execSync('git status --porcelain -- dist', { cwd }).toString()
    }
    let nowMs = _.isFunction(_.get(opt, 'nowMs')) ? opt.nowMs : Date.now
    let checkRelease = _.get(opt, 'checkRelease', true) !== false

    //倉庫設定(帳本R27, publishPackage傳入, 正式路徑使用): registryConfig.main為主倉庫, 每個exec都帶registry使該列內所有npm子行程以主倉庫為準(npm_config_registry), 並供最終閘門查主倉庫;
    //registryConfig.mirrors為同時發布之鏡像, 主倉庫之npm publish成功後逐一發布(鏡像失敗只警告, onMirrorResult收集結果); 未給registryConfig(僅測試)則不設環境變數、不發鏡像, 最終閘門由checkNpm自行要求registry
    let regMain = ''
    let regMirrors = []
    if (_.get(opt, 'registryConfig.main')) {
        regMain = normalizeRegistryUrl(opt.registryConfig.main)
        regMirrors = _.map(_.get(opt, 'registryConfig.mirrors', []), (x) => normalizeRegistryUrl(x))
    }
    let execOpt = (o) => (regMain !== '' ? { ...o, registry: regMain } : o)

    //執行前檢查全部列: 有非預期指令或缺必要列即於第一列之前中止, 不在addVersion等改動之後才中止
    let lines = loadScript(pdi, msg, { checkRelease })
    console.log('scps', _.map(lines, 'raw'))

    let startMs = nowMs() //本輪起點: 主檔閘門比對mtime用(R17.2)
    let versionStart = checkRelease ? readVersion(pdi.path) : '' //起跑時版本: 首個對外列之前要求已遞增(R20.2)

    let bCheckDist = false //首個對外git列前檢查建置產物之旗標(R10)
    let bCheckVersion = false //版本遞增檢查只在首個對外列之前執行一次(R20.2)
    let nOutward = 0 //已通過閘門之對外列數
    let warnPrinted = new Set() //主檔留痕整個runScript同一則只印一次(R17.10)

    //版本閘門(R20.2): 首個對外列之前版本須已遞增, 否則addVersion列未生效, git push、deploy、publish會帶舊版號發生, 最終閘門又只會查到舊版(必在npm上)而判成功; 通過後不再重查
    let gateVersion = () => {
        if (!checkRelease || bCheckVersion) {
            return
        }
        bCheckVersion = true
        let versionNow = readVersion(pdi.path)
        if (versionNow === versionStart) {
            throw new Error(`[${pdi.name}] 版本未遞增(起跑[${versionStart}]、結束[${versionNow}]): addVersion 列未生效, 最終閘門只會查到舊版`)
        }
    }

    //建置主檔閘門(R17.1): 每個對外列之前都重新檢查(其間可能有rm -r dist之類的列清掉主檔); 留痕只印新出現者(R17.10)
    let gateMain = () => {
        let r = checkMainFiles(pdi.path, { startMs })
        _.each(r.warn, (s) => {
            if (!warnPrinted.has(s)) {
                warnPrinted.add(s)
                console.log(`[${pdi.name}] 主檔留痕: ${s}`)
            }
        })
        if (_.size(r.fatal) > 0) {
            throw new Error(`[${pdi.name}] 建置主檔異常: ${_.join(r.fatal, '; ')}`)
        }
    }

    //對外列(非唯讀git、npm run deploy、npm publish)執行前之閘門: 先版本(R20.2), 再主檔(R17.1)
    let gateOutward = () => {
        nOutward++
        gateVersion()
        gateMain()
    }

    //通知呼叫端「第一個遠端列(git push、npm run deploy、npm publish等; 本機git add/commit不算)即將交給exec」(R21.3): 須在該列全部閘門通過後、緊鄰exec之前呼叫(其間不得有可能throw的程式)
    //  呼叫端(publishPackage)據此區分失敗發生在遠端列之前(可還原package.json與lock)或之後(不還原); 只通知一次, 閘門失敗時不通知
    //回傳此次呼叫是否為「第一個遠端列」(旗標由此翻轉): git 分支據此在第一次嘗試即 spawn 失敗時撤回(R26.2)
    let bRemote = false
    let notifyRemote = (v) => {
        if (bRemote || !isRemoteCmd(v)) {
            return false
        }
        bRemote = true
        if (_.isFunction(_.get(opt, 'onRemote'))) {
            opt.onRemote()
        }
        return true
    }

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
            let msg = await exec(pdi, v, execOpt({ main: 'node' })) //main='node'使node指令失敗(離開碼非0、程序無法啟動、輸出含[RollupError]、離開碼0但輸出含錯誤堆疊或固定建置失敗字串)於ectScripts內立即throw
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
            let msg = await (regMain !== '' ? exec(pdi, v, execOpt({})) : exec(pdi, v)) //不判定成敗(逾時除外, R18): jsdoc有ERROR時exit 1但文件照常產出; 有拒絕值時ectScripts只留痕一行(未判定(...))
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

            //唯讀git查詢(status、diff、log等)不是對外列, 不觸發任何閘門(R17.1、R10, 外審F07)
            if (isOutwardCmd(v)) {

                //首個對外git列前檢查dist內有無[已被刪除且未重建]之git追蹤檔(建置失敗徵兆: cleanFolder刪除後建置未重建, git狀態為D; 殷鑑w-highcharts空殼上架), 有即中止避免push/publish空殼
                //判準見judgeDistStatus(帳本R10); 此閘門只攔[全部建置失敗之空殼], 主檔缺失/為空由其後之gateMain攔(R17)
                if (!bCheckDist) {
                    bCheckDist = true
                    let rd = ''
                    try {
                        rd = gitStatusDist(pdi.path)
                    }
                    catch (e) {
                        if (isTestGuardError(e)) {
                            throw e //測試環境守衛(R25)不得被下方『其他例外跳過檢查』吞掉
                        }
                        //git status自身以exit>=128結束(非git倉庫、dubious ownership、index毀損等fatal:類): 其後的git add必同樣128, 於遠端列之前中止使R21還原(外審opus F5; 帳本R10、R6)
                        let st = _.get(e, 'status')
                        if (_.isFinite(st) && st >= GIT_FATAL_EXIT_CODE) {
                            let se = ''
                            try {
                                se = String(_.get(e, 'stderr', '')).trim()
                            }
                            catch (e2) {}
                            throw new Error(`[${pdi.name}] git指令失敗(code[${st}]): git status --porcelain -- dist${se !== '' ? `\n${se}` : ''}`)
                        }
                        rd = '' //其他例外(status為null之無法啟動、小於128)跳過檢查
                    }
                    let jd = judgeDistStatus(rd)
                    if (jd.fatal) {
                        throw new Error(`[${pdi.name}] 建置產物遭刪除且無任何產出:\n${_.join(jd.dels, '\n')}\n中止git與publish`)
                    }
                }

                gateOutward() //版本(R20.2)與建置主檔(R17.1)閘門: 每個對外列之前
            }

            console.log(`${pdi.name} >>> exec: `, v)
            let bFirstRemote = notifyRemote(v) //第一個遠端列(git push等)交出前通知(R21.3); git add、git commit、唯讀git不通知
            let nTry = 0 //git 列已嘗試次數(R26.2: 只有第一次嘗試即 spawn 失敗才撤回)
            let msg
            try {
                msg = await runWithRetry(() => {
                    nTry++
                    return exec(pdi, v, execOpt({ main: 'git' })) //main='git'使ectScripts依子命令判定(R6.2): spawn與離開碼>=128一律throw; push及未列入白名單之子命令任何非0throw; commit僅含nothing to commit之exit 1良性(D1); add與唯讀子命令其餘良性, 只留痕一行(未判定(...), R13)
                }, {
                    ...getRetryPolicy(v), //git push 失敗重試2次、間隔30秒(R26.1), 其他 git 列不重試
                    ...(_.isFinite(_.get(opt, 'retryDelayMs')) ? { delayMs: opt.retryDelayMs } : {}), //opt.retryDelayMs僅供測試縮短間隔
                    shouldRetry: (err) => isNetworkPushError(err), //只有網路類失敗才重試; 被拒、認證、index.lock、逾時、spawn 皆不重試(R26.1)
                    onRetry: (k, n, err) => {
                        console.log(getRetryMessage(pdi.name, v, k, n)) //訊息不含致命字樣, 避免守望器誤當中止
                    },
                })
            }
            catch (err) {
                //R26.2: 第一個遠端列於第一次嘗試即 spawn 失敗(PowerShell/git 根本沒執行)→ 遠端確定未動, 撤回『已交出遠端列』旗標使 publishPackage 照常還原; 已執行過 git(重試中)或非 spawn 失敗不撤回
                if (bFirstRemote && nTry === 1 && /^(?:Error: )?\[[^\]\n]+\] git指令失敗\(spawn\[/.test(String(_.get(err, 'message', err))) && _.isFunction(_.get(opt, 'onRemoteRevoke'))) {
                    opt.onRemoteRevoke()
                }
                throw err
            }
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
            if (isOutwardCmd(v)) {
                gateOutward() //對外列(R17.1、R20.2): 無git列之script亦於deploy、publish之前檢查版本與建置主檔; 指令後可接參數
            }
            console.log(`${pdi.name} >>> exec: `, v)
            notifyRemote(v) //第一個遠端列(npm run deploy、npm publish)交出前通知(R21.3)
            let msg = await runWithRetry(() => {
                return exec(pdi, v, execOpt({ main: 'npm' })) //main='npm'使npm指令失敗(輸出含npm error, 或離開碼非0、程序無法啟動、逾時)於ectScripts內立即throw
            }, {
                ...getRetryPolicy(v), //npm run deploy(後可接參數)失敗重試2次、間隔30秒, 其他不重試
                ...(_.isFinite(_.get(opt, 'retryDelayMs')) ? { delayMs: opt.retryDelayMs } : {}), //opt.retryDelayMs僅供測試縮短間隔(R9)
                shouldRetry: (err) => !isTimeoutMessage(err) && !isTestGuardError(err), //逾時不重試(R9): 60分鐘逾時不屬網路暫時性失敗, 重試會使單列最壞達181分鐘; 測試環境守衛錯誤(R25)不重試
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

            //同時發布(帳本R27.4): 主倉庫之npm publish成功後(失敗已於上方throw)才對每個鏡像發布; 鏡像列緊接於主發布列之後、屬同一個對外列的延伸, 每個鏡像發布前仍重過對外列閘門(版本與建置主檔, 失敗記為該鏡像未同步而不發布);
            //鏡像失敗不throw(不使套件失敗、不中止連動), 由onMirrorResult收集並於結束摘要列出; 主發布列已通知過遠端(notifyRemote), 鏡像不改變還原邊界(R21)
            if (isPublishCmd(v) && _.size(regMirrors) > 0) {
                let vPub = readVersion(pdi.path) //主倉庫剛發布之版本; 版本閘門(R20.2)只在首個對外列前查一次, 鏡像之間改以此值重驗(npm lifecycle 可能改動 package.json)
                let gateMirror = () => {
                    gateOutward()
                    let vNow = readVersion(pdi.path)
                    if (vNow !== vPub) {
                        throw new Error(`[${pdi.name}] 版本於鏡像發布期間改變(主倉庫發布[${vPub}]、現在[${vNow}]), 鏡像不發布`)
                    }
                }
                await publishToMirrors({ pdi, version: vPub, v, mirrors: regMirrors, exec, gate: gateMirror, onResult: _.get(opt, 'onMirrorResult') })
            }
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
                if (isTestGuardError(err)) {
                    throw err //守衛錯誤原樣重拋(重包會丟失標記, 帳本 R25.2)
                }
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

    //全無對外列(非唯讀git、npm run deploy、npm publish)時於所有列之後、最終閘門之前補執行版本與建置主檔閘門(R17.1、R20.2後備)
    if (nOutward === 0) {
        gateVersion()
        gateMain()
    }

    //偵測主倉庫, 確認套件已能取得與安裝
    if (true) {

        let versionNew = readVersion(pdi.path)

        let b = regMain !== '' ? await checkNpm(pdi.name, versionNew, { registry: regMain }) : await checkNpm(pdi.name, versionNew) //查主倉庫(帳本R27.3); 鏡像不列入等待條件

        if (!b) {
            throw new Error(`npm上找不到[${pdi.name}@${versionNew}]`) //(字樣為守望器致命字樣, 不變; 實際查的是主倉庫)須用versionNew(addVersion已bump), pdi.version為掃描時舊版號會誤導
        }

    }

    // console.log('runScript finish')
}


export {
    RM_RETRIES,
    RM_DELAY_MS,
    RM_RETRY_CODES,
    isSafeRmTarget,
    hasNpmRegistryOverride,
    getPublishTargetIssue,
    hasShellControl,
    isReadonlyGitCmd,
    isLocalGitCmd,
    isRemoteCmd,
    isDeployCmd,
    isPublishCmd,
    isAddVersionCmd,
    isOutwardCmd,
    classifyLine,
    parseScript,
    loadScript,
    getRetryPolicy,
    getRetryMessage,
    runWithRetry,
    isPushCmd,
    isNetworkPushError,
    parseNpmCmd,
    removeTarget,
    judgeDistStatus,
    checkMainFiles
}
export default runScript
