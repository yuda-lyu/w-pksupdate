import _ from 'lodash-es'
import w from 'wsemi'
import getFolders from './src/getFolders.mjs'
import parseProject from './src/parseProject.mjs'
import checkGitStatus from './src/checkGitStatus.mjs'
import ectScripts from './src/ectScripts.mjs'


let fds = getFolders()
// console.log('fds', fds)

let ps = parseProject(fds)
// console.log('ps', ps)

await w.pmSeries(ps, async(p) => {

    //checkGitStatus
    let fd = p.path
    let r = checkGitStatus(fd)
    console.log('checkGitStatus', {
        ...p,
        ...r,
    })

    if (!r.hasChanges) {
        return
    }

    let scps = `
git add .  -A
git commit -m 'modify: readme'
git push origin master:master
`
    scps = w.sep(scps, '\n')
    // console.log('scps', scps)

    await ectScripts(p, scps)

})


//node g.checkAndCommit.mjs
