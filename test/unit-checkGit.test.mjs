//起跑預檢 git(帳本 R24)單元與整合測試
//  注入 opt.exec 驗證呼叫形態與失敗訊息; 另以真 ectScripts + 真 PowerShell 驗證: 墊片 git.cmd(輸出含/不含 git version、exit 0/1/128)、git 不在 PATH
//  絕不執行真 git: 墊片置於 PATH 最前並先探測確認被解析; 「git 不在 PATH」案把 PATH 縮為 PowerShell 所在目錄與 System32; GIT_DIR 指向不存在之路徑作雙重保險
//fixture 於 test/_tmp/unit-checkGit, before 建立、after 刪除
import assert from 'assert'
import fs from 'fs'
import path from 'path'
import checkGit from '../src/checkGit.mjs'
import { mkFixturePkg, cleanTmpRoot } from './tools/mkFixturePkg.mjs'
import { reFatal } from './tools/fatalWords.mjs'
import { ectReal } from './tools/realExec.mjs' //刻意走真實 PowerShell(帳本 R25.5): 限 test/_tmp 內 fixture; git 指令須 PATH 首項為墊片
import { getRealPath } from './tools/testEnv.mjs' //全域測試環境預設從 PATH 移除 PowerShell(R25.6), 本組明確取回原 PATH(opt-in)


let fdTmp = path.resolve('./test/_tmp/unit-checkGit')
let fdPkg = path.join(fdTmp, 'pkg')
let fdShim = path.join(fdTmp, 'gitshim')

let quiet = async (fn) => {
    let logOri = console.log
    console.log = () => {}
    try {
        return await fn()
    }
    finally {
        console.log = logOri
    }
}


describe('checkGit 起跑預檢(R24; 注入 exec)', function() {

    it('R24.1 以 main=git 執行 git --version, pdi 為 preflight, 逾時預設 120 秒, 路徑預設為 src 資料夾(必存在, 不用 process.cwd()); 輸出含 git version 即通過並回傳輸出', async function() {
        let seen = null
        let c = await checkGit({ exec: async (pdi, scps, o) => {
            seen = { pdi, scps, o }
            return 'git version 2.50.0.windows.1\n'
        } })
        assert.deepStrictEqual(seen, { pdi: { name: 'preflight', path: path.resolve('./src') }, scps: 'git --version', o: { main: 'git', timeoutMs: 120000 } })
        assert.ok(fs.existsSync(seen.pdi.path) && fs.statSync(seen.pdi.path).isDirectory())
        assert.strictEqual(c, 'git version 2.50.0.windows.1\n')
    })

    it('外審 opus F5: 預設路徑不依賴 process.cwd()(cwd 換到別處, 傳入 exec 的路徑仍為 src 資料夾)', async function() {
        let cwdOri = process.cwd()
        let seen = null
        process.chdir(path.dirname(process.execPath))
        try {
            await checkGit({ exec: async (pdi) => {
                seen = pdi.path
                return 'git version 1\n'
            } })
        }
        finally {
            process.chdir(cwdOri)
        }
        assert.strictEqual(seen, path.resolve(cwdOri, 'src'))
        assert.notStrictEqual(seen, path.dirname(process.execPath))
    })

    it('R24.4 opt.path、opt.timeoutMs 轉交 exec', async function() {
        let seen = null
        await checkGit({ path: 'C:/x', timeoutMs: 5000, exec: async (pdi, scps, o) => {
            seen = { pdi, o }
            return 'git version 1\n'
        } })
        assert.deepStrictEqual(seen, { pdi: { name: 'preflight', path: 'C:/x' }, o: { main: 'git', timeoutMs: 5000 } })
    })

    it('R24.1 exec 失敗(git 不可用: 非 0、spawn、逾時)→ 原錯誤物件原樣 reject(不重新包裝)', async function() {
        let sent = Object.assign(new Error('[preflight] git指令失敗(code[1]): git --version'), { code: 'SENT' })
        let got = null
        await checkGit({ exec: async () => { throw sent } }).catch((e) => { got = e })
        assert.strictEqual(got, sent)
    })

    it('R24.2 離開碼 0 但輸出不含 git version(函式遮蔽、空輸出)→ throw [preflight] git指令失敗(輸出不含[git version]), 含守望字樣', async function() {
        for (let c of ['', '\n', 'something else\n', 'GIT VERSION 2\n', null, undefined]) {
            let got = null
            await checkGit({ exec: async () => c }).catch((e) => { got = e })
            assert.ok(got instanceof Error, JSON.stringify(c))
            assert.ok(/^\[preflight\] git指令失敗\(輸出不含\[git version\]\): git --version/.test(got.message), got.message)
            assert.ok(reFatal.test(got.message))
        }
    })

})


