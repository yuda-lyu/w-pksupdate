# 累積經驗

本檔為執行工作時特有之累積經驗,留給後續之嘗試、執行與判斷,由agent自行編列、擴充與維護.

## 一、指令列成敗判定(2026-10-13 事項三審計所得;證據與腳本見 `tmp/ect判定-全盤.md`、`tmp/audit-ect/`)

1. **PowerShell 5.1 `-Command` 之離開碼只有 0/1**:取最末陳述之 `$?`,原生程式之 3、2、13 一律壓成 1;要保留原值須在結尾傳 `$LASTEXITCODE`.
2. **裸 `exit $LASTEXITCODE` 會遮蔽失敗**:最末陳述若不是原生程式(如找不到指令),`$LASTEXITCODE` 為 `$null`,`exit $null` 即 exit 0.PATH 少了 node 時,建議書之 b+c 會把整列判為成功(實測).成熟 CI 之寫法是開頭 `$ErrorActionPreference = 'Stop'`、結尾 `if ((Test-Path -LiteralPath variable:\LASTEXITCODE)) { exit $LASTEXITCODE }`(GitHub Actions 與 Azure Pipelines PowerShell@2 皆此).
3. **`cd "<路徑>"` 失敗不會中止**:後續指令在呼叫端 cwd 執行,實測為 w-pksupdate 根目錄——此時 `git add/commit/push` 會作用在 **w-pksupdate 自身**,`npm i` 會改寫 w-pksupdate 之 node_modules.`Set-Location -LiteralPath '...'` 配 `$ErrorActionPreference='Stop'` 才會不執行並 exit 1.
4. **npm 12 之 `npm run <script>` 腳本失敗不印 `npm error`**:只回非 0 離開碼;`npm error` 只出現在 npm 自身錯誤(Missing script、E403、ETARGET、相依套件 gyp).以字樣判 npm 列已不可靠(run22 w-web-perm build、run49 w-sync-webdata deploy 皆因此漏擋).
5. **jsdoc 4.0.5 之 `ERROR:` 會 exit 1 但文件照產**:「來源路徑不存在」與「@example 缺值」兩種皆實測如此;近兩輪仍有 8 個套件(w-pubsub 等)屬之.故 `.bin` 列不可單純以離開碼判定.
6. **判定用文字不可逐塊補換行**:execProcess 之回呼以讀取塊為單位(約 64KB),`c += cdata + '\n'` 會把跨邊界之 `[RollupError]`/`npm error` 拆散;沙箱 66 次中漏 6 次.各串流原樣串接即無此問題.
7. **`$ErrorActionPreference='Stop'` 不會因原生程式寫 stderr 而中止**(PowerShell 5.1、呼叫端未在 PowerShell 內重導 stderr):node、npm、.ps1 墊片、git 之 stderr 原樣輸出,離開碼原樣傳出.
8. **多指令一次送只看最末列**:`g_checkAndCommit.mjs` 三列 git 合一次呼叫,中間失敗不影響離開碼(任何組法皆然).
9. **wsemi 1.8.65 → 1.9.14**:`execProcess` 離開碼語意(非 0 即 reject `code[N]`)、`pmSeries` 首錯即停皆未變;變的是串流解碼與 resolve 字串不再補換行(不影響 ectScripts,因其自行以回呼累積).
10. **wsemi 1.9.14 → 1.9.15(2026-10-14)**:`execProcess` 之拒絕值全為字串,程序無法啟動時由 Error 物件改為 `spawn[錯誤碼]:\n<node 之錯誤說明>`(非同步錯誤之說明含執行檔名,同步錯誤如 ENAMETOOLONG/UNKNOWN 不含,參數檢查錯誤已去除參數值),摘要須接第二行(R12)才看得出是哪個程式;EMFILE/ENFILE 不再因存取未建立之 stdio 而崩潰(1.9.14 會以 TypeError reject 並留未捕捉例外);外部 `taskkill /F` 結束子程序得 `code[1]` 而非 `code[null]`.連帶教訓:2026-10-13 以前之 ectScripts 以 `.catch(() => { })` 丟棄拒絕值,歷史 log 不能證明「無法啟動從未發生」;以 node `execSync` 執行含 `^` 之 git 修訂(如 `0a1d611^`)會被 cmd.exe 當跳脫字元吃掉,一律寫 `0a1d611~1`.

