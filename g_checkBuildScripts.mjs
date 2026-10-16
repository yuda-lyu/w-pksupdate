import getFolders from './src/getFolders.mjs'
import parseProject from './src/parseProject.mjs'
import { runCheckBuildScripts } from './src/checkBuildScripts.mjs'


//唯讀預檢(帳本R22): 掃描套件區各套件 script.txt 之 node 列所指腳本, 列出自接 catch 而吞錯(失敗時離開碼仍為0)之站點.
//完全唯讀: 不寫檔、不執行任何指令. 有吞錯站點離開碼為1, 無則0. 開跑前清單見 CLAUDE.md §6.
let ps = parseProject(getFolders())

let r = runCheckBuildScripts(ps)
for (let s of r.lines) {
    console.log(s)
}
process.exitCode = r.code


//node g_checkBuildScripts.mjs
