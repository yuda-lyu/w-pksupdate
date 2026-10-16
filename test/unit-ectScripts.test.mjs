//ectScripts 之純函式單元測試: 組法、輸出累積、失敗摘要、未判定列之留痕、判定(全部判定格)
//對應需求: R01 組法、R02 node 列、R03 npm 列、R04 判定文字各串流原樣串接、R05 無 main 不判定; 帳本(CLAUDE_rulebook.md 1.3) R12 失敗摘要、R13 未判定列之留痕、R6 git 列依子命令判定(≥128、spawn、push 任何非 0、commit 良性片語)
import assert from 'assert'
import ectScripts, { composeCommand, createOutputCollector, getExecDetail, getUnjudgedMessage, judgeResult, detectPrintedFailure, getTimeoutMs, isTimeoutMessage, DEFAULT_TIMEOUT_MS, TIMEOUT_GRACE_MS, PRINTED_FAIL_STRINGS, GIT_FATAL_EXIT_CODE, RE_GIT_NO_CHANGE, GIT_LENIENT_SUBS, getGitSubcommand } from '../src/ectScripts.mjs'
import { getGitSubcommand as getGitSubcommandOwner, GIT_LENIENT_SUBS as GIT_LENIENT_SUBS_OWNER } from '../src/gitSubcommand.mjs'
import { isReadonlyGitCmd } from '../src/runScript.mjs'
import { reFatal } from './tools/fatalWords.mjs'


let GUARD = 'if ((Test-Path -LiteralPath variable:\\LASTEXITCODE)) { exit $LASTEXITCODE }'


describe('ectScripts composeCommand(R01 組法)', function() {

    it('開頭為 $ErrorActionPreference = \'Stop\', 接 Set-Location -LiteralPath 單引號路徑, 結尾為 Test-Path 守衛傳離開碼', function() {
        let s = composeCommand('C:\\opensrc\\開源-JS-001-1-x/x', 'node toolg/a.mjs')
        assert.strictEqual(s, `$ErrorActionPreference = 'Stop' ; Set-Location -LiteralPath 'C:\\opensrc\\開源-JS-001-1-x/x' ; node toolg/a.mjs ; ${GUARD}`)
    })

    it('指令陣列依序以 " ; " 串接', function() {
        let s = composeCommand('C:\\p', ['git add .  -A', `git commit -m 'modify: x'`, 'git push origin master:master'])
        assert.strictEqual(s, `$ErrorActionPreference = 'Stop' ; Set-Location -LiteralPath 'C:\\p' ; git add .  -A ; git commit -m 'modify: x' ; git push origin master:master ; ${GUARD}`)
    })

    it('路徑之單引號以兩個單引號跳脫; $ 與 [ ] 原樣置於單引號內(不展開、不做萬用字元)', function() {
        let s = composeCommand(`C:\\a'b$c[1]`, 'node x.mjs')
        assert.ok(s.indexOf(`Set-Location -LiteralPath 'C:\\a''b$c[1]'`) >= 0, s)
    })

    it('外審 opus F4 R6: 組法不得在 PowerShell 內重導或管線化原生程式之輸出(2>、*>、>&、|、Out-Host、Tee-Object), 否則 Windows PowerShell 5.1 會把 stderr 包成 NativeCommandError 而使真 git 的 fatal 128 被壓成 1', function() {
        let s = composeCommand('C:\\x', ['git push origin master:master', 'git commit -m x'])
        for (let re of [/2>/, /\*>/, />&/, /\|/, /Out-Host/i, /Tee-Object/i, /Out-String/i, /2>&1/]) {
            assert.ok(!re.test(s), `${re}: ${s}`)
        }
    })

    it('不得出現未經 Test-Path 守衛之裸 exit $LASTEXITCODE(找不到指令時會以 0 結束而遮蔽失敗)', function() {
        let s = composeCommand('C:\\p', 'node x.mjs')
        let n = s.split('exit $LASTEXITCODE').length - 1
        let g = s.split(GUARD).length - 1
        assert.strictEqual(n, 1)
        assert.strictEqual(g, 1)
    })

})


describe('ectScripts createOutputCollector(R04 判定文字各串流原樣串接)', function() {

    it('判定字樣被切成兩塊送入 stdout 回呼, 判定用文字仍完整含該字樣', function() {
        let col = createOutputCollector()
        col.onStdout('x'.repeat(10) + 'Error [Rollup')
        col.onStdout('Error]: split')
        assert.ok(col.getOut().indexOf('[RollupError]') >= 0)
        assert.strictEqual(judgeResult({ main: 'node', errExec: null, out: col.getOut(), err: col.getErr() }).label, 'rollup編譯失敗')
    })

    it('stdout 之兩塊中間插入 stderr 之塊, 判定用 stdout 仍完整含字樣', function() {
        let col = createOutputCollector()
        col.onStdout('npm err')
        col.onStderr('warning: something')
        col.onStdout('or code E403')
        assert.ok(col.getOut().indexOf('npm error') >= 0)
        assert.strictEqual(col.getErr(), 'warning: something')
    })

    it('判定字樣被切成兩塊送入 stderr 回呼亦同', function() {
        let col = createOutputCollector()
        col.onStderr('npm er')
        col.onStderr('ror Missing script')
        assert.strictEqual(judgeResult({ main: 'npm', errExec: null, out: col.getOut(), err: col.getErr() }).failed, true)
    })

    it('顯示用文字維持既有格式: 兩串流依到達順序合併, 每塊後補換行', function() {
        let col = createOutputCollector()
        col.onStdout('a')
        col.onStderr('b')
        col.onStdout('c')
        assert.strictEqual(col.getDisplay(), 'a\nb\nc\n')
    })

})


describe('ectScripts getExecDetail(帳本 R12 失敗摘要; 輸入為 wsemi 1.9.15 實際之拒絕值形態)', function() {

    it('離開碼字串取首行並去掉結尾冒號(R12: code[N]、timeout[Nms] 只取首行)', function() {
        assert.strictEqual(getExecDetail('code[3]:\nabc'), 'code[3]')
        assert.strictEqual(getExecDetail('code[13]:\n'), 'code[13]')
        assert.strictEqual(getExecDetail('timeout[1000ms]:\nx'), 'timeout[1000ms]')
    })

    it('訊號結束之 code[null] 取首行(R12)', function() {
        assert.strictEqual(getExecDetail('code[null]:\n'), 'code[null]')
    })

    it('程序無法啟動(非同步 error 事件)接上第二行之 node 錯誤說明, 看得出是哪個程式(R12; 實測 PATH 無 PowerShell 之拒絕值)', function() {
        assert.strictEqual(getExecDetail('spawn[ENOENT]:\nspawn powershell ENOENT'), 'spawn[ENOENT] spawn powershell ENOENT')
    })

    it('程序無法啟動(同步拋錯)亦接上第二行(R12; 實測指令過長之拒絕值)', function() {
        assert.strictEqual(getExecDetail('spawn[ENAMETOOLONG]:\nspawn ENAMETOOLONG'), 'spawn[ENAMETOOLONG] spawn ENAMETOOLONG')
    })

    it('程序無法啟動(node 參數檢查)接上說明, 說明不含參數值(R12; 實測指令含空字元之拒絕值)', function() {
        let s = getExecDetail(`spawn[ERR_INVALID_ARG_VALUE]:\nThe argument 'args[1]' must be a string without null bytes`)
        assert.strictEqual(s, `spawn[ERR_INVALID_ARG_VALUE] The argument 'args[1]' must be a string without null bytes`)
    })

    it('程序無法啟動但說明空白時只回首行(R12: 第二行非空才接)', function() {
        assert.strictEqual(getExecDetail('spawn[ENOENT]:\n'), 'spawn[ENOENT]')
        assert.strictEqual(getExecDetail('spawn[ENOENT]:'), 'spawn[ENOENT]')
    })

    it('程序無法啟動之說明多行時只接第二行(R12)', function() {
        assert.strictEqual(getExecDetail('spawn[EMFILE]:\nspawn powershell EMFILE\nX'), 'spawn[EMFILE] spawn powershell EMFILE')
    })

    it('無標頭之字串取首行(R12; 如 args 型別不符之說明字串)', function() {
        assert.strictEqual(getExecDetail('args is not an array or string'), 'args is not an array or string')
    })

    it('非字串之拒絕值(wsemi 1.9.15 之前之 Error 物件)取 String 首行(R12; 相容)', function() {
        assert.strictEqual(getExecDetail(new Error('spawn powershell ENOENT')), 'Error: spawn powershell ENOENT')
    })

    it('null 與 undefined 回傳空字串(R12)', function() {
        assert.strictEqual(getExecDetail(null), '')
        assert.strictEqual(getExecDetail(undefined), '')
    })

})


