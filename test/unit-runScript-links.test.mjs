//removeTarget 之連結(junction)處置與存在判斷(真檔案系統; fixture 於 test/_tmp/unit-runScript-links; 連結以 junction 建立, 不需管理員權限)
//對應需求(帳本 CLAUDE_rulebook.md 1.3): R14.9 目標之祖先經連結逸出套件時拒絕(外審 F01、O-13)、R14.10 存在判斷用 lstat 不跟隨連結(外審 F15)
import assert from 'assert'
import fs from 'fs'
import path from 'path'
import { removeTarget } from '../src/runScript.mjs'
import { cleanTmpRoot } from './tools/mkFixturePkg.mjs'


let fdRoot = path.resolve('./test/_tmp/unit-runScript-links')
let n = 0

//每個測試各自一組 pkg 與 outside, 互不干擾; 回傳 { pkg, out }
let mk = () => {
    let base = path.join(fdRoot, `c${++n}`)
    let pkg = path.join(base, 'pkg')
    let out = path.join(base, 'outside')
    fs.mkdirSync(path.join(out, 'sub'), { recursive: true })
    fs.writeFileSync(path.join(out, 'sub', 'file.txt'), 'keep', 'utf8')
    fs.writeFileSync(path.join(out, 'top.txt'), 'keep', 'utf8')
    fs.mkdirSync(pkg, { recursive: true })
    return { base, pkg, out }
}
let junction = (target, linkPath) => fs.symlinkSync(target, linkPath, 'junction')
let lexists = (p) => {
    try {
        fs.lstatSync(p)
        return true
    }
    catch (err) {
        return false
    }
}


