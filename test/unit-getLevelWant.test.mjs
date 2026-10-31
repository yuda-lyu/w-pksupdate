import assert from 'assert'
import getLevelWant from '../src/getLevelWant.mjs'


//Level定義規則(CLAUDE.md §4): 閘門與依賴圖重算之共用判準
describe('unit-getLevelWant', function() {

    it('規則1: w-package-tools 為根, 恆為 1', function() {
        assert.strictEqual(getLevelWant('w-package-tools', 0), 1)
    })

    it('規則2: w-package-tools-* 只依賴 w-package-tools(1) 時為 2', function() {
        assert.strictEqual(getLevelWant('w-package-tools-e2e', 1), 2)
        assert.strictEqual(getLevelWant('w-package-tools-x', 0), 2)
    })

    it('規則2(業主2026-10-31): w-package-tools-* 另依賴其他自有套件時取最大依賴+1, 如依賴 wsemi(3) 為 4', function() {
        assert.strictEqual(getLevelWant('w-package-tools-e2e', 3), 4)
        assert.strictEqual(getLevelWant('w-package-tools-e2e', 5), 6)
    })

    it('規則3: 一般套件下限 3(僅依賴 w-package-tools 或第二層基礎 2 者皆為 3)', function() {
        assert.strictEqual(getLevelWant('wsemi', 1), 3)
        assert.strictEqual(getLevelWant('w-demores', 2), 3)
        assert.strictEqual(getLevelWant('w-x', 0), 3)
    })

    it('規則4: 一般套件取最大依賴+1', function() {
        assert.strictEqual(getLevelWant('w-scan-dep', 3), 4)
        assert.strictEqual(getLevelWant('w-ui-loginout', 4), 5)
    })

})
