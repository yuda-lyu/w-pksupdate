import { stripVTControlCharacters } from 'node:util'
import _ from 'lodash-es'
import w from 'wsemi'
import execProcess from 'wsemi/src/execProcess.mjs'
import { neutralizeFatal } from './fatalWords.mjs'
import { assertRealExecAllowed } from './testGuard.mjs'
import { GIT_LENIENT_SUBS, getGitSubcommand } from './gitSubcommand.mjs'


/**
 * 每次呼叫 ectScripts 之預設逾時毫秒數(帳本 R18): 60 分鐘.
 * 逾時由 execProcess 殺整棵程序樹並 reject 'timeout[Nms]:…', 一律視為失敗(見 judgeResult).
 * 為上限而非預期耗時; checkNpmVersion 之等待不經 ectScripts, 不受此限.
 */
const DEFAULT_TIMEOUT_MS = 3600000

/**
 * 逾時後等 execProcess 落定之寬限毫秒數(帳本 R18.6): 30 秒.
 * execProcess 殺程序樹後須等子程序輸出管道關閉才落定; 孫程序孤兒持有管道或殺樹失敗時可能遲遲不落定甚至不落定,
 * 逾 timeoutMs + 寬限仍未落定即判逾時失敗並不再等待.
 */
const TIMEOUT_GRACE_MS = 30000

//git 列離開碼達此值(含)以上判失敗(帳本 R6): git 的 fatal: 類錯誤(index.lock 殘留、認證/網路失敗、非倉庫)一律 exit 128
const GIT_FATAL_EXIT_CODE = 128

//git commit 無變更時之 stdout 片語(英文; 本機 git 輸出為英文, 帳本 R6.6③): commit 的 exit 1 僅含其中之一時良性
//2026-10-17 主控 D1: 只接受 nothing to commit; 'nothing added to commit'(有未追蹤檔)、'no changes added to commit'(有變更但未暫存)代表前一列 git add 沒暫存到變更, 續行會發布出無對應遠端 commit 之版本, 判失敗
//第 5 次外審(opus F11、sol F11)再收斂: 原以子字串比對, hook 診斷文字、引述、否定句含該字樣即被判良性而續行 push/publish; 改為整行比對 git 的兩種無變更結論
//('nothing to commit, working tree clean'、'nothing to commit (create/copy files and use "git add" to track)'); '(use -u to show untracked files)' 變體(status.showUntrackedFiles=no, git 看不到未追蹤檔)不算
const RE_GIT_NO_CHANGE = /^nothing to commit(?:, working tree clean| \(create\/copy files and use "git add" to track\))[ \t]*\r?$/m

//離開碼 0 時視為建置失敗之固定字串(帳本 R15.2): w-package-tools 1.1.20 之清空失敗與全部 Promise.reject(<字串>), 無堆疊可供結構判定; 依序比對, 先命中者決定 detail
//此清單隨 w-package-tools 新增訊息而過時, 屬已知限制(R15.7); 根治靠其改以 Error 物件拒絕
const PRINTED_FAIL_STRINGS = [
    'can not clean folder[',
    'invalid fpSrc',
    'invalid opt.fdSrc[',
    'invalid opt.fdTar[',
    'invalid opt.',
    'opt.fpSrc is not file',
    'opt.funNames[',
    'opt.evNames only supports',
    'opt.type need to set',
    'formatOut[iife] only supports runin[browser]',
    '] has no default export, type[function]',
    '] has no export, type[object]',
    'inner of worker[',
    'cb is not a function, need to set opt.returnResult',
    'return-code mode of rollupFile can not output',
]

