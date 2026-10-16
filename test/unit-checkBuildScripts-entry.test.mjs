//g_checkBuildScripts.mjs 進入點之離開碼(子程序; 以 test/tools/hooksStub.mjs 的 listUpdates 模式換掉 getFolders、parseProject, 掃描與報告用真的)
//對應需求(帳本 CLAUDE_rulebook.md 1.3): R22.4 有吞錯站點離開碼 1、無則 0; R22.1 完全唯讀(外審 O-12: 原僅有核心函式測試, 進入點的 process.exitCode 接線無測試)
//fixture 於 test/_tmp/unit-checkBuildScripts-entry; 只有 script.txt 與假腳本, 不碰套件區、不執行 git/npm
import assert from 'assert'
import fs from 'fs'
import path from 'path'
import cp from 'child_process'
import { cleanTmpRoot } from './tools/mkFixturePkg.mjs'


let fdTmp = path.resolve('./test/_tmp/unit-checkBuildScripts-entry')

let mk = (name, level, src) => {
    let fd = path.join(fdTmp, name)
    fs.mkdirSync(path.join(fd, 'toolg'), { recursive: true })
    fs.writeFileSync(path.join(fd, 'toolg', 'g.mjs'), src, 'utf8')
    fs.writeFileSync(path.join(fd, 'script.txt'), 'node toolg/g.mjs\r\n', 'utf8')
    return { name, path: fd, level: String(level) }
}
let run = (pkgs) => {
    let r = cp.spawnSync(process.execPath, ['--import', './test/tools/hooksStub.mjs', 'g_checkBuildScripts.mjs'], {
        cwd: path.resolve('.'),
        env: { ...process.env, STUB_MODE: 'listUpdates', FIXTURE_PKGS: JSON.stringify(pkgs) },
        encoding: 'utf8',
        timeout: 60000,
    })
    return { code: r.status, out: r.stdout || '', err: r.stderr || '' }
}


describe('g_checkBuildScripts 進入點離開碼(R22.4; 子程序 + 樁 getFolders/parseProject)', function() {

    before(function() {
        fs.rmSync(fdTmp, { recursive: true, force: true })
        fs.mkdirSync(fdTmp, { recursive: true })
    })

    after(function() {
        fs.rmSync(fdTmp, { recursive: true, force: true })
        cleanTmpRoot()
    })

    it('R22.4 有吞錯站點 → 離開碼 1, 報告含站點行與彙總行 吞錯站點: 1 個 repo、1 處', function() {
        let r = run([mk('swallow', 3, `p().catch((e) => { console.log(e) })\n`)])
        assert.strictEqual(r.code, 1, r.out + r.err)
        assert.ok(r.out.indexOf('swallow | toolg/g.mjs | 1 | .catch | swallow-log') >= 0, r.out)
        assert.ok(r.out.indexOf('吞錯站點: 1 個 repo、1 處') >= 0, r.out)
    })

    it('R22.4 無吞錯站點(傳遞者)→ 離開碼 0, 報告為 無吞錯站點', function() {
        let r = run([mk('clean', 3, `p().catch((e) => { throw e })\n`)])
        assert.strictEqual(r.code, 0, r.out + r.err)
        assert.ok(r.out.indexOf('無吞錯站點') >= 0, r.out)
    })

    it('R22.1 唯讀: 執行後 fixture 的腳本與 script.txt 內容不變、資料夾內無新增檔案', function() {
        let p = mk('readonly', 3, `p().catch(() => {})\n`)
        let before = fs.readdirSync(p.path, { recursive: true }).sort()
        let src = fs.readFileSync(path.join(p.path, 'toolg', 'g.mjs'), 'utf8')
        run([p])
        assert.deepStrictEqual(fs.readdirSync(p.path, { recursive: true }).sort(), before)
        assert.strictEqual(fs.readFileSync(path.join(p.path, 'toolg', 'g.mjs'), 'utf8'), src)
    })

})
