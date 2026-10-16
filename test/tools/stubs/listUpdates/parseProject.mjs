//parseProject 之樁(listUpdates 模式): 回傳環境變數 FIXTURE_PKGS(JSON 陣列, 每項 { name, path, level })所給定之 fixture 套件清單
function parseProject(fds) {
    return JSON.parse(process.env.FIXTURE_PKGS)
}


export default parseProject
