import _ from 'lodash-es'
import w from 'wsemi'
import checkProjectLevels from './src/checkProjectLevels.mjs'
import sortProjectLevels from './src/sortProjectLevels.mjs'
import publishPackages from './src/publishPackages.mjs'
import runMain, { exitAfterFlush } from './src/runMain.mjs'


let ps = checkProjectLevels()
// console.log('ps', ps)

let names
names = [

    // 'w-pubsub',

    // 'w-zip',

    // 'w-dwload-m3u8',
    // 'w-dwload-dlp',
    // 'w-ldap',
    // 'w-kriging',
    // 'w-opencc',

    // 'w-data-mseed',
    // 'w-data-csv',
    // 'w-data-syncer',
    // 'w-dwdata-binance',

    'w-data-scheduler',
    'w-data-syncer',
    // 'w-dwdata-builder',
    // 'w-dwdata-ftp',
    // 'w-dwdata-tweq',
    // 'w-dwdata-tweqod',
    // 'w-dwdata-tweqmp',

    // 'w-converhp',
    // 'w-serv-broadcast',
    // 'w-serv-orm',
    // 'w-sync-webdata',
    // 'w-serv-webdata',
    // 'w-serv-hapi',

    // 'w-web-sso',
    // 'w-web-perm',
    // 'w-web-api',

]
names = []

let nameLevels = sortProjectLevels(ps, names, { returnObj: true })
console.log('nameLevels', nameLevels)

names = _.map(nameLevels, 'name')

//倉庫設定(帳本R27; 詳見README〈倉庫設定〉): 不給任何值時, 主倉庫取本機npm設定(npm config get registry), 不同時發布鏡像.
//覆寫順序: 此處選項 > 環境變數(W_PKSUPDATE_REGISTRY主倉庫、W_PKSUPDATE_MIRRORS鏡像, 多個以逗號分隔) > npm設定
let optRegistry = {
    // registry: 'http://localhost:4873/', //主倉庫(安裝依賴、發布、確認上架皆用它)
    // mirrors: ['https://registry.npmjs.org/'], //同時發布之鏡像: 主倉庫發布成功後再發至此(可多個), 失敗只警告並於結束摘要列出
}

//中止時錯誤照常印出且無`>>> finish all`, 但離開碼為1(帳本R16; 原寫法.catch只印出, 中止時離開碼為0)
process.exitCode = await runMain(() => publishPackages(names, optRegistry))

//逾時寬限到期而孤兒仍持有輸出管道時, 主行程不會自行結束(帳本R16.4): 排空輸出後強制以該離開碼結束
await exitAfterFlush(process.exitCode)


//node g_listUpdates.mjs

//node g_updateAndPublic.mjs

//請幫我執行 node checkProjectLevels.mjs, 看套件庫是否有level編錯

//請幫我執行與監測 node g_updateAndPublic.mjs, 要點詳見本專案內之CLAUDE.md
