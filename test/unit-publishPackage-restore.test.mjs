//publishPackage × runScript 還原範圍矩陣(帳本 R21: 第一個遠端列〔git push、npm run deploy、npm publish 等〕交出之前的中止還原 package.json 與 package-lock.json, 之後不還原)
//真 publishPackage + 真 runScript + 真 updatePackage + 真 loadScript, 僅注入: getFolders/parseProject/getUpdate(單一套件)、npm i(ectScripts 樁)、runScript 的 exec/checkNpm/gitStatusDist/retryDelayMs
//不執行任何 git、deploy、npm publish、npm i; script.txt 以 writeScript(stubbed:true) 寫入(含 git、publish 列, 全由 exec 樁吃掉)
//fixture 於 test/_tmp/unit-publishPackage-restore, before 建立、after 刪除
import assert from 'assert'
import fs from 'fs'
import path from 'path'
import publishPackage from '../src/publishPackage.mjs'
import runScript from '../src/runScript.mjs'
import ectScripts from '../src/ectScripts.mjs'
import updatePackage from '../src/updatePackage.mjs'
import { writeScript, cleanTmpRoot } from './tools/mkFixturePkg.mjs'
import { reFatal } from './tools/fatalWords.mjs'


let fdTmp = path.resolve('./test/_tmp/unit-publishPackage-restore')
let fdPkg = path.join(fdTmp, 'pkg')
let fdOut = path.join(fdTmp, 'outside')
let fpPj = path.join(fdPkg, 'package.json')
let fpLock = path.join(fdPkg, 'package-lock.json')
let fpMain = path.join(fdPkg, 'dist', 'a.umd.js')
let fpNm = path.join(fdPkg, 'node_modules', 'marker.txt')

//原始位元組(CRLF、結尾換行、非 ASCII、尾端空白: 檢驗還原為位元組相同而非語意相同)
let pjOri = Buffer.from('{\r\n  "name": "sbx-rs",\r\n  "version": "0.0.1",\r\n  "main": "dist/a.umd.js",\r\n  "devDependencies": {\r\n    "w-x": "^1.0.0"\r\n  },\r\n  "note": "開源 "\r\n}\r\n', 'utf8')
let lockOri = Buffer.from('{"name":"sbx-rs","lockfileVersion":3,"packages":{"":{"devDependencies":{"w-x":"^1.0.0"}}}}\n\n', 'utf8')
//模擬 npm i 成功後改寫的 lock(含非 ASCII 與 CRLF, 供「遠端列之後不還原」逐位元組比對)
let lockNew = Buffer.from('{"name":"sbx-rs","lockfileVersion":3,"packages":{"":{"devDependencies":{"w-x":"^1.0.1"}},"node_modules/w-x":{"version":"1.0.1","note":"開源"}}}\r\n\r\n', 'utf8')

//實際語料之列序(118/118 個 script.txt): addVersion → 建置 → git add → git commit → git push → deploy → publish
let standard = ['#node toolg/addVersion.mjs', 'node toolg/build.mjs', 'git add .  -A', `git commit -m 'modify: '`, 'git push origin master:master', 'npm run deploy', '#npm publish']

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
let same = (fp, buf) => fs.existsSync(fp) && Buffer.compare(fs.readFileSync(fp), buf) === 0
let restoredLog = () => logs.filter((x) => x.indexOf('已還原 package.json') >= 0)

//模擬 addVersion 遞增 patch(改寫 package.json 的 version 欄位文字, 保留 CRLF)
let bump = () => {
    let t = fs.readFileSync(fpPj, 'utf8')
    fs.writeFileSync(fpPj, t.replace('"version": "0.0.1"', '"version": "0.0.2"'), 'utf8')
}
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
//模擬 npm i 成功: 改寫 lock、留下 node_modules 標記
let npmIOk = async () => {
    fs.mkdirSync(path.dirname(fpNm), { recursive: true })
    fs.writeFileSync(fpNm, 'x', 'utf8')
    fs.writeFileSync(fpLock, lockNew)
    return ''
}

