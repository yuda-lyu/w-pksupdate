//帳本 R25.1 測試用子程序入口: 回報本行程的測試旗標與 isTestEnv 判別結果(最後一行 RESULT_JSON)
//  node [--import ./test/tools/hooksStub.mjs] test/tools/envProbe.mjs [import-testGuard|import-testEnv-install]
//  第一個參數 import-testGuard: 只載入 src/testGuard.mjs; import-testEnv-install: 只載入 test/tools/testEnv.mjs 並呼叫 installTestEnv(), 皆不載入對方
let how = process.argv[2] || ''
let out = { how, flagBefore: process.env.W_PKSUPDATE_TEST || '' }
if (how === 'import-testGuard') {
    let m = await import('../../src/testGuard.mjs')
    out.isTestEnv = m.isTestEnv()
}
else if (how === 'latch') {
    //載入時以 argv 帶 mocha 判為測試環境並鎖存; 之後測試自己清掉旗標、argv 後仍須為真(第 5 次外審 sol F08)
    let m = await import('../../src/testGuard.mjs')
    out.isTestEnvBefore = m.isTestEnv()
    delete process.env.W_PKSUPDATE_TEST
    process.argv.length = 2
    out.signalsGone = m.isTestEnv({ env: process.env, globals: {}, argv: process.argv, execArgv: [] }) //對照: 以純函式重算(不鎖存)訊號確已全無
    out.isTestEnvAfter = m.isTestEnv()
}
else if (how === 'import-testEnv-install') {
    let m = await import('./testEnv.mjs')
    m.installTestEnv()
}
else {
    let m = await import('../../src/testGuard.mjs')
    out.isTestEnv = m.isTestEnv({ env: {}, globals: {}, argv: [], execArgv: [] }) //對照: 訊號全無時為 false
}
out.flagAfter = process.env.W_PKSUPDATE_TEST || ''
console.log('RESULT_JSON:' + JSON.stringify(out))
