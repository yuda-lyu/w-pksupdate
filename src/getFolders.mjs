import _ from 'lodash-es'
import w from 'wsemi'


function getFolders() {

    //pfd
    let pfd = 'D:\\- 006 -        開源\\'

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