//備妥一次情境; onRow(cmd) 為 runScript 樁 exec 之副作用(可改檔、可 throw); npmI 為 npm i 樁行為; lock=false 表原本不存在 package-lock.json
//judge(cmd) 給定時(C1/C2 端到端), exec 樁改為呼叫真 ectScripts 並以注入之 execProcess 回報 { errExec, out, err }, 讓 git 列經真 judgeResult/getGitSubcommand 判定
let setup = ({ script = standard, onRow = normalRow, npmI = npmIOk, gitStatusDist = () => '', checkNpmResult = true, checkRelease = true, lock = true, loadScriptImpl, updatePackageImpl, onRemoteThrows = false, judge } = {}) => {
    fs.rmSync(path.join(fdPkg, 'dist'), { recursive: true, force: true })
    fs.rmSync(path.join(fdPkg, 'node_modules'), { recursive: true, force: true })
    fs.rmSync(path.join(fdPkg, 'docs'), { recursive: true, force: true })
    fs.mkdirSync(fdPkg, { recursive: true })
    fs.writeFileSync(fpPj, pjOri)
    fs.rmSync(fpLock, { force: true })
    if (lock) {
        fs.writeFileSync(fpLock, lockOri)
    }
    writeScript(fdPkg, script, { stubbed: true })
    let s = { rows: [], npmICalls: [], npmCalls: [], remote: 0, pjAtRemote: null, lockAtRemote: undefined, lock, pdi: null, deps: null, opt: { checkRelease } }
    s.pdi = { name: 'sbx-rs', path: fdPkg, version: '0.0.1', update: true, dependencies: [], devDependencies: [{ name: 'w-x', verOld: '^1.0.0', verNew: '^1.0.1' }] }
    s.deps = {
        getFolders: () => [fdPkg],
        parseProject: () => [{ name: 'sbx-rs', path: fdPkg, level: '3' }],
        getUpdate: () => s.pdi,
        updatePackage, //真實函式顯式注入(帳本 R25: 測試環境下 publishPackage 要求 updatePackage 已注入; 只作用於本檔 fixture)
        ectScripts: async (p, scps, o) => {
            s.npmICalls.push(scps)
            return npmI(scps, o)
        },
        runScript: (p, msg, o) => {
            let onRemoteOri = o.onRemote
            return runScript(p, msg, {
                ...o,
                onRemote: () => {
                    s.remote++
                    if (s.remote === 1) {
                        s.pjAtRemote = fs.readFileSync(fpPj)
                        s.lockAtRemote = fs.existsSync(fpLock) ? fs.readFileSync(fpLock) : null
                    }
                    if (onRemoteThrows) {
                        throw new Error('callback boom')
                    }
                    onRemoteOri()
                },
                exec: async (pp, scps, oo = {}) => {
                    let cmd = Array.isArray(scps) ? scps.join(' ; ') : scps
                    s.rows.push(cmd)
                    onRow(cmd)
                    if (judge) {
                        let beh = judge(cmd) || {}
                        return ectScripts(pp, scps, {
                            ...oo,
                            execProcess: async (prog, args, o) => {
                                if (beh.out) {
                                    o.cbStdout(beh.out)
                                }
                                if (beh.err) {
                                    o.cbStderr(beh.err)
                                }
                                if (beh.errExec !== undefined) {
                                    throw beh.errExec
                                }
                                return ''
                            },
                        })
                    }
                    return ''
                },
                checkNpm: async (name, v) => {
                    s.npmCalls.push(`${name}@${v}`)
                    return checkNpmResult
                },
                gitStatusDist: (cwd) => (typeof gitStatusDist === 'function' ? gitStatusDist(cwd) : gitStatusDist),
                retryDelayMs: 1, //deploy 重試間隔縮短
            })
        },
    }
    if (loadScriptImpl) {
        s.deps.loadScript = loadScriptImpl
    }
    if (updatePackageImpl) {
        s.deps.updatePackage = updatePackageImpl
    }
    return s
}
let run = (s) => quiet(() => publishPackage(['sbx-rs'], { deps: s.deps, checkRelease: s.opt.checkRelease }))

//遠端列之前: package.json 與 lock 位元組還原(版本號為起跑時, 不跳號); 原本無 lock 者 lock 已被移除; 恰印一行還原訊息
let assertRestored = (s, label) => {
    assert.ok(same(fpPj, pjOri), `${label}: package.json 未還原為位元組相同(版本號應為 0.0.1): ${fs.readFileSync(fpPj, 'utf8')}`)
    if (s.lock) {
        assert.ok(same(fpLock, lockOri), `${label}: package-lock.json 未還原為位元組相同`)
    }
    else {
        assert.strictEqual(fs.existsSync(fpLock), false, `${label}: 原本不存在之 package-lock.json 應已移除`)
    }
    assert.strictEqual(restoredLog().length, 1, `${label}: 應印一行還原訊息: ${JSON.stringify(logs)}`)
    assert.ok(restoredLog().every((x) => !reFatal.test(x)), `${label}: 還原訊息不得含守望器致命字樣`)
}
//遠端列之後: 不還原, package.json 與 lock 位元組等於遠端列交出當下者(含 addVersion 之遞增、npm i 改寫之 lock), 不印還原訊息
let assertKept = (s, label) => {
    assert.ok(s.remote >= 1, `${label}: 應已交出遠端列`)
    assert.ok(!same(fpPj, pjOri), `${label}: 遠端列之後失敗不應還原 package.json`)
    assert.ok(fs.readFileSync(fpPj, 'utf8').indexOf('"w-x": "^1.0.1"') >= 0, `${label}: 依賴應維持 ^1.0.1`)
    assert.ok(same(fpPj, s.pjAtRemote), `${label}: package.json 應與遠端列交出當下位元組相同`)
    if (s.lockAtRemote === null) {
        assert.strictEqual(fs.existsSync(fpLock), false, `${label}: 交出當下無 lock, 現在亦應無`)
    }
    else {
        assert.ok(same(fpLock, s.lockAtRemote), `${label}: package-lock.json 應與遠端列交出當下位元組相同(不得只回退 lock)`)
    }
    assert.strictEqual(restoredLog().length, 0, `${label}: 不得印還原訊息: ${JSON.stringify(logs)}`)
}


