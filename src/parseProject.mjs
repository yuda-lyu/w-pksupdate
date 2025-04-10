import _ from 'lodash-es'
import w from 'wsemi'


function parseProject(fds) {
    let ps = []
    _.each(fds, (v) => {

        let name = w.getFileName(v)
        // console.log('name:', name)
        name = w.strdelleft(name, 12)
        // console.log('name:', name)

        let fd = `${v}/${name}`
        // console.log('fd:', fd, w.fsIsFolder(fd))

        if (!w.fsIsFolder(fd)) {
            console.log(`偵測到fd[${fd}]非套件資料夾`)
            return true //跳出換下一個
        }

        let p = {
            name,
            path: fd,
        }

        ps.push(p)

    })
    // console.log('ps', ps)

    return ps
}


export default parseProject