describe('ectScripts getUnjudgedMessage(帳本 R13 未判定列之留痕)', function() {

    it('離開碼非 0 → [套件] 未判定(code[N]): 指令', function() {
        let s = getUnjudgedMessage({ name: 'w-gis', errExec: 'code[1]:\nERROR: Unable to find the source file', scps: './node_modules/.bin/jsdoc -c .jsdoc' })
        assert.strictEqual(s, '[w-gis] 未判定(code[1]): ./node_modules/.bin/jsdoc -c .jsdoc')
    })

    it('程序無法啟動 → 摘要依 R12 接上說明', function() {
        let s = getUnjudgedMessage({ name: 'w-x', errExec: 'spawn[ENOENT]:\nspawn powershell ENOENT', scps: 'git add .  -A' })
        assert.strictEqual(s, '[w-x] 未判定(spawn[ENOENT] spawn powershell ENOENT): git add .  -A')
    })

    it('指令陣列以 " ; " 串接(與 throw 訊息相同; g_checkAndCommit 三列一次送)', function() {
        let s = getUnjudgedMessage({ name: 'w-x', errExec: 'code[1]:\n', scps: ['git add .  -A', `git commit -m 'modify: readme'`, 'git push origin master:master'] })
        assert.strictEqual(s, `[w-x] 未判定(code[1]): git add .  -A ; git commit -m 'modify: readme' ; git push origin master:master`)
    })

    it('外審 sol F3: 指令與摘要為外來文字, 含致命字樣時整行經中和後不再命中守望器(commit 訊息談到 git指令失敗、npm指令失敗等), 去零寬字元後與原文相同', function() {
        let cmds = [
            `git commit -m '修正 git指令失敗 的判讀'`,
            `git commit -m 'npm指令失敗 node指令失敗 rollup編譯失敗 建置產物遭刪除 npm上找不到 非預期指令 rm指令失敗 Vue packages version mismatch 指令逾時 建置主檔異常 版本未遞增 script.txt缺少必要列 script.txt列序不符'`,
        ]
        for (let cmd of cmds) {
            let msg = getUnjudgedMessage({ name: 'w-x', errExec: 'code[1]:\nnothing to commit', scps: [cmd] })
            assert.ok(!reFatal.test(msg), msg)
            assert.strictEqual(msg.replace(/​/g, ''), `[w-x] 未判定(code[1]): ${cmd}`)
        }
        let msgName = getUnjudgedMessage({ name: 'w-x', errExec: 'spawn[ENOENT]:\nspawn git指令失敗 ENOENT', scps: ['git status'] })
        assert.ok(!reFatal.test(msgName), msgName)
    })

    it('無拒絕值(成功)時回傳空字串, 不留痕', function() {
        assert.strictEqual(getUnjudgedMessage({ name: 'w-x', errExec: null, scps: 'git push origin master:master' }), '')
        assert.strictEqual(getUnjudgedMessage({ name: 'w-x', scps: 'git push origin master:master' }), '')
        assert.strictEqual(getUnjudgedMessage(), '')
    })

    it('全庫實際之未判定列 × 各拒絕值形態: 皆留痕且不含守望器致命字樣(避免良性 exit 1 被誤當中止)', function() {
        let cmds = ['./node_modules/.bin/jsdoc -c .jsdoc', './node_modules/.bin/pkg .', 'git add .  -A', `git commit -m 'modify: update pks'`, 'git push origin master:master']
        let errs = ['code[1]:\nERROR: x', 'code[128]:\nfatal: x', 'spawn[ENOENT]:\nspawn powershell ENOENT', 'spawn[EMFILE]:\nspawn powershell EMFILE', 'spawn[ENAMETOOLONG]:\nspawn ENAMETOOLONG']
        for (let v of cmds) {
            for (let e of errs) {
                let s = getUnjudgedMessage({ name: 'w-pubsub', errExec: e, scps: v })
                assert.ok(s.indexOf('[w-pubsub] 未判定(') === 0 && s.endsWith(`): ${v}`), s)
                assert.strictEqual(reFatal.test(s), false, s)
            }
        }
    })

})


