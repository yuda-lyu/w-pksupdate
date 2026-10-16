//刻意走真實執行之測試專用(帳本 R25.5): 需真 PowerShell、墊片 git.cmd、fixture 內真 git status 之測試, 一律經本檔
//  ectReal: 以注入 execProcess 使 ectScripts 之測試環境守衛放行(顯式承認要走真實執行), 但限 test/_tmp 內之 fixture,
//           且指令須在『白名單』內(第 5 次外審 opus F02: 原為黑名單正則, 引號、帶值選項、縮寫、絕對路徑 git.exe、alias 等等價寫法皆可通過)
//  gitStatusDistReal: runScript 之 gitStatusDist 真實實作, 限 test/_tmp 內
//引用本檔之測試檔即『刻意真實執行』之完整清單, 由 unit-testGuard 之盤點案釘住
import fs from 'fs'
import path from 'path'
import cp from 'child_process'
import _ from 'lodash-es'
import execProcessWsemi from 'wsemi/src/execProcess.mjs'
import ectScripts from '../../src/ectScripts.mjs'
import { hasShellControl, parseNpmCmd } from '../../src/runScript.mjs'
import { getGitSubcommand, GIT_LENIENT_SUBS } from '../../src/gitSubcommand.mjs'
import { realPathOf, testTmpRoot } from '../../src/testGuard.mjs'


//未經包裝的真實 execProcess 不可直接注入 ectScripts(其守衛以身分比對拒絕); 經本檔包裝為另一個函式後才算『經 realExec』
const realExecProcess = (prog, args, opt) => execProcessWsemi(prog, args, opt)

//無墊片時允許真實執行的 git 唯讀子命令(GIT_LENIENT_SUBS 去掉 add), 及不得帶的會寫檔或起程式之選項
const GIT_READONLY_SUBS = new Set([...GIT_LENIENT_SUBS].filter((s) => s !== 'add'))
const RE_GIT_DENIED_OPT = /^(?:--output(?:=|$)|--ext-diff|--textconv|--open-files-in-pager|--config-env|--git-dir|--work-tree|--exec-path|--paginate|-O|-c|-C|-p)/

//npm run 之腳本名: 單純名稱, 且不得是 deploy(含 deploy: 前綴)
const RE_NPM_SCRIPT = /^[A-Za-z0-9_:.-]+$/


//以實體路徑比對(解開 junction、符號連結、8.3 短名; 路徑尚不存在時取最近既存祖先的實體路徑): 字面比對會被 test/_tmp 內指向真實套件的 junction 通過(R25.2)
function norm(p) {
    return realPathOf(p).toLowerCase().replace(/[\\/]+$/, '')
}

function isUnder(p, root) {
    let a = norm(p)
    let b = norm(root)
    return a === b || a.startsWith(b + path.sep)
}


/**
 * 執行目錄須在 <專案根>/test/_tmp 內(錨點由 testGuard 之 import.meta.url 推得, 不隨 process.chdir 搬家), 否則 throw
 *
 * @param {String} p 輸入 pdi.path 或 cwd
 */
function assertConfined(p) {
    if (!_.isString(p) || p === '' || !isUnder(p, testTmpRoot())) {
        throw new Error(`[realExec] 執行目錄[${p}]不在 test/_tmp 內, 拒絕真實執行(帳本 R25.5)`)
    }
}


/**
 * PATH 首項目錄是否含 git.cmd 墊片
 *
 * @returns {Boolean} 回傳是否含
 */
function shimFirst() {
    let first = String(process.env.PATH || '').split(path.delimiter)[0]
    return Boolean(first) && _.some(['git.cmd', 'git.bat'], (n) => fs.existsSync(path.join(first, n)))
}


/**
 * 檢查單一指令字串是否在白名單內(純檢查, 不啟動任何行程)
 *
 * 規則(皆以『程式記號必須是裸 node / npm / git / ./node_modules/.bin/…』為前提, 拒絕 .exe/.cmd/.ps1/絕對路徑/&/npx/cmd 等):
 *  ①含 shell 控制運算子者拒絕(無法判定為單一指令); ②node: 放行(腳本內容由測試自寫之 fixture 決定);
 *  ③npm: 只放行 `run <腳本名>`/`run-script <腳本名>`, 腳本名為單純名稱且不以 deploy 開頭——與正式路徑同一個解析器(runScript 之 parseNpmCmd: 去引號、略過全域選項), 縮寫(rum)、別名、publish/install/version 等一律拒絕;
 *  ④git: PATH 首項目錄有 git.cmd 墊片時放行(實際執行的是墊片); 無墊片時只放行唯讀子命令(且不帶會寫檔或起程式之選項)與 `git --version`.
 *
 * @param {String} cmd 輸入指令字串
 */
