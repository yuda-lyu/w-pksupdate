//checkBuildScripts 單元測試(唯讀預檢 g_checkBuildScripts.mjs 之核心; fixture 於 test/_tmp/unit-checkBuildScripts, 以假套件資料夾與假腳本檔驗證, 不碰套件區)
//對應需求(帳本 CLAUDE_rulebook.md 1.3): R22 建置腳本吞錯預檢
import assert from 'assert'
import fs from 'fs'
import path from 'path'
import { stripComments, classifyBody, scanScriptSource, checkBuildScripts, runCheckBuildScripts } from '../src/checkBuildScripts.mjs'
import { cleanTmpRoot } from './tools/mkFixturePkg.mjs'


let fdTmp = path.resolve('./test/_tmp/unit-checkBuildScripts')
let n = 0

//建假套件: scripts 為 { 相對路徑: 原始碼 }, scriptTxt 為 script.txt 各列(null 表不建); 回傳 { name, path }
let mkPkg = (scripts, scriptTxt = null) => {
    let name = `pkg${++n}`
    let fd = path.join(fdTmp, name)
    fs.mkdirSync(fd, { recursive: true })
    for (let [rel, src] of Object.entries(scripts)) {
        let fp = path.join(fd, rel)
        fs.mkdirSync(path.dirname(fp), { recursive: true })
        fs.writeFileSync(fp, src, 'utf8')
    }
    if (scriptTxt !== null) {
        fs.writeFileSync(path.join(fd, 'script.txt'), scriptTxt.join('\r\n') + '\r\n', 'utf8')
    }
    return { name, path: fd }
}
//只掃單一腳本: 建立含該腳本與 node 列之假套件, 回傳該套件之站點
let sitesOf = (src, extra = {}) => {
    let p = mkPkg({ 'toolg/g.mjs': src, ...extra }, ['node toolg/g.mjs'])
    return checkBuildScripts([p]).sites
}


