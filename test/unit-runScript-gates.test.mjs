//runScript 呼叫點測試(同一行程內; 以 opt.exec、opt.checkNpm、opt.gitStatusDist、opt.nowMs 注入樁, 不執行任何列、不執行 git、不查 npm、不 publish)
//對應需求(帳本 CLAUDE_rulebook.md 1.3): R10 dist 閘門之呼叫點、R17 建置主檔閘門之時機與逐個對外列檢查、R20 版本遞增之時點與閘門順序、R9 deploy 重試之呼叫點接線、最終閘門(npm上找不到)
//fixture 於 test/_tmp/unit-runScript-gates, before 建立、after 刪除; script.txt 以 writeScript(stubbed:true) 寫入(含 git、publish 列, 但全部由樁吃掉)
import assert from 'assert'
import fs from 'fs'
import path from 'path'
import runScript from '../src/runScript.mjs'
import { assertRealExecAllowed, isTestGuardError } from '../src/testGuard.mjs'
import { mkFixturePkg, writeScript, cleanTmpRoot } from './tools/mkFixturePkg.mjs'
import { reFatal } from './tools/fatalWords.mjs'


let fdTmp = path.resolve('./test/_tmp/unit-runScript-gates')
let fdPkg = path.join(fdTmp, 'pkg')
let pdi = { name: 'sbx-gates', path: fdPkg }
let fpMain = path.join(fdPkg, 'dist', 'a.umd.js')
let fpPj = path.join(fdPkg, 'package.json')

//標準 script: 版本遞增 → 建置 → 兩個 git 列 → 發布
let fullScript = ['#node toolg/addVersion.mjs', 'node toolg/build.mjs', 'git add .  -A', `git commit -m 'modify: '`, '#npm publish']

//擷取 console.log(runScript 會印 scps、>>> exec 等)
let logs = []
let quiet = async (fn) => {
    let logOri = console.log
    logs = []
    console.log = (...args) => {
        logs.push(args.join(' '))
    }
    try {
        return await fn()
    }
    finally {
        console.log = logOri
    }
}

//備妥一次情境: pj 為 package.json 內容, script 為 script.txt 各列; 回傳 { rows, opt }
//  onRow(cmd): 樁 exec 執行該列時之副作用(模擬 addVersion 遞增、build 寫出主檔等)
let setup = ({ main = true, script = fullScript, version = '0.0.1', onRow = () => {}, gitStatusDist = () => '', nowMs, checkNpmResult = true } = {}) => {
    fs.rmSync(path.join(fdPkg, 'dist'), { recursive: true, force: true })
    fs.writeFileSync(fpPj, JSON.stringify({ name: 'sbx-gates', version, private: true, ...(main ? { main: 'dist/a.umd.js' } : {}) }), 'utf8')
    writeScript(fdPkg, script, { stubbed: true })
    let rows = []
    let npmCalls = []
    let gitCalls = []
    let opt = {
        exec: async (p, scps, o = {}) => {
            let cmd = Array.isArray(scps) ? scps.join(' ; ') : scps
            rows.push({ cmd, main: o.main })
            onRow(cmd)
            return ''
        },
        checkNpm: async (name, v) => {
            npmCalls.push(`${name}@${v}`)
            return checkNpmResult
        },
        gitStatusDist: (cwd) => {
            gitCalls.push(cwd)
            return typeof gitStatusDist === 'function' ? gitStatusDist(cwd) : gitStatusDist
        },
    }
    if (nowMs !== undefined) {
        opt.nowMs = () => nowMs
    }
    return { rows, npmCalls, gitCalls, opt }
}

//模擬 addVersion 遞增 patch
let bump = () => {
    let o = JSON.parse(fs.readFileSync(fpPj, 'utf8'))
    let s = o.version.split('.')
    s[2] = String(Number(s[2]) + 1)
    o.version = s.join('.')
    fs.writeFileSync(fpPj, JSON.stringify(o), 'utf8')
}
//模擬建置寫出主檔
let build = () => {
    fs.mkdirSync(path.dirname(fpMain), { recursive: true })
    fs.writeFileSync(fpMain, 'built', 'utf8')
}
let normalRow = (cmd) => {
    if (cmd === 'node toolg/addVersion.mjs') {
        bump()
    }
    if (cmd === 'node toolg/build.mjs') {
        build()
    }
}