describe('ectScripts judgeResult(R02 node 列、R03 npm 列、R05 無 main 不判定; 全部判定格)', function() {

    //結果形態: errExec 為 execProcess 之 reject 值(成功為 null; wsemi 1.9.15 起皆為字串), out/err 為各串流原樣串接
    let outcomes = {
        O01_成功: { errExec: null, out: 'ok', err: '' },
        O02_成功且stderr有警告: { errExec: null, out: 'built ok', err: 'Browserslist: browsers data (caniuse-lite) is 6 months old.\n(!) Plugin node-resolve' },
        O03_離開碼1: { errExec: 'code[1]:\nError: boom', out: '', err: 'Error: boom' },
        O04_離開碼3: { errExec: 'code[3]:\n', out: '', err: '' },
        O05_離開碼13: { errExec: 'code[13]:\nWarning: Detected unsettled top-level await', out: '', err: 'Warning: Detected unsettled top-level await' },
        O06_程序無法啟動: { errExec: 'spawn[ENOENT]:\nspawn powershell ENOENT', out: '', err: '' },
        O07_逾時: { errExec: 'timeout[1000ms]:\n', out: '', err: '' },
        O08_stdout含RollupError且exit0: { errExec: null, out: 'Error [RollupError]: "default" is not exported', err: '' },
        O09_stderr含RollupError且exit0: { errExec: null, out: '', err: 'Error [RollupError]: x' },
        O10_含RollupError且離開碼1: { errExec: 'code[1]:\nError [RollupError]: x', out: '', err: 'Error [RollupError]: x' },
        O11_stdout含npmerror且exit0: { errExec: null, out: 'npm error code E403', err: '' },
        O12_stderr含npmerror且exit0: { errExec: null, out: '', err: 'npm error Missing script: "x"' },
        O13_含npmerror且離開碼1: { errExec: 'code[1]:\nnpm error code ETARGET', out: '', err: 'npm error code ETARGET' },
        O14_只有npmwarn: { errExec: null, out: '', err: 'npm warn deprecated x@1.0.0' },
        O15_程序無法啟動同步拋錯: { errExec: 'spawn[ENAMETOOLONG]:\nspawn ENAMETOOLONG', out: '', err: '' },
        O16_訊號結束: { errExec: 'code[null]:\n', out: '', err: '' },
        O17_舊版wsemi之Error物件: { errExec: new Error('spawn powershell ENOENT'), out: '', err: '' },
        //以下 O18-O30 為帳本 R15(2026-10-16): 離開碼 0 時之輸出特徵; 堆疊框取自 Node 實際輸出之樣式
        O18_stdout含堆疊框且exit0: { errExec: null, out: 'Error: boom-caught\n    at core (file:///C:/pkg/toolg/gDistRollup.mjs:6:8)\n    at ModuleJob.run (node:internal/modules/esm/module_job:439:25)\n', err: '' },
        O19_stderr含堆疊框且exit0: { errExec: null, out: '', err: 'Error: ENOENT: no such file or directory, open \'x.json\'\n    at Object.readFileSync (node:fs:484:20)\n    at async node:internal/modules/run_main:101:5\n' },
        O20_含can_not_clean_folder且exit0: { errExec: null, out: 'can not clean folder[./dist]: EPERM, Permission denied', err: '' },
        O21_含invalid_fpSrc且exit0: { errExec: null, out: 'invalid fpSrc: C:\\x\\nofile.mjs', err: '' },
        O22_含invalid_opt_fdSrc且exit0: { errExec: null, out: 'invalid opt.fdSrc[./nodir]: not a folder', err: '' },
        O23_含invalid_opt_fdTar且exit0: { errExec: null, out: 'invalid opt.fdTar[./d]: not a folder and can not be created', err: '' },
        O24_ANSI色碼包住之堆疊框且exit0: { errExec: null, out: '\u001b[31m    at core (file:///C:/a.mjs:6:8)\u001b[39m\n', err: '' },
        O25_堆疊框被拆在stdout與stderr且exit0: { errExec: null, out: '    at core (file:///C:/a.mjs:6', err: ':8)\n' },
        O26_DeprecationWarning且exit0: { errExec: null, out: 'built', err: '(node:1234) [DEP0040] DeprecationWarning: The `punycode` module is deprecated.\n(Use `node --trace-deprecation ...` to show where the warning was created)\n' },
        O27_WPT_DYNAMIC_REQUIRE_GUARDED警告且exit0: { errExec: null, out: '(!) [w-package-tools] require() with a non-literal argument inside try is replaced by a stub (WPT_DYNAMIC_REQUIRE_GUARDED), in module(s): lib.js\n', err: '' },
        O28_縮排的at開頭時間戳行且exit0: { errExec: null, out: 'summary:\n    at the end of the build 12:30:45\n    at 12:30:45\n', err: '' },
        O29_含堆疊框且含RollupError且exit0: { errExec: null, out: 'Error [RollupError]: x\n    at error (file:///C:/a/b.js:1:2)\n', err: '' },
        O30_含堆疊框且離開碼1: { errExec: 'code[1]:\nError: boom', out: 'Error: boom\n    at core (file:///C:/a.mjs:6:8)\n', err: '' },
    }

    //應然: [failed, label, detail]
    let expects = {
        node: {
            O01_成功: [false, '', ''],
            O02_成功且stderr有警告: [false, '', ''],
            O03_離開碼1: [true, 'node指令失敗', 'code[1]'],
            O04_離開碼3: [true, 'node指令失敗', 'code[3]'],
            O05_離開碼13: [true, 'node指令失敗', 'code[13]'],
            O06_程序無法啟動: [true, 'node指令失敗', 'spawn[ENOENT] spawn powershell ENOENT'], //R12: 接上說明
            O07_逾時: [true, 'node指令失敗', 'timeout[1000ms]'],
            O08_stdout含RollupError且exit0: [true, 'rollup編譯失敗', ''],
            O09_stderr含RollupError且exit0: [true, 'rollup編譯失敗', ''],
            O10_含RollupError且離開碼1: [true, 'rollup編譯失敗', ''], //字樣優先, 沿用既有訊息
            O11_stdout含npmerror且exit0: [false, '', ''], //node 列不比對 npm error
            O12_stderr含npmerror且exit0: [false, '', ''],
            O13_含npmerror且離開碼1: [true, 'node指令失敗', 'code[1]'],
            O14_只有npmwarn: [false, '', ''],
            O15_程序無法啟動同步拋錯: [true, 'node指令失敗', 'spawn[ENAMETOOLONG] spawn ENAMETOOLONG'],
            O16_訊號結束: [true, 'node指令失敗', 'code[null]'],
            O17_舊版wsemi之Error物件: [true, 'node指令失敗', 'Error: spawn powershell ENOENT'], //非字串取 String 首行(相容)
            O18_stdout含堆疊框且exit0: [true, 'node指令失敗', 'exit 0 但輸出含錯誤堆疊'], //R15.1
            O19_stderr含堆疊框且exit0: [true, 'node指令失敗', 'exit 0 但輸出含錯誤堆疊'], //R15.1(兩串流皆比對)
            O20_含can_not_clean_folder且exit0: [true, 'node指令失敗', 'exit 0 但輸出含[can not clean folder[]'], //R15.2
            O21_含invalid_fpSrc且exit0: [true, 'node指令失敗', 'exit 0 但輸出含[invalid fpSrc]'], //R15.2
            O22_含invalid_opt_fdSrc且exit0: [true, 'node指令失敗', 'exit 0 但輸出含[invalid opt.fdSrc[]'], //R15.2
            O23_含invalid_opt_fdTar且exit0: [true, 'node指令失敗', 'exit 0 但輸出含[invalid opt.fdTar[]'], //R15.2
            O24_ANSI色碼包住之堆疊框且exit0: [true, 'node指令失敗', 'exit 0 但輸出含錯誤堆疊'], //R15.1 去 ANSI
            O25_堆疊框被拆在stdout與stderr且exit0: [false, '', ''], //R15.1 兩串流各自比對, 不拼接
            O26_DeprecationWarning且exit0: [false, '', ''], //R15.5 良性
            O27_WPT_DYNAMIC_REQUIRE_GUARDED警告且exit0: [false, '', ''], //R15.5 不得以 WPT_DYNAMIC_REQUIRE 子字串判定
            O28_縮排的at開頭時間戳行且exit0: [false, '', ''], //R15.1 位置須像路徑或網址, 時間戳不算
            O29_含堆疊框且含RollupError且exit0: [true, 'rollup編譯失敗', ''], //R15.3 優先序
            O30_含堆疊框且離開碼1: [true, 'node指令失敗', 'code[1]'], //R15.3 優先序
        },
        npm: {
            O01_成功: [false, '', ''],
            O02_成功且stderr有警告: [false, '', ''],
            O03_離開碼1: [true, 'npm指令失敗', 'code[1]'],
            O04_離開碼3: [true, 'npm指令失敗', 'code[3]'],
            O05_離開碼13: [true, 'npm指令失敗', 'code[13]'],
            O06_程序無法啟動: [true, 'npm指令失敗', 'spawn[ENOENT] spawn powershell ENOENT'], //R12: 接上說明
            O07_逾時: [true, 'npm指令失敗', 'timeout[1000ms]'],
            O08_stdout含RollupError且exit0: [false, '', ''], //npm 列不比對 [RollupError]
            O09_stderr含RollupError且exit0: [false, '', ''],
            O10_含RollupError且離開碼1: [true, 'npm指令失敗', 'code[1]'],
            O11_stdout含npmerror且exit0: [true, 'npm指令失敗', ''],
            O12_stderr含npmerror且exit0: [true, 'npm指令失敗', ''],
            O13_含npmerror且離開碼1: [true, 'npm指令失敗', ''], //字樣優先, 沿用既有訊息
            O14_只有npmwarn: [false, '', ''],
            O15_程序無法啟動同步拋錯: [true, 'npm指令失敗', 'spawn[ENAMETOOLONG] spawn ENAMETOOLONG'],
            O16_訊號結束: [true, 'npm指令失敗', 'code[null]'],
            O17_舊版wsemi之Error物件: [true, 'npm指令失敗', 'Error: spawn powershell ENOENT'],
            //R15.4: npm 列不套用輸出特徵(O18-O28 一律通過); O29 的 RollupError 字樣、O30 的離開碼依既有 npm 規則
            O18_stdout含堆疊框且exit0: [false, '', ''],
            O19_stderr含堆疊框且exit0: [false, '', ''],
            O20_含can_not_clean_folder且exit0: [false, '', ''],
            O21_含invalid_fpSrc且exit0: [false, '', ''],
            O22_含invalid_opt_fdSrc且exit0: [false, '', ''],
            O23_含invalid_opt_fdTar且exit0: [false, '', ''],
            O24_ANSI色碼包住之堆疊框且exit0: [false, '', ''],
            O25_堆疊框被拆在stdout與stderr且exit0: [false, '', ''],
            O26_DeprecationWarning且exit0: [false, '', ''],
            O27_WPT_DYNAMIC_REQUIRE_GUARDED警告且exit0: [false, '', ''],
            O28_縮排的at開頭時間戳行且exit0: [false, '', ''],
            O29_含堆疊框且含RollupError且exit0: [false, '', ''],
            O30_含堆疊框且離開碼1: [true, 'npm指令失敗', 'code[1]'],
        },
    }

    for (let [oname, o] of Object.entries(outcomes)) {
        for (let main of ['node', 'npm']) {
            let [failed, label, detail] = expects[main][oname]
            it(`main=${main} × ${oname} → ${failed ? `${label}(${detail})` : '通過'}`, function() {
                let r = judgeResult({ main, ...o })
                assert.deepStrictEqual(r, { failed, label, detail })
            })
        }
        //R18.2(2026-10-16; 原載『未給 main 之列一律不判定』對逾時不成立): 逾時是唯一對未判定列(git、.bin、g_checkAndCommit)也判失敗的形態
        let expectUnjudged = oname === 'O07_逾時' ? { failed: true, label: '指令逾時', detail: 'timeout[1000ms]' } : { failed: false, label: '', detail: '' }
        it(`main=未給(git、.bin 列) × ${oname} → ${expectUnjudged.failed ? `${expectUnjudged.label}(${expectUnjudged.detail})` : '通過(不判定)'}`, function() {
            let r = judgeResult({ ...o })
            assert.deepStrictEqual(r, expectUnjudged)
        })
        //R6.2(2026-10-17): main='git' 且未給 gitSub(泛用): 僅離開碼 ≥128 與 spawn[…](C2)判失敗; O01–O30 無 ≥128 之離開碼(最大 code[13]), 故除 spawn 類(O06、O15)外與未給 main 同為『通過, 逾時除外』
        let expectGit = expectUnjudged
        if (oname === 'O06_程序無法啟動' || oname === 'O15_程序無法啟動同步拋錯') {
            expectGit = { failed: true, label: 'git指令失敗', detail: expects.node[oname][2] }
        }
        it(`main=git(泛用) × ${oname} → ${expectGit.failed ? `${expectGit.label}(${expectGit.detail})` : '通過(不判定)'}`, function() {
            let r = judgeResult({ main: 'git', ...o })
            assert.deepStrictEqual(r, expectGit)
        })
    }

    it('未給任何參數 → 通過', function() {
        assert.deepStrictEqual(judgeResult(), { failed: false, label: '', detail: '' })
    })

})