describe('checkBuildScripts 吞錯站點分類(R22.2、R22.3、R22.5)', function() {

    before(function() {
        fs.rmSync(fdTmp, { recursive: true, force: true })
        fs.mkdirSync(fdTmp, { recursive: true })
    })

    after(function() {
        fs.rmSync(fdTmp, { recursive: true, force: true })
        cleanTmpRoot()
    })

    it('R22.3 全庫實樣式 .catch((err) => { console.log(err) }) → swallow-log, 行號為原始碼行號', function() {
        let src = `import x from 'y'\n\nasync function rp() {\n    await x()\n        .catch((err) => {\n            console.log(err)\n        })\n}\nrp()\n    .catch((err) => {\n        console.log(err)\n    })\n`
        let sites = sitesOf(src)
        assert.deepStrictEqual(sites.map((s) => [s.script, s.line, s.kind, s.cls]), [
            ['toolg/g.mjs', 5, '.catch', 'swallow-log'],
            ['toolg/g.mjs', 10, '.catch', 'swallow-log'],
        ])
    })

    it('R22.3 傳遞者不計: throw、process.exit(1)、process.exitCode = 1(含 console.error 在內)', function() {
        let cases = [
            `p().catch((e) => { throw e })`,
            `p().catch((e) => { console.error(e); process.exitCode = 1 })`,
            `p().catch((e) => { console.log(e); process.exit(1) })`,
            `try { await p() } catch (e) { throw new Error('x', { cause: e }) }`,
            `try { await p() } catch (e) { console.error(e); process.exitCode = 2 }`,
        ]
        for (let src of cases) {
            assert.deepStrictEqual(sitesOf(src), [], src)
        }
    })

    it('R22.3 靜默者: .catch(() => {})、.catch((e) => {})、.catch(e => {})、.catch(() => null)、空的 catch 區塊 → swallow-silent', function() {
        let cases = [
            `p().catch(() => {})`,
            `p().catch((e) => {})`,
            `p().catch(e => {})`,
            `p().catch(() => null)`,
            `try { await p() } catch (e) { }`,
            `try { await p() } catch { }`,
        ]
        for (let src of cases) {
            let sites = sitesOf(src)
            assert.strictEqual(sites.length, 1, src)
            assert.strictEqual(sites[0].cls, 'swallow-silent', src)
        }
    })

    it('R22.3 try/catch 只印出 → swallow-log', function() {
        let sites = sitesOf(`try {\n    await p()\n}\ncatch (e) {\n    console.warn(e)\n}\n`)
        assert.deepStrictEqual(sites.map((s) => [s.line, s.kind, s.cls]), [[4, 'try-catch', 'swallow-log']])
    })

    it('R22.3 exitCode = 0 與 process.exit(0) 不是傳遞(離開碼仍為 0): 搭配 console.log 仍為 swallow-log', function() {
        assert.strictEqual(sitesOf(`p().catch((e) => { console.log(e); process.exitCode = 0 })`)[0].cls, 'swallow-log')
        assert.strictEqual(sitesOf(`p().catch((e) => { console.log(e); process.exit(0) })`)[0].cls, 'swallow-log')
    })

    it('R22.3 other(既非傳遞也非單純印出或靜默, 如 .catch(retry))→ 不計入吞錯站點, 但列在 other 供人工看', function() {
        let p = mkPkg({ 'toolg/g.mjs': `p().catch(retry)\n` }, ['node toolg/g.mjs'])
        let r = checkBuildScripts([p])
        assert.deepStrictEqual(r.sites, [])
        assert.strictEqual(r.others.length, 1)
        assert.deepStrictEqual([r.others[0].script, r.others[0].line, r.others[0].cls], ['toolg/g.mjs', 1, 'other'])
    })

    it('R22.5 被註解掉之 .catch( 不計(行註解與區塊註解), 行號不因去註解而位移', function() {
        let src = `// p().catch((e) => { console.log(e) })\n/*\n p().catch(() => {})\n*/\nq().catch((e) => {\n    console.log(e)\n})\n`
        let sites = sitesOf(src)
        assert.deepStrictEqual(sites.map((s) => [s.line, s.cls]), [[5, 'swallow-log']])
    })

    it('stripComments 保留換行與字串內之 //(網址不被當成註解)', function() {
        let s = stripComments(`let u = 'http://x.y/z' // c\n/* a\nb */ let v = 1\n`)
        assert.strictEqual(s.split('\n').length, 4)
        assert.ok(s.indexOf(`'http://x.y/z'`) >= 0)
        assert.ok(s.indexOf('// c') < 0 && s.indexOf('a') < 0)
    })

    it('classifyBody 直接驗證各形態', function() {
        assert.strictEqual(classifyBody('{ throw e }'), 'propagate')
        assert.strictEqual(classifyBody('{ process.exit(3) }'), 'propagate')
        assert.strictEqual(classifyBody('{ process.exitCode = 1 }'), 'propagate')
        assert.strictEqual(classifyBody('((err) => { console.log(err) })'), 'swallow-log')
        assert.strictEqual(classifyBody('(() => {})'), 'swallow-silent')
        assert.strictEqual(classifyBody('{ }'), 'swallow-silent')
        assert.strictEqual(classifyBody('(retry)'), 'other')
    })

    it('scanScriptSource 回傳站點之 kind、line、cls 與截短之 body', function() {
        let items = scanScriptSource(`p().catch((e) => { console.log(e) })\n`)
        assert.strictEqual(items.length, 1)
        assert.deepStrictEqual([items[0].kind, items[0].line, items[0].cls], ['.catch', 1, 'swallow-log'])
        assert.ok(items[0].body.indexOf('console.log') >= 0)
    })

})


describe('checkBuildScripts 套件層(script.txt 之 node 列; R22.2、R22.4)', function() {

    before(function() {
        fs.rmSync(fdTmp, { recursive: true, force: true })
        fs.mkdirSync(fdTmp, { recursive: true })
    })

    after(function() {
        fs.rmSync(fdTmp, { recursive: true, force: true })
        cleanTmpRoot()
    })

    it('只掃 node 列所指腳本; .bin、git、npm 列與註解列不掃; node 列帶參數時取第一個參數為腳本', function() {
        let bad = `p().catch((e) => { console.log(e) })\n`
        let p = mkPkg({ 'toolg/a.mjs': bad, 'toolg/b.mjs': bad, 'toolg/c.mjs': bad, 'toolg/unlisted.mjs': bad }, [
            '#node toolg/addVersion.mjs', 'node toolg/a.mjs --flag x', '#node toolg/b.mjs', './node_modules/.bin/jsdoc -c .jsdoc', 'git add .  -A', 'npm run build', 'node toolg/c.mjs',
        ])
        let r = checkBuildScripts([p])
        assert.deepStrictEqual(r.sites.map((s) => s.script).sort(), ['toolg/a.mjs', 'toolg/c.mjs']) //b 為註解列, unlisted 不在 script.txt, addVersion 不存在(列為 missing)
        assert.deepStrictEqual(r.missing.map((m) => m.script), ['toolg/addVersion.mjs'])
    })

    it('同一腳本被多個 node 列引用只計一次', function() {
        let p = mkPkg({ 'toolg/a.mjs': `p().catch((e) => { console.log(e) })\n` }, ['node toolg/a.mjs', 'node toolg/a.mjs'])
        assert.strictEqual(checkBuildScripts([p]).sites.length, 1)
    })

    it('腳本檔不存在 → 列入 missing(含套件名與腳本), 不拋錯、不計入吞錯', function() {
        let p = mkPkg({}, ['node toolg/nope.mjs'])
        let r = checkBuildScripts([p])
        assert.deepStrictEqual(r.sites, [])
        assert.deepStrictEqual(r.missing.map((m) => [m.repo, m.script]), [[p.name, 'toolg/nope.mjs']])
    })

    it('套件沒有 script.txt → 略過並列入 noScript, 不拋錯', function() {
        let p = mkPkg({ 'toolg/a.mjs': 'x' }, null)
        let r = checkBuildScripts([p])
        assert.deepStrictEqual(r.noScript, [p.name])
        assert.deepStrictEqual(r.sites, [])
    })

    it('R22.4 彙總: repos(有吞錯站點之套件數)與 sites(站點數); 多套件', function() {
        let bad = `a().catch((e) => { console.log(e) })\nb().catch(() => {})\n`
        let good = `a().catch((e) => { console.error(e); process.exitCode = 1 })\n`
        let p1 = mkPkg({ 'toolg/g.mjs': bad }, ['node toolg/g.mjs'])
        let p2 = mkPkg({ 'toolg/g.mjs': good }, ['node toolg/g.mjs'])
        let p3 = mkPkg({ 'toolg/g.mjs': bad }, ['node toolg/g.mjs'])
        let r = checkBuildScripts([p1, p2, p3])
        assert.strictEqual(r.sites.length, 4)
        assert.deepStrictEqual([...new Set(r.sites.map((s) => s.repo))].sort(), [p1.name, p3.name].sort())
        assert.strictEqual(r.repos, 2)
    })

})


