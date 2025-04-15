import _ from 'lodash-es'
import w from 'wsemi'


function parseProject(fds) {
    let ps = []
    _.each(fds, (v) => {

        let nameFd = w.getFileName(v)
        // console.log('nameFd', nameFd)

        let name = w.strdelleft(nameFd, 12) //刪除「開源-JS-002-3-」長度為12
        // console.log('name', name)

        let level = w.strdelleft(nameFd, 10) //刪除「開源-JS-002-」長度為10
        level = w.strleft(level, 1) //取第1個, 代表依賴層級

        let fd = `${v}/${name}`
        // console.log('fd', fd, w.fsIsFolder(fd))

        if (!w.fsIsFolder(fd)) {
            console.log(`偵測到fd[${fd}]非套件資料夾`)
            return true //跳出換下一個
        }

        let p = {
            name,
            path: fd,
            level,
        }

        ps.push(p)

    })
    // console.log('ps', ps)

    ps = _.sortBy(ps, 'level')

    return ps
}


export default parseProject
