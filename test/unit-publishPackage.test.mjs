//publishPackage 單元測試(同一行程內; 以 opt.deps 注入 getFolders、parseProject、getUpdate、ectScripts、loadScript、runScript 之樁, updatePackage 用真的; 不執行 npm i、git、publish)
//對應需求(帳本 CLAUDE_rulebook.md 1.3): R21 首個遠端列之前之中止(updatePackage、npm i、runScript 於 onRemote 之前)還原 package.json 與 package-lock.json, onRemote 之後不還原; R7 執行前檢查(loadScript 失敗時不改任何檔)
//真 runScript 與 publishPackage 的接線矩陣見 unit-publishPackage-restore.test.mjs; 本檔以樁 runScript 驗證 publishPackage 自身的備份/還原/旗標邏輯
//fixture 於 test/_tmp/unit-publishPackage, before 建立、after 刪除
import assert from 'assert'
import fs from 'fs'
import path from 'path'
import publishPackage from '../src/publishPackage.mjs'
import updatePackage from '../src/updatePackage.mjs'
import getUpdate from '../src/getUpdate.mjs'
import { cleanTmpRoot } from './tools/mkFixturePkg.mjs'
import { reFatal } from './tools/fatalWords.mjs'


let fdTmp = path.resolve('./test/_tmp/unit-publishPackage')
let fdPkg = path.join(fdTmp, 'pkg')
let fpPj = path.join(fdPkg, 'package.json')
let fpLock = path.join(fdPkg, 'package-lock.json')

//原始位元組(CRLF、結尾換行、非 ASCII、尾端空白, 檢驗還原為位元組相同而非語意相同)
let pjOri = Buffer.from('{\r\n  "name": "sbx-pub",\r\n  "version": "0.0.1",\r\n  "devDependencies": {\r\n    "w-x": "^1.0.0"\r\n  },\r\n  "note": "開源 "\r\n}\r\n', 'utf8')
let lockOri = Buffer.from('{"name":"sbx-pub","lockfileVersion":3,"packages":{"":{"devDependencies":{"w-x":"^1.0.0"}}}}\n\n', 'utf8')

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

//備妥 fixture 與注入物件; npmI(cmd) 為 npm i 之行為(可改檔、可 throw); runScriptImpl 為 runScript 之行為
let setup = ({ lock = true, npmI = async () => '', runScriptImpl = async () => {}, loadScriptImpl = () => [] } = {}) => {
    fs.mkdirSync(fdPkg, { recursive: true })
    fs.writeFileSync(fpPj, pjOri)
    fs.rmSync(fpLock, { force: true })
    if (lock) {
        fs.writeFileSync(fpLock, lockOri)
    }
    let calls = []
    let pdi = { name: 'sbx-pub', path: fdPkg, version: '0.0.1', update: true, dependencies: [], devDependencies: [{ name: 'w-x', verOld: '^1.0.0', verNew: '^1.0.1' }] }
    let deps = {
        getFolders: () => [fdPkg],
        parseProject: () => [{ name: 'sbx-pub', path: fdPkg, level: '3' }],
        getUpdate: () => pdi,
        updatePackage: (p) => {
            calls.push('updatePackage')
            return updatePackage(p) //真的改寫 package.json
        },
        ectScripts: async (p, scps, o) => {
            calls.push(`ectScripts|${scps}`)
            return npmI(scps, o)
        },
        loadScript: (p) => {
            calls.push('loadScript')
            return loadScriptImpl(p)
        },
        runScript: async (p, msg, o) => {
            calls.push('runScript')
            return runScriptImpl(p, msg, o)
        },
    }
    return { calls, deps }
}
let same = (fp, buf) => Buffer.compare(fs.readFileSync(fp), buf) === 0


