import _ from 'lodash-es'
import w from 'wsemi'


let sortProjectLevels = (ps, names, opt = {}) => {

    //returnObj
    let returnObj = _.get(opt, 'returnObj', false)

    let kpPjLevel = {}
    _.each(ps, (p) => {
        kpPjLevel[p.name] = p.level
    })
    // console.log('kpPjLevel', kpPjLevel)

    let vs = _.map(names, (name) => {

        let level = _.get(kpPjLevel, name, '')

        if (!w.ispint(level)) {
            throw new Error(`name[${name}] can not get level`)
        }

        level = w.cint(level)

        let v = {
            name,
            level,
        }

        return v
    })

    vs = _.sortBy(vs, 'level')
    // console.log('vs(sort)', vs)

    let namesSort = _.map(vs, 'name')

    if (returnObj) {
        return vs
    }
    return namesSort
}


export default sortProjectLevels
