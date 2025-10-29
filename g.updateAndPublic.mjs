import _ from 'lodash-es'
import w from 'wsemi'
import publishPackages from './src/publishPackages.mjs'
import checkProjectLevels from './src/checkProjectLevels.mjs'
import sortProjectLevels from './src/sortProjectLevels.mjs'


let ps = checkProjectLevels()
// console.log('ps', ps)

let names = [

    'w-pubsub',

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
    'w-dwdata-builder',
    'w-dwdata-ftp',
    'w-dwdata-tweq',
    'w-dwdata-tweqod',
    'w-dwdata-tweqmp',

    'w-converhp',
    'w-serv-broadcast',
    'w-serv-orm',
    'w-sync-webdata',
    'w-serv-webdata',
    'w-serv-hapi',

    'w-web-sso',
    'w-web-perm',
    'w-web-api',

]

let nameLevels = sortProjectLevels(ps, names, { returnObj: true })
console.log('nameLevels', nameLevels)

names = _.map(nameLevels, 'name')

await publishPackages(names)
    .then(() => {
        console.log(`>>> finish all`)
    })
    .catch((err) => {
        console.log(err)
    })


//node g.updateAndPublic.mjs
