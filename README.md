# w-pksupdate

依賴連動發布工具:掃描「同層套件區」(所有 `開源-JS-*` 套件),依相依關係判斷哪些套件的相依版本落後,對落後者依 level 由低到高逐一更新 `package.json`、`npm i`、建置、`git push`、`gh-pages` 部署、`npm publish`,並確認新版已上架;發布一個會 bump 版本使其下游落後,迴圈重掃直到全部對齊.

使用與監測要點見專案內部文件(`CLAUDE.md`,不入版控);本檔說明**倉庫設定**與**同時發布**.

## 入口

| 指令 | 用途 |
|---|---|
| `node g_listUpdates.mjs` | 唯讀預覽:會發布哪些套件(不更新、不發布) |
| `node g_checkProjectLevels.mjs` | 唯讀:套件資料夾 Level 標示檢查 |
| `node g_checkBuildScripts.mjs` | 唯讀:建置腳本吞錯預檢 |
| `node g_updateAndPublic.mjs` | 全庫連動更新與發布(**對外且不可逆**,須明確授權) |
| `npm test` | 單元與整合測試(不對任何套件執行 git、deploy、npm publish、npm i) |

## 倉庫設定

安裝依賴(`npm i`)、確認新版已上架、發布(`npm publish`)所用之倉庫由**倉庫設定**決定,程式碼內不寫死任何倉庫位址(含 npmjs).

### 主倉庫

安裝依賴、發布、確認上架一律用主倉庫.取值優先序:

1. `g_updateAndPublic.mjs` 之 `optRegistry.registry`
2. 環境變數 `W_PKSUPDATE_REGISTRY`
3. 本機 npm 設定:`npm config get registry`(**預設**)

解析失敗(npm 取不到 registry、位址無效)會明確報錯並中止,**不會默默退回 npmjs**.起跑時印一行 `[registry] 主倉庫: …(來源: …); 同時發布之鏡像: …`,可核對本輪用的是哪個倉庫.

發布時各子行程之 npm 以主倉庫為準(以 `npm_config_registry` 環境變數指定,優先於使用者與套件層 `.npmrc`),不受執行機其他設定影響.以下會使發布/安裝落到設定以外之倉庫,故於執行前檢查拒絕(不改動任何檔案):

- `script.txt` 內之 npm 列自帶倉庫旗標(`--registry`、其縮寫如 `--reg`、引號包住之寫法、`--@scope:registry`);
- 套件 `package.json` 含 `publishConfig.registry`(npm 規定它優先於環境變數);
- scoped 套件(`@scope/name`;本工具僅支援無 scope 套件)。

**確認上架**查主倉庫的 `<主倉庫><套件名>/<版本>` 與 `<主倉庫><套件名>` 兩個端點(npmjs 與 Verdaccio 皆支援),四項檢查(metadata、versions list、tarball、tarball HEAD)全過才算上架.這些請求**不帶 npm 認證**(倉庫須允許匿名讀取);若主倉庫連續回 401/403 達 20 次(約 1 分鐘)即判定為認證問題並停止等待,不會空等數小時.

### 位址格式

僅接受 `http://` 或 `https://` 位址,會正規化(主機轉小寫、結尾補 `/`、移除預設埠).拒收:非 http(s)、含帳密(`user:pw@`)、含查詢字串或片段、含空白、逗號與 shell 特殊字元、IPv6 字面位址;選項型別錯誤(`registry` 非字串、`mirrors` 非字串/字串陣列)同樣報錯,不會悄悄改用下一順位.帳密與權杖請放 npm 設定檔(`.npmrc`),不要放進位址.

### 鏡像倉庫(同時發布)

預設**不啟用**.啟用後,主倉庫的 `npm publish` 成功後,對每個鏡像再執行 `npm publish --registry=<鏡像>`(保留原列的 `--tag` 等參數).

啟用方式(擇一,選項優先於環境變數):

```js
// g_updateAndPublic.mjs
let optRegistry = {
    registry: 'http://localhost:4873/',          // 主倉庫(可省略,省略則取 npm 設定)
    mirrors: ['https://registry.npmjs.org/'],    // 同時發布之鏡像,可多個
}
```

```powershell
$env:W_PKSUPDATE_REGISTRY = 'http://localhost:4873/'
$env:W_PKSUPDATE_MIRRORS  = 'https://registry.npmjs.org/'   # 多個以逗號分隔
node g_updateAndPublic.mjs
```

**例:主倉庫用私有倉庫(Verdaccio),同時發布 npmjs**——本機 npm 設定的 registry 指向私有倉庫(預設),再設定 `W_PKSUPDATE_MIRRORS=https://registry.npmjs.org/`,並確認本機 npm 已登入 npmjs(鏡像的認證由 npm 設定檔依主機區分).不需要同時發布時不設即可.

鏡像的行為:

- **鏡像失敗不使該套件失敗、不中止連動**:印一行警告,並於連動結束(含中止)時彙整成摘要,列出哪些套件版本沒發到哪個鏡像與錯誤原文(截短),供日後補發:

  ```
  [mirror] 摘要: 鏡像 https://registry.npmjs.org/; 發布成功 40 筆、已存在視為已同步 1 筆、未同步 2 筆
  [mirror] 未同步清單(補發: 於該套件目錄執行 npm publish --registry=<鏡像>):
  [mirror]   w-example@1.0.3 → https://registry.npmjs.org/: code E403 | 403 Forbidden - PUT …
  ```

- 鏡像已存在同版本(npmjs 的 `cannot publish over the previously published versions`、Verdaccio 的 409)視為已同步,不算失敗.單獨的 403(權限、停權)不算已同步.
- 確認上架只查主倉庫,鏡像不列入等待條件;鏡像每列逾時 10 分鐘,不重試.逾時後仍未落定者,摘要標「狀態未知」(子程序樹可能仍在執行).
- 每個鏡像發布前仍重過對外列閘門(版本已遞增、建置主檔存在),並重驗版本仍等於主倉庫剛發布者;不通過則該鏡像記為未同步而不發布.
- 每個鏡像各自執行 `npm publish`、各自打包;若套件有內容不確定的 `prepublishOnly`/`prepack` 等 lifecycle,各倉庫同版本內容可能不同(現有套件皆無此類 lifecycle).

### 注意

- 以私有倉庫執行 `npm i` 後,`package-lock.json` 內來自私有倉庫的套件,其 `resolved` 會記錄私有倉庫的 tarball 位址;連動以 `git add -A` 提交,若私有倉庫是內網位址,該位址會進入公開 GitHub 庫.請於發布前確認.
- 換機器須改 `src/getFolders.mjs` 之 `pfd`(套件區根目錄),詳見專案內部文件.

## 測試

```bash
npm test
```

測試中的倉庫位址為虛構位址(`http://localhost:<port>/`、`*.example.test`)或公開位址(例如 `https://registry.npmjs.org/` 作為鏡像範例),測試皆不連線;測試環境下真實執行路徑(啟動 PowerShell、git、npm、網路)未經注入一律於副作用前中止(`src/testGuard.mjs`).

## 授權

MIT
