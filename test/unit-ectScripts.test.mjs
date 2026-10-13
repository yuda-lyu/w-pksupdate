//ectScripts 之純函式單元測試: 組法、輸出累積、判定(全部判定格)
//對應需求: R01 組法、R02 node 列、R03 npm 列、R04 判定文字各串流原樣串接、R05 無 main 不判定
import assert from 'assert'
import { composeCommand, createOutputCollector, getExecDetail, judgeResult } from '../src/ectScripts.mjs'


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


describe('ectScripts getExecDetail', function() {

    it('離開碼字串取首行並去掉結尾冒號', function() {
        assert.strictEqual(getExecDetail('code[3]:\nabc'), 'code[3]')
        assert.strictEqual(getExecDetail('code[13]:\n'), 'code[13]')
        assert.strictEqual(getExecDetail('timeout[1000ms]:\nx'), 'timeout[1000ms]')
    })

    it('程序無法啟動之 Error 取 String 首行', function() {
        assert.strictEqual(getExecDetail(new Error('spawn powershell ENOENT')), 'Error: spawn powershell ENOENT')
    })

    it('null 與 undefined 回傳空字串', function() {
        assert.strictEqual(getExecDetail(null), '')
        assert.strictEqual(getExecDetail(undefined), '')
    })

})


describe('ectScripts judgeResult(R02 node 列、R03 npm 列、R05 無 main 不判定; 全部判定格)', function() {

    //結果形態: errExec 為 execProcess 之 reject 值(成功為 null), out/err 為各串流原樣串接
    let outcomes = {
        O01_成功: { errExec: null, out: 'ok', err: '' },
        O02_成功且stderr有警告: { errExec: null, out: 'built ok', err: 'Browserslist: browsers data (caniuse-lite) is 6 months old.\n(!) Plugin node-resolve' },
        O03_離開碼1: { errExec: 'code[1]:\nError: boom', out: '', err: 'Error: boom' },
        O04_離開碼3: { errExec: 'code[3]:\n', out: '', err: '' },
        O05_離開碼13: { errExec: 'code[13]:\nWarning: Detected unsettled top-level await', out: '', err: 'Warning: Detected unsettled top-level await' },
        O06_程序無法啟動: { errExec: new Error('spawn powershell ENOENT'), out: '', err: '' },
        O07_逾時: { errExec: 'timeout[1000ms]:\n', out: '', err: '' },
        O08_stdout含RollupError且exit0: { errExec: null, out: 'Error [RollupError]: "default" is not exported', err: '' },
        O09_stderr含RollupError且exit0: { errExec: null, out: '', err: 'Error [RollupError]: x' },
        O10_含RollupError且離開碼1: { errExec: 'code[1]:\nError [RollupError]: x', out: '', err: 'Error [RollupError]: x' },
        O11_stdout含npmerror且exit0: { errExec: null, out: 'npm error code E403', err: '' },
        O12_stderr含npmerror且exit0: { errExec: null, out: '', err: 'npm error Missing script: "x"' },
        O13_含npmerror且離開碼1: { errExec: 'code[1]:\nnpm error code ETARGET', out: '', err: 'npm error code ETARGET' },
        O14_只有npmwarn: { errExec: null, out: '', err: 'npm warn deprecated x@1.0.0' },
    }

    //應然: [failed, label, detail]
    let expects = {
        node: {
            O01_成功: [false, '', ''],
            O02_成功且stderr有警告: [false, '', ''],
            O03_離開碼1: [true, 'node指令失敗', 'code[1]'],
            O04_離開碼3: [true, 'node指令失敗', 'code[3]'],
            O05_離開碼13: [true, 'node指令失敗', 'code[13]'],
            O06_程序無法啟動: [true, 'node指令失敗', 'Error: spawn powershell ENOENT'],
            O07_逾時: [true, 'node指令失敗', 'timeout[1000ms]'],
            O08_stdout含RollupError且exit0: [true, 'rollup編譯失敗', ''],
            O09_stderr含RollupError且exit0: [true, 'rollup編譯失敗', ''],
            O10_含RollupError且離開碼1: [true, 'rollup編譯失敗', ''], //字樣優先, 沿用既有訊息
            O11_stdout含npmerror且exit0: [false, '', ''], //node 列不比對 npm error
            O12_stderr含npmerror且exit0: [false, '', ''],
            O13_含npmerror且離開碼1: [true, 'node指令失敗', 'code[1]'],
            O14_只有npmwarn: [false, '', ''],
        },
        npm: {
            O01_成功: [false, '', ''],
            O02_成功且stderr有警告: [false, '', ''],
            O03_離開碼1: [true, 'npm指令失敗', 'code[1]'],
            O04_離開碼3: [true, 'npm指令失敗', 'code[3]'],
            O05_離開碼13: [true, 'npm指令失敗', 'code[13]'],
            O06_程序無法啟動: [true, 'npm指令失敗', 'Error: spawn powershell ENOENT'],
            O07_逾時: [true, 'npm指令失敗', 'timeout[1000ms]'],
            O08_stdout含RollupError且exit0: [false, '', ''], //npm 列不比對 [RollupError]
            O09_stderr含RollupError且exit0: [false, '', ''],
            O10_含RollupError且離開碼1: [true, 'npm指令失敗', 'code[1]'],
            O11_stdout含npmerror且exit0: [true, 'npm指令失敗', ''],
            O12_stderr含npmerror且exit0: [true, 'npm指令失敗', ''],
            O13_含npmerror且離開碼1: [true, 'npm指令失敗', ''], //字樣優先, 沿用既有訊息
            O14_只有npmwarn: [false, '', ''],
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