describe('ectScripts getGitSubcommand(R6.1 子命令辨識; 純函式)', function() {

    it('單一 git 指令: push、commit、add、status 等取第一個非選項記號並轉小寫', function() {
        for (let [v, sub] of [
            ['git push', 'push'], ['git push origin master:master', 'push'], ['git PUSH origin', 'push'], ['git Commit -m x', 'commit'],
            [`git commit -m 'modify: update pks'`, 'commit'], ['git add .  -A', 'add'], ['git status', 'status'], ['git log --oneline', 'log'], ['git tag v1', 'tag'],
        ]) {
            assert.strictEqual(getGitSubcommand(v), sub, v)
        }
    })

    it('略過全域選項(含值、含引號之值): -C <v>、-c <k=v>、--git-dir[=]<v>、--work-tree[=]<v>、--namespace、--no-pager、-P、--no-optional-locks', function() {
        for (let [v, sub] of [
            ['git -C . push', 'push'], ['git -C "a b" push', 'push'], [`git -C 'a b' commit -m x`, 'commit'], ['git -c user.name=x commit -m y', 'commit'], ['git -c "user.name=a b" push', 'push'],
            ['git --git-dir=.git --work-tree=. add -A', 'add'], ['git --git-dir .git --work-tree . push', 'push'], ['git --no-pager -P --no-optional-locks log', 'log'], ['git --namespace ns push', 'push'],
            ['git -C "C:/開源 x/y" -c core.quotepath=false --no-pager push origin', 'push'], ['git --exec-path=/x push', 'push'],
            ['git --attr-source HEAD push origin', 'push'], ['git --attr-source=HEAD commit -m x', 'commit'], ['git --config-env=user.name=NAME push', 'push'],
        ]) {
            assert.strictEqual(getGitSubcommand(v), sub, v)
        }
    })

    it('外審 opus F1: 未加引號的含空白路徑、變數展開、錯字等無法正確辨識者, 回傳的記號不屬良性白名單(下游 judgeResult 因而嚴格)', function() {
        for (let v of ['git -C C:/a b push origin', 'git $env:SUB origin master', 'git pusj origin', 'git psuh origin']) {
            let sub = getGitSubcommand(v)
            assert.ok(sub === 'unknown' || !GIT_LENIENT_SUBS.has(sub), `${v} → ${sub}`)
            assert.notStrictEqual(sub, 'add')
        }
        assert.strictEqual(getGitSubcommand('git pusj origin'), 'pusj')
        assert.strictEqual(getGitSubcommand('git -C C:/a b push origin'), 'b') //未加引號之空白路徑: 'b' 被當子命令, 不在白名單 → 嚴格(寧嚴勿鬆)
    })

    it('無法辨識 → unknown: 無子命令(git --version、git、只有全域選項)、首記號非 git、陣列多於一列、非字串、空字串', function() {
        for (let v of ['git --version', 'git', 'git -C .', 'git --no-pager', 'git -C', 'node a.mjs', 'npm publish', '', '   ', null, undefined, 123, ['git push', 'git commit'], []]) {
            assert.strictEqual(getGitSubcommand(v), 'unknown', JSON.stringify(v))
        }
    })

    it('陣列僅一個元素時取該元素(ectScripts 的 scps 可為陣列)', function() {
        assert.strictEqual(getGitSubcommand(['git push origin master:master']), 'push')
        assert.strictEqual(getGitSubcommand([`git commit -m 'x'`]), 'commit')
    })

    it('未封閉的引號不拋錯, 以剩餘字元為記號(仍可辨識子命令或回 unknown)', function() {
        assert.strictEqual(getGitSubcommand(`git commit -m 'abc`), 'commit')
        assert.strictEqual(getGitSubcommand(`git -C 'a b`), 'unknown')
    })

})