describe('publishPackage npm i 失敗還原(R21)', function() {

    //安全網: 萬一 opt.deps 注入失效而走到真的 getFolders/getUpdate/ectScripts(會掃套件區、執行 npm i), 自 PATH 移除 powershell 所在目錄使真實執行在啟動時失敗
    //(getFolders 等純檔案操作無法以此擋下, 故 deps 一律整組注入; 本檔每案皆經 setup 注入全部相依)
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

    it('R21.1 npm i 失敗(並已改寫 lock)→ package.json 與 package-lock.json 位元組還原、原錯誤原樣 throw、印還原訊息、runScript 未被呼叫', async function() {
        let s = setup({
            npmI: async () => {
                fs.writeFileSync(fpLock, '{"partial":"npm i 寫到一半"}', 'utf8') //模擬 npm i 已改動 lock
                throw new Error('[sbx-pub] npm指令失敗(code[1]): npm i --registry=https://registry.npmjs.org/')
            },
        })
        await assert.rejects(quiet(() => publishPackage(['sbx-pub'], { deps: s.deps, checkRelease: false })), /^Error: \[sbx-pub\] npm指令失敗\(code\[1\]\): npm i/)
        assert.ok(same(fpPj, pjOri), 'package.json 未還原為位元組相同')
        assert.ok(same(fpLock, lockOri), 'package-lock.json 未還原為位元組相同')
        assert.ok(logs.includes('[sbx-pub] npm i 失敗, 已還原 package.json(與 package-lock.json)為更新前內容, 重跑將重新判定為落後'), JSON.stringify(logs))
        assert.deepStrictEqual(s.calls, ['loadScript', 'updatePackage', 'ectScripts|npm i --registry=https://registry.npmjs.org/'])
    })

    it('R21.1 還原前 package.json 確已被 updatePackage 改寫(測試前提: 失敗當下 devDependencies 為 ^1.0.1)', async function() {
        let seen = ''
        let s = setup({
            npmI: async () => {
                seen = fs.readFileSync(fpPj, 'utf8')
                throw new Error('x')
            },
        })
        await assert.rejects(quiet(() => publishPackage(['sbx-pub'], { deps: s.deps, checkRelease: false })), /^Error: x$/)
        assert.ok(seen.indexOf('"w-x": "^1.0.1"') >= 0, seen)
        assert.ok(same(fpPj, pjOri))
    })

    it('R21.1 lock 原本不存在而 npm i 失敗前建立了它 → 還原時刪除; package.json 還原', async function() {
        let s = setup({
            lock: false,
            npmI: async () => {
                fs.writeFileSync(fpLock, '{"created":"by failing npm i"}', 'utf8')
                throw new Error('x')
            },
        })
        await assert.rejects(quiet(() => publishPackage(['sbx-pub'], { deps: s.deps, checkRelease: false })), /^Error: x$/)
        assert.strictEqual(fs.existsSync(fpLock), false)
        assert.ok(same(fpPj, pjOri))
    })

    it('R21.1 lock 原本不存在且 npm i 失敗時也沒建立 → 無事可刪, 不報錯, package.json 仍還原', async function() {
        let s = setup({ lock: false, npmI: async () => { throw new Error('x') } })
        await assert.rejects(quiet(() => publishPackage(['sbx-pub'], { deps: s.deps, checkRelease: false })), /^Error: x$/)
        assert.strictEqual(fs.existsSync(fpLock), false)
        assert.ok(same(fpPj, pjOri))
    })

    it('第二輪 N2 R21 提示: npm i 逾時後仍未落定(npm 可能仍在執行)而還原時, 另印一行注意訊息(lock 可能被覆寫); 一般失敗不印', async function() {
        let s1 = setup({ npmI: async () => { throw new Error('[sbx-pub] npm指令失敗(timeout[3600000ms]): npm i --registry=https://registry.npmjs.org/\n逾時後仍未落定, 子程序樹可能未清除') } })
        await assert.rejects(quiet(() => publishPackage(['sbx-pub'], { deps: s1.deps, checkRelease: false })), /仍未落定/)
        assert.ok(same(fpPj, pjOri))
        assert.ok(logs.some((x) => x.indexOf('[sbx-pub] 注意: npm 逾時後仍未落定, npm 可能仍在執行, 已還原之 package-lock.json 可能被再度覆寫') === 0), JSON.stringify(logs))
        assert.ok(logs.filter((x) => x.indexOf('注意: npm 逾時後仍未落定') >= 0).every((x) => !reFatal.test(x)), '注意訊息不得含守望器致命字樣')
        let s2 = setup({ npmI: async () => { throw new Error('[sbx-pub] npm指令失敗(code[1]): npm i') } })
        await assert.rejects(quiet(() => publishPackage(['sbx-pub'], { deps: s2.deps, checkRelease: false })), /code\[1\]/)
        assert.ok(!logs.some((x) => x.indexOf('注意: npm 逾時後仍未落定') >= 0))
    })

    it('R21.4 npm i 成功 → 不還原、不印還原訊息; package.json 保持更新後之內容; 接著呼叫 runScript', async function() {
        let s = setup()
        let b = await quiet(() => publishPackage(['sbx-pub'], { deps: s.deps, checkRelease: false }))
        assert.strictEqual(b, true)
        assert.ok(!same(fpPj, pjOri))
        assert.ok(fs.readFileSync(fpPj, 'utf8').indexOf('"w-x": "^1.0.1"') >= 0)
        assert.ok(!logs.some((x) => x.indexOf('已還原') >= 0))
        assert.deepStrictEqual(s.calls, ['loadScript', 'updatePackage', 'ectScripts|npm i --registry=https://registry.npmjs.org/', 'runScript'])
    })

    it('R21.2 npm i 成功之後 runScript 於遠端列之前失敗(未呼叫 onRemote)→ 還原 package.json 與 package-lock.json(位元組相同), 印 script 階段還原訊息, 錯誤原樣 throw', async function() {
        let s = setup({ runScriptImpl: async () => {
            fs.writeFileSync(fpLock, '{"touched":"by npm i"}', 'utf8') //模擬 npm i 已改 lock
            fs.writeFileSync(fpPj, fs.readFileSync(fpPj, 'utf8').replace('"version": "0.0.1"', '"version": "0.0.2"'), 'utf8') //模擬 addVersion 已遞增版本
            throw new Error('[sbx-pub] node指令失敗(code[1]): node toolg/build.mjs')
        } })
        await assert.rejects(quiet(() => publishPackage(['sbx-pub'], { deps: s.deps, checkRelease: false })), /^Error: \[sbx-pub\] node指令失敗\(code\[1\]\): node toolg\/build\.mjs$/)
        assert.ok(same(fpPj, pjOri), 'package.json(含 addVersion 之遞增)未還原為位元組相同')
        assert.ok(same(fpLock, lockOri), 'package-lock.json 未還原')
        assert.ok(logs.includes('[sbx-pub] script 於首個遠端列(git push、deploy、publish)之前中止, 已還原 package.json(與 package-lock.json)為更新前內容(版本號隨之回退), 重跑將重新判定為落後; node_modules、dist、docs、本機 git 之 index 與 commit 不還原, 重跑時會重建'), JSON.stringify(logs))
        assert.ok(!logs.some((x) => x.indexOf('npm i 失敗') >= 0))
        assert.ok(logs.filter((x) => x.indexOf('已還原') >= 0).every((x) => !reFatal.test(x)), '還原訊息不得含守望器致命字樣')
    })

    it('R21.3 runScript 已呼叫 onRemote 之後失敗(遠端動作可能已發生)→ 不還原(維持 CLAUDE.md §7.6 降版重觸發), 不印還原訊息, 錯誤原樣 throw', async function() {
        let s = setup({ runScriptImpl: async (p, msg, o) => {
            o.onRemote()
            throw new Error('[sbx-pub] git指令失敗(code[128]): git add .')
        } })
        await assert.rejects(quiet(() => publishPackage(['sbx-pub'], { deps: s.deps, checkRelease: false })), /^Error: \[sbx-pub\] git指令失敗\(code\[128\]\): git add \.$/)
        assert.ok(!same(fpPj, pjOri), 'onRemote 之後失敗不應還原 package.json')
        assert.ok(fs.readFileSync(fpPj, 'utf8').indexOf('"w-x": "^1.0.1"') >= 0)
        assert.ok(!logs.some((x) => x.indexOf('已還原') >= 0))
    })

    it('R21.3 onRemote 在失敗前任一時刻呼叫過即算(呼叫後又做了其他事再失敗亦然); 多次呼叫無害', async function() {
        let s = setup({ runScriptImpl: async (p, msg, o) => {
            o.onRemote()
            o.onRemote()
            await new Promise((r) => setTimeout(r, 5))
            throw new Error('[sbx-pub] npm上找不到[sbx-pub@0.0.2]')
        } })
        await assert.rejects(quiet(() => publishPackage(['sbx-pub'], { deps: s.deps, checkRelease: false })), /npm上找不到/)
        assert.ok(!same(fpPj, pjOri))
        assert.ok(!logs.some((x) => x.indexOf('已還原') >= 0))
    })

    it('R21.9 publishPackage 傳給 runScript 的 opt 含 checkRelease 與函式 onRemote; 每次呼叫 publishPackage 的旗標互相獨立(上一輪的 onRemote 不影響下一輪)', async function() {
        let seen = []
        let s1 = setup({ runScriptImpl: async (p, msg, o) => {
            seen.push([typeof o.onRemote, o.checkRelease])
            o.onRemote()
        } })
        await quiet(() => publishPackage(['sbx-pub'], { deps: s1.deps, checkRelease: false }))
        assert.deepStrictEqual(seen, [['function', false]])
        //第二次: 不呼叫 onRemote 即失敗 → 仍須還原(旗標不可沿用前一次)
        let s2 = setup({ runScriptImpl: async () => { throw new Error('x') } })
        await assert.rejects(quiet(() => publishPackage(['sbx-pub'], { deps: s2.deps, checkRelease: false })), /^Error: x$/)
        assert.ok(same(fpPj, pjOri))
    })

    it('R21.2 updatePackage 自身例外(寫到一半)→ 還原 package.json 與 lock, 印 update package.json 階段訊息, npm i 與 runScript 未被呼叫, 錯誤原樣 throw', async function() {
        let s = setup()
        s.deps.updatePackage = (p) => {
            s.calls.push('updatePackage')
            fs.writeFileSync(fpPj, '{"name":"half-writ', 'utf8') //模擬寫到一半
            fs.writeFileSync(fpLock, '{"half":1}', 'utf8')
            throw new Error('EIO: i/o error, write')
        }
        await assert.rejects(quiet(() => publishPackage(['sbx-pub'], { deps: s.deps, checkRelease: false })), /^Error: EIO: i\/o error, write$/)
        assert.ok(same(fpPj, pjOri) && same(fpLock, lockOri))
        assert.ok(logs.includes('[sbx-pub] update package.json 失敗, 已還原 package.json(與 package-lock.json)為更新前內容, 重跑將重新判定為落後'), JSON.stringify(logs))
        assert.deepStrictEqual(s.calls, ['loadScript', 'updatePackage'])
    })

    it('R21.6 script 階段還原本身失敗 → 印 還原失敗 警告, 不遮蔽 runScript 的原錯誤', async function() {
        let oriWrite = fs.writeFileSync
        let s = setup({ runScriptImpl: async () => {
            fs.writeFileSync = (p, ...rest) => {
                if (String(p).endsWith('package.json')) {
                    let e = new Error('EPERM: operation not permitted')
                    e.code = 'EPERM'
                    throw e
                }
                return oriWrite(p, ...rest)
            }
            throw new Error('[sbx-pub] 版本未遞增(起跑[0.0.1]、結束[0.0.1]): addVersion 列未生效')
        } })
        try {
            await assert.rejects(quiet(() => publishPackage(['sbx-pub'], { deps: s.deps, checkRelease: false })), /^Error: \[sbx-pub\] 版本未遞增/)
        }
        finally {
            fs.writeFileSync = oriWrite
        }
        assert.ok(logs.some((x) => x.indexOf('還原失敗: EPERM: operation not permitted') >= 0), JSON.stringify(logs))
        assert.ok(!logs.some((x) => x.indexOf('已還原 package.json') >= 0))
    })

    it('外審 sol F7 原錯誤物件身分: 各階段、還原前後、還原失敗時 throw 的都是同一個錯誤物件(code、cause 與物件身分保留), 不被重新包裝', async function() {
        let mk = (tag) => Object.assign(new Error(`sentinel ${tag}`), { code: `SENTINEL_${tag}`, cause: { tag } })
        let cases = [
            ['updatePackage', (sent) => { let s = setup(); s.deps.updatePackage = () => { throw sent }; return s }],
            ['npm i', (sent) => setup({ npmI: async () => { throw sent } })],
            ['runScript 於遠端列之前', (sent) => setup({ runScriptImpl: async () => { throw sent } })],
            ['runScript 於遠端列之後', (sent) => setup({ runScriptImpl: async (p, msg, o) => { o.onRemote(); throw sent } })],
        ]
        for (let [name, mkSetup] of cases) {
            let sent = mk(name)
            let s = mkSetup(sent)
            let got = null
            await quiet(() => publishPackage(['sbx-pub'], { deps: s.deps, checkRelease: false })).catch((e) => { got = e })
            assert.strictEqual(got, sent, `${name}: 錯誤物件身分不同`)
            assert.strictEqual(got.code, `SENTINEL_${name}`)
        }
        //還原本身失敗時亦然
        let oriWrite = fs.writeFileSync
        let sent2 = mk('restoreFail')
        let s2 = setup({ runScriptImpl: async () => {
            fs.writeFileSync = (p, ...rest) => {
                if (String(p).endsWith('package.json')) {
                    throw new Error('EPERM')
                }
                return oriWrite(p, ...rest)
            }
            throw sent2
        } })
        let got2 = null
        try {
            await quiet(() => publishPackage(['sbx-pub'], { deps: s2.deps, checkRelease: false })).catch((e) => { got2 = e })
        }
        finally {
            fs.writeFileSync = oriWrite
        }
        assert.strictEqual(got2, sent2)
    })

    it('外審 sol F4/opus F7 執行前拒絕(loadScript 失敗、備份讀檔失敗)發生於 updatePackage 之前: 未改動任何檔, 不印還原訊息, 錯誤原樣 throw', async function() {
        let sent = Object.assign(new Error('[sbx-pub] 非預期指令(執行前檢查, 尚未執行任何列): 第1列[npx x](不支援之指令)'), { code: 'PRECHECK' })
        let s1 = setup({ loadScriptImpl: () => { throw sent } })
        let got = null
        await quiet(() => publishPackage(['sbx-pub'], { deps: s1.deps, checkRelease: false })).catch((e) => { got = e })
        assert.strictEqual(got, sent)
        assert.ok(same(fpPj, pjOri) && same(fpLock, lockOri))
        assert.ok(!logs.some((x) => x.indexOf('已還原') >= 0 || x.indexOf('還原失敗') >= 0), JSON.stringify(logs))
        assert.ok(!logs.some((x) => x.indexOf('>>> update package.json') >= 0), '未進入 update package.json 階段')
        //備份讀檔失敗(package-lock.json 為資料夾 → EISDIR)
        let s2 = setup()
        fs.rmSync(fpLock, { force: true })
        fs.mkdirSync(fpLock)
        try {
            await assert.rejects(quiet(() => publishPackage(['sbx-pub'], { deps: s2.deps, checkRelease: false })), (e) => e.code === 'EISDIR')
        }
        finally {
            fs.rmSync(fpLock, { recursive: true, force: true })
        }
        assert.ok(same(fpPj, pjOri))
        assert.ok(!s2.calls.includes('updatePackage'), JSON.stringify(s2.calls))
        assert.ok(!logs.some((x) => x.indexOf('已還原') >= 0))
    })

    it('R21.7 script 階段中止訊息含「仍未落定」(逾時寬限到期、子程序樹可能未清除)→ 另印一行殘留程序注意; 一般失敗不印', async function() {
        let s1 = setup({ runScriptImpl: async () => { throw new Error('[sbx-pub] 指令逾時(timeout[3600000ms]): ./node_modules/.bin/jsdoc\n逾時後仍未落定, 子程序樹可能未清除') } })
        await assert.rejects(quiet(() => publishPackage(['sbx-pub'], { deps: s1.deps, checkRelease: false })), /仍未落定/)
        assert.ok(same(fpPj, pjOri))
        let note = logs.filter((x) => x.indexOf('殘留之子程序可能仍在執行') >= 0)
        assert.strictEqual(note.length, 1, JSON.stringify(logs))
        assert.ok(note[0].indexOf('[sbx-pub] 注意: ') === 0)
        assert.ok(note.every((x) => !reFatal.test(x)), '注意訊息不得含守望器致命字樣')
        assert.ok(!logs.some((x) => x.indexOf('npm 逾時後仍未落定') >= 0), 'script 階段不套用 npm i 階段的注意文字')
        let s2 = setup({ runScriptImpl: async () => { throw new Error('[sbx-pub] node指令失敗(code[1]): x') } })
        await assert.rejects(quiet(() => publishPackage(['sbx-pub'], { deps: s2.deps, checkRelease: false })), /code\[1\]/)
        assert.ok(!logs.some((x) => x.indexOf('殘留之子程序') >= 0))
    })

    it('R21.3 還原本身失敗(寫檔例外)→ 印 還原失敗 警告, 不遮蔽原錯誤(throw 的仍是 npm i 之原錯誤)', async function() {
        let oriWrite = fs.writeFileSync
        let s = setup({
            npmI: async () => {
                //自此刻起, 寫 package.json 一律失敗(模擬還原時被占用/唯讀)
                fs.writeFileSync = (p, ...rest) => {
                    if (String(p).endsWith('package.json')) {
                        let e = new Error('EPERM: operation not permitted')
                        e.code = 'EPERM'
                        throw e
                    }
                    return oriWrite(p, ...rest)
                }
                throw new Error('[sbx-pub] npm指令失敗(code[1]): npm i')
            },
        })
        try {
            await assert.rejects(quiet(() => publishPackage(['sbx-pub'], { deps: s.deps, checkRelease: false })), /^Error: \[sbx-pub\] npm指令失敗\(code\[1\]\): npm i$/)
        }
        finally {
            fs.writeFileSync = oriWrite
        }
        assert.ok(logs.some((x) => x.indexOf('還原失敗: EPERM: operation not permitted') >= 0), JSON.stringify(logs))
        assert.ok(!logs.some((x) => x.indexOf('已還原 package.json') >= 0))
        assert.ok(logs.filter((x) => x.indexOf('還原失敗') >= 0).every((x) => !reFatal.test(x)), '還原失敗行不得含守望器致命字樣')
    })

    it('R7 沿用: loadScript 失敗(執行前檢查)→ 在 updatePackage 與 npm i 之前中止, package.json 與 lock 位元組不變, 也不需要還原', async function() {
        let s = setup({ loadScriptImpl: () => { throw new Error('[sbx-pub] 非預期指令(執行前檢查, 尚未執行任何列): 第1列[npx x](不支援之指令)') } })
        await assert.rejects(quiet(() => publishPackage(['sbx-pub'], { deps: s.deps, checkRelease: false })), /非預期指令\(執行前檢查/)
        assert.ok(same(fpPj, pjOri) && same(fpLock, lockOri))
        assert.deepStrictEqual(s.calls, ['loadScript'])
        assert.ok(!logs.some((x) => x.indexOf('已還原') >= 0))
    })

    it('R21 端到端(真 getUpdate): npm i 失敗、遠端列之前的 runScript 失敗還原後, 重跑的 getUpdate 再度判定為落後; 遠端列之後失敗不還原, 重跑判定為已對齊而略過(CLAUDE.md §7.6) (外審 O-12; 2026-10-17 範圍擴大)', async function() {
        let fdWx = path.join(fdTmp, 'wx')
        fs.mkdirSync(fdWx, { recursive: true })
        fs.writeFileSync(path.join(fdWx, 'package.json'), JSON.stringify({ name: 'w-x', version: '1.0.1' }), 'utf8')
        let ps = [{ name: 'w-x', path: fdWx, level: '3' }, { name: 'sbx-pub', path: fdPkg, level: '4' }]
        let mkDeps = (npmI, runScriptImpl) => {
            let s = setup({ npmI, runScriptImpl })
            return { ...s.deps, parseProject: () => ps, getUpdate }
        }

        //npm i 失敗 → 還原 → 重跑仍判定為落後
        let deps1 = mkDeps(async () => { throw new Error('[sbx-pub] npm指令失敗(code[1]): npm i') })
        assert.strictEqual(getUpdate(ps, 'sbx-pub').update, true) //起點: 落後(^1.0.0 對 1.0.1)
        await assert.rejects(quiet(() => publishPackage(['sbx-pub'], { deps: deps1, checkRelease: false })), /npm i/)
        assert.ok(same(fpPj, pjOri))
        assert.strictEqual(getUpdate(ps, 'sbx-pub').update, true, '還原後應再度判定為落後(重跑會處理它)')

        //npm i 成功、runScript 於遠端列之前失敗 → 還原 → 重跑仍判定為落後(2026-10-17: 不再 limbo)
        let deps2 = mkDeps(async () => '', async () => { throw new Error('[sbx-pub] node指令失敗(code[1]): node toolg/build.mjs') })
        await assert.rejects(quiet(() => publishPackage(['sbx-pub'], { deps: deps2, checkRelease: false })), /node指令失敗/)
        assert.ok(same(fpPj, pjOri))
        assert.strictEqual(getUpdate(ps, 'sbx-pub').update, true, '遠端列之前的 runScript 失敗已還原, 重跑會再處理它')

        //npm i 成功、runScript 於遠端列之後失敗 → 不還原 → 重跑判定為已對齊(§7.6, 須降版重觸發)
        let deps3 = mkDeps(async () => '', async (p, msg, o) => { o.onRemote(); throw new Error('[sbx-pub] npm指令失敗(code[1]): npm publish') })
        await assert.rejects(quiet(() => publishPackage(['sbx-pub'], { deps: deps3, checkRelease: false })), /npm指令失敗/)
        assert.ok(!same(fpPj, pjOri))
        assert.strictEqual(getUpdate(ps, 'sbx-pub').update, false, '遠端列之後失敗不還原, 重跑會被略過(此即 §7.6)')
    })

    it('opt.checkRelease 轉交 loadScript 與 runScript(R20.3; 預設 true)', async function() {
        let seen = []
        let s = setup({ loadScriptImpl: () => [] })
        s.deps.loadScript = (p, msg, o) => {
            seen.push(['loadScript', o && o.checkRelease])
            return []
        }
        s.deps.runScript = async (p, msg, o) => {
            seen.push(['runScript', o && o.checkRelease])
        }
        await quiet(() => publishPackage(['sbx-pub'], { deps: s.deps }))
        assert.deepStrictEqual(seen, [['loadScript', true], ['runScript', true]])
        seen.length = 0
        setup()
        await quiet(() => publishPackage(['sbx-pub'], { deps: s.deps, checkRelease: false }))
        assert.deepStrictEqual(seen, [['loadScript', false], ['runScript', false]])
    })

})