## 二、沙箱實測 runScript 之作法

1. **checkNpmVersion 必須換掉**:沙箱套件名不在 npm,原樣呼叫會重試 2400 次×3 秒.用 `node --import ./tmp/audit-ect/hooks/register.mjs`(`module.registerHooks` 之 resolve 掛鉤)把 `src/checkNpmVersion.mjs` 換成樁,`src/runScript.mjs` 本身原樣不改;要比對原型時再以環境變數 `ECT_PROTO` 換 `src/ectScripts.mjs`.
2. **沙箱 script.txt 之禁忌**:不可含 git、deploy、npm publish 列,**也不可含 `#npm publish`、`#node toolg/addVersion.mjs`**——runScript 會把這兩種註解改寫成真的執行(`src/runScript.mjs:36-43`).寫入前以正則擋下.
3. 以 `_trace.txt`(每支沙箱腳本開頭附加自身檔名)判斷「失敗列之後的列是否仍被執行」,比看回傳值可靠.
4. 真實之 RollupError 與字串 reject 可直接以 w-package-tools repo 之 `src/rollupFiles.mjs` 產生(動態 import 其絕對路徑,fdTar 指沙箱);jsdoc 可借其他套件 node_modules 之 `jsdoc/jsdoc.js` 以絕對路徑執行,輸出寫沙箱.

## 三、歷史 log 之判讀

1. `tmp/publish_all*.log` 只記輸出、**不記離開碼**;「已被觀察」只能以輸出特徵(stack、`Error:`、`ENOENT`)與發布紀錄(`+ pkg@ver`、`>>> finish`)推定.
2. 每段指令輸出會在 `useNode:::`/`useBin:::`/`useGit:::`/`useNpm:::` 之後**重印一次**,計數時只取重印之前的部分,否則加倍.
3. log 夾帶 NUL,`grep` 要加 `-a`(Grep 工具會在 NUL 處停止,改用 Bash `grep -a` 或 node 讀檔).
4. bash `cut -c` 對中文以位元組切,取套件名改用 `${b#開源-JS-???-?-}`.
5. 已知 benign 噪音(可不必停下):w-backup 之 `./node_modules/.bin/pkg` 每輪 `> Error! No available node version satisfies 'node24'`(產物不入版控也不入 npm 包);w-maplibregl-vue 每輪 commit 之 `error: task 'gc' failed`(該 repo 有指向壞物件之 `refs/codex/...`,commit 本身成功);8 個套件之 jsdoc `ERROR:`.

## 四、實作與測試(2026-10-13 run02 所得)

1. **「於任何副作用之前中止」要看整條呼叫鏈,不只 runScript**:publishPackage 在 runScript 之前已先 updatePackage(改寫 package.json)與 `npm i`;只在 runScript 開頭檢查仍會落入 §7.6 之重跑略過陷阱.故 `loadScript` 須在 publishPackage 之 updatePackage 前呼叫,runScript 開頭再呼叫一次(直接呼叫 runScript 時亦受保護).
2. **runScript／publishPackage 之整合測試一律放子程序**:以 `node --import ./test/tools/hooksStub.mjs` 換掉 checkNpmVersion(publishPackage 另換 getFolders/parseProject/getUpdate/updatePackage/ectScripts).若在 mocha 同程序內呼叫,一旦回歸使失敗列被放行,就會走到 checkNpmVersion 查 npm 重試 2 小時,mocha 卡死不結束.
3. **錯誤訊息會回顯指令本身**:斷言「某輸出未出現」時,要比對輸出特有之樣式(例 `cwd=` 後接磁碟機代號),不可比對指令文字也含有之字樣(首版測試即因此誤紅).
4. **重試訊息不可含致命字樣**:守望器以 `npm指令失敗` 等字樣判中止,若重試訊息帶出錯誤首行,可自癒之重試會被誤當中止.已抽成 `getRetryMessage` 並以單元測試釘住.
5. **`npm i -D <pkg>` 會順手把 devDependencies 依字母重排**(本次 `eslint-plugin-import` 與 `eslint-plugin-n` 對調),diff 會多出一對行,屬正常.
6. **npm 12 預設封鎖相依套件之 install scripts**(`npm warn install-scripts … blocked because they are not covered by allowScripts`):近兩輪全庫連動之每個套件 `npm i` 都有此警告(core-js、@parcel/watcher 等),連動照常完成,未見影響;若日後有建置依賴相依套件之 postinstall 產物而失敗,會由 node 列之離開碼判定攔下.
7. **全庫 script.txt 之唯讀總檢**:以 `parseScript` 解析 118 個 script.txt,2026-10-13 為 0 個非預期指令(rm 列只有 w-package-tools、w-package-tools-e2e 之 `rm -r docs`).可作為開跑前檢查.

