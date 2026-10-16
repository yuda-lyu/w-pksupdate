//g_listUpdates.mjs 預覽入口之離開碼與「未能判定」處置(子程序; 以 test/tools/hooksStub.mjs 的 listUpdates 模式換掉 getFolders、parseProject, getUpdate 用真的)
//對應需求(帳本 CLAUDE_rulebook.md 1.3): R23 預覽入口離開碼(外審 F16); fixture 於 test/_tmp/unit-listUpdates, 只有 package.json, 不碰套件區、不執行 git/npm
import assert from 'assert'
import fs from 'fs'
import path from 'path'
import cp from 'child_process'
import { cleanTmpRoot } from './tools/mkFixturePkg.mjs'


let fdTmp = path.resolve('./test/_tmp/unit-listUpdates')
let n = 0

//建 fixture 套件並回傳 parseProject 樁所用之項目; o 為 package.json 物件(version 預設 1.0.0)
let mk = (dir, name, level, o) => {
    let fd = path.join(dir, name)
    fs.mkdirSync(fd, { recursive: true })
    fs.writeFileSync(path.join(fd, 'package.json'), JSON.stringify({ name, version: '1.0.0', ...o }), 'utf8')
    return { name, path: fd, level: String(level) }
}
let run = (pkgs) => {
    let r = cp.spawnSync(process.execPath, ['--import', './test/tools/hooksStub.mjs', 'g_listUpdates.mjs'], {
        cwd: path.resolve('.'),
        env: { ...process.env, STUB_MODE: 'listUpdates', FIXTURE_PKGS: JSON.stringify(pkgs) },
        encoding: 'utf8',
        timeout: 60000,
    })
    return { code: r.status, out: r.stdout || '', err: r.stderr || '' }
}
//取「完全不受影響的穩定套件」一節之名稱清單
let stableOf = (out) => {
    let m = out.match(/穩定套件\(共 \d+ 個\) -----\r?\n([^\r\n]*)/)
    return m ? m[1] : null
}


