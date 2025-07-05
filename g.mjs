// import _ from 'lodash-es'
// import w from 'wsemi'
import publishPackages from './src/publishPackages.mjs'


// let names = []
let names = [
    //原則給予順序是level[1位]小放前面, 再來才放type[3位]小放前面
    //雖然是無限查找有更新就更新:
    // 但有些是devDependencies依賴前者套件, 至少須給與相同level, 若dependencies依賴前者套件就一定要給予大於level
    // 因devDependencies有出現新版依然會更新與發布, 即便非必要, 所以names盡量給予level由小至大的順序, 減少自動化時非必要之更新發布

    'w-data-csv',
    'w-dwdata-binance',
    'w-data-syncer',

    'w-converhp',
    'w-serv-broadcast',
    'w-serv-orm',
    'w-sync-webdata',
    'w-serv-webdata',
    'w-serv-hapi',

    // 'w-web-api',
    // 'w-web-perm',
    // 'w-web-sso',

]

await publishPackages(names)
    .then(() => {
        console.log(`>>> finish all`)
    })
    .catch((err) => {
        console.log(err)
    })


//node g.mjs
