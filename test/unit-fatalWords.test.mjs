//致命字樣清單單一來源與中和函式單元測試
//對應需求(帳本 CLAUDE_rulebook.md 1.3): R19.4 外來訊息不得帶出守望器致命字樣(外審 F17); 1.1 致命字樣清單與 test/tools/fatalWords.mjs 之獨立正規式須一致
import assert from 'assert'
import fs from 'fs'
import path from 'path'
import { FATAL_WORDS, neutralizeFatal } from '../src/fatalWords.mjs'
import { reFatal } from './tools/fatalWords.mjs'


//測試端獨立正規式之字樣集合(source 以 | 分隔, 還原跳脫的 '.')
let wordsInTest = reFatal.source.split('|').map((s) => s.replace(/\\\./g, '.'))


describe('fatalWords 致命字樣清單與中和(R19.4)', function() {

    it('src 之 FATAL_WORDS 與 test/tools/fatalWords.mjs 之獨立正規式為同一集合(新增字樣須兩處同改, 並同步 CLAUDE.md §7.4 之 grep)', function() {
        assert.deepStrictEqual([...FATAL_WORDS].sort(), [...wordsInTest].sort())
    })

    it('第二輪 N9: CLAUDE.md §7.4 守望器 grep 清單(守望器實際使用的那一份)與 FATAL_WORDS 為同一集合, 新增字樣漏改文件即紅', function() {
        let fp = path.resolve('./CLAUDE.md')
        if (!fs.existsSync(fp)) {
            this.skip() //CLAUDE*.md 被 .gitignore 忽略, 全新 clone 無此檔時略過
        }
        let md = fs.readFileSync(fp, 'utf8')
        let m = md.match(/持續 grep `([^`]+)`/)
        assert.ok(m, 'CLAUDE.md 找不到「持續 grep `…`」之守望器清單')
        let inDoc = m[1].split('|')
        assert.deepStrictEqual([...inDoc].sort(), [...FATAL_WORDS].sort())
    })

    it('清單含本輪新增之守望字樣: 指令逾時、建置主檔異常、版本未遞增、script.txt缺少必要列、script.txt列序不符', function() {
        for (let s of ['指令逾時', '建置主檔異常', '版本未遞增', 'script.txt缺少必要列', 'script.txt列序不符']) {
            assert.ok(FATAL_WORDS.includes(s), s)
        }
    })

    it('R6 清單含 2026-10-17 新增之守望字樣 git指令失敗(git 列離開碼 ≥128), 共 14 項', function() {
        assert.ok(FATAL_WORDS.includes('git指令失敗'))
        assert.strictEqual(FATAL_WORDS.length, 14)
        assert.ok(reFatal.test('[w-x] git指令失敗(code[128]): git commit'))
    })

    it('neutralizeFatal: 每個致命字樣被中和後不再命中守望器正規式, 且去掉零寬字元後與原文相同(人眼與搜尋原文不受影響)', function() {
        for (let word of FATAL_WORDS) {
            let src = `前綴 ${word} 後綴`
            let out = neutralizeFatal(src)
            assert.ok(!reFatal.test(out), `${word} → ${JSON.stringify(out)}`)
            assert.strictEqual(out.replace(/​/g, ''), src)
        }
    })

    it('neutralizeFatal: 同一字串含多個、含重複致命字樣, 全部中和; 冪等', function() {
        let src = 'npm指令失敗 與 node指令失敗 與 npm指令失敗 與 Vue packages version mismatch'
        let out = neutralizeFatal(src)
        assert.ok(!reFatal.test(out))
        assert.strictEqual(neutralizeFatal(out), out)
    })

    it('neutralizeFatal: 不含致命字樣之文字原樣不動; 非字串輸入轉為字串', function() {
        assert.strictEqual(neutralizeFatal('fetch failed'), 'fetch failed')
        assert.strictEqual(neutralizeFatal('檢測例外 ETIMEDOUT'), '檢測例外 ETIMEDOUT')
        assert.strictEqual(neutralizeFatal(undefined), '')
        assert.strictEqual(neutralizeFatal(null), '')
        assert.strictEqual(neutralizeFatal(123), '123')
    })

})
