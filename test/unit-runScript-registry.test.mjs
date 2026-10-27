//runScript 倉庫設定與同時發布(鏡像)之呼叫點測試(同一行程內; 以 opt.exec、opt.checkNpm、opt.gitStatusDist 注入樁, 不執行任何列、不執行 git、不查 npm、不 publish)
//對應需求(帳本 sgud/rule/rulebook.md 二 R27): R27.2 主倉庫經 exec 之 registry 選項套用於每個 exec; R27.3 最終閘門查主倉庫、鏡像不列入等待條件;
//R27.4 主倉庫 publish 成功後才發鏡像、鏡像失敗不使套件失敗且不中止、已存在同版視為已同步、閘門每個鏡像重過; R27.5 npm 列不得自帶 --registry; R21 還原邊界不因鏡像改變(onRemote 恰一次, 於主發布列之前)
//fixture 於 test/_tmp/unit-runScript-registry, before 建立、after 刪除; script.txt 以 writeScript(stubbed:true) 寫入(含 git、publish 列, 但全部由樁吃掉)
import assert from 'assert'
import fs from 'fs'
import path from 'path'
import runScript, { loadScript, classifyLine, hasNpmRegistryOverride, getPublishTargetIssue } from '../src/runScript.mjs'
import { mkFixturePkg, writeScript, cleanTmpRoot } from './tools/mkFixturePkg.mjs'
import { reFatal } from './tools/fatalWords.mjs'


let fdTmp = path.resolve('./test/_tmp/unit-runScript-registry')
let fdPkg = path.join(fdTmp, 'pkg')
let pdi = { name: 'sbx-reg', path: fdPkg }
let fpMain = path.join(fdPkg, 'dist', 'a.umd.js')
let fpPj = path.join(fdPkg, 'package.json')

let MAIN = 'http://localhost:48731/'
let MA = 'https://mirror-a.example.test/'
let MB = 'https://mirror-b.example.test/'

//標準 script: 版本遞增 → 建置 → bin 列 → 兩個 git 列 → 發布
let fullScript = ['#node toolg/addVersion.mjs', 'node toolg/build.mjs', './node_modules/.bin/fakebin 0', 'git add .  -A', `git commit -m 'modify: '`, '#npm publish']

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

//備妥一次情境; onRow(cmd) 為樁 exec 執行該列時之副作用(可改檔、可 throw)
let setup = ({ script = fullScript, onRow = () => {}, registryConfig, checkNpmResult = true } = {}) => {
    fs.rmSync(path.join(fdPkg, 'dist'), { recursive: true, force: true })
    fs.writeFileSync(fpPj, JSON.stringify({ name: 'sbx-reg', version: '0.0.1', private: true, main: 'dist/a.umd.js' }), 'utf8')
    writeScript(fdPkg, script, { stubbed: true })
    let s = { rows: [], npmCalls: [], remote: 0, mirrorResults: [], remoteAtRow: [] }
    s.opt = {
        checkRelease: true,
        exec: async (p, scps, ...rest) => {
            let cmd = Array.isArray(scps) ? scps.join(' ; ') : scps
            s.rows.push({ cmd, args: rest, o: rest[0] })
            s.remoteAtRow.push(s.remote)
            onRow(cmd)
            return ''
        },
        checkNpm: async (...args) => {
            s.npmCalls.push(args)
            return checkNpmResult
        },
        gitStatusDist: () => '',
        onRemote: () => {
            s.remote++
        },
        onMirrorResult: (r) => s.mirrorResults.push(r),
    }
    if (registryConfig !== undefined) {
        s.opt.registryConfig = registryConfig
    }
    return s
}

let normalRow = (cmd) => {
    if (cmd === 'node toolg/addVersion.mjs') {
        let o = JSON.parse(fs.readFileSync(fpPj, 'utf8'))
        o.version = '0.0.2'
        fs.writeFileSync(fpPj, JSON.stringify(o), 'utf8')
    }
    if (cmd === 'node toolg/build.mjs') {
        fs.mkdirSync(path.dirname(fpMain), { recursive: true })
        fs.writeFileSync(fpMain, 'built', 'utf8')
    }
}