describe('g_listUpdates 預覽入口(R23; 子程序 + 樁 getFolders/parseProject + 真 getUpdate)', function() {

    before(function() {
        fs.rmSync(fdTmp, { recursive: true, force: true })
        fs.mkdirSync(fdTmp, { recursive: true })
    })

    after(function() {
        fs.rmSync(fdTmp, { recursive: true, force: true })
        cleanTmpRoot()
    })

    //a(3) 無相依; b(4) 相依 a 且已對齊; c(4) 相依 a 但落後; d(5) 相依 c 且已對齊(因 c 發布而連鎖)
    let base = (dir) => [
        mk(dir, 'a', 3, { version: '1.0.1' }),
        mk(dir, 'b', 4, { dependencies: { a: '^1.0.1' } }),
        mk(dir, 'c', 4, { devDependencies: { a: '^1.0.0' } }),
        mk(dir, 'd', 5, { dependencies: { c: '^1.0.0' } }),
    ]

    it('R23.2 全部可判定 → 離開碼 0; 第一波 1(c)、連鎖後發布集合 2(c、d)、穩定為 a、b; 不輸出未能判定一節 (R23.3 其餘格式不變)', function() {
        let dir = path.join(fdTmp, `c${++n}`)
        let r = run(base(dir))
        assert.strictEqual(r.code, 0, r.out + r.err)
        assert.ok(r.out.indexOf('全部套件            : 4') >= 0, r.out)
        assert.ok(r.out.indexOf('第一波(現已過期)  : 1') >= 0, r.out)
        assert.ok(r.out.indexOf('連鎖後最終發布集合  : 2') >= 0, r.out)
        assert.strictEqual(stableOf(r.out), 'a, b')
        assert.ok(r.out.indexOf('未能判定') < 0, r.out)
    })

    it('R23.1、R23.2 某套件 getUpdate 拋錯(依賴層級順序違規: e 為 3、依賴 4 之 f)→ 離開碼 1; e 不在穩定清單、不在第一波與連鎖; 其餘套件仍被判定; 獨立一節列出名稱與原因', function() {
        let dir = path.join(fdTmp, `c${++n}`)
        let pkgs = [...base(dir), mk(dir, 'e', 3, { dependencies: { f: '^1.0.0' } }), mk(dir, 'f', 4, {})]
        let r = run(pkgs)
        assert.strictEqual(r.code, 1, r.out + r.err)
        assert.ok(r.out.indexOf('第一波(現已過期)  : 1') >= 0, r.out)
        assert.ok(r.out.indexOf('連鎖後最終發布集合  : 2') >= 0, r.out)
        assert.strictEqual(stableOf(r.out), 'a, b, f') //e 不在其中
        assert.ok(r.out.indexOf('未能判定(getUpdate 拋錯): 1') >= 0, r.out)
        let m = r.out.match(/----- 未能判定\(getUpdate 拋錯, 共 1 個[^\r\n]*-----\r?\n([^\r\n]*)/)
        assert.ok(m, r.out)
        assert.ok(m[1].indexOf('● e: 套件[e]依賴層級level[3] < 套件[f]依賴層級level[4]') === 0, m[1])
    })

    it('第二輪 N6: 未能判定者(e,實際已落後)之下游 g(已對齊於 e)不是「完全不受影響」→ 另列一節「受未能判定者影響」, 不在穩定清單; 與第一波/連鎖無關之 a、b、f 仍為穩定', function() {
        let dir = path.join(fdTmp, `c${++n}`)
        //e(3) 相依 a ^1.0.0(落後)且相依 level 4 之 f(層級違規 → getUpdate 拋錯); g(5) 相依 e 且已對齊; h(6) 相依 g(傳遞)
        let pkgs = [...base(dir), mk(dir, 'e', 3, { dependencies: { f: '^1.0.0' }, devDependencies: { a: '^1.0.0' } }), mk(dir, 'f', 4, {}), mk(dir, 'g', 5, { dependencies: { e: '^1.0.0' } }), mk(dir, 'h', 6, { dependencies: { g: '^1.0.0' } })]
        let r = run(pkgs)
        assert.strictEqual(r.code, 1, r.out + r.err)
        assert.strictEqual(stableOf(r.out), 'a, b, f')
        let m = r.out.match(/----- 受未能判定者影響[^\r\n]*-----\r?\n([^\r\n]*)/)
        assert.ok(m, r.out)
        assert.strictEqual(m[1], 'g, h')
    })

    it('第二輪 N6: 未能判定者之下游已在發布集合時(同時因其他來源落後)仍算發布集合, 不重複列入「受影響」節', function() {
        let dir = path.join(fdTmp, `c${++n}`)
        //e(3) 拋錯; k(4) 相依 e 且相依 a ^1.0.0(落後 → 第一波)
        let pkgs = [...base(dir), mk(dir, 'e', 3, { dependencies: { f: '^1.0.0' } }), mk(dir, 'f', 4, {}), mk(dir, 'k', 4, { dependencies: { e: '^1.0.0' }, devDependencies: { a: '^1.0.0' } })]
        let r = run(pkgs)
        assert.strictEqual(r.code, 1, r.out + r.err)
        assert.ok(r.out.indexOf('第一波(現已過期)  : 2') >= 0, r.out) //c 與 k
        assert.ok(r.out.indexOf('受未能判定者影響') < 0, r.out)
    })

    it('R23.1 getUpdate 對所有套件皆拋錯(任一套件缺 version, getUpdate 先讀全部)→ 全部列入未能判定, 穩定清單為空, 離開碼 1', function() {
        let dir = path.join(fdTmp, `c${++n}`)
        let pkgs = [mk(dir, 'a', 3, {}), mk(dir, 'b', 4, {})]
        fs.writeFileSync(path.join(pkgs[1].path, 'package.json'), JSON.stringify({ name: 'b' }), 'utf8') //無 version
        let r = run(pkgs)
        assert.strictEqual(r.code, 1, r.out + r.err)
        assert.strictEqual(stableOf(r.out), '(無)')
        assert.ok(r.out.indexOf('共 2 個; 不計入第一波、連鎖與穩定') >= 0, r.out)
    })

})