describe('ectScripts judgeResult × git 列(R6.2 子命令 × 結果形態; push/unknown 嚴格、commit 良性片語、add 及其他 ≥128 與 spawn)', function() {

    let pass = { failed: false, label: '', detail: '' }
    let fail = (detail) => ({ failed: true, label: 'git指令失敗', detail })
    let SPAWN = 'spawn[ENOENT]:\nspawn powershell ENOENT'
    let SPAWN_D = 'spawn[ENOENT] spawn powershell ENOENT'
    let fatalOut = 'fatal: Unable to create \'C:/pkg/.git/index.lock\': File exists.'

    //結果形態: [errExec, out, err]
    let outcomes = {
        ok: [null, 'ok', ''],
        c1_push被拒: ['code[1]:\n! [rejected] master -> master (non-fast-forward)', '', '! [rejected] master -> master (non-fast-forward)\nerror: failed to push some refs'],
        c1_無變更_stdout: ['code[1]:\nOn branch master\nnothing to commit, working tree clean', 'On branch master\nnothing to commit, working tree clean\n', ''],
        c1_未追蹤: ['code[1]:\n', 'nothing added to commit but untracked files present (use "git add" to track)\n', ''],
        c1_未暫存: ['code[1]:\n', 'no changes added to commit (use "git add" and/or "git commit -a")\n', ''],
        c1_無變更_stderr: ['code[1]:\n', '', 'nothing to commit, working tree clean\n'],
        c1_hook失敗: ['code[1]:\nhusky - pre-commit hook exited with code 1 (error)', 'husky - pre-commit hook exited with code 1 (error)\n', ''],
        c1_無輸出: ['code[1]:\n', '', ''],
        c2_含片語: ['code[2]:\nnothing to commit', 'nothing to commit\n', ''],
        c2: ['code[2]:\n', '', ''],
        c127: ['code[127]:\n', '', ''],
        c128: [`code[128]:\n${fatalOut}`, '', fatalOut],
        c255: ['code[255]:\n', '', ''],
        cnull: ['code[null]:\n', '', ''],
        spawn: [SPAWN, '', ''],
        errObj: [new Error('x'), '', ''],
    }

    //應然: 依子命令類別 → 各形態結果
    let expects = {
        //add、status 等其他子命令, 以及未給 gitSub(舊呼叫形): 僅 ≥128 與 spawn 失敗
        generic: {
            ok: pass, c1_push被拒: pass, c1_無變更_stdout: pass, c1_未追蹤: pass, c1_未暫存: pass, c1_無變更_stderr: pass, c1_hook失敗: pass, c1_無輸出: pass,
            c2_含片語: pass, c2: pass, c127: pass, c128: fail('code[128]'), c255: fail('code[255]'), cnull: pass, spawn: fail(SPAWN_D), errObj: pass,
        },
        //push 與 unknown: 任何非 0 失敗
        strict: {
            ok: pass, c1_push被拒: fail('code[1]'), c1_無變更_stdout: fail('code[1]'), c1_未追蹤: fail('code[1]'), c1_未暫存: fail('code[1]'), c1_無變更_stderr: fail('code[1]'), c1_hook失敗: fail('code[1]'), c1_無輸出: fail('code[1]'),
            c2_含片語: fail('code[2]'), c2: fail('code[2]'), c127: fail('code[127]'), c128: fail('code[128]'), c255: fail('code[255]'), cnull: fail('code[null]'), spawn: fail(SPAWN_D), errObj: fail('Error: x'),
        },
        //commit: exit 1 且含 nothing to commit 才良性, 其餘非 0 失敗(R6.2③; D1: nothing added to commit / no changes added to commit 代表前一列 git add 沒暫存到變更, 判失敗)
        commit: {
            ok: pass, c1_push被拒: fail('code[1]'), c1_無變更_stdout: pass, c1_未追蹤: fail('code[1]'), c1_未暫存: fail('code[1]'), c1_無變更_stderr: pass, c1_hook失敗: fail('code[1]'), c1_無輸出: fail('code[1]'),
            c2_含片語: fail('code[2]'), c2: fail('code[2]'), c127: fail('code[127]'), c128: fail('code[128]'), c255: fail('code[255]'), cnull: fail('code[null]'), spawn: fail(SPAWN_D), errObj: fail('Error: x'),
        },
    }
    //良性白名單(外審 opus F1): add 與唯讀子命令為 generic; commit 專屬; 其餘(push、unknown、pull、fetch、tag、merge、錯字 pusj、被誤當子命令之記號 head 等)一律 strict
    let classOf = (sub) => {
        if (sub === undefined || GIT_LENIENT_SUBS.has(sub)) {
            return 'generic'
        }
        return sub === 'commit' ? 'commit' : 'strict'
    }

    it('git 子命令辨識之單一擁有者為 src/gitSubcommand.mjs, ectScripts 再匯出同一物件(既有 import 不變)', function() {
        assert.strictEqual(getGitSubcommand, getGitSubcommandOwner)
        assert.strictEqual(GIT_LENIENT_SUBS, GIT_LENIENT_SUBS_OWNER)
    })

    it('GIT_LENIENT_SUBS 恰為 add 與 12 個唯讀子命令(與 runScript 之 RE_READONLY_GIT 同集合)', function() {
        assert.deepStrictEqual([...GIT_LENIENT_SUBS].sort(), ['add', 'blame', 'cat-file', 'describe', 'diff', 'grep', 'log', 'ls-files', 'rev-list', 'rev-parse', 'shortlog', 'show', 'status'])
        for (let sub of GIT_LENIENT_SUBS) {
            if (sub !== 'add') {
                assert.strictEqual(isReadonlyGitCmd(`git ${sub}`), true, sub) //同一份清單
            }
        }
        assert.strictEqual(isReadonlyGitCmd('git add .'), false)
    })

    for (let gitSub of [undefined, 'add', 'status', 'log', 'show', 'push', 'unknown', 'commit', 'tag', 'pull', 'fetch', 'merge', 'pusj', 'head']) {
        for (let [oname, [errExec, out, err]] of Object.entries(outcomes)) {
            let want = expects[classOf(gitSub)][oname]
            it(`gitSub=${gitSub} × ${oname} → ${want.failed ? `${want.label}(${want.detail})` : '通過'}`, function() {
                assert.deepStrictEqual(judgeResult({ main: 'git', gitSub, errExec, out, err }), want)
            })
        }
    }

    it('GIT_FATAL_EXIT_CODE 為 128; 邊界: 127 對 add 通過、128 失敗; 負數碼與非整數碼不當離開碼(add 通過; push 因非 0 而失敗)', function() {
        assert.strictEqual(GIT_FATAL_EXIT_CODE, 128)
        assert.strictEqual(judgeResult({ main: 'git', gitSub: 'add', errExec: 'code[127]:\n' }).failed, false)
        assert.strictEqual(judgeResult({ main: 'git', gitSub: 'add', errExec: 'code[128]:\n' }).failed, true)
        assert.strictEqual(judgeResult({ main: 'git', gitSub: 'add', errExec: 'code[-1]:\n' }).failed, false)
        assert.strictEqual(judgeResult({ main: 'git', gitSub: 'push', errExec: 'code[-1]:\n' }).failed, true)
    })

    it('Windows 異常終止碼 code[3221225477]、code[4294967295] 對所有子命令皆失敗(≥128)', function() {
        for (let gitSub of [undefined, 'add', 'push', 'commit', 'unknown']) {
            for (let n of [129, 256, 3221225477, 4294967295]) {
                assert.deepStrictEqual(judgeResult({ main: 'git', gitSub, errExec: `code[${n}]:\n` }), fail(`code[${n}]`), `${gitSub} ${n}`)
            }
        }
    })

    it('只認首行之 code[N]/spawn[…]: 輸出(第二行起)含 code[128] 字樣者不算(add 通過); spawn 標頭仍判失敗', function() {
        assert.strictEqual(judgeResult({ main: 'git', gitSub: 'add', errExec: 'code[1]:\nprocess exited with code[128]' }).failed, false)
        assert.deepStrictEqual(judgeResult({ main: 'git', gitSub: 'add', errExec: 'spawn[ENOENT]:\ncode[128]' }), fail('spawn[ENOENT] code[128]'))
    })

    it('D1 commit × code[1]: nothing added to commit / no changes added to commit(前一列 git add 沒暫存到變更)→ 失敗; git 的無變更結論整行(nothing to commit, working tree clean / (create/copy files and use "git add" to track))→ 良性', function() {
        assert.deepStrictEqual(judgeResult({ main: 'git', gitSub: 'commit', errExec: 'code[1]:\n', out: 'nothing added to commit but untracked files present' }), fail('code[1]'))
        assert.deepStrictEqual(judgeResult({ main: 'git', gitSub: 'commit', errExec: 'code[1]:\n', err: 'no changes added to commit (use "git add" and/or "git commit -a")' }), fail('code[1]'))
        assert.deepStrictEqual(judgeResult({ main: 'git', gitSub: 'commit', errExec: 'code[1]:\n', out: 'nothing to commit, working tree clean' }), pass)
        assert.deepStrictEqual(judgeResult({ main: 'git', gitSub: 'commit', errExec: 'code[1]:\n', out: 'On branch master\nnothing to commit, working tree clean\n' }), pass)
        assert.deepStrictEqual(judgeResult({ main: 'git', gitSub: 'commit', errExec: 'code[1]:\n', out: 'On branch master\r\nnothing to commit, working tree clean\r\n' }), pass) //CRLF 輸出
        assert.deepStrictEqual(judgeResult({ main: 'git', gitSub: 'commit', errExec: 'code[1]:\n', out: 'nothing to commit (create/copy files and use "git add" to track)' }), pass)
        assert.deepStrictEqual(judgeResult({ main: 'git', gitSub: 'commit', errExec: 'code[1]:\n', err: 'nothing to commit, working tree clean' }), pass) //stderr 亦同
    })

    //第 5 次外審 opus F11 / sol F11: 原以子字串比對, hook 診斷文字、引述、否定句含該字樣即被判良性而續行 push/publish; 改為整行比對 git 的無變更結論
    it('D1 整行比對: hook 失敗輸出中只是提到 nothing to commit(行中、引述、否定句、前後夾文字)、僅 nothing to commit 無後綴、-u 變體(status.showUntrackedFiles=no)→ 失敗; 兩串流之一有整行即良性', function() {
        let f = (out, err = '') => judgeResult({ main: 'git', gitSub: 'commit', errExec: 'code[1]:\n', out, err })
        for (let bad of [
            'pre-commit: checking the nothing to commit condition\nhusky - pre-commit script failed (code 1)',
            'hook says: nothing to commit, working tree clean (ignored)',
            'error: do not report "nothing to commit, working tree clean" here',
            '  nothing to commit, working tree clean', //行首有空白
            'nothing to commit',
            'nothing to commit (use -u to show untracked files)', //status.showUntrackedFiles=no: git 看不到未追蹤檔, 不能證明 add 沒漏
            'nothing to commit, working tree clean.',
            'Nothing to commit, working tree clean',
            'nothing to commit, working directory clean', //舊版 git 字樣不在允許集合(失敗方向)
        ]) {
            assert.deepStrictEqual(f(bad), fail('code[1]'), bad)
        }
        assert.deepStrictEqual(f('husky - hook failed', 'On branch x\nnothing to commit, working tree clean\n'), pass) //任一串流有 git 的整行結論
        assert.deepStrictEqual(f('nothing to commit, working tree clean  \n'), pass) //行尾空白
    })

    it('D1 RE_GIT_NO_CHANGE 為單一擁有者: 整行錨定(多列模式)、只含兩種 git 無變更結論', function() {
        assert.ok(RE_GIT_NO_CHANGE.multiline)
        assert.ok(RE_GIT_NO_CHANGE.test('x\nnothing to commit, working tree clean'))
        assert.ok(!RE_GIT_NO_CHANGE.test('x nothing to commit, working tree clean'))
    })

    it('commit 良性片語只在 code[1] 才算: code[2]、code[128] 含片語仍失敗; 片語大小寫不符(Nothing to commit)不算(git 輸出為小寫)', function() {
        assert.strictEqual(judgeResult({ main: 'git', gitSub: 'commit', errExec: 'code[2]:\n', out: 'nothing to commit' }).failed, true)
        assert.strictEqual(judgeResult({ main: 'git', gitSub: 'commit', errExec: 'code[128]:\n', out: 'nothing to commit' }).failed, true)
        assert.strictEqual(judgeResult({ main: 'git', gitSub: 'commit', errExec: 'code[1]:\n', out: 'Nothing to commit' }).failed, true)
    })

    it('exit 0 時 git 列不比對輸出: 含 fatal:/code[128]/[RollupError]/npm error/無變更片語字樣皆通過(任何子命令)', function() {
        for (let gitSub of [undefined, 'add', 'push', 'commit', 'unknown']) {
            let r = judgeResult({ main: 'git', gitSub, errExec: null, out: 'fatal: x\nError [RollupError]\nnpm error code E403\nnothing to commit', err: 'code[128]\n! [rejected]' })
            assert.deepStrictEqual(r, pass, String(gitSub))
        }
    })

    it('逾時仍依 R18 判 指令逾時(非 git指令失敗), 對所有子命令', function() {
        for (let gitSub of [undefined, 'add', 'push', 'commit', 'unknown']) {
            assert.deepStrictEqual(judgeResult({ main: 'git', gitSub, errExec: 'timeout[1000ms]:\n' }), { failed: true, label: '指令逾時', detail: 'timeout[1000ms]' }, String(gitSub))
        }
    })

    it('範圍限制: gitSub 只在 main=git 時生效; 未給 main(.bin、g_checkAndCommit)與 main=node/npm 之判定不變', function() {
        assert.deepStrictEqual(judgeResult({ gitSub: 'push', errExec: 'code[1]:\n' }), pass)
        assert.deepStrictEqual(judgeResult({ gitSub: 'push', errExec: 'code[128]:\n' }), pass)
        assert.deepStrictEqual(judgeResult({ main: 'node', gitSub: 'push', errExec: 'code[128]:\n' }), { failed: true, label: 'node指令失敗', detail: 'code[128]' })
        assert.deepStrictEqual(judgeResult({ main: 'npm', gitSub: 'commit', errExec: 'code[1]:\n' }), { failed: true, label: 'npm指令失敗', detail: 'code[1]' })
        assert.deepStrictEqual(judgeResult({ errExec: SPAWN }), pass)
    })

    it('失敗標籤含守望器致命字樣(git指令失敗 在 FATAL_WORDS), 使守望器 grep 命中', function() {
        let r = judgeResult({ main: 'git', gitSub: 'push', errExec: 'code[1]:\n' })
        assert.ok(reFatal.test(`[w-x] ${r.label}(${r.detail}): git push`))
    })

    it('良性留痕訊息(R13)不含致命字樣: commit 無變更 exit 1、add exit 1', function() {
        let msg = getUnjudgedMessage({ name: 'w-x', errExec: 'code[1]:\nnothing to commit', scps: ['git commit -m \'modify: \''] })
        assert.strictEqual(msg, '[w-x] 未判定(code[1]): git commit -m \'modify: \'')
        assert.ok(!reFatal.test(msg))
    })

})


