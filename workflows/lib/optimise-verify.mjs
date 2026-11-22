#!/usr/bin/env node
// The weekly runner's result check (HARN-RUNNER-2 T3): what the session returned, held against the files the
// runner collected. It was a program inside a bash heredoc; it is a module so each rule can be tested on its own
// (AC-ARCH-6) and so the attended path can use the same rules (T4).
//
// Command line, as the runner calls it:
//   optimise-verify.mjs <per-run dir> <session reply file, or -> <digest token> <repository> <runner temp dir>
//                       <sidecar root, or ->
// (the per-run directory is physical; the runner temp dir is the same directory as first made, so a path spelled
// either way is caught; the sidecar root is the checkout whose .claude/ holds the proposal-targets sidecar)
// It prints fixed-vocabulary lines only: TOKENS (the figures for the RESULT line), DENIED, CAUSE (a session
// failure's class), one REASON per problem and PLACE yes|no. It never prints a word the session said, or a path.
// When the result is trusted (or the only problem is a lane that could not run) it writes result-report.md and
// result-sidecar.json into the per-run directory, ready for the runner to place. The sidecar it writes is the
// returned one MERGED into the one on disk: the sidecar is the only copy of the id-to-target map for decided
// proposals, so a run never loses an entry from it (mergeSidecar).
//
// Spawn-free, and read-only toward everything but those two files: every read goes through the reader's guarded
// helper (readRepoFile: no symlink, regular file, size cap), like the collector's reads of collected files, and a
// static test fails if this file imports child_process or reads any other way.

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isPlainInsufficientRow, readRepoFile, sidecarTargetOrReason, stableProposalId } from './optimise-read.mjs'

export const REPORT_CAP = 5242880
export const SIDECAR_CAP = 1048576
export const FILE_CAP = 67108864
// How many entries the sidecar file keeps. This module is the only place retention is decided (the workflow carries every
// outcome the digest holds and decides nothing; a test holds it to that).
export const SIDECAR_CARRY_MAX = 500
export const SIDECAR_REL = '.claude/optimise-proposal-targets.json'
export const LANES = ['ledger', 'git', 'ci']
export const SIDECAR_UNREADABLE = 'sidecar on disk cannot be read as a JSON object; left as it was'

export const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
export const isCount = (v) => Number.isSafeInteger(v) && v >= 0
export const modeToken = (m) => (typeof m === 'string' && /^[a-z_]{1,32}$/.test(m) ? m : 'other')

// ---- reading what the runner collected ----

function readGuarded(dir, name) {
  const got = readRepoFile(dir, name, FILE_CAP)
  return got.status === 'ok' ? got.text : null
}

