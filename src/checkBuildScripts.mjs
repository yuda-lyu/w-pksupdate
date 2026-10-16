import fs from 'fs'
import path from 'path'
import _ from 'lodash-es'
import { parseScript } from './runScript.mjs'


/**
 * 建置腳本吞錯預檢(帳本 R22; 完全唯讀: 只讀檔案, 不寫檔、不執行任何指令)
 *
 * 背景: 下游建置腳本若 `.catch((err) => { console.log(err) })` 自接錯誤, 失敗時離開碼仍為 0, 離開碼判定看不到(R15 僅能補文字特徵之一部分);
 * 唯一穩健的預防是在開跑前以結構掃描列出這些站點, 由主控另案改為直接呼叫型(第 54 項).
 * 掃描為 regex 級(R22.10): 先經簡易詞法掃描(去註解、辨識正規式字面值、抹空字串內容)再比對; 經 helper 函式間接吞錯、Promise.allSettled 後不檢查結果等掃不到.
 */


//前一個有效字元為下列之一時, 其後的 '/' 起始正規式字面值(否則為除法); 前一個為識別字元時看該字是否為下列關鍵字
const REGEX_PREV_CHARS = '(,=:[!&|?{};+-*%<>~^'
const REGEX_PREV_WORDS = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'case', 'delete', 'void', 'throw', 'new', 'else', 'do', 'yield', 'await'])

