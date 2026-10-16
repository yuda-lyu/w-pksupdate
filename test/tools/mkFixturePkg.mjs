//測試用 fixture 套件產生器: 於指定資料夾建立沙箱套件(各失敗形態之腳本、仿 npm cmd-shim 之 .bin 墊片、可選之 docs)
//只供 test/*.test.mjs 於 before 建立、after 刪除; 不含任何 git、deploy、npm publish、npm i
import fs from 'fs'
import path from 'path'


let files = {

    'package.json': JSON.stringify({
        name: 'sbx-ect-test',
        version: '0.0.1',
        private: true,
        scripts: {
            'build-ok': 'node toolg/ok.mjs',
            'build-warn': 'node toolg/okStderr.mjs',
            'build-exit3': 'node toolg/exit3.mjs',
        },
    }, null, 2),

    //每支腳本開頭把自身檔名與參數附加到 cwd 之 _trace.txt, 用以判斷哪些列被執行
    'toolg/_trace.mjs': `import fs from 'fs'
import path from 'path'
function trace() {
    let name = path.basename(process.argv[1] || '?')
    let args = process.argv.slice(2).join(' ')
    fs.appendFileSync('./_trace.txt', name + (args ? ' ' + args : '') + '\\n', 'utf8')
}
export default trace
`,
    'toolg/ok.mjs': `import trace from './_trace.mjs'
trace()
console.log('ok 中文輸出')
`,
    'toolg/okStderr.mjs': `import trace from './_trace.mjs'
trace()
process.stderr.write('Browserslist: browsers data (caniuse-lite) is 6 months old.\\n')
console.warn('(!) Plugin node-resolve: preferring built-in module "fs"')
console.log('built ok')
`,
    'toolg/throwErr.mjs': `import trace from './_trace.mjs'
trace()
throw new Error('boom-uncaught')
`,
    'toolg/exit3.mjs': `import trace from './_trace.mjs'
trace()
process.exit(3)
`,
    //自接 catch 後印出 RollupError 而 exit 0(建置腳本自接 catch 之輸出形態)
    'toolg/rollupMarker.mjs': `import trace from './_trace.mjs'
trace()
console.log('Error [RollupError]: "default" is not exported by "src/lib.mjs", imported by "src/bad.mjs".')
`,
    //自接 catch 後 console.log(err) 而 exit 0(全庫 19 個 repo、35 處之實際形態; Error 物件印出時帶堆疊框)(R15)
    'toolg/throwCaught.mjs': `import trace from './_trace.mjs'
trace()
async function core() {
    throw new Error('boom-caught')
}
core().catch((err) => { console.log(err) })
`,
    //字串 reject(w-package-tools 之 invalid fpSrc 形態, 無堆疊)自接 catch 印出而 exit 0(R15 固定字串)
    'toolg/rejectStringCaught.mjs': `import trace from './_trace.mjs'
trace()
Promise.reject('invalid fpSrc: C:\\\\x\\\\nofile.mjs').catch((err) => { console.log(err) })
`,
    //未處理的 rejection: 預設 exit 1; 加 --unhandled-rejections=warn 則印 (node:pid) UnhandledPromiseRejectionWarning 與堆疊而 exit 0(第二輪 N1)
    'toolg/unhandled.mjs': `import trace from './_trace.mjs'
trace()
async function core() {
    throw new Error('build failed: unhandled')
}
core()
`,
    //靜默 catch 而 exit 0(R15.7 設計限制: 無任何文字特徵)
    'toolg/silentCatch.mjs': `import trace from './_trace.mjs'
trace()
Promise.reject(new Error('silent')).catch(() => {})
`,
    //卡住 120 秒(R18 逾時)
    'toolg/hang.mjs': `import trace from './_trace.mjs'
trace()
setTimeout(() => {}, 120000)
`,
    //啟動一個脫離之孫程序(繼承 stdout/stderr, 卡住 120 秒, 命令列帶唯一標記)後立即結束(R18.6: 孤兒持有輸出管道, execProcess 須等孤兒結束才落定)
    'toolg/orphan.mjs': `import cp from 'child_process'
import path from 'path'
import trace from './_trace.mjs'
trace()
let id = process.argv[2] || 'x'
let c = cp.spawn(process.execPath, [path.resolve('./toolg/hang.mjs'), id], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] })
c.unref()
console.log('orphan spawned')
`,
    //N 位元組填充後接判定字樣, 單次 write, exit 0
    'toolg/bigThenMarker.mjs': `let n = Number(process.argv[2] || 0)
process.stdout.write('x'.repeat(n) + 'Error [RollupError]: split-test marker\\n')
`,
    'toolg/mark.mjs': `import trace from './_trace.mjs'
trace()
console.log('mark ' + process.argv.slice(2).join(' '))
`,
    //名稱同真實之 addVersion, 只記錄被執行(驗證非預期指令於其之前中止)
    'toolg/addVersion.mjs': `import trace from './_trace.mjs'
trace()
console.log('addVersion(fixture)')
`,

    //.bin 墊片(內容同 npm cmd-shim 產物, 目標改為 ../fakebin/bin/fakebin.js)
    'node_modules/fakebin/bin/fakebin.js': `let code = Number(process.argv[2] || 0)
console.log('fakebin exit=' + code)
process.exit(code)
`,
    'node_modules/.bin/fakebin.ps1': `#!/usr/bin/env pwsh
$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent

$exe=""
if ($PSVersionTable.PSVersion -lt "6.0" -or $IsWindows) {
  # Fix case when both the Windows and Linux builds of Node
  # are installed in the same directory
  $exe=".exe"
}
$ret=0
if (Test-Path "$basedir/node$exe") {
  # Support pipeline input
  if ($MyInvocation.ExpectingInput) {
    $input | & "$basedir/node$exe"  "$basedir/../fakebin/bin/fakebin.js" $args
  } else {
    & "$basedir/node$exe"  "$basedir/../fakebin/bin/fakebin.js" $args
  }
  $ret=$LASTEXITCODE
} else {
  # Support pipeline input
  if ($MyInvocation.ExpectingInput) {
    $input | & "node$exe"  "$basedir/../fakebin/bin/fakebin.js" $args
  } else {
    & "node$exe"  "$basedir/../fakebin/bin/fakebin.js" $args
  }
  $ret=$LASTEXITCODE
}
exit $ret
`,
    'node_modules/.bin/fakebin.cmd': '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\..\\fakebin\\bin\\fakebin.js" %*\r\n',
}


