import path from 'path'
import fs from 'fs'
import cp from 'child_process'
import _ from 'lodash-es'
import w from 'wsemi'
import ectScripts from './ectScripts.mjs'
import checkNpmVersion from './checkNpmVersion.mjs'


async function runScript(pdi, msg = 'update pks') {
    // pdi {
    //   name: 'w-serv-broadcast',
    //   path: 'D:\\- 006 -        開源\\開源-JS-007-4-w-serv-broadcast/w-serv-broadcast',
    //   version: '1.0.17',
    //   update: true,
    //   dependencies: [],
    //   devDependencies: [ { name: 'w-converhp', verOld: '^2.0.17', verNew: '^2.0.18' } ]
    // }

    let fpscp = path.resolve(pdi.path, 'script.txt')

    let c = fs.readFileSync(fpscp, 'utf8')
    // console.log('c', c)

    let scps = w.sep(c, '\n')
    console.log('scps', scps)

    let bCheckDist = false //首次執行git指令前檢查建置產物之旗標

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
            let msg = await ectScripts(pdi, v, { main: 'node' }) //main='node'使rollup編譯失敗(輸出含[RollupError])於ectScripts內立即throw
            // .catch((err) => {
            //     console.log('useNode', err)

            //     // let e1 = `Browserslist: caniuse-lite is outdated.`
            //     // if (err.indexOf(e1) >= 0) {
            //     //     //rollup編譯提示Browserslist報錯, 不視為錯誤
            //     //     console.log(err) //err為正常訊息
            //     //     return
            //     // }

            //     // let e2 = `Browserslist: browsers data` //Browserslist: browsers data (caniuse-lite) is 6 months old.
            //     // if (err.indexOf(e2) >= 0) {
            //     //     //rollup編譯提示Browserslist報錯, 不視為錯誤
            //     //     console.log(err) //err為正常訊息
            //     //     return
            //     // }

            //     // let e3 = `Creating a browser bundle that depends on Node.js built-in modules`
            //     // if (err.indexOf(e3) >= 0) {
            //     //     //rollup編譯提示前端套件會依賴Node.js內建模組報錯, 不視為錯誤
            //     //     console.log(err) //err為正常訊息
            //     //     return
            //     // }

            //     // throw new Error(err)
            // })
            console.log('useNode:::', msg)
            return //直接跳出
        }

        let useBin = w.strleft(v, 20) === './node_modules/.bin/'
        if (useBin) {
            console.log(`${pdi.name} >>> exec: `, v)
            let msg = await ectScripts(pdi, v)
            // .catch((err) => {
            //     console.log('useBin', err)

            //     // let e1 = `ERROR: Unable to find the source file or directory`
            //     // if (w.strleft(err, _.size(e1)) === e1) {
            //     //     //jsdoc報錯, 不視為錯誤
            //     //     console.log(err) //err為正常訊息
            //     //     return
            //     // }

            //     // throw new Error(err)
            // })
            console.log('useBin:::', msg)
            return //直接跳出
        }

        let useGit = w.strleft(v, 4) === 'git '
        if (useGit) {

            //首次執行git指令前檢查dist內有無[已被刪除且未重建]之git追蹤檔(建置失敗徵兆: cleanFolder刪除後建置未重建, git狀態為D; 殷鑑w-highcharts空殼上架), 有即中止避免push/publish空殼
            //註: 不可改用[main檔案存在]檢查, 套件區多套件main欄位指向從未存在之檔名(長期狀態, 如w-fft/w-batch/w-pubsub/w-converhp), 會誤擋
            if (!bCheckDist) {
                bCheckDist = true
                let rd = ''
                try {
                    rd = cp.execSync('git status --porcelain -- dist', { cwd: pdi.path }).toString()
                }
                catch (e) {
                    rd = '' //非git倉庫等情況跳過檢查
                }
                let lns = _.filter(_.split(rd, '\n'), (s) => _.trim(s) !== '')
                let dels = _.filter(lns, (s) => _.trim(s).slice(0, 2).indexOf('D') >= 0) //遭刪除(含AD: 曾staged後又被刪)
                let outs = _.filter(lns, (s) => _.trim(s).slice(0, 2).indexOf('D') < 0) //有產出(??新檔, M修改, A新增)
                //判準: 有刪除且完全無產出=建置失敗空殼(殷鑑w-highcharts: 僅2行D零產出); hash檔名rebuild(舊hash刪+新hash增, 如w-web-api)有產出不誤擋
                if (_.size(dels) > 0 && _.size(outs) === 0) {
                    throw new Error(`[${pdi.name}] 建置產物遭刪除且無任何產出:\n${_.join(dels, '\n')}\n中止git與publish`)
                }
            }

            console.log(`${pdi.name} >>> exec: `, v)
            let msg = await ectScripts(pdi, v)
            // .catch((err) => {
            //     console.log('useGit', err)

            //     // let e1 = `warning: LF will be replaced by CRLF`
            //     // if (err.indexOf(e1) >= 0) {
            //     //     //git自動取代crlf報錯, 不視為錯誤
            //     //     console.log(err) //err為正常訊息
            //     //     return
            //     // }

            //     // let e2a = `remote: GitHub found`
            //     // let e2b = `vulnerabil` //可能有單數, 不要用複數vulnerabilities偵測
            //     // if (err.indexOf(e2a) >= 0 && err.indexOf(e2b) >= 0) {
            //     //     //git push時偵測vulnerabilities報錯, 不視為錯誤
            //     //     console.log(err) //err為正常訊息
            //     //     return
            //     // }

            //     // let e3 = `To https://github.com/yuda-lyu/`
            //     // if (err.indexOf(e3) >= 0) {
            //     //     //git push至倉庫時訊息報錯, 不視為錯誤
            //     //     console.log(err) //err為正常訊息
            //     //     return
            //     // }

            //     // throw new Error(err)
            // })
            console.log('useGit:::', msg)
            return //直接跳出
        }

        let useNpm = w.strleft(v, 4) === 'npm '
        if (useNpm) {
            console.log(`${pdi.name} >>> exec: `, v)
            let msg = await ectScripts(pdi, v, { main: 'npm' }) //main='npm'使npm指令失敗(輸出含npm error)於ectScripts內立即throw
            // .catch((err) => {
            //     console.log('useNpm', err)

            //     // let e1 = `npm notice Publishing to https://registry.npmjs.org/ with tag latest and default access`
            //     // if (err.indexOf(e1) >= 0) {
            //     //     //npm publish會用stdout報錯, 不視為錯誤
            //     //     console.log(err) //err為正常訊息
            //     //     return
            //     // }

            //     // let e2 = `You cannot publish over the previously published versions`
            //     // if (err.indexOf(e2) >= 0) {
            //     //     //npm publish先前版本報錯, 要視為錯誤
            //     //     throw new Error(err)
            //     // }

            //     // throw new Error(err)
            // })
            console.log('useNpm:::', msg)
            // let cerr
            // cerr = 'You cannot publish over the previously published versions'
            // if (msg.indexOf(cerr) >= 0) {
            //     throw new Error(cerr)
            // }
            return //直接跳出
        }

        throw new Error(`非預期指令: ${v}`)
    })
    // .catch((err) => {
    //     console.log('runScript catch', err) //僅顯示不向外報錯
    // })

    //偵測npm, 確認套件已能取得與安裝
    if (true) {

        let fppkg = path.resolve(pdi.path, 'package.json')

        let j = fs.readFileSync(fppkg, 'utf8')

        let o = w.j2o(j)

        let versionNew = o.version

        let b = await checkNpmVersion(pdi.name, versionNew)

        if (!b) {
            throw new Error(`npm上找不到[${pdi.name}@${versionNew}]`) //須用versionNew(addVersion已bump), pdi.version為掃描時舊版號會誤導
        }

    }

    // console.log('runScript finish')
}


export default runScript