//錯誤堆疊框行(帳本 R15.1): '    at fn (位置:行:欄)'、'    at async 位置:行:欄'; 位置須像路徑或網址(scheme://、node:、磁碟機代號、/、./、../、\\\\ UNC、<anonymous>),
//故 '    at the end of the build 12:30:45' 之類時間戳行不算. 函式名部分允許至多三層巢狀括號(eval 框: 'at eval (eval at <anonymous> (file:///…:1:32), <anonymous>:1:7)');
//'[^()]*' 使函式名部分不與後面的 '.*' 重疊, '{0,3}' 使病態長行(大量 ' (')不致平方級退化.
const RE_STACK_FRAME = /^[ \t]+at[ \t]+(?:async[ \t]+)?(?:[^()]*\(){0,3}(?:[A-Za-z][A-Za-z0-9+.-]*:\/\/|node:|[A-Za-z]:[\\/]|\/|\.{1,2}[\\/]|\\\\|<anonymous>).*:\d+:\d+\)?[ \t]*$/

//診斷輸出之標頭行(帳本 R15.5): console.trace()('Trace: 訊息'或單獨一行 'Trace')與 Node 行程警告('(node:<pid>) …', --trace-warnings、--trace-deprecation 下其後附堆疊);
//緊接在此類標頭之後的堆疊框屬診斷而非失敗. 'Error: …' 標頭(被印出之 Error 物件)不在此列.
//'(node:<pid>) …'僅限良性警告: 含 UnhandledPromiseRejection 者(--unhandled-rejections=warn 下未處理的建置失敗, exit 0)不豁免(第二輪 N1); 另含非 Node 的'Warning:'標頭(如 bluebird)
const RE_DIAG_HEAD = /^(?:Trace(?::.*)?|Warning:.*|\(node:\d+\)(?!.*UnhandledPromiseRejection).*)$/