describe('runScript removeTarget 連結(R14.9、R14.10; 真 junction)', function() {

    before(function() {
        fs.rmSync(fdRoot, { recursive: true, force: true })
        fs.mkdirSync(fdRoot, { recursive: true })
    })

    after(function() {
        //先以 rmdir 移除所有 junction 再整體刪除, 避免遞迴刪除時穿越連結
        for (let i = 1; i <= n; i++) {
            let base = path.join(fdRoot, `c${i}`, 'pkg')
            if (fs.existsSync(base) || lexists(base)) {
                for (let name of fs.readdirSync(base)) {
                    let p = path.join(base, name)
                    if (fs.lstatSync(p).isSymbolicLink()) {
                        fs.rmdirSync(p)
                    }
                }
            }
        }
        fs.rmSync(fdRoot, { recursive: true, force: true })
        cleanTmpRoot()
    })

    it('R14.9 docs 為指向套件外的 junction, 目標 docs/sub 字面在套件內、實體在套件外 → throw 目標經連結位於套件外, 不呼叫刪除, 套件外內容不動', function() {
        let { pkg, out } = mk()
        junction(out, path.join(pkg, 'docs'))
        let called = 0
        assert.throws(
            () => removeTarget(pkg, 'docs/sub', { rm: () => { called++ } }),
            (err) => {
                let esc = path.join(pkg, 'docs', 'sub').replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')
                return new RegExp(`^Error: rm指令失敗: 目標經連結位於套件外\\[${esc}\\]$`).test(String(err))
            }
        )
        assert.strictEqual(called, 0)
        assert.strictEqual(fs.readFileSync(path.join(out, 'sub', 'file.txt'), 'utf8'), 'keep')
    })

    it('R14.9 不用自訂 rm 而走預設刪除實作時, 同樣拒絕且套件外內容不動', function() {
        let { pkg, out } = mk()
        junction(out, path.join(pkg, 'docs'))
        assert.throws(() => removeTarget(pkg, 'docs/sub'), /rm指令失敗: 目標經連結位於套件外/)
        assert.throws(() => removeTarget(pkg, 'docs/top.txt'), /rm指令失敗: 目標經連結位於套件外/)
        assert.strictEqual(fs.readFileSync(path.join(out, 'sub', 'file.txt'), 'utf8'), 'keep')
        assert.strictEqual(fs.readFileSync(path.join(out, 'top.txt'), 'utf8'), 'keep')
    })

    it('R14.9 連結指向套件內其他位置(實體仍在套件內)→ 不拒絕, 正常移除', function() {
        let { pkg } = mk()
        fs.mkdirSync(path.join(pkg, 'real'), { recursive: true })
        fs.writeFileSync(path.join(pkg, 'real', 'x.txt'), 'x', 'utf8')
        junction(path.join(pkg, 'real'), path.join(pkg, 'alias'))
        let r = removeTarget(pkg, 'alias/x.txt')
        assert.strictEqual(r.state, 'removed')
        assert.strictEqual(lexists(path.join(pkg, 'real', 'x.txt')), false)
    })

    it('R14.9 目標本身是指向套件外的 junction → 只移除連結本身, 連結指向之內容不動', function() {
        let { pkg, out } = mk()
        junction(out, path.join(pkg, 'lnk'))
        let r = removeTarget(pkg, 'lnk')
        assert.strictEqual(r.state, 'removed')
        assert.strictEqual(lexists(path.join(pkg, 'lnk')), false)
        assert.strictEqual(fs.readFileSync(path.join(out, 'sub', 'file.txt'), 'utf8'), 'keep')
        assert.strictEqual(fs.readFileSync(path.join(out, 'top.txt'), 'utf8'), 'keep')
    })

    it('R14.10 懸空 junction(目標已不存在)屬存在: 回傳 removed 而非 absent, 連結已被移除, 回驗通過', function() {
        let { base, pkg } = mk()
        let gone = path.join(base, 'gone')
        fs.mkdirSync(gone, { recursive: true })
        junction(gone, path.join(pkg, 'dang'))
        fs.rmdirSync(gone)
        assert.strictEqual(fs.existsSync(path.join(pkg, 'dang')), false) //existsSync 跟隨連結, 懸空時為 false(舊判斷據此誤回報 absent)
        assert.strictEqual(lexists(path.join(pkg, 'dang')), true)
        let r = removeTarget(pkg, 'dang')
        assert.strictEqual(r.state, 'removed')
        assert.strictEqual(lexists(path.join(pkg, 'dang')), false)
    })

    it('R14.10 回驗亦不跟隨連結: 假 rm 未移除懸空 junction → throw 移除後仍存在', function() {
        let { base, pkg } = mk()
        let gone = path.join(base, 'gone')
        fs.mkdirSync(gone, { recursive: true })
        junction(gone, path.join(pkg, 'dang'))
        fs.rmdirSync(gone)
        assert.throws(() => removeTarget(pkg, 'dang', { rm: () => {} }), /rm指令失敗: 移除後仍存在/)
        assert.strictEqual(lexists(path.join(pkg, 'dang')), true) //清理由 after 負責
    })

    it('R14.6 不存在之目標仍回傳 absent 且不呼叫刪除(含父資料夾不存在)', function() {
        let { pkg } = mk()
        let called = 0
        assert.strictEqual(removeTarget(pkg, 'nope', { rm: () => { called++ } }).state, 'absent')
        assert.strictEqual(removeTarget(pkg, 'nope/deeper/x', { rm: () => { called++ } }).state, 'absent')
        assert.strictEqual(called, 0)
    })

    it('R14.9 實體路徑無法解析(注入 realpath 拋 EACCES)→ 拒絕: throw 無法確認目標位置[路徑]: EACCES, 只引 err.code, 不呼叫刪除', function() {
        let { pkg } = mk()
        fs.mkdirSync(path.join(pkg, 'docs'), { recursive: true })
        let called = 0
        let realpath = () => {
            let e = new Error('拒絕存取 亂碼路徑')
            e.code = 'EACCES'
            throw e
        }
        assert.throws(
            () => removeTarget(pkg, 'docs', { realpath, rm: () => { called++ } }),
            (err) => err.message === `rm指令失敗: 無法確認目標位置[${path.join(pkg, 'docs')}]: EACCES`
        )
        assert.strictEqual(called, 0)
    })

    it('R14.9 套件路徑大小寫與實際不同, 且父資料夾經套件內 junction 解析(實體路徑大小寫由連結目標決定)→ 以 native 實體路徑且不分大小寫比對, 不誤拒絕', function() {
        if (process.platform !== 'win32') {
            this.skip()
        }
        let { pkg } = mk()
        fs.mkdirSync(path.join(pkg, 'real'), { recursive: true })
        fs.writeFileSync(path.join(pkg, 'real', 'x.txt'), 'x', 'utf8')
        junction(path.join(pkg, 'real'), path.join(pkg, 'alias'))
        let weird = pkg.replace(/pkg$/, 'PKG')
        let r = removeTarget(weird, 'alias/x.txt')
        assert.strictEqual(r.state, 'removed')
        assert.strictEqual(lexists(path.join(pkg, 'real', 'x.txt')), false)
    })

    it('R14.9 套件路徑大小寫與實際不同(Windows 檔案系統不分大小寫)→ 以實體路徑比對, 不誤拒絕', function() {
        if (process.platform !== 'win32') {
            this.skip()
        }
        let { pkg } = mk()
        fs.mkdirSync(path.join(pkg, 'docs'), { recursive: true })
        fs.writeFileSync(path.join(pkg, 'docs', 'a.txt'), 'a', 'utf8')
        let weird = pkg.replace(/pkg$/, 'PKG')
        let r = removeTarget(weird, 'docs/a.txt')
        assert.strictEqual(r.state, 'removed')
    })

})
