import w from 'wsemi'


//git 全域選項中, 不含'='時須再吃下一個記號當值者(帳本 R6.1)
const GIT_VALUE_OPTS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--attr-source', '--super-prefix'])

//使 git 印出說明/版本/路徑後即結束(不執行其後的子命令)之全域選項記號(帳本 R6.1; 第 5 次外審 opus F09): 遇到即視為無子命令(unknown). 注意 --exec-path=<路徑> 帶等號者是設定路徑的一般選項, 不在此列
const GIT_INFO_OPTS = new Set(['-h', '--help', '-v', '--version', '--exec-path', '--html-path', '--man-path', '--info-path'])

//git exit 1~127 維持良性(只留痕)之子命令白名單(帳本 R6.2④): add 與唯讀子命令(與 runScript 之 RE_READONLY_GIT 同一集合); 不在其內且非 commit 之子命令(pull、fetch、tag、錯字、被誤當子命令之記號等)一律嚴格
const GIT_LENIENT_SUBS = new Set(['add', 'status', 'diff', 'log', 'show', 'rev-parse', 'ls-files', 'describe', 'rev-list', 'cat-file', 'shortlog', 'blame', 'grep'])

//script.txt 之 git 列允許的子命令(帳本 R7.2, 執行前檢查): 良性白名單加上 commit、push; 其餘於任何副作用之前判為非預期指令(日後需 pull、tag 等須明確擴充, 並檢視 R6.2、isLocalGitCmd、isRemoteCmd、R21)
const GIT_ALLOWED_SUBS = new Set([...GIT_LENIENT_SUBS, 'commit', 'push'])


/**
 * 取 git 指令列之子命令(純函式; 帳本 R6.1)
 *
 * 記號化(尊重單/雙引號, 引號本身不留; 未封閉之引號以剩餘字元為記號), 首記號須為 git; 其後以 - 開頭者為全域選項而略過
 * (-C、-c、--git-dir、--work-tree、--namespace、--config-env、--super-prefix 不含'='時連同下一個記號一併略過), 第一個非選項記號轉小寫即子命令.
 *
 * @param {String|Array} scps 輸入指令字串, 或僅含一個指令字串之陣列(ectScripts 的 scps 形態; 多於一個或為空陣列視為無法辨識)
 * @param {Object} [opt={}] 輸入設定物件
 * @param {Boolean} [opt.keepCase=false] 輸入是否保留子命令原大小寫(預設轉小寫供判定用; 白名單檢查用 true, 因 git 子命令區分大小寫, 'git PUSH' 會被 git 自己拒絕)
 * @returns {String} 回傳子命令字串(預設小寫), 如'push'、'commit'、'add'、'status'; 無法辨識(首記號非 git、無子命令如'git --version'、陣列多列、非字串)回傳'unknown'
 */
function getGitSubcommand(scps, opt = {}) {
    let s = scps
    if (Array.isArray(scps)) {
        if (scps.length !== 1) {
            return 'unknown'
        }
        s = scps[0]
    }
    if (!w.isestr(s)) {
        return 'unknown'
    }

    //記號化
    let ts = []
    let cur = ''
    let has = false //cur 是否已開始(含空引號 '' 形成之空記號)
    let q = ''
    for (let c of s) {
        if (q !== '') {
            if (c === q) {
                q = ''
            }
            else {
                cur += c
            }
            continue
        }
        if (c === '"' || c === "'") {
            q = c
            has = true
            continue
        }
        if (/\s/.test(c)) {
            if (has) {
                ts.push(cur)
                cur = ''
                has = false
            }
            continue
        }
        cur += c
        has = true
    }
    if (has) {
        ts.push(cur)
    }

    if (ts.length === 0 || ts[0] !== 'git') {
        return 'unknown'
    }
    let i = 1
    while (i < ts.length && w.strleft(ts[i], 1) === '-') {
        if (GIT_INFO_OPTS.has(ts[i]) || w.strleft(ts[i], 12) === '--list-cmds=') {
            return 'unknown' //git 印出即結束, 其後的記號不是會被執行的子命令
        }
        i += GIT_VALUE_OPTS.has(ts[i]) ? 2 : 1
    }
    if (i >= ts.length) {
        return 'unknown'
    }
    return opt.keepCase === true ? ts[i] : ts[i].toLowerCase()
}


export { GIT_LENIENT_SUBS, GIT_ALLOWED_SUBS, getGitSubcommand }
