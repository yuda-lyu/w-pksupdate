//checkBuildScripts 外審補強測試(R22.5 正規式字面值、R22.7 靜默形擴充與字串抹空、R22.8 解構 catch 參數、R22.9 .then 第二引數與 process.on)
//對應需求(帳本 CLAUDE_rulebook.md 1.3): R22(外審 O-07); fixture 於 test/_tmp/unit-checkBuildScripts-ext, 以假套件與假腳本驗證, 不碰套件區
import assert from 'assert'
import fs from 'fs'
import path from 'path'
import { stripComments, classifyBody, scanScriptSource, checkBuildScripts } from '../src/checkBuildScripts.mjs'
import { cleanTmpRoot } from './tools/mkFixturePkg.mjs'


let fdTmp = path.resolve('./test/_tmp/unit-checkBuildScripts-ext')
let n = 0

//建含單一腳本與 node 列之假套件, 回傳該套件之 checkBuildScripts 結果
let scanSrc = (src) => {
    let name = `pkg${++n}`
    let fd = path.join(fdTmp, name)
    fs.mkdirSync(path.join(fd, 'toolg'), { recursive: true })
    fs.writeFileSync(path.join(fd, 'toolg', 'g.mjs'), src, 'utf8')
    fs.writeFileSync(path.join(fd, 'script.txt'), 'node toolg/g.mjs\r\n', 'utf8')
    return checkBuildScripts([{ name, path: fd }])
}
let sitesOf = (src) => scanSrc(src).sites
let clsOf = (src) => scanSrc(src).sites.map((s) => `${s.kind}:${s.cls}`)


