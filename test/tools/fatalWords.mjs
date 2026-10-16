//守望器比對之致命字樣(CLAUDE.md §7.4): 出現任一即被當成中止; 只定義一次, 供重試訊息(帳本 R9)、留痕訊息(帳本 R13)與其他不得誤觸守望器之訊息(R17 留痕、R19 檢測例外)之測試共用
//2026-10-16 新增: 指令逾時(R18)、建置主檔異常(R17)、版本未遞增與 script.txt缺少必要列(R20)、script.txt列序不符(R20.5)
//2026-10-17 新增: git指令失敗(git 列依子命令判定: spawn、離開碼 ≥128、push 任何非 0 等, 帳本 R6.2)
//本正規式刻意獨立於 src/fatalWords.mjs 之 FATAL_WORDS, 由 test/unit-fatalWords.test.mjs 釘住兩者為同一集合(若改為 import 同一份, 就測不出清單被改壞)
let reFatal = /npm指令失敗|node指令失敗|rollup編譯失敗|建置產物遭刪除|npm上找不到|非預期指令|rm指令失敗|Vue packages version mismatch|指令逾時|建置主檔異常|版本未遞增|script\.txt缺少必要列|script\.txt列序不符|git指令失敗/


export { reFatal }
