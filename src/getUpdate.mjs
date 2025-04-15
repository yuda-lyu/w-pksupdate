import fs from 'fs'
import _ from 'lodash-es'
import w from 'wsemi'
import JSON5 from 'json5'


function getUpdate(ps, nameTar) {
    // ps = [
    //   {
    //     name: 'w-package-tools',
    //     path: 'D:\\- 006 -        開源\\開源-JS-001-1-w-package-tools/w-package-tools',
    //     level: '1'
    //   },
    //   {
    //     name: 'wsemi',
    //     path: 'D:\\- 006 -        開源\\開源-JS-002-3-wsemi/wsemi',
    //     level: '3'
    //   },
    //   ...
    // ]

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

    let kp = {}
    _.each(pis, (pi) => {
        kp[pi.name] = pi
    })

    let getVersionByName = (name) => {
        let version = _.get(kp, `${name}.version`, '')
        return version
    }

    let getLevelByName = (name) => {
        let level = _.get(kp, `${name}.level`, '')
        return level
    }

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
            //nameTar為當前套件名, name為當前依賴套件名

            let verNew = getVersionByName(name)

            if (!w.isestr(verNew)) {
                return true //跳出換下一個
            }

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

            let levelMain = getLevelByName(nameTar)
            if (!w.isnum(levelMain)) {
                console.log('nameTar', nameTar)
                throw new Error(`套件[${nameTar}]無法查到依賴層級level`)
            }
            levelMain = w.cint(levelMain)

            let levelDep = getLevelByName(name)
            if (!w.isnum(levelDep)) {
                console.log('name', name)
                throw new Error(`套件[${name}]無法查到依賴層級level`)
            }
            levelDep = w.cint(levelDep)

            if (levelMain < levelDep) {
                throw new Error(`套件[${nameTar}]依賴層級level[${levelMain}] < 套件[${name}]依賴層級level[${levelDep}]`)
            }

        })

    })
    // console.log('pdi', pdi)

    return pdi
}


export default getUpdate
