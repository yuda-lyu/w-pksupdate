import fs from 'fs'
import _ from 'lodash-es'
import w from 'wsemi'


async function ectScripts(pdi, scps) {
    // pdi {
    //   name: 'w-serv-broadcast',
    //   path: 'D:\\- 006 -        開源\\開源-JS-007-4-w-serv-broadcast/w-serv-broadcast',
    //   version: '1.0.17',
    //   update: true,
    //   dependencies: [],
    //   devDependencies: [ { name: 'w-converhp', verOld: '^2.0.17', verNew: '^2.0.18' } ]
    // }

    if (!w.isarr(scps)) {
        scps = [scps]
    }

    let prog = 'powershell'
    let args = []
    let c = ''

    // args = ['ls']
    // c = await w.execScript(prog, args)
    // console.log(c)

    // args = ['pwd']
    // c = await w.execScript(prog, args)
    // console.log(c)

    // args = [`cd "${pdi.path}"`]
    // c = await w.execScript(prog, args)
    // console.log(c)

    // args = ['npm i']
    // let c = await w.execScript(prog, args)
    // console.log(c)

    // args = [`cd "${pdi.path}" ; pwd ; npm i`]
    // let c = await w.execScript(prog, args)
    // console.log(c)

    args = [
        `cd "${pdi.path}"`,
        // `pwd`, //顯示當前工作路徑會延遲顯示, 故會出現於最末
        ...scps,
    ]
    args = _.join(args, ' ; ')
    c = await w.execScript(prog, args)
    console.log(c)

}


export default ectScripts