/**
 * 建立 fixture 套件
 *
 * @param {String} fdPkg 輸入套件資料夾路徑字串, 必須位於 test/_tmp 之下
 * @param {Object} [opt={}] 輸入設定物件
 * @param {Boolean} [opt.docs=false] 輸入是否建立 docs 資料夾(含子資料夾與檔案)
 * @param {Array} [opt.script] 輸入 script.txt 之各列, 未給則不建立 script.txt
 * @returns {String} 回傳套件資料夾絕對路徑
 */
function mkFixturePkg(fdPkg, opt = {}) {
    let abs = path.resolve(fdPkg)
    if (abs.replace(/\\/g, '/').indexOf('/test/_tmp/') < 0) {
        throw new Error(`fixture 必須位於 test/_tmp 之下: ${abs}`)
    }
    for (let [rel, content] of Object.entries(files)) {
        let fp = path.join(abs, rel)
        fs.mkdirSync(path.dirname(fp), { recursive: true })
        fs.writeFileSync(fp, content, 'utf8')
    }
    if (opt.docs) {
        mkDocs(abs)
    }
    if (Array.isArray(opt.script)) {
        writeScript(abs, opt.script)
    }
    return abs
}


/**
 * 建立 docs 資料夾(含子資料夾與檔案), 供 rm -r docs 之測試
 *
 * @param {String} fdPkg 輸入套件資料夾路徑字串
 */
function mkDocs(fdPkg) {
    fs.mkdirSync(path.join(fdPkg, 'docs', 'sub'), { recursive: true })
    fs.writeFileSync(path.join(fdPkg, 'docs', 'index.html'), '<html></html>', 'utf8')
    fs.writeFileSync(path.join(fdPkg, 'docs', 'sub', 'a.js'), '//a', 'utf8')
}


/**
 * 寫入 script.txt(CRLF, 同套件區之實際格式)
 *
 * @param {String} fdPkg 輸入套件資料夾路徑字串
 * @param {Array} lines 輸入各列字串陣列
 */
function writeScript(fdPkg, lines, opt = {}) {
    //opt.stubbed=true 只供「同一行程內以 opt.exec 注入樁、不會真的執行任何列」之測試(unit-runScript-gates、unit-publishPackage), 解除下列禁止; 其餘測試一律不得使用
    let forbid = /^\s*#?\s*npm\s+publish|run\s+deploy|^\s*#?\s*git\b|^\s*#?\s*npm\s+(i|install)\b/
    for (let s of lines) {
        if (!opt.stubbed && forbid.test(s)) {
            throw new Error(`測試不得含 git、deploy、npm publish、npm i 列: ${s}`)
        }
    }
    fs.writeFileSync(path.join(fdPkg, 'script.txt'), lines.join('\r\n') + '\r\n', 'utf8')
}


/**
 * 刪除 test/_tmp 本身(僅在已無任何內容時), 供各測試檔 after 於刪除自身資料夾後呼叫, 測完不殘留空資料夾
 */
function cleanTmpRoot() {
    let fd = path.resolve('./test/_tmp')
    try {
        if (fs.existsSync(fd) && fs.readdirSync(fd).length === 0) {
            fs.rmdirSync(fd)
        }
    }
    catch (err) {}
}


/**
 * 讀取 _trace.txt 之各列(不存在回傳空陣列)
 *
 * @param {String} fdPkg 輸入套件資料夾路徑字串
 * @returns {Array} 回傳各列字串陣列
 */
function readTrace(fdPkg) {
    let fp = path.join(fdPkg, '_trace.txt')
    if (!fs.existsSync(fp)) {
        return []
    }
    return fs.readFileSync(fp, 'utf8').split(/\r?\n/).filter((s) => s !== '')
}


export {
    mkFixturePkg,
    mkDocs,
    writeScript,
    cleanTmpRoot,
    readTrace
}