describe('ectScripts × git 列(注入 execProcess; ectScripts 由 scps 求子命令後判定, R6.1)', function() {

    let pdi = { name: 'sbx-git', path: 'C:/sbx' }
    //execProcess 樁: 先把輸出餵給 cbStdout/cbStderr, 再以 errExec reject(null 為成功)
    let mk = (errExec, out = '', err = '') => async (prog, args, o) => {
        if (out !== '') {
            o.cbStdout(out)
        }
        if (err !== '') {
            o.cbStderr(err)
        }
        if (errExec !== null) {
            throw errExec
        }
        return ''
    }
    let run = async (scps, execProcess, opt = {}) => {
        let logOri = console.log
        let logs = []
        console.log = (...args) => {
            logs.push(args.join(' '))
        }
        try {
            await ectScripts(pdi, scps, { main: 'git', execProcess, ...opt })
            return { ok: true, logs }
        }
        catch (e) {
            return { ok: false, err: e, logs }
        }
        finally {
            console.log = logOri
        }
    }

    it('git push origin master:master × code[1](被拒)→ throw git指令失敗(code[1]), 訊息含 git 之輸出', async function() {
        let r = await run('git push origin master:master', mk('code[1]:\nerror: failed to push', '', 'error: failed to push some refs'))
        assert.strictEqual(r.ok, false)
        assert.ok(/^\[sbx-git\] git指令失敗\(code\[1\]\): git push origin master:master\n/.test(r.err.message), r.err.message)
        assert.ok(r.err.message.indexOf('failed to push some refs') >= 0)
    })

    it('git -C . push(帶全域選項)× code[1] → 同樣 throw git指令失敗(code[1]); 陣列單元素 [git push] 亦然(斷言完整首行, 外審 opus F8)', async function() {
        let r1 = await run('git -C . push', mk('code[1]:\n'))
        assert.strictEqual(r1.ok, false)
        assert.ok(/^\[sbx-git\] git指令失敗\(code\[1\]\): git -C \. push\n/.test(r1.err.message), r1.err.message)
        let r2 = await run(['git push'], mk('code[1]:\n'))
        assert.strictEqual(r2.ok, false)
        assert.ok(/^\[sbx-git\] git指令失敗\(code\[1\]\): git push\n/.test(r2.err.message), r2.err.message)
    })

    it('外審 opus F1: 錯字與非白名單子命令(git pusj、git tag、git pull、git fetch)× code[1] → throw git指令失敗(code[1]) (不得因子命令不認得而放行)', async function() {
        for (let cmd of ['git pusj origin master:master', 'git tag v1', 'git pull', 'git fetch origin', 'git merge x']) {
            let r = await run(cmd, mk('code[1]:\n'))
            assert.strictEqual(r.ok, false, cmd)
            assert.ok(new RegExp(`^\\[sbx-git\\] git指令失敗\\(code\\[1\\]\\): ${cmd}\\n`).test(r.err.message), `${cmd}: ${r.err.message}`)
        }
    })

    it('外審 opus F8: push 成功但 stderr 有 To https://…/進度輸出(真 git 的正常形態)→ 通過且不留痕(未判定)', async function() {
        let r = await run('git push origin master:master', mk(null, '', 'To https://github.com/x/y\n   abc..def  master -> master\nremote: GitHub found vulnerabilities'))
        assert.strictEqual(r.ok, true)
        assert.ok(!r.logs.some((x) => x.indexOf('未判定') >= 0))
    })

    it('git commit × code[1] 且 stdout 含 nothing to commit → 通過並留痕 未判定(code[1]); 無該片語 → throw', async function() {
        let r1 = await run(`git commit -m 'modify: update pks'`, mk('code[1]:\nnothing to commit', 'On branch master\nnothing to commit, working tree clean\n'))
        assert.strictEqual(r1.ok, true)
        assert.ok(r1.logs.some((x) => x === `[sbx-git] 未判定(code[1]): git commit -m 'modify: update pks'`), JSON.stringify(r1.logs))
        let r2 = await run(`git commit -m 'modify: update pks'`, mk('code[1]:\nhook failed', 'pre-commit hook failed\n'))
        assert.strictEqual(r2.ok, false)
        assert.ok(/git指令失敗\(code\[1\]\): git commit/.test(r2.err.message))
    })

    it('git add .  -A × code[1] → 通過並留痕(add 維持 ≥128); × code[128] → throw', async function() {
        let r1 = await run('git add .  -A', mk('code[1]:\nwarning'))
        assert.strictEqual(r1.ok, true)
        assert.ok(r1.logs.some((x) => x.indexOf('未判定(code[1]): git add') >= 0))
        let r2 = await run('git add .  -A', mk('code[128]:\nfatal: Unable to create index.lock', '', 'fatal: Unable to create index.lock'))
        assert.strictEqual(r2.ok, false)
        assert.ok(/git指令失敗\(code\[128\]\): git add/.test(r2.err.message))
    })

    it('任何 git 列 × spawn[ENOENT](程序無法啟動)→ throw git指令失敗(spawn[ENOENT] …)(C2)', async function() {
        for (let cmd of ['git add .  -A', `git commit -m 'x'`, 'git push', 'git status']) {
            let r = await run(cmd, mk('spawn[ENOENT]:\nspawn powershell ENOENT'))
            assert.strictEqual(r.ok, false, cmd)
            assert.ok(/git指令失敗\(spawn\[ENOENT\] spawn powershell ENOENT\)/.test(r.err.message), `${cmd}: ${r.err.message}`)
        }
    })

    it('git --version(子命令 unknown → 嚴格)× code[1] → throw git指令失敗(code[1]): git --version; × 成功 → 通過', async function() {
        let r = await run('git --version', mk('code[1]:\n'))
        assert.strictEqual(r.ok, false)
        assert.ok(/^\[sbx-git\] git指令失敗\(code\[1\]\): git --version\n/.test(r.err.message), r.err.message)
        assert.strictEqual((await run('git --version', mk(null, 'git version 2.50.0\n'))).ok, true)
    })

    it('未給 main 的 git 字串(如 g_checkAndCommit 合併列)不套用 git 判定: push code[1] 與 spawn 皆通過並留痕', async function() {
        let r = await run('git push', mk('code[1]:\n'), { main: undefined })
        assert.strictEqual(r.ok, true)
    })

})


