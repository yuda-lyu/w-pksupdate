import _ from 'lodash-es'
import w from 'wsemi'
import execProcess from 'wsemi/src/execProcess.mjs'


async function ectScripts(pdi, scps, opt={}) {
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

    args = [
        `cd "${pdi.path}"`,
        // `pwd`, //顯示當前工作路徑會延遲顯示, 故會出現於最末
        ...scps,
    ]
    args = _.join(args, ' ; ') //合併為整行指令
    // console.log('args', args)

    let c = ''
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

    //執行指令時訊息會混合使用cbStdout與cbStderr, 先掛載即時顯示, 合併後回傳再供外部使用判斷
    await execProcess(prog, ['-Command', args], { cbStdout, cbStderr }) //指定'-Command'時可將後面參數字串視為須全部執行之整行指令
        .catch(() => { })

    //若指定主要指令類型為npm, 偵測輸出含npm error即視為失敗(npm失敗必印npm error且benign噪音為npm warn前綴, 不會誤殺)
    if (_.get(opt, 'main') === 'npm') {
        if (c.indexOf('npm error') >= 0) {
            throw new Error(`[${pdi.name}] npm指令失敗: ${_.join(scps, ' ; ')}\n${c}`)
        }
    }

    //若指定主要指令類型為node, 偵測輸出含[RollupError]即視為rollup編譯失敗(toolg腳本catch後console.log錯誤且exit=0, 無法靠exit code偵測; 不可用裸字樣is not exported by, 成功建置之警告亦有該字樣會誤殺)
    if (_.get(opt, 'main') === 'node') {
        if (c.indexOf('[RollupError]') >= 0) {
            throw new Error(`[${pdi.name}] rollup編譯失敗: ${_.join(scps, ' ; ')}\n${c}`)
        }
    }

    return c
}


export default ectScripts