## 五、2026-10-16 第 41 項審計與修正所得(證據在 `tmp/audit-pksu/`,run02 修正報告見主控 agent-out)

1. **Windows 下刪除重試**:`fs.rmSync(..., { maxRetries })` 對 EPERM 不重試(0~1ms 即拋);`fs.promises.rm` 的重試不受 `maxRetries×retryDelay` 約束,永久占用時 122 秒才返回(單檔被 `FileShare.None` 開啟時等到占用者離開才「成功」)——比失敗更糟;被 cwd 占用的資料夾連 `rename` 也 EPERM,改名繞道不可行.只有自寫同步迴圈(`Atomics.wait`)是有界的.junction/symlink 在 docs 內或 docs 本身皆不被穿越(套件外檔案不受影響);唯讀屬性檔可刪.
2. **`fs.rmSync` 的錯誤訊息與 `err.path` 在路徑含非 ASCII(「開源」)時為亂碼**(`¶}·½`、U+FFFD);`unlinkSync`/`rmdirSync` 的則正常.訊息一律用已知路徑加 `err.code`,不引用 `err.message`.
3. **自接 catch 的失敗輸出分兩種**:Error 物件(RollupError、babel SyntaxError、fs 錯誤、`can not clean folder`)印出時帶堆疊框,可結構判定;字串拒絕(`invalid fpSrc…`)與 `throw '字串'` 無堆疊,只能靠固定字串或無法判定.babel 的 SyntaxError **不含 `[RollupError]`**,原寫法會漏.`UNRESOLVED_IMPORT`/`WPT_*` 是 RollupError(`Error [RollupError]: …`,`pluginCode` 另見),`console.log(err)` 下原本就會被攔.
4. **堆疊框正則不可寬鬆**:`^\s+at\s+\S.*:\d+:\d+$` 會誤傷 `    at the end of the build 12:30:45` 之類時間戳行;位置須像路徑或網址(`scheme://`、`node:`、磁碟機代號、`/`、`./`、`../`).逐行比對並設長度上限(2000),避免病態長行平方級退化.以 42 份歷史 log 之 11,211 個 node 區塊驗證:命中 27 個皆為真失敗,其餘 0 命中.
5. **歷史評估過而否決的產物層硬閘**:「發布 commit 完全未動 dist」誤判 117/3,480(3.4%);「追蹤檔消失而無同名〔去 hash〕產出」32/3,480(多為合法改名合併).兩者只能當留痕,不能當硬閘.主檔(`main`/`module`/`browser`)存在且非空現況 118 個套件 0 誤判.
6. **測試注入優先於子程序加掛鉤**:`runScript`/`publishPackage`/`checkNpmVersion` 的 `opt` 注入讓同一行程內可走完呼叫點;但**測試含 git、npm publish 列時須有第二道保險**——測試期間自 PATH 移除 powershell 所在目錄,使任何注入失效時的真實執行在啟動就失敗(spawn ENOENT),且 fixture 之 package.json 設 `private: true`.`writeScript` 之 `stubbed:true` 才可寫入這類列.
7. **對 HEAD 程式跑「修前紅」之安全邊界**:新測試檔若靠注入(`opt.exec`、`opt.deps`)而 HEAD 程式會忽略該參數,對 HEAD 跑會**真的執行 git/publish、掃描套件區、或無限重試**——只能跑對 HEAD 安全的檔案(其餘改以變異驗證:在現行實作副本上單點破壞,確認對應測試轉紅;26 個變異 0 存活).修前紅用 `tmp/redRun.mjs`(HEAD src 副本加新匯出名空殼).
8. **src 為 CRLF**(`.editorconfig end_of_line=crlf`)而 git blob 為 LF:對 `src/` 做字串替換之腳本須先判斷換行符;以 Write 新建之檔案為 LF,收尾時須轉 CRLF 保持一致.`.md` 檔本為 LF.
9. **`du`、遞迴統計不可對含 junction 之夾使用**(會穿越掃描他 repo 之 node_modules);清除沙箱副本須先 `fs.rmdirSync(junction)` 再刪副本.
10. **全庫 script.txt 之結構事實(2026-10-16 實掃)**:118 個皆含 `#node toolg/addVersion.mjs` 與 `#npm publish` 且前者在後;對外列(git、deploy、publish)之後沒有建置類 node 列;列種類統計 node 557、bin 118、git 354、npm 239、rm 2、註解 126.`rm -r docs` 只有 w-package-tools 與 w-package-tools-e2e,但 w-package-tools 無自有套件依賴(`getUpdate` 判準:自有套件依賴版本字串落後才 `update=true`),不進連動集合,實際經本工具執行者只有 w-package-tools-e2e.

