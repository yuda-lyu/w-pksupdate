//checkMainFiles 之入口解析與 exports 檢查(真檔案系統; fixture 於 test/_tmp/unit-runScript-mainfiles)
//對應需求(帳本 CLAUDE_rulebook.md 1.3): R17.8 入口解析比照 Node(外審 F09)、R17.9 exports 一併檢查(外審 F08)、R17.4 補『套件外』以路徑段判定(外審 F12)
import assert from 'assert'
import fs from 'fs'
import path from 'path'
import { checkMainFiles } from '../src/runScript.mjs'
import { cleanTmpRoot } from './tools/mkFixturePkg.mjs'


let fdRoot = path.resolve('./test/_tmp/unit-runScript-mainfiles')
let n = 0
let startMs = Date.UTC(2026, 9, 16, 12, 0, 0)
let fresh = { content: 'built', mtimeMs: startMs + 5000 }

//建 fixture 套件: pj 為 package.json 物件; files 為 { 相對路徑: { content, mtimeMs? } | 'dir' }; 回傳套件資料夾
let mk = (pj, files = {}) => {
    let fd = path.join(fdRoot, `p${++n}`)
    fs.mkdirSync(fd, { recursive: true })
    fs.writeFileSync(path.join(fd, 'package.json'), JSON.stringify(pj), 'utf8')
    for (let [rel, o] of Object.entries(files)) {
        let fp = path.join(fd, rel)
        fs.mkdirSync(path.dirname(fp), { recursive: true })
        if (o === 'dir') {
            fs.mkdirSync(fp, { recursive: true })
            continue
        }
        fs.writeFileSync(fp, o.content, 'utf8')
        if (o.mtimeMs !== undefined) {
            fs.utimesSync(fp, new Date(o.mtimeMs), new Date(o.mtimeMs))
        }
    }
    return fd
}
let check = (fd) => checkMainFiles(fd, { startMs, slackMs: 2000 })
let ok = { fatal: [], warn: [] }


describe('runScript checkMainFiles 入口解析(R17.8; 比照 Node 補副檔名與 index)', function() {

    before(function() {
        fs.rmSync(fdRoot, { recursive: true, force: true })
        fs.mkdirSync(fdRoot, { recursive: true })
    })

    after(function() {
        fs.rmSync(fdRoot, { recursive: true, force: true })
        cleanTmpRoot()
    })

    it('main 省略副檔名: 字面檔不存在時依序補 .js、.json、.node(比照 Node, 不補 .mjs、.cjs), 解析到者通過', function() {
        for (let ext of ['.js', '.json', '.node']) {
            let fd = mk({ main: 'dist/x' }, { [`dist/x${ext}`]: fresh })
            assert.deepStrictEqual(check(fd), ok, ext)
        }
    })

    it('第二輪 N4: 只有 x.mjs 或只有 x.cjs → Node 的 require 與 import 都載入失敗, 閘門須報不存在(不補 .mjs、.cjs)', function() {
        for (let ext of ['.mjs', '.cjs']) {
            let fd = mk({ main: 'dist/x' }, { [`dist/x${ext}`]: fresh })
            assert.deepStrictEqual(check(fd).fatal, ['main[dist/x]不存在'], ext)
        }
    })

    it('補副檔名有先後: .js 先於 .json; 先解析到的檔案為空檔 → 報為空檔(訊息仍以欄位原值顯示)', function() {
        let fd = mk({ main: 'dist/x' }, { 'dist/x.js': { content: '', mtimeMs: startMs + 5000 }, 'dist/x.json': fresh })
        let r = check(fd)
        assert.deepStrictEqual(r.fatal, ['main[dist/x]為空檔'])
    })

    it('第二輪 N4: main 為資料夾名但同名 .js 檔存在 → 先補副檔名(Node: tryFile → tryExtensions → index), 載入的是 lib.js; lib.js 為空而 lib/index.js 非空 → 報為空檔(Node 載到空檔)', function() {
        let fd1 = mk({ main: 'lib' }, { 'lib.js': fresh, 'lib': 'dir' })
        assert.deepStrictEqual(check(fd1), ok) //原誤擋: main[lib]不是檔案
        let fd2 = mk({ main: 'lib' }, { 'lib.js': { content: '', mtimeMs: startMs + 5000 }, 'lib/index.js': fresh })
        assert.deepStrictEqual(check(fd2).fatal, ['main[lib]為空檔']) //原漏判: 放行
    })

    it('字面檔存在則直接使用, 不再補副檔名', function() {
        let fd = mk({ main: 'dist/x.js' }, { 'dist/x.js': { content: '', mtimeMs: startMs + 5000 }, 'dist/x.js.js': fresh })
        assert.deepStrictEqual(check(fd).fatal, ['main[dist/x.js]為空檔'])
    })

    it('main 為資料夾: 嘗試其 index.js、index.json、index.node, 解析到者通過', function() {
        for (let name of ['index.js', 'index.json', 'index.node']) {
            let fd = mk({ main: 'lib' }, { [`lib/${name}`]: fresh })
            assert.deepStrictEqual(check(fd), ok, name)
        }
    })

    it('main 為資料夾但無 index → 不是檔案; 其 index.js 為空檔 → 為空檔', function() {
        let fd1 = mk({ main: 'lib' }, { 'lib': 'dir' })
        assert.deepStrictEqual(check(fd1).fatal, ['main[lib]不是檔案'])
        let fd2 = mk({ main: 'lib' }, { 'lib/index.js': { content: '', mtimeMs: startMs + 5000 } })
        assert.deepStrictEqual(check(fd2).fatal, ['main[lib]為空檔'])
    })

    it('皆無 → 維持不存在; module、browser 同樣解析', function() {
        let fd1 = mk({ main: 'dist/none' })
        assert.deepStrictEqual(check(fd1).fatal, ['main[dist/none]不存在'])
        let fd2 = mk({ module: 'dist/m', browser: 'dist/b' }, { 'dist/m.json': fresh, 'dist/b/index.js': fresh })
        assert.deepStrictEqual(check(fd2), ok)
    })

})


