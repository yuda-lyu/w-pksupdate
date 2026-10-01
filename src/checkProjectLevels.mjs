import path from 'path'
import fs from 'fs'
import _ from 'lodash-es'
import w from 'wsemi'
import getFolders from './getFolders.mjs'
import parseProject from './parseProject.mjs'
import getLevelWant from './getLevelWant.mjs'


function checkProjectLevels() {

    let fds = getFolders()
    // console.log('fds', fds)

    let ps = parseProject(fds)
    // console.log('ps', ps)

    let ls = []
    let kpLevel = {}
    _.each(ps, (v) => {

        //package
        let fp = path.resolve(v.path, 'package.json')
        let j = fs.readFileSync(fp, 'utf8')
        let o = w.j2o(j)
        // console.log(v.name, 'o', o)

        //push
        ls.push({
            ...v,
            kpDep: {
                ...o.dependencies,
                ...o.devDependencies,
            },
        })

        //save
        kpLevel[v.name] = w.cint(v.level)

    })
    // console.log('ls', ls)

    _.each(ls, (v) => {

        //levelSelf
        let levelSelf = w.cint(v.level)

        //kpLevelDep, levelDepMax
        let kpLevelDep = {}
        let levelDepMax = 0
        let levelDepMaxName = ''
        _.each(v.kpDep, (verDep, nameDep) => {

            //levelDep
            let levelDep = _.get(kpLevel, nameDep, '')

            //check
            if (w.isint(levelDep)) {

                //save
                kpLevelDep[nameDep] = levelDep

                //取最大
                if (levelDepMax < levelDep) {
                    levelDepMax = levelDep
                    levelDepMaxName = nameDep
                }

            }

        })

        //check
        if (levelDepMax === 0) {
            return true //跳出換下一個
        }

        //check
        if (levelSelf <= levelDepMax) {
            throw new Error(`套件[${v.name}]的Level[${levelSelf}] <= 依賴套件[${levelDepMaxName}]的Level[${levelDepMax}]`)
        }

        //levelWant: 依Level定義規則算應有Level(與g_checkProjectLevels共用同一判準, 見CLAUDE.md §4)
        let levelWant = getLevelWant(v.name, levelDepMax)

        //check
        if (levelSelf !== levelWant) {
            throw new Error(`套件[${v.name}]的Level[${levelSelf}] 應該為 [${levelWant}](依賴套件[${levelDepMaxName}]的Level[${levelDepMax}])`)
        }

        // console.log(`套件[${v.name}]的Level[${levelSelf}], 依賴最高Level套件[${levelDepMaxName}]的Level[${levelDepMax}]`)
    })

    return ps
}


export default checkProjectLevels
