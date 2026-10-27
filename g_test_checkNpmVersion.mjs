import checkNpmVersion from './src/checkNpmVersion.mjs'
import { resolveRegistryConfig } from './src/registryConfig.mjs'


//倉庫由倉庫設定決定(帳本R27): 預設取本機npm設定之registry, 可由環境變數W_PKSUPDATE_REGISTRY覆寫
let registry = resolveRegistryConfig().main
console.log('registry', registry)

let name
let version
let b

// name = 'wsemi'
// version = '1.8.17'
// b = await checkNpmVersion(name, version, { registry })
// console.log(name, version, b)

name = 'w-converhp'
version = '2.0.63'
b = await checkNpmVersion(name, version, { registry })
console.log(name, version, b)


//node g_test_checkNpmVersion.mjs