function readJsonGuarded(dir, name) {
  const text = readGuarded(dir, name)
  if (text === null) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

// The three lane files and the digest, as parsed, or null for one that could not be read.
export function loadCollected(dir) {
  return {
    lane: { ledger: readJsonGuarded(dir, 'ledger.json'), git: readJsonGuarded(dir, 'git.json'), ci: readJsonGuarded(dir, 'ci.json') },
    digest: readJsonGuarded(dir, 'digest.json'),
  }
}

export const laneState = (col, name) => (isObject(col.lane[name]) && (col.lane[name].status === 'ran' || col.lane[name].status === 'failed') ? col.lane[name].status : 'unreadable')
export const resultOf = (col, name) => (isObject(col.lane[name]) && isObject(col.lane[name].result) ? col.lane[name].result : {})
export const collectedLedger = (col) => (laneState(col, 'ledger') === 'ran' && isCount(resultOf(col, 'ledger').n) ? resultOf(col, 'ledger').n : null)

// ---- the figures for the RESULT line: collected values only, fixed tokens and integers ----

function laneToken(col, name, figure) {
  if (laneState(col, name) === 'failed') return `${name}=failed:${modeToken(col.lane[name].mode)}`
  return `${name}=${laneState(col, name) === 'ran' && figure !== null ? figure : 'unreadable'}`
}

function ciFigure(col) {
  if (laneState(col, 'ci') !== 'ran') return null
  if (isCount(col.lane.ci.runCount)) return String(col.lane.ci.runCount)
  return typeof col.lane.ci.mode === 'string' ? modeToken(col.lane.ci.mode) : 'unmeasured'
}

function digestFields(col, digestToken) {
  const { digest } = col
  if (digestToken !== 'ran') return `digest=${/^failed:[a-z_]{1,32}(:\w{1,40})?$/.test(digestToken) ? digestToken : 'failed:other'}`
  if (!isObject(digest) || !isObject(digest.dropped)) return 'digest=failed:unreadable'
  const omitted = Object.values(digest.dropped).filter((v) => Number.isInteger(v)).reduce((a, b) => a + b, 0)
  return `digest=ran omitted=${omitted} trimmed=${digest.dropped.trimmedForSize === true ? 'yes' : 'no'}`
}

export function tokensFor(col, digestToken, reportedLedger) {
  const n = collectedLedger(col)
  const reported = reportedLedger === null ? '-' : reportedLedger
  const ledger = n === null ? null : `${n}/${reported}`
  const count = resultOf(col, 'git').count
  return [laneToken(col, 'ledger', ledger), laneToken(col, 'ci', ciFigure(col)), laneToken(col, 'git', isCount(count) ? count : null), digestFields(col, digestToken)].join(' ')
}

// ---- the session's output: the JSON envelope, then the result inside it ----

// The CLI's own report of the tool calls it refused. Measured on 2026-11-22 (claude 2.1.330): the list holds one entry per
// refused Read, so a list is a count, zero included. Whether a refused SHELL call appears in it is not established (an
// earlier measurement found it empty for those), so the count is what the CLI said, not a proof that nothing else was
// attempted. An absent or non-list value is `unknown`. Only the tool NAMES are kept, drawn from a known set (anything else is
// `other`); an entry's tool_input holds paths and is never carried.
export const KNOWN_TOOL_NAMES = ['Agent', 'Bash', 'Edit', 'Glob', 'Grep', 'NotebookEdit', 'Read', 'Skill', 'WebFetch', 'WebSearch', 'Workflow', 'Write']
const toolNameOf = (entry) => (isObject(entry) && KNOWN_TOOL_NAMES.includes(entry.tool_name) ? entry.tool_name : 'other')

export function deniedReport(envelope) {
  if (!Array.isArray(envelope.permission_denials)) return { denied: 'unknown', tools: 'none' }
  const names = [...new Set(envelope.permission_denials.map(toolNameOf))].sort((a, b) => a.localeCompare(b))
  return { denied: String(envelope.permission_denials.length), tools: names.length > 0 ? names.join(',') : 'none' }
}

// { result, denied, tools } or { reason, cause, denied, tools }: the result object, or the one fixed reason it could not be had and the
// class of the failure (empty, malformed).
export function parseSession(text) {
  const empty = { denied: 'unknown', tools: 'none' }
  if (text.trim() === '') return { reason: 'session output: empty', cause: 'empty', ...empty }
  let envelope
  try {
    envelope = JSON.parse(text)
  } catch {
    return { reason: 'session output: not a JSON envelope', cause: 'malformed', ...empty }
  }
  if (!isObject(envelope)) return { reason: 'session output: not a JSON envelope', cause: 'malformed', ...empty }
  const denied = deniedReport(envelope)
  if (envelope.is_error === true || typeof envelope.result !== 'string' || envelope.result === '') return { reason: 'session output: envelope has no result', cause: 'malformed', ...denied }
  let result
  try {
    result = JSON.parse(envelope.result)
  } catch {
    return { reason: 'session output: result is not a JSON object', cause: 'malformed', ...denied }
  }
  return isObject(result) ? { result, ...denied } : { reason: 'session output: result is not a JSON object', cause: 'malformed', ...denied }
}

export function startsWithHeading(report) {
  const first = report.replace(/^﻿/, '').slice(0, 4096).split('\n').find((l) => l.trim() !== '')
  return typeof first === 'string' && first.startsWith('# ')
}

// ---- paths the report must not hold ----

// The real path of a path that exists, else null (a path that does not resolve has no second spelling).
function realPathOrNull(value) {
  try {
    return fs.realpathSync(value)
  } catch {
    return null
  }
}

// Every spelling of a path that must not appear: each given value, trimmed of trailing slashes, and its real path.
export function pathNeedles(values) {
  const named = values.filter((value) => typeof value === 'string' && value.length >= 2)
  return named.flatMap((value) => [value.replace(/\/+$/, ''), realPathOrNull(value)]).filter((needle) => needle !== null)
}

// `strict` needles (the home directory, the per-run directories) are held wherever they appear: `$HOME.bak` and
// `$HOME-old` carry the home directory as surely as `$HOME/x` does. `bounded` needles (the analysed repository) are
// held only as a whole path, so a sibling repository whose name starts the same way is not a leak.
export function holdsPath(text, strict, bounded = []) {
  if (strict.some((needle) => text.includes(needle))) return true
  return bounded.some((needle) => {
    let at = text.indexOf(needle)
    while (at !== -1) {
      if (!/[A-Za-z0-9_.-]/.test(text.charAt(at + needle.length))) return true
      at = text.indexOf(needle, at + 1)
    }
    return false
  })
}

// ---- the result object ----

const failure = (reason, cause) => ({ reason, ...(cause ? { cause } : {}) })

function checkSidecar(result, report) {
  if (!Object.hasOwn(result, 'proposal_targets')) return failure('sidecar missing', 'malformed')
  if (!isObject(result.proposal_targets)) return failure('sidecar is not a JSON object', 'malformed')
  const sidecar = JSON.stringify(result.proposal_targets, null, 2) + '\n'
  if (Buffer.byteLength(sidecar, 'utf8') > SIDECAR_CAP) return failure('sidecar is over the size cap', 'oversized')
  const ids = [...report.matchAll(/^### ([0-9a-f]{16}):/gm)].map((m) => m[1])
  if (ids.some((id) => !Object.hasOwn(result.proposal_targets, id))) return failure('sidecar is missing a proposal id the report names', 'malformed')
  return { sidecar, targets: result.proposal_targets }
}

function checkReportText(report) {
  if (typeof report !== 'string') return failure('session output: report is not a string', 'malformed')
  if (!startsWithHeading(report)) return failure('report does not start with a markdown heading', 'malformed')
  if (report.includes('\u0000')) return failure('report contains a NUL byte', 'malformed')
  if (Buffer.from(report, 'utf8').toString('utf8') !== report) return failure('report is not valid UTF-8', 'malformed')
  const bytes = Buffer.byteLength(report, 'utf8')
  return bytes > REPORT_CAP ? failure(`report is ${bytes} bytes, over the ${REPORT_CAP} cap`, 'oversized') : null
}

// { report, sidecar, targets } or { reason, cause }.
export function checkResult(result, strict, bounded = []) {
  if (Object.hasOwn(result, 'failed_step')) {
    const step = typeof result.failed_step === 'string' && /^[a-z_]{1,32}$/.test(result.failed_step) ? ` (${result.failed_step})` : ''
    return failure(`session returned failed_step${step}`, 'failed_step')
  }
  if (!isObject(result.lanes)) return failure('session output: result has no lanes', 'malformed')
  if (!Object.hasOwn(result, 'report')) return failure('session output: result has no report', 'malformed')
  const reportProblem = checkReportText(result.report)
  if (reportProblem !== null) return reportProblem
  const side = checkSidecar(result, result.report)
  if (side.reason) return side
  if (holdsPath(result.report, strict, bounded) || holdsPath(side.sidecar, strict, bounded)) return failure('report holds an absolute path (the home directory, the repository or the per-run directory)', 'malformed')
  return { report: result.report, sidecar: side.sidecar, targets: side.targets }
}

// ---- the figure checks: what the report says against what the collector wrote ----

const numbersIn = (report, re) => [...report.matchAll(re)].map((m) => m.slice(1).map(Number))

function firstDifference(names, want, got) {
  const i = want.findIndex((w, k) => w !== got[k])
  return i < 0 ? null : { name: names[i], want: want[i], got: got[i] }
}

export function checkLanes(said, col) {
  const reasons = []
  for (const name of LANES) {
    const st = laneState(col, name)
    if (st === 'unreadable') {
      reasons.push(`collected data unreadable: ${name}`)
    } else if (!isObject(said[name]) || said[name].status !== st) {
      const was = isObject(said[name]) && (said[name].status === 'ran' || said[name].status === 'failed') ? said[name].status : 'invalid'
      reasons.push(`figure mismatch ${name}: lane reported ${was}, collected ${st}`)
    } else if (st === 'failed' && modeToken(said[name].mode) !== modeToken(col.lane[name].mode)) {
      reasons.push(`figure mismatch ${name}: lane mode reported ${modeToken(said[name].mode)}, collected ${modeToken(col.lane[name].mode)}`)
    }
  }
  return reasons
}

// { reasons, reported }: reported is the figure the report states for the ledger, for the RESULT line. A record
// count printed beside a ledger lane that has no collected figure is refused, whatever the number: it can only be a
// default zero standing for a lane that did not run.
export function checkLedger(report, col) {
  const want = collectedLedger(col)
  const found = numbersIn(report, /Ledger records in window: (\d{1,15})/g).map(([n]) => n)
  if (want === null) return { reasons: found.length > 0 ? [`figure mismatch ledger: collected none, reported ${found[0]}`] : [], reported: null }
  if (found.length === 0) return { reasons: [`figure mismatch ledger: collected ${want}, reported none`], reported: null }
  const wrong = found.find((n) => n !== want)
  if (wrong === undefined) return { reasons: [], reported: want }
  return { reasons: [`figure mismatch ledger: collected ${want}, reported ${wrong}`], reported: wrong }
}

// A lane with a figure the report must show: every line of that shape in the report equals it. A lane with none:
// the report shows no such line.
export function checkLine(name, report, re, names, want) {
  const found = numbersIn(report, re)
  if (want === null) return found.length > 0 ? [`figure mismatch ${name}: collected none, reported ${found[0][0]}`] : []
  if (found.length === 0) return [`figure mismatch ${name}: ${names[0]} collected ${want[0]}, reported none`]
  for (const got of found) {
    const diff = firstDifference(names, want, got)
    if (diff) return [`figure mismatch ${name}: ${diff.name} collected ${diff.want}, reported ${diff.got}`]
  }
  return []
}

export function checkCi(report, col) {
  const c = col.lane.ci
  const measured = laneState(col, 'ci') === 'ran' && isCount(c.runCount) && isCount(c.fetchFailedCount) && isCount(c.timeoutCount)
  const want = measured ? [c.runCount, c.fetchFailedCount, c.timeoutCount] : null
  return checkLine('ci', report, /CI runs: (\d{1,15}) fetched, (\d{1,15}) not fetched, (\d{1,15}) timed out/g, ['runs', 'not fetched', 'timed out'], want)
}

export function checkGit(report, col) {
  const g = resultOf(col, 'git')
  const measured = laneState(col, 'git') === 'ran' && isCount(g.count) && isCount(g.n_commits_examined)
  return checkLine('git', report, /Raw \(unscoped\): (\d{1,15}) of (\d{1,15}) examined commits/g, ['count', 'examined'], measured ? [g.count, g.n_commits_examined] : null)
}

// The scoped escaped-defect line, against the git lane's scoped counts.
export function checkScoped(report, col) {
  const g = resultOf(col, 'git')
  const measured = laneState(col, 'git') === 'ran' && isCount(g.scoped_count) && isCount(g.scoped_excluded_count) && isCount(g.scoped_unavailable_count)
  const want = measured ? [g.scoped_count, g.scoped_excluded_count, g.scoped_unavailable_count] : null
  return checkLine('git scoped', report, /Scoped to product source \(config: [^)\n]{0,200}\): (\d{1,15}) counted, (\d{1,15}) excluded as pipeline\/tooling-only, (\d{1,15}) unavailable/g, ['scoped counted', 'scoped excluded', 'scoped unavailable'], want)
}

export function checkDigest(report, col) {
  const { digest } = col
  if (!isObject(digest) || !isObject(digest.dropped)) return ['collected data unreadable: digest']
  const dropped = digest.dropped
  const seen = new Set()
  for (const [, key, n] of report.matchAll(/Digest omitted ([A-Za-z]{1,40}): (\d{1,15})/g)) {
    if (!Object.hasOwn(dropped, key) || !isCount(dropped[key])) return [`figure mismatch digest: an omission line the digest does not hold, reported ${n}`]
    seen.add(key)
    if (Number(n) !== dropped[key]) return [`figure mismatch digest: omitted ${key} collected ${dropped[key]}, reported ${n}`]
  }
  for (const [key, value] of Object.entries(dropped)) {
    if (isCount(value) && value > 0 && !seen.has(key)) return [`figure mismatch digest: omitted ${key} collected ${value}, reported none`]
  }
  return (dropped.trimmedForSize === true) !== report.includes('Digest trimmed for size: yes') ? ['figure mismatch digest: trimmed flag'] : []
}

// ---- the number-bearing rows the workflow renders from the digest ----
//
// Each class of row is held to the digest the runner collected (on disk, out of the session's reach). A row is a line
// the class's pattern matches; its key (a job, a repository, a plan, an acceptance criterion) must be one the digest
// holds, every figure on it must equal the digest's, and every key the digest holds must be rendered. A line that looks
// like the class but does not match the exact pattern is refused as a shape the check does not know, so a row cannot
// escape the check by being written differently. Reasons name the class and the figure, never a key or a session word.

// The workflow prints a CI job or repository key through its flattener: absolute-path-looking text redacted, whitespace
// collapsed, 120 characters. A job named `build</UNTRUSTED...` has a `/UNTRUSTED...` that looks like a path, so the
// printed key is not the collected one until it goes through the same steps. The pattern and marker are the
// workflow's own (a parity test holds them equal).
export const REDACTED_PATH_MARKER = '<redacted-path>'
export const ABSOLUTE_PATH_RE = /(^|[\s'"(`=[<,+]|:(?!\/\/))([A-Za-z]:\\[^\s'")]+|\/[^\s'")]+)/g
const flat = (v) => String(v).replaceAll(ABSOLUTE_PATH_RE, (whole, prefix) => `${prefix}${REDACTED_PATH_MARKER}`).replaceAll(/\s+/g, ' ').slice(0, 120)
const countText = (x) => (x === 'n/a' ? null : Number(x))
const numOrNull = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const secondsOf = (s) => (s === 'unmeasured (null)' ? null : Number(s.slice(0, -1)))
const SEC = String.raw`(-?\d{1,15}(?:\.\d{1,9})?s)`
const COUNT = String.raw`(\d{1,15})`
const ledgerDigest = (col) => (isObject(col.digest?.ledger) ? col.digest.ledger : {})
const ciDigest = (col) => (isObject(col.digest?.ci) ? col.digest.ci : {})
const entriesOf = (v) => (isObject(v) ? Object.entries(v) : [])
const orNull = (v) => (v === undefined ? null : v)

const CI_JOB = {
  name: 'ci job',
  re: /^- ([^\n]{1,500}?): n=(\d{1,15}|n\/a), failed=(\d{1,15}|n\/a)(?=,| |$)/gm,
  isRow: (l) => l.startsWith('- ') && l.includes(': n=') && l.includes(', failed='),
  names: ['n', 'failed'],
  split: (m) => ({ key: m[1], got: [countText(m[2]), countText(m[3])] }),
  rows: (col) => new Map(entriesOf(ciDigest(col).byJob).map(([k, j]) => [flat(k), [numOrNull(j?.n), numOrNull(j?.failureCount)]])),
}

const CI_REPOSITORY = {
  name: 'ci repository',
  re: new RegExp(String.raw`^- ([^\n]{1,500}?): ${COUNT} runs not completed \(left out\); per-run fetch failures \(incl\. attempt-1\): rate_limited ${COUNT}, unauthenticated ${COUNT}, other ${COUNT}; attempt-1 jobs not fetched: (\d{1,15}|n/a); runs past attempt 2 or with an unreadable attempt \(not qualifiable\): (\d{1,15}|n/a)$`, 'gm'),
  isRow: (l) => l.startsWith('- ') && l.includes('runs not completed'),
  names: ['not completed', 'rate limited', 'unauthenticated', 'other', 'attempt-1 unfetched', 'past attempt 2'],
  split: (m) => ({ key: m[1], got: m.slice(2).map(countText) }),
  rows: (col) => new Map(entriesOf(ciDigest(col).repoStats).map(([k, st]) => [flat(k), [st?.notCompleted || 0, st?.fetchFailures?.rate_limited || 0, st?.fetchFailures?.unauthenticated || 0, st?.fetchFailures?.other || 0, numOrNull(st?.attempt1Unfetched), numOrNull(st?.pastAttempt2)]])),
}

const GH_CALLS = {
  name: 'gh calls',
  re: /^- ([^\n]{1,500}?): wall-clock (\d{1,15}(?:\.\d{1,9})?|n\/a)s, (\d{1,15}|n\/a) gh calls$/gm,
  isRow: (l) => l.startsWith('- ') && l.includes('gh calls'),
  names: ['wall-clock seconds', 'calls'],
  split: (m) => ({ key: m[1], got: [countText(m[2]), countText(m[3])] }),
  rows: (col) => new Map((Array.isArray(ciDigest(col).ghStats) ? ciDigest(col).ghStats : []).map((g) => [flat(g?.repo), [numOrNull(g?.wall_clock_s), numOrNull(g?.gh_calls)]])),
}

const WALL_CLOCK_PLAN = {
  name: 'wall-clock plan',
  re: new RegExp(String.raw`^- ([^\n]{1,500}?): ci_wait=${SEC} \(n=${COUNT}\), human_wait=${SEC} \(n=${COUNT}\), agent_compute=${SEC} \(n=${COUNT}\)(?:, aborted=${SEC} \(n=${COUNT}\))?(?:, unterminated_waits: ${COUNT})?$`, 'gm'),
  isRow: (l) => l.startsWith('- ') && l.includes(': ci_wait='),
  names: ['ci wait seconds', 'ci wait runs', 'human wait seconds', 'human wait runs', 'agent compute seconds', 'agent compute runs', 'aborted seconds', 'aborted runs', 'unterminated waits'],
  split: (m) => ({ key: m[1], got: [secondsOf(m[2]), Number(m[3]), secondsOf(m[4]), Number(m[5]), secondsOf(m[6]), Number(m[7]), m[8] === undefined ? 0 : secondsOf(m[8]), Number(m[9] ?? 0), Number(m[10] ?? 0)] }),
  rows: (col) => new Map(entriesOf(ledgerDigest(col).wallClock?.byPlan).map(([k, b]) => [k, [orNull(b?.ciWaitSeconds), orNull(b?.ciWaitN), orNull(b?.humanWaitSeconds), orNull(b?.humanWaitN), orNull(b?.agentComputeSeconds), orNull(b?.agentComputeN), b?.agentComputeAbortedN ? orNull(b.agentComputeAbortedSeconds) : 0, b?.agentComputeAbortedN || 0, b?.unterminatedWaits || 0]])),
}

const SEG = String.raw`(unmeasured \(null\)|-?\d{1,15}(?:\.\d{1,9})?s)`
const WALL_CLOCK_TOTALS = {
  name: 'wall-clock totals',
  re: new RegExp(String.raw`^Totals: ci_wait=${SEG} \(measured n=${COUNT}, unmeasured n=${COUNT}\), human_wait=${SEG} \(measured n=${COUNT}, unmeasured n=${COUNT}\), agent_compute=${SEG} \(measured n=${COUNT}, unmeasured n=${COUNT}, aborted n=(\d{1,15}|[^)\n]{1,200})(?: \[[^\]\n]{1,40}\])?\)\.$`, 'gm'),
  isRow: (l) => l.startsWith('Totals: '),
  names: ['ci wait seconds', 'ci wait measured runs', 'ci wait unmeasured runs', 'human wait seconds', 'human wait measured runs', 'human wait unmeasured runs', 'agent compute seconds', 'agent compute measured runs', 'agent compute unmeasured runs', 'agent compute aborted pairs'],
  split: (m) => ({ key: 'totals', got: [secondsOf(m[1]), Number(m[2]), Number(m[3]), secondsOf(m[4]), Number(m[5]), Number(m[6]), secondsOf(m[7]), Number(m[8]), Number(m[9]), /^\d+$/.test(m[10]) ? Number(m[10]) : null] }),
  rows: (col) => {
    const t = ledgerDigest(col).wallClock?.totals
    if (!isObject(t)) return new Map()
    return new Map([['totals', [orNull(t.ciWaitSeconds), t.ciWaitMeasuredRuns ?? 0, t.ciWaitUnmeasuredRuns ?? 0, orNull(t.humanWaitSeconds), t.humanWaitMeasuredRuns ?? 0, t.humanWaitUnmeasuredRuns ?? 0, orNull(t.agentComputeSeconds), t.agentComputeMeasuredRuns ?? 0, t.agentComputeUnmeasuredRuns ?? 0, numOrNull(t.agentComputeAbortedPairs)]]])
  },
}

// What the workflow shows for a never-failing row: the three figures after its repository/spec/criterion key.
const neverFailingText = (a) => {
  const reasoned = a.insufficient_data || a.unattributed_fail_in_window || a.unattributed_verdict_in_entry || a.truncated_in_window
  let disagreements = String(a.verdict_disagreements)
  if (a.verdict_disagreements === undefined) disagreements = ''
  else if (a.verdict_disagreements === null) disagreements = 'not measured'
  return [a.n, reasoned ? '' : String(a.never_failed), disagreements]
}
const carriedNeverFailing = (col) => (Array.isArray(ledgerDigest(col).neverFailingAcs) ? ledgerDigest(col).neverFailingAcs : [])
const shownNeverFailing = (col) => carriedNeverFailing(col).filter((a) => !isPlainInsufficientRow(a))

const NEVER_FAILING = {
  name: 'never-failing',
  re: /^- ([^\n]{1,500}?): n=(\d{1,15})(?: \([^)\n]{1,200}\))?(?:, never_failed=(true|false|null))?(?:, verdict_disagreements=(\d{1,15}|not measured|null))?$/gm,
  isRow: (l) => l.startsWith('- ') && /: n=\d{1,15}(?: \(|, never_failed|, verdict_disagreements)/.test(l),
  names: ['n', 'never failed', 'verdict disagreements'],
  split: (m) => ({ key: m[1], got: [Number(m[2]), m[3] ?? '', m[4] ?? ''] }),
  rows: (col) => new Map(shownNeverFailing(col).map((a) => [`${a.repo}/${a.spec} ${a.ac_id}`, neverFailingText(a)])),
}

const NEVER_FAILING_LEFT_OUT = {
  name: 'never-failing',
  re: /^(\d{1,15}) criteria rows left out as insufficient data$/gm,
  isRow: (l) => /^\S{1,20} criteria rows left out/.test(l),
  names: ['rows left out'],
  split: (m) => ({ key: 'left out', got: [Number(m[1])] }),
  rows: (col) => {
    const leftOut = (ledgerDigest(col).neverFailingInsufficientCount ?? 0) + carriedNeverFailing(col).length - shownNeverFailing(col).length
    return leftOut > 0 ? new Map([['left out', [leftOut]]]) : new Map()
  },
}

// A per-repository ledger row carries a label the digest does not share (the workflow's own), so these rows are matched in order.
const instrumentedRepos = (col) => (Array.isArray(ledgerDigest(col).perRepo) ? ledgerDigest(col).perRepo : []).filter((e) => !e?.uninstrumented)
const LEDGER_REPOSITORY = {
  name: 'ledger repository',
  re: /^- ([^\n]{1,500}?): (\d{1,15}) record\(s\) in window, skipped=(\d{1,15}), /gm,
  isRow: (l) => l.startsWith('- ') && l.includes(' record(s) in window'),
  names: ['records', 'skipped'],
  byPosition: true,
  split: (m) => ({ got: [Number(m[2]), Number(m[3])] }),
  rows: (col) => new Map(instrumentedRepos(col).map((e, i) => [String(i), [e.recordCount, e.skippedCount ?? 0]])),
}

const LEDGER_SKIPPED = {
  name: 'ledger repository',
  re: /^(\d{1,15}) ledger line\(s\) were skipped as unparseable/gm,
  isRow: (l) => /^\S{1,20} ledger line\(s\) were skipped/.test(l),
  names: ['skipped'],
  split: (m) => ({ key: 'skipped', got: [Number(m[1])] }),
  rows: (col) => (ledgerDigest(col).skippedCount > 0 ? new Map([['skipped', [ledgerDigest(col).skippedCount]]]) : new Map()),
}

const TRIGGER_ACCURACY = {
  name: 'trigger accuracy',
  re: /^- ([^\n]{1,500}?): clean_zero_trigger=(\d{1,15}), clean_with_matches=(\d{1,15}), findings=(\d{1,15}), clean_trigger_unmeasured=(\d{1,15}), total=(\d{1,15})$/gm,
  isRow: (l) => l.startsWith('- ') && l.includes(': clean_zero_trigger='),
  names: ['clean zero trigger', 'clean with matches', 'findings', 'clean trigger unmeasured', 'total'],
  split: (m) => ({ key: m[1], got: m.slice(2).map(Number) }),
  rows: (col) => new Map(entriesOf(ledgerDigest(col).triggerAccuracy?.byLens).map(([k, b]) => [k, [b?.cleanWithZeroTrigger, b?.cleanWithMatches, b?.findingsWithMatches, b?.cleanTriggerUnmeasured || 0, b?.total]])),
}

const REWORK = {
  name: 'rework',
  re: /^- ([^\n]{1,500}?): fixed=(\d{1,15}), rejected=(\d{1,15}), spec_bug=(\d{1,15}), open=(\d{1,15})$/gm,
  isRow: (l) => l.startsWith('- ') && /: fixed=\d/.test(l),
  names: ['fixed', 'rejected', 'spec bug', 'open'],
  split: (m) => ({ key: m[1], got: m.slice(2).map(Number) }),
  rows: (col) => new Map(entriesOf(ledgerDigest(col).rework?.lensDispositionCounts).map(([k, c]) => [k, [c?.fixed, c?.rejected, c?.spec_bug, c?.open]])),
}

const rework = (col) => (isObject(ledgerDigest(col).rework) ? ledgerDigest(col).rework : {})
const wallTotals = (col) => (isObject(ledgerDigest(col).wallClock?.totals) ? ledgerDigest(col).wallClock.totals : {})

const EXCLUDED_FROM_ATTRIBUTION = {
  name: 'attribution counters',
  re: new RegExp(String.raw`^Excluded from attribution \(never silently dropped\): unattributable runs=${COUNT}, degraded-unattributed runs=${COUNT}, unattributable ci_wait/human_wait observations=${COUNT}, unattributable rework records=${COUNT}\.$`, 'gm'),
  isRow: (l) => l.startsWith('Excluded from attribution'),
  names: ['unattributable runs', 'degraded-unattributed runs', 'unattributable waits', 'unattributable rework records'],
  split: (m) => ({ key: 'excluded', got: m.slice(1).map(Number) }),
  rows: (col) => new Map([['excluded', [wallTotals(col).unattributableRuns ?? 0, wallTotals(col).degradedUnattributedRuns ?? 0, wallTotals(col).unattributableWaits ?? 0, rework(col).unattributableCount ?? 0]]]),
}

// The sanitiser's dropped-value counters, one line each: label -> the digest field it reports.
const DROPPED_COUNTERS = {
  invalid_ac_ids_dropped: 'invalidAcIdsDropped',
  invalid_record_values_dropped: 'invalidRecordValuesDropped',
  invalid_fixed_ids_dropped: 'invalidFixedIdsDropped',
  duplicate_fixed_ids_dropped: 'duplicateFixedIdsDropped',
  'duplicate fixed confirmations across rounds': 'duplicateFixedAcrossRounds',
  invalid_prior_ids_dropped: 'invalidPriorIdsDropped',
}
const DROPPED_COUNTER = {
  name: 'dropped counters',
  re: /^(invalid_ac_ids_dropped|invalid_record_values_dropped|invalid_fixed_ids_dropped|duplicate_fixed_ids_dropped|duplicate fixed confirmations across rounds|invalid_prior_ids_dropped) \([^)\n]{1,300}\): (\d{1,15}|null|unavailable \([^)\n]{1,100}\))\.$/gm,
  isRow: (l) => /^(?:invalid_\w{1,40}_dropped|duplicate_fixed_ids_dropped|duplicate fixed confirmations)/.test(l),
  names: ['dropped count'],
  split: (m) => ({ key: m[1], got: [/^\d+$/.test(m[2]) ? Number(m[2]) : null] }),
  rows: (col) => new Map(Object.entries(DROPPED_COUNTERS).map(([label, field]) => [label, [numOrNull(rework(col)[field])]])),
}

