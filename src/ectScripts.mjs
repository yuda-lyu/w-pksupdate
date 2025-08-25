import _ from 'lodash-es'
import w from 'wsemi'
import execProcess from 'wsemi/src/execProcess.mjs'


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

    args = [
        `cd "${pdi.path}"`,
        // `pwd`, //顯示當前工作路徑會延遲顯示, 故會出現於最末
        ...scps,
    ]
    args = _.join(args, ' ; ') //合併為整行指令
    // console.log('args', args)

    let cbStdout = (cdata) => {
        // console.log('stdout', cdata)
        console.log(cdata)
        c += cdata + '\n'
    }
    let cbStderr = (cdata) => {
        // console.log('stderr', cdata)
        console.log(cdata)
        c += cdata + '\n'
    }

    //執行指令時訊息會混合使用cbStdout與cbStderr, 故統一攔截與回傳再判斷
    await execProcess(prog, ['-Command', args], { cbStdout, cbStderr }) //指定'-Command'時可將後面參數字串視為須全部執行之整行指令
        .catch(() => { })

    return c
}


export default ectScripts
