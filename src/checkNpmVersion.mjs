// import _ from 'lodash-es'
import w from 'wsemi'


async function checkNpmVersionCore(name, version) {

    //查主清單內是否有指定name與version
    //url帶時變query繞過CDN快取(packument之Cache-Control為max-age=300, 重試打同一URL會一直命中舊快取; 帶不同query使CF-Cache-Status由HIT變MISS直達origin, 2026-07-27實測)
    console.log(`checking metadata...${name}@${version}`)
    let urlNV = `https://registry.npmjs.org/${encodeURIComponent(name)}/${version}?t=${Date.now()}`
    let resNV = await fetch(urlNV)
    if (!resNV.ok) {
        console.log(`${name}@${version} metadata not found: ${resNV.status}`)
        return false
    }

    //查主清單內是否有包含version
    console.log(`checking versions list...${name}@${version}`)
    let urlList = `https://registry.npmjs.org/${encodeURIComponent(name)}?t=${Date.now()}`
    let resList = await fetch(urlList, {
        headers: { 'accept': 'application/vnd.npm.install-v1+json' },
    })
    if (!resList.ok) {
        console.log(`${name} versions list not ready: ${resList.status}`)
        return false
    }
    let listJson = await resList.json()
    if (!listJson?.versions?.[version]) {
        console.log(`${name}@${version} not in versions list`)
        return false
    }

    //查tarball
    console.log(`checking tarball...${name}@${version}`)
    let body = await resNV.json()
    let tarball = body.dist?.tarball
    if (!tarball) {
        console.log(`${name}@${version} tarball missing`)
        return false
    }

    //查tarball是否可抓
    console.log(`checking tarball head...${name}@${version}`)
    let headRes = await fetch(tarball, { method: 'HEAD' })
    if (!headRes.ok) {
        console.log(`${name}@${version} tarball not ready yet: ${headRes.status}`)
        return false
    }

    return true
}

async function checkNpmVersion(name, version) {

    let b = false
    for (let i = 0; i <= 300; i++) {
        if (i >= 1) {
            console.log(`重新檢測第 ${i} 次...`)
        }

        //checkNpmVersionCore
        b = await checkNpmVersionCore(name, version)

        //check
        if (b) {
            break
        }

        await w.delay(3000)
    }

    return b
}


export default checkNpmVersion
