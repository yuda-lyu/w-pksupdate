import fs from 'fs'
import _ from 'lodash-es'
import w from 'wsemi'
import ectScripts from './ectScripts.mjs'


async function runScript(pdi, msg = 'update pks') {
    // pdi {
    //   name: 'w-serv-broadcast',
    //   path: 'D:\\- 006 -        開源\\開源-JS-007-4-w-serv-broadcast/w-serv-broadcast',
    //   version: '1.0.17',
    //   update: true,
    //   dependencies: [],
    //   devDependencies: [ { name: 'w-converhp', verOld: '^2.0.17', verNew: '^2.0.18' } ]
    // }

    let fpscp = `${pdi.path}/script.txt`

    let c = fs.readFileSync(fpscp, 'utf8')
    // console.log('c', c)

    let scps = w.sep(c, '\n')
    console.log('scps', scps)

    await w.pmSeries(scps, async (v) => {

        let t1 = '#node toolg/addVersion.mjs'
        let t2 = `git commit -m 'modify: '`
        let t3 = '#npm publish'

        if (v === t1) {
            v = w.strdelleft(v, 1)
            // console.log('t1', v)
        }
        else if (v === t3) {
            v = w.strdelleft(v, 1)
            // console.log('t3', v)
        }
        else if (v === t2) {
            v = `git commit -m 'modify: ${msg}'`
            // console.log('t2', v)
        }

        // console.log('cmd', v)
        if (w.strleft(v, 1) === '#') {
            return //直接跳出
        }
        // console.log('cmd(det)', v)

        let useNode = w.strleft(v, 5) === 'node '
        if (useNode) {
            console.log(`${pdi.name} >>> exec: `, v)
            await ectScripts(pdi, v)
                .catch((err) => {
                    // console.log('useNode', err)

                    let e1 = `Browserslist: caniuse-lite is outdated.`
                    if (err.indexOf(e1) >= 0) {
                        //rollup編譯提示caniuse-lite報錯, 不視為錯誤
                        console.log(err) //err為正常訊息
                        return
                    }

                    let e2 = `Creating a browser bundle that depends on Node.js built-in modules`
                    if (err.indexOf(e2) >= 0) {
                        //rollup編譯提示前端套件會依賴Node.js內建模組報錯, 不視為錯誤
                        console.log(err) //err為正常訊息
                        return
                    }

                    throw new Error(err)
                })
            return //直接跳出
        }

        let useBin = w.strleft(v, 20) === './node_modules/.bin/'
        if (useBin) {
            console.log(`${pdi.name} >>> exec: `, v)
            await ectScripts(pdi, v)
                .catch((err) => {
                    // console.log('useBin', err)

                    let e1 = `ERROR: Unable to find the source file or directory`
                    if (w.strleft(err, _.size(e1)) === e1) {
                        //jsdoc報錯, 不視為錯誤
                        console.log(err) //err為正常訊息
                        return
                    }

                    throw new Error(err)
                })
            return //直接跳出
        }

        let useGit = w.strleft(v, 4) === 'git '
        if (useGit) {
            console.log(`${pdi.name} >>> exec: `, v)
            await ectScripts(pdi, v)
                .catch((err) => {
                    // console.log('useGit', err)

                    let e1 = `warning: LF will be replaced by CRLF`
                    if (err.indexOf(e1) >= 0) {
                        //git自動取代crlf報錯, 不視為錯誤
                        console.log(err) //err為正常訊息
                        return
                    }

                    let e2a = `remote: GitHub found`
                    let e2b = `vulnerabil` //可能有單數, 不要用複數vulnerabilities偵測
                    if (err.indexOf(e2a) >= 0 && err.indexOf(e2b) >= 0) {
                        //git push時偵測vulnerabilities報錯, 不視為錯誤
                        console.log(err) //err為正常訊息
                        return
                    }

                    let e3 = `To https://github.com/yuda-lyu/`
                    if (err.indexOf(e3) >= 0) {
                        //git push至倉庫時訊息報錯, 不視為錯誤
                        console.log(err) //err為正常訊息
                        return
                    }

                    // throw new Error(err)
                    console.log('git訊息非預期報錯:', err)
                })
            return //直接跳出
        }

        let useNpm = w.strleft(v, 4) === 'npm '
        if (useNpm) {
            console.log(`${pdi.name} >>> exec: `, v)
            await ectScripts(pdi, v)
                .catch((err) => {
                    // console.log('useNpm', err)

                    let e1 = `npm notice Publishing to https://registry.npmjs.org/ with tag latest and default access`
                    if (err.indexOf(e1) >= 0) {
                        //npm publish會用stdout報錯, 不視為錯誤
                        console.log(err) //err為正常訊息
                        return
                    }

                    let e2 = `You cannot publish over the previously published versions`
                    if (err.indexOf(e2) >= 0) {
                        //npm publish先前版本報錯, 要視為錯誤
                        throw new Error(err)
                    }

                    throw new Error(err)
                })
            return //直接跳出
        }

        throw new Error(`非預期指令: ${v}`)
    })

    // console.log('runScript finish')
}


export default runScript
