//publishPackages 入口單元測試(帳本 R24: 起跑預檢 git --version 先於任何套件; while 迴圈語意不變)
//以 opt.deps 注入 checkGit、publishPackage 之樁, 不掃套件區、不執行任何列、不執行 git
import assert from 'assert'
import fs from 'fs'
import path from 'path'
import publishPackages from '../src/publishPackages.mjs'


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

    let mkDeps = ({ results = [false], checkGitImpl = async () => 'git version 1\n' } = {}) => {
        let calls = []
        let k = 0
        return {
            calls,
            deps: {
                checkGit: async (...args) => {
                    calls.push('checkGit')
                    return checkGitImpl(...args)
                },
                publishPackage: async (names) => {
                    calls.push(`publishPackage|${JSON.stringify(names)}`)
                    let b = results[Math.min(k, results.length - 1)]
                    k++
                    return b
                },
            },
        }
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
        await publishPackages(['w-a'], { deps: { checkGit: async () => { calls.push('checkGit') }, publishPackage: async () => { throw sent } } }).catch((e) => { got = e })
        assert.strictEqual(got, sent)
        assert.deepStrictEqual(calls, ['checkGit'])
    })

})
