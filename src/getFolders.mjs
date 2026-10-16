import _ from 'lodash-es'
import w from 'wsemi'
import { assertRealExecAllowed } from './testGuard.mjs'


function getFolders() {

    //測試環境下取不到真實套件區(真實 pdi 唯一來源), 其下游寫檔之 updatePackage、removeTarget、restoreFiles 因而只可能作用於測試自建之 fixture(帳本 R25)
    assertRealExecAllowed('getFolders', '將掃描真實套件區')

    //pfd //[tag:換位置時要調整]
    // let pfd = 'D:\\- 006 -        開源\\'
    let pfd = 'C:\\opensrc\\'
    
    //vfds
    let vfdsp = w.fsGetFoldersInFolder(pfd)
    let fds = _.map(vfdsp, 'path')

    //fds
    fds = _.filter(fds, (v) => {
        // console.log('v', v)
        return v.indexOf('開源-JS-') >= 0
    })
    fds = _.filter(fds, (v) => {
        return v.indexOf('開源-JS-000') < 0 //剔除輔助工具
    })
    // console.log('fds', fds)

    return fds
}


export default getFolders
