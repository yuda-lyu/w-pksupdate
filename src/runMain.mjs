import _ from 'lodash-es'
import { assertRealExecAllowed } from './testGuard.mjs'


/**
 * 執行主程序並回傳離開碼(帳本 R16)
 *
 * 原 g_updateAndPublic.mjs 以 `.then(印 finish all).catch(console.log)` 收尾, 中止時錯誤只被印出而離開碼為 0,
 * 凡以離開碼判定「完成」之自動化會把中止誤當成功. 改為: publishFn 成功 → 印 `>>> finish all` 並回傳 0;
 * 失敗(含同步拋錯、非 Error 之 reject 值)→ 印出錯誤並回傳 1, 由入口設為 process.exitCode.
 * 守望器判讀不變: 中止時仍無 `>>> finish all`, 錯誤仍印於 log(CLAUDE.md §7.3).
 *
 * @param {Function} publishFn 輸入主程序函數(通常為 () => publishPackages(names)), 可同步或非同步
 * @returns {Promise} 回傳 Promise, resolve 回傳離開碼, 成功為 0, 失敗為 1; 本函數不 reject
 */
async function runMain(publishFn) {
    try {
        await publishFn()
    }
    catch (err) {
        console.log(err)
        return 1
    }
    console.log(`>>> finish all`)
    return 0
}


/**
 * 等 stdout、stderr 排空後以指定離開碼結束行程(帳本 R16.4, 第二輪 N2)
 *
 * 逾時寬限到期(R18.6)時, 孫程序孤兒仍持有子程序之輸出管道, 主行程的事件迴圈因而不空, 即使 Promise 已落定、錯誤已印出,
 * 行程仍不結束(實測等到孤兒結束才退出, 常駐孤兒則永不退出): 離開碼送不出去, 「進程結束守望」一直回報仍在執行.
 * 入口在 runMain 回傳後呼叫本函數, 排空輸出再強制結束; 另設備援計時器(2 秒, unref)避免輸出管道損壞時永遠等不到回呼.
 *
 * @param {Number} code 輸入離開碼
 * @param {Function} [exitFn=process.exit] 輸入結束行程之函數(供測試注入); 測試環境下必須給(未給即 throw, 帳本 R25), 需真結束行程之子行程測試顯式傳 process.exit
 * @returns {Promise} 回傳 Promise, 於呼叫 exitFn 之後 resolve(真實 process.exit 不會返回)
 */
function exitAfterFlush(code, exitFn) {
    //測試環境下未注入 exitFn 即 throw: 預設的 process.exit 會使 mocha 行程中途結束並回報成功(第 5 次外審 opus F13; 帳本 R25); 子行程測試顯式傳 process.exit 表承認
    if (!_.isFunction(exitFn)) {
        assertRealExecAllowed('exitAfterFlush', '未注入 exitFn, 將以 process.exit 結束行程')
        exitFn = process.exit
    }
    return new Promise((resolve) => {
        let done = false
        let finish = () => {
            if (done) {
                return
            }
            done = true
            exitFn(code)
            resolve()
        }
        setTimeout(finish, 2000).unref()
        process.stdout.write('', () => {
            process.stderr.write('', finish)
        })
    })
}


export { exitAfterFlush }
export default runMain
