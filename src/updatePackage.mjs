import fs from 'fs'
import _ from 'lodash-es'
import w from 'wsemi'
import JSON5 from 'json5'
import { assertConfinedToTestTmp, assertSingleLink } from './testGuard.mjs'


function updatePackage(pdi) {
    // pdi {
    //   name: 'w-serv-broadcast',
    //   path: 'D:\\- 006 -        開源\\開源-JS-007-4-w-serv-broadcast/w-serv-broadcast',
    //   version: '1.0.17',
    //   update: true,
    //   dependencies: [],
    //   devDependencies: [ { name: 'w-converhp', verOld: '^2.0.17', verNew: '^2.0.18' } ]
    // }

    if (!pdi.update) {
        return 'no update'
    }

    //測試環境下只可作用於 test/_tmp 內之 fixture(帳本 R25.2; 第 5 次外審 opus F07)
    assertConfinedToTestTmp('updatePackage', pdi.path)
    assertSingleLink('updatePackage', `${pdi.path}/package.json`) //硬連結會改到別名檔案(第 5 次外審 sol F02)

    let fppk = `${pdi.path}/package.json`

    let j = fs.readFileSync(fppk, 'utf8')

    let o = JSON5.parse(j)
    // console.log('o(ori)', o)

    let dks = [
        'dependencies',
        'devDependencies',
    ]
    _.each(dks, (dk) => {

        if (_.size(pdi[dk]) === 0) {
            return true //跳出換下一個
        }

        _.each(pdi[dk], (d) => {
            // d.name
            // d.verNew
            o[dk][d.name] = d.verNew
        })

    })
    // console.log('o(update)', o)

    let _j = JSON.stringify(o, null, 2).replace(/\n/g, '\r\n') + '\r\n' //依.editorconfig(end_of_line=crlf, insert_final_newline=true), 與w-pksbatch之runModifyFile寫法一致
    // console.log('_j', _j)

    fs.writeFileSync(fppk, _j, 'utf8')

    return 'ok'
}


export default updatePackage
