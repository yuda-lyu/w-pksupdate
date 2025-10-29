import checkNpmVersion from './src/checkNpmVersion.mjs'


let name
let version
let b

// name = 'wsemi'
// version = '1.8.17'
// b = await checkNpmVersion(name, version)
// console.log(name, version, b)

name = 'w-converhp'
version = '2.0.63'
b = await checkNpmVersion(name, version)
console.log(name, version, b)


//node g_test_checkNpmVersion.mjs