function assertCommandAllowed(cmd) {
    let s = String(cmd).trim()
    let deny = (why) => {
        throw new Error(`[realExec] 指令不在允許集合(${why}): ${s}(帳本 R25.5)`)
    }
    if (s === '') {
        deny('空指令')
    }
    if (hasShellControl(s)) {
        deny('含 shell 控制運算子, 無法判定為單一指令')
    }
    let prog = s.split(/\s+/)[0]
    if (prog === 'node') {
        if (/(?:^|[\s\\/])(?:npm|npx)(?:-cli)?(?:\.c?js)?(?:\s|$)/i.test(s.slice(prog.length))) {
            deny('node 不得直接執行 npm/npx 的 cli 腳本')
        }
        return
    }
    if (prog.indexOf('./node_modules/.bin/') === 0) {
        return
    }
    if (prog === 'npm') {
        let { sub, arg } = parseNpmCmd(s)
        if ((sub !== 'run' && sub !== 'run-script') || !RE_NPM_SCRIPT.test(arg) || arg.indexOf('deploy') === 0) {
            deny('npm 只放行 run <fixture 腳本名>, 且不得為 deploy')
        }
        return
    }
    if (prog === 'git') {
        if (shimFirst()) {
            return
        }
        if (/^git\s+--version$/.test(s)) {
            return
        }
        let sub = getGitSubcommand(s, { keepCase: true })
        let optsBad = s.split(/\s+/).slice(1).some((t) => RE_GIT_DENIED_OPT.test(t))
        if (GIT_READONLY_SUBS.has(sub) && !optsBad) {
            return
        }
        deny('git 無墊片時只放行唯讀子命令; 其餘須 PATH 首項目錄含 git.cmd 墊片')
    }
    deny('程式記號須為裸 node / npm / git 或 ./node_modules/.bin/…')
}


/**
 * 檢查指令字串(陣列)是否可真實執行, 不可則 throw(純檢查, 不啟動任何行程)
 *
 * @param {String|Array} scps 輸入指令字串或陣列
 */
function assertCommandsAllowed(scps) {
    _.each(_.isArray(scps) ? scps : [scps], (c) => {
        assertCommandAllowed(c)
    })
}


/**
 * 真實 git 不得探索到本工具自己的倉庫(fixture 位於 <專案根>/test/_tmp, 往上就是本工具倉庫): 以專案根為 GIT_CEILING_DIRECTORIES
 *
 * @returns {String} 回傳專案根之實體路徑
 */
function gitCeiling() {
    return path.resolve(testTmpRoot(), '..', '..')
}


/**
 * 產生 ectReal(供測試注入底層, 使「拒絕」可在不啟動任何行程下驗證)
 *
 * @param {Object} [deps={}] 輸入相依物件
 * @param {Function} [deps.ect=ectScripts] 輸入 ectScripts 實作
 * @param {Function} [deps.execProcess=realExecProcess] 輸入 execProcess 實作
 * @returns {Function} 回傳簽名同 ectScripts(pdi, scps, opt) 之函式
 */
function makeEctReal(deps = {}) {
    let ect = _.get(deps, 'ect', ectScripts)
    let execProcess = _.get(deps, 'execProcess', realExecProcess)
    return async (pdi, scps, opt = {}) => {
        assertConfined(_.get(pdi, 'path'))
        assertCommandsAllowed(scps)
        //執行期間設 GIT_CEILING_DIRECTORIES: 真實 git 自 fixture 往上找不到本工具倉庫(子行程於啟動時讀取環境, 呼叫結束即還原)
        let ceilOri = process.env.GIT_CEILING_DIRECTORIES
        process.env.GIT_CEILING_DIRECTORIES = gitCeiling()
        try {
            return await ect(pdi, scps, { ...opt, execProcess: _.isFunction(_.get(opt, 'execProcess')) ? opt.execProcess : execProcess })
        }
        finally {
            if (ceilOri === undefined) {
                delete process.env.GIT_CEILING_DIRECTORIES
            }
            else {
                process.env.GIT_CEILING_DIRECTORIES = ceilOri
            }
        }
    }
}

let ectReal = makeEctReal()


/**
 * runScript 之 gitStatusDist 真實實作(唯讀 git status), 限 test/_tmp 內; 不得探索到本工具倉庫
 *
 * @param {String} cwd 輸入執行目錄
 * @returns {String} 回傳 git status --porcelain 輸出
 */
function gitStatusDistReal(cwd) {
    assertConfined(cwd)
    return cp.execSync('git status --porcelain -- dist', { cwd, env: { ...process.env, GIT_CEILING_DIRECTORIES: gitCeiling() } }).toString()
}


export { assertConfined, assertCommandAllowed, assertCommandsAllowed, gitCeiling, makeEctReal, ectReal, realExecProcess, gitStatusDistReal }
