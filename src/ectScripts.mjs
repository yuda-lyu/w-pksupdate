import _ from 'lodash-es'
import w from 'wsemi'
import execProcess from 'wsemi/src/execProcess.mjs'


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
 * 未判定之列有拒絕值時之留痕訊息(純函式)
 *
 * 未給 main 之列(.bin、git 列與 g_checkAndCommit)不判定成敗(jsdoc 有 ERROR 時 exit 1、git commit 無變更時 exit 1 皆屬良性), 但離開碼非 0 或程序無法啟動時須留下一行痕跡, 否則 log 只見空白回顯而無從察覺.
 * 只留痕、不中止、不改判定; ectScripts 只在判定未失敗後呼叫(判定為失敗之列改為 throw).
 * 訊息不可含守望器比對之致命字樣(npm指令失敗、node指令失敗、rollup編譯失敗、rm指令失敗、建置產物遭刪除、npm上找不到、非預期指令、Vue packages version mismatch), 否則良性之 exit 1 會被誤當中止.
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
    return `[${name}] 未判定(${getExecDetail(errExec)}): ${_.join(scps, ' ; ')}`
}


/**
 * 判定指令執行結果(純函式)
 *
 * main 為'node'時: 先比對輸出含[RollupError](自接 catch 後印出錯誤且 exit 0 之建置腳本只能靠字樣; 未捕捉之 RollupError 亦含此字樣, 沿用既有訊息), 再看離開碼非 0 或程序無法啟動.
 * main 為'npm'時: 先比對輸出含 npm error(npm 自身錯誤如 ETARGET、E403、Missing script 必印), 再看離開碼非 0 或程序無法啟動(npm 11 起 npm run 之腳本失敗只回非 0 離開碼, 不印 npm error).
 * 其他(git 與 ./node_modules/.bin/ 列)不判定: git commit 無變更即 exit 1; jsdoc 有 ERROR(如來源路徑不存在、@example 缺值)時 exit 1 但文件照常產出.
 * stderr 有輸出不視為失敗(太多程式把警告輸出到 stderr).
 *
 * @param {Object} [p={}] 輸入判定資料物件
 * @param {String} [p.main] 輸入主要指令類型字串, 'node'或'npm', 其他值不判定
 * @param {*} [p.errExec=null] 輸入 execProcess 之 reject 值, 成功為 null
 * @param {String} [p.out=''] 輸入 stdout 原樣串接之字串
 * @param {String} [p.err=''] 輸入 stderr 原樣串接之字串
 * @returns {Object} 回傳判定物件 { failed, label, detail }, label 為'rollup編譯失敗'、'node指令失敗'或'npm指令失敗', detail 為離開碼等摘要(以字樣判定時為'')
 */
function judgeResult({ main, errExec = null, out = '', err = '' } = {}) {

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

    if (main === 'node') {
        if (has('[RollupError]')) {
            return { failed: true, label: 'rollup編譯失敗', detail: '' }
        }
        if (failedExec) {
            return { failed: true, label: 'node指令失敗', detail: getExecDetail(errExec) }
        }
    }

    return { failed: false, label: '', detail: '' }
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
 * @param {String} [opt.main] 輸入主要指令類型字串, 'node'或'npm'時判定成敗, 其他不判定
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
    let errExec = null
    await execProcess(prog, ['-Command', args], { cbStdout, cbStderr }) //指定'-Command'時可將後面參數字串視為須全部執行之整行指令
        .catch((err) => {
            errExec = err
        })

    let c = col.getDisplay()

    //判定
    let r = judgeResult({ main: _.get(opt, 'main'), errExec, out: col.getOut(), err: col.getErr() })
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
    composeCommand,
    createOutputCollector,
    getExecDetail,
    getUnjudgedMessage,
    judgeResult
}
export default ectScripts