11. **兩輪外審所得(2026-10-17;opus + sol 共 26 點、第二輪 opus 再審 9 點,報告見 `tmp/review/{opus,sol,opus2}/review.md`)**:
    - **孤兒孫程序(脫離、繼承 stdout)會讓 `execProcess` 逾時殺樹後仍等管道關閉才落定**(實測 21.5 秒),且**落定後主行程仍不結束**(事件迴圈被管道拖住):需兩道處置——`ectScripts` 以 `Promise.race` 加寬限(R18.6)使 Promise 落定,入口再 `exitAfterFlush` 強制結束(R16.4).收攏孤兒本身須 Job Object,PPID 走訪做不到.
    - **Windows 的 `existsSync` 跟隨連結**:懸空 junction 回 false,據此回報「不存在」會留下連結;判存在用 `lstat`.`realpathSync`(JS 版)保留輸入大小寫,比對用 `.native` 且不分大小寫.`fs.rmSync(recursive)` 對 junction 只移除連結本身(實測),但祖先經 junction 逸出時會刪到套件外.
    - **「豁免」要寫成能反例的白名單,不是前綴**:首輪把所有 `(node:<pid>)` 開頭的行當診斷標頭豁免,連 `UnhandledPromiseRejectionWarning: Error…`(`--unhandled-rejections=warn` 下未處理的建置失敗,exit 0)也豁免,等於修了誤判卻引入漏判(opus2 N1).豁免清單要列「已知良性」而非「排除已知惡性」,並以真 Node 輸出做測試.
    - **以測試手段觀測「無殘留」要確認觀測本身有效**:`Get-CimInstance` 的非終止錯誤(PermissionDenied、命名空間不存在)只印 stderr 而 exit 0、`Measure-Object` 仍輸出 0,假綠;加 `$ErrorActionPreference='Stop'` 才會拋出並改為 skip.殘留計數用唯一標記,不用全機萬用字元.
    - **入口解析比照 Node 要照 Node 的順序**:`tryFile → tryExtensions(.js/.json/.node) → index`;不補 `.mjs/.cjs`;資料夾名同時有同名 `.js` 時先補副檔名.只寫「比照 Node」而自擬順序會同時造成漏判與誤擋.
    - **修正本身需再審一輪**:修正輪動了約 1000 行,第二輪仍找出 1 個回歸(N1)與 1 個未修好(F14);全庫真實資料(118 個 script.txt/package.json、11,211 個歷史區塊、557 個建置腳本)對照是抓回歸的第二道網——本輪新規則對真實資料皆 0 誤擋.

