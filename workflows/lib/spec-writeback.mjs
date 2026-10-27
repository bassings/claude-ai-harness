#!/usr/bin/env node
// The plan cycle's write-back check, COMPUTED here rather than judged by an agent.
//
// HARN-OPT-5 T8. On 2026-10-13 the synthesis write-back pasted the whole preamble into the criteria at three points
// and cut three criterion lines where their text held a regex end anchor followed by a backtick (the replacement-string
// metacharacter sequence); only the pre-push gate's duplicate-criterion scan caught it, and it was repaired by hand.
// Workflow scripts have no filesystem access, so the capture, the comparison and the restore live in this ordinary Node
// script and the agents only relay its small stdout objects (the pattern of stray-snapshot.mjs).
//
// Usage:
//   node spec-writeback.mjs snapshot <spec-path>
//     copies the spec's bytes to a 0600 file made with mkdtemp under os.tmpdir() (never under a repo or .claude/) and
//     prints ONE object { file, sha256, headings: [every "## " line, in order], ac_ids: [ids defined by "- **AC-...:**" lines] }.
//     Exits non-zero only when the spec cannot be read.
//   node spec-writeback.mjs verify <spec-path> <snapshot-file> <surviving-ids-json>
//     checks the spec as written now against the snapshot:
//       (a) every top-level heading the snapshot had appears exactly once now, and "## Acceptance criteria" exactly once;
//       (b) the set of AC ids defined now equals the surviving set given;
//       (c) no criterion line ends mid-sentence (odd backticks, unbalanced parentheses, or a last character, after any
//           closing quote, bracket, asterisk or backtick, outside . ? ! :);
//       (d) no criterion line's text appears more than once.
//     On any failure it RESTORES the snapshot's bytes into the spec (temp file beside it, then rename, so it is atomic)
//     and prints { ok: false, problems, restored: true, spec_sha256_after_restore, snapshot_sha256 }. On success it prints
//     { ok: true, problems: [], restored: false, spec_sha256, snapshot_sha256 } and removes the snapshot file and its directory.
//     A missing or malformed snapshot or surviving-ids argument exits non-zero with one reason line on stderr, nothing
//     on stdout, and restores nothing.
// The only removal is that successful-verify reap of the snapshot file and its harn-specwb-* directory.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'

const SNAP_PREFIX = 'harn-specwb-'
const AC_LINE = /^- \*\*(AC-[A-Z]+-\d+):\*\*(.*)$/
const ACCEPTANCE = '## Acceptance criteria'

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')
const fail = (reason) => { process.stderr.write(`spec-writeback: ${reason}\n`); process.exit(1) }

const linesOf = (text) => text.split('\n').map((l) => l.replace(/\r$/, ''))
const headingsOf = (text) => linesOf(text).filter((l) => l.startsWith('## ')).map((l) => l.trimEnd())
const criteriaOf = (text) => linesOf(text).map((l) => AC_LINE.exec(l)).filter(Boolean)
  .map((m) => ({ id: m[1], text: m[2].trim() }))