const ORPHANED_RUNS = {
  name: 'orphaned runs',
  re: new RegExp(String.raw`^Orphaned agent-compute runs \(never silently collapsed into one number\): start-only=(\d{1,15}|unavailable \([^)\n]{1,100}\)) \(by kind: [^)\n]{1,300}\), terminal-only=(\d{1,15}|unavailable \([^)\n]{1,100}\)) \(by kind: [^)\n]{1,300}\)\.$`, 'gm'),
  isRow: (l) => l.startsWith('Orphaned agent-compute runs'),
  names: ['start-only', 'terminal-only'],
  split: (m) => ({ key: 'orphaned', got: [m[1], m[2]].map((x) => (/^\d+$/.test(x) ? Number(x) : null)) }),
  rows: (col) => new Map([['orphaned', [numOrNull(wallTotals(col).agentComputeStartOnlyRuns), numOrNull(wallTotals(col).agentComputeTerminalOnlyRuns)]]]),
}

// ---- the remaining figure lines: rework counters, blocked TDD runs, suppression shares, sources, the plan-label note ----

// The workflow prints a count it was given as a number, `null`, or an "unavailable" marker for a reader that predates the field;
// a split figure also prints `not recorded` for null. These are compared as the fixed words they are, never as session text.
const COUNTISH = String.raw`(\d{1,15}|null|unavailable \([^)\n]{1,100}\))`
const SPLITISH = String.raw`(\d{1,15}|not recorded|unavailable \([^)\n]{1,100}\))`
const wordOf = (x) => (x.startsWith('unavailable') ? 'unavailable' : x)
const fmtCount = (v) => (v === undefined ? 'unavailable' : String(v))
function fmtSplit(v) {
  if (v === undefined) return 'unavailable'
  return v === null ? 'not recorded' : String(v)
}
const fmtV4 = (v) => (v === null || v === undefined ? 'not recorded' : String(v))
const reworkOf = (col) => (isObject(ledgerDigest(col).rework) ? ledgerDigest(col).rework : null)

