//帳本 R25 守衛測試之子程序入口(由 test/unit-testGuard.test.mjs 以 spawnSync 呼叫):
//  node --import ./test/tools/hooksStub.mjs test/tools/guardCase.mjs <站點>      (STUB_MODE=guard)
//以「未注入任何相依」之形態呼叫站點之真實函式, 回報是否 throw 與訊息; 站點之下一層已由掛鉤換成只寫呼叫紀錄(CALLS_FILE)的 spy, 不執行任何東西.
//子程序是否為測試環境由父行程給環境變數決定(W_PKSUPDATE_TEST 有無): 有 → 守衛應擋下; 無 → 正式模式對照組, spy 應被呼叫.
//站點 missing:<函式>:<鍵> 表「該函式要求注入的其他鍵都給記錄用 spy, 只缺<鍵>」: 測試環境下須列出該鍵缺漏而 throw(逐鍵驗證守衛的鍵清單, 帳本 R25.2), 正式模式則該鍵走(已被換成 spy 的)預設實作
//最後一行輸出 RESULT_JSON:{ site, threw, message, logs }, logs 為子程序期間印出之行(對照組據以證明確實走到了真實預設實作)
let site = process.argv[2]
let fdPkg = process.env.FIXTURE_PKG
let pdi = { name: process.env.FIXTURE_NAME, path: fdPkg }

//掛鉤握手(第 5 次外審 sol F06/M13、opus F06): 回報『被換成 spy 的模組』實際解析到哪個檔案——正反兩組都斷言有解析到 stubs/guard, 否則帶旗標的負例即使 spy 沒接上也會因守衛在前而通過(拿掉守衛的變異就不安全)
let hookResolved = {}
for (let n of String(process.env.GUARD_STUBS || '').split(',').filter((s) => s !== '')) {
    hookResolved[n] = import.meta.resolve(`../../src/${n}`)
}
if (process.env.GUARD_EXEC_SPY === '1') {
    hookResolved['wsemi/src/execProcess.mjs'] = import.meta.resolve('wsemi/src/execProcess.mjs')
}

