//整合測試之子程序入口(由 test/unit-runScript-ps.test.mjs 以 spawnSync 呼叫):
//  node --import ./test/tools/hooksStub.mjs test/tools/runCase.mjs <runScript|publishPackage>
//環境變數: FIXTURE_PKG(fixture 套件絕對路徑)、FIXTURE_NAME、STUB_MODE、CALLS_FILE
//最後一行輸出 RESULT_JSON:{ ok, publish, message }
let mode = process.argv[2]
let fdPkg = process.env.FIXTURE_PKG
let name = process.env.FIXTURE_NAME

let logOri = console.log
console.log = () => {}
let result
try {
    if (mode === 'runScript') {
        let { default: runScript } = await import('../../src/runScript.mjs')
        await runScript({ name, path: fdPkg }, 'test')
        result = { ok: true }
    }
    else if (mode === 'publishPackage') {
        let { default: publishPackage } = await import('../../src/publishPackage.mjs')
        let b = await publishPackage([name])
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
console.log('RESULT_JSON:' + JSON.stringify(result))
