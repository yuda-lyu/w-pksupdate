# 現況(state)

本檔記 w-pksupdate 當前已開發功能之最新狀態(只記現況、不寫過程;過程寫入 `sgud/exp/experience.md`,藍圖在 `sgud/rule/rulebook.md`)。接續工作先讀本檔。

- 最近一次更新:2026-10-28(pks-run01:倉庫設定與同時發布〔鏡像〕、堆疊框行尾 `{`)
- 最近一次驗證:2026-10-28 全套 `npm test` 1129 passing、1 pending、0 failing(pending 為既有 `it.skip` R15.7 已知落差);修前紅證據 9 failing(HEAD 副本);變異驗證 10 個變異全被測試殺死;外審(terra,max)23 條,屬實 18、部分屬實 5、誤報 0,可修者已修(見 rulebook 二)
- 真實只讀驗證:`resolveRegistryConfig()` 取本機主倉庫(私有 Verdaccio),`checkNpmVersion` 查 `w-mousekey@1.0.43` → true(四項全過)、`9.9.9` → false(404)
- 版本/發布:本套件 `package.json` 版本 1.0.0,不發布至 npm(工具庫,`main` 不存在);程式變更尚未 commit(由主控提交檢查點)
- 工作樹:除 `src/`、`test/`、`g_*.mjs` 外,新增 `README.md`、`sgud/state/state.md`;`.npmignore`、`sgud/` 仍為未追蹤(依全域 §14 `sgud/` 納入版控、`CLAUDE*.md` 不入版控)

## 入口

| 入口 | 狀態 |
|---|---|
| `g_updateAndPublic.mjs` | 全庫連動發布;離開碼 0/1(R16);新增 `optRegistry` 倉庫選項(R27) |
| `g_listUpdates.mjs` | 唯讀預覽;`getUpdate` 拋錯者列「未能判定」並 exit 1(R23) |
| `g_checkProjectLevels.mjs` | 唯讀 Level 預檢 |
| `g_checkBuildScripts.mjs` | 唯讀建置腳本吞錯預檢(R22);預期 exit 0 |
| `g_checkAndCommit.mjs` | 逐套件 checkGitStatus,有變更 commit+push(手動) |
| `g_test_checkNpmVersion.mjs` | 手動探測上架確認(經 `resolveRegistryConfig` 取倉庫) |

## 功能狀態(功能 → 規則帳本 → 測試檔 → 缺口)

