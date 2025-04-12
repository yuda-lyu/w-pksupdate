import publishPackage from './publishPackage.mjs'


async function publishPackages(names) {
    // names = [
    //   'w-converhp',
    //   'w-serv-broadcast',
    //   'w-serv-orm',
    //   'w-sync-webdata',
    //   'w-serv-webdata',
    //   'w-serv-hapi',
    // ]

    let b = await publishPackage(names)
    while (b) { //有更新就繼續, 直到無法更新為止
        b = await publishPackage(names)
    }

}


export default publishPackages
