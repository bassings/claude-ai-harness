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
//   node spec-writeback.mjs verify <spec-path> <snapshot-file> <surviving-ids-file>
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
// T8 review round 2 H1: a lens prefix may carry a digit (AC-A11Y-<n>), the same blindness static-checks M5 recorded.
const AC_LINE = /^- \*\*(AC-[A-Z][A-Z0-9]*-\d+):\*\*(.*)$/
const AC_ID = /^AC-[A-Z][A-Z0-9]{0,15}-[0-9]{1,6}$/
const ACCEPTANCE = '## Acceptance criteria'

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')
const fail = (reason) => { process.stderr.write(`spec-writeback: ${reason}\n`); process.exit(1) }

const linesOf = (text) => text.split('\n').map((l) => l.replace(/\r$/, ''))
// Round 4 F2: a "## " line inside a fenced code block is an example, not a heading.
const headingsOf = (text) => {
  const out = []
  let fenced = false
  for (const l of linesOf(text)) {
    if (/^\s*(```|~~~)/.test(l)) { fenced = !fenced; continue }
    if (!fenced && l.startsWith('## ')) out.push(l.trimEnd())
  }
  return out
}
// Round 4 F1: a spec reached through a symlink is resolved once, so the restore writes through to the real file
// instead of replacing the link with a regular file and reporting a false restore.
function realSpecPath(specPath) {
  try { return fs.realpathSync(specPath) } catch (e) { return fail(`cannot read the spec: ${e.code || e.message}`) }
}
const criteriaOf = (text) => linesOf(text).map((l) => AC_LINE.exec(l)).filter(Boolean)
  .map((m) => ({ id: m[1], text: m[2].trim(), line: m[0] }))

// T8 review round 1 F1 (High): the first form stripped every trailing closer before reading the last character, so
// the merge-note shapes the synthesis prompt itself asks for ("Text. *(merges AC-ARCH-7)*", "Text. [merges AC-QA-15]")
// read their last character as the digit of the id and were flagged; 2 of 12 real specs failed. Trailing emphasis
// and whole trailing bracketed notes are peeled off, repeatedly, and then trailing closers are stripped, before the
// sentence-terminal test. The check applies only to criterion lines the write-back wrote or changed: a line byte-
// identical to one in the snapshot is the operator's own (hand-written specs carry multi-line criteria), and the
// write-back is judged on what it wrote. test/spec-writeback.test.js runs verify over every real spec under specs/
// against its own snapshot and ids, so the structural checks are pinned against real input.
// T8 review round 3 F2: a demand for terminal punctuation rejected complete criteria ("Returns 401 for a bad token",
// "The command is `make verify`"), and the writer was never told the rule. The check now looks for TRUNCATION
// signatures only: an odd number of backticks, unbalanced ( ) or [ ], a closing code span whose content ends in an
// anchor or opener (the 2026-10-13 cut, "`/^abc$`"), a trailing comma, dash or opener, or a trailing connective word.
// The synthesis prompt still asks for a full stop, as style; its absence alone is not a defect.
const CONNECTIVES = new Set(['and', 'or', 'then', 'the', 'a', 'an', 'of', 'to', 'with', 'by', 'for', 'in', 'on', 'at', 'is', 'are', 'that', 'which', 'when', 'where', 'if', 'but', 'as', 'into', 'from', 'than', 'so', 'not', 'be', 'was', 'were', 'has', 'have', 'its', 'their', 'any', 'each', 'every', 'no'])
function midSentence(text) {
  if ((text.match(/`/g) || []).length % 2 === 1) return 'an odd number of backticks'
  const bare = text.replace(/`[^`]*`/g, '')
  if ((bare.match(/\(/g) || []).length !== (bare.match(/\)/g) || []).length) return 'unbalanced parentheses'
  if ((bare.match(/\[/g) || []).length !== (bare.match(/\]/g) || []).length) return 'unbalanced brackets'
  let t = text.trimEnd()
  for (;;) {
    const peeled = t.replace(/[\s*_"']+$/, '').replace(/\s*[([][^()[\]]*[)\]]$/, '')
    if (peeled === t) break
    t = peeled
  }
  const span = /`([^`]*)`$/.exec(t)
  if (span && /[$^/|\\([{]$/.test(span[1])) return 'ends in a code span cut at an anchor or opener'
  const tail = t.replace(/[\s*_"'`)\]]+$/, '')
  if (/[,\-([{]$/.test(tail)) return `ends with ${JSON.stringify(tail.slice(-1))}`
  const lastWord = (/([A-Za-z]+)$/.exec(tail) || [])[1]
  if (lastWord && CONNECTIVES.has(lastWord.toLowerCase())) return `ends with the connective "${lastWord}"`
  return null
}

function problemsOf(now, snapshotText, surviving) {
  const problems = []
  const headingsNow = headingsOf(now)
  const headingsSnap = headingsOf(snapshotText)
  const count = (h) => headingsNow.filter((x) => x === h).length
  // Round 4 F2: the write-back is judged on what it changed; a heading the snapshot already had twice is the
  // operator's own and is not a defect here (only a heading the write-back ADDED a copy of, or dropped, is).
  for (const h of new Set(headingsSnap)) {
    const n = count(h)
    const had = headingsSnap.filter((x) => x === h).length
    if (n === 0) problems.push(`missing heading: ${h} (the snapshot had it)`)
    else if (n > had) problems.push(`duplicate heading: ${h} (${n} times, the snapshot had ${had})`)
  }
  if (count(ACCEPTANCE) !== 1) problems.push(`"${ACCEPTANCE}" must appear exactly once, found ${count(ACCEPTANCE)}`)

  const criteria = criteriaOf(now)
  const defined = new Set(criteria.map((c) => c.id))
  // T8 review round 3 F1: the same id defined twice with different text is the id-uniqueness class the pre-push
  // gate caught on 2026-10-13; a set comparison cannot see it, so definitions are counted per id.
  const perId = new Map()
  for (const c of criteria) perId.set(c.id, (perId.get(c.id) || 0) + 1)
  for (const [id, n] of perId) if (n > 1) problems.push(`duplicate criterion id: ${id} (${n} times)`)
  const want = new Set(surviving)
  for (const id of want) if (!defined.has(id)) problems.push(`missing criterion: ${id} is in the surviving set but not defined in the spec`)
  for (const id of defined) if (!want.has(id)) problems.push(`unexpected criterion: ${id} is defined in the spec but not in the surviving set`)

  const seen = new Map()
  const snapshotLines = new Set(linesOf(snapshotText))
  for (const c of criteria) {
    const why = snapshotLines.has(c.line) ? null : midSentence(c.text)
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

function snapshot(specPathGiven) {
  const specPath = realSpecPath(specPathGiven)
  let bytes
  try { bytes = fs.readFileSync(specPath) } catch (e) { fail(`cannot read the spec: ${e.code || e.message}`) }
  const text = bytes.toString('utf8')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), SNAP_PREFIX))
  const file = path.join(dir, 'spec.snapshot')
  fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 })
  process.stdout.write(JSON.stringify({ file, sha256: sha256(bytes), headings: headingsOf(text), ac_ids: criteriaOf(text).map((c) => c.id) }) + '\n')
}

// T8 review round 2 M2: the text outside the acceptance-criteria section (the section runs from its heading to the
// next top-level heading or the end). A restore only ever rewrites that section's edit; if anything OUTSIDE it differs
// from the snapshot, someone else (the operator, during a multi-minute run) changed the spec, and overwriting that
// would be silent data loss, so verify reports and refuses to restore instead.
// The section ends at the next top-level heading the SNAPSHOT had that has not already appeared earlier in the file:
// a snapshot heading pasted into the section (the 2026-10-13 shape) has appeared above already, so it stays inside and
// a restore still happens; a genuinely following heading such as "## Tasks" ends the section as it should.
function outsideSection(text, snapshotText) {
  const snapHeadings = new Set(headingsOf(snapshotText))
  const out = []
  const seen = new Map()
  let inside = false
  for (const l of linesOf(text)) {
    const t = l.trimEnd()
    if (t === ACCEPTANCE) { inside = true; seen.set(t, (seen.get(t) || 0) + 1); continue }
    if (inside && t.startsWith('## ') && snapHeadings.has(t) && !(seen.get(t) > 0)) inside = false
    if (t.startsWith('## ')) seen.set(t, (seen.get(t) || 0) + 1)
    if (!inside) out.push(l)
  }
  return out.join('\n')
}

// T8 review round 2 M1: the surviving ids come from a FILE the synthesis agent writes with its file tool, never from a
// shell argument it types (the shape T5 removed for the ledger payload), and the ids verified are echoed back as
// surviving_ids_checked so the workflow can tie them to the ids the agent returned.
function readIds(idsFile) {
  let raw
  try { raw = fs.readFileSync(idsFile, 'utf8') } catch (e) { fail(`cannot read the surviving-ids file: ${e.code || e.message}`) }
  let ids
  try { ids = JSON.parse(raw) } catch { fail('the surviving-ids file is not JSON') }
  if (!Array.isArray(ids) || !ids.every((x) => typeof x === 'string' && AC_ID.test(x))) fail('the surviving-ids file must be a JSON array of AC ids')
  return [...new Set(ids)].sort()
}

function verify(specPathGiven, snapFile, idsFile) {
  if (!specPathGiven || !snapFile || !idsFile) fail('usage: verify <spec-path> <snapshot-file> <surviving-ids-file>')
  const specPath = realSpecPath(specPathGiven)
  let snapBytes
  try { snapBytes = fs.readFileSync(snapFile) } catch (e) { fail(`cannot read the snapshot file: ${e.code || e.message}`) }
  if (!snapBytes.length) fail('the snapshot file is empty')
  const surviving = readIds(idsFile)

  const problems = []
  let nowBytes = null
  try { nowBytes = fs.readFileSync(specPath) } catch (e) { problems.push(`the spec cannot be read after the write-back: ${e.code || e.message}`) }
  if (nowBytes) problems.push(...problemsOf(nowBytes.toString('utf8'), snapBytes.toString('utf8'), surviving))

  const snapshot_sha256 = sha256(snapBytes)
  if (problems.length) {
    const snapText = snapBytes.toString('utf8')
    const changedOutside = nowBytes !== null && outsideSection(nowBytes.toString('utf8'), snapText) !== outsideSection(snapText, snapText)
    if (changedOutside) {
      problems.push('the spec changed outside the acceptance-criteria section since the snapshot (not restored, so that change is kept; check the spec by hand)')
      process.stdout.write(JSON.stringify({ ok: false, problems, restored: false, spec_sha256: sha256(nowBytes), snapshot_sha256, surviving_ids_checked: surviving }) + '\n')
      return
    }
    restore(specPath, snapBytes)
    process.stdout.write(JSON.stringify({ ok: false, problems, restored: true, spec_sha256_after_restore: sha256(fs.readFileSync(specPath)), snapshot_sha256, surviving_ids_checked: surviving }) + '\n')
    return
  }
  const dir = path.dirname(snapFile)
  if (path.basename(dir).startsWith(SNAP_PREFIX)) {
    // The ids file the agent wrote beside the snapshot (round 2 M1) goes with it.
    try { if (path.dirname(path.resolve(idsFile)) === path.resolve(dir)) fs.unlinkSync(idsFile) } catch { /* same as below */ }
    try { fs.unlinkSync(snapFile); fs.rmdirSync(dir) } catch { /* left in place; stdout already carries the result */ }
  }
  process.stdout.write(JSON.stringify({ ok: true, problems: [], restored: false, spec_sha256: sha256(nowBytes), snapshot_sha256, surviving_ids_checked: surviving }) + '\n')
}

const [mode, ...rest] = process.argv.slice(2)
if (mode === 'snapshot' && rest[0]) snapshot(rest[0])
else if (mode === 'verify') verify(...rest)
else fail('usage: snapshot <spec-path> | verify <spec-path> <snapshot-file> <surviving-ids-file>')