function midSentence(text) {
  if ((text.match(/`/g) || []).length % 2 === 1) return 'an odd number of backticks'
  const bare = text.replace(/`[^`]*`/g, '')
  if ((bare.match(/\(/g) || []).length !== (bare.match(/\)/g) || []).length) return 'unbalanced parentheses'
  const last = text.replace(/[\s)\]"'*`]+$/, '').slice(-1)
  if (!last || !'.?!:'.includes(last)) return `the last character is not sentence-terminal (${JSON.stringify(text.slice(-1))})`
  return null
}

function problemsOf(now, snapshotText, surviving) {
  const problems = []
  const headingsNow = headingsOf(now)
  const count = (h) => headingsNow.filter((x) => x === h).length
  for (const h of new Set(headingsOf(snapshotText))) {
    const n = count(h)
    if (n === 0) problems.push(`missing heading: ${h} (the snapshot had it)`)
    else if (n > 1) problems.push(`duplicate heading: ${h} (${n} times)`)
  }
  if (count(ACCEPTANCE) !== 1) problems.push(`"${ACCEPTANCE}" must appear exactly once, found ${count(ACCEPTANCE)}`)

  const criteria = criteriaOf(now)
  const defined = new Set(criteria.map((c) => c.id))
  const want = new Set(surviving)
  for (const id of want) if (!defined.has(id)) problems.push(`missing criterion: ${id} is in the surviving set but not defined in the spec`)
  for (const id of defined) if (!want.has(id)) problems.push(`unexpected criterion: ${id} is defined in the spec but not in the surviving set`)

  const seen = new Map()
  for (const c of criteria) {
    const why = midSentence(c.text)
    if (why) problems.push(`criterion line ends mid-sentence: ${c.id} (${why})`)
    seen.set(c.text, [...(seen.get(c.text) || []), c.id])
  }
  for (const [text, ids] of seen) {
    if (ids.length > 1) problems.push(`duplicate criterion line text (${ids.length} times: ${ids.join(', ')}): ${text.slice(0, 60)}`)
  }
  return problems
}

// Temp file beside the spec, then rename: the restore is atomic, so a crash leaves the old bytes or the snapshot's, never half.
function restore(specPath, bytes) {
  const tmp = path.join(path.dirname(specPath), `.${path.basename(specPath)}.restore-${process.pid}`)
  let mode = 0o644
  try { mode = fs.statSync(specPath).mode & 0o777 } catch { /* spec gone: default mode */ }
  fs.writeFileSync(tmp, bytes, { mode })
  fs.chmodSync(tmp, mode)
  fs.renameSync(tmp, specPath)
}

function snapshot(specPath) {
  let bytes
  try { bytes = fs.readFileSync(specPath) } catch (e) { fail(`cannot read the spec: ${e.code || e.message}`) }
  const text = bytes.toString('utf8')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), SNAP_PREFIX))
  const file = path.join(dir, 'spec.snapshot')
  fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 })
  process.stdout.write(JSON.stringify({ file, sha256: sha256(bytes), headings: headingsOf(text), ac_ids: criteriaOf(text).map((c) => c.id) }) + '\n')
}

function verify(specPath, snapFile, idsJson) {
  if (!specPath || !snapFile || idsJson === undefined) fail('usage: verify <spec-path> <snapshot-file> <surviving-ids-json>')
  let snapBytes
  try { snapBytes = fs.readFileSync(snapFile) } catch (e) { fail(`cannot read the snapshot file: ${e.code || e.message}`) }
  if (!snapBytes.length) fail('the snapshot file is empty')
  let surviving
  try { surviving = JSON.parse(idsJson) } catch { fail('the surviving ids argument is not JSON') }
  if (!Array.isArray(surviving) || !surviving.every((x) => typeof x === 'string')) fail('the surviving ids argument must be a JSON array of strings')

  const problems = []
  let nowBytes = null
  try { nowBytes = fs.readFileSync(specPath) } catch (e) { problems.push(`the spec cannot be read after the write-back: ${e.code || e.message}`) }
  if (nowBytes) problems.push(...problemsOf(nowBytes.toString('utf8'), snapBytes.toString('utf8'), surviving))

  const snapshot_sha256 = sha256(snapBytes)
  if (problems.length) {
    restore(specPath, snapBytes)
    process.stdout.write(JSON.stringify({ ok: false, problems, restored: true, spec_sha256_after_restore: sha256(fs.readFileSync(specPath)), snapshot_sha256 }) + '\n')
    return
  }
  const dir = path.dirname(snapFile)
  if (path.basename(dir).startsWith(SNAP_PREFIX)) {
    try { fs.unlinkSync(snapFile); fs.rmdirSync(dir) } catch { /* left in place; stdout already carries the result */ }
  }
  process.stdout.write(JSON.stringify({ ok: true, problems: [], restored: false, spec_sha256: sha256(nowBytes), snapshot_sha256 }) + '\n')
}

const [mode, ...rest] = process.argv.slice(2)
if (mode === 'snapshot' && rest[0]) snapshot(rest[0])
else if (mode === 'verify') verify(...rest)
else fail('usage: snapshot <spec-path> | verify <spec-path> <snapshot-file> <surviving-ids-json>')