describe('runScript 呼叫點(注入樁; R10、R17、R20 與最終閘門)', function() {

    //安全網: 本檔 script.txt 含 git、npm publish 列(全由 opt.exec 樁吃掉)。萬一注入失效而走到真的 ectScripts, 會呼叫 powershell 執行 git/npm publish——
    //故測試期間自 PATH 移除 powershell 所在目錄, 使任何真實執行都在啟動時失敗(spawn ENOENT), 不可能碰到 git 或 npm; fixture 之 package.json 另設 private
    let pathOri
    before(function() {
        pathOri = process.env.PATH
        process.env.PATH = pathOri.split(';').filter((s) => s && !fs.existsSync(path.join(s, 'powershell.exe'))).join(';')
        fs.rmSync(fdTmp, { recursive: true, force: true })
        mkFixturePkg(fdPkg)
    })

    after(function() {
        process.env.PATH = pathOri
        fs.rmSync(fdTmp, { recursive: true, force: true })
        cleanTmpRoot()
    })

    it('全部正常: 各列依序交給 exec(node 列 main=node、npm 列 main=npm、git 列 main=git〔R6, 2026-10-17〕), 版本已遞增後以新版號走最終閘門 (R20.2 正向)', async function() {
        let s = setup({ onRow: normalRow })
        await quiet(() => runScript(pdi, 'update pks', s.opt))
        assert.deepStrictEqual(s.rows, [
            { cmd: 'node toolg/addVersion.mjs', main: 'node' },
            { cmd: 'node toolg/build.mjs', main: 'node' },
            { cmd: 'git add .  -A', main: 'git' },
            { cmd: `git commit -m 'modify: update pks'`, main: 'git' },
            { cmd: 'npm publish', main: 'npm' },
        ])
        assert.deepStrictEqual(s.npmCalls, ['sbx-gates@0.0.2'])
        assert.strictEqual(s.gitCalls.length, 1) //R10: dist 閘門只在首個 git 列前執行一次
        assert.strictEqual(s.gitCalls[0], fdPkg) //以套件資料夾為 cwd
    })

    it('R17.1 主檔缺失 → 在第一個 git 列被交給 exec 之前 throw 建置主檔異常, 不執行 git 與 publish, 不走最終閘門', async function() {
        let s = setup({ onRow: (cmd) => { if (cmd === 'node toolg/addVersion.mjs') { bump() } } }) //build 列不產出主檔
        await assert.rejects(quiet(() => runScript(pdi, 'update pks', s.opt)), /^Error: \[sbx-gates\] 建置主檔異常: main\[dist\/a\.umd\.js\]不存在/)
        assert.deepStrictEqual(s.rows.map((r) => r.cmd), ['node toolg/addVersion.mjs', 'node toolg/build.mjs']) //git 列未被呼叫
        assert.deepStrictEqual(s.npmCalls, [])
    })

    it('R17.1 主檔為空檔 → 同樣在 git 之前中止', async function() {
        let s = setup({ onRow: (cmd) => { normalRow(cmd); if (cmd === 'node toolg/build.mjs') { fs.writeFileSync(fpMain, '', 'utf8') } } })
        await assert.rejects(quiet(() => runScript(pdi, 'update pks', s.opt)), /建置主檔異常: main\[dist\/a\.umd\.js\]為空檔/)
        assert.ok(!s.rows.some((r) => r.cmd.indexOf('git ') === 0))
    })

    it('R17.1 無 git 列但有發布列 → 在 npm publish 之前中止(首個對外列之前), publish 未被呼叫', async function() {
        let s = setup({ script: ['#node toolg/addVersion.mjs', 'node toolg/build.mjs', '#npm publish'], onRow: (cmd) => { if (cmd === 'node toolg/addVersion.mjs') { bump() } } })
        await assert.rejects(quiet(() => runScript(pdi, 'update pks', s.opt)), /建置主檔異常/)
        assert.deepStrictEqual(s.rows.map((r) => r.cmd), ['node toolg/addVersion.mjs', 'node toolg/build.mjs'])
    })

    it('R17.1 npm run deploy 亦屬對外列: 主檔缺失時在 deploy 之前中止', async function() {
        let s = setup({ script: ['#node toolg/addVersion.mjs', 'node toolg/build.mjs', 'npm run deploy', '#npm publish'], onRow: (cmd) => { if (cmd === 'node toolg/addVersion.mjs') { bump() } } })
        await assert.rejects(quiet(() => runScript(pdi, 'update pks', s.opt)), /建置主檔異常/)
        assert.ok(!s.rows.some((r) => r.cmd === 'npm run deploy'))
    })

    it('R17.1 全無對外列(僅建置列)→ 於所有列之後、最終閘門之前檢查(checkRelease:false 以略過 R20)', async function() {
        let s = setup({ script: ['node toolg/build.mjs'], checkRelease: false })
        let opt = { ...s.opt, checkRelease: false }
        await assert.rejects(quiet(() => runScript(pdi, 'update pks', opt)), /建置主檔異常/)
        assert.deepStrictEqual(s.rows.map((r) => r.cmd), ['node toolg/build.mjs']) //所有列已執行
        assert.deepStrictEqual(s.npmCalls, [])
    })

    it('R17.1 每個對外列之前都檢查: git add 之後主檔被刪 → git commit 未被呼叫即 throw 建置主檔異常(原載「只執行一次」使此情況放行)', async function() {
        let s = setup({ onRow: (cmd) => { normalRow(cmd); if (cmd === 'git add .  -A') { fs.rmSync(fpMain, { force: true }) } } })
        await assert.rejects(quiet(() => runScript(pdi, 'update pks', s.opt)), /^Error: \[sbx-gates\] 建置主檔異常: main\[dist\/a\.umd\.js\]不存在/)
        assert.deepStrictEqual(s.rows.map((r) => r.cmd), ['node toolg/addVersion.mjs', 'node toolg/build.mjs', 'git add .  -A'])
        assert.deepStrictEqual(s.npmCalls, [])
    })

    it('R17.1 發布列之前亦檢查: git commit 之後主檔被刪(如 rm -r dist 類列)→ npm publish 未被呼叫', async function() {
        let s = setup({ onRow: (cmd) => { normalRow(cmd); if (cmd.indexOf('git commit') === 0) { fs.rmSync(fpMain, { force: true }) } } })
        await assert.rejects(quiet(() => runScript(pdi, 'update pks', s.opt)), /建置主檔異常/)
        assert.ok(!s.rows.some((r) => r.cmd === 'npm publish'))
    })

    it('R17.1 唯讀 git 查詢列(git status 等)不是對外列: 主檔尚未建出時執行 git status 不觸發主檔閘門與 dist 閘門; dist 閘門在首個對外 git 列才執行 (外審 F07)', async function() {
        let distCalledAt = []
        let s = setup({ script: ['git status', '#node toolg/addVersion.mjs', 'git log -1', 'node toolg/build.mjs', 'git add .  -A', '#npm publish'], onRow: normalRow })
        s.opt.gitStatusDist = () => {
            distCalledAt.push(s.rows.map((r) => r.cmd))
            return ''
        }
        await quiet(() => runScript(pdi, 'update pks', s.opt))
        assert.strictEqual(distCalledAt.length, 1)
        assert.deepStrictEqual(distCalledAt[0], ['git status', 'node toolg/addVersion.mjs', 'git log -1', 'node toolg/build.mjs']) //dist 閘門於 git add 之前才跑, 此時 build 已完成
        assert.strictEqual(s.rows.length, 6)
    })

    it('第二輪 N5: 帶全域選項之唯讀 git(git -C . status、git --no-pager log)在建置前不觸發主檔閘門, 也不影響列序檢查', async function() {
        let s = setup({ script: ['#node toolg/addVersion.mjs', 'git -C . status', 'git --no-pager log -1', 'node toolg/build.mjs', 'git add .  -A', '#npm publish'], onRow: normalRow })
        await quiet(() => runScript(pdi, 'update pks', s.opt))
        assert.strictEqual(s.rows.length, 6)
    })

    it('R17.1 npm run deploy 與 npm publish 後接參數仍是對外列: 主檔缺失時在其之前中止 (外審 F05)', async function() {
        for (let tail of ['npm run deploy -- --message x', 'npm publish --tag next']) {
            let s = setup({ script: ['#node toolg/addVersion.mjs', 'node toolg/build.mjs', tail, '#npm publish'], onRow: (cmd) => { if (cmd === 'node toolg/addVersion.mjs') { bump() } } })
            await assert.rejects(quiet(() => runScript(pdi, 'update pks', s.opt)), /建置主檔異常/, tail)
            assert.ok(!s.rows.some((r) => r.cmd === tail), tail)
        }
    })

    it('R17.1 npm run deployx 不是 deploy: 不觸發主檔閘門(主檔缺失時仍被執行), 其後的 npm publish 才被攔 (外審 F05)', async function() {
        let s = setup({ script: ['#node toolg/addVersion.mjs', 'npm run deployx', '#npm publish'], onRow: (cmd) => { if (cmd === 'node toolg/addVersion.mjs') { bump() } } })
        await assert.rejects(quiet(() => runScript(pdi, 'update pks', s.opt)), /建置主檔異常/)
        assert.deepStrictEqual(s.rows.map((r) => r.cmd), ['node toolg/addVersion.mjs', 'npm run deployx'])
    })

    it('R17.10 留痕整個 runScript 只印一次: 三個對外列之前各檢查一次, 主檔 mtime 舊之留痕仍只出現一次', async function() {
        let s = setup({
            onRow: (cmd) => {
                normalRow(cmd)
                if (cmd === 'node toolg/build.mjs') {
                    let old = new Date(Date.now() - 3 * 3600 * 1000)
                    fs.utimesSync(fpMain, old, old)
                }
            },
        })
        await quiet(() => runScript(pdi, 'update pks', s.opt))
        assert.strictEqual(logs.filter((x) => x.indexOf('主檔留痕') >= 0).length, 1)
    })

    it('R20.2 版本閘門在首個對外列之前: addVersion 未生效 → git add 與 npm publish 都未被呼叫即 throw 版本未遞增 (外審 F03、O-08)', async function() {
        let s = setup({ onRow: (cmd) => { if (cmd === 'node toolg/build.mjs') { build() } } })
        await assert.rejects(quiet(() => runScript(pdi, 'update pks', s.opt)), /^Error: \[sbx-gates\] 版本未遞增/)
        assert.deepStrictEqual(s.rows.map((r) => r.cmd), ['node toolg/addVersion.mjs', 'node toolg/build.mjs'])
        assert.deepStrictEqual(s.npmCalls, []) //最終閘門亦未走到(順序 dist→版本→主檔: dist 閘門只是唯讀 git status 查詢, 已在版本閘門之前執行)
    })

    it('閘門順序: 版本未遞增與主檔缺失同時成立 → 先報版本未遞增 (R20.2 先於 R17.1)', async function() {
        let s = setup({}) //addVersion 不遞增、build 不產出主檔
        await assert.rejects(quiet(() => runScript(pdi, 'update pks', s.opt)), /^Error: \[sbx-gates\] 版本未遞增/)
    })

    it('R20.2 通過後不再重查: 首個對外列之後 package.json 的版本被改回(對外列之後的改版不在此防)→ 不 throw', async function() {
        let s = setup({ onRow: (cmd) => { normalRow(cmd); if (cmd === 'git add .  -A') { let o = JSON.parse(fs.readFileSync(fpPj, 'utf8')); o.version = '0.0.1'; fs.writeFileSync(fpPj, JSON.stringify(o), 'utf8') } } })
        await quiet(() => runScript(pdi, 'update pks', s.opt))
        assert.strictEqual(s.rows.length, 5)
    })

    it('R9 呼叫點接線: npm run deploy(含帶參數形)非逾時失敗 → 依政策重試(間隔以 opt.retryDelayMs 縮短), 第 3 次成功即通過, 印出 2 則重試訊息; npm publish 失敗不重試 (外審 O-12)', async function() {
        for (let deployCmd of ['npm run deploy', 'npm run deploy -- --message x']) {
            let deploys = 0
            let s = setup({ script: ['#node toolg/addVersion.mjs', 'node toolg/build.mjs', deployCmd, '#npm publish'], onRow: normalRow })
            let exec = s.opt.exec
            s.opt.exec = async (p, scps, o = {}) => {
                if (scps === deployCmd) {
                    deploys++
                    if (deploys <= 2) {
                        throw new Error(`[sbx-gates] npm指令失敗(code[1]): ${deployCmd}`)
                    }
                    return ''
                }
                return exec(p, scps, o)
            }
            await quiet(() => runScript(pdi, 'update pks', { ...s.opt, retryDelayMs: 1 }))
            assert.strictEqual(deploys, 3, deployCmd)
            assert.deepStrictEqual(logs.filter((x) => x.indexOf('重試(第') >= 0), [
                `sbx-gates >>> 重試(第 1/2 次, 間隔 30 秒): ${deployCmd}`,
                `sbx-gates >>> 重試(第 2/2 次, 間隔 30 秒): ${deployCmd}`,
            ])
        }
        let publishes = 0
        let s2 = setup({ onRow: normalRow })
        let exec2 = s2.opt.exec
        s2.opt.exec = async (p, scps, o = {}) => {
            if (scps === 'npm publish') {
                publishes++
                throw new Error('[sbx-gates] npm指令失敗(code[1]): npm publish')
            }
            return exec2(p, scps, o)
        }
        await assert.rejects(quiet(() => runScript(pdi, 'update pks', { ...s2.opt, retryDelayMs: 1 })), /npm指令失敗\(code\[1\]\): npm publish/)
        assert.strictEqual(publishes, 1)
    })

    it('R9 逾時不重試: npm run deploy 逾時 → 只執行 1 次, 無重試訊息, 錯誤原樣 throw (外審 O-06、F05)', async function() {
        let deploys = 0
        let s = setup({ script: ['#node toolg/addVersion.mjs', 'node toolg/build.mjs', 'npm run deploy', '#npm publish'], onRow: normalRow })
        let exec = s.opt.exec
        s.opt.exec = async (p, scps, o = {}) => {
            if (scps === 'npm run deploy') {
                deploys++
                throw new Error('[sbx-gates] npm指令失敗(timeout[60ms]): npm run deploy\n輸出')
            }
            return exec(p, scps, o)
        }
        await assert.rejects(quiet(() => runScript(pdi, 'update pks', s.opt)), /npm指令失敗\(timeout\[60ms\]\): npm run deploy/)
        assert.strictEqual(deploys, 1)
        assert.strictEqual(logs.filter((x) => x.indexOf('重試(第') >= 0).length, 0)
    })

    //---- R26 git push 網路類重試與 spawn 失敗撤回遠端旗標(2026-10-17 第 5 次執行, 主控 D2) ----
    let PUSH = 'git push origin master:master'
    let pushScript = ['#node toolg/addVersion.mjs', 'node toolg/build.mjs', 'git add .  -A', `git commit -m 'modify: '`, PUSH, '#npm publish']
    let SPAWN_ERR = `[sbx-gates] git指令失敗(spawn[ENOENT] spawn powershell ENOENT): ${PUSH}\n`
    //push 列依序丟出 errs 中之錯誤(各為 Error 訊息字串), 超過後成功; 其餘列走原樁. 回傳 { s, c }: c.pushes 為 push 嘗試次數, c.remote/c.revoke 為 onRemote/onRemoteRevoke 次數, c.order 為事件序
    let withPush = ({ errs = [], script = pushScript, onRowExtra = () => {} } = {}) => {
        let s = setup({ script, onRow: normalRow })
        let c = { pushes: 0, remote: 0, revoke: 0, order: [] }
        let exec = s.opt.exec
        s.opt.exec = async (p, scps, o = {}) => {
            if (scps === PUSH) {
                c.pushes++
                c.order.push('push')
                if (c.pushes <= errs.length) {
                    throw new Error(errs[c.pushes - 1])
                }
                return ''
            }
            onRowExtra(scps, c)
            return exec(p, scps, o)
        }
        s.opt.retryDelayMs = 1
        s.opt.onRemote = () => {
            c.remote++
            c.order.push('onRemote')
        }
        s.opt.onRemoteRevoke = () => {
            c.revoke++
            c.order.push('revoke')
        }
        return { s, c }
    }
    let netErr = (phrase) => `[sbx-gates] git指令失敗(code[128]): ${PUSH}\n${phrase}`
    let retryLogs = () => logs.filter((x) => x.indexOf('重試(第') >= 0)

    it('R26.1 呼叫點: git push 遇網路類失敗(五個特徵各一)→ 依政策重試, 第 3 次成功即通過; 印 2 則重試訊息(不含致命字樣); onRemote 只在第一次嘗試前通知一次; 不撤回', async function() {
        for (let phrase of [`fatal: unable to access 'https://github.com/x/y.git/': Failed to connect`, 'fatal: unable to access x: Could not resolve host: github.com', 'error: RPC failed; HTTP 500', 'fatal: the remote end hung up unexpectedly', `fatal: unable to access 'x': Empty reply from server`]) {
            let { s, c } = withPush({ errs: [netErr(phrase), netErr(phrase)] })
            await quiet(() => runScript(pdi, 'update pks', s.opt))
            assert.strictEqual(c.pushes, 3, phrase)
            assert.strictEqual(c.remote, 1, phrase)
            assert.strictEqual(c.revoke, 0, phrase)
            assert.deepStrictEqual(c.order, ['onRemote', 'push', 'push', 'push'], phrase) //重試期間不重複通知
            assert.deepStrictEqual(retryLogs(), [`sbx-gates >>> 重試(第 1/2 次, 間隔 30 秒): ${PUSH}`, `sbx-gates >>> 重試(第 2/2 次, 間隔 30 秒): ${PUSH}`], phrase)
            assert.ok(retryLogs().every((x) => !reFatal.test(x)))
            assert.deepStrictEqual(s.npmCalls, ['sbx-gates@0.0.2']) //push 通過後續行至發布與最終閘門
        }
    })

    it('R26.1 呼叫點: git push 網路類失敗連續 3 次 → 耗盡後 throw 最後一次之錯誤(push 共 3 次); 不撤回(已嘗試過 push, 遠端可能已部分接受)', async function() {
        let { s, c } = withPush({ errs: [netErr('fatal: unable to access a: Empty reply'), netErr('error: RPC failed; one'), netErr('fatal: the remote end hung up unexpectedly (third)')] })
        await assert.rejects(quiet(() => runScript(pdi, 'update pks', s.opt)), /git指令失敗\(code\[128\]\): git push origin master:master\nfatal: the remote end hung up unexpectedly \(third\)/)
        assert.strictEqual(c.pushes, 3)
        assert.strictEqual(c.remote, 1)
        assert.strictEqual(c.revoke, 0)
        assert.strictEqual(retryLogs().length, 2)
        assert.deepStrictEqual(s.npmCalls, []) //publish 與最終閘門未執行
    })

    it('R26.1 呼叫點: 非網路類失敗一律不重試(push 只 1 次、無重試訊息、錯誤原樣): non-fast-forward 被拒、GH001、認證失敗、index.lock、逾時(即使輸出含網路特徵)', async function() {
        let errs = [
            `[sbx-gates] git指令失敗(code[1]): ${PUSH}\n ! [rejected]        master -> master (non-fast-forward)`,
            `[sbx-gates] git指令失敗(code[1]): ${PUSH}\nremote: error: GH001: Large files detected.`,
            `[sbx-gates] git指令失敗(code[128]): ${PUSH}\nfatal: Authentication failed for 'https://github.com/x/y.git/'`,
            `[sbx-gates] git指令失敗(code[128]): ${PUSH}\nfatal: Unable to create 'C:/p/.git/index.lock': File exists.`,
            `[sbx-gates] 指令逾時(timeout[3600000ms]): ${PUSH}\nfatal: unable to access x: Empty reply from server`,
        ]
        for (let e of errs) {
            let { s, c } = withPush({ errs: [e] })
            await assert.rejects(quiet(() => runScript(pdi, 'update pks', s.opt)), (err) => err.message === e, e)
            assert.strictEqual(c.pushes, 1, e)
            assert.strictEqual(retryLogs().length, 0, e)
            assert.strictEqual(c.revoke, 0, e) //非 spawn 失敗: 不撤回
            assert.strictEqual(c.remote, 1, e)
        }
    })

    it('R26.2 呼叫點: git push 第一次嘗試即 spawn 失敗(git/PowerShell 根本沒執行)→ 不重試、於 throw 前呼叫 onRemoteRevoke 一次(onRemote 在先), 錯誤原樣', async function() {
        let { s, c } = withPush({ errs: [SPAWN_ERR] })
        await assert.rejects(quiet(() => runScript(pdi, 'update pks', s.opt)), (err) => err.message === SPAWN_ERR)
        assert.strictEqual(c.pushes, 1)
        assert.deepStrictEqual(c.order, ['onRemote', 'push', 'revoke'])
        assert.strictEqual(retryLogs().length, 0)
    })

    it('R26.2 邊界: 網路類失敗後重試時才 spawn 失敗 → 不撤回(第一次嘗試已執行過 git, 遠端可能已部分接受); 一般失敗亦不撤回', async function() {
        let { s, c } = withPush({ errs: [netErr('fatal: unable to access a: Empty reply'), SPAWN_ERR] })
        await assert.rejects(quiet(() => runScript(pdi, 'update pks', s.opt)), (err) => err.message === SPAWN_ERR)
        assert.strictEqual(c.pushes, 2)
        assert.strictEqual(c.revoke, 0)
        assert.strictEqual(c.remote, 1)
    })

    it('R26.2 邊界: 本機 git 列(git add、git commit)spawn 失敗 → 尚未交出遠端列, 不通知也不撤回(由 R21 原有路徑還原); npm run deploy 為第一個遠端列時 spawn 失敗 → 維持不撤回(殘餘)', async function() {
        for (let [script, bad, badErr] of [
            [pushScript, 'git add .  -A', '[sbx-gates] git指令失敗(spawn[ENOENT] spawn powershell ENOENT): git add .  -A\n'],
            [pushScript, `git commit -m 'modify: update pks'`, `[sbx-gates] git指令失敗(spawn[ENOENT] spawn powershell ENOENT): git commit -m 'modify: update pks'\n`],
            [['#node toolg/addVersion.mjs', 'node toolg/build.mjs', 'npm run deploy', '#npm publish'], 'npm run deploy', '[sbx-gates] npm指令失敗(spawn[ENOENT] spawn powershell ENOENT): npm run deploy\n'],
        ]) {
            let { s, c } = withPush({
                script,
                onRowExtra: (cmd) => {
                    if (cmd === bad) {
                        throw new Error(badErr)
                    }
                },
            })
            await assert.rejects(quiet(() => runScript(pdi, 'update pks', s.opt)), (err) => err.message === badErr, bad)
            assert.strictEqual(c.revoke, 0, bad)
            assert.strictEqual(c.remote, bad === 'npm run deploy' ? 1 : 0, bad)
        }
    })

    it('R26.2 未給 onRemoteRevoke / onRemote 時 push 失敗照常 throw 原錯誤(不因回呼缺漏而換成 TypeError)', async function() {
        let { s } = withPush({ errs: [SPAWN_ERR] })
        delete s.opt.onRemote
        delete s.opt.onRemoteRevoke
        await assert.rejects(quiet(() => runScript(pdi, 'update pks', s.opt)), (err) => err.message === SPAWN_ERR)
    })

    it('R25 守衛錯誤不重試(第 5 次外審 opus F12): deploy 列的 exec 若拋測試環境守衛錯誤 → 只執行 1 次、無重試訊息、錯誤原樣(標記保留)', async function() {
        let guardErr = null
        try {
            assertRealExecAllowed('siteGate')
        }
        catch (err) {
            guardErr = err
        }
        assert.ok(isTestGuardError(guardErr))
        let deploys = 0
        let s = setup({ script: ['#node toolg/addVersion.mjs', 'node toolg/build.mjs', 'npm run deploy', '#npm publish'], onRow: normalRow })
        let exec = s.opt.exec
        s.opt.exec = async (p, scps, o = {}) => {
            if (scps === 'npm run deploy') {
                deploys++
                throw guardErr
            }
            return exec(p, scps, o)
        }
        await assert.rejects(quiet(() => runScript(pdi, 'update pks', { ...s.opt, retryDelayMs: 1 })), (err) => err === guardErr)
        assert.strictEqual(deploys, 1)
        assert.strictEqual(logs.filter((x) => x.indexOf('重試(第') >= 0).length, 0)
    })

    it('R17.2 主檔 mtime 早於起點 → 只印留痕 主檔留痕, 不中止, 續行至最終閘門 (留痕不含致命字樣 R17.6)', async function() {
        let s = setup({
            onRow: (cmd) => {
                normalRow(cmd)
                if (cmd === 'node toolg/build.mjs') {
                    let old = new Date(Date.now() - 3 * 3600 * 1000)
                    fs.utimesSync(fpMain, old, old)
                }
            },
        })
        await quiet(() => runScript(pdi, 'update pks', s.opt)) //起點預設為 Date.now(): 主檔 mtime 為 3 小時前 → 留痕
        let traces = logs.filter((x) => x.indexOf('主檔留痕') >= 0)
        assert.strictEqual(traces.length, 1)
        assert.ok(traces[0].indexOf('[sbx-gates] 主檔留痕: main[dist/a.umd.js]未於本輪重寫') === 0, traces[0])
        assert.ok(!reFatal.test(traces[0]))
        assert.strictEqual(s.rows.length, 5)
        assert.deepStrictEqual(s.npmCalls, ['sbx-gates@0.0.2'])
    })

    it('R17.3 無 main/module/browser 欄位之套件不檢查 → 正常通過', async function() {
        let s = setup({ main: false, onRow: normalRow })
        await quiet(() => runScript(pdi, 'update pks', s.opt))
        assert.strictEqual(s.rows.length, 5)
    })

    it('R10 dist 閘門呼叫點: gitStatusDist 回報僅刪除而零產出 → 在第一個 git 列之前 throw 建置產物遭刪除且無任何產出', async function() {
        let s = setup({ onRow: normalRow, gitStatusDist: ' D dist/a.umd.js\n D dist/a.umd.js.map\n' })
        await assert.rejects(quiet(() => runScript(pdi, 'update pks', s.opt)), /^Error: \[sbx-gates\] 建置產物遭刪除且無任何產出:/)
        assert.ok(!s.rows.some((r) => r.cmd.indexOf('git ') === 0))
        assert.deepStrictEqual(s.npmCalls, [])
    })

    it('R10 dist 閘門呼叫點: 有刪除且有產出(hash 檔名 rebuild)→ 放行; gitStatusDist 拋錯(非 git 倉庫)→ 略過放行', async function() {
        let s1 = setup({ onRow: normalRow, gitStatusDist: ' D dist/js/app.1.js\n?? dist/js/app.2.js\n' })
        await quiet(() => runScript(pdi, 'update pks', s1.opt))
        assert.strictEqual(s1.rows.length, 5)
        let s2 = setup({ onRow: normalRow, gitStatusDist: () => { throw new Error('not a git repository') } })
        await quiet(() => runScript(pdi, 'update pks', s2.opt))
        assert.strictEqual(s2.rows.length, 5)
    })

    it('R20.2 版本未遞增(addVersion 列未生效)→ 在最終閘門之前 throw 版本未遞增(起跑[0.0.1]、結束[0.0.1]), checkNpm 未被呼叫', async function() {
        let s = setup({ onRow: (cmd) => { if (cmd === 'node toolg/build.mjs') { build() } } }) //addVersion 列不遞增
        await assert.rejects(quiet(() => runScript(pdi, 'update pks', s.opt)), /^Error: \[sbx-gates\] 版本未遞增\(起跑\[0\.0\.1\]、結束\[0\.0\.1\]\): addVersion 列未生效/)
        assert.deepStrictEqual(s.npmCalls, [])
    })

    it('R20.3 opt.checkRelease=false: 不要求必要列與版本遞增, 以未遞增之版號走最終閘門', async function() {
        let s = setup({ script: ['node toolg/build.mjs'], onRow: normalRow })
        await quiet(() => runScript(pdi, 'update pks', { ...s.opt, checkRelease: false }))
        assert.deepStrictEqual(s.npmCalls, ['sbx-gates@0.0.1'])
    })

    it('R20.1 script.txt 缺發布列 → 於第一列之前 throw 缺少必要列, 沒有任何列被執行', async function() {
        let s = setup({ script: ['#node toolg/addVersion.mjs', 'node toolg/build.mjs'], onRow: normalRow })
        await assert.rejects(quiet(() => runScript(pdi, 'update pks', s.opt)), /^Error: \[sbx-gates\] script\.txt缺少必要列\(執行前檢查, 尚未執行任何列\)/)
        assert.deepStrictEqual(s.rows, [])
    })

    it('最終閘門: checkNpm 回 false → throw npm上找不到[套件@新版號](沿用既有行為; 版號為 bump 後之新版)', async function() {
        let s = setup({ onRow: normalRow, checkNpmResult: false })
        await assert.rejects(quiet(() => runScript(pdi, 'update pks', s.opt)), /^Error: npm上找不到\[sbx-gates@0\.0\.2\]/)
    })

    it('所有守望字樣之訊息皆含 reFatal 可比對之字樣 (R17、R20、最終閘門)', async function() {
        let msgs = []
        let s1 = setup({ onRow: (cmd) => { if (cmd === 'node toolg/addVersion.mjs') { bump() } } })
        await quiet(() => runScript(pdi, 'update pks', s1.opt)).catch((e) => msgs.push(e.message))
        let s2 = setup({ onRow: (cmd) => { if (cmd === 'node toolg/build.mjs') { build() } } })
        await quiet(() => runScript(pdi, 'update pks', s2.opt)).catch((e) => msgs.push(e.message))
        assert.strictEqual(msgs.length, 2)
        for (let m of msgs) {
            assert.ok(reFatal.test(m), m)
        }
    })

    it('R6 呼叫點: 唯讀 git 列(git status、git -C . log)與對外 git 列皆以 main=git 呼叫 exec; .bin 列無 main; rm 與註解列不呼叫 exec', async function() {
        let s = setup({ script: ['git status', '#node toolg/addVersion.mjs', './node_modules/.bin/fakebin 0', 'node toolg/build.mjs', 'git -C . log -1', 'git add .  -A', `git commit -m 'modify: '`, '#npm publish'], onRow: normalRow })
        await quiet(() => runScript(pdi, 'update pks', s.opt))
        assert.deepStrictEqual(s.rows.map((r) => [r.cmd, r.main]), [
            ['git status', 'git'],
            ['node toolg/addVersion.mjs', 'node'],
            ['./node_modules/.bin/fakebin 0', undefined],
            ['node toolg/build.mjs', 'node'],
            ['git -C . log -1', 'git'],
            ['git add .  -A', 'git'],
            [`git commit -m 'modify: update pks'`, 'git'],
            ['npm publish', 'npm'],
        ])
    })

    it('R6 呼叫點: exec 對 git 列 throw git指令失敗(如 index.lock 殘留之 128)→ 該錯誤原樣向上拋, 其後之列(含 npm publish)不執行、不走最終閘門', async function() {
        let s = setup({ onRow: (cmd) => {
            normalRow(cmd)
            if (cmd.indexOf('git commit') === 0) {
                throw new Error(`[sbx-gates] git指令失敗(code[128]): ${cmd}\nfatal: Unable to create '.git/index.lock': File exists.`)
            }
        } })
        await assert.rejects(quiet(() => runScript(pdi, 'update pks', s.opt)), /^Error: \[sbx-gates\] git指令失敗\(code\[128\]\): git commit/)
        assert.ok(!s.rows.some((r) => r.cmd === 'npm publish'))
        assert.deepStrictEqual(s.npmCalls, [])
    })

})