describe('checkBuildScripts 外審補強(R22.5、R22.7、R22.8、R22.9)', function() {

    before(function() {
        fs.rmSync(fdTmp, { recursive: true, force: true })
        fs.mkdirSync(fdTmp, { recursive: true })
    })

    after(function() {
        fs.rmSync(fdTmp, { recursive: true, force: true })
        cleanTmpRoot()
    })

    it('R22.5 正規式字面值內的 // 不是行註解: 同一行之後的 .catch( 仍被掃到(舊版整行被當註解而漏掃)', function() {
        let sites = sitesOf(`let re = /^https?:\\/\\//; p().catch((e) => { console.log(e) })\n`)
        assert.deepStrictEqual(sites.map((s) => [s.line, s.kind, s.cls]), [[1, '.catch', 'swallow-log']])
    })

    it('R22.5 正規式字面值前後的註解仍被去除; 除法後的 // 仍是註解; 行號不位移', function() {
        let src = [
            `let re = /x/g // p().catch(() => {})`,
            `let a = b / 2 // q().catch(() => {})`,
            `r().catch((e) => { console.log(e) })`,
            `let s = x.split(/\\/\\//) /* s().catch(() => {}) */`,
            ``,
        ].join('\n')
        assert.deepStrictEqual(sitesOf(src).map((s) => [s.line, s.cls]), [[3, 'swallow-log']])
        assert.strictEqual(stripComments(src).split('\n').length, src.split('\n').length)
    })

    it('R22.5 正規式字面值含引號(/["\']/)不致使其後內容被誤當字串', function() {
        let src = `let re = /["']/g\np().catch((e) => { console.log(e) })\nlet t = "x" // c\n`
        assert.deepStrictEqual(sitesOf(src).map((s) => [s.line, s.cls]), [[2, 'swallow-log']])
    })

    it('R22.7 靜默形擴充: function 字面值、async 箭頭、回傳常數、僅 return → 皆 swallow-silent', function() {
        let cases = [
            `p().catch(function(e){})`,
            `p().catch(function () {})`,
            `p().catch(async () => {})`,
            `p().catch(async (e) => {})`,
            `p().catch(() => false)`,
            `p().catch(() => 0)`,
            `p().catch((e) => true)`,
            `p().catch(() => '')`,
            `p().catch(() => ({}))`,
            `p().catch((e) => { return })`,
            `p().catch((e) => { return null })`,
            `p().catch(function (e) { return e })`,
            `try { await p() } catch (e) { return }`,
        ]
        for (let src of cases) {
            assert.deepStrictEqual(clsOf(src).map((x) => x.split(':')[1]), ['swallow-silent'], src)
        }
    })

    it('R22.7 含 console.* 而不傳遞者仍為 swallow-log(即使另有 return); 含函式呼叫者為 other(不計入吞錯)', function() {
        for (let src of [
            `p().catch(function (e) { console.error(e) })`,
            `p().catch((e) => { console.log(e); return null })`,
            `p().catch((e) => console.log(e))`,
            `p().catch(console.log)`,
        ]) {
            assert.deepStrictEqual(clsOf(src), ['.catch:swallow-log'], src)
        }
        for (let src of [`p().catch((e) => { cleanup(e) })`, `p().catch((e) => { return fix(e) })`, `p().catch(retry)`, `p().catch((e) => handle(e))`]) {
            let r = scanSrc(src)
            assert.deepStrictEqual(r.sites, [], src)
            assert.strictEqual(r.others.length, 1, src)
        }
    })

    it('R22.7 判斷前先把字串與樣板字串字面值抹空: 字串中的 throw / process.exit(1) 字樣不算傳遞; 字串中的函式呼叫不算呼叫; 字串中的 .catch( 不是站點', function() {
        assert.deepStrictEqual(clsOf(`p().catch((e) => { console.log('throw away') })`), ['.catch:swallow-log'])
        assert.deepStrictEqual(clsOf('p().catch((e) => { console.log(`process.exit(1) ${e}`) })'), ['.catch:swallow-log'])
        assert.deepStrictEqual(clsOf(`p().catch((e) => { return 'fix(e)' })`), ['.catch:swallow-silent'])
        assert.deepStrictEqual(sitesOf(`let s = 'p().catch(() => {})'\n`), [])
        assert.deepStrictEqual(clsOf(`p().catch((e) => { throw e })`), []) //真的 throw 仍是傳遞
    })

    it('R22.8 catch 參數為解構: try { } catch ({ message }) { } 與 catch ([a]) 皆被掃到並分類', function() {
        assert.deepStrictEqual(clsOf(`try { await p() } catch ({ message }) { console.log(message) }`), ['try-catch:swallow-log'])
        assert.deepStrictEqual(clsOf(`try { await p() } catch ({ message }) { }`), ['try-catch:swallow-silent'])
        assert.deepStrictEqual(clsOf(`try { await p() } catch ([a, b]) { console.warn(a) }`), ['try-catch:swallow-log'])
        assert.deepStrictEqual(clsOf(`try { await p() } catch ({ message }) { throw new Error(message) }`), [])
    })

    it('R22.9 .then(onFulfilled, onRejected) 之第二引數(kind then-onRejected)依 R22.3 分類; 只有一個引數者不是站點', function() {
        assert.deepStrictEqual(clsOf(`p().then(ok, (e) => { console.log(e) })`), ['then-onRejected:swallow-log'])
        assert.deepStrictEqual(clsOf(`p().then((v) => { f(v, 1) }, () => {})`), ['then-onRejected:swallow-silent'])
        assert.deepStrictEqual(clsOf(`p().then(ok, console.error)`), ['then-onRejected:swallow-log'])
        assert.deepStrictEqual(clsOf(`p().then(ok, (e) => { throw e })`), [])
        assert.deepStrictEqual(clsOf(`p().then((v) => { console.log(v, 'a,b') })`), [])
        assert.deepStrictEqual(clsOf(`p().then(ok)`), [])
        let r = scanSrc(`p().then(ok, handler)`)
        assert.deepStrictEqual(r.sites, [])
        assert.strictEqual(r.others.length, 1)
    })

    it('R22.9 process.on(unhandledRejection | uncaughtException, handler) 之 handler(kind process.on)依 R22.3 分類; 其他事件與傳遞者不是站點', function() {
        assert.deepStrictEqual(clsOf(`process.on('unhandledRejection', (e) => { console.log(e) })`), ['process.on:swallow-log'])
        assert.deepStrictEqual(clsOf(`process.on("uncaughtException", function () {})`), ['process.on:swallow-silent'])
        assert.deepStrictEqual(clsOf(`process.on('unhandledRejection', (e) => { console.error(e); process.exitCode = 1 })`), [])
        assert.deepStrictEqual(clsOf(`process.on('exit', (c) => { console.log(c) })`), [])
        assert.deepStrictEqual(clsOf(`process.on('SIGINT', () => {})`), [])
    })

    it('第二輪 N7: process.exitCode ||= 1、??= 1、process.exit(0x1)(十六進位非 0)會傳遞錯誤 → 不計入吞錯; exit(0) 與 exitCode ||= 0 仍不是傳遞', function() {
        for (let src of [
            `p().catch((e) => { console.log(e); process.exitCode ||= 1 })`,
            `p().catch((e) => { console.log(e); process.exitCode ??= 2 })`,
            `p().catch((e) => { console.log(e); process.exit(0x1) })`,
            `p().catch((e) => { console.log(e); process.exit(code) })`,
        ]) {
            assert.deepStrictEqual(clsOf(src), [], src)
        }
        assert.deepStrictEqual(clsOf(`p().catch((e) => { console.log(e); process.exit(0) })`), ['.catch:swallow-log'])
        assert.deepStrictEqual(clsOf(`p().catch((e) => { console.log(e); process.exitCode ||= 0 })`), ['.catch:swallow-log'])
    })

    it('第二輪 N7: process.once 與 process.addListener 註冊之 unhandledRejection/uncaughtException handler 亦掃(kind process.on)', function() {
        assert.deepStrictEqual(clsOf(`process.once('unhandledRejection', (e) => { console.log(e) })`), ['process.on:swallow-log'])
        assert.deepStrictEqual(clsOf(`process.addListener('uncaughtException', function () {})`), ['process.on:swallow-silent'])
        assert.deepStrictEqual(clsOf(`process.once('exit', () => { console.log(1) })`), [])
    })

    it('第二輪 N7: 大檔案行號仍正確(行號改以換行位置表二分搜尋計算): 第 1、5000、12000 行各一個站點', function() {
        let lines = []
        for (let i = 1; i <= 12000; i++) {
            lines.push(i === 1 || i === 5000 || i === 12000 ? `p${i}().catch((e) => { console.log(e) })` : `let a${i} = ${i}`)
        }
        let items = scanSrc(lines.join('\n') + '\n').sites
        assert.deepStrictEqual(items.map((s) => s.line), [1, 5000, 12000])
    })

    it('classifyBody 直接驗證擴充形態與抹空', function() {
        assert.strictEqual(classifyBody('(function(e){})'), 'swallow-silent')
        assert.strictEqual(classifyBody('(async () => {})'), 'swallow-silent')
        assert.strictEqual(classifyBody('(() => false)'), 'swallow-silent')
        assert.strictEqual(classifyBody('{ return }'), 'swallow-silent')
        assert.strictEqual(classifyBody(`{ console.log('throw') }`), 'swallow-log')
        assert.strictEqual(classifyBody('(e) => { }'), 'swallow-silent') //無外層括號之函式字面值(then 第二引數、process.on handler)
        assert.strictEqual(classifyBody('(e) => { f(e) }'), 'other')
    })

    it('scanScriptSource 之 body 為截短且去註解之原文(含字串內容), 供人工閱讀', function() {
        let items = scanScriptSource(`p().catch((e) => { console.log('hello world') /* c */ })\n`)
        assert.strictEqual(items.length, 1)
        assert.ok(items[0].body.indexOf(`'hello world'`) >= 0, items[0].body)
        assert.ok(items[0].body.indexOf('/* c */') < 0, items[0].body)
    })

})
