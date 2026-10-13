//getFolders 之樁: 只回傳 fixture 套件資料夾, 不掃描套件區
function getFolders() {
    return [process.env.FIXTURE_PKG]
}


export default getFolders