describe('publishPackage × runScript 還原範圍矩陣(R21; 真 publishPackage + 真 runScript, 注入 exec 樁)', function() {

    //安全網: script.txt 含 git、npm publish 列(全由 exec 樁吃掉)。萬一注入失效而走到真的 ectScripts, 會呼叫 powershell 執行 git/npm publish——
    //故測試期間自 PATH 移除 powershell 所在目錄, 使任何真實執行都在啟動時失敗(spawn ENOENT), 不可能碰到 git 或 npm
    let pathOri
    before(function() {
        pathOri = process.env.PATH
        process.env.PATH = pathOri.split(';').filter((s) => s && !fs.existsSync(path.join(s, 'powershell.exe'))).join(';')
        fs.rmSync(fdTmp, { recursive: true, force: true })
        fs.mkdirSync(fdPkg, { recursive: true })
    })

    after(function() {
        process.env.PATH = pathOri
        //先以 rmdir 移除 junction 再整體刪除, 避免遞迴刪除時穿越連結
        try {
            fs.rmdirSync(path.join(fdPkg, 'docs'))
        }
        catch (err) {}
        fs.rmSync(fdTmp, { recursive: true, force: true })
        cleanTmpRoot()
    })

    //─────────── 遠端列之前之中止 → 還原(還原不足的格) ───────────

    describe('首個遠端列之前 → 還原', function() {

        it('P1 updatePackage 寫到一半例外 → 還原; npm i 與 runScript 未被呼叫', async function() {
            let s = setup({ updatePackageImpl: () => {
                fs.writeFileSync(fpPj, '{"name":"half', 'utf8')
                throw new Error('EIO: i/o error, write')
            } })
            await assert.rejects(run(s), /^Error: EIO/)
            assertRestored(s, 'P1')
            assert.deepStrictEqual(s.npmICalls, [])
            assert.deepStrictEqual(s.rows, [])
            assert.strictEqual(s.remote, 0)
        })

        it('P2 npm i 失敗(已改寫 lock、留下 node_modules 標記)→ 還原; node_modules 不還原(marker 仍在); runScript 未被呼叫', async function() {
            let s = setup({ npmI: async () => {
                await npmIOk()
                throw new Error('[sbx-rs] npm指令失敗(code[1]): npm i')
            } })
            await assert.rejects(run(s), /npm指令失敗\(code\[1\]\): npm i/)
            assertRestored(s, 'P2')
            assert.ok(logs.some((x) => x.indexOf('npm i 失敗, 已還原') >= 0))
            assert.ok(fs.existsSync(fpNm), 'node_modules 不還原(R21.5)')
            assert.deepStrictEqual(s.rows, [])
        })

        it('P2b 原本不存在 package-lock.json、npm i 建立了它後失敗 → 還原時移除該 lock', async function() {
            let s = setup({ lock: false, npmI: async () => {
                await npmIOk()
                throw new Error('[sbx-rs] npm指令失敗(code[1]): npm i')
            } })
            await assert.rejects(run(s), /npm指令失敗/)
            assertRestored(s, 'P2b')
        })

        it('P3 node 建置列失敗(addVersion 已遞增版本、dist 已有半成品)→ 還原且版本號回退(不跳號); dist 不還原; git 與 publish 列未被呼叫; onRemote 未呼叫', async function() {
            let s = setup({ onRow: (cmd) => {
                normalRow(cmd)
                if (cmd === 'node toolg/build.mjs') {
                    throw new Error('[sbx-rs] node指令失敗(code[1]): node toolg/build.mjs')
                }
            } })
            await assert.rejects(run(s), /^Error: \[sbx-rs\] node指令失敗\(code\[1\]\): node toolg\/build\.mjs$/)
            assertRestored(s, 'P3')
            assert.ok(logs.some((x) => x.indexOf('script 於首個遠端列(git push、deploy、publish)之前中止, 已還原') >= 0))
            assert.deepStrictEqual(s.rows, ['node toolg/addVersion.mjs', 'node toolg/build.mjs'])
            assert.ok(fs.existsSync(fpMain), 'dist 不還原(R21.5)')
            assert.strictEqual(s.remote, 0)
        })

        it('P3b 同一套件還原後立即重跑(模擬操作者修好建置腳本)→ addVersion 由 0.0.1 遞增為 0.0.2(不是 0.0.3), 順利發布', async function() {
            let failOnce = true
            let s = setup({ onRow: (cmd) => {
                normalRow(cmd)
                if (cmd === 'node toolg/build.mjs' && failOnce) {
                    failOnce = false
                    throw new Error('[sbx-rs] node指令失敗(code[1]): node toolg/build.mjs')
                }
            } })
            await assert.rejects(run(s), /node指令失敗/)
            assertRestored(s, 'P3b-第一次')
            //getUpdate 樁恆回 update:true, 等同真 getUpdate 在還原後再度判定為落後(見 unit-publishPackage 端到端)
            s.rows.length = 0
            let b = await quiet(() => publishPackage(['sbx-rs'], { deps: s.deps }))
            assert.strictEqual(b, true)
            assert.deepStrictEqual(s.npmCalls, ['sbx-rs@0.0.2'], '重跑後版本應為 0.0.2(無跳號)')
        })

        it('P4 .bin 列逾時(指令逾時)→ 還原', async function() {
            let s = setup({ script: ['#node toolg/addVersion.mjs', './node_modules/.bin/jsdoc -c .jsdoc', 'node toolg/build.mjs', 'git add .  -A', 'git push', '#npm publish'], onRow: (cmd) => {
                normalRow(cmd)
                if (cmd.indexOf('jsdoc') >= 0) {
                    throw new Error('[sbx-rs] 指令逾時(timeout[3600000ms]): ./node_modules/.bin/jsdoc -c .jsdoc')
                }
            } })
            await assert.rejects(run(s), /指令逾時/)
            assertRestored(s, 'P4')
            assert.strictEqual(s.remote, 0)
        })

        it('P5 非對外 npm 列(npm run build)失敗 → 還原', async function() {
            let s = setup({ script: ['#node toolg/addVersion.mjs', 'npm run build', 'git add .  -A', 'git push', '#npm publish'], onRow: (cmd) => {
                normalRow(cmd)
                if (cmd === 'npm run build') {
                    throw new Error('[sbx-rs] npm指令失敗(code[1]): npm run build')
                }
            } })
            await assert.rejects(run(s), /npm指令失敗\(code\[1\]\): npm run build/)
            assertRestored(s, 'P5')
            assert.deepStrictEqual(s.rows, ['node toolg/addVersion.mjs', 'npm run build'])
        })

        it('P6 唯讀 git 列(git status)失敗 128 → 還原', async function() {
            let s = setup({ script: ['git status', '#node toolg/addVersion.mjs', 'node toolg/build.mjs', 'git add .  -A', 'git push', '#npm publish'], onRow: (cmd) => {
                normalRow(cmd)
                if (cmd === 'git status') {
                    throw new Error('[sbx-rs] git指令失敗(code[128]): git status')
                }
            } })
            await assert.rejects(run(s), /git指令失敗\(code\[128\]\): git status/)
            assertRestored(s, 'P6')
            assert.deepStrictEqual(s.rows, ['git status'])
            assert.strictEqual(s.remote, 0)
        })

        it('P6b(外審 opus F1)本機 git 列 git add 失敗 128(R18 殺 git 後殘留 index.lock 的主案例)→ 還原且版本回退; 遠端列未被呼叫', async function() {
            let s = setup({ onRow: (cmd) => {
                normalRow(cmd)
                if (cmd === 'git add .  -A') {
                    throw new Error('[sbx-rs] git指令失敗(code[128]): git add .  -A\nfatal: Unable to create index.lock')
                }
            } })
            await assert.rejects(run(s), /git指令失敗\(code\[128\]\): git add/)
            assertRestored(s, 'P6b')
            assert.deepStrictEqual(s.rows, ['node toolg/addVersion.mjs', 'node toolg/build.mjs', 'git add .  -A'])
            assert.strictEqual(s.remote, 0)
        })

        it('P6c(外審 opus F1)本機 git 列 git commit 失敗 128(無 user.email、index.lock、gpg)→ 還原; git push 未被呼叫', async function() {
            let s = setup({ onRow: (cmd) => {
                normalRow(cmd)
                if (cmd.indexOf('git commit') === 0) {
                    throw new Error('[sbx-rs] git指令失敗(code[128]): git commit')
                }
            } })
            await assert.rejects(run(s), /git指令失敗\(code\[128\]\): git commit/)
            assertRestored(s, 'P6c')
            assert.ok(!s.rows.some((x) => x.indexOf('git push') === 0))
            assert.strictEqual(s.remote, 0)
        })

        it('P6d git add 之後主檔被刪 → git commit 前的 R17 閘門 throw 建置主檔異常(本機動作、遠端未變)→ 還原; git commit 與 git push 未被呼叫', async function() {
            let s = setup({ onRow: (cmd) => {
                normalRow(cmd)
                if (cmd === 'git add .  -A') {
                    fs.rmSync(fpMain, { force: true })
                }
            } })
            await assert.rejects(run(s), /建置主檔異常/)
            assertRestored(s, 'P6d')
            assert.ok(!s.rows.some((x) => x.indexOf('git commit') === 0 || x.indexOf('git push') === 0))
            assert.strictEqual(s.remote, 0)
        })

        it('P7 R10 dist 閘門(建置產物遭刪除且無任何產出)→ 在 git add 交出之前 throw → 還原', async function() {
            let s = setup({ gitStatusDist: () => ' D dist/a.umd.js\n' })
            await assert.rejects(run(s), /建置產物遭刪除且無任何產出/)
            assertRestored(s, 'P7')
            assert.ok(!s.rows.includes('git add .  -A'))
            assert.strictEqual(s.remote, 0)
        })

        it('P7b(外審 opus F5)R10 dist 閘門取 git status 自身 exit 128(dubious ownership 等)→ throw git指令失敗 於 git add 之前 → 還原', async function() {
            let s = setup({ gitStatusDist: () => {
                throw Object.assign(new Error('Command failed: git status --porcelain -- dist'), { status: 128, stderr: Buffer.from('fatal: detected dubious ownership in repository') })
            } })
            await assert.rejects(run(s), /^Error: \[sbx-rs\] git指令失敗\(code\[128\]\): git status --porcelain -- dist/)
            assertRestored(s, 'P7b')
            assert.ok(!s.rows.includes('git add .  -A'))
            assert.strictEqual(s.remote, 0)
        })

        it('P8 R20.2 版本閘門(addVersion 未生效)→ 在首個對外列之前 throw → 還原', async function() {
            let s = setup({ onRow: (cmd) => {
                if (cmd === 'node toolg/build.mjs') {
                    build()
                } //addVersion 列不遞增
            } })
            await assert.rejects(run(s), /版本未遞增/)
            assertRestored(s, 'P8')
            assert.ok(!s.rows.includes('git add .  -A'))
            assert.strictEqual(s.remote, 0)
        })

        it('P9 R17 主檔閘門(建置未產出主檔)→ 在首個對外列之前 throw → 還原', async function() {
            let s = setup({ onRow: (cmd) => {
                if (cmd === 'node toolg/addVersion.mjs') {
                    bump()
                } //build 列不產出主檔
            } })
            await assert.rejects(run(s), /建置主檔異常/)
            assertRestored(s, 'P9')
            assert.ok(!s.rows.includes('git add .  -A'))
            assert.strictEqual(s.remote, 0)
        })

        it('P9b readVersion 失敗(addVersion 列之後 package.json 消失 → ENOENT)→ 首個對外列的版本閘門 throw → 還原(原檔位元組寫回)', async function() {
            let s = setup({ onRow: (cmd) => {
                if (cmd === 'node toolg/addVersion.mjs') {
                    fs.rmSync(fpPj, { force: true })
                }
                if (cmd === 'node toolg/build.mjs') {
                    build()
                }
            } })
            await assert.rejects(run(s), (e) => e.code === 'ENOENT')
            assertRestored(s, 'P9b')
            assert.strictEqual(s.remote, 0)
        })

        it('P10 runScript 內部的 loadScript 失敗(publishPackage 之執行前檢查已放行, 如 script.txt 在兩者之間被改)→ 還原', async function() {
            let s = setup({ script: ['#node toolg/addVersion.mjs', 'npx postject x', '#npm publish'], loadScriptImpl: () => [] })
            await assert.rejects(run(s), /非預期指令\(執行前檢查, 尚未執行任何列\)/)
            assertRestored(s, 'P10')
            assert.deepStrictEqual(s.rows, [])
            assert.strictEqual(s.remote, 0)
        })

        it('P10b(外審 sol F1)script.txt 含 shell 控制運算子之列(git status ; git push)→ 執行前檢查判為非預期指令, 於任何副作用之前中止(未改動任何檔、無還原訊息)', async function() {
            let s = setup({ script: ['#node toolg/addVersion.mjs', 'node toolg/build.mjs', 'git status ; git add . ; git push', '#npm publish'] })
            await assert.rejects(run(s), /非預期指令\(執行前檢查, 尚未執行任何列\).*shell 控制運算子/)
            assert.ok(same(fpPj, pjOri) && same(fpLock, lockOri))
            assert.strictEqual(restoredLog().length, 0)
            assert.deepStrictEqual(s.npmICalls, [])
            assert.deepStrictEqual(s.rows, [])
        })

        it('P11 rm -r 失敗(docs 為指向套件外之 junction, 目標 docs/sub 經連結逸出)→ 還原; 套件外內容不動', async function() {
            fs.rmSync(fdOut, { recursive: true, force: true })
            fs.mkdirSync(path.join(fdOut, 'sub'), { recursive: true })
            fs.writeFileSync(path.join(fdOut, 'sub', 'keep.txt'), 'keep', 'utf8')
            let s = setup({ script: ['#node toolg/addVersion.mjs', 'rm -r docs/sub', 'node toolg/build.mjs', 'git add .  -A', 'git push', '#npm publish'], onRow: normalRow })
            fs.symlinkSync(fdOut, path.join(fdPkg, 'docs'), 'junction')
            try {
                await assert.rejects(run(s), /rm指令失敗: 目標經連結位於套件外/)
                assertRestored(s, 'P11')
                assert.deepStrictEqual(s.rows, ['node toolg/addVersion.mjs'])
                assert.strictEqual(fs.readFileSync(path.join(fdOut, 'sub', 'keep.txt'), 'utf8'), 'keep')
            }
            finally {
                fs.rmdirSync(path.join(fdPkg, 'docs'))
            }
        })

        it('P12 無遠端列之 script(僅 checkRelease:false 夾具可達): 建置列失敗、或建置完成而主檔缺失 → 整個 runScript 的失敗皆屬遠端列之前, 還原', async function() {
            let s1 = setup({ script: ['node toolg/build.mjs'], checkRelease: false, onRow: () => {
                throw new Error('[sbx-rs] node指令失敗(code[1]): node toolg/build.mjs')
            } })
            await assert.rejects(run(s1), /node指令失敗/)
            assertRestored(s1, 'P12a')
            let s2 = setup({ script: ['node toolg/build.mjs'], checkRelease: false, onRow: () => {} })
            await assert.rejects(run(s2), /建置主檔異常/)
            assertRestored(s2, 'P12b')
            assert.strictEqual(s2.remote, 0)
        })

        it('P13 onRemote 回呼自身 throw(自訂回呼)→ runScript 以該錯誤中止、遠端列 exec 未被呼叫 → publishPackage 視為遠端列之前, 還原', async function() {
            let s = setup({ onRemoteThrows: true })
            await assert.rejects(run(s), /^Error: callback boom$/)
            assertRestored(s, 'P13')
            assert.ok(!s.rows.some((x) => x.indexOf('git push') === 0), JSON.stringify(s.rows))
        })

        it('P14 原本不存在 lock 且 npm i 建立了它, 其後 git commit 128 → 還原時移除該 lock、package.json 位元組還原', async function() {
            let s = setup({ lock: false, onRow: (cmd) => {
                normalRow(cmd)
                if (cmd.indexOf('git commit') === 0) {
                    throw new Error('[sbx-rs] git指令失敗(code[128]): git commit')
                }
            } })
            await assert.rejects(run(s), /git指令失敗/)
            assertRestored(s, 'P14')
        })

        it('P12c 無遠端列且成功(checkRelease:false)→ 不還原、不印還原訊息、publishPackage 回傳 true', async function() {
            let s = setup({ script: ['node toolg/build.mjs'], checkRelease: false, onRow: normalRow })
            let b = await run(s)
            assert.strictEqual(b, true)
            assert.ok(!same(fpPj, pjOri))
            assert.ok(same(fpLock, lockNew))
            assert.strictEqual(restoredLog().length, 0)
            assert.strictEqual(s.remote, 0)
        })

    })

    //─────────── 遠端列之後之中止 → 不還原(還原過頭的格) ───────────

    describe('首個遠端列交出之後 → 不還原', function() {

        it('Q1 首個遠端列 git push 自身失敗(128, 遠端可能已部分接受)→ 不還原; 版本已遞增; package.json 與 lock 位元組等於交出當下', async function() {
            let s = setup({ onRow: (cmd) => {
                normalRow(cmd)
                if (cmd.indexOf('git push') === 0) {
                    throw new Error(`[sbx-rs] git指令失敗(code[128]): git push origin master:master\nfatal: Authentication failed for 'https://github.com/x/y.git/'`) //非網路類(R26.1: 網路類特徵會被重試, 由 E12/E13 涵蓋)
                }
            } })
            await assert.rejects(run(s), /git指令失敗\(code\[128\]\): git push/)
            assertKept(s, 'Q1')
            assert.ok(fs.readFileSync(fpPj, 'utf8').indexOf('"version": "0.0.2"') >= 0, '版本已遞增而不回退')
            assert.ok(same(fpLock, lockNew))
            assert.strictEqual(s.remote, 1)
            assert.deepStrictEqual(s.rows, ['node toolg/addVersion.mjs', 'node toolg/build.mjs', 'git add .  -A', `git commit -m 'modify: update pks'`, 'git push origin master:master'])
        })

        it('Q2 第二個對外列的閘門失敗(git push 之後主檔被刪, R17.1 每個對外列, deploy 前 throw)→ 不還原(遠端列已交出); deploy 未被呼叫', async function() {
            let s = setup({ onRow: (cmd) => {
                normalRow(cmd)
                if (cmd.indexOf('git push') === 0) {
                    fs.rmSync(fpMain, { force: true })
                }
            } })
            await assert.rejects(run(s), /建置主檔異常/)
            assertKept(s, 'Q2')
            assert.ok(!s.rows.includes('npm run deploy'))
            assert.strictEqual(s.remote, 1)
        })

        it('Q4 npm run deploy 失敗(非逾時, 重試 2 次後第 3 次仍失敗)→ 不還原', async function() {
            let nDeploy = 0
            let s = setup({ onRow: (cmd) => {
                normalRow(cmd)
                if (cmd === 'npm run deploy') {
                    nDeploy++
                    throw new Error('[sbx-rs] npm指令失敗(code[1]): npm run deploy')
                }
            } })
            await assert.rejects(run(s), /npm指令失敗\(code\[1\]\): npm run deploy/)
            assertKept(s, 'Q4')
            assert.strictEqual(nDeploy, 3)
            assert.ok(!s.rows.includes('npm publish'))
            assert.strictEqual(s.remote, 1)
        })

        it('Q5 npm publish 失敗 → 不還原', async function() {
            let s = setup({ onRow: (cmd) => {
                normalRow(cmd)
                if (cmd === 'npm publish') {
                    throw new Error('[sbx-rs] npm指令失敗(code[1]): npm publish')
                }
            } })
            await assert.rejects(run(s), /npm指令失敗\(code\[1\]\): npm publish/)
            assertKept(s, 'Q5')
            assert.deepStrictEqual(s.npmCalls, [])
        })

        it('Q6 最終閘門 npm上找不到 → 不還原', async function() {
            let s = setup({ checkNpmResult: false })
            await assert.rejects(run(s), /^Error: npm上找不到\[sbx-rs@0\.0\.2\]/)
            assertKept(s, 'Q6')
            assert.deepStrictEqual(s.npmCalls, ['sbx-rs@0.0.2'])
        })

        it('Q7 無 git 列, 首個遠端列為 npm run deploy, deploy 失敗 → 不還原', async function() {
            let s = setup({ script: ['#node toolg/addVersion.mjs', 'node toolg/build.mjs', 'npm run deploy', '#npm publish'], onRow: (cmd) => {
                normalRow(cmd)
                if (cmd === 'npm run deploy') {
                    throw new Error('[sbx-rs] 指令逾時(timeout[3600000ms]): npm run deploy')
                }
            } })
            await assert.rejects(run(s), /指令逾時/)
            assertKept(s, 'Q7')
            assert.strictEqual(s.remote, 1)
        })

        it('Q8 只有發布列為遠端列(首個即 npm publish), publish 失敗 → 不還原', async function() {
            let s = setup({ script: ['#node toolg/addVersion.mjs', 'node toolg/build.mjs', '#npm publish'], onRow: (cmd) => {
                normalRow(cmd)
                if (cmd === 'npm publish') {
                    throw new Error('[sbx-rs] npm指令失敗(code[1]): npm publish')
                }
            } })
            await assert.rejects(run(s), /npm指令失敗/)
            assertKept(s, 'Q8')
            assert.strictEqual(s.remote, 1)
        })

        it('Q9 遠端列之後的非對外列(git push 之後的 .bin 列)失敗 → 不還原', async function() {
            let s = setup({ script: ['#node toolg/addVersion.mjs', 'node toolg/build.mjs', 'git add .  -A', 'git push', './node_modules/.bin/jsdoc -c .jsdoc', '#npm publish'], onRow: (cmd) => {
                normalRow(cmd)
                if (cmd.indexOf('jsdoc') >= 0) {
                    throw new Error('[sbx-rs] 指令逾時(timeout[3600000ms]): ./node_modules/.bin/jsdoc -c .jsdoc')
                }
            } })
            await assert.rejects(run(s), /指令逾時/)
            assertKept(s, 'Q9')
        })

        it('Q10 原本不存在 lock、npm i 建立了它, git push 失敗 → 不還原, lock 維持 npm i 建立者', async function() {
            let s = setup({ lock: false, onRow: (cmd) => {
                normalRow(cmd)
                if (cmd.indexOf('git push') === 0) {
                    throw new Error('[sbx-rs] git指令失敗(code[128]): git push')
                }
            } })
            await assert.rejects(run(s), /git指令失敗/)
            assertKept(s, 'Q10')
            assert.ok(same(fpLock, lockNew), 'npm i 建立之 lock 應保留')
        })

        it('Q11(外審 sol F2)npm run  deploy(連續空白之等價寫法)為遠端列: 自身失敗 → 不還原(onRemote 已先呼叫)', async function() {
            let s = setup({ script: ['#node toolg/addVersion.mjs', 'node toolg/build.mjs', 'npm run  deploy', '#npm publish'], onRow: (cmd) => {
                normalRow(cmd)
                if (cmd === 'npm run  deploy') {
                    throw new Error('[sbx-rs] npm指令失敗(code[1]): npm run  deploy')
                }
            } })
            await assert.rejects(run(s), /npm指令失敗/)
            assertKept(s, 'Q11')
            assert.strictEqual(s.remote, 1)
        })

    })

    describe('成功與錯誤原樣', function() {

        it('S1 全部成功 → 不還原、不印還原訊息; onRemote 恰一次; 版本 0.0.2 走最終閘門; 回傳 true', async function() {
            let s = setup()
            let b = await run(s)
            assert.strictEqual(b, true)
            assert.ok(!same(fpPj, pjOri))
            assert.ok(same(fpLock, lockNew))
            assert.strictEqual(restoredLog().length, 0)
            assert.strictEqual(s.remote, 1)
            assert.deepStrictEqual(s.npmCalls, ['sbx-rs@0.0.2'])
            assert.deepStrictEqual(s.rows, ['node toolg/addVersion.mjs', 'node toolg/build.mjs', 'git add .  -A', `git commit -m 'modify: update pks'`, 'git push origin master:master', 'npm run deploy', 'npm publish'])
        })

        it('S2(外審 sol F7)經真 runScript 傳出的錯誤物件身分不變: 遠端列之前與之後 exec throw 的 sentinel 皆原物件(code、cause 保留), 還原不重新包裝', async function() {
            let sentPre = Object.assign(new Error('[sbx-rs] node指令失敗(code[3]): node toolg/build.mjs\n輸出 內容'), { code: 'SENT_PRE', cause: { n: 1 } })
            let s1 = setup({ onRow: (cmd) => {
                normalRow(cmd)
                if (cmd === 'node toolg/build.mjs') {
                    throw sentPre
                }
            } })
            let got1 = null
            await run(s1).catch((e) => { got1 = e })
            assert.strictEqual(got1, sentPre)
            assertRestored(s1, 'S2-pre')
            let sentPost = Object.assign(new Error('[sbx-rs] git指令失敗(code[128]): git push'), { code: 'SENT_POST', cause: { n: 2 } })
            let s2 = setup({ onRow: (cmd) => {
                normalRow(cmd)
                if (cmd.indexOf('git push') === 0) {
                    throw sentPost
                }
            } })
            let got2 = null
            await run(s2).catch((e) => { got2 = e })
            assert.strictEqual(got2, sentPost)
            assertKept(s2, 'S2-post')
        })

    })

})