describe('checkGit 起跑預檢(R24; 真 ectScripts + 真 PowerShell + 墊片 git.cmd)', function() {

    let pathOri = null //含 PowerShell 之原 PATH(墊片目錄接於其前)
    let pathSaved0 = null //進入本組前之 PATH(全域環境下不含 PowerShell), after 還原
    let exitOri = null
    let verOri = null
    let gitDirOri = null

    before(function() {
        fs.rmSync(fdTmp, { recursive: true, force: true })
        mkFixturePkg(fdPkg)
        fs.mkdirSync(fdShim, { recursive: true })
        //墊片: GIT_SHIM_VER 非空則印 `git version <值>`(模擬 git --version), 否則印不含該字樣之輸出; 最後以 %GIT_SHIM_EXIT% 結束
        fs.writeFileSync(path.join(fdShim, 'git.cmd'), '@echo off\r\nif defined GIT_SHIM_VER (echo git version %GIT_SHIM_VER%) else (echo shim-git called: %*)\r\nif "%GIT_SHIM_EXIT%"=="128" echo fatal: simulated 1>&2\r\nexit /b %GIT_SHIM_EXIT%\r\n', 'utf8')
        pathSaved0 = process.env.PATH
        pathOri = getRealPath()
        exitOri = process.env.GIT_SHIM_EXIT
        verOri = process.env.GIT_SHIM_VER
        gitDirOri = process.env.GIT_DIR
        process.env.PATH = `${fdShim};${pathOri}`
        process.env.GIT_DIR = path.join(fdTmp, 'no-such-git-dir') //雙重保險: 即使墊片未被解析, 真 git 也只會 fatal 而不碰任何倉庫
    })

    after(function() {
        process.env.PATH = pathSaved0
        for (let [k, v] of [['GIT_SHIM_EXIT', exitOri], ['GIT_SHIM_VER', verOri], ['GIT_DIR', gitDirOri]]) {
            if (v === undefined) {
                delete process.env[k]
            }
            else {
                process.env[k] = v
            }
        }
        fs.rmSync(fdTmp, { recursive: true, force: true })
        cleanTmpRoot()
    })

    let run = (exit, ver) => {
        process.env.GIT_SHIM_EXIT = String(exit)
        if (ver === '') {
            delete process.env.GIT_SHIM_VER
        }
        else {
            process.env.GIT_SHIM_VER = ver
        }
        return quiet(() => checkGit({ path: fdPkg, timeoutMs: 60000, exec: ectReal }))
    }

    it('墊片 exit 0 且輸出 git version → 通過(經真 PowerShell 與正式組法解析到墊片)', async function() {
        let c = await run(0, '9.9.9.shim')
        assert.ok(c.indexOf('git version 9.9.9.shim') >= 0, c)
    })

    it('墊片 exit 1(git --version 失敗)→ throw [preflight] git指令失敗(code[1]): git --version(子命令 unknown → 任何非 0 失敗)', async function() {
        await assert.rejects(run(1, '9.9.9.shim'), (err) => /^\[preflight\] git指令失敗\(code\[1\]\): git --version/.test(err.message) && reFatal.test(err.message))
    })

    it('墊片 exit 128 → throw git指令失敗(code[128])', async function() {
        await assert.rejects(run(128, '9.9.9.shim'), /^Error: \[preflight\] git指令失敗\(code\[128\]\): git --version/)
    })

    it('墊片 exit 0 但輸出不含 git version → throw 輸出不含[git version]', async function() {
        await assert.rejects(run(0, ''), (err) => /git指令失敗\(輸出不含\[git version\]\)/.test(err.message) && err.message.indexOf('shim-git called') >= 0)
    })

    it('git 不在 PATH(PATH 縮為 PowerShell 所在目錄與 System32)→ PowerShell 找不到指令 exit 1 → throw git指令失敗(code[1]) (C2: 起跑即擋下, 不到各列才留痕)', async function() {
        let psDir = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0')
        let sys32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32')
        if (!fs.existsSync(path.join(psDir, 'powershell.exe'))) {
            this.skip()
        }
        let pathSaved = process.env.PATH
        process.env.PATH = `${psDir};${sys32}`
        try {
            await assert.rejects(run(0, '9.9.9.shim'), (err) => /^\[preflight\] git指令失敗\(code\[1\]\): git --version/.test(err.message))
        }
        finally {
            process.env.PATH = pathSaved
        }
    })

    it('PATH 無 PowerShell(程序無法啟動)→ throw git指令失敗(spawn[ENOENT] …) (C2 spawn 判失敗)', async function() {
        let pathSaved = process.env.PATH
        process.env.PATH = pathSaved.split(';').filter((s) => s && !fs.existsSync(path.join(s, 'powershell.exe'))).join(';')
        try {
            await assert.rejects(run(0, '9.9.9.shim'), (err) => /^\[preflight\] git指令失敗\(spawn\[ENOENT\] spawn powershell ENOENT\): git --version/.test(err.message))
        }
        finally {
            process.env.PATH = pathSaved
        }
    })

})
