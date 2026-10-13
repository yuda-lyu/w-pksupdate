//樁之共用: 把呼叫紀錄附加到環境變數 CALLS_FILE 指定之檔案
import fs from 'fs'


function record(s) {
    let fp = process.env.CALLS_FILE
    if (fp) {
        fs.appendFileSync(fp, s + '\n', 'utf8')
    }
}


export default record