const REWORK_FINDINGS_DROPPED = {
  name: 'rework counters',
  re: new RegExp(String.raw`^findings dropped from this tally: findings_truncated=${COUNTISH} \(findings the writer counted but could not fit on the line; the per-lens rows above are short by this many\), ac_verdicts_truncated=${COUNTISH}, unattributed \(lens value did not match a known lens\)=${COUNTISH}\.$`, 'gm'),
  isRow: (l) => l.startsWith('findings dropped from this tally'),
  names: ['findings truncated', 'ac verdicts truncated', 'unattributed findings'],
  textual: true,
  split: (m) => ({ key: 'dropped', got: m.slice(1, 4).map(wordOf) }),
  rows: (col) => {
    const r = reworkOf(col)
    return r === null ? new Map() : new Map([['dropped', [fmtCount(r.findingsTruncated), fmtCount(r.acVerdictsTruncated), fmtCount(r.unattributedFindings)]]])
  },
}

const REWORK_NO_SPEC = {
  name: 'rework counters',
  re: new RegExp(String.raw`^No-spec review runs in window: ${COUNTISH} \(conducted=${SPLITISH}, direct=${SPLITISH}, round not recorded=${SPLITISH}\) \(findings reclassified from spec_bug to open on those runs: ${COUNTISH}\)\. Completed review runs carrying a conductor round, any spec: ${SPLITISH}\.$`, 'gm'),
  isRow: (l) => l.startsWith('No-spec review runs in window'),
  names: ['no-spec review runs', 'conducted', 'direct', 'round not recorded', 'reclassified findings', 'review runs with a round'],
  textual: true,
  split: (m) => ({ key: 'no-spec', got: m.slice(1, 7).map(wordOf) }),
  rows: (col) => {
    const r = reworkOf(col)
    return r === null ? new Map() : new Map([['no-spec', [fmtCount(r.noSpecReviewRuns), fmtSplit(r.noSpecReviewRunsConducted), fmtSplit(r.noSpecReviewRunsDirect), fmtSplit(r.noSpecReviewRunsRoundNotRecorded), fmtCount(r.noSpecFindingsReclassified), fmtSplit(r.reviewRunsWithRound)]]])
  },
}