//─────────── C1/C2 端到端: git 列經真 ectScripts(judgeResult/getGitSubcommand)判定, 僅 execProcess 為注入之樁 ───────────
describe('publishPackage × runScript × 真 ectScripts 的 git 判定端到端(R6.2、R21; 注入 execProcess)', function() {

    //安全網同上: 任何注入失效而走到真實列時, 因 PATH 無 powershell 而在啟動時失敗
    let pathOri
    before(function() {
        pathOri = process.env.PATH
        process.env.PATH = pathOri.split(';').filter((s) => s && !fs.existsSync(path.join(s, 'powershell.exe'))).join(';')
        fs.rmSync(fdTmp, { recursive: true, force: true })
        fs.mkdirSync(fdPkg, { recursive: true })
    })

    after(function() {
        process.env.PATH = pathOri
        fs.rmSync(fdTmp, { recursive: true, force: true })
        cleanTmpRoot()
    })

    //judge 輔助: 依指令前綴回報行為, 其餘列成功; map 的值為 { errExec, out, err }
    let gitBeh = (map) => (cmd) => {
        for (let [prefix, beh] of Object.entries(map)) {
            if (cmd.indexOf(prefix) === 0) {
                return beh
            }
        }
        return {}
    }

    it('E1 git commit exit 1 且無「無變更」片語(hook 失敗同形)→ git指令失敗(code[1]) → 在遠端列之前 → 還原; git push 未被呼叫', async function() {
        let s = setup({ judge: gitBeh({ 'git commit': { errExec: 'code[1]:\nhusky - pre-commit hook exited with code 1', out: 'husky - pre-commit hook exited with code 1\n' } }) })
        await assert.rejects(run(s), /^Error: \[sbx-rs\] git指令失敗\(code\[1\]\): git commit/)
        assertRestored(s, 'E1')
        assert.ok(!s.rows.some((x) => x.indexOf('git push') === 0))
        assert.strictEqual(s.remote, 0)
    })

    it('E2 git commit exit 1 且 stdout 含 nothing to commit(重跑時本機 commit 已存在)→ 良性留痕, 續行 push/deploy/publish, 發布成功', async function() {
        let s = setup({ judge: gitBeh({ 'git commit': { errExec: 'code[1]:\nnothing to commit, working tree clean', out: 'On branch master\nnothing to commit, working tree clean\n' } }) })
        let b = await run(s)
        assert.strictEqual(b, true)
        assert.ok(logs.some((x) => x.indexOf('未判定(code[1]): git commit') >= 0), JSON.stringify(logs.filter((x) => x.indexOf('未判定') >= 0)))
        assert.strictEqual(restoredLog().length, 0)
        assert.deepStrictEqual(s.rows.slice(-3), ['git push origin master:master', 'npm run deploy', 'npm publish'])
    })

    it('E3 git add exit 1(良性)→ 留痕續行, 發布成功', async function() {
        let s = setup({ judge: gitBeh({ 'git add': { errExec: 'code[1]:\nwarning: adding embedded git repository' } }) })
        let b = await run(s)
        assert.strictEqual(b, true)
        assert.ok(logs.some((x) => x.indexOf('未判定(code[1]): git add') >= 0))
    })

    it('E4 git push exit 1(non-fast-forward 被拒)→ git指令失敗(code[1]) → 遠端列自身失敗 → 不還原; deploy/publish 未被呼叫', async function() {
        let s = setup({ judge: gitBeh({ 'git push': { errExec: 'code[1]:\n! [rejected] master -> master (non-fast-forward)', err: '! [rejected] master -> master (non-fast-forward)\nerror: failed to push some refs\n' } }) })
        await assert.rejects(run(s), /^Error: \[sbx-rs\] git指令失敗\(code\[1\]\): git push origin master:master/)
        assertKept(s, 'E4')
        assert.ok(!s.rows.includes('npm run deploy') && !s.rows.includes('npm publish'))
    })

    it('E5 git push exit 0 且 stderr 有 To https://… 與進度(真 git 的正常輸出)→ 通過, 發布成功(不得被誤判)', async function() {
        let s = setup({ judge: gitBeh({ 'git push': { err: 'To https://github.com/yuda-lyu/sbx-rs\n   abc1234..def5678  master -> master\n' } }) })
        let b = await run(s)
        assert.strictEqual(b, true)
        assert.strictEqual(restoredLog().length, 0)
    })

    it('E6 git push 的 spawn 失敗(powershell 無法啟動, push 根本沒執行)→ git指令失敗(spawn[ENOENT] …) → 視為遠端未動而照常還原(R26.2, 主控 D2); 版本號回退; 不重試; deploy/publish 未被呼叫', async function() {
        let s = setup({ judge: gitBeh({ 'git push': { errExec: 'spawn[ENOENT]:\nspawn powershell ENOENT' } }) })
        await assert.rejects(run(s), /git指令失敗\(spawn\[ENOENT\] spawn powershell ENOENT\): git push/)
        assertRestored(s, 'E6')
        assert.strictEqual(s.rows.filter((x) => x.indexOf('git push') === 0).length, 1) //spawn 失敗不重試
        assert.ok(!s.rows.includes('npm run deploy') && !s.rows.includes('npm publish'))
        assert.strictEqual(logs.filter((x) => x.indexOf('重試(第') >= 0).length, 0)
    })

    it('E7 git add 的 spawn 失敗 → 中止於遠端列之前 → 還原', async function() {
        let s = setup({ judge: gitBeh({ 'git add': { errExec: 'spawn[EMFILE]:\nspawn EMFILE' } }) })
        await assert.rejects(run(s), /git指令失敗\(spawn\[EMFILE\] spawn EMFILE\): git add/)
        assertRestored(s, 'E7')
        assert.strictEqual(s.remote, 0)
    })

    it('E8 git commit exit 128(index.lock)→ 還原; git add exit 128 → 還原', async function() {
        for (let prefix of ['git commit', 'git add']) {
            let s = setup({ judge: gitBeh({ [prefix]: { errExec: 'code[128]:\nfatal: Unable to create index.lock', err: 'fatal: Unable to create index.lock\n' } }) })
            await assert.rejects(run(s), /git指令失敗\(code\[128\]\)/)
            assertRestored(s, `E8-${prefix}`)
        }
    })

    it('E9(外審 opus F1 → 主控「選項」R7.2)push 寫成錯字 git pusj → 執行前檢查即判非預期指令(子命令不在允許集合), 於任何副作用之前中止: 不改 package.json、不 npm i、不執行任何列、無還原訊息', async function() {
        let s = setup({
            script: ['#node toolg/addVersion.mjs', 'node toolg/build.mjs', 'git add .  -A', `git commit -m 'modify: '`, 'git pusj origin master:master', 'npm run deploy', '#npm publish'],
        })
        await assert.rejects(run(s), /^Error: \[sbx-rs\] 非預期指令\(執行前檢查, 尚未執行任何列\): 第5列\[git pusj origin master:master\]\(git 子命令\[pusj\]不在允許集合\(add、commit、push 與唯讀查詢\)\)/)
        assert.deepStrictEqual(s.rows, [])
        assert.deepStrictEqual(s.npmICalls, [])
        assert.ok(same(fpPj, pjOri), 'package.json 不得被改動')
        assert.strictEqual(restoredLog().length, 0)
        assert.strictEqual(s.remote, 0)
    })

    it('E10 其他非允許子命令(git tag、git fetch、git pull)同樣於執行前檢查攔下(R7.2); 原『exit 1 嚴格失敗』之判定矩陣仍由 judgeResult 單元測試涵蓋(unit-ectScripts)', async function() {
        for (let sub of ['git tag v1', 'git fetch origin', 'git pull']) {
            let s = setup({
                script: ['#node toolg/addVersion.mjs', 'node toolg/build.mjs', 'git add .  -A', `git commit -m 'modify: '`, sub, 'git push origin master:master', 'npm run deploy', '#npm publish'],
            })
            await assert.rejects(run(s), new RegExp(`非預期指令\\(執行前檢查, 尚未執行任何列\\): 第5列\\[${sub}\\]\\(git 子命令\\[${sub.split(' ')[1]}\\]不在允許集合`), sub)
            assert.deepStrictEqual(s.rows, [], sub)
            assert.ok(same(fpPj, pjOri), sub)
        }
    })

    it('E11(D1)前一列 git add exit 1(良性, 沒暫存到變更)接著 git commit exit 1 且輸出為 nothing added to commit but untracked files present → git指令失敗(code[1]): git commit → 遠端列之前 → 還原; git push 未被呼叫(不再發布出無對應遠端 commit 之版本)', async function() {
        let s = setup({ judge: gitBeh({
            'git add': { errExec: 'code[1]:\nwarning: adding embedded git repository' },
            'git commit': { errExec: 'code[1]:\n', out: 'On branch master\nnothing added to commit but untracked files present (use "git add" to track)\n' },
        }) })
        await assert.rejects(run(s), /^Error: \[sbx-rs\] git指令失敗\(code\[1\]\): git commit/)
        assertRestored(s, 'E11')
        assert.ok(!s.rows.some((x) => x.indexOf('git push') === 0))
        assert.strictEqual(s.remote, 0)
        for (let phrase of ['no changes added to commit (use "git add" and/or "git commit -a")']) {
            let s2 = setup({ judge: gitBeh({ 'git commit': { errExec: 'code[1]:\n', out: phrase + '\n' } }) })
            await assert.rejects(run(s2), /git指令失敗\(code\[1\]\): git commit/)
            assertRestored(s2, 'E11-' + phrase)
        }
    })

    //push 網路類失敗: 前 n 次回 code[128] 加網路特徵, 之後成功
    let netPush = (n, phrase = `fatal: unable to access 'https://github.com/x/y.git/': Empty reply from server`) => {
        let k = 0
        return (cmd) => {
            if (cmd.indexOf('git push') === 0) {
                k++
                if (k <= n) {
                    return { errExec: `code[128]:\n${phrase}`, err: phrase + '\n' }
                }
            }
            return {}
        }
    }

    it('E12(D2)git push 網路類失敗 2 次後成功 → 重試(印 2 則重試訊息)後照常續行 deploy/publish, 發布成功; onRemote 恰一次, 不還原', async function() {
        let s = setup({ judge: netPush(2) })
        let b = await run(s)
        assert.strictEqual(b, true)
        assert.strictEqual(s.rows.filter((x) => x.indexOf('git push') === 0).length, 3)
        assert.strictEqual(logs.filter((x) => x.indexOf('重試(第') >= 0).length, 2)
        assert.strictEqual(s.remote, 1)
        assert.strictEqual(restoredLog().length, 0)
        assert.deepStrictEqual(s.rows.slice(-2), ['npm run deploy', 'npm publish'])
    })

    it('E13(D2)git push 網路類失敗 3 次(耗盡)→ git指令失敗(code[128]) → 已嘗試過 push, 遠端可能已部分接受 → 不還原(依 §7.6); deploy/publish 未被呼叫', async function() {
        let s = setup({ judge: netPush(5) })
        await assert.rejects(run(s), /^Error: \[sbx-rs\] git指令失敗\(code\[128\]\): git push origin master:master\nfatal: unable to access/)
        assert.strictEqual(s.rows.filter((x) => x.indexOf('git push') === 0).length, 3)
        assertKept(s, 'E13')
        assert.ok(!s.rows.includes('npm run deploy') && !s.rows.includes('npm publish'))
    })

})