let logOri = console.log
let logs = []
console.log = (...args) => {
    logs.push(args.join(' ').slice(0, 300))
}
let result = { site, threw: false, message: '' }
try {
    if (site.indexOf('missing:') === 0) {
        let [, fn, key] = site.split(':')
        let { default: record } = await import('./stubs/record.mjs')
        let rec = (n, ret) => () => {
            record(n)
            return ret
        }
        let async_ = (n, ret) => async () => {
            record(n)
            return ret
        }
        if (fn === 'publishPackages') {
            let deps = { checkGit: async_('checkGit', 'git version spy\n'), publishPackage: async_('publishPackage', false) }
            delete deps[key]
            let { default: f } = await import('../../src/publishPackages.mjs')
            await f([pdi.name], { deps })
        }
        else if (fn === 'publishPackage') {
            let deps = {
                getFolders: rec('getFolders', [fdPkg]),
                parseProject: rec('parseProject', [{ name: pdi.name, path: fdPkg, level: '3' }]),
                getUpdate: rec('getUpdate', { name: pdi.name, path: fdPkg, version: '0.0.1', update: true, dependencies: [], devDependencies: [] }),
                updatePackage: rec('updatePackage', 'ok'),
                ectScripts: async_('ectScripts', ''),
                runScript: async_('runScript', undefined),
            }
            delete deps[key]
            let { default: f } = await import('../../src/publishPackage.mjs')
            await f([pdi.name], { checkRelease: false, deps })
        }
        else if (fn === 'runScript') {
            let opt = { checkRelease: false, exec: async_('exec', '') }
            delete opt[key]
            let { default: f } = await import('../../src/runScript.mjs')
            await f(pdi, 'guard', opt)
        }
        else if (fn === 'checkGit') {
            let opt = { exec: async_('exec', 'git version spy\n') }
            delete opt[key]
            let { default: f } = await import('../../src/checkGit.mjs')
            await f({ path: fdPkg, ...opt })
        }
        else {
            throw new Error(`未知函式[${fn}]`)
        }
    }
    else if (site === 'publishPackages') {
        let { default: f } = await import('../../src/publishPackages.mjs')
        await f([pdi.name])
    }
    else if (site === 'publishPackage') {
        let { default: f } = await import('../../src/publishPackage.mjs')
        await f([pdi.name], { checkRelease: false }) //checkRelease 不是注入的接縫, 只使夾具不必備齊發布列
    }
    else if (site === 'runScript') {
        let { default: f } = await import('../../src/runScript.mjs')
        await f(pdi, 'guard', { checkRelease: false })
    }
    else if (site === 'runScript.checkNpm') {
        //exec 已注入、checkNpm 未注入: 走到最終閘門時預設 checkNpm(網路)被使用 → 測試環境下須 throw
        let { default: f } = await import('../../src/runScript.mjs')
        await f(pdi, 'guard', { checkRelease: false, exec: async () => '' })
    }
    else if (site === 'runScript.gitStatusDist') {
        //exec 已注入(記錄被呼叫)、gitStatusDist 未注入: 首個對外 git 列之前 dist 閘門使用預設 git status → 測試環境下須 throw, 且 exec 從未被呼叫
        let { writeScript } = await import('./mkFixturePkg.mjs')
        let { default: f } = await import('../../src/runScript.mjs')
        let { default: record } = await import('./stubs/record.mjs')
        writeScript(fdPkg, ['git add .  -A'], { stubbed: true })
        await f(pdi, 'guard', { checkRelease: false, exec: async (p, s) => { record(`exec|${s}`); return '' }, checkNpm: async () => true })
    }
    else if (site === 'runScript.path') {
        //exec 已注入、但套件路徑不在 test/_tmp 內(指向不存在之資料夾 OUTSIDE_PKG): 測試環境下須在 loadScript、rm -r 等任何本機動作之前 throw
        let { default: f } = await import('../../src/runScript.mjs')
        await f({ name: pdi.name, path: process.env.OUTSIDE_PKG }, 'guard', { checkRelease: false, exec: async () => '' })
    }
    else if (site === 'publishPackage.path') {
        //deps 全部注入(皆為記錄用 spy)、但 getUpdate 回的套件路徑不在 test/_tmp 內: 測試環境下須在 loadScript、備份、updatePackage 之前 throw
        let { default: f } = await import('../../src/publishPackage.mjs')
        let { default: record } = await import('./stubs/record.mjs')
        let outside = process.env.OUTSIDE_PKG
        let rec = (n, ret) => () => {
            record(n)
            return ret
        }
        await f([pdi.name], {
            checkRelease: false,
            deps: {
                getFolders: rec('getFolders', [outside]),
                parseProject: rec('parseProject', [{ name: pdi.name, path: outside, level: '3' }]),
                getUpdate: rec('getUpdate', { name: pdi.name, path: outside, version: '0.0.1', update: true, dependencies: [], devDependencies: [] }),
                updatePackage: rec('updatePackage', 'ok'),
                ectScripts: async () => {
                    record('ectScripts')
                    return ''
                },
                runScript: async () => {
                    record('runScript')
                },
            },
        })
    }
    else if (site === 'ectScripts.realIdentity') {
        //注入的 execProcess 恰是 wsemi 預設匯出本身(此子程序中已被掛鉤換成 spy; 與 ectScripts 所匯入者同一個身分): 視為未包裝, 測試環境下須 throw
        let { default: ex } = await import('wsemi/src/execProcess.mjs')
        let { default: f } = await import('../../src/ectScripts.mjs')
        await f(pdi, 'node -v', { execProcess: ex })
    }
    else if (site === 'ectScripts.undefExec' || site === 'ectScripts.nonFnExec') {
        //execProcess 鍵在但值不是函式(undefined、數字): 等同未注入
        let { default: f } = await import('../../src/ectScripts.mjs')
        await f(pdi, 'node -v', { execProcess: site === 'ectScripts.undefExec' ? undefined : 1 })
    }
    else if (site === 'removeTarget.path') {
        //寫/刪類匯出函式: 路徑不在 test/_tmp 內(指向不存在之資料夾)須在任何動作之前 throw
        let { removeTarget } = await import('../../src/runScript.mjs')
        removeTarget(process.env.OUTSIDE_PKG, 'docs')
    }
    else if (site === 'updatePackage.path') {
        let { default: f } = await import('../../src/updatePackage.mjs')
        f({ name: pdi.name, path: process.env.OUTSIDE_PKG, update: true, dependencies: [], devDependencies: [{ name: 'w-x', verOld: '^1.0.0', verNew: '^1.0.1' }] })
    }
    else if (site === 'exitAfterFlush') {
        //process.exit 換成記錄用 spy(不真的結束): 測試環境下未給 exitFn 須在呼叫前 throw、spy 不被呼叫; 正式模式則呼叫 process.exit(spy)
        let { default: record } = await import('./stubs/record.mjs')
        process.exit = (c) => {
            record(`exit|${c}`)
        }
        let { exitAfterFlush } = await import('../../src/runMain.mjs')
        await exitAfterFlush(0)
    }
    else if (site === 'ectScripts') {
        let { default: f } = await import('../../src/ectScripts.mjs')
        await f(pdi, 'node -v')
    }
    else if (site === 'checkGit') {
        let { default: f } = await import('../../src/checkGit.mjs')
        await f({ path: fdPkg })
    }
    else if (site === 'checkNpmVersion') {
        //觀測用: globalThis.fetch 換成只記錄並拒絕的 spy(經不通代理亦不離機); 擋下時 spy 不得被呼叫, 對照組(正式模式)須呼叫到
        let { default: record } = await import('./stubs/record.mjs')
        globalThis.fetch = async (url) => {
            record(`fetch|${String(url).slice(0, 60)}`)
            throw new Error('fetch spy')
        }
        let { default: f } = await import('../../src/checkNpmVersion.mjs')
        await f('sbx-guard-pkg', '0.0.1', { maxTry: 0, delayMs: 1, requestTimeoutMs: 3000 })
    }
    else if (site === 'getFolders') {
        //觀測用: 呼叫期間把 fs 的讀取類函式換成『先記錄再轉呼叫』的包裝; 擋下時守衛在掃描之前, 不得有任何記錄, 對照組(正式模式)須記錄到(外審 opus F06 MUT3c)
        let { default: record } = await import('./stubs/record.mjs')
        let fs = (await import('node:fs')).default
        let { default: f } = await import('../../src/getFolders.mjs')
        let ori = {}
        for (let k of ['readdirSync', 'statSync', 'lstatSync', 'opendirSync']) {
            ori[k] = fs[k]
            fs[k] = (...args) => {
                record(`fs|${k}`)
                return ori[k](...args)
            }
        }
        try {
            f()
        }
        finally {
            for (let k of Object.keys(ori)) {
                fs[k] = ori[k]
            }
        }
    }
    else if (site === 'checkGitStatus') {
        //觀測用: child_process.execSync 換成只記錄的 spy(先於 checkGitStatus 載入並同步內建模組的 ESM 具名匯出); fixture 放一個空的 .git 資料夾使對照組走得到 execSync
        let { default: record } = await import('./stubs/record.mjs')
        let nodeFs = (await import('node:fs')).default
        let cpMod = (await import('node:child_process')).default
        let { syncBuiltinESMExports } = await import('node:module')
        nodeFs.mkdirSync(`${fdPkg}/.git`, { recursive: true })
        cpMod.execSync = (cmd) => {
            record(`execSync|${cmd}`)
            return ''
        }
        syncBuiltinESMExports()
        let { default: f } = await import('../../src/checkGitStatus.mjs')
        f(fdPkg)
    }
    else {
        throw new Error(`未知站點[${site}]`)
    }
}
catch (err) {
    result.threw = true
    result.message = String(err && err.message ? err.message : err).split('\n')[0]
}
console.log = logOri
result.logs = logs.slice(0, 60)
result.hookResolved = hookResolved
console.log('RESULT_JSON:' + JSON.stringify(result))
