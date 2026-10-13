//ectScripts 之純函式單元測試: 組法、輸出累積、失敗摘要、未判定列之留痕、判定(全部判定格)
//對應需求: R01 組法、R02 node 列、R03 npm 列、R04 判定文字各串流原樣串接、R05 無 main 不判定; 帳本(CLAUDE_rulebook.md 1.3) R12 失敗摘要、R13 未判定列之留痕
import assert from 'assert'
import { composeCommand, createOutputCollector, getExecDetail, getUnjudgedMessage, judgeResult } from '../src/ectScripts.mjs'
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
        it(`main=未給(git、.bin 列) × ${oname} → 通過(不判定)`, function() {
            let r = judgeResult({ ...o })
            assert.deepStrictEqual(r, { failed: false, label: '', detail: '' })
        })
        it(`main=其他值('git') × ${oname} → 通過(不判定)`, function() {
            let r = judgeResult({ main: 'git', ...o })
            assert.deepStrictEqual(r, { failed: false, label: '', detail: '' })
        })
    }

    it('未給任何參數 → 通過', function() {
        assert.deepStrictEqual(judgeResult(), { failed: false, label: '', detail: '' })
    })

})
