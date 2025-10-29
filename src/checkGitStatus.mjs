import fs from 'fs'
import path from 'path'
import { execSync } from 'child_process'
import _ from 'lodash-es'
import w from 'wsemi'


let checkGitStatus = (fd) => {

    //r
    let r = {
        hasChanges: false,
        changes: [],
    }

    try {

        //check, 檢查是否為 git 專案
        let gitDir = path.join(fd, '.git')
        if (!fs.existsSync(gitDir)) {
            throw new Error('不是 Git 專案')
        }

        //執行 git status --short
        let output = execSync('git status --short', {
            cwd: fd,
            encoding: 'utf8',
        }).trim()

        //changes
        let changes = w.sep(output, '\n')

        //check
        if (_.size(changes) > 0) {
            r.hasChanges = true
            r.changes = changes
        }

    }
    catch (err) {
        //若不是 git 專案或發生錯誤，統一回傳空結果
        r.error = err.message
    }

    return r
}


export default checkGitStatus
