// import _ from 'lodash-es'
import w from 'wsemi'


async function checkNpmVersionCore(name, version) {

    //查metadata
    console.log(`checking metadata...${name}@${version}`)
    let url = `https://registry.npmjs.org/${encodeURIComponent(name)}/${version}`
    let res = await fetch(url)
    if (!res.ok) {
        console.log(`${name}@${version} metadata not found: ${res.status}`)
        return false
    }

    //查tarball
    console.log(`checking tarball...${name}@${version}`)
    let body = await res.json()
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
    for (let i = 0; i <= 100; i++) {
        if (i >= 1) {
            console.log(`重新檢測第 ${i} 次...`)
        }

        //checkNpmVersionCore
        b = await checkNpmVersionCore(name, version)

        //check
        if (b) {
            break
        }

        await w.delay(2000)
    }

    return b
}


export default checkNpmVersion
