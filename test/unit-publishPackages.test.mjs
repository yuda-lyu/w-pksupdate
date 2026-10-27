//publishPackages 入口單元測試(帳本 R24: 起跑預檢 git --version 先於任何套件; while 迴圈語意不變)
//以 opt.deps 注入 checkGit、publishPackage 之樁, 不掃套件區、不執行任何列、不執行 git
import assert from 'assert'
import fs from 'fs'
import path from 'path'
import publishPackages from '../src/publishPackages.mjs'
import { reFatal } from './tools/fatalWords.mjs'


describe('publishPackages 入口(R24 預檢; 注入 checkGit、publishPackage)', function() {

    //安全網(2026-10-17 事故後必備): publishPackages 若因注入失效而走到真的 publishPackage, 會掃描真實套件區並執行 npm i、git push、deploy、npm publish(事故紀錄見 run04 報告)。
    //故測試期間自 PATH 移除 powershell 所在目錄, 使任何真實列在啟動時失敗(spawn ENOENT), 並由 R21 還原 package.json; 且 mocha 逾時前即以 PATH 前提斷言快速失敗
    let pathOri
    before(function() {
        pathOri = process.env.PATH
        process.env.PATH = pathOri.split(';').filter((s) => s && !fs.existsSync(path.join(s, 'powershell.exe'))).join(';')
        assert.ok(!process.env.PATH.split(';').some((s) => s && fs.existsSync(path.join(s, 'powershell.exe'))), 'PATH 仍含 powershell, 安全網失效')
    })

    after(function() {
        process.env.PATH = pathOri
    })

    //resolveRegistryConfig 為注入之樁(帳本 R27, 測試環境下必須注入; 不啟動 npm); 回傳固定之虛構設定, 並記錄收到之選項
    let REG = { main: 'http://localhost:48731/', mirrors: [], source: '測試', notes: [] }
    let mkDeps = ({ results = [false], checkGitImpl = async () => 'git version 1\n', cfg = REG, publishImpl } = {}) => {
        let calls = []
        let resolveArgs = []
        let publishArgs = []
        let k = 0
        return {
            calls,
            resolveArgs,
            publishArgs,
            deps: {
                checkGit: async (...args) => {
                    calls.push('checkGit')
                    return checkGitImpl(...args)
                },
                publishPackage: async (names, o) => {
                    calls.push(`publishPackage|${JSON.stringify(names)}`)
                    publishArgs.push(o)
                    if (publishImpl) {
                        await publishImpl(names, o)
                    }
                    let b = results[Math.min(k, results.length - 1)]
                    k++
                    return b
                },
                resolveRegistryConfig: (o) => {
                    resolveArgs.push(o)
                    if (cfg instanceof Error) {
                        throw cfg
                    }
                    return cfg
                },
            },
        }
    }

    //擷取 console.log
    let quiet = async (fn) => {
        let logOri = console.log
        let logs = []
        console.log = (...args) => {
            logs.push(args.join(' '))
        }
        try {
            await fn()
        }
        finally {
            console.log = logOri
        }
        return logs
    }

    it('R24.1 預檢先於任何 publishPackage; 預檢通過後照常呼叫 publishPackage(names)', async function() {
        let m = mkDeps()
        await publishPackages(['w-a', 'w-b'], { deps: m.deps })
        assert.deepStrictEqual(m.calls, ['checkGit', 'publishPackage|["w-a","w-b"]'])
    })

    it('R24.3 預檢只做一次: publishPackage 連續回 true 的多輪 while 迴圈(直到回 false)期間不重複預檢', async function() {
        let m = mkDeps({ results: [true, true, true, false] })
        await publishPackages([], { deps: m.deps })
        assert.deepStrictEqual(m.calls, ['checkGit', 'publishPackage|[]', 'publishPackage|[]', 'publishPackage|[]', 'publishPackage|[]'])
    })

    it('R24.1 預檢失敗(git 不可用)→ publishPackages 以該錯誤 reject, publishPackage 從未被呼叫(任何列執行前中止)', async function() {
        let sent = Object.assign(new Error('[preflight] git指令失敗(code[1]): git --version'), { code: 'PRE' })
        let m = mkDeps({ checkGitImpl: async () => { throw sent } })
        let got = null
        await publishPackages(['w-a'], { deps: m.deps }).catch((e) => { got = e })
        assert.strictEqual(got, sent)
        assert.deepStrictEqual(m.calls, ['checkGit'])
    })

    it('單套件發布(names 只含一個)與全庫(names 空陣列)走同一入口, 皆預檢', async function() {
        for (let names of [['w-only'], []]) {
            let m = mkDeps()
            await publishPackages(names, { deps: m.deps })
            assert.strictEqual(m.calls[0], 'checkGit', JSON.stringify(names))
        }
    })

    it('publishPackage 失敗時錯誤原樣向上傳(預檢已過, 不吞錯)', async function() {
        let sent = new Error('[w-a] npm指令失敗(code[1]): npm publish')
        let calls = []
        let got = null
        await publishPackages(['w-a'], { deps: { checkGit: async () => { calls.push('checkGit') }, publishPackage: async () => { throw sent }, resolveRegistryConfig: () => REG } }).catch((e) => { got = e })
        assert.strictEqual(got, sent)
        assert.deepStrictEqual(calls, ['checkGit'])
    })

    //---- 帳本 R27: 倉庫設定解析一次、往下傳、結束印鏡像摘要 ----

    it('R27.1 倉庫設定只解析一次(選項 registry、mirrors 原樣交給解析函式), 每次 publishPackage 都收到同一份 registryConfig(while 多輪亦同); 起跑印一行設定', async function() {
        let m = mkDeps({ results: [true, true, false] })
        let logs = await quiet(() => publishPackages(['w-a'], { registry: 'http://localhost:48731/', mirrors: ['https://registry.npmjs.org/'], deps: m.deps }))
        assert.deepStrictEqual(m.resolveArgs, [{ registry: 'http://localhost:48731/', mirrors: ['https://registry.npmjs.org/'] }])
        assert.strictEqual(m.publishArgs.length, 3)
        for (let o of m.publishArgs) {
            assert.strictEqual(o.registryConfig, REG)
            assert.strictEqual(typeof o.onMirrorResult, 'function')
        }
        assert.strictEqual(logs.filter((s) => s.indexOf('[registry] 主倉庫: http://localhost:48731/') === 0).length, 1)
    })

    it('R27.1 未給選項時解析函式收到 { registry: undefined, mirrors: undefined }(預設取 npm 設定, 由解析函式決定)', async function() {
        let m = mkDeps()
        await quiet(() => publishPackages(['w-a'], { deps: m.deps }))
        assert.deepStrictEqual(m.resolveArgs, [{ registry: undefined, mirrors: undefined }])
    })

    it('R27.1 倉庫設定解析失敗 → publishPackages 以該錯誤 reject, checkGit 與 publishPackage 皆未被呼叫(任何套件被改動前中止)', async function() {
        let sent = new Error('[registry] 無法取得 npm 設定之 registry')
        let m = mkDeps({ cfg: sent })
        let got = null
        await quiet(() => publishPackages(['w-a'], { deps: m.deps }).catch((e) => { got = e }))
        assert.strictEqual(got, sent)
        assert.deepStrictEqual(m.calls, [])
    })

    it('R27.4 未啟用鏡像且無鏡像結果 → 不印鏡像摘要', async function() {
        let m = mkDeps()
        let logs = await quiet(() => publishPackages(['w-a'], { deps: m.deps }))
        assert.deepStrictEqual(logs.filter((s) => s.indexOf('[mirror]') === 0), [])
    })

    it('R27.4 啟用鏡像: 結束印摘要, 列出哪些套件版本沒發到哪個鏡像與錯誤原文; 已存在視為已同步不列入未同步清單; 摘要不含致命字樣(不被守望器誤判中止)', async function() {
        let cfg = { ...REG, mirrors: ['https://mirror-a.example.test/', 'https://mirror-b.example.test/'] }
        let m = mkDeps({
            cfg,
            publishImpl: async (names, o) => {
                o.onMirrorResult({ name: 'w-a', version: '1.0.1', mirror: 'https://mirror-a.example.test/', status: 'ok', error: '' })
                o.onMirrorResult({ name: 'w-a', version: '1.0.1', mirror: 'https://mirror-b.example.test/', status: 'failed', error: 'E401 Unable to authenticate' })
                o.onMirrorResult({ name: 'w-b', version: '2.0.0', mirror: 'https://mirror-a.example.test/', status: 'exists', error: '' })
            },
        })
        let logs = await quiet(() => publishPackages(['w-a'], { deps: m.deps }))
        let ms = logs.filter((s) => s.indexOf('[mirror]') === 0)
        assert.ok(ms[0].indexOf('發布成功 1 筆、已存在視為已同步 1 筆、未同步 1 筆') >= 0, ms[0])
        assert.ok(ms.some((s) => s.indexOf('w-a@1.0.1 → https://mirror-b.example.test/: E401 Unable to authenticate') >= 0), JSON.stringify(ms))
        assert.ok(!ms.some((s) => s.indexOf('w-b@2.0.0') >= 0), '已存在視為已同步, 不列入未同步清單')
        for (let s of ms) {
            assert.ok(!reFatal.test(s), s)
        }
    })

    it('R27.4 連動中止(publishPackage throw)時仍印鏡像摘要(中止前已發出之鏡像紀錄不得遺失), 且原錯誤原樣向上傳', async function() {
        let sent = new Error('[w-c] npm指令失敗(code[1]): npm publish')
        let cfg = { ...REG, mirrors: ['https://mirror-a.example.test/'] }
        let m = mkDeps({
            cfg,
            publishImpl: async (names, o) => {
                o.onMirrorResult({ name: 'w-a', version: '1.0.1', mirror: 'https://mirror-a.example.test/', status: 'failed', error: 'ETIMEDOUT' })
                throw sent
            },
        })
        let got = null
        let logs = await quiet(() => publishPackages(['w-a'], { deps: m.deps }).catch((e) => { got = e }))
        assert.strictEqual(got, sent)
        assert.ok(logs.some((s) => s.indexOf('[mirror]   w-a@1.0.1 → https://mirror-a.example.test/: ETIMEDOUT') === 0), JSON.stringify(logs))
    })

    it('R25.2 測試環境下未注入 resolveRegistryConfig → throw [testGuard], 不呼叫 checkGit/publishPackage(解析會啟動 npm)', async function() {
        let calls = []
        let deps = { checkGit: async () => { calls.push('checkGit') }, publishPackage: async () => { calls.push('publishPackage') } }
        await assert.rejects(publishPackages(['w-a'], { deps }), /\[testGuard\].*\[publishPackages\]: 未注入 resolveRegistryConfig/)
        assert.deepStrictEqual(calls, [])
    })

})