describe('runScript opt.onRemote 呼叫時序(R21.3; 注入樁)', function() {

    let pathOri
    before(function() {
        pathOri = process.env.PATH
        process.env.PATH = pathOri.split(';').filter((s) => s && !fs.existsSync(path.join(s, 'powershell.exe'))).join(';')
        fs.rmSync(fdTmp, { recursive: true, force: true })
        mkFixturePkg(fdPkg)
    })

    after(function() {
        process.env.PATH = pathOri
        fs.rmSync(fdTmp, { recursive: true, force: true })
        cleanTmpRoot()
    })

    //標準 script(含 git push 為遠端列)
    let withPush = ['#node toolg/addVersion.mjs', 'node toolg/build.mjs', 'git add .  -A', `git commit -m 'modify: '`, 'git push origin master:master', 'npm run deploy', '#npm publish']

    //onRemote 與 exec 共用一條事件序列, 以驗證「在第一個遠端列的 exec 之前、其閘門之後」呼叫
    let withEvents = (s) => {
        let ev = []
        let execOri = s.opt.exec
        s.opt.exec = async (p, scps, o) => {
            ev.push(`exec|${Array.isArray(scps) ? scps.join(' ; ') : scps}`)
            return execOri(p, scps, o)
        }
        s.opt.onRemote = () => {
            ev.push('onRemote')
        }
        return ev
    }

    it('R21.3 第一個遠端列(git push)的 exec 之前恰呼叫一次; 其前的 node 列、唯讀 git 列、.bin 列、git add、git commit 之前與之後都不呼叫; 後續遠端列(deploy、publish)不再呼叫', async function() {
        let s = setup({ script: ['git status', '#node toolg/addVersion.mjs', './node_modules/.bin/fakebin 0', 'node toolg/build.mjs', 'git add .  -A', `git commit -m 'modify: '`, 'git push origin master:master', 'npm run deploy', '#npm publish'], onRow: normalRow })
        let ev = withEvents(s)
        await quiet(() => runScript(pdi, 'update pks', s.opt))
        assert.deepStrictEqual(ev, [
            'exec|git status',
            'exec|node toolg/addVersion.mjs',
            'exec|./node_modules/.bin/fakebin 0',
            'exec|node toolg/build.mjs',
            'exec|git add .  -A',
            `exec|git commit -m 'modify: update pks'`,
            'onRemote',
            'exec|git push origin master:master',
            'exec|npm run deploy',
            'exec|npm publish',
        ])
    })

    it('R21.3 無 push 的 script: 第一個遠端列為 npm run deploy 或 npm publish → 在其 exec 之前呼叫(git add、git commit 不算)', async function() {
        let s1 = setup({ script: ['#node toolg/addVersion.mjs', 'node toolg/build.mjs', 'git add .  -A', `git commit -m 'modify: '`, 'npm run deploy', '#npm publish'], onRow: normalRow })
        let ev1 = withEvents(s1)
        await quiet(() => runScript(pdi, 'update pks', s1.opt))
        assert.deepStrictEqual(ev1.slice(-3), ['onRemote', 'exec|npm run deploy', 'exec|npm publish'], JSON.stringify(ev1))
        assert.strictEqual(ev1.filter((x) => x === 'onRemote').length, 1)
        assert.ok(ev1.indexOf('onRemote') > ev1.indexOf(`exec|git commit -m 'modify: update pks'`))
        assert.strictEqual(ev1[ev1.indexOf('onRemote') + 1], 'exec|npm run deploy')
        let s2 = setup({ script: ['#node toolg/addVersion.mjs', 'node toolg/build.mjs', '#npm publish'], onRow: normalRow })
        let ev2 = withEvents(s2)
        await quiet(() => runScript(pdi, 'update pks', s2.opt))
        assert.deepStrictEqual(ev2.slice(-2), ['onRemote', 'exec|npm publish'])
    })

    it('R21.3 npm 的等價寫法(連續空白)亦是遠端列: npm run  deploy → 在其 exec 之前呼叫(外審 sol F2)', async function() {
        let s = setup({ script: ['#node toolg/addVersion.mjs', 'node toolg/build.mjs', 'npm run  deploy', '#npm publish'], onRow: normalRow })
        let ev = withEvents(s)
        await quiet(() => runScript(pdi, 'update pks', s.opt))
        assert.deepStrictEqual(ev.slice(-3), ['onRemote', 'exec|npm run  deploy', 'exec|npm publish'])
    })

    it('R21.3 第一個遠端列自身 exec 失敗(git push 128)→ onRemote 已先呼叫(遠端可能已部分接受, 不屬「之前」)', async function() {
        let s = setup({ script: withPush, onRow: (cmd) => {
            normalRow(cmd)
            if (cmd.indexOf('git push') === 0) {
                throw new Error('[sbx-gates] git指令失敗(code[128]): git push')
            }
        } })
        let ev = withEvents(s)
        await assert.rejects(quiet(() => runScript(pdi, 'update pks', s.opt)), /git指令失敗/)
        assert.strictEqual(ev.filter((x) => x === 'onRemote').length, 1)
        assert.ok(ev.indexOf('onRemote') < ev.indexOf('exec|git push origin master:master'))
    })

    it('R21.3 本機 git 列自身失敗(git add 128、git commit 128)→ onRemote 尚未呼叫(本機動作, 遠端未變, 可還原)', async function() {
        for (let bad of ['git add .  -A', `git commit -m 'modify: update pks'`]) {
            let s = setup({ script: withPush, onRow: (cmd) => {
                normalRow(cmd)
                if (cmd === bad) {
                    throw new Error(`[sbx-gates] git指令失敗(code[128]): ${cmd}\nfatal: Unable to create '.git/index.lock': File exists.`)
                }
            } })
            let ev = withEvents(s)
            await assert.rejects(quiet(() => runScript(pdi, 'update pks', s.opt)), /git指令失敗\(code\[128\]\)/)
            assert.ok(!ev.includes('onRemote'), `${bad}: ${JSON.stringify(ev)}`)
            assert.ok(!ev.includes('exec|git push origin master:master'))
        }
    })

    it('R21.3 閘門失敗時不呼叫: 主檔缺失(R17)、版本未遞增(R20.2)、dist 遭刪除(R10)皆在 onRemote 之前 throw; git add 之後主檔被刪使 git commit 前的 R17 throw 亦在 onRemote 之前', async function() {
        let s1 = setup({ script: withPush, onRow: (cmd) => { if (cmd === 'node toolg/addVersion.mjs') { bump() } } }) //build 不產出主檔
        let ev1 = withEvents(s1)
        await assert.rejects(quiet(() => runScript(pdi, 'update pks', s1.opt)), /建置主檔異常/)
        assert.ok(!ev1.includes('onRemote'), JSON.stringify(ev1))
        let s2 = setup({ script: withPush, onRow: (cmd) => { if (cmd === 'node toolg/build.mjs') { build() } } }) //addVersion 未生效
        let ev2 = withEvents(s2)
        await assert.rejects(quiet(() => runScript(pdi, 'update pks', s2.opt)), /版本未遞增/)
        assert.ok(!ev2.includes('onRemote'), JSON.stringify(ev2))
        let s3 = setup({ script: withPush, onRow: normalRow, gitStatusDist: () => ' D dist/a.umd.js\n' })
        let ev3 = withEvents(s3)
        await assert.rejects(quiet(() => runScript(pdi, 'update pks', s3.opt)), /建置產物遭刪除且無任何產出/)
        assert.ok(!ev3.includes('onRemote'), JSON.stringify(ev3))
        let s4 = setup({ script: withPush, onRow: (cmd) => { normalRow(cmd); if (cmd === 'git add .  -A') { fs.rmSync(fpMain, { force: true }) } } })
        let ev4 = withEvents(s4)
        await assert.rejects(quiet(() => runScript(pdi, 'update pks', s4.opt)), /建置主檔異常/)
        assert.ok(!ev4.includes('onRemote'), JSON.stringify(ev4))
        assert.ok(ev4.includes('exec|git add .  -A') && !ev4.includes(`exec|git commit -m 'modify: update pks'`))
    })

    it('R21.3 非對外列失敗時不呼叫: 建置 node 列失敗、.bin 列逾時、npm run build 失敗、唯讀 git 128 皆發生於 onRemote 之前', async function() {
        for (let [bad, err] of [
            ['node toolg/build.mjs', '[sbx-gates] node指令失敗(code[1]): node toolg/build.mjs'],
            ['./node_modules/.bin/fakebin 0', '[sbx-gates] 指令逾時(timeout[1000ms]): ./node_modules/.bin/fakebin 0'],
            ['npm run build', '[sbx-gates] npm指令失敗(code[1]): npm run build'],
            ['git status', '[sbx-gates] git指令失敗(code[128]): git status'],
        ]) {
            let s = setup({ script: ['git status', '#node toolg/addVersion.mjs', 'npm run build', './node_modules/.bin/fakebin 0', 'node toolg/build.mjs', 'git add .  -A', 'git push', '#npm publish'], onRow: (cmd) => {
                normalRow(cmd)
                if (cmd === bad) {
                    throw new Error(err)
                }
            } })
            let ev = withEvents(s)
            await assert.rejects(quiet(() => runScript(pdi, 'update pks', s.opt)), (e) => e.message === err, bad)
            assert.ok(!ev.includes('onRemote'), `${bad}: ${JSON.stringify(ev)}`)
        }
    })

    it('R21.3 第二個遠端列的閘門失敗(git push 之後主檔被刪, R17.1 每個對外列)→ onRemote 已在第一個遠端列呼叫過一次, 不重複呼叫; deploy 未被呼叫', async function() {
        let s = setup({ script: withPush, onRow: (cmd) => { normalRow(cmd); if (cmd.indexOf('git push') === 0) { fs.rmSync(fpMain, { force: true }) } } })
        let ev = withEvents(s)
        await assert.rejects(quiet(() => runScript(pdi, 'update pks', s.opt)), /建置主檔異常/)
        assert.strictEqual(ev.filter((x) => x === 'onRemote').length, 1)
        assert.ok(!ev.includes('exec|npm run deploy'))
    })

    it('R21.3(外審 sol F5)onRemote 緊鄰 exec: 「>>> exec」回顯 console.log 同步 throw 時, onRemote 與 exec 皆未發生(未交出任何遠端動作, 可還原)', async function() {
        let s = setup({ script: ['#node toolg/addVersion.mjs', 'node toolg/build.mjs', 'git add .  -A', 'git push origin master:master', '#npm publish'], onRow: normalRow })
        let ev = withEvents(s)
        let logOri = console.log
        console.log = (...args) => {
            let line = args.join(' ')
            if (line.indexOf('>>> exec:') >= 0 && line.indexOf('git push') >= 0) {
                throw new Error('EIO injected: console.log failed')
            }
        }
        try {
            await assert.rejects(runScript(pdi, 'update pks', s.opt), /EIO injected/)
        }
        finally {
            console.log = logOri
        }
        assert.ok(!ev.includes('onRemote'), JSON.stringify(ev))
        assert.ok(!ev.includes('exec|git push origin master:master'), JSON.stringify(ev))
    })

    it('R21.9 自訂 onRemote 回呼 throw → runScript 以該錯誤中止, 遠端列的 exec 未被呼叫', async function() {
        let s = setup({ script: withPush, onRow: normalRow })
        let called = []
        let execOri = s.opt.exec
        s.opt.exec = async (p, scps, o) => {
            called.push(Array.isArray(scps) ? scps.join(' ; ') : scps)
            return execOri(p, scps, o)
        }
        s.opt.onRemote = () => {
            throw new Error('callback boom')
        }
        await assert.rejects(quiet(() => runScript(pdi, 'update pks', s.opt)), /^Error: callback boom$/)
        assert.ok(!called.includes('git push origin master:master'), JSON.stringify(called))
    })

    it('R21.4 無遠端列之 script(checkRelease:false)→ 全程不呼叫 onRemote', async function() {
        let s = setup({ script: ['node toolg/build.mjs'], onRow: normalRow })
        let ev = withEvents(s)
        await quiet(() => runScript(pdi, 'update pks', { ...s.opt, checkRelease: false }))
        assert.ok(!ev.includes('onRemote'), JSON.stringify(ev))
    })

    it('R21.9 未給 opt.onRemote 時行為不變(既有呼叫點不受影響); 給非函式值亦略過', async function() {
        let s = setup({ onRow: normalRow })
        await quiet(() => runScript(pdi, 'update pks', s.opt))
        let s2 = setup({ onRow: normalRow })
        await quiet(() => runScript(pdi, 'update pks', { ...s2.opt, onRemote: 'not a function' }))
    })

    it('R10/外審 opus F5 dist 閘門取 git status 自身 exit ≥128(非倉庫、dubious ownership)→ throw git指令失敗(code[N]) 於 onRemote 與 git add 之前; status 為 null(無法啟動)或小於 128 仍略過', async function() {
        let mkErr = (status) => Object.assign(new Error('Command failed: git status --porcelain -- dist'), { status, stderr: Buffer.from('fatal: detected dubious ownership in repository') })
        let s = setup({ script: withPush, onRow: normalRow, gitStatusDist: () => { throw mkErr(128) } })
        let ev = withEvents(s)
        await assert.rejects(quiet(() => runScript(pdi, 'update pks', s.opt)), (e) => /^\[sbx-gates\] git指令失敗\(code\[128\]\): git status --porcelain -- dist/.test(e.message) && e.message.indexOf('dubious ownership') >= 0 && reFatal.test(e.message))
        assert.ok(!ev.includes('onRemote') && !ev.includes('exec|git add .  -A'), JSON.stringify(ev))
        for (let status of [null, 1, 127, undefined]) {
            let s2 = setup({ script: withPush, onRow: normalRow, gitStatusDist: () => { throw mkErr(status) } })
            let ev2 = withEvents(s2)
            await quiet(() => runScript(pdi, 'update pks', s2.opt)) //略過, 照常走完
            assert.ok(ev2.includes('onRemote'), `status=${status}`)
        }
    })

})
