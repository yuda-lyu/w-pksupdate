import fs from 'fs'
import _ from 'lodash-es'
import w from 'wsemi'
import JSON5 from 'json5'


function getUpdate(ps, nameTar) {

    let pis = _.map(ps, (p) => {

        let fppk = `${p.path}/package.json`

        let j = fs.readFileSync(fppk, 'utf8')

        let o = JSON5.parse(j)
        // console.log('o', o)

        let version = _.get(o, 'version', '')
        if (!w.isestr(version)) {
            throw new Error(`套件[${p.name}]的package.json無法取得version`)
        }

        //dependencies
        let dependencies = _.get(o, 'dependencies', {})

        //devDependencies
        let devDependencies = _.get(o, 'devDependencies', {})

        let pi = {
            ...p,
            version,
            dependencies,
            devDependencies
        }

        return pi
    })
    // console.log('pis', pis)

    let kpName = {}
    _.each(pis, (pi) => {
        kpName[pi.name] = pi.version
    })

    let piTar = null
    _.each(pis, (pi) => {
        if (pi.name === nameTar) {
            piTar = pi
        }
    })

    if (piTar === null) {
        throw new Error(`找不到套件[${nameTar}]`)
    }

    let pdi = {
        name: piTar.name,
        path: piTar.path,
        version: piTar.version,
        update: false,
        dependencies: [],
        devDependencies: [],
    }

    let dks = [
        'dependencies',
        'devDependencies',
    ]
    _.each(dks, (dk) => {

        _.each(piTar[dk], (verOld, name) => {

            if (!w.haskey(kpName, name)) {
                return true //跳出換下一個
            }

            let verNew = kpName[name]
            verNew = `^${verNew}`
            // console.log('verNew', verNew)

            if (verNew !== verOld) {
                // console.log(name, verOld, verNew)
                pdi.update = true
                pdi[dk].push({
                    name,
                    verOld,
                    verNew,
                })
            }

        })

    })
    // console.log('pdi, pdi)

    return pdi
}


export default getUpdate