describe('runCheckBuildScripts 報告與離開碼(R22.1、R22.4)', function() {

    before(function() {
        fs.rmSync(fdTmp, { recursive: true, force: true })
        fs.mkdirSync(fdTmp, { recursive: true })
    })

    after(function() {
        fs.rmSync(fdTmp, { recursive: true, force: true })
        cleanTmpRoot()
    })

    it('R22.4 有吞錯站點 → code 1, 報告列出 套件 | 腳本 | 行號 | 類別 並於末尾彙總 N 個 repo、M 處', function() {
        let p = mkPkg({ 'toolg/g.mjs': `x\np().catch((e) => { console.log(e) })\n` }, ['node toolg/g.mjs'])
        let r = runCheckBuildScripts([p])
        assert.strictEqual(r.code, 1)
        assert.ok(r.lines.some((s) => s.indexOf(`${p.name} | toolg/g.mjs | 2 | .catch | swallow-log`) >= 0), r.lines.join('\n'))
        assert.ok(r.lines.some((s) => s.indexOf('吞錯站點: 1 個 repo、1 處') >= 0), r.lines.join('\n'))
    })

    it('R22.4 無吞錯站點 → code 0, 報告含 無吞錯站點', function() {
        let p = mkPkg({ 'toolg/g.mjs': `p().catch((e) => { console.error(e); process.exitCode = 1 })\n` }, ['node toolg/g.mjs'])
        let r = runCheckBuildScripts([p])
        assert.strictEqual(r.code, 0)
        assert.ok(r.lines.some((s) => s.indexOf('無吞錯站點') >= 0))
    })

    it('R22.1 完全唯讀: 掃描前後 fixture 檔案內容與 mtime 皆不變、不產生任何新檔', function() {
        let p = mkPkg({ 'toolg/g.mjs': `p().catch((e) => { console.log(e) })\n` }, ['node toolg/g.mjs'])
        let snap = () => {
            let o = {}
            let walk = (d) => {
                for (let e of fs.readdirSync(d, { withFileTypes: true })) {
                    let fp = path.join(d, e.name)
                    if (e.isDirectory()) {
                        walk(fp)
                    }
                    else {
                        o[fp] = fs.readFileSync(fp, 'utf8') + '|' + fs.statSync(fp).mtimeMs
                    }
                }
            }
            walk(p.path)
            return o
        }
        let before = snap()
        runCheckBuildScripts([p])
        assert.deepStrictEqual(snap(), before)
    })

    it('R22.1 不執行任何指令: 腳本檔內容為會留下痕跡之程式碼, 掃描後該痕跡不存在', function() {
        let marker = path.join(fdTmp, 'executed.marker')
        let p = mkPkg({ 'toolg/g.mjs': `import fs from 'fs'\nfs.writeFileSync(${JSON.stringify(marker)}, 'x')\np().catch((e) => { console.log(e) })\n` }, ['node toolg/g.mjs'])
        runCheckBuildScripts([p])
        assert.strictEqual(fs.existsSync(marker), false)
    })

})