| 功能 | 帳本 | 測試檔 | 狀態與缺口 |
|---|---|---|---|
| 指令列成敗判定(node/npm/git/.bin、離開碼、spawn、堆疊框/固定字串特徵) | 一 R1~R15、R6 | `unit-ectScripts*.test.mjs`、`unit-runScript*.test.mjs` | 已實作。殘餘盲區:自接 catch 只印訊息/靜默 catch 無特徵(R15.7,由 `g_checkBuildScripts` 與源頭修改處理)。**2026-10-28:`RE_STACK_FRAME` 行尾容許 ` {`(單框堆疊+屬性區塊)已補** |
| deploy 與 git push 網路類失敗重試、push spawn 失敗撤回 | R9、R26 | `unit-runScript*.test.mjs`、`unit-publishPackage-restore.test.mjs` | 已實作 |
| dist 閘門、建置主檔閘門、版本遞增閘門、必要列/列序 | R10、R17、R20 | `unit-runScript-gates.test.mjs`、`unit-runScript-mainfiles.test.mjs`、`unit-runScript-outward.test.mjs` | 已實作;主檔 mtime 目前只留痕不擋(R17.2) |
| 每列逾時與寬限、`rm -r` 重試 | R14、R18 | `unit-ectScripts*.test.mjs`、`unit-runScript-ps.test.mjs` | 已實作;孤兒孫程序持管道時須人工清除(已知限制) |
| 第一個遠端列之前中止即還原 package.json/lock | R21 | `unit-publishPackage*.test.mjs` | 已實作;鏡像不改變還原邊界(R27.4) |
| 確認上架(重試、逾時、牆鐘上限、例外視為尚未就緒) | R19、R27.3 | `unit-checkNpmVersion.test.mjs` | 已實作;**查 `opt.registry` 指定之主倉庫(必給)** |
| git 起跑預檢 | R24 | `unit-checkGit.test.mjs`、`unit-publishPackages.test.mjs` | 已實作 |
| 測試環境守衛(真實執行路徑未注入即中止) | R25 | `unit-testGuard.test.mjs`、`test/tools/*` | 已實作;新增接縫須登錄盤點表(本輪新增 `registryConfig.npmConfig`) |
| 離開碼與 `exitAfterFlush` | R16 | `unit-runMain.test.mjs` | 已實作 |
| 守望字樣單一來源 | 1.1 | `unit-fatalWords.test.mjs` | 已實作;CLAUDE.md §7.4 的 grep 清單須同步 |
| **倉庫設定(主倉庫/鏡像、環境變數與選項、位址正規化)** | **二 R27.1、R27.2** | `unit-registryConfig.test.mjs`、`unit-publishPackage.test.mjs`、`unit-publishPackages.test.mjs`、`unit-ectScripts*.test.mjs` | **已實作(2026-10-28)**:預設取 `npm config get registry`;安裝依賴/發布/上架確認一律用主倉庫;子行程 npm 以 `npm_config_registry` 為準 |
| **同時發布(鏡像)與結束摘要** | **二 R27.4** | `unit-mirrorPublish.test.mjs`、`unit-runScript-registry.test.mjs`、`unit-publishPackages.test.mjs` | **已實作(2026-10-28)**:主發布成功後逐一發布;失敗只警告;已存在視為已同步;結束(含中止)印摘要 |
| script.txt 不得自帶 `--registry` | 二 R27.5 | `unit-runScript-registry.test.mjs` | 已實作 |

## 已知缺口與待辦

- 私有倉庫為內網位址時,`npm i` 寫入各套件 `package-lock.json` 的 `resolved` 會隨 `git add -A` 進入公開庫(rulebook 2.4)——待主控裁示。
- 鏡像失敗無重試、無自動補發(僅摘要);每個鏡像各自打包(現有套件皆無 lifecycle,理論風險)。
- 鏡像閘門(版本/建置主檔)不通過時該鏡像不發布並列入摘要、連動繼續(評審建議改為中止,屬設計取捨,待主控裁示,見 rulebook 2.4)。
- 發布列形態:僅支援 `npm publish` 與 `--tag` 等簡單參數;`npm --loglevel warn publish`、縮寫、`--dry-run`、發布他處目錄不在列辨識範圍(舊有限制)。
- `checkNpmVersion` 不帶 npm 認證,倉庫須允許匿名讀取(連續 401/403 達 20 次即停止等待)。
- 已於執行前檢查拒絕:npm 列自帶倉庫旗標(含縮寫/引號/scope 形)、`publishConfig.registry`、scoped 套件名。
- `CLAUDE.md` 多處敘述以 npmjs 為前提(§6.1 探針、§7.3 傳播延遲、§7.9),且 §7.4 守望器未涵蓋 `[mirror]` 摘要;依約本輪不改 `CLAUDE.md`,待主控更新。
- 真實連動(`node g_updateAndPublic.mjs`)在新倉庫設定下尚未實跑:本輪僅以單元/整合測試與對真實私有倉庫的只讀上架確認驗證,由主控實跑。

## 測試對照

- 全套:`npm test`(`mocha --no-parallel "test/*.test.mjs" --timeout 180000`,約 2 分鐘)。
- 改動範圍 → 必跑:`src/ectScripts.mjs`、`src/runScript.mjs`、`src/publishPackage.mjs`、`src/publishPackages.mjs`、`src/checkNpmVersion.mjs`、`src/registryConfig.mjs`、`src/mirrorPublish.mjs`、`src/runMain.mjs`、`src/checkBuildScripts.mjs` 任一改動後跑全套。
- 本套件無瀏覽器 e2e。