const V4 = String.raw`(\d{1,15}|not recorded)`
const REWORK_SCHEMA_V4 = {
  name: 'rework counters',
  re: new RegExp(String.raw`^Completeness, schema_version >= 4 rows only(?: \(${COUNT} rows; ${COUNT} older rows excluded\): findings_truncated=${V4}, unattributed findings=${V4}, duplicate verdict groups collapsed=${V4}, no-spec review runs=${V4}, no-spec review runs conducted=${V4}, direct=${V4}, round not recorded=${V4}\. Completed review runs carrying a conductor round, any spec: ${V4}\.|: not recorded \(no such rows; ${COUNT} older rows excluded\)\.)$`, 'gm'),
  isRow: (l) => l.startsWith('Completeness, schema_version >= 4'),
  names: ['schema v4 rows', 'schema v4 older rows', 'findings truncated', 'unattributed findings', 'duplicate verdict groups', 'no-spec review runs', 'no-spec review runs conducted', 'direct', 'round not recorded', 'review runs with a round'],
  textual: false,
  split: (m) => (m[1] === undefined ? { key: 'v4', got: ['0', m[11]].map(String) } : { key: 'v4', got: m.slice(1, 11).map(String) }),
  rows: (col) => {
    const v4 = reworkOf(col)?.schemaV4
    if (!isObject(v4)) return new Map()
    const rows = isCount(v4.rows) && v4.rows > 0
    const figures = rows ? [v4.findingsTruncated, v4.unattributedFindings, v4.duplicateVerdictPairs, v4.noSpecReviewRuns, v4.noSpecReviewRunsConducted, v4.noSpecReviewRunsDirect, v4.noSpecReviewRunsRoundNotRecorded, v4.reviewRunsWithRound].map(fmtV4) : []
    return new Map([['v4', [String(rows ? v4.rows : 0), String(v4.excludedRows), ...figures]]])
  },
}