describe('ectScripts detectPrintedFailure(R15 離開碼 0 時之輸出特徵; 純函式)', function() {

    it('無輸出或良性輸出 → null (R15.5)', function() {
        assert.strictEqual(detectPrintedFailure('', ''), null)
        assert.strictEqual(detectPrintedFailure('transpiling: a.mjs\noutput: a.umd.js\n', 'Browserslist: caniuse-lite is outdated.\n'), null)
        assert.strictEqual(detectPrintedFailure(undefined, undefined), null)
    })

    it('堆疊框行 → { detail: exit 0 但輸出含錯誤堆疊 } (R15.1)', function() {
        let r = detectPrintedFailure('Error: x\n    at core (file:///C:/a.mjs:6:8)\n', '')
        assert.deepStrictEqual(r, { detail: 'exit 0 但輸出含錯誤堆疊' })
    })

    it('堆疊框之各種 V8 樣式皆命中: 具名函式、async、無函式名、絕對路徑、相對路徑、node: 內部、含空白之路徑 (R15.1)', function() {
        let frames = [
            '    at core (file:///C:/pkg/x.mjs:6:8)',
            '    at async node:internal/modules/run_main:101:5',
            '    at file:///C:/pkg/x.mjs:8:1',
            '    at Object.<anonymous> (C:\\pkg\\x.js:3:5)',
            '    at Parser.raise (/home/u/lib/index.js:6599:19)',
            '    at fn (./src/y.js:1:2)',
            '    at async Object.run (C:\\a b\\開源-JS\\x.mjs:10:20)',
            '    at Object.readFileSync (node:fs:484:20)',
        ]
        for (let f of frames) {
            assert.ok(detectPrintedFailure(f + '\n', '') !== null, f)
        }
    })

    it('非堆疊框之縮排 at 行不算: 時間戳、一般英文句 (R15.1 位置須像路徑或網址)', function() {
        for (let s of ['    at the end of the build 12:30:45', '    at 12:30:45', '  at least 3:4:5', 'at core (file:///C:/a.mjs:6:8)']) { //最後一行無縮排: 非堆疊框
            assert.strictEqual(detectPrintedFailure(s + '\n', ''), null, s)
        }
    })

    it('長度超過 2000 字元之行不比對(壓縮碼輸出; R15.1 逐行上限)', function() {
        let longLine = '    at core (file:///C:/' + 'x'.repeat(3000) + ':6:8)'
        assert.strictEqual(detectPrintedFailure(longLine + '\n', ''), null)
        let okLine = '    at core (file:///C:/' + 'x'.repeat(1500) + ':6:8)'
        assert.ok(detectPrintedFailure(okLine + '\n', '') !== null)
    })

    it('固定字串各自命中, 且 stderr 亦比對 (R15.2)', function() {
        for (let m of ['can not clean folder[', 'invalid fpSrc', 'invalid opt.fdSrc[', 'invalid opt.fdTar[']) {
            assert.deepStrictEqual(detectPrintedFailure('', `x ${m} y`), { detail: `exit 0 但輸出含[${m}]` })
        }
    })

    it('警告碼 WPT_DYNAMIC_REQUIRE_GUARDED 與 UNRESOLVED_IMPORT 之子字串本身不判 (R15.5; 後者由 [RollupError] 字樣負責)', function() {
        assert.strictEqual(detectPrintedFailure('WPT_DYNAMIC_REQUIRE_GUARDED', ''), null)
        assert.strictEqual(detectPrintedFailure('code: UNRESOLVED_IMPORT', ''), null)
    })

    it('R15.1 巢狀括號之 eval 框與 <anonymous> 位置皆命中(外審 F10)', function() {
        let frames = [
            '    at eval (eval at <anonymous> (file:///C:/pkg/x.mjs:1:32), <anonymous>:1:7)',
            '    at fn (<anonymous>:1:7)',
            '    at <anonymous>:3:4',
            '    at new Foo (file:///C:/pkg/x.mjs:9:3)',
            '    at core (\\\\server\\share\\pkg\\x.js:6:8)', //UNC 路徑(opus 重跑探測 S15)
            '    at \\\\server\\share\\pkg\\x.js:6:8',
        ]
        for (let f of frames) {
            assert.deepStrictEqual(detectPrintedFailure(f + '\n', ''), { detail: 'exit 0 但輸出含錯誤堆疊' }, f)
        }
    })

    it('R15.8 去控制碼涵蓋 OSC 8 超連結(BEL 與 ST 結尾)與 SGR 色碼(外審 F11)', function() {
        let bel = '    at core (\u001b]8;;file:///C:/pkg/x.mjs\u0007file:///C:/pkg/x.mjs:6:8\u001b]8;;\u0007)\n'
        let st = '    at core (\u001b]8;;file:///C:/pkg/x.mjs\u001b\\file:///C:/pkg/x.mjs:6:8\u001b]8;;\u001b\\)\n'
        let sgr = '\u001b[31m    at core (file:///C:/pkg/x.mjs:6:8)\u001b[0m\n'
        for (let s of [bel, st, sgr]) {
            assert.deepStrictEqual(detectPrintedFailure(s, ''), { detail: 'exit 0 但輸出含錯誤堆疊' }, JSON.stringify(s))
            assert.deepStrictEqual(detectPrintedFailure('', s), { detail: 'exit 0 但輸出含錯誤堆疊' }, JSON.stringify(s))
        }
    })

    it('R15.5 緊接在 Trace、單獨一行 Trace 或 (node:pid) 警告之後的堆疊框屬診斷輸出, 不判(外審 F02/O-03)', function() {
        let frames = '    at foo (file:///C:/pkg/x.mjs:1:2)\n    at bar (node:internal/modules/run_main:5:6)\n'
        let heads = [
            'Trace: build step',
            'Trace',
            '(node:1234) [DEP0040] DeprecationWarning: The `punycode` module is deprecated.',
            '(node:1234) Warning: Accessing non-existent property',
        ]
        for (let head of heads) {
            assert.strictEqual(detectPrintedFailure(`${head}\n${frames}`, ''), null, head)
            assert.strictEqual(detectPrintedFailure('', `${head}\n${frames}`), null, head)
        }
    })

    it('R15.5 豁免只限「緊接」: 中間隔空行或其他行即重新判斷; 不跨串流; Error: 標頭不豁免(被印出之 Error 物件仍判失敗)', function() {
        let frames = '    at foo (file:///C:/pkg/x.mjs:1:2)\n'
        let fail = { detail: 'exit 0 但輸出含錯誤堆疊' }
        assert.deepStrictEqual(detectPrintedFailure(`Trace: x\n\n${frames}`, ''), fail) //隔空行
        assert.deepStrictEqual(detectPrintedFailure(`Trace: x\n${frames}done building\n${frames}`, ''), fail) //第二段不在 Trace 之後
        assert.deepStrictEqual(detectPrintedFailure('Trace: x\n', frames), fail) //跨串流
        assert.deepStrictEqual(detectPrintedFailure(`Error: boom\n${frames}`, ''), fail) //Error 標頭
        assert.deepStrictEqual(detectPrintedFailure(`(node:1\n${frames}`, ''), fail) //不完整之 (node:pid) 標頭
        assert.deepStrictEqual(detectPrintedFailure(`Tracer\n${frames}`, ''), fail) //Trace 前綴字串不算
    })

    it('R15.5(第二輪 N1 回歸修正) (node:pid) 標頭只豁免良性警告; UnhandledPromiseRejectionWarning 後之堆疊框是未處理的建置失敗(--unhandled-rejections=warn 時 exit 0), 仍判失敗', function() {
        let fail = { detail: 'exit 0 但輸出含錯誤堆疊' }
        let frames = '    at core (file:///C:/pkg/build.mjs:1:30)\n    at file:///C:/pkg/build.mjs:2:1\n'
        let rej = `(node:17236) UnhandledPromiseRejectionWarning: Error: build failed: rollup could not resolve entry\n${frames}`
        assert.deepStrictEqual(detectPrintedFailure('', rej), fail)
        assert.deepStrictEqual(detectPrintedFailure(rej, ''), fail)
        //其他 (node:pid) 良性警告仍豁免
        for (let head of ['(node:1234) [DEP0040] DeprecationWarning: The `punycode` module is deprecated.', '(node:1234) Warning: Accessing non-existent property', '(node:1234) ExperimentalWarning: VM Modules is an experimental feature']) {
            assert.strictEqual(detectPrintedFailure('', `${head}\n${frames}`), null, head)
        }
    })

    it('R15.5(N8) 非 Node 的「Warning:」標頭後緊接之堆疊框屬診斷(如 bluebird), 不判; 但 Error: 標頭仍判', function() {
        let frames = '    at foo (file:///C:/pkg/x.mjs:1:2)\n'
        assert.strictEqual(detectPrintedFailure('', `Warning: a promise was created in a handler but was not returned from it\n${frames}`), null)
        assert.deepStrictEqual(detectPrintedFailure('', `Error: boom\n${frames}`), { detail: 'exit 0 但輸出含錯誤堆疊' })
    })

    it('R15.8(N8) 冒號形 SGR(ITU T.416, ESC[38:2::255:0:0m)亦去除, 其後之堆疊框照判(Node 的 stripVTControlCharacters 單獨處理不了)', function() {
        let s = 'Error: boom\n\u001b[38:2::255:0:0m    at build (file:///x.mjs:1:2)\u001b[0m\n'
        assert.deepStrictEqual(detectPrintedFailure(s, ''), { detail: 'exit 0 但輸出含錯誤堆疊' })
        let s2 = '\u001b[38:2::255:0:0m    at build (file:///x.mjs:1:2)\u001b[0m\n'
        assert.deepStrictEqual(detectPrintedFailure('', s2), { detail: 'exit 0 但輸出含錯誤堆疊' })
    })

    it('R15.2 固定字串共 15 項, 各自命中(stdout 與 stderr), detail 為該項(依序比對, 先命中者決定); 近似但不含完整字串者不判(外審 O-02)', function() {
        assert.strictEqual(PRINTED_FAIL_STRINGS.length, 15)
        for (let m of PRINTED_FAIL_STRINGS) {
            assert.deepStrictEqual(detectPrintedFailure(`x ${m} y`, ''), { detail: `exit 0 但輸出含[${m}]` }, m)
            assert.deepStrictEqual(detectPrintedFailure('', `x ${m} y`), { detail: `exit 0 但輸出含[${m}]` }, m)
        }
        assert.deepStrictEqual(detectPrintedFailure('invalid opt.fpSrc', ''), { detail: 'exit 0 但輸出含[invalid opt.]' })
        for (let s of ['invalid option x', 'opt.type is set', 'inner of worker', 'cb is a function']) {
            assert.strictEqual(detectPrintedFailure(s, ''), null, s)
        }
    })

    it('效能: 5MB 良性輸出 < 2 秒, 且病態長行(含大量 " (" )不造成指數或平方級退化 (R15.1)', function() {
        let big = 'a normal build line with some text 12345\n'.repeat(125000)
        let t0 = Date.now()
        assert.strictEqual(detectPrintedFailure(big, ''), null)
        let patho = '  at ' + ' ('.repeat(900) + 'z\n'
        assert.strictEqual(detectPrintedFailure(patho.repeat(2000), ''), null)
        assert.ok(Date.now() - t0 < 2000, `耗時 ${Date.now() - t0}ms`)
    })

})