12. **run04 事故與測試環境守衛(2026-10-17 第 5 次執行;帳本 R25)**:
    - **安全網不可依賴「各測試檔自行加」**:run04 新測試漏加 PATH 安全網、又呼叫了尚未支援注入之 `publishPackages`,走了真實全庫連動,真的發布 2 個套件.守衛改在 src 內(`isTestEnv()` 四訊號,fail-closed),任何以 mocha 執行之測試——含單檔、含新檔——自動涵蓋;全域規範禁用 `.mocharc.json`,故不用 mocha 設定檔.PATH 無 PowerShell 的全域 root hook 只是第二道.
    - **證明「未注入即拋錯」的測試自己必須對變異安全**:該測試若在測試行程內呼叫真實站點,拔掉守衛的變異就是事故重演.改在子程序呼叫,站點「之下一層」由掛鉤換成只寫紀錄的 spy(`STUB_MODE=guard`),並有**對照組**(同子程序、去掉測試旗標)證明 spy 有接上、『無呼叫』不是空轉.變異驗證只對這種檔做,絕不對全套測試拿掉守衛.
    - **守衛會被「吞例外後略過」的 catch 吃掉**:`runScript` 的 dist 閘門 catch 把『其他例外』當成『跳過檢查』,守衛錯誤因此被吞、流程續行到注入的 exec.守衛錯誤帶 `testGuard` 標記,此類 catch 須先 `isTestGuardError` 重拋;每個延遲守衛(使用時才擋者)都要有自己的站點案,不能只測入口.
    - **盤點要機械化**:新接縫(子行程、網路、寫檔、`getFolders`)未登錄於 `unit-testGuard` 之盤點表即紅;『刻意真實執行』與『直接匯入 child_process』兩份清單用 deepStrictEqual 釘死,新增者必須經審查才會變綠.
    - **Git Bash 的 `grep -c $'\r$'` 不可用來判斷 CRLF**(MSYS grep 會吃掉 CR,每行都命中):用 node 計 `\r\n`.Write 新建之檔為 LF,`.editorconfig` 要求 CRLF,收尾須轉換;Edit 工具保留原檔換行.
    - **mocha 全域行為注意**:root 層 `before`/`after`(不屬任何 describe)寫在被 glob 載入之檔,對同一次執行之全部測試檔生效,單檔執行則只有該檔自己的 root hook;因此不能把安全寄託於 root hook,只能當第二道.
    - **`quiet-run.mjs` 在 `C:/opensrcOper/tools/`**(提示詞曾寫成 `C:/opensrc/tools/`,不存在).

## 六、方法上的教訓

1. 建議書之選項要逐一實跑,不要只看它想解決的那一格:選項 c 解決了「離開碼被壓成 1」,卻在「找不到指令」那一格造成遮蔽——只有把組法 × 失敗形態整張表跑完才看得到.
2. 盤點自接 catch 時,grep 樣式要涵蓋同族函式名:附錄 A 用 `rollupWorker\(` 就漏了 `rollupWorkerCore(`(w-component-vue).用「腳本 × 所有 `.catch(`/`catch {`」之結構掃描,不要用函式名清單.

## 七、倉庫設定與同時發布(2026-10-28 pks-run01)