const blockedOf = (col) => (isObject(ledgerDigest(col).blockedUnresolved) ? ledgerDigest(col).blockedUnresolved : null)
const BLOCKED_COUNT = {
  name: 'blocked tdd',
  re: /^Blocked TDD runs unresolved in window \(upper bound: a task finished by hand leaves no resolution row\): (\d{1,15})$/gm,
  isRow: (l) => l.startsWith('Blocked TDD runs unresolved in window (') && !/: not measured \((?:ledger unavailable|installed reader predates this metric)\)$/.test(l),
  names: ['unresolved'],
  split: (m) => ({ key: 'count', got: [Number(m[1])] }),
  rows: (col) => (isCount(blockedOf(col)?.count) ? new Map([['count', [blockedOf(col).count]]]) : new Map()),
}
// The blocked runs whose reason was recorded: the sum of the per-reason counts, or `not recorded` when there are none to sum.
function recordedReasons(byReason) {
  if (!isObject(byReason)) return 'not recorded'
  return Object.values(byReason).reduce((acc, v) => acc + (isCount(v) ? v : 0), 0)
}
const BLOCKED_REASONS = {
  name: 'blocked tdd',
  re: /^Blocked TDD runs unresolved, reason recorded \(post-T5\): (\d{1,15}|not recorded); not recorded \(pre-T5\): (\d{1,15}|not recorded)\.$/gm,
  isRow: (l) => l.startsWith('Blocked TDD runs unresolved, reason recorded'),
  names: ['reason recorded', 'not recorded'],
  split: (m) => ({ key: 'reasons', got: [m[1], m[2]] }),
  rows: (col) => {
    const b = blockedOf(col)
    if (!isCount(b?.count)) return new Map()
    const recorded = recordedReasons(b.byReason)
    return new Map([['reasons', [String(recorded), isCount(b.reasonNotRecorded) ? String(b.reasonNotRecorded) : 'not recorded']]])
  },
}

const UNTERMINATED_TOTAL = {
  name: 'wall-clock unterminated',
  re: /^unterminated_waits: (\d{1,15})$/gm,
  isRow: (l) => l.startsWith('unterminated_waits: '),
  names: ['unterminated waits'],
  split: (m) => ({ key: 'total', got: [Number(m[1])] }),
  rows: (col) => (wallTotals(col).unterminatedWaits ? new Map([['total', [wallTotals(col).unterminatedWaits]]]) : new Map()),
}

const SEGMENTS = { ci_wait: 'ciWait', human_wait: 'humanWait', agent_compute: 'agentCompute' }
const SUPPRESSION_SHARE = {
  name: 'filtering',
  re: /^(ci_wait|human_wait|agent_compute): (\d{1,15})\/(\d{1,15}) runs unmeasured \((\d{1,3})%\) -- (?:at\/above|below) the 20% suppression threshold(?:: wall-clock proposals citing this segment are suppressed)?$/gm,
  isRow: (l) => /^(?:ci_wait|human_wait|agent_compute): /.test(l) && l.includes(' runs unmeasured '),
  names: ['unmeasured', 'total', 'percent'],
  split: (m) => ({ key: m[1], got: [Number(m[2]), Number(m[3]), Number(m[4])] }),
  rows: (col) => {
    const t = wallTotals(col)
    return new Map(Object.entries(SEGMENTS).filter(([, p]) => isCount(t[`${p}UnmeasuredRuns`]) && isCount(t[`${p}MeasuredRuns`])).map(([seg, p]) => {
      const unmeasured = t[`${p}UnmeasuredRuns`]
      const total = unmeasured + t[`${p}MeasuredRuns`]
      return [seg, [unmeasured, total, total > 0 ? Math.floor((unmeasured / total) * 100) : 0]]
    }))
  },
}

const WALL_CLOCK_SOURCES = {
  name: 'wall-clock sources',
  re: /^Sources: ci_wait=([^\n]{1,300}), human_wait=([^\n]{1,300}), agent_compute=([^\n]{1,300})\.$/gm,
  isRow: (l) => l.startsWith('Sources: '),
  names: ['ci wait source', 'human wait source', 'agent compute source'],
  textual: true,
  split: (m) => ({ key: 'sources', got: [m[1], m[2], m[3]] }),
  rows: (col) => {
    const src = ledgerDigest(col).wallClock?.source
    return isObject(src) ? new Map([['sources', [String(src.ci_wait), String(src.human_wait), String(src.agent_compute)]]]) : new Map()
  },
}

function formatByKind(byKind) {
  const entries = entriesOf(byKind)
  return entries.length > 0 ? entries.map(([k, n]) => `${k}: ${n}`).join(', ') : 'none'
}
const ORPHANED_KINDS = {
  name: 'orphaned runs',
  re: /^Orphaned agent-compute runs \(never silently collapsed into one number\): start-only=[^(\n]{1,120}(?:\([^)\n]{1,100}\))? \(by kind: ([^)\n]{1,300})\), terminal-only=[^(\n]{1,120}(?:\([^)\n]{1,100}\))? \(by kind: ([^)\n]{1,300})\)\.$/gm,
  isRow: (l) => l.startsWith('Orphaned agent-compute runs'),
  names: ['start-only by kind', 'terminal-only by kind'],
  textual: true,
  split: (m) => ({ key: 'kinds', got: [m[1], m[2]] }),
  rows: (col) => new Map([['kinds', [formatByKind(wallTotals(col).agentComputeStartOnlyByKind), formatByKind(wallTotals(col).agentComputeTerminalOnlyByKind)]]]),
}

const ROW_CLASSES = [CI_JOB, CI_REPOSITORY, GH_CALLS, WALL_CLOCK_PLAN, WALL_CLOCK_TOTALS, NEVER_FAILING, NEVER_FAILING_LEFT_OUT, LEDGER_REPOSITORY, LEDGER_SKIPPED, TRIGGER_ACCURACY, REWORK, EXCLUDED_FROM_ATTRIBUTION, DROPPED_COUNTER, ORPHANED_RUNS, ORPHANED_KINDS, REWORK_FINDINGS_DROPPED, REWORK_NO_SPEC, REWORK_SCHEMA_V4, BLOCKED_COUNT, BLOCKED_REASONS, UNTERMINATED_TOTAL, SUPPRESSION_SHARE, WALL_CLOCK_SOURCES]

