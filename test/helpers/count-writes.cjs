// Preload for a child process (`node --require test/helpers/count-writes.cjs ...`): records every fs.writeSync of a Buffer
// to the file named by WRITE_LOG, as one JSON line holding the byte length and whether it ends in a newline. Used by
// test/ledger-append.test.js to prove, without any timing, that one ledger append is exactly one write() of the whole line
// (AC-DATA-3 / AC-DATA-16). Strings are not recorded: the writer's temp-file write for the git exclude file passes a string.
const fs = require('node:fs')

const original = fs.writeSync
let recording = false

fs.writeSync = function writeSync(fd, data, ...rest) {
  if (!recording && process.env.WRITE_LOG && Buffer.isBuffer(data)) {
    recording = true // appendFileSync below calls fs.writeSync itself
    try {
      fs.appendFileSync(process.env.WRITE_LOG, JSON.stringify({ length: data.length, endsWithNewline: data[data.length - 1] === 0x0a }) + '\n')
    } finally {
      recording = false
    }
  }
  return original.call(this, fd, data, ...rest)
}
