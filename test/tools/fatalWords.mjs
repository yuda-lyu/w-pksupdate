//守望器比對之致命字樣(CLAUDE.md §7.4): 出現任一即被當成中止; 只定義一次, 供重試訊息(帳本 R9)與留痕訊息(帳本 R13)之測試共用
let reFatal = /npm指令失敗|node指令失敗|rollup編譯失敗|建置產物遭刪除|npm上找不到|非預期指令|rm指令失敗|Vue packages version mismatch/


export { reFatal }
