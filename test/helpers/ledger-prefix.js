// Shared helper for the append-only property of workflows/lib/ledger-append.mjs
// (AC-DATA-19, HARN-OPT-4 T4 round 2 L2): a write may only ADD one
// newline-terminated line, and the bytes already on disk must be a prefix of
// the new content (after the writer's heal newline for a truncated last line).
// Written for T4; T5 and T8 reuse it for their own new fields. Callers pass a
// makeTempRepo() directory, never the real ledger.
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const { runAppend, LEDGER_REL } = require('./temp-repo.js')

// Three lines, the last one cut off mid-record with no trailing newline: the
// shape a crash mid-write leaves behind.
function seedTruncatedLedger(repo) {
  const p = path.join(repo, LEDGER_REL)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  const full = (n) => JSON.stringify({ schema_version: 4, run_id: `seed${n}`, ts: '2026-10-11T00:00:00.000Z', repo: 'demo', kind: 'review_cycle', outcome: 'done' })
  const seed = `${full(1)}\n${full(2)}\n${full(3).slice(0, 40)}`
  assert.ok(!seed.endsWith('\n'), 'fixture must end without a newline')
  fs.writeFileSync(p, seed)
  return { p, seed }
}

// Seeds, writes ONE payload through the real writer, and asserts the prefix
// property. Returns { before, after, added } for further assertions.
function assertAppendPreservesPrefix(repo, payload) {
  const { p, seed: before } = seedTruncatedLedger(repo)
  const res = runAppend(repo, payload)
  assert.equal(JSON.parse(res.stdout.trim().split('\n').pop()).write_ok, true, `stderr: ${res.stderr}`)
  const after = fs.readFileSync(p, 'utf8')
  assert.ok(after.startsWith(before), 'the original bytes must be an untouched prefix of the new content')
  const added = after.slice(before.length)
  assert.ok(added.startsWith('\n'), "the writer's heal newline must follow the truncated line")
  const body = added.slice(1)
  assert.ok(body.endsWith('\n'), 'the added line must be newline-terminated')
  assert.equal(body.split('\n').length - 1, 1, `exactly one line must be added per write, got: ${JSON.stringify(body)}`)
  return { before, after, added: body }
}

module.exports = { seedTruncatedLedger, assertAppendPreservesPrefix }
