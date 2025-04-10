import fs from 'fs'
import _ from 'lodash-es'
import w from 'wsemi'
import getFolders from './getFolders.mjs'
import parseProject from './parseProject.mjs'
import getUpdate from './getUpdate.mjs'
import updatePackage from './updatePackage.mjs'
import ectScripts from './ectScripts.mjs'
import runScript from './runScript.mjs'


async function publishPackage(names) {
    // names = [
    //   'w-converhp',
    //   'w-serv-broadcast',
    //   'w-serv-orm',
    //   'w-sync-webdata',
    //   'w-serv-webdata',
    //   'w-serv-hapi',
    // ]

    let fds = getFolders()
    let ps = parseProject(fds)

    if (_.size(names) === 0) {
        names = _.map(ps, 'name')
    }

    let publish = false
    for (let k = 0; k < _.size(names); k++) {

        let name = names[k]

        let pdi = getUpdate(ps, name)

        if (pdi.update) {
            console.log('pdi', pdi)

            //執行[update package.json]
            updatePackage(pdi)

            //執行[npm i]
            await ectScripts(pdi, `npm i`)

            //執行[script]
            await runScript(pdi, `update pks`)

            publish = true
            console.log(`publish: ${name}`)

            break //更新套件須跳出, 因為更新依賴資訊清單須重算
        }
    }

    return publish
}


export default publishPackage
