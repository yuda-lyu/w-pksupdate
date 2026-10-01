import _ from 'lodash-es'


/**
 * 依Level定義規則算出套件之應有Level
 *
 * 規則(業主2026-10-01裁示, 見CLAUDE.md §4):
 * 1.w-package-tools為全自有套件(發布至npm才算套件)之基礎, 自身level為最小=1
 * 2.w-package-tools-*代表第二層基礎, 依賴w-package-tools, level一律為2
 * 3.其他npm套件level最小只能用3, 以wsemi為例, 雖僅依賴w-package-tools(1), 其level最小仍須為3,
 *   不能使用到2, 因2是第二層基礎專用之level
 * 4.其他npm套件, 有安裝自有套件者取其最大之level, 自身之level為前者+1
 *
 * 規則3與4合併為: max(levelDepMax + 1, 3)
 *
 * 此函數為checkProjectLevels(閘門)與g_checkProjectLevels(依賴圖重算)之共用判準,
 * 兩者務必皆由此取得應有Level, 不可各自手寫(殷鑑: 重算曾寫死3而閘門放行2, 同一規則兩處行為分岔)
 *
 * @param {String} name 輸入套件名, 如'wsemi'
 * @param {Number} levelDepMax 輸入該套件之套件區內依賴中最高之level, 無區內依賴時給0
 * @returns {Number} 回傳應有之level
 */
function getLevelWant(name, levelDepMax) {

    //w-package-tools: 全自有套件之基礎
    if (name === 'w-package-tools') {
        return 1
    }

    //w-package-tools-*: 第二層基礎
    if (_.startsWith(name, 'w-package-tools-')) {
        return 2
    }

    //其他npm套件: 取最大依賴level+1, 下限為3
    return Math.max(levelDepMax + 1, 3)
}


export default getLevelWant
