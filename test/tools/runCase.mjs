//整合測試之子程序入口(由 test/unit-runScript-ps.test.mjs 以 spawnSync 呼叫):
//  node --import ./test/tools/hooksStub.mjs test/tools/runCase.mjs <runScript|publishPackage>
//環境變數: FIXTURE_PKG(fixture 套件絕對路徑)、FIXTURE_NAME、STUB_MODE、CALLS_FILE
//最後一行輸出 RESULT_JSON:{ ok, publish, message, unjudged }, unjudged 為執行期間印出之留痕行(帳本 R13, 含「未判定(」者)
//帳本 R25: 子程序繼承測試旗標(W_PKSUPDATE_TEST), 真實函式之相依一律顯式注入——
//  runScript 模式: 刻意走真實 PowerShell, exec 經 realExec 之 ectReal(限 test/_tmp 內 fixture、拒絕對外型指令), checkNpm 為掛鉤換入之樁
//  publishPackage 模式: getFolders、parseProject、getUpdate、updatePackage、ectScripts 皆為掛鉤換入之樁(下方斷言確為樁), 不啟動任何行程
let mode = process.argv[2]
let fdPkg = process.env.FIXTURE_PKG
let name = process.env.FIXTURE_NAME
//R20: 既有整合案例之 script.txt 不含 addVersion/publish 列(writeScript 禁止 publish 列), 預設關閉發布列與版本遞增檢查以保持原意; 要測 R20 者設 CHECK_RELEASE=1
let checkRelease = process.env.CHECK_RELEASE === '1'

let logOri = console.log
let unjudged = []
console.log = (...args) => {
    let s = args.join(' ')
    if (s.indexOf('未判定(') >= 0) {
        unjudged.push(s)
    }
}
let result
try {
    let { default: checkNpm } = await import('../../src/checkNpmVersion.mjs')
    if (mode === 'runScript') {
        let { default: runScript } = await import('../../src/runScript.mjs')
        let { ectReal, gitStatusDistReal } = await import('./realExec.mjs')
        await runScript({ name, path: fdPkg }, 'test', { checkRelease, exec: ectReal, checkNpm, gitStatusDist: gitStatusDistReal })
        result = { ok: true }
    }
    else if (mode === 'publishPackage') {
        let { default: publishPackage } = await import('../../src/publishPackage.mjs')
        let { default: runScript } = await import('../../src/runScript.mjs')
        let { default: getFolders } = await import('../../src/getFolders.mjs')
        let { default: parseProject } = await import('../../src/parseProject.mjs')
        let { default: getUpdate } = await import('../../src/getUpdate.mjs')
        let { default: updatePackage } = await import('../../src/updatePackage.mjs')
        let mEct = await import('../../src/ectScripts.mjs')
        if (mEct.isStub !== true) {
            throw new Error('publishPackage 模式要求 ectScripts 為掛鉤換入之樁(isStub), 拒絕走真實執行')
        }
        let ectScripts = mEct.default
        let deps = {
            getFolders,
            parseProject,
            getUpdate,
            updatePackage,
            ectScripts,
            runScript: (pdi, msg, o) => runScript(pdi, msg, { ...o, exec: ectScripts, checkNpm, gitStatusDist: () => '' }),
        }
        let b = await publishPackage([name], { checkRelease, deps, registryConfig: { main: 'http://localhost:48731/', mirrors: [] } }) //帳本 R27: 倉庫設定由呼叫端給(虛構之本機位址)
        result = { ok: true, publish: b }
    }
    else {
        throw new Error(`未知 mode[${mode}]`)
    }
}
catch (err) {
    result = { ok: false, message: String(err && err.message ? err.message : err).split('\n')[0] }
}
console.log = logOri
result.unjudged = unjudged
console.log('RESULT_JSON:' + JSON.stringify(result))