function checkRowClass(spec, report, col) {
  const wants = spec.rows(col)
  const reasons = []
  const seen = new Set()
  const matches = [...report.matchAll(spec.re)]
  matches.forEach((m, index) => {
    const parsed = spec.split(m)
    const key = spec.byPosition ? String(index) : parsed.key
    const want = wants.get(key)
    if (want === undefined) {
      reasons.push(`figure mismatch ${spec.name}: a row the collected data does not hold`)
      return
    }
    seen.add(key)
    const diff = firstDifference(spec.names, want, parsed.got)
    if (diff) reasons.push(spec.textual ? `figure mismatch ${spec.name}: ${diff.name} differs from the collected one` : `figure mismatch ${spec.name}: ${diff.name} collected ${diff.want}, reported ${diff.got}`)
  })
  for (const [key, want] of wants) if (!seen.has(key)) reasons.push(`figure mismatch ${spec.name}: ${spec.names[0]} collected ${want[0]}, reported none`)
  if (report.split('\n').filter(spec.isRow).length !== matches.length) reasons.push(`figure mismatch ${spec.name}: a row in a shape the check does not know`)
  return reasons
}

// The proposal a line belongs to: a `### <id>: ...` heading or a `- <id>: ...` bullet starts one, a `## ` heading ends it.
function proposalIdAfter(line, current) {
  if (line.startsWith('## ')) return null
  const heading = /^(?:### |- )(\w{1,64}): /.exec(line)
  return heading ? heading[1] : current
}

// The adoption or rejection date an annotation line states, or null for any other line.
function dateClaimIn(line) {
  const adopted = /^Already adopted on (.{1,64})\.$/.exec(line)
  if (adopted) return { kind: 'adoption', ts: adopted[1] }
  const rejected = /^\*\*Previously rejected on (.{1,64})\.\*\*$/.exec(line)
  return rejected ? { kind: 'rejection', ts: rejected[1] } : null
}

function outcomeProblem(claim, outcome) {
  const held = claim.kind === 'adoption' ? outcome.lastAdoptionTs : outcome.lastRejectionTs
  return held === claim.ts ? null : `figure mismatch proposal outcome: ${claim.kind} date differs from the collected one`
}

// The recorded adoption and rejection dates a proposal's annotation shows, held to the outcome the ledger holds for that id.
export function checkProposalOutcomes(report, col) {
  const outcomes = ledgerDigest(col).proposalOutcomes
  const reasons = []
  let id = null
  for (const line of report.split('\n')) {
    id = proposalIdAfter(line, id)
    const claim = dateClaimIn(line)
    if (claim === null) continue
    const held = id !== null && isObject(outcomes) && Object.hasOwn(outcomes, id) ? outcomes[id] : null
    const problem = held === null ? 'figure mismatch proposal outcome: an outcome the collected data does not hold' : outcomeProblem(claim, held)
    if (problem !== null) reasons.push(problem)
  }
  return reasons
}

// The note the collector wrote about plan labels it left out is printed verbatim (flattened); the report must carry exactly it.
export function checkPlanLabelNote(report, col) {
  const note = col.digest?.plan_labels_note
  if (typeof note !== 'string' || note.trim() === '') return []
  const expected = note.replaceAll(/\s+/g, ' ').slice(0, 400)
  return report.split('\n').includes(expected) ? [] : ['figure mismatch plan labels: note differs from the collected one']
}

// The single-line figure shapes that are not row classes: each has its own check above.
const SINGLE_LINE_SHAPES = [/^Ledger records in window: /, /^CI runs: /, /^Raw \(unscoped\): /, /^Scoped to product source /, /^Digest omitted /, /^Digest trimmed for size: /]

// Whether some check in this module looks at the line (so a figure on it cannot change in transit unseen). The coverage test
// in test/optimise-verify.test.js renders the real report and requires every line with a digit to be checked or to be on its
// explicit list of deliberately unchecked shapes, so a new numeric line in the workflow fails that test until it is one or the other.
export function isCheckedLine(line, col) {
  if (SINGLE_LINE_SHAPES.some((shape) => shape.test(line)) || ROW_CLASSES.some((spec) => spec.isRow(line)) || dateClaimIn(line) !== null) return true
  const note = col.digest?.plan_labels_note
  return typeof note === 'string' && note.trim() !== '' && line === note.replaceAll(/\s+/g, ' ').slice(0, 400)
}

export function checkRows(report, col) {
  return [...ROW_CLASSES.flatMap((spec) => checkRowClass(spec, report, col)), ...checkScoped(report, col), ...checkProposalOutcomes(report, col), ...checkPlanLabelNote(report, col)]
}

// { reasons, reportedLedger }: every figure in the report against the collected files.
export function checkFigures(result, report, col) {
  const ledger = checkLedger(report, col)
  const reasons = [...checkLanes(result.lanes, col), ...ledger.reasons, ...checkCi(report, col), ...checkGit(report, col), ...checkDigest(report, col), ...checkRows(report, col)]
  return { reasons, reportedLedger: ledger.reported }
}

// ---- the sidecar: the only copy of the id-to-target map for decided proposals ----

// The returned sidecar merged into the one on disk, so no entry is ever lost: every prior entry the returned one lacks is
// kept, a returned entry is added or replaces the prior one and counts as the newest, and only past `max` do the oldest
// go. The file carries no age, so age is insertion order: the order of the keys in the JSON file.
export function mergeSidecar(existing, returned, max = SIDECAR_CARRY_MAX) {
  const merged = new Map(Object.entries(existing))
  for (const [id, target] of Object.entries(returned)) {
    merged.delete(id)
    merged.set(id, target)
  }
  const keys = [...merged.keys()]
  return Object.fromEntries(keys.slice(Math.max(0, keys.length - max)).map((k) => [k, merged.get(k)]))
}

const sidecarText = (obj) => JSON.stringify(obj, null, 2) + '\n'

// The merged sidecar, shrunk oldest-first until it fits the size cap (it cannot be placed over it).
export function fitSidecar(merged) {
  const keys = Object.keys(merged)
  const from = (n) => Object.fromEntries(keys.slice(n).map((k) => [k, merged[k]]))
  let n = 0
  while (n < keys.length && Buffer.byteLength(sidecarText(from(n)), 'utf8') > SIDECAR_CAP) n += 1
  return from(n)
}

// { entries } the sidecar on disk (an absent one is empty), or { reason } when it exists and cannot be read as a JSON object.
export function readExistingSidecar(root) {
  const got = readRepoFile(root, SIDECAR_REL, SIDECAR_CAP)
  if (got.status === 'absent') return { entries: {} }
  if (got.status !== 'ok') return { reason: SIDECAR_UNREADABLE }
  try {
    const parsed = JSON.parse(got.text)
    return isObject(parsed) ? { entries: parsed } : { reason: SIDECAR_UNREADABLE }
  } catch {
    return { reason: SIDECAR_UNREADABLE }
  }
}

// ---- the returned sidecar is session output: validated before it touches the on-disk one (H1) ----
//
// The on-disk sidecar is the only copy of the id-to-target map for decided proposals, so what the session returns is
// admitted entry by entry, and one entry that fails any rule fails the run (nothing placed, the file untouched):
//   1. the key is a proposal id, 16 lower-case hex characters (so `__proto__`, `constructor` and made-up words are out);
//   2. the value is a target in the reader's fixed shape (the reader's own rule, imported, not copied);
//   3. the value hashes, by the reader's stableProposalId, to its key (so a real target cannot sit under another id);
//   4. the id is one this run names: a `### <id>:` heading or `- <id>:` bullet in its report, or an outcome the ledger
//      holds. A flood of made-up ids, or a decided id's value swapped, therefore cannot get in.
// Eviction follows from these rules: a returned entry can only be one of the ids rule 4 names, so the number of on-disk
// entries it can push out (only when the file is already at SIDECAR_CARRY_MAX, oldest first) is at most the number of
// such ids, and never more than the entries it adds (pinned in test/optimise-verify.test.js).
const PROPOSAL_ID = /^[0-9a-f]{16}$/

// The proposal ids this run names: report headings and bullets, and the ledger's recorded outcomes (carried through the digest).
export function namedProposalIds(report, col) {
  const ids = new Set([...report.matchAll(/^(?:### |- )([0-9a-f]{16}): /gm)].map((m) => m[1]))
  const outcomes = ledgerDigest(col).proposalOutcomes
  for (const id of isObject(outcomes) ? Object.keys(outcomes) : []) ids.add(id)
  return ids
}

// null when every entry passes, else the one fixed reason for the first that does not.
export function validateReturnedSidecar(targets, named) {
  for (const [id, value] of Object.entries(targets)) {
    if (!PROPOSAL_ID.test(id)) return 'returned sidecar has a key that is not a proposal id'
    if (sidecarTargetOrReason(value).target === undefined) return 'returned sidecar has a target that is not the fixed shape'
    if (stableProposalId(value) !== id) return 'returned sidecar has a target that does not hash to its id'
    if (!named.has(id)) return 'returned sidecar has an id this run does not name'
  }
  return null
}

// ---- the nonce the session passed on (H2) ----

// The result must carry the SHA-256 of the nonce the runner minted for this run (given to this process in its environment,
// never in its arguments), so a session steered by text in the digest into passing another nonce, or a result that did not
// come from a workflow run on this run's digest, is refused. null when it matches, else the one fixed reason.
export function nonceProblem(result, nonce) {
  if (typeof result.nonce_sha256 !== 'string') return 'result carries no nonce hash'
  const want = createHash('sha256').update(typeof nonce === 'string' ? nonce : '').digest('hex')
  return result.nonce_sha256 === want && typeof nonce === 'string' && nonce !== '' ? null : 'result nonce hash does not match this run'
}

// ---- the whole check ----

function lanesThatCouldNotRun(col) {
  return LANES.filter((name) => laneState(col, name) === 'failed').map((name) => `${name} lane could not run: ${modeToken(col.lane[name].mode)}`)
}

function readSession(sessionPath) {
  const got = readRepoFile(path.dirname(sessionPath), path.basename(sessionPath), FILE_CAP)
  if (got.status === 'ok') return { text: got.text }
  return { reason: 'session output: not a JSON envelope', cause: got.status === 'too_large' ? 'oversized' : 'malformed' }
}

// What a session's reply amounts to: { reasons, cause, denied, reportedLedger, place, report, sidecar, targets }.
function judgeSession(sessionPath, col, strict, bounded, nonce) {
  const out = { reasons: [], denied: 'unknown', tools: 'none', reportedLedger: null, place: 'no' }
  const read = readSession(sessionPath)
  const parsed = read.reason ? read : parseSession(read.text)
  if (parsed.reason) return { ...out, denied: parsed.denied, tools: parsed.tools, reasons: [parsed.reason], cause: parsed.cause }
  const checked = checkResult(parsed.result, strict, bounded)
  if (checked.reason) return { ...out, denied: parsed.denied, tools: parsed.tools, reasons: [checked.reason], cause: checked.cause }
  const wrongNonce = nonceProblem(parsed.result, nonce)
  if (wrongNonce !== null) return { ...out, denied: parsed.denied, tools: parsed.tools, reasons: [wrongNonce], cause: 'nonce' }
  const figures = checkFigures(parsed.result, checked.report, col)
  const reasons = figures.reasons.length === 0 ? lanesThatCouldNotRun(col) : figures.reasons
  return { ...out, denied: parsed.denied, tools: parsed.tools, reasons, reportedLedger: figures.reportedLedger, place: figures.reasons.length === 0 ? 'yes' : 'no', report: checked.report, sidecar: checked.sidecar, targets: checked.targets }
}

// A trusted result's sidecar is validated (H1), then merged into the one on disk. One that fails a rule, or an on-disk one
// that cannot be read, stops the run: nothing is placed.
function withMergedSidecar(judged, sidecarRoot, col) {
  if (judged.place !== 'yes') return judged
  const invalid = validateReturnedSidecar(judged.targets, namedProposalIds(judged.report, col))
  if (invalid !== null) return { ...judged, reasons: [invalid], place: 'no' }
  if (!sidecarRoot || sidecarRoot === '-') return judged
  const existing = readExistingSidecar(sidecarRoot)
  if (existing.reason) return { ...judged, reasons: [existing.reason], place: 'no' }
  return { ...judged, sidecar: sidecarText(fitSidecar(mergeSidecar(existing.entries, judged.targets))) }
}

// { tokens, denied, cause, reasons, place, report, sidecar }. `sessionPath` of '-' means no session ran.
export function verifyRun({ dir, sessionPath, digestToken, repo, runTmp, home, sidecarRoot, nonce }) {
  const col = loadCollected(dir)
  const strict = pathNeedles([home, dir, runTmp])
  const bounded = pathNeedles([repo])
  const judged = sessionPath === '-' ? { reasons: [], denied: 'unknown', reportedLedger: null, place: 'no' } : withMergedSidecar(judgeSession(sessionPath, col, strict, bounded, nonce), sidecarRoot, col)
  return { ...judged, tokens: tokensFor(col, digestToken, judged.reportedLedger) }
}

// The returned report decides how many reasons a bad result produces, so the number printed, and each one's length, are
// bounded here: duplicates collapse, the first MAX_REASONS are printed, and the rest are counted as `more_reasons:<n>`.
export const MAX_REASONS = 8
export const MAX_REASON_CHARS = 300

export function cappedReasons(reasons) {
  const distinct = [...new Set(reasons)]
  const shown = distinct.slice(0, MAX_REASONS).map((r) => r.slice(0, MAX_REASON_CHARS))
  return distinct.length > MAX_REASONS ? [...shown, `more_reasons:${distinct.length - MAX_REASONS}`] : shown
}

export function formatVerdict(v) {
  return [`TOKENS ${v.tokens}`, `DENIED ${v.denied}`, ...(v.tools === undefined ? [] : [`TOOLS ${v.tools}`]), ...(v.cause ? [`CAUSE ${v.cause}`] : []), ...cappedReasons(v.reasons).map((r) => `REASON ${r}`), `PLACE ${v.place}`].join('\n') + '\n'
}

function main(argv) {
  const [dir, sessionPath, digestToken, repo, runTmp, sidecarRoot] = argv
  const v = verifyRun({ dir, sessionPath, digestToken, repo, runTmp, home: process.env.HOME, sidecarRoot, nonce: process.env.OPTIMISE_VERIFY_NONCE })
  if (v.place === 'yes') {
    fs.writeFileSync(`${dir}/result-report.md`, v.report, { mode: 0o600 })
    fs.writeFileSync(`${dir}/result-sidecar.json`, v.sidecar, { mode: 0o600 })
  }
  process.stdout.write(formatVerdict(v))
}

// Compared by real path: import.meta.url is the real file, argv[1] may be reached through a symlink (an install whose
// ~/.claude is a link), and a lexical comparison then silently runs nothing.
function isMainModule() {
  try {
    return Boolean(process.argv[1]) && fileURLToPath(import.meta.url) === fs.realpathSync(path.resolve(process.argv[1]))
  } catch {
    return false
  }
}
const isMain = isMainModule()
if (isMain) main(process.argv.slice(2))