describe('ectScripts 逾時(R18)', function() {

    it('DEFAULT_TIMEOUT_MS 為 60 分鐘 (R18.1)', function() {
        assert.strictEqual(DEFAULT_TIMEOUT_MS, 3600000)
    })

    it('main=node/npm × 逾時 → 沿用 node指令失敗/npm指令失敗, detail 為 timeout[Nms] (R18.2)', function() {
        let errExec = 'timeout[3600000ms]:\n部分輸出'
        assert.deepStrictEqual(judgeResult({ main: 'node', errExec }), { failed: true, label: 'node指令失敗', detail: 'timeout[3600000ms]' })
        assert.deepStrictEqual(judgeResult({ main: 'npm', errExec }), { failed: true, label: 'npm指令失敗', detail: 'timeout[3600000ms]' })
    })

    it('未判定列(未給 main、git、bin)× 逾時 → 指令逾時 (R18.2)', function() {
        let errExec = 'timeout[3600000ms]:\n'
        assert.deepStrictEqual(judgeResult({ errExec }), { failed: true, label: '指令逾時', detail: 'timeout[3600000ms]' })
        assert.deepStrictEqual(judgeResult({ main: 'git', errExec }), { failed: true, label: '指令逾時', detail: 'timeout[3600000ms]' })
    })

    it('未判定列 × 非逾時之拒絕值(離開碼、無法啟動)仍不判定 (R5 不變; R18.3)', function() {
        for (let errExec of ['code[1]:\n', 'code[5]:\nERROR', 'spawn[ENOENT]:\nspawn powershell ENOENT', 'code[null]:\n']) {
            assert.deepStrictEqual(judgeResult({ errExec }), { failed: false, label: '', detail: '' }, errExec)
        }
    })

    it('getTimeoutMs: 未給 → 預設; 正數 → 該值; null 或 0 → null(不限制); 負數、NaN、非數字 → 預設 (R18.1)', function() {
        assert.strictEqual(getTimeoutMs(), DEFAULT_TIMEOUT_MS)
        assert.strictEqual(getTimeoutMs({}), DEFAULT_TIMEOUT_MS)
        assert.strictEqual(getTimeoutMs({ main: 'node' }), DEFAULT_TIMEOUT_MS)
        assert.strictEqual(getTimeoutMs({ timeoutMs: 1500 }), 1500)
        assert.strictEqual(getTimeoutMs({ timeoutMs: null }), null)
        assert.strictEqual(getTimeoutMs({ timeoutMs: 0 }), null)
        for (let v of [-1, NaN, 'abc', Infinity, undefined, {}]) {
            assert.strictEqual(getTimeoutMs({ timeoutMs: v }), DEFAULT_TIMEOUT_MS, String(v))
        }
    })

    it('逾時之標籤含守望器字樣 (R18.2: 指令逾時 為新守望字樣; reFatal 已涵蓋)', function() {
        assert.ok(reFatal.test('[w-x] 指令逾時(timeout[3600000ms]): git push'))
    })

    it('isTimeoutMessage: 只認首行標籤後緊接之 (timeout[Nms]); 離開碼、無法啟動、指令文字含 (timeout[…] 者不算 (R18.5、R9)', function() {
        for (let m of [
            '[w-x] node指令失敗(timeout[1500ms]): node toolg/hang.mjs\n輸出',
            '[w-x] npm指令失敗(timeout[3600000ms]): npm run deploy',
            '[w-x] 指令逾時(timeout[3600000ms]): git push',
            'Error: [w-x] npm指令失敗(timeout[2500ms]): npm run hang\n',
        ]) {
            assert.strictEqual(isTimeoutMessage(m), true, m)
        }
        assert.strictEqual(isTimeoutMessage(new Error('[w-x] 指令逾時(timeout[9ms]): git push')), true)
        for (let m of [
            '[w-x] npm指令失敗(code[3]): npm run deploy',
            '[w-x] npm指令失敗: npm run deploy\nnpm error ...',
            '[w-x] npm指令失敗(code[1]): echo (timeout[5ms]): x',
            '[w-x] npm指令失敗(spawn[ENOENT] spawn powershell ENOENT): npm run deploy',
            '[w-x] npm指令失敗(code[1]): npm run deploy\n(timeout[5ms]): 第二行',
            '',
            null,
            undefined,
        ]) {
            assert.strictEqual(isTimeoutMessage(m), false, String(m))
        }
    })

    it('R18.6 TIMEOUT_GRACE_MS 預設 30 秒', function() {
        assert.strictEqual(TIMEOUT_GRACE_MS, 30000)
    })

})


describe('ectScripts 逾時寬限(R18.6; 注入 execProcess, 不啟動程序)', function() {

    let pdi = { name: 'sbx-grace', path: 'C:/sbx' }
    let hang = () => new Promise(() => {}) //永不落定: 模擬孤兒孫程序持有輸出管道, 或殺樹失敗
    let run = async (execProcess, opt) => {
        let oriLog = console.log
        console.log = () => {}
        try {
            return await ectScripts(pdi, 'node x.mjs', { execProcess, ...opt })
        }
        finally {
            console.log = oriLog
        }
    }

    it('execProcess 於 timeoutMs 後仍不落定 → timeoutMs + timeoutGraceMs 後判失敗並不再等待; 訊息註明「逾時後仍未落定, 子程序樹可能未清除」; execProcess 收到 timeout', async function() {
        let seen = null
        let t0 = Date.now()
        await assert.rejects(
            run((prog, args, o) => {
                seen = o
                o.cbStdout('部分輸出')
                return hang()
            }, { main: 'node', timeoutMs: 40, timeoutGraceMs: 80 }),
            (err) => {
                assert.ok(/^Error: \[sbx-grace\] node指令失敗\(timeout\[40ms\]\): node x\.mjs/.test(String(err)), String(err))
                assert.ok(err.message.indexOf('逾時後仍未落定, 子程序樹可能未清除') >= 0, err.message)
                assert.ok(err.message.indexOf('部分輸出') >= 0, '已收到之輸出須保留')
                return true
            }
        )
        let dt = Date.now() - t0
        assert.strictEqual(seen.timeout, 40)
        assert.ok(dt >= 100 && dt < 2000, `耗時 ${dt}ms`)
    })

    it('未給 main(git、.bin 同型)與 npm 列同樣依標籤判失敗', async function() {
        await assert.rejects(run(hang, { timeoutMs: 30, timeoutGraceMs: 50 }), /指令逾時\(timeout\[30ms\]\): node x\.mjs/)
        await assert.rejects(run(hang, { main: 'npm', timeoutMs: 30, timeoutGraceMs: 50 }), /npm指令失敗\(timeout\[30ms\]\)/)
    })

    it('execProcess 在寬限內自行落定(reject timeout[…]) → 照一般逾時判定, 不加「仍未落定」註記', async function() {
        await assert.rejects(
            run(() => new Promise((resolve, reject) => setTimeout(() => reject('timeout[40ms]:\n輸出'), 60)), { main: 'node', timeoutMs: 40, timeoutGraceMs: 500 }),
            (err) => {
                assert.ok(/node指令失敗\(timeout\[40ms\]\)/.test(err.message), err.message)
                assert.ok(err.message.indexOf('仍未落定') < 0, err.message)
                return true
            }
        )
    })

    it('timeoutMs 為 null 或 0(不限制) → 不設寬限賽跑, 不傳 timeout; 慢但成功之列通過', async function() {
        for (let timeoutMs of [null, 0]) {
            let seen = null
            let c = await run((prog, args, o) => {
                seen = o
                return new Promise((resolve) => setTimeout(() => {
                    o.cbStdout('慢輸出')
                    resolve()
                }, 150))
            }, { main: 'node', timeoutMs, timeoutGraceMs: 20 })
            assert.ok(c.indexOf('慢輸出') >= 0)
            assert.ok(!('timeout' in seen), `timeoutMs=${timeoutMs}`)
        }
    })

    it('判為「仍未落定」之後 execProcess 才 reject, 不產生未處理之 rejection', async function() {
        let unhandled = []
        let onUnhandled = (e) => unhandled.push(e)
        process.on('unhandledRejection', onUnhandled)
        try {
            await assert.rejects(
                run(() => new Promise((resolve, reject) => setTimeout(() => reject('timeout[30ms]:\n遲到'), 200)), { main: 'node', timeoutMs: 30, timeoutGraceMs: 30 }),
                /仍未落定/
            )
            await new Promise((resolve) => setTimeout(resolve, 350))
            assert.deepStrictEqual(unhandled, [])
        }
        finally {
            process.off('unhandledRejection', onUnhandled)
        }
    })

    it('timeoutGraceMs 給負數、NaN、非數字 → 用預設 TIMEOUT_GRACE_MS(以 timeoutMs 很短且 execProcess 於 120ms 自行落定驗證: 若寬限被誤設為 0 則 40ms 即判「仍未落定」)', async function() {
        for (let g of [-1, NaN, 'abc']) {
            await assert.rejects(
                run(() => new Promise((resolve, reject) => setTimeout(() => reject('timeout[30ms]:\n'), 120)), { main: 'node', timeoutMs: 30, timeoutGraceMs: g }),
                (err) => {
                    assert.ok(err.message.indexOf('仍未落定') < 0, `${g}: ${err.message}`)
                    return true
                }
            )
        }
    })

})