describe('runScript checkMainFiles exports(R17.9)', function() {

    before(function() {
        fs.rmSync(fdRoot, { recursive: true, force: true })
        fs.mkdirSync(fdRoot, { recursive: true })
    })

    after(function() {
        fs.rmSync(fdRoot, { recursive: true, force: true })
        cleanTmpRoot()
    })

    it('exports 為字串: 存在 → 通過; 不存在 → fatal exports[<路徑>]不存在', function() {
        let fd1 = mk({ exports: './dist/a.js' }, { 'dist/a.js': fresh })
        assert.deepStrictEqual(check(fd1), ok)
        let fd2 = mk({ exports: './dist/a.js' })
        assert.deepStrictEqual(check(fd2).fatal, ['exports[dist/a.js]不存在'])
    })

    it('exports 為物件含子路徑與條件巢狀、陣列: 全部以 ./ 開頭之字串目標逐一檢查', function() {
        let pj = {
            exports: {
                '.': { import: './dist/a.mjs', require: './dist/a.cjs', default: { node: './dist/n.js' } },
                './b': ['./dist/b1.js', './dist/b2.js'],
                './package.json': './package.json',
            },
        }
        let all = { 'dist/a.mjs': fresh, 'dist/a.cjs': fresh, 'dist/n.js': fresh, 'dist/b1.js': fresh, 'dist/b2.js': fresh }
        let fd1 = mk(pj, all)
        assert.deepStrictEqual(check(fd1), ok) //./package.json 由 mk 建立且非空
        let fd2 = mk(pj, { 'dist/a.mjs': fresh, 'dist/a.cjs': fresh, 'dist/b1.js': fresh })
        assert.deepStrictEqual(check(fd2).fatal.sort(), ['exports[dist/b2.js]不存在', 'exports[dist/n.js]不存在'])
    })

    it('types、typings 條件之目標不檢查(型別宣告檔建置不一定產出)', function() {
        let fd = mk({ exports: { '.': { types: './dist/a.d.ts', typings: './dist/a.d.ts', import: './dist/a.mjs' } } }, { 'dist/a.mjs': fresh })
        assert.deepStrictEqual(check(fd), ok)
    })

    it('含 * 之樣式目標、不以 ./ 開頭之字串、null 目標、非字串值皆略過', function() {
        let fd = mk({ exports: { './*': './dist/*.js', './x': 'dist/x.js', './y': null, './z': 123 } })
        assert.deepStrictEqual(check(fd), ok)
    })

    it('exports 目標為空檔、資料夾 → 為空檔、不是檔案; 且不補副檔名(精確路徑)', function() {
        let fd1 = mk({ exports: './dist/a.js' }, { 'dist/a.js': { content: '', mtimeMs: startMs + 5000 } })
        assert.deepStrictEqual(check(fd1).fatal, ['exports[dist/a.js]為空檔'])
        let fd2 = mk({ exports: './dist' }, { dist: 'dir' })
        assert.deepStrictEqual(check(fd2).fatal, ['exports[dist]不是檔案'])
        let fd3 = mk({ exports: './dist/a' }, { 'dist/a.js': fresh })
        assert.deepStrictEqual(check(fd3).fatal, ['exports[dist/a]不存在'])
    })

    it('main 與 exports 同時異常 → 逐項列出; exports 目標指向套件外 → 只留痕不中止', function() {
        let fd1 = mk({ main: 'dist/m.js', exports: './dist/e.js' })
        assert.deepStrictEqual(check(fd1).fatal, ['main[dist/m.js]不存在', 'exports[dist/e.js]不存在'])
        let fd2 = mk({ exports: './../outside.js' })
        let r = check(fd2)
        assert.deepStrictEqual(r.fatal, [])
        assert.strictEqual(r.warn.length, 1)
        assert.ok(r.warn[0].indexOf('主檔路徑不在套件內, 略過') >= 0, r.warn[0])
    })

})


describe('runScript checkMainFiles 套件外判定(R17.4 補: 以路徑段, 外審 F12)', function() {

    before(function() {
        fs.rmSync(fdRoot, { recursive: true, force: true })
        fs.mkdirSync(fdRoot, { recursive: true })
    })

    after(function() {
        fs.rmSync(fdRoot, { recursive: true, force: true })
        cleanTmpRoot()
    })

    it('以兩個點開頭之普通名稱(..cache/x.js)屬套件內: 存在即通過, 不被誤判為套件外', function() {
        let fd = mk({ main: '..cache/x.js' }, { '..cache/x.js': fresh })
        assert.deepStrictEqual(check(fd), ok)
    })

    it('..cache 內主檔不存在 → 報不存在而非套件外', function() {
        let fd = mk({ main: '..cache/x.js' })
        assert.deepStrictEqual(check(fd).fatal, ['main[..cache/x.js]不存在'])
    })

    it('../x.js、.. 與 ..\\x.js 仍為套件外 → 只留痕不中止', function() {
        for (let v of ['../x.js', '..', '..\\x.js']) {
            if (v.indexOf('\\') >= 0 && process.platform !== 'win32') {
                continue //反斜線僅在 Windows 為路徑分隔字元
            }
            let fd = mk({ main: v })
            let r = check(fd)
            assert.deepStrictEqual(r.fatal, [], v)
            assert.strictEqual(r.warn.length, 1, v)
        }
    })

})