//CSI 序列(含冒號形 SGR, 如 ESC[38:2::255:0:0m): util.stripVTControlCharacters 只認分號形, 冒號形會殘留致使行首不是空白(第二輪 N8), 故先以此去除
const RE_CSI = /\u001b\[[0-9:;?]*[ -/]*[@-~]/g

//逐行比對之長度上限(壓縮碼輸出之超長行不比對)
const MAX_FRAME_LINE_LENGTH = 2000

//逾時錯誤訊息之首行(帳本 R9、R18.5): '[<套件>] <label>(timeout[Nms]): <指令>'; 只認標籤後緊接之 (timeout[…]), 指令文字內含同樣字串者不算
const RE_TIMEOUT_MESSAGE = /^(?:Error: )?\[[^\]\n]+\] [^\n(]*\(timeout\[\d+ms\]\):/

//execProcess 逾時後仍未落定之標記與訊息
const GRACE_EXPIRED = Symbol('graceExpired')
const NOTE_NOT_SETTLED = '逾時後仍未落定, 子程序樹可能未清除'


/**
 * 組出交給 powershell -Command 執行之整行指令(純函式)
 *
 * 組法沿用 GitHub Actions(shell: powershell)與 Azure Pipelines(PowerShell@2 預設)之慣例:
 * 開頭 $ErrorActionPreference = 'Stop', 使切換目錄失敗、找不到指令等 cmdlet 錯誤即中止整行並以離開碼 1 結束, 不會在呼叫端目錄續行後續指令;
 * 結尾 if ((Test-Path -LiteralPath variable:\LASTEXITCODE)) { exit $LASTEXITCODE }, 使最末原生程式之離開碼原樣傳出(否則 PowerShell 一律壓成 0 或 1).
 * 不可改用裸 'exit $LASTEXITCODE': 最末陳述非原生程式時(如找不到指令) $LASTEXITCODE 為 $null, 會以 0 結束而遮蔽失敗.
 * 原生程式寫入 stderr 不會因 Stop 而中止(呼叫端未在 PowerShell 內重導 stderr, 不會被包成 ErrorRecord).
 * 切換目錄用 Set-Location -LiteralPath(不做萬用字元解讀), 路徑置於單引號內(不做變數展開), 單引號本身以兩個單引號跳脫.
 *
 * @param {String} pathPkg 輸入套件資料夾路徑字串
 * @param {String|Array} scps 輸入指令字串或指令陣列, 陣列依序以' ; '串接; 多指令時離開碼只反映最末一個
 * @returns {String} 回傳整行指令字串
 */
function composeCommand(pathPkg, scps) {

    if (!w.isarr(scps)) {
        scps = [scps]
    }

    let pathLiteral = String(pathPkg).replace(/'/g, `''`)

    let args = [
        `$ErrorActionPreference = 'Stop'`,
        `Set-Location -LiteralPath '${pathLiteral}'`,
        // `pwd`, //顯示當前工作路徑會延遲顯示, 故會出現於最末
        ...scps,
        `if ((Test-Path -LiteralPath variable:\\LASTEXITCODE)) { exit $LASTEXITCODE }`,
    ]
    args = _.join(args, ' ; ') //合併為整行指令
    // console.log('args', args)

    return args
}


/**
 * 建立程序輸出之累積器(純函式, 不做任何 I/O)
 *
 * 判定用之 stdout 與 stderr 各自原樣串接, 不插入換行: execProcess 之回呼以讀取塊為單位(約64KB), 若逐塊補換行, 跨塊之判定字樣(如[RollupError]、npm error)會被拆散而漏判;
 * 兩串流亦分開累積, 避免另一串流之塊插在中間而拆散字樣.
 * 顯示與回傳用之文字維持既有格式(兩串流依到達順序合併, 每塊後補換行).
 *
 * @returns {Object} 回傳累積器物件, 含 onStdout(cdata)、onStderr(cdata)、getOut()、getErr()、getDisplay()
 */
function createOutputCollector() {
    let out = ''
    let err = ''
    let display = ''
    return {
        onStdout: (cdata) => {
            out += cdata
            display += cdata + '\n'
        },
        onStderr: (cdata) => {
            err += cdata
            display += cdata + '\n'
        },
        getOut: () => out,
        getErr: () => err,
        getDisplay: () => display,
    }
}


/**
 * 取執行失敗之摘要(純函式): execProcess 之 reject 值首行, 去掉結尾冒號; 程序無法啟動時再接第二行之錯誤說明
 *
 * execProcess(wsemi 1.9.15 起)之 reject 值皆為字串:
 * 離開碼非 0 為'code[N]:\n<子程序輸出>'(因訊號結束時 N 為 null), 逾時為'timeout[Nms]:\n<子程序輸出>', 只取首行(第二行起為子程序輸出, 已見於顯示文字);
 * 程序無法啟動為'spawn[錯誤碼]:\n<node 之錯誤說明>', 說明不含參數(如'spawn powershell ENOENT'), 此時沒有子程序輸出, 故接於首行之後, 使摘要看得出是哪個程式無法啟動.
 * 非字串之 reject 值(如 wsemi 1.9.15 之前之 Error 物件)取 String 後之首行.
 *
 * @param {*} errExec 輸入 execProcess 之 reject 值, 無值為 null 或 undefined
 * @returns {String} 回傳摘要字串, 例如'code[3]'、'timeout[1000ms]'、'spawn[ENOENT] spawn powershell ENOENT', 無值時回傳''
 */
function getExecDetail(errExec) {
    if (errExec === null || errExec === undefined) {
        return ''
    }
    let lines = String(errExec).split('\n')
    let s = lines[0].replace(/:\s*$/, '')
    if (s.startsWith('spawn[') && w.isestr(lines[1])) {
        s = `${s} ${lines[1]}`
    }
    return s
}


/**
 * 取 execProcess 拒絕值首行之離開碼(純函式; 帳本 R6)
 *
 * @param {*} errExec 輸入 execProcess 之 reject 值
 * @returns {Number|null} 回傳離開碼; 拒絕值非字串(成功為 null/undefined、wsemi 1.9.15 之前之 Error 物件)、首行不是 code[整數](訊號結束 code[null]、spawn[…]、timeout[…]、負數)時回傳 null
 */
function getExitCode(errExec) {
    if (typeof errExec !== 'string') {
        return null
    }
    let m = /^code\[(\d+)\](?::|$)/.exec(errExec.split('\n')[0])
    return m === null ? null : Number(m[1])
}


/**
 * 未判定之列有拒絕值時之留痕訊息(純函式)
 *
 * 未判定之列(未給 main 之 .bin 與 g_checkAndCommit, 及 main='git' 而依帳本 R6.2 為良性者: add/其他子命令之 exit 1~127、commit 之無變更 exit 1)不判定成敗(jsdoc 有 ERROR 時 exit 1、git commit 無變更時 exit 1 皆屬良性), 但離開碼非 0 時須留下一行痕跡, 否則 log 只見空白回顯而無從察覺.
 * 只留痕、不中止、不改判定; ectScripts 只在判定未失敗後呼叫(判定為失敗之列改為 throw).
 * 訊息不可含守望器比對之致命字樣(見 src/fatalWords.mjs 之 FATAL_WORDS), 否則良性之 exit 1 會被誤當中止.
 *
 * @param {Object} [p={}] 輸入資料物件
 * @param {String} [p.name=''] 輸入套件名稱字串
 * @param {*} [p.errExec=null] 輸入 execProcess 之 reject 值, 成功為 null
 * @param {String|Array} [p.scps=[]] 輸入指令字串或指令陣列, 陣列依序以' ; '串接
 * @returns {String} 回傳留痕訊息字串, 例如'[w-gis] 未判定(code[1]): ./node_modules/.bin/jsdoc -c .jsdoc', 無拒絕值時回傳''
 */
function getUnjudgedMessage({ name = '', errExec = null, scps = [] } = {}) {
    if (errExec === null || errExec === undefined) {
        return ''
    }
    if (!w.isarr(scps)) {
        scps = [scps]
    }
    //指令與摘要為外來文字(如 commit 訊息談到'git指令失敗'), 整行中和致命字樣後才輸出, 避免良性留痕被守望器誤當中止(外審 sol F3; 同 R19.4)
    return neutralizeFatal(`[${name}] 未判定(${getExecDetail(errExec)}): ${_.join(scps, ' ; ')}`)
}


/**
 * 判斷一段文字是否含不在診斷標頭之後的錯誤堆疊框行(純函式; 帳本 R15.1、R15.5)
 *
 * 逐行比對: 超長行(壓縮碼輸出)略過, 不改變豁免狀態; 標頭行(Trace、(node:pid))開啟豁免, 緊接其後的堆疊框行不判;
 * 遇到標頭與堆疊框以外的任何行(含空行)即結束豁免.
 *
 * @param {String} text 輸入已去控制碼之單一串流文字
 * @returns {Boolean} 回傳是否含應判為失敗的堆疊框行
 */
function hasStackFrame(text) {
    let exempt = false
    for (let ln of text.split(/\r?\n/)) {
        if (ln.length > MAX_FRAME_LINE_LENGTH) {
            continue
        }
        if (RE_DIAG_HEAD.test(ln)) {
            exempt = true
        }
        else if (RE_STACK_FRAME.test(ln)) {
            if (!exempt) {
                return true
            }
        }
        else {
            exempt = false
        }
    }
    return false
}


/**
 * 偵測離開碼 0 之 node 列輸出是否印出了建置失敗(純函式; 帳本 R15)
 *
 * 下游建置腳本普遍自接 catch 後只 console.log(err), 失敗時離開碼仍為 0, 離開碼判定看不到.
 * 先看錯誤堆疊框行(任何被印出之 Error 物件皆有: RollupError、babel SyntaxError、fs 錯誤、can not clean folder), 再看固定字串(字串拒絕無堆疊).
 * 以 util.stripVTControlCharacters 去控制碼(SGR 色碼、OSC 8 超連結等; R15.8)後, stdout 與 stderr 各自比對、不拼接(同 createOutputCollector 之理由);
 * 逐行比對, 長度超過 MAX_FRAME_LINE_LENGTH 之行略過, 緊接在 Trace 或 (node:pid) 標頭之後的堆疊框屬診斷輸出不判(見 hasStackFrame).
 * 良性輸出(警告、Browserslist 提示、DeprecationWarning、時間戳行、WPT_DYNAMIC_REQUIRE_GUARDED 警告碼)不判.
 *
 * @param {String} [out=''] 輸入 stdout 原樣串接之字串
 * @param {String} [err=''] 輸入 stderr 原樣串接之字串
 * @returns {Object|null} 回傳 { detail }, detail 為'exit 0 但輸出含錯誤堆疊'或'exit 0 但輸出含[<固定字串>]'; 未偵測到回傳 null
 */
function detectPrintedFailure(out = '', err = '') {

    let streams = []
    for (let s of [out, err]) {
        streams.push(s === null || s === undefined ? '' : stripVTControlCharacters(String(s).replace(RE_CSI, '')))
    }

    //堆疊框
    for (let t of streams) {
        if (t !== '' && hasStackFrame(t)) {
            return { detail: 'exit 0 但輸出含錯誤堆疊' }
        }
    }

    //固定字串
    for (let t of streams) {
        for (let m of PRINTED_FAIL_STRINGS) {
            if (t.indexOf(m) >= 0) {
                return { detail: `exit 0 但輸出含[${m}]` }
            }
        }
    }

    return null
}


/**
 * 判定指令執行結果(純函式)
 *
 * main 為'node'時: 先比對輸出含[RollupError](自接 catch 後印出錯誤且 exit 0 之建置腳本只能靠字樣; 未捕捉之 RollupError 亦含此字樣, 沿用既有訊息), 再看離開碼非 0 或程序無法啟動;
 *   離開碼為 0 時再看輸出是否印出了建置失敗(錯誤堆疊框、固定字串; 見 detectPrintedFailure, 帳本 R15).
 * main 為'npm'時: 先比對輸出含 npm error(npm 自身錯誤如 ETARGET、E403、Missing script 必印), 再看離開碼非 0 或程序無法啟動(npm 11 起 npm run 之腳本失敗只回非 0 離開碼, 不印 npm error).
 * main 為'git'時(帳本 R6.2, 2026-10-17), label 為'git指令失敗', 依 gitSub(子命令, 見 getGitSubcommand)判定:
 *   所有子命令: spawn[…](程序無法啟動)判失敗; 離開碼 >= 128(git 的 fatal: 類錯誤, 如 index.lock 殘留、認證/網路失敗、非倉庫)判失敗;
 *   'push'、'unknown'與所有不在良性白名單(GIT_LENIENT_SUBS)內之子命令(pull、fetch、tag、錯字等): 任何其他非 0(含 code[1]之被拒、訊號結束、舊版 Error 物件)一律失敗;
 *   'commit': 僅 code[1] 且 stdout 或 stderr 有 git 的無變更結論整行(RE_GIT_NO_CHANGE, 即 nothing to commit, working tree clean 等; D1)時良性, 其餘非 0 一律失敗(含 nothing added to commit、no changes added to commit、行中提及該字樣者);
 *   白名單子命令(add 與唯讀 status、diff、log 等)或未給 gitSub: exit 1~127、訊號結束維持不判定(只由 ectScripts 依帳本 R13 留痕); 離開碼 0 時不比對輸出.
 * 其他(./node_modules/.bin/ 與 g_checkAndCommit 列, 未給 main)不判定離開碼與輸出: jsdoc 有 ERROR(如來源路徑不存在、@example 缺值)時 exit 1 但文件照常產出;
 *   **唯逾時例外**(帳本 R18): 任何列逾時一律判失敗, 未判定列之 label 為'指令逾時'.
 * stderr 有輸出不視為失敗(太多程式把警告輸出到 stderr).
 *
 * @param {Object} [p={}] 輸入判定資料物件
 * @param {String} [p.main] 輸入主要指令類型字串, 'node'、'npm'或'git', 其他值不判定
 * @param {String} [p.gitSub] 輸入 git 子命令字串(僅 main='git' 時用, 由 getGitSubcommand 求得: 'push'、'commit'、'add'、…或'unknown'), 未給視為泛用(僅 >=128 與 spawn 判失敗, 同白名單子命令)
 * @param {*} [p.errExec=null] 輸入 execProcess 之 reject 值, 成功為 null
 * @param {String} [p.out=''] 輸入 stdout 原樣串接之字串
 * @param {String} [p.err=''] 輸入 stderr 原樣串接之字串
 * @returns {Object} 回傳判定物件 { failed, label, detail }, label 為'rollup編譯失敗'、'node指令失敗'、'npm指令失敗'、'git指令失敗'或'指令逾時', detail 為離開碼等摘要(以字樣判定時為'')
 */
function judgeResult({ main, gitSub, errExec = null, out = '', err = '' } = {}) {

    let has = (s) => {
        return String(out).indexOf(s) >= 0 || String(err).indexOf(s) >= 0
    }
    let failedExec = errExec !== null && errExec !== undefined

    if (main === 'npm') {
        if (has('npm error')) {
            return { failed: true, label: 'npm指令失敗', detail: '' }
        }
        if (failedExec) {
            return { failed: true, label: 'npm指令失敗', detail: getExecDetail(errExec) }
        }
    }

    //git列(帳本R6.2): 依子命令gitSub判定; 逾時不在此判(由下方統一判為'指令逾時')
    if (main === 'git' && failedExec && String(errExec).indexOf('timeout[') !== 0) {
        let code = getExitCode(errExec)
        let spawnFail = typeof errExec === 'string' && errExec.indexOf('spawn[') === 0
        let fatal = { failed: true, label: 'git指令失敗', detail: getExecDetail(errExec) }
        if (spawnFail) {
            return fatal //程序無法啟動: git根本沒執行, 不得續行(C2)
        }
        if (code !== null && code >= GIT_FATAL_EXIT_CODE) {
            return fatal //fatal:類(index.lock殘留、認證/網路失敗、非倉庫)
        }
        if (gitSub === 'commit') {
            let bNoChange = code === 1 && (RE_GIT_NO_CHANGE.test(String(out)) || RE_GIT_NO_CHANGE.test(String(err)))
            if (!bNoChange) {
                return fatal //commit除exit 1且含無變更片語外一律失敗(hook失敗、其他非0; C1)
            }
        }
        else if (gitSub !== undefined && !GIT_LENIENT_SUBS.has(gitSub)) {
            return fatal //push、無法辨識(unknown)與所有不在良性白名單內之子命令(pull、fetch、tag、錯字等): 任何非0一律失敗(含exit 1之被拒; 遠端未收到commit時不得續行deploy/publish; C1)
        }
        //add與唯讀子命令(白名單)或未給gitSub: exit 1~127、訊號結束、舊版Error物件維持良性, 只由ectScripts依R13留痕
    }

    if (main === 'node') {
        if (has('[RollupError]')) {
            return { failed: true, label: 'rollup編譯失敗', detail: '' }
        }
        if (failedExec) {
            return { failed: true, label: 'node指令失敗', detail: getExecDetail(errExec) }
        }
        //離開碼為0: 自接catch只印出錯誤之下游建置腳本(帳本R15)
        let printed = detectPrintedFailure(out, err)
        if (printed !== null) {
            return { failed: true, label: 'node指令失敗', detail: printed.detail }
        }
    }

    //逾時一律視為失敗(帳本R18): node與npm列已於上方以各自標籤判定; 其餘未判定列(git、.bin、g_checkAndCommit)僅逾時例外
    if (failedExec && String(errExec).indexOf('timeout[') === 0) {
        return { failed: true, label: '指令逾時', detail: getExecDetail(errExec) }
    }

    return { failed: false, label: '', detail: '' }
}


/**
 * 取本次呼叫之逾時毫秒數(純函式; 帳本 R18.1)
 *
 * @param {Object} [opt={}] 輸入 ectScripts 之設定物件
 * @returns {Number|null} 回傳逾時毫秒數, null 表不限制: opt 未給 timeoutMs 或給非正數之非 null/0 值 → DEFAULT_TIMEOUT_MS; 給 null 或 0 → null; 給正數 → 該值
 */
function getTimeoutMs(opt = {}) {
    let v = _.get(opt, 'timeoutMs')
    if (v === null || v === 0) {
        return null
    }
    if (_.isFinite(v) && v > 0) {
        return v
    }
    return DEFAULT_TIMEOUT_MS
}


/**
 * 取本次呼叫逾時後之寬限毫秒數(純函式; 帳本 R18.6)
 *
 * @param {Object} [opt={}] 輸入 ectScripts 之設定物件
 * @returns {Number} 回傳寬限毫秒數: opt.timeoutGraceMs 為有限且不小於 0 之數字則用之, 否則 TIMEOUT_GRACE_MS
 */
function getTimeoutGraceMs(opt = {}) {
    let v = _.get(opt, 'timeoutGraceMs')
    if (_.isFinite(v) && v >= 0) {
        return v
    }
    return TIMEOUT_GRACE_MS
}


/**
 * 判斷錯誤訊息是否為逾時失敗(純函式; 帳本 R9、R18.5)
 *
 * 逾時之訊息首行為'[<套件>] <label>(timeout[Nms]): <指令>'(label 為 node指令失敗、npm指令失敗、指令逾時); 只認標籤後緊接之 (timeout[…]),
 * 離開碼、程序無法啟動、或指令文字內含同樣字串者不算.
 *
 * @param {*} msg 輸入錯誤訊息字串或 Error 物件
 * @returns {Boolean} 回傳是否為逾時失敗
 */
function isTimeoutMessage(msg) {
    if (msg === null || msg === undefined) {
        return false
    }
    let s = msg instanceof Error ? msg.message : String(msg)
    return RE_TIMEOUT_MESSAGE.test(s)
}


/**
 * 於套件資料夾內以 PowerShell 執行指令並判定成敗
 *
 * 組法見 composeCommand, 判定見 judgeResult; 判定為失敗即 throw, 訊息為'[套件名] <label>(<detail>): <指令>\n<輸出>'.
 * 未判定之列(未給 main)有拒絕值時不中止, 只印一行留痕, 見 getUnjudgedMessage.
 *
 * @param {Object} pdi 輸入套件資訊物件, 須含 name 與 path
 * @param {String|Array} scps 輸入指令字串或指令陣列
 * @param {Object} [opt={}] 輸入設定物件
 * @param {String} [opt.main] 輸入主要指令類型字串, 'node'、'npm'時判定成敗, 'git'時依子命令判定(帳本 R6.2: spawn 與離開碼 >= 128 一律失敗; push/未列入白名單之子命令任何非 0 失敗; commit 僅含無變更片語之 exit 1 良性; add 與唯讀子命令其餘良性), 其他不判定(逾時除外, 見 judgeResult)
 * @param {Number|null} [opt.timeoutMs=DEFAULT_TIMEOUT_MS] 輸入逾時毫秒數(帳本 R18), 未給用預設 60 分鐘, 給 null 或 0 表不限制, 非正數之其他值視為未給
 * @param {Number} [opt.timeoutGraceMs=TIMEOUT_GRACE_MS] 輸入逾時後等 execProcess 落定之寬限毫秒數(帳本 R18.6), 逾時仍未落定即判逾時失敗並不再等待; 供測試縮短
 * @param {Function} [opt.execProcess] 輸入取代 wsemi execProcess 之函式(供測試注入, 簽名同 execProcess(prog, args, opt)); 測試環境下必須給, 未給即 throw(帳本 R25)
 * @returns {Promise} 回傳 Promise, resolve 回傳輸出文字(兩串流依到達順序合併, 每塊後補換行), 判定失敗時 reject
 */
async function ectScripts(pdi, scps, opt = {}) {
    // pdi {
    //   name: 'w-serv-broadcast',
    //   path: 'D:\\- 006 -        開源\\開源-JS-007-4-w-serv-broadcast/w-serv-broadcast',
    //   version: '1.0.17',
    //   update: true,
    //   dependencies: [],
    //   devDependencies: [ { name: 'w-converhp', verOld: '^2.0.17', verNew: '^2.0.18' } ]
    // }

    //唯一啟動 PowerShell 之接縫(npm i、git push、deploy、publish、建置列皆經此): 測試環境下未注入 execProcess 即 throw, 不啟動任何行程(帳本 R25)
    //注入的若恰是未包裝的真實 execProcess(wsemi 預設匯出, 含 w.execProcess)亦視為未注入: 須經 test/tools/realExec.mjs 的包裝與限制(第 5 次外審 opus F05)
    if (!_.isFunction(_.get(opt, 'execProcess'))) {
        assertRealExecAllowed('ectScripts', '未注入 execProcess, 將啟動真實 PowerShell')
    }
    else if (opt.execProcess === execProcess) {
        assertRealExecAllowed('ectScripts', '直接注入了未包裝的真實 execProcess, 將啟動真實 PowerShell')
    }

    if (!w.isarr(scps)) {
        scps = [scps]
    }

    let prog = 'powershell'
    let args = composeCommand(pdi.path, scps)

    let col = createOutputCollector()
    let cbStdout = (cdata) => {
        // console.log('stdout', cdata)
        console.log(cdata)
        col.onStdout(cdata)
    }
    let cbStderr = (cdata) => {
        // console.log('stderr', cdata)
        console.log(cdata)
        col.onStderr(cdata)
    }

    //執行指令時訊息會混合使用cbStdout與cbStderr, 先掛載即時顯示; 離開碼非0或程序無法啟動時execProcess會reject, 保留下來供判定
    let execOpt = { cbStdout, cbStderr }
    let timeoutMs = getTimeoutMs(opt)
    if (timeoutMs !== null) {
        execOpt.timeout = timeoutMs //逾時由execProcess殺整棵程序樹並reject 'timeout[Nms]:…'
    }
    let exec = _.isFunction(_.get(opt, 'execProcess')) ? opt.execProcess : execProcess
    let pExec = new Promise((resolve) => {
        resolve(exec(prog, ['-Command', args], execOpt)) //指定'-Command'時可將後面參數字串視為須全部執行之整行指令
    }).then(() => null, (err) => ({ err }))

    //逾時後再等寬限(帳本R18.6): execProcess須等輸出管道關閉才落定, 孤兒孫程序持有管道或殺樹失敗時可能不落定, 不能無限等
    let settled = null
    if (timeoutMs !== null) {
        let timer = null
        let guard = new Promise((resolve) => {
            timer = setTimeout(() => resolve(GRACE_EXPIRED), timeoutMs + getTimeoutGraceMs(opt))
        })
        settled = await Promise.race([pExec, guard])
        clearTimeout(timer)
    }
    else {
        settled = await pExec
    }

    let errExec = null
    let c = null
    if (settled === GRACE_EXPIRED) {
        errExec = `timeout[${timeoutMs}ms]:\n${NOTE_NOT_SETTLED}`
        c = col.getDisplay() + NOTE_NOT_SETTLED + '\n'
    }
    else {
        if (settled !== null) {
            errExec = settled.err
        }
        c = col.getDisplay()
    }

    //判定
    let main = _.get(opt, 'main')
    let r = judgeResult({ main, gitSub: main === 'git' ? getGitSubcommand(scps) : undefined, errExec, out: col.getOut(), err: col.getErr() })
    if (r.failed) {
        let detail = r.detail !== '' ? `(${r.detail})` : ''
        throw new Error(`[${pdi.name}] ${r.label}${detail}: ${_.join(scps, ' ; ')}\n${c}`)
    }

    //未判定之列有拒絕值(離開碼非0或程序無法啟動)時留痕一行, 不中止
    let msgUnjudged = getUnjudgedMessage({ name: pdi.name, errExec, scps })
    if (msgUnjudged !== '') {
        console.log(msgUnjudged)
    }

    return c
}


export {
    DEFAULT_TIMEOUT_MS,
    TIMEOUT_GRACE_MS,
    GIT_FATAL_EXIT_CODE,
    RE_GIT_NO_CHANGE,
    GIT_LENIENT_SUBS,
    PRINTED_FAIL_STRINGS,
    composeCommand,
    createOutputCollector,
    getExecDetail,
    getGitSubcommand,
    getUnjudgedMessage,
    getTimeoutMs,
    getTimeoutGraceMs,
    isTimeoutMessage,
    detectPrintedFailure,
    judgeResult
}
export default ectScripts