1. **`npm test` 會把 npm 自己的設定匯出成 `npm_config_*` 環境變數給子行程**(含 `npm_config_registry`):測試若要驗「環境變數優先於專案 `.npmrc`」或「未設定時為 unset」,必須在測試內暫時移除該變數(含大小寫變體)再還原;只用 `this.skip()` 閃避會讓這兩案在 `npm test` 下永遠 pending(第一版即如此,全套顯示 3 pending 才發現,基準為 1).
2. **WHATWG `URL` 會悄悄改寫輸入**:空白、`"`、`` ` ``、`<`、`>`、`{`、`}` 在路徑中被編成 `%20`、`%22`…;只驗標準化後的 `href` 會把使用者原本含非法字元的位址放行成另一個位址.位址白名單要對**輸入原文與標準化結果**各驗一次.`'`、`$`、`(`、`)`、`;`、`|`、`&` 則不會被編碼,白名單可直接擋.
3. **測試守衛盤點牽動範圍**:新增含 `execSync` 的檔案(`registryConfig.mjs`)須同時改 `unit-testGuard.test.mjs` 的 `TABLE`(守衛文字 + 匯出清單釘死)、`SITES`(子程序 + spy 站點)、`guardCase.mjs`(spy 驅動)與站點矩陣斷言;`publishPackages` 新增必注入鍵(`resolveRegistryConfig`)須同步 `MISSING` 逐鍵表.對照組(正式模式)的 `resolveRegistryConfig` 取父行程給的 `W_PKSUPDATE_REGISTRY`,不啟動真 npm.測試檔不得出現正式入口檔名(盤點案),靜態掃描「是否含入口檔」改用 `/^g_u.*\.mjs$/` 之類不含全名的寫法.
4. **修前紅取證不用 stash/checkout**:`git archive HEAD | tar -x -C ./tmp/pks-run01/orig`,再把新版測試檔複製進去跑;副本位於專案 `./tmp/` 之下,模組解析會往上找到專案根的 `node_modules`,不需連接點.副本的 quiet-run log 落在副本自己的 `tmp/quiet-run/`.
5. **鏡像失敗訊息會含守望字樣**:`ectScripts` 的失敗訊息首行為 `[套件] npm指令失敗(…)`,若原樣印出,守望器會把可容忍的鏡像失敗當成連動中止.摘要一律取 `npm error` 行並經 `neutralizeFatal` 中和;「已存在同版本」只認明確字樣——停權帳號回的 403 與『權限不足』的 403 無法與『已存在』的 403 區分,故單獨 403 不算已同步.
6. **真實只讀驗證的做法**:`resolveRegistryConfig()` 取本機 `npm config get registry`,`checkNpmVersion` 對私有倉庫(Verdaccio)查 `<倉庫><name>/<version>`、`<倉庫><name>`(`accept: application/vnd.npm.install-v1+json`)、metadata 的 `dist.tarball` 及其 HEAD,四項全過;不存在的版本回 404.Verdaccio 兩端點與 tarball HEAD 皆可用,不需特殊處理.
7. **跨套件掃描**:`C:/opensrc` 下以 Glob 工具掃 `開源-JS-*/*/script.txt` 會逾時(目錄含大量檔案),改用 Bash `ls -d /c/opensrc/開源-JS-*/*/script.txt | xargs grep …`(只列目標檔,秒回).
8. **派工 terra 讀中文檔**:`rg -n '^' -- <檔>` 完好;`-m` 等選項須放在 `--` 之前,放在其後會被當成檔名(探測時即犯,rg 報「系統找不到指定的檔案」但仍輸出其餘結果).
9. **npm 的倉庫選擇優先序比預期多一層**:`npm publish` 會把 `package.json` 的 `publishConfig` 套到發布選項,僅命令列旗標更高——`publishConfig.registry` 壓過 `npm_config_registry`(`npm/lib/commands/publish.js` 約第 298 行);scoped 套件適用 `@scope:registry`;旗標可用唯一前綴縮寫(`--reg`)與引號形式(PowerShell 去引號後 npm 才收到).只用環境變數指定倉庫不夠,須在執行前檢查拒絕這些覆寫來源.
10. **npm 對「已存在」有兩則相近訊息**:`You cannot publish over the previously published versions: X`(本版已存在)與 `Cannot implicitly apply the "latest" tag because previously published version X is higher…`(較高版本已存在,本版未發布).判「已存在視為已同步」不可只比對 `previously published version` 片語.
11. **外審有效處**:terra(max)23 條中 18 屬實、5 部分屬實、0 誤報;最有價值的是我自認完整之盤點仍漏的「覆寫來源」(publishConfig、scope、旗標縮寫)與正則誤判(第 10 點).變異驗證(複製 src+test 至 `./tmp/pks-run01/mut/`,以 Write 寫的腳本套用變異並要求替換恰一處)是證明新增測試真的會紅的低成本作法,不必動 repo 檔案.
12. **`src/**` 內任何檔案出現 `spawn`、`execSync` 等接縫關鍵字(含正則字面或註解以外的字串)都會觸發盤點案**:`mirrorPublish.mjs` 曾因正則字面 `spawn\[…\]` 被判為新接縫;寫成不含關鍵字的通用形(`/\(([a-z]+\[[^\]]*\])/`)即可.
