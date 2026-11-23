'use strict'
// Test seam for bin/sonar-rules-table.mjs, loaded with NODE_OPTIONS=--require.
// It touches only paths that name the analyser rules table, and only when asked:
//   HOOK_PARTIAL_WRITE=1     write half of the content, announce it on fd 2 with
//                            HOOK-PARTIAL-WRITE, then stall so a test can kill
//                            the process partway through a write.
//   HOOK_SPLIT_WRITE_MS=n    write the content in two halves with an n ms stall between
//                            them, so a writer that is not atomic (two runs writing the
//                            table itself) visibly interleaves.
//   HOOK_VANISH_ON_LSTAT=1   remove a leftover temporary file just before it is
//                            inspected, as another run's sweep would.
//   HOOK_RENAME_THROW=plain|coded
//                            make the rename onto the table throw: plain is an Error
//                            with no code, coded one with a code, syscall and path.
//                            Both carry a free-text message holding a sentinel. named is
//                            a third: an Error with no code whose name is the JSON value
//                            in HOOK_ERROR_NAME_JSON, which need not be a string.
//   HOOK_RENAME_DELAY_MS=n   stall n ms before renaming onto the table, so two
//                            runs started together are both between write and
//                            rename at once.
//   HOOK_BARRIER_DIR=dir     (with HOOK_BARRIER_COUNT=n, default 2) make that overlap certain
//                            instead of likely: a run that has written half of the table, and again
//                            a run that is about to rename onto it, waits until n runs have reached
//                            the same point, however loaded the machine is. A wait that is not met
//                            in two minutes gives up, so a lone run cannot hang forever.
const fs = require('node:fs')
const path = require('node:path')

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
const names = (p) => String(p).includes('analyser-rules')
const write = fs.writeFileSync
const rename = fs.renameSync

// A rendezvous that does not depend on how fast anything runs: this process leaves a marker for `point` and waits until `count` markers are there.
function rendezvous(point) {
  const dir = process.env.HOOK_BARRIER_DIR
  if (!dir) return
  const want = Number(process.env.HOOK_BARRIER_COUNT || 2)
  write.call(fs, path.join(dir, `${point}.${process.pid}`), '')
  const giveUp = Date.now() + 120000
  while (fs.readdirSync(dir).filter((n) => n.startsWith(`${point}.`)).length < want && Date.now() < giveUp) sleep(10)
}

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
if (process.env.HOOK_SPLIT_WRITE_MS) {
  fs.writeFileSync = function (p, data, opts) {
    if (!names(p)) return write.apply(this, arguments)
    const buf = Buffer.from(data)
    const half = buf.length >> 1
    write.call(this, p, buf.subarray(0, half), opts)
    sleep(Number(process.env.HOOK_SPLIT_WRITE_MS))
    rendezvous('half')
    // The original writer, not appendFileSync, which calls the patched one.
    write.call(this, p, buf.subarray(half), { flag: 'a' })
  }
}
if (process.env.HOOK_VANISH_ON_LSTAT === '1') {
  const lstat = fs.lstatSync
  fs.lstatSync = function (p, ...rest) {
    if (/\.analyser-rules\.md\.\d+\.tmp$/.test(String(p))) {
      try {
        fs.unlinkSync(p) // not rmSync, which inspects the path with this very function
      } catch {}
    }
    return lstat.call(this, p, ...rest)
  }
}
if (process.env.HOOK_RENAME_THROW) {
  fs.renameSync = function (from, to) {
    if (!names(to)) return rename.apply(this, arguments)
    const e = new Error(`FREE-TEXT-SENTINEL ${to}`)
    if (process.env.HOOK_RENAME_THROW === 'coded') Object.assign(e, { code: 'ENOSPC', syscall: 'rename', path: String(to) })
    if (process.env.HOOK_RENAME_THROW === 'named') e.name = JSON.parse(process.env.HOOK_ERROR_NAME_JSON)
    throw e
  }
}
if (process.env.HOOK_RENAME_DELAY_MS) {
  fs.renameSync = function (from, to) {
    if (names(to)) sleep(Number(process.env.HOOK_RENAME_DELAY_MS))
    if (names(to)) rendezvous('rename')
    return rename.apply(this, arguments)
  }
}