describe('runScript 倉庫設定與同時發布(R27)', function() {

    //安全網: 同 unit-runScript-gates(script.txt 含 git、npm publish 列, 全由 opt.exec 樁吃掉; 萬一注入失效, PATH 無 powershell 使真實執行在啟動時失敗)
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

    describe('主倉庫套用(R27.2、R27.3)', function() {

        it('R27.2 給 registryConfig → 每個 exec(node、bin、git、npm 列)都帶 registry=主倉庫, 原有選項(main)不變', async function() {
            let s = setup({ onRow: normalRow, registryConfig: { main: MAIN, mirrors: [] } })
            await quiet(() => runScript(pdi, 'update pks', s.opt))
            assert.deepStrictEqual(s.rows.map((r) => r.cmd), ['node toolg/addVersion.mjs', 'node toolg/build.mjs', './node_modules/.bin/fakebin 0', 'git add .  -A', `git commit -m 'modify: update pks'`, 'npm publish'])
            assert.deepStrictEqual(s.rows.map((r) => r.o), [
                { main: 'node', registry: MAIN },
                { main: 'node', registry: MAIN },
                { registry: MAIN },
                { main: 'git', registry: MAIN },
                { main: 'git', registry: MAIN },
                { main: 'npm', registry: MAIN },
            ])
        })

        it('R27.2 registryConfig 之主倉庫入口即正規化(無結尾斜線、大寫主機)再交給 exec', async function() {
            let s = setup({ onRow: normalRow, registryConfig: { main: 'HTTP://LOCALHOST:48731', mirrors: [] } })
            await quiet(() => runScript(pdi, 'update pks', s.opt))
            for (let r of s.rows) {
                assert.strictEqual(r.o.registry, MAIN, r.cmd)
            }
        })

        it('R27.2 不給 registryConfig(僅測試)→ exec 之選項與原本完全相同(node 列 { main }、bin 列不帶第三參數), 不帶 registry', async function() {
            let s = setup({ onRow: normalRow })
            await quiet(() => runScript(pdi, 'update pks', s.opt))
            assert.deepStrictEqual(s.rows.map((r) => r.o), [{ main: 'node' }, { main: 'node' }, undefined, { main: 'git' }, { main: 'git' }, { main: 'npm' }])
            assert.strictEqual(s.rows[2].args.length, 0)
        })

        it('R27.3 最終閘門查主倉庫: checkNpm(name, 新版, { registry: 主倉庫 }); 未給 registryConfig 則只傳 (name, 新版)', async function() {
            let s = setup({ onRow: normalRow, registryConfig: { main: MAIN, mirrors: [MA] } })
            await quiet(() => runScript(pdi, 'update pks', s.opt))
            assert.deepStrictEqual(s.npmCalls, [['sbx-reg', '0.0.2', { registry: MAIN }]])
            let s2 = setup({ onRow: normalRow })
            await quiet(() => runScript(pdi, 'update pks', s2.opt))
            assert.deepStrictEqual(s2.npmCalls, [['sbx-reg', '0.0.2']])
        })

        it('R27.3 主倉庫查不到 → npm上找不到(守望字樣不變); 鏡像全數成功也不改變此結果(鏡像不列入等待條件)', async function() {
            let s = setup({ onRow: normalRow, registryConfig: { main: MAIN, mirrors: [MA] }, checkNpmResult: false })
            await assert.rejects(quiet(() => runScript(pdi, 'update pks', s.opt)), /^Error: npm上找不到\[sbx-reg@0\.0\.2\]/)
            assert.strictEqual(s.mirrorResults.length, 1)
            assert.strictEqual(s.mirrorResults[0].status, 'ok')
            assert.deepStrictEqual(s.npmCalls.map((c) => c[2]), [{ registry: MAIN }]) //只查主倉庫, 沒有查鏡像
        })

    })

    describe('同時發布(鏡像; R27.4)', function() {

        it('R27.4 鏡像關閉(mirrors 為空)→ 不多執行任何列、不呼叫 onMirrorResult', async function() {
            let s = setup({ onRow: normalRow, registryConfig: { main: MAIN, mirrors: [] } })
            await quiet(() => runScript(pdi, 'update pks', s.opt))
            assert.strictEqual(s.rows.filter((r) => r.cmd.indexOf('--registry=') >= 0).length, 0)
            assert.deepStrictEqual(s.mirrorResults, [])
        })

        it('R27.4 鏡像開啟: 主發布列成功後依序對每個鏡像執行 `npm publish --registry=<鏡像>`(逾時 10 分鐘), 其後才是最終閘門; 結果交 onMirrorResult', async function() {
            let s = setup({ onRow: normalRow, registryConfig: { main: MAIN, mirrors: [MA, MB] } })
            await quiet(() => runScript(pdi, 'update pks', s.opt))
            let tail = s.rows.slice(-3)
            assert.deepStrictEqual(tail.map((r) => r.cmd), ['npm publish', `npm publish --registry=${MA}`, `npm publish --registry=${MB}`])
            assert.deepStrictEqual(tail[0].o, { main: 'npm', registry: MAIN }) //主發布列: 主倉庫以環境變數套用, 命令列原樣(script.txt 原列)
            assert.deepStrictEqual(tail[1].o, { main: 'npm', timeoutMs: 600000 }) //鏡像列: 以 --registry 旗標指定(優先於環境變數), 不帶主倉庫環境變數
            assert.deepStrictEqual(s.mirrorResults.map((r) => [r.name, r.version, r.mirror, r.status]), [['sbx-reg', '0.0.2', MA, 'ok'], ['sbx-reg', '0.0.2', MB, 'ok']])
            assert.strictEqual(s.npmCalls.length, 1)
        })

        it('R27.4 原發布列帶參數(npm publish --tag next)→ 鏡像列保留該參數', async function() {
            let s = setup({ script: ['#node toolg/addVersion.mjs', 'node toolg/build.mjs', 'npm publish --tag next'], onRow: normalRow, registryConfig: { main: MAIN, mirrors: [MA] } })
            await quiet(() => runScript(pdi, 'update pks', s.opt))
            assert.deepStrictEqual(s.rows.slice(-2).map((r) => r.cmd), ['npm publish --tag next', `npm publish --tag next --registry=${MA}`])
        })

        it('R27.4 script.txt 無對外 git 列、只有 npm publish 列 → 鏡像照常於其後發布', async function() {
            let s = setup({ script: ['#node toolg/addVersion.mjs', 'node toolg/build.mjs', '#npm publish'], onRow: normalRow, registryConfig: { main: MAIN, mirrors: [MA] } })
            await quiet(() => runScript(pdi, 'update pks', s.opt))
            assert.deepStrictEqual(s.rows.slice(-2).map((r) => r.cmd), ['npm publish', `npm publish --registry=${MA}`])
        })

        it('R27.4 非 npm publish 的 npm 列(npm run deploy)不觸發鏡像', async function() {
            let s = setup({ script: ['#node toolg/addVersion.mjs', 'node toolg/build.mjs', 'npm run deploy', '#npm publish'], onRow: normalRow, registryConfig: { main: MAIN, mirrors: [MA] } })
            await quiet(() => runScript(pdi, 'update pks', s.opt))
            assert.deepStrictEqual(s.rows.map((r) => r.cmd), ['node toolg/addVersion.mjs', 'node toolg/build.mjs', 'npm run deploy', 'npm publish', `npm publish --registry=${MA}`])
        })

        it('R27.4 主發布列失敗 → throw、鏡像列從未執行、onMirrorResult 未呼叫(主失敗不發鏡像)', async function() {
            let s = setup({
                registryConfig: { main: MAIN, mirrors: [MA, MB] },
                onRow: (cmd) => {
                    normalRow(cmd)
                    if (cmd === 'npm publish') {
                        throw new Error('[sbx-reg] npm指令失敗(code[1]): npm publish')
                    }
                },
            })
            await assert.rejects(quiet(() => runScript(pdi, 'update pks', s.opt)), /npm指令失敗\(code\[1\]\): npm publish/)
            assert.strictEqual(s.rows.filter((r) => r.cmd.indexOf('--registry=') >= 0).length, 0)
            assert.deepStrictEqual(s.mirrorResults, [])
            assert.deepStrictEqual(s.npmCalls, [])
        })

        it('R27.4 鏡像失敗不使套件失敗、不中止: runScript 照常完成並走最終閘門; 失敗者記為 failed(含錯誤摘要), 其後鏡像繼續發布; 警告行不含致命字樣', async function() {
            let s = setup({
                registryConfig: { main: MAIN, mirrors: [MA, MB] },
                onRow: (cmd) => {
                    normalRow(cmd)
                    if (cmd === `npm publish --registry=${MA}`) {
                        throw new Error(`[sbx-reg] npm指令失敗(code[1]): ${cmd}\nnpm error code E401\nnpm error Unable to authenticate`)
                    }
                },
            })
            await quiet(() => runScript(pdi, 'update pks', s.opt))
            assert.deepStrictEqual(s.mirrorResults.map((r) => [r.mirror, r.status]), [[MA, 'failed'], [MB, 'ok']])
            assert.strictEqual(s.mirrorResults[0].error, 'code[1]: code E401 | Unable to authenticate')
            assert.strictEqual(s.npmCalls.length, 1) //最終閘門仍執行且通過
            let warn = logs.filter((x) => x.indexOf('鏡像未同步') >= 0)
            assert.strictEqual(warn.length, 1)
            for (let x of logs) {
                assert.ok(!reFatal.test(x), x) //整段 log 無致命字樣(樁 exec 之錯誤已被吞並中和)
            }
        })

        it('R27.4 鏡像回報已存在同版本 → status exists(視為已同步)', async function() {
            let s = setup({
                registryConfig: { main: MAIN, mirrors: [MA] },
                onRow: (cmd) => {
                    normalRow(cmd)
                    if (cmd === `npm publish --registry=${MA}`) {
                        throw new Error(`[sbx-reg] npm指令失敗(code[1]): ${cmd}\nnpm error code E403\nnpm error 403 Forbidden - PUT x - You cannot publish over the previously published versions: 0.0.2.`)
                    }
                },
            })
            await quiet(() => runScript(pdi, 'update pks', s.opt))
            assert.strictEqual(s.mirrorResults[0].status, 'exists')
        })

        it('R27.4 閘門不被鏡像繞過: 第一個鏡像發布期間建置主檔被移除 → 第二個鏡像於其閘門被攔下(記為未同步、不執行該列), 套件不失敗', async function() {
            let s = setup({
                registryConfig: { main: MAIN, mirrors: [MA, MB] },
                onRow: (cmd) => {
                    normalRow(cmd)
                    if (cmd === `npm publish --registry=${MA}`) {
                        fs.rmSync(fpMain, { force: true })
                    }
                },
            })
            await quiet(() => runScript(pdi, 'update pks', s.opt))
            assert.deepStrictEqual(s.mirrorResults.map((r) => [r.mirror, r.status]), [[MA, 'ok'], [MB, 'failed']])
            assert.ok(s.mirrorResults[1].error.indexOf('main[dist/a.umd.js]不存在') >= 0, s.mirrorResults[1].error)
            assert.strictEqual(s.rows.filter((r) => r.cmd === `npm publish --registry=${MB}`).length, 0)
        })

        it('評審 F13: 鏡像之間重驗版本——第一個鏡像發布期間 package.json 版本被改動(npm lifecycle) → 第二個鏡像記為未同步且不執行; 結果紀錄之版本為主倉庫剛發布者', async function() {
            let s = setup({
                registryConfig: { main: MAIN, mirrors: [MA, MB] },
                onRow: (cmd) => {
                    normalRow(cmd)
                    if (cmd === `npm publish --registry=${MA}`) {
                        let o = JSON.parse(fs.readFileSync(fpPj, 'utf8'))
                        o.version = '0.0.9'
                        fs.writeFileSync(fpPj, JSON.stringify(o), 'utf8')
                    }
                },
            })
            await quiet(() => runScript(pdi, 'update pks', { ...s.opt, checkNpm: async () => true }))
            assert.deepStrictEqual(s.mirrorResults.map((r) => [r.mirror, r.version, r.status]), [[MA, '0.0.2', 'ok'], [MB, '0.0.2', 'failed']])
            assert.ok(s.mirrorResults[1].error.indexOf('版本於鏡像發布期間改變(主倉庫發布[0.0.2]、現在[0.0.9])') >= 0, s.mirrorResults[1].error)
            assert.strictEqual(s.rows.filter((r) => r.cmd === `npm publish --registry=${MB}`).length, 0)
        })

        it('評審 F08: 發布列含獨立的 `--` → 鏡像旗標插在其前', async function() {
            let s = setup({ script: ['#node toolg/addVersion.mjs', 'node toolg/build.mjs', 'npm publish --'], onRow: normalRow, registryConfig: { main: MAIN, mirrors: [MA] } })
            await quiet(() => runScript(pdi, 'update pks', s.opt))
            assert.deepStrictEqual(s.rows.slice(-2).map((r) => r.cmd), ['npm publish --', `npm publish --registry=${MA} --`])
        })

        it('R21 還原邊界不因鏡像改變: onRemote 恰一次且早於主發布列(script 含 git push 時於 git push 之前); 鏡像列執行時 onRemote 已為 1', async function() {
            let s = setup({
                script: ['#node toolg/addVersion.mjs', 'node toolg/build.mjs', 'git add .  -A', `git commit -m 'modify: '`, 'git push origin master:master', '#npm publish'],
                onRow: normalRow,
                registryConfig: { main: MAIN, mirrors: [MA, MB] },
            })
            await quiet(() => runScript(pdi, 'update pks', s.opt))
            assert.strictEqual(s.remote, 1)
            let iPush = s.rows.findIndex((r) => r.cmd === 'git push origin master:master')
            assert.strictEqual(s.remoteAtRow[iPush], 1) //onRemote 於 git push 交給 exec 之前已呼叫
            let iAdd = s.rows.findIndex((r) => r.cmd === 'git add .  -A')
            assert.strictEqual(s.remoteAtRow[iAdd], 0) //本機 git 列不算遠端列
            for (let i = 0; i < s.rows.length; i++) {
                if (s.rows[i].cmd.indexOf('--registry=') >= 0) {
                    assert.strictEqual(s.remoteAtRow[i], 1)
                }
            }
        })

    })

    describe('script.txt 不得自帶 --registry(R27.5)', function() {

        it('classifyLine: npm 列含 --registry / --registry=… → unexpected 並指出原因; 不含者照舊', function() {
            for (let v of ['npm publish --registry=https://x.example.test/', 'npm publish --registry https://x.example.test/', 'npm i --registry=https://x.example.test/', 'npm   publish   --tag next --registry=https://x.example.test/']) {
                let r = classifyLine(v)
                assert.strictEqual(r.kind, 'unexpected', v)
                assert.ok(r.reason.indexOf('--registry') >= 0 && r.reason.indexOf('倉庫設定') >= 0, r.reason)
            }
            for (let v of ['npm publish', 'npm publish --tag next', 'npm run deploy', 'npm run build -- --registry-x']) {
                assert.strictEqual(classifyLine(v).kind, 'npm', v)
            }
        })

        it('評審 F04: npm 的等價寫法亦拒絕——唯一前綴縮寫(--reg、--regi、--regis…)、引號包住之旗標、scope 專屬 --@scope:registry、大小寫; 不誤擋 --registryx、--re、--regex、-- 之後的一般引數', function() {
            for (let v of [
                'npm publish --reg=https://x.example.test/', 'npm publish --regi=https://x.example.test/', 'npm publish --regis https://x.example.test/', 'npm publish --registr=https://x.example.test/',
                'npm publish "--registry=https://x.example.test/"', 'npm publish \'--registry\' https://x.example.test/', 'npm publish "--reg=https://x.example.test/"',
                'npm publish --@scope:registry=https://x.example.test/', 'npm publish --REGISTRY=https://x.example.test/', 'npm\tpublish\t--registry=https://x.example.test/',
            ]) {
                let r = classifyLine(v)
                assert.strictEqual(r.kind, 'unexpected', v)
                assert.ok(hasNpmRegistryOverride(v), v)
            }
            for (let v of ['npm publish --registryx', 'npm publish --re', 'npm publish --regex', 'npm publish --tag registry', 'npm publish --access public', 'npm run build -- reg', 'npm publish --otp=123456']) {
                assert.strictEqual(hasNpmRegistryOverride(v), false, v)
                assert.strictEqual(classifyLine(v).kind, 'npm', v)
            }
        })

        it('classifyLine: 非 npm 列不受影響(node 腳本參數含 --registry 字樣不誤擋)', function() {
            assert.strictEqual(classifyLine('node toolg/x.mjs --registry=a').kind, 'node')
        })

        it('loadScript: 發布列自帶 --registry → 於任何列執行前以非預期指令中止(守望字樣), 訊息含列號與原文', function() {
            writeScript(fdPkg, ['#node toolg/addVersion.mjs', 'node toolg/build.mjs', 'npm publish --registry=https://x.example.test/'], { stubbed: true })
            assert.throws(() => loadScript(pdi, 'update pks'), (e) => /^\[sbx-reg\] 非預期指令\(執行前檢查, 尚未執行任何列\): 第3列\[npm publish --registry=https:\/\/x\.example\.test\/\]\(npm 列不得自帶 --registry/.test(e.message))
        })

        //評審 F01/F02: npm publish 會把 publishConfig 套到發布選項, 優先於環境變數; scoped 套件適用 @scope:registry——皆可使發布落到倉庫設定以外
        it('評審 F01: package.json 含 publishConfig.registry → loadScript 於任何列執行前以非預期指令中止(守望字樣); publishConfig 無 registry 者放行', function() {
            writeScript(fdPkg, fullScript, { stubbed: true })
            let pj = (o) => fs.writeFileSync(fpPj, JSON.stringify({ name: 'sbx-reg', version: '0.0.1', private: true, main: 'dist/a.umd.js', ...o }), 'utf8')
            pj({ publishConfig: { registry: 'https://other.example.test/' } })
            assert.throws(() => loadScript(pdi, 'update pks'), (e) => /^\[sbx-reg\] 非預期指令\(執行前檢查, 尚未執行任何列\): package\.json 之 publishConfig\.registry/.test(e.message))
            pj({ publishConfig: { registry: '' } })
            assert.doesNotThrow(() => loadScript(pdi, 'update pks'))
            pj({ publishConfig: { access: 'public', tag: 'next' } })
            assert.doesNotThrow(() => loadScript(pdi, 'update pks'))
            pj({})
            assert.doesNotThrow(() => loadScript(pdi, 'update pks'))
        })

        it('評審 F02: scoped 套件名(@scope/name)→ loadScript 於任何列執行前以非預期指令中止; package.json 讀不到或無法剖析時不誤擋(交由其他閘門)', function() {
            writeScript(fdPkg, fullScript, { stubbed: true })
            fs.writeFileSync(fpPj, JSON.stringify({ name: '@scope/sbx-reg', version: '0.0.1', private: true }), 'utf8')
            assert.throws(() => loadScript(pdi, 'update pks'), (e) => /^\[sbx-reg\] 非預期指令\(執行前檢查, 尚未執行任何列\): 套件名\[@scope\/sbx-reg\]為 scoped/.test(e.message))
            fs.writeFileSync(fpPj, '{ not json', 'utf8')
            assert.strictEqual(getPublishTargetIssue(pdi), '')
            assert.doesNotThrow(() => loadScript(pdi, 'update pks'))
            fs.rmSync(fpPj, { force: true })
            assert.strictEqual(getPublishTargetIssue(pdi), '')
        })

        it('評審 F01: publishConfig.registry 於 publishPackage 流程中同樣在 updatePackage/npm i 之前攔下(經 runScript 的 loadScript 呼叫點)', async function() {
            let s = setup({ registryConfig: { main: MAIN, mirrors: [] } })
            fs.writeFileSync(fpPj, JSON.stringify({ name: 'sbx-reg', version: '0.0.1', private: true, main: 'dist/a.umd.js', publishConfig: { registry: 'https://other.example.test/' } }), 'utf8')
            await assert.rejects(quiet(() => runScript(pdi, 'update pks', s.opt)), /^Error: \[sbx-reg\] 非預期指令\(執行前檢查, 尚未執行任何列\): package\.json 之 publishConfig\.registry/)
            assert.deepStrictEqual(s.rows, [])
        })

    })

})
