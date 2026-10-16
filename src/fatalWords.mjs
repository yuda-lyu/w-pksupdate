/**
 * 守望器致命字樣清單(CLAUDE.md §7.4 的 grep 內容之程式側單一來源; 帳本 R19.4、1.1)
 *
 * 守望器以這些字樣判定「主程序被某個 throw 中止」. 凡來自外部、不受控的文字(如 HTTP 回應本文被 SyntaxError 引述)
 * 在印出前須經 neutralizeFatal 中和, 否則可自癒之重試行會被守望器誤當成中止.
 * 新增字樣時須同步: test/tools/fatalWords.mjs 之獨立正規式、CLAUDE.md §7.4 之 grep 清單(unit-fatalWords 釘住前兩者一致).
 */
const FATAL_WORDS = [
    'npm指令失敗',
    'node指令失敗',
    'rollup編譯失敗',
    '建置產物遭刪除',
    'npm上找不到',
    '非預期指令',
    'rm指令失敗',
    'Vue packages version mismatch',
    '指令逾時',
    '建置主檔異常',
    '版本未遞增',
    'script.txt缺少必要列',
    'script.txt列序不符',
    'git指令失敗',
]


/**
 * 中和字串內的致命字樣(純函式): 於每個致命字樣的首字之後插入零寬空白(U+200B), 人眼與原文幾乎相同, 但不再被 grep/正規式命中
 *
 * @param {*} s 輸入任意值, 轉為字串; null 與 undefined 視為空字串
 * @returns {String} 回傳中和後之字串; 冪等(已中和者再次呼叫不變)
 */
function neutralizeFatal(s) {
    let t = s === null || s === undefined ? '' : String(s)
    for (let word of FATAL_WORDS) {
        t = t.split(word).join(word[0] + '​' + word.slice(1))
    }
    return t
}


export { FATAL_WORDS, neutralizeFatal }