//傳遞: 含 throw、process.exit(非 0; 0x1 等十六進位亦算非 0)、process.exitCode = 非 0(含 ||=、??=、&&= 形; 第二輪 N7)
const RE_PROPAGATE = /\bthrow\b|process\.exit\s*\(\s*(?!0\s*\))[^)\s]|process\.exitCode\s*(?:\|\||\?\?|&&)?=\s*(?!0\b)\S/
//常數運算式(箭頭函式的運算式本體): null、undefined、void 0、布林、數字、字串常數(字串內容已抹空)、空陣列、空物件
const RE_CONST_EXPR = /^(?:null|undefined|void 0|true|false|-?\d+(?:\.\d+)?|(['"`])\s*\1|\[\s*\]|\(\s*\{\s*\}\s*\))$/


//自 openIdx 之括號起取到平衡處(含括號本身)
function takeBalanced(s, openIdx, open = '(', close = ')') {
    let d = 0
    for (let i = openIdx; i < s.length; i++) {
        if (s[i] === open) {
            d++
        }
        else if (s[i] === close) {
            d--
            if (d === 0) {
                return s.slice(openIdx, i + 1)
            }
        }
    }
    return s.slice(openIdx)
}


//建立「索引 → 行號(1 起)」函數: 先收集全部換行位置, 再二分搜尋(逐站點從頭計行為平方級, 第二輪 N7)
function makeLineAt(s) {
    let nl = []
    for (let i = 0; i < s.length; i++) {
        if (s[i] === '\n') {
            nl.push(i)
        }
    }
    return (idx) => {
        let lo = 0
        let hi = nl.length
        while (lo < hi) {
            let mid = (lo + hi) >> 1
            if (nl[mid] < idx) {
                lo = mid + 1
            }
            else {
                hi = mid
            }
        }
        return lo + 1 //idx 之前的換行數 + 1
    }
}


//自 i 處的 '/' 起掃描正規式字面值, 回傳結尾 '/' 之後的索引; 同行內找不到結尾回傳 -1(視為除法)
function scanRegex(src, i) {
    let n = src.length
    let inClass = false
    for (let j = i + 1; j < n; j++) {
        let ch = src[j]
        if (ch === '\n' || ch === '\r') {
            return -1
        }
        if (ch === '\\') {
            j++
            if (src[j] === '\n' || src[j] === '\r') {
                return -1
            }
            continue
        }
        if (inClass) {
            if (ch === ']') {
                inClass = false
            }
            continue
        }
        if (ch === '[') {
            inClass = true
            continue
        }
        if (ch === '/') {
            return j + 1
        }
    }
    return -1
}


/**
 * 簡易詞法掃描(純函式; 帳本 R22.5、R22.7): 同時產生「去註解」與「去註解且字串、樣板字串、正規式字面值內容抹空」兩個版本
 *
 * 兩個版本的長度、行數與原始碼完全相同(註解與被抹空內容以空白取代, 換行保留), 故索引與行號可互通.
 * 正規式字面值以「前一個有效字元」啟發式辨識(見 REGEX_PREV_CHARS、REGEX_PREV_WORDS): 其內的 '//' 不是行註解, 其內的引號不開啟字串.
 * 樣板字串內的 `${}` 不展開(整段視為字串).
 *
 * @param {String} src 輸入原始碼字串
 * @returns {Object} 回傳 { code, blank }
 */
function lex(src) {
    let code = ''
    let blank = ''
    let i = 0
    let n = src.length
    let st = 'code'
    let q = ''
    let prev = '' //最近一個非空白之程式碼字元
    let word = '' //prev 為識別字元時所屬之識別字
    let inWord = false //緊接前一字元是否為識別字元
    let sp = (s) => s.replace(/[^\n\r]/g, ' ')

    while (i < n) {
        let c = src[i]
        let c2 = src.slice(i, i + 2)

        if (st === 'code') {
            if (c2 === '//') {
                st = 'line'
                i += 2
                code += '  '
                blank += '  '
                continue
            }
            if (c2 === '/*') {
                st = 'block'
                i += 2
                code += '  '
                blank += '  '
                continue
            }
            if (c === '"' || c === `'` || c === '`') {
                st = 'str'
                q = c
                code += c
                blank += c
                prev = c
                word = ''
                inWord = false
                i++
                continue
            }
            if (c === '/') {
                let regexAllowed = prev === '' || (/[\w$]/.test(prev) ? REGEX_PREV_WORDS.has(word) : REGEX_PREV_CHARS.indexOf(prev) >= 0)
                let end = regexAllowed ? scanRegex(src, i) : -1
                if (end > 0) {
                    code += src.slice(i, end)
                    blank += '/' + sp(src.slice(i + 1, end - 1)) + '/'
                    prev = '/'
                    word = ''
                    inWord = false
                    i = end
                    continue
                }
            }
            code += c
            blank += c
            if (/[\w$]/.test(c)) {
                word = inWord ? word + c : c
                inWord = true
                prev = c
            }
            else if (/\s/.test(c)) {
                inWord = false
            }
            else {
                word = ''
                inWord = false
                prev = c
            }
            i++
            continue
        }

        if (st === 'str') {
            if (c === '\\') {
                let two = src.slice(i, i + 2)
                code += two
                blank += sp(two)
                i += 2
                continue
            }
            if (c === q) {
                st = 'code'
                code += c
                blank += c
                prev = c
                word = ''
                inWord = false
                i++
                continue
            }
            code += c
            blank += (c === '\n' || c === '\r') ? c : ' '
            i++
            continue
        }

        if (st === 'line') {
            if (c === '\n') {
                st = 'code'
                code += c
                blank += c
            }
            else {
                code += ' '
                blank += ' '
            }
            i++
            continue
        }

        if (st === 'block') {
            if (c2 === '*/') {
                st = 'code'
                code += '  '
                blank += '  '
                i += 2
                continue
            }
            let ch = (c === '\n') ? '\n' : (c === '\r' ? '\r' : ' ')
            code += ch
            blank += ch
            i++
            continue
        }
    }

    return { code, blank }
}


/**
 * 去註解(保留換行, 以空白取代註解內容, 使行號不位移); 字串內與正規式字面值內之 // 不是註解
 *
 * @param {String} src 輸入原始碼字串
 * @returns {String} 回傳去註解後之字串, 長度與行數與原始碼相同
 */
function stripComments(src) {
    return lex(String(src)).code
}


//將已抹空字串之文字依最外層逗號切段, 回傳各段 { s, e }(索引區間, 不含逗號)
function splitTopLevel(s) {
    let segs = []
    let d = 0
    let start = 0
    for (let i = 0; i < s.length; i++) {
        let ch = s[i]
        if (ch === '(' || ch === '[' || ch === '{') {
            d++
        }
        else if (ch === ')' || ch === ']' || ch === '}') {
            d--
        }
        else if (ch === ',' && d === 0) {
            segs.push({ s: start, e: i })
            start = i + 1
        }
    }
    segs.push({ s: start, e: s.length })
    return segs
}


//整個字串由一對配對的括號包住時去掉最外層括號(反覆), 否則原樣回傳
function unwrapParens(b) {
    while (b.startsWith('(') && b.endsWith(')') && takeBalanced(b, 0).length === b.length) {
        b = b.slice(1, -1).trim()
    }
    return b
}


//解析函式字面值(function、箭頭、async 皆可); 回傳 { type: 'block' | 'expr', inner } 或 null(不是函式字面值)
function parseFn(b) {
    let s = b.replace(/^async\s+/, '')
    let m = /^function\b\s*[\w$]*\s*\(/.exec(s)
    let rest
    if (m) {
        let params = takeBalanced(s, m[0].length - 1)
        rest = s.slice(m[0].length - 1 + params.length).trim()
        if (rest.startsWith('{') && takeBalanced(rest, 0, '{', '}').length === rest.length) {
            return { type: 'block', inner: rest.slice(1, -1).trim() }
        }
        return null
    }
    if (s.startsWith('(')) {
        rest = s.slice(takeBalanced(s, 0).length).trim()
    }
    else {
        m = /^[\w$]+/.exec(s)
        if (!m) {
            return null
        }
        rest = s.slice(m[0].length).trim()
    }
    if (!rest.startsWith('=>')) {
        return null
    }
    rest = rest.slice(2).trim()
    if (rest.startsWith('{') && takeBalanced(rest, 0, '{', '}').length === rest.length) {
        return { type: 'block', inner: rest.slice(1, -1).trim() }
    }
    return { type: 'expr', inner: rest }
}


/**
 * 分類 catch 本體或錯誤處理函式(純函式; 帳本 R22.3、R22.7)
 *
 * 先把字串、樣板字串與正規式字面值內容抹空(字串中的 throw、process.exit(1)、函式呼叫字樣不算), 再判斷:
 * propagate: 含 throw、process.exit(非 0)、process.exitCode = 非 0 → 錯誤會反映為非 0 離開碼(不計);
 * swallow-log: 含 console.log/error/warn/info 而不傳遞(包含 process.exit(0)、process.exitCode = 0; 本體為函式字面值或 console.log 本身皆算);
 * swallow-silent: 本體為空(空區塊、`() => {}`、`function(e){}`、`async () => {}`)、僅回傳常數(`=> null`、`=> undefined`、`=> void 0`、`=> false`、`=> 0`、`=> ''`、`=> []`、`=> ({})`)、
 *   或函式字面值且本體僅 `return`/`return x`(不含任何函式呼叫、throw、process.exit、process.exitCode);
 * other: 其餘(如 `.catch(retry)`、本體含函式呼叫), 不計入吞錯站點, 僅列出供人工看.
 *
 * @param {String} body 輸入本體字串(`.catch(...)` 為含括號之引數字串, try/catch 為含大括號之區塊, then 第二引數與 process.on handler 為函式字面值)
 * @returns {String} 回傳 'propagate'、'swallow-silent'、'swallow-log' 或 'other'
 */
function classifyBody(body) {
    let b = lex(String(body)).blank.replace(/\s+/g, ' ').trim()
    if (RE_PROPAGATE.test(b)) {
        return 'propagate'
    }
    b = unwrapParens(b)
    let hasConsole = /console\.(log|error|warn|info)/.test(b)

    //try/catch 的區塊本體
    let fn = null
    if (b.startsWith('{') && takeBalanced(b, 0, '{', '}').length === b.length) {
        fn = { type: 'block', inner: b.slice(1, -1).trim() }
    }
    if (fn === null) {
        fn = parseFn(b)
    }

    if (fn === null || hasConsole) {
        return hasConsole ? 'swallow-log' : 'other'
    }
    if (fn.type === 'block') {
        if (fn.inner === '' || /^return(?:\s+[^;(){}]*)?;?$/.test(fn.inner)) {
            return 'swallow-silent'
        }
        return 'other'
    }
    return RE_CONST_EXPR.test(fn.inner) ? 'swallow-silent' : 'other'
}


/**
 * 掃描單一腳本原始碼中的吞錯候選站點(純函式; 帳本 R22.2、R22.8、R22.9)
 *
 * 站點種類: '.catch'(`.catch(` 之引數)、'try-catch'(catch 區塊; 參數可為解構)、'then-onRejected'(`.then(a, b)` 之第二引數)、
 * 'process.on'(`process.on('unhandledRejection' | 'uncaughtException', handler)` 之 handler).
 *
 * @param {String} src 輸入原始碼字串
 * @returns {Array} 回傳站點陣列, 每項 { kind, line, cls, body }, line 為原始碼行號, cls 見 classifyBody, body 為截短之去註解原文
 */
function scanScriptSource(src) {
    let { code, blank } = lex(String(src))
    let items = []
    let oneLine = (s) => s.replace(/\s+/g, ' ').slice(0, 90)
    let lineAt = makeLineAt(blank)

    let m
    let re = /\.catch\s*\(/g
    while ((m = re.exec(blank)) !== null) {
        let open = m.index + m[0].length - 1
        let len = takeBalanced(blank, open).length
        let body = code.slice(open, open + len)
        items.push({ kind: '.catch', line: lineAt(m.index), cls: classifyBody(body), body: oneLine(body) })
    }

    let re2 = /(?<![.\w])catch\s*(?:\([^()]*\))?\s*\{/g
    while ((m = re2.exec(blank)) !== null) {
        let open = m.index + m[0].length - 1
        let len = takeBalanced(blank, open, '{', '}').length
        let body = code.slice(open, open + len)
        items.push({ kind: 'try-catch', line: lineAt(m.index), cls: classifyBody(body), body: oneLine(body) })
    }

    //取呼叫引數並依最外層逗號切段; 回傳各段之去註解原文(已 trim)
    let argsOf = (open) => {
        let len = takeBalanced(blank, open).length
        let inner = blank.slice(open + 1, open + len - 1)
        return _.map(splitTopLevel(inner), (sg) => code.slice(open + 1 + sg.s, open + 1 + sg.e).trim())
    }

    let re3 = /\.then\s*\(/g
    while ((m = re3.exec(blank)) !== null) {
        let args = argsOf(m.index + m[0].length - 1)
        if (_.size(args) >= 2 && args[1] !== '') {
            items.push({ kind: 'then-onRejected', line: lineAt(m.index), cls: classifyBody(args[1]), body: oneLine(args[1]) })
        }
    }

    let re4 = /\bprocess\s*\.\s*(?:on|once|addListener)\s*\(/g
    while ((m = re4.exec(blank)) !== null) {
        let args = argsOf(m.index + m[0].length - 1)
        if (_.size(args) >= 2 && /^(['"`])(?:unhandledRejection|uncaughtException)\1$/.test(args[0]) && args[1] !== '') {
            items.push({ kind: 'process.on', line: lineAt(m.index), cls: classifyBody(args[1]), body: oneLine(args[1]) })
        }
    }

    return _.sortBy(items, 'line')
}


/**
 * 對套件清單逐一掃描 script.txt 之 node 列所指腳本(唯讀)
 *
 * @param {Array} ps 輸入套件陣列, 每項須含 name 與 path
 * @returns {Object} 回傳 { sites, others, missing, noScript, repos, scripts }:
 *   sites 為吞錯站點(swallow-log、swallow-silent)陣列, 每項 { repo, script, line, kind, cls };
 *   others 為 other 類站點(供人工看); missing 為 node 列所指但不存在之腳本 { repo, script };
 *   noScript 為無 script.txt 之套件名陣列; repos 為有吞錯站點之套件數; scripts 為實際掃描之腳本數
 */
function checkBuildScripts(ps) {
    let sites = []
    let others = []
    let missing = []
    let noScript = []
    let scripts = 0

    _.each(ps, (p) => {
        let c
        try {
            c = fs.readFileSync(path.resolve(p.path, 'script.txt'), 'utf8')
        }
        catch (err) {
            noScript.push(p.name)
            return true
        }
        let rels = []
        _.each(parseScript(c), (ln) => {
            if (ln.kind !== 'node') {
                return true
            }
            let rel = _.get(_.split(_.trim(_.trim(ln.cmd).slice(5)), /\s+/), 0, '')
            if (rel !== '' && !_.includes(rels, rel)) {
                rels.push(rel)
            }
        })
        _.each(rels, (rel) => {
            let fp = path.resolve(p.path, rel)
            let src
            try {
                src = fs.readFileSync(fp, 'utf8')
            }
            catch (err) {
                missing.push({ repo: p.name, script: rel })
                return true
            }
            scripts++
            _.each(scanScriptSource(src), (it) => {
                let row = { repo: p.name, script: rel, line: it.line, kind: it.kind, cls: it.cls }
                if (it.cls === 'swallow-log' || it.cls === 'swallow-silent') {
                    sites.push(row)
                }
                else if (it.cls === 'other') {
                    others.push(row)
                }
            })
        })
    })

    return { sites, others, missing, noScript, repos: _.size(_.uniq(_.map(sites, 'repo'))), scripts }
}


/**
 * 執行預檢並組出報告與離開碼(唯讀; 供進入點 g_checkBuildScripts.mjs 印出)
 *
 * 報告格式: 一行一站點 `<套件> | <腳本> | <行號> | <kind> | <類別>`; 末尾彙總行 `吞錯站點: N 個 repo、M 處` 或 `無吞錯站點`.
 *
 * @param {Array} ps 輸入套件陣列, 每項須含 name 與 path
 * @returns {Object} 回傳 { code, lines }, code 有吞錯站點為 1 否則 0, lines 為報告各行字串
 */
function runCheckBuildScripts(ps) {
    let r = checkBuildScripts(ps)
    let lines = []
    _.each(r.sites, (s) => {
        lines.push(`${s.repo} | ${s.script} | ${s.line} | ${s.kind} | ${s.cls}`)
    })
    _.each(r.others, (s) => {
        lines.push(`[人工看] ${s.repo} | ${s.script} | ${s.line} | ${s.kind} | ${s.cls}`)
    })
    _.each(r.missing, (s) => {
        lines.push(`[腳本不存在] ${s.repo} | ${s.script}`)
    })
    if (_.size(r.noScript) > 0) {
        lines.push(`[無 script.txt] ${_.join(r.noScript, ', ')}`)
    }
    lines.push(`已掃描腳本: ${r.scripts} 個`)
    if (_.size(r.sites) > 0) {
        lines.push(`吞錯站點: ${r.repos} 個 repo、${_.size(r.sites)} 處`)
    }
    else {
        lines.push('無吞錯站點')
    }
    return { code: _.size(r.sites) > 0 ? 1 : 0, lines }
}


export {
    stripComments,
    classifyBody,
    scanScriptSource,
    checkBuildScripts,
    runCheckBuildScripts
}
