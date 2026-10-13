//parseProject 之樁: 只回傳 fixture 套件
function parseProject(fds) {
    return [{ name: process.env.FIXTURE_NAME, path: process.env.FIXTURE_PKG, level: '3' }]
}


export default parseProject
