// import _ from 'lodash-es'
// import w from 'wsemi'
import publishPackages from './src/publishPackages.mjs'


// let names = []
let names = [
    'w-converhp',
    'w-serv-broadcast',
    'w-serv-orm',
    'w-sync-webdata',
    'w-serv-webdata',
    'w-serv-hapi',
]

await publishPackages(names)
    .then(() => {
        console.log(`finish all`)
    })
    .catch((err) => {
        console.log(err)
    })


//node --experimental-modules g.mjs
