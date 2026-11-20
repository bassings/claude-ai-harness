'use strict'
// Test seam for bin/sonar-rules-table.mjs, loaded with NODE_OPTIONS=--require.
// It touches only paths that name the analyser rules table, and only when asked:
//   HOOK_PARTIAL_WRITE=1     write half of the content, announce it on fd 2 with
//                            HOOK-PARTIAL-WRITE, then stall so a test can kill
//                            the process partway through a write.
//   HOOK_RENAME_DELAY_MS=n   stall n ms before renaming onto the table, so two
//                            runs started together are both between write and
//                            rename at once.
const fs = require('node:fs')

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
const names = (p) => String(p).includes('analyser-rules')
const write = fs.writeFileSync
const rename = fs.renameSync

if (process.env.HOOK_PARTIAL_WRITE === '1') {
  fs.writeFileSync = function (p, data, opts) {
    if (!names(p)) return write.apply(this, arguments)
    const buf = Buffer.from(data)
    write.call(this, p, buf.subarray(0, buf.length >> 1), opts)
    fs.writeSync(2, 'HOOK-PARTIAL-WRITE\n')
    sleep(60000)
    return write.apply(this, arguments)
  }
}
if (process.env.HOOK_RENAME_DELAY_MS) {
  fs.renameSync = function (from, to) {
    if (names(to)) sleep(Number(process.env.HOOK_RENAME_DELAY_MS))
    return rename.apply(this, arguments)
  }
}
