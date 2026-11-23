#!/usr/bin/env node
// The weekly runner's result check (HARN-RUNNER-2 T3): what the session returned, held against the files the
// runner collected. It was a program inside a bash heredoc; it is a module so each rule can be tested on its own
// (AC-ARCH-6) and so the attended path can use the same rules (T4).
//
// Command line, as the runner calls it:
//   optimise-verify.mjs <per-run dir> <session reply file, or -> <digest token> <repository> <runner temp dir>
//                       <sidecar root, or ->
// and the other forms, which the runner and the attended /optimise-cycle share so that neither has a second copy of the
// lock or of the placement (HARN-RUNNER-2 T4, AC-DATA-2):
//   (when the outputs were placed it prints PLACED yes after PLACE yes, which the runner requires before it believes a placement)
//   optimise-verify.mjs settle <per-run dir> <session reply file> <digest token> <repository> <runner temp dir> <main checkout> <place|withheld>
//        the runner's whole critical section in one run: wait for the sidecar lock, read, validate and merge the sidecar, place the
//        two outputs in the main checkout (not when withheld) and release the lock. It places only when the per-run directory holds the
//        proof `optimise-report-ignore.mjs prepare` wrote for this main checkout (ignore-proof.json, consumed when used); a trusted
//        result with no proof is printed as `HELD ignore-proof` (the runner then prepares and calls again) and is a FAIL for the attended entry
//   OPTIMISE_VERIFY_NONCE=<nonce> optimise-verify.mjs attended <per-run dir> <result file> <repository> <main checkout>
//        the attended entry: the same critical section (settleRun), for the object the Workflow tool returned, saved unchanged.
//        <main checkout> is the root the skill resolved for <repository> (the repository itself, or the main checkout of a linked
//        worktree); it is checked against the repository before anything is read or written, and both outputs are placed there
// (the per-run directory is physical; the runner temp dir is the same directory as first made, so a path spelled
// either way is caught; the sidecar root is the checkout whose .claude/ holds the proposal-targets sidecar)
// It prints fixed-vocabulary lines only: TOKENS (the figures for the RESULT line), DENIED, CAUSE (a session
// failure's class), NOTICE (a fixed token for something the lock code had to report), one REASON per problem and PLACE yes|no
// (the attended entry prints a VERDICT line first). It never prints a word the session said, or a path.
// When the result is trusted (or the only problem is a lane that could not run) it writes result-report.md and
// result-sidecar.json into the per-run directory, ready for the runner to place. The sidecar it writes is the
// returned one MERGED into the one on disk: the sidecar is the only copy of the id-to-target map for decided
// proposals, so a run never loses an entry from it (mergeSidecar).
//
// Spawn-free, and read-only toward everything but those two files: every read goes through the reader's guarded
// helper (readRepoFile: no symlink, regular file, size cap), like the collector's reads of collected files, and a
// static test fails if this file imports child_process or reads any other way. The result check itself writes only
// those two files. The critical section (settleRun, which the runner's settle form and the attended entry both call) also
// writes the sidecar lock, the staged temp files and the two outputs. It runs no git: making the two output paths ignored, and
// confirming it, is the caller's step before it is called (the runner's ensure_ignored, the skill's own commands).

import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ABSOLUTE_PATH_RE, LEDGER_RELATIVE_PATH, REDACTED_PATH_MARKER } from './ledger-append.mjs'
import { aggregateProposalOutcomes, canonicalJson, isPlainInsufficientRow, parseLedgerContent, readRepoFile, REPO_FILE_CAPS, resolveLedgerRoot, sidecarTargetOrReason, stableProposalId } from './optimise-read.mjs'

export const REPORT_CAP = 5242880
export const SIDECAR_CAP = 1048576
export const FILE_CAP = 67108864
// How many entries the sidecar file keeps. This module is the only place retention is decided (the workflow carries every
// outcome the digest holds and decides nothing; a test holds it to that).
export const SIDECAR_CARRY_MAX = 500
export const SIDECAR_REL = '.claude/optimise-proposal-targets.json'
export const REPORT_REL = '.claude/optimise-cycle-report.md'
export const LANES = ['ledger', 'git', 'ci']

// BEGIN FIXED REASONS
// Every reason this module can print, spelled once. The README's runbook has a row for each (a test holds the two to each other
// in both directions, and holds this file to this list: a reason-shaped string anywhere else fails it). A reason that starts with
// a name or a figure is listed by the words that follow it, and one with a placeholder (<n>) is filled by fill(). The code takes
// every reason from here through F (below).
export const FIXED_REASONS = Object.freeze({
  SESSION_EMPTY: 'session output: empty',
  SESSION_NOT_ENVELOPE: 'session output: not a JSON envelope',
  SESSION_NO_RESULT: 'session output: envelope has no result',
  SESSION_NOT_OBJECT: 'session output: result is not a JSON object',
  NO_LANES: 'session output: result has no lanes',
  NO_REPORT: 'session output: result has no report',
  REPORT_NOT_STRING: 'session output: report is not a string',
  FAILED_STEP: 'session returned failed_step',
  WORKFLOW_REFUSED: 'workflow refused to run',
  NO_HEADING: 'report does not start with a markdown heading',
  NUL_BYTE: 'report contains a NUL byte',
  NOT_UTF8: 'report is not valid UTF-8',
  OVER_CAP: 'report is <n> bytes, over the <cap> cap',
  SIDECAR_MISSING: 'sidecar missing',
  SIDECAR_NOT_OBJECT: 'sidecar is not a JSON object',
  SIDECAR_OVER_CAP: 'sidecar is over the size cap',
  SIDECAR_MISSING_ID: 'sidecar is missing a proposal id the report names',
  SIDECAR_UNREADABLE: 'sidecar on disk cannot be read as a JSON object; left as it was',
  RETURNED_KEY: 'returned sidecar has a key that is not a proposal id',
  RETURNED_SHAPE: 'returned sidecar has a target that is not the fixed shape',
  RETURNED_HASH: 'returned sidecar has a target that does not hash to its id',
  RETURNED_UNNAMED: 'returned sidecar has an id this run does not name',
  NO_NONCE_HASH: 'result carries no nonce hash',
  NONCE_MISMATCH: 'result nonce hash does not match this run',
  NO_MAC: 'result carries no mac',
  MAC_MISMATCH: 'result mac does not match this run',
  ALWAYS_ON_PROPOSAL: 'report proposes removing an always-on lens',
  INVISIBLE: 'report contains an invisible or direction-control character',
  ODD_BACKTICKS: 'report has a line with an odd number of backticks',
  UNKNOWN_LINE: 'report has a line in a shape the check does not know',
  ABSOLUTE_PATH: 'report holds an absolute path (the home directory, the repository or the per-run directory)',
  UNREADABLE: 'collected data unreadable',
  FIGURE_MISMATCH: 'figure mismatch',
  LANE_COULD_NOT_RUN: 'lane could not run',
  REPORT_REJECTED: 'report rejected:',
  SIDECAR_REJECTED: 'sidecar rejected:',
  MOVE_FAILED: 'could not move the result into place',
  MAIN_CHECKOUT: 'main checkout does not match the repository',
  IGNORE_PROOF: 'the output paths were not confirmed ignored for this checkout',
  LOCK_BUSY: 'could not take the sidecar lock',
  LOCK_UNUSABLE: 'the sidecar lock path is not usable',
  LOCK_HELPER_FAILED: 'the sidecar lock helper failed',
})
// What follows `report rejected:` or `sidecar rejected:`: the runbook row for those two says "the rest of the line says which".
export const REASON_DETAILS = Object.freeze({
  EMPTY: 'the result file is empty',
  TOO_LARGE: 'the result file is larger than <cap> bytes',
  IS_SYMLINK: 'the result file is a symlink',
  NOT_REGULAR: 'the result path is not a regular file',
  DESTINATION: 'the destination is a symlinked directory or a directory',
  NO_DESTINATION_DIR: 'could not create the destination directory',
  NO_STAGING: 'could not stage it',
})
// The class of a session failure, printed as CAUSE <token>.
export const CAUSE_TOKENS = Object.freeze(['empty', 'malformed', 'failed_step', 'oversized', 'nonce', 'mac', 'refused'])
// Fixed tokens the lock code raises for the caller to print as NOTICE <token>.
export const NOTICE_TOKENS = Object.freeze(['lock-restore-failed', 'sidecar-referenced-evicted'])
// END FIXED REASONS

const F = FIXED_REASONS
const D = REASON_DETAILS
const fill = (template, values) => template.replaceAll(/<(\w+)>/g, (whole, name) => String(values[name]))
export const SIDECAR_UNREADABLE = F.SIDECAR_UNREADABLE

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

// The ledger figure for the line: `<collected>/<reported>` (the reported one `-` when none could be read), or the collected
// count alone when the caller passes `undefined` for the reported one (the attended entry, which has no RESULT line).
function ledgerFigure(n, reportedLedger) {
  if (n === null) return null
  if (reportedLedger === undefined) return `${n}`
  return `${n}/${reportedLedger === null ? '-' : reportedLedger}`
}

export function tokensFor(col, digestToken, reportedLedger) {
  const n = collectedLedger(col)
  const ledger = ledgerFigure(n, reportedLedger)
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
  if (text.trim() === '') return { reason: F.SESSION_EMPTY, cause: 'empty', ...empty }
  let envelope
  try {
    envelope = JSON.parse(text)
  } catch {
    return { reason: F.SESSION_NOT_ENVELOPE, cause: 'malformed', ...empty }
  }
  if (!isObject(envelope)) return { reason: F.SESSION_NOT_ENVELOPE, cause: 'malformed', ...empty }
  const denied = deniedReport(envelope)
  if (envelope.is_error === true || typeof envelope.result !== 'string' || envelope.result === '') return { reason: F.SESSION_NO_RESULT, cause: 'malformed', ...denied }
  let result
  try {
    result = JSON.parse(envelope.result)
  } catch {
    return { reason: F.SESSION_NOT_OBJECT, cause: 'malformed', ...denied }
  }
  return isObject(result) ? { result, ...denied } : { reason: F.SESSION_NOT_OBJECT, cause: 'malformed', ...denied }
}

// The attended form's input: the object the Workflow tool returned, saved unchanged, not the CLI's envelope around one.
export function parseResultObject(text) {
  const empty = { denied: 'unknown', tools: 'none' }
  if (text.trim() === '') return { reason: F.SESSION_EMPTY, cause: 'empty', ...empty }
  let value
  try {
    value = JSON.parse(text)
  } catch {
    return { reason: F.SESSION_NOT_OBJECT, cause: 'malformed', ...empty }
  }
  return isObject(value) ? { result: value, ...empty } : { reason: F.SESSION_NOT_OBJECT, cause: 'malformed', ...empty }
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
  if (!Object.hasOwn(result, 'proposal_targets')) return failure(F.SIDECAR_MISSING, 'malformed')
  if (!isObject(result.proposal_targets)) return failure(F.SIDECAR_NOT_OBJECT, 'malformed')
  const sidecar = JSON.stringify(result.proposal_targets, null, 2) + '\n'
  if (Buffer.byteLength(sidecar, 'utf8') > SIDECAR_CAP) return failure(F.SIDECAR_OVER_CAP, 'oversized')
  const ids = [...report.matchAll(/^### ([0-9a-f]{16}):/gm)].map((m) => m[1])
  if (ids.some((id) => !Object.hasOwn(result.proposal_targets, id))) return failure(F.SIDECAR_MISSING_ID, 'malformed')
  return { sidecar, targets: result.proposal_targets }
}

// Characters that show nothing (zero-width, word joiner, byte-order mark) or reorder what is shown (direction controls): a report may hold none,
// because text that reads one way and is stored another is how a line is made to look true (M1).
const INVISIBLE_RE = /[\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/u

function checkReportText(report) {
  if (typeof report !== 'string') return failure(F.REPORT_NOT_STRING, 'malformed')
  if (!startsWithHeading(report)) return failure(F.NO_HEADING, 'malformed')
  if (report.includes('\u0000')) return failure(F.NUL_BYTE, 'malformed')
  if (INVISIBLE_RE.test(report.replace(/^\ufeff/, ''))) return failure(F.INVISIBLE, 'malformed')
  if (Buffer.from(report, 'utf8').toString('utf8') !== report) return failure(F.NOT_UTF8, 'malformed')
  const bytes = Buffer.byteLength(report, 'utf8')
  return bytes > REPORT_CAP ? failure(fill(F.OVER_CAP, { n: bytes, cap: REPORT_CAP }), 'oversized') : null
}

// { report, sidecar, targets } or { reason, cause }.
export function checkResult(result, strict, bounded = []) {
  if (result.__outcome === 'aborted') return failure(F.WORKFLOW_REFUSED, 'refused')
  if (Object.hasOwn(result, 'failed_step')) {
    const step = typeof result.failed_step === 'string' && /^[a-z_]{1,32}$/.test(result.failed_step) ? ` (${result.failed_step})` : ''
    return failure(`${F.FAILED_STEP}${step}`, 'failed_step')
  }
  if (!isObject(result.lanes)) return failure(F.NO_LANES, 'malformed')
  if (!Object.hasOwn(result, 'report')) return failure(F.NO_REPORT, 'malformed')
  const reportProblem = checkReportText(result.report)
  if (reportProblem !== null) return reportProblem
  const side = checkSidecar(result, result.report)
  if (side.reason) return side
  if (holdsPath(result.report, strict, bounded) || holdsPath(side.sidecar, strict, bounded)) return failure(F.ABSOLUTE_PATH, 'malformed')
  return { report: result.report, sidecar: side.sidecar, targets: side.targets }
}

// ---- the figure checks: what the report says against what the collector wrote ----

function firstDifference(names, want, got) {
  const i = want.findIndex((w, k) => w !== got[k])
  return i < 0 ? null : { name: names[i], want: want[i], got: got[i] }
}

export function checkLanes(said, col) {
  const reasons = []
  for (const name of LANES) {
    const st = laneState(col, name)
    if (st === 'unreadable') {
      reasons.push(`${F.UNREADABLE}: ${name}`)
    } else if (!isObject(said[name]) || said[name].status !== st) {
      const was = isObject(said[name]) && (said[name].status === 'ran' || said[name].status === 'failed') ? said[name].status : 'invalid'
      reasons.push(`${F.FIGURE_MISMATCH} ${name}: lane reported ${was}, collected ${st}`)
    } else if (st === 'failed' && modeToken(said[name].mode) !== modeToken(col.lane[name].mode)) {
      reasons.push(`${F.FIGURE_MISMATCH} ${name}: lane mode reported ${modeToken(said[name].mode)}, collected ${modeToken(col.lane[name].mode)}`)
    }
  }
  return reasons
}

// ---- the report's lines: script text, with every untrusted string inside a code span (whole-branch review round 3; owner decision 2026-11-23) ----
//
// The workflow renders every string that came from a repository or a model through ONE encoder (inert, in workflows/optimise-cycle.js),
// which shows it as a Markdown inline code span: one backtick, the text with every backtick turned into an apostrophe and every line break
// into a space, one backtick. Inside a code span a Markdown viewer interprets nothing, so that text is literal: it cannot become a line of its
// own, a heading, a link, inline HTML or a measured figure. The script writes no backtick for any other purpose, so this check holds the
// report to that structurally, and positively, instead of looking for disguises:
//   - every line holds an even number of backticks (an odd count means a line was altered after the encoder ran);
//   - the SKELETON of a line is the line with each code span replaced by SPAN_TOKEN; every line's skeleton must be exactly one of the shapes
//     the script writes (FIXED_LINES, LINE_SHAPES, the headline SHAPES and the ROW_CLASSES), so anything outside a span that the script did
//     not write, an angle bracket, an ampersand, a link or a forged figure line included, fails as a line in a shape the check does not know;
//   - each headline figure is on exactly the expected number of lines of its shape, and agrees with the collected data;
//   - a row's key is read from inside its span and held to the collected data through the encoder's mirror (inertText).
// Text inside a span is never a measured figure, so a proposal may quote a headline label freely: it is shown as literal text.

// BEGIN untrusted-text encoding mirror
// The workflow's inert() without the two backticks it adds (a parity test holds the two together over a table of hostile strings).
const INERT_MAX = 300
const INERT_CUT = ' [cut]'
const INERT_EMPTY = '(empty)'
const INERT_BREAKS_RE = /[\t\n\v\f\r\u0085\u2028\u2029]/g
const INERT_REMOVED_RE = /[\u0000-\u001f\u007f-\u009f\p{Cf}\p{Cs}\ufe00-\ufe0f]/gu
export function inertText(value) {
  const text = (typeof value === 'string' ? value : String(value ?? ''))
    .replaceAll(INERT_BREAKS_RE, ' ')
    .replaceAll(INERT_REMOVED_RE, '')
    .replaceAll('\u0060', "'")
    .replaceAll(/\s+/g, ' ')
    .trim()
  const chars = Array.from(text)
  const bounded = chars.length > INERT_MAX ? `${chars.slice(0, INERT_MAX).join('')}${INERT_CUT}` : text
  return bounded === '' ? INERT_EMPTY : bounded
}
// END untrusted-text encoding mirror

const BACKTICK = '\u0060'
export const SPAN_TOKEN = BACKTICK + BACKTICK
const SPAN_RE = new RegExp(`${BACKTICK}[^${BACKTICK}]*${BACKTICK}`, 'g')
// A shape is written as a regular expression in which ¤ stands for one code span.
const sp = (re) => new RegExp(re.source.replaceAll('¤', SPAN_TOKEN), re.flags)

// { line, skeleton, spans }: the line, the line with each code span replaced by SPAN_TOKEN, and the text inside each span in order.
export function parseLine(line) {
  const spans = []
  const skeleton = line.replaceAll(SPAN_RE, (span) => {
    spans.push(span.slice(1, -1))
    return SPAN_TOKEN
  })
  return { line, skeleton, spans }
}
// A leading byte-order mark is not part of the first line (checkReportText allows one there, and only there).
const parsedLines = (report) => (Array.isArray(report) ? report : report.replace(/^\ufeff/, '').split('\n').map(parseLine))
const backtickCount = (line) => line.split(BACKTICK).length - 1

const UNKNOWN_SHAPE = 'a line in a shape the check does not know'
const unknownShape = (name) => `${F.FIGURE_MISMATCH} ${name}: ${UNKNOWN_SHAPE}`

// The headline figure lines.
const SHAPES = {
  ledger: { re: /^Ledger records in window: (\d{1,15}) \(minimum for harness-side proposals: \d{1,15}\)\.$/ },
  ci: { re: /^CI runs: (\d{1,15}) fetched, (\d{1,15}) not fetched, (\d{1,15}) timed out$/ },
  git: { re: sp(/^Raw \(unscoped\): (\d{1,15}) of (\d{1,15}) examined commits matched the heuristic\. ¤$/) },
  scoped: { re: sp(/^Scoped to product source \(config: ¤\): (\d{1,15}) counted, (\d{1,15}) excluded as pipeline\/tooling-only, (\d{1,15}) unavailable \(changed paths could not be determined\)\. ¤$/) },
}
const DIGEST_OMITTED_RE = /^Digest omitted ([A-Za-z]{1,40}): (\d{1,15})$/
const DIGEST_TRIMMED_LINE = 'Digest trimmed for size: yes'
const PLAN_LABELS_NOTE_RE = sp(/^Plan labels note: ¤$/)
const ADOPTED_RE = sp(/^Already adopted on ¤\.$/)
const REJECTED_RE = sp(/^\*\*Previously rejected on ¤\.\*\*$/)

// Every line the script writes with no figure the check compares: fixed prose, and lines whose only variable parts are code spans, the
// script's own proposal ids, its drafting bookkeeping and fixed words.
const FIXED_LINES = new Set([
  '',
  '# Delivery optimiser report',
  '## Sample completeness',
  '**Ledger analysis unavailable**: the ledger lane failed to run (e.g. optimise-read.mjs may not be resolvable yet -- see the rollout\'s global-mirror step). This is NOT the same as an empty ledger: a fixed install may already show real data.',
  'Ledger window was truncated to the most recent records; older history was not read (AC-ARCH-14 bound).',
  'Instrumented invocation routes: conducted runs and every direct invocation of the harness\'s other workflows write the ledger identically (AC-ARCH-4); conduct-plan wait/PR events are conductor-only.',
  DIGEST_TRIMMED_LINE,
  '## Wall-clock decomposition (source: ledger)',
  'No wall-clock data in window.',
  'No wall-clock data (ledger unavailable).',
  '## Rework attribution (source: ledger)',
  'No lens findings recorded in window.',
  'No rework data (ledger unavailable).',
  'Blocked TDD runs unresolved in window may include a task re-briefed after a block and then finished (see the hint on each line); two briefs identical in their first 500 bytes can falsely clear each other (round 3 F4).',
  'Blocked TDD runs unresolved in window (upper bound: a task finished by hand leaves no resolution row): not measured (ledger unavailable)',
  'Blocked TDD runs unresolved in window (upper bound: a task finished by hand leaves no resolution row): not measured (installed reader predates this metric)',
  '## Never-failing acceptance criteria (source: ledger)',
  '## Trigger accuracy (source: ledger)',
  'No trigger data in window.',
  'No trigger data (ledger unavailable).',
  '## CI section (source: gh)',
  'No CI data available.',
  '## Escaped-defect counter-metric',
  'Escaped defects are not currently captured (git-lane unavailable).',
  '## Proposals (ranked)',
  '## Proposals previously adopted (not ranked as new)',
  '## Proposals (insufficient data, excluded from ranking)',
  'None.',
  '**Flagged: security-purposed check removal/demotion.**',
  '**Flagged: adopted and reverted at least twice previously (§12: keep the original).**',
  '## Filtering',
])

const SEGMENT_DETAIL = /(?:ci_wait|human_wait|agent_compute) \((?:reader field unavailable|[\w.-]{1,24} unmeasured runs)\)/.source
const LINE_SHAPES = [
  sp(/^Repos: ¤$/),
  sp(/^Not measured: ¤$/),
  /^\*\*Insufficient data\*\*: harness-side \(rework\/wall-clock\/trigger\) proposals are suppressed until the ledger holds at least \d{1,15} records\.$/,
  sp(/^- ¤: \*\*uninstrumented\*\* \(no ledger file found -- not \x22no activity\x22; the harness has never written a ledger here\)$/),
  PLAN_LABELS_NOTE_RE,
  /^None recorded \(invalid_ac_ids_dropped in window: (?:\d{1,15}|null|unavailable \(installed optimise-read\.mjs predates this field\))\)\.$/,
  sp(/^- ¤ ¤ ¤: ¤(?: \(a later done run exists for this spec at ¤; under a multi-task plan this may be another task\))?$/),
  sp(/^- gh unavailable for ¤: ¤ \(¤\): ¤$/),
  sp(/^Repo \d{1,15} \(¤\):$/),
  sp(/^Scoped figure unavailable: ¤$/),
  sp(/^### (?:[0-9a-f]{16}|\(no id\)): Proposal statement \(model text\): ¤$/),
  sp(/^- (?:[0-9a-f]{16}|\(no id\)): Proposal statement \(model text\): ¤ \(n=¤\)$/),
  sp(/^n=¤\. Motivating \(model text\): ¤\. Confirming \(model text\): ¤\. Citations \(model text\): (?:¤(?:, ¤)*)?\.$/),
  sp(/^Target: kind=¤ component=¤ concern=¤ lens=¤ workflow=¤ job=¤$/),
  sp(/^Reinstatement evidence \(model text\): ¤$/),
  ADOPTED_RE,
  REJECTED_RE,
  /^(?:ci_wait|human_wait|agent_compute): unavailable \(installed optimise-read\.mjs predates this field\)$/,
  new RegExp(String.raw`^Drafted: \d{1,15}\. Dropped \(no resolvable citation\): \d{1,15}\. Dropped \(always-on security lens removal, never permitted\): \d{1,15}\. Dropped \(removal without reinstatement evidence\): \d{1,15}\. Dropped \(motivating wall-clock segment has unmeasured runs(?: -- ${SEGMENT_DETAIL}(?:, ${SEGMENT_DETAIL})*)?\): \d{1,15}\. Dropped \(cited CI job has no settled never-failed verdict; see the CI section qualifiers\): \d{1,15}\.$`),
  sp(/^Proposals rejected: malformed target: \d{1,15}(?: \(¤(?: \| ¤)*\))?$/),
  DIGEST_OMITTED_RE,
]

// { reasons, reported }: reported is the figure the report states for the ledger, for the RESULT line. A record
// count printed beside a ledger lane that has no collected figure is refused, whatever the number: it can only be a
// default zero standing for a lane that did not run.
const figuresOn = (lines, shape) => lines.map(({ skeleton }) => shape.re.exec(skeleton)).filter((m) => m !== null).map((m) => m.slice(1).map(Number))

export function checkLedger(report, col) {
  const want = collectedLedger(col)
  const found = figuresOn(parsedLines(report), SHAPES.ledger)
  const first = found[0]?.[0]
  if (want === null) return { reasons: found.length > 0 ? [`${F.FIGURE_MISMATCH} ledger: collected none, reported ${first}`] : [], reported: null }
  if (found.length === 0) return { reasons: [`${F.FIGURE_MISMATCH} ledger: collected ${want}, reported none`], reported: null }
  const wrong = found.find(([n]) => n !== want)
  if (wrong !== undefined) return { reasons: [`${F.FIGURE_MISMATCH} ledger: collected ${want}, reported ${wrong[0]}`], reported: wrong[0] }
  return { reasons: found.length === 1 ? [] : [unknownShape('ledger')], reported: want }
}

// A lane with a figure the report must show: exactly one line carries the label and it equals the figure. A lane with none: no line does.
export function checkLine(name, report, shape, names, want) {
  const found = figuresOn(parsedLines(report), shape)
  if (want === null) return found.length > 0 ? [`${F.FIGURE_MISMATCH} ${name}: collected none, reported ${found[0][0]}`] : []
  if (found.length === 0) return [`${F.FIGURE_MISMATCH} ${name}: ${names[0]} collected ${want[0]}, reported none`]
  for (const got of found) {
    const diff = firstDifference(names, want, got)
    if (diff) return [`${F.FIGURE_MISMATCH} ${name}: ${diff.name} collected ${diff.want}, reported ${diff.got}`]
  }
  return found.length === 1 ? [] : [unknownShape(name)]
}

export function checkCi(report, col) {
  const c = col.lane.ci
  const measured = laneState(col, 'ci') === 'ran' && isCount(c.runCount) && isCount(c.fetchFailedCount) && isCount(c.timeoutCount)
  const want = measured ? [c.runCount, c.fetchFailedCount, c.timeoutCount] : null
  return checkLine('ci', report, SHAPES.ci, ['runs', 'not fetched', 'timed out'], want)
}

export function checkGit(report, col) {
  const g = resultOf(col, 'git')
  const measured = laneState(col, 'git') === 'ran' && isCount(g.count) && isCount(g.n_commits_examined)
  return checkLine('git', report, SHAPES.git, ['count', 'examined'], measured ? [g.count, g.n_commits_examined] : null)
}

// The scoped escaped-defect line, against the git lane's scoped counts.
export function checkScoped(report, col) {
  const g = resultOf(col, 'git')
  const measured = laneState(col, 'git') === 'ran' && isCount(g.scoped_count) && isCount(g.scoped_excluded_count) && isCount(g.scoped_unavailable_count)
  const want = measured ? [g.scoped_count, g.scoped_excluded_count, g.scoped_unavailable_count] : null
  return checkLine('git scoped', report, SHAPES.scoped, ['scoped counted', 'scoped excluded', 'scoped unavailable'], want)
}

// The first problem with the digest's omission lines, or null: each names a key the digest holds, with its figure, once.
function omissionProblem(lines, dropped) {
  const seen = new Set()
  for (const m of lines.map(({ skeleton }) => DIGEST_OMITTED_RE.exec(skeleton)).filter((found) => found !== null)) {
    const [, key, n] = m
    if (!Object.hasOwn(dropped, key) || !isCount(dropped[key])) return `${F.FIGURE_MISMATCH} digest: an omission line the digest does not hold, reported ${n}`
    if (Number(n) !== dropped[key]) return `${F.FIGURE_MISMATCH} digest: omitted ${key} collected ${dropped[key]}, reported ${n}`
    if (seen.has(key)) return unknownShape('digest')
    seen.add(key)
  }
  const missing = Object.entries(dropped).find(([key, value]) => isCount(value) && value > 0 && !seen.has(key))
  return missing ? `${F.FIGURE_MISMATCH} digest: omitted ${missing[0]} collected ${missing[1]}, reported none` : null
}

export function checkDigest(report, col) {
  const { digest } = col
  if (!isObject(digest) || !isObject(digest.dropped)) return [`${F.UNREADABLE}: digest`]
  const lines = parsedLines(report)
  const problem = omissionProblem(lines, digest.dropped)
  if (problem !== null) return [problem]
  const trimmedLines = lines.filter(({ skeleton }) => skeleton === DIGEST_TRIMMED_LINE).length
  return (digest.dropped.trimmedForSize === true) !== (trimmedLines > 0) || trimmedLines > 1 ? [`${F.FIGURE_MISMATCH} digest: trimmed flag`] : []
}

// ---- the number-bearing rows the workflow renders from the digest ----
//
// Each class of row is held to the digest the runner collected (on disk, out of the session's reach). A row is a line whose skeleton the
// class's pattern matches; its key (a job, a repository, a plan, an acceptance criterion) is the text of its first code span, which must be
// the encoder's rendering of a key the digest holds; every figure on it must equal the digest's, and every key the digest holds must be
// rendered. A line in any other shape is refused by checkLineShapes. Reasons name the class and the figure, never a key or a session word.

// The workflow prints a CI job or repository key through its flattener (absolute-path-looking text redacted, whitespace collapsed, 120
// characters) before the encoder. The pattern and marker are the workflow's own (a parity test holds them equal).
export { ABSOLUTE_PATH_RE, REDACTED_PATH_MARKER }
const flat = (v) => String(v).replaceAll(ABSOLUTE_PATH_RE, (whole, prefix) => `${prefix}${REDACTED_PATH_MARKER}`).replaceAll(/\s+/g, ' ').slice(0, 120)
const countText = (x) => (x === 'n/a' ? null : Number(x))
const numOrNull = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const secondsOf = (s) => (s === 'unmeasured (null)' ? null : Number(s.slice(0, -1)))
const SEC = String.raw`(-?\d{1,15}(?:\.\d{1,9})?s)`
const COUNT = String.raw`(\d{1,15})`
const NUMBER = String.raw`-?\d{1,15}(?:\.\d{1,9})?`
const UNAVAILABLE = String.raw`unavailable \(installed optimise-read\.mjs predates this field\)`
const ledgerDigest = (col) => (isObject(col.digest?.ledger) ? col.digest.ledger : {})
const ciDigest = (col) => (isObject(col.digest?.ci) ? col.digest.ci : {})
const entriesOf = (v) => (isObject(v) ? Object.entries(v) : [])
const orNull = (v) => (v === undefined ? null : v)
const spanKey = (spans) => spans[0]

const CI_QUALIFIER = '(?:insufficient data|window truncated|rename suspect|re-run|jobs partially fetched|never failed in this window)'
const CI_JOB = {
  name: 'ci job',
  re: sp(new RegExp(String.raw`^- ¤: n=(\d{1,15}|n/a), failed=(\d{1,15}|n/a)(?:, not settled=(?:${NUMBER}|n/a) \(skipped, cancelled or neutral\))?(?: \(run ids \d{1,20}(?:, \d{1,20}){0,9}(?:, \+\d{1,15} more)?\))?, mean (?:-?\d{1,15}s|n/a)(?: \(${CI_QUALIFIER}(?:, ${CI_QUALIFIER}){0,5}\))?$`)),
  names: ['n', 'failed'],
  split: (m, spans) => ({ key: spanKey(spans), got: [countText(m[1]), countText(m[2])] }),
  rows: (col) => new Map(entriesOf(ciDigest(col).byJob).map(([k, j]) => [inertText(flat(k)), [numOrNull(j?.n), numOrNull(j?.failureCount)]])),
}

const CI_REPOSITORY = {
  name: 'ci repository',
  re: sp(new RegExp(String.raw`^- ¤: ${COUNT} runs not completed \(left out\); per-run fetch failures \(incl\. attempt-1\): rate_limited ${COUNT}, unauthenticated ${COUNT}, other ${COUNT}; attempt-1 jobs not fetched: (\d{1,15}|n/a); runs past attempt 2 or with an unreadable attempt \(not qualifiable\): (\d{1,15}|n/a)$`)),
  names: ['not completed', 'rate limited', 'unauthenticated', 'other', 'attempt-1 unfetched', 'past attempt 2'],
  split: (m, spans) => ({ key: spanKey(spans), got: m.slice(1).map(countText) }),
  rows: (col) => new Map(entriesOf(ciDigest(col).repoStats).map(([k, st]) => [inertText(flat(k)), [st?.notCompleted || 0, st?.fetchFailures?.rate_limited || 0, st?.fetchFailures?.unauthenticated || 0, st?.fetchFailures?.other || 0, numOrNull(st?.attempt1Unfetched), numOrNull(st?.pastAttempt2)]])),
}

const GH_CALLS = {
  name: 'gh calls',
  re: sp(/^- ¤: wall-clock (\d{1,15}(?:\.\d{1,9})?|n\/a)s, (\d{1,15}|n\/a) gh calls$/),
  names: ['wall-clock seconds', 'calls'],
  split: (m, spans) => ({ key: spanKey(spans), got: [countText(m[1]), countText(m[2])] }),
  rows: (col) => new Map((Array.isArray(ciDigest(col).ghStats) ? ciDigest(col).ghStats : []).map((g) => [inertText(flat(g?.repo)), [numOrNull(g?.wall_clock_s), numOrNull(g?.gh_calls)]])),
}

const WALL_CLOCK_PLAN = {
  name: 'wall-clock plan',
  re: sp(new RegExp(String.raw`^- ¤: ci_wait=${SEC} \(n=${COUNT}\), human_wait=${SEC} \(n=${COUNT}\), agent_compute=${SEC} \(n=${COUNT}\)(?:, aborted=${SEC} \(n=${COUNT}\))?(?:, unterminated_waits: ${COUNT})?$`)),
  names: ['ci wait seconds', 'ci wait runs', 'human wait seconds', 'human wait runs', 'agent compute seconds', 'agent compute runs', 'aborted seconds', 'aborted runs', 'unterminated waits'],
  split: (m, spans) => ({ key: spanKey(spans), got: [secondsOf(m[1]), Number(m[2]), secondsOf(m[3]), Number(m[4]), secondsOf(m[5]), Number(m[6]), m[7] === undefined ? 0 : secondsOf(m[7]), Number(m[8] ?? 0), Number(m[9] ?? 0)] }),
  rows: (col) => new Map(entriesOf(ledgerDigest(col).wallClock?.byPlan).map(([k, b]) => [inertText(k), [orNull(b?.ciWaitSeconds), orNull(b?.ciWaitN), orNull(b?.humanWaitSeconds), orNull(b?.humanWaitN), orNull(b?.agentComputeSeconds), orNull(b?.agentComputeN), b?.agentComputeAbortedN ? orNull(b.agentComputeAbortedSeconds) : 0, b?.agentComputeAbortedN || 0, b?.unterminatedWaits || 0]])),
}

const SEG = String.raw`(unmeasured \(null\)|-?\d{1,15}(?:\.\d{1,9})?s)`
const WALL_CLOCK_TOTALS = {
  name: 'wall-clock totals',
  re: new RegExp(String.raw`^Totals: ci_wait=${SEG} \(measured n=${COUNT}, unmeasured n=${COUNT}\), human_wait=${SEG} \(measured n=${COUNT}, unmeasured n=${COUNT}\), agent_compute=${SEG} \(measured n=${COUNT}, unmeasured n=${COUNT}, aborted n=(\d{1,15}|null|${UNAVAILABLE})(?: \[(?:unmeasured \(null\)|${NUMBER}s)\])?\)\.$`),
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
const neverFailingKey = (a) => [a.repo, a.spec, a.ac_id].map(inertText).join('\n')

const NEVER_FAILING_REASON = '(?:insufficient data|unattributed FAIL in window -- see invalid_ac_ids_dropped|unattributed verdict for this criterion -- see invalid_record_values_dropped|truncated ac_verdicts in window -- see ac_verdicts_truncated)'
const NEVER_FAILING = {
  name: 'never-failing',
  re: sp(new RegExp(String.raw`^- ¤/¤ ¤: n=(\d{1,15})(?: \(${NEVER_FAILING_REASON}\))?(?:, never_failed=(true|false|null))?(?:, verdict_disagreements=(\d{1,15}|not measured|null))?$`)),
  names: ['n', 'never failed', 'verdict disagreements'],
  split: (m, spans) => ({ key: spans.slice(0, 3).join('\n'), got: [Number(m[1]), m[2] ?? '', m[3] ?? ''] }),
  rows: (col) => new Map(shownNeverFailing(col).map((a) => [neverFailingKey(a), neverFailingText(a)])),
}

const NEVER_FAILING_LEFT_OUT = {
  name: 'never-failing',
  re: /^(\d{1,15}) criteria rows left out as insufficient data$/,
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
  re: sp(/^- ¤: (\d{1,15}) record\(s\) in window, skipped=(\d{1,15}), schema_version mix: \{(?:none|¤: \d{1,15}(?:, ¤: \d{1,15})*)\}, truncated final line: (?:true|false)$/),
  names: ['records', 'skipped'],
  byPosition: true,
  split: (m) => ({ got: [Number(m[1]), Number(m[2])] }),
  rows: (col) => new Map(instrumentedRepos(col).map((e, i) => [String(i), [e.recordCount, e.skippedCount ?? 0]])),
}

const LEDGER_SKIPPED = {
  name: 'ledger repository',
  re: /^(\d{1,15}) ledger line\(s\) were skipped as unparseable or missing a required field; see raw skip reasons in the agent transcript\.$/,
  names: ['skipped'],
  split: (m) => ({ key: 'skipped', got: [Number(m[1])] }),
  rows: (col) => (ledgerDigest(col).skippedCount > 0 ? new Map([['skipped', [ledgerDigest(col).skippedCount]]]) : new Map()),
}

const TRIGGER_ACCURACY = {
  name: 'trigger accuracy',
  re: sp(/^- ¤: clean_zero_trigger=(\d{1,15}), clean_with_matches=(\d{1,15}), findings=(\d{1,15}), clean_trigger_unmeasured=(\d{1,15}), total=(\d{1,15})$/),
  names: ['clean zero trigger', 'clean with matches', 'findings', 'clean trigger unmeasured', 'total'],
  split: (m, spans) => ({ key: spanKey(spans), got: m.slice(1).map(Number) }),
  rows: (col) => new Map(entriesOf(ledgerDigest(col).triggerAccuracy?.byLens).map(([k, b]) => [inertText(k), [b?.cleanWithZeroTrigger, b?.cleanWithMatches, b?.findingsWithMatches, b?.cleanTriggerUnmeasured || 0, b?.total]])),
}

const REWORK = {
  name: 'rework',
  re: sp(/^- ¤: fixed=(\d{1,15}), rejected=(\d{1,15}), spec_bug=(\d{1,15}), open=(\d{1,15})$/),
  names: ['fixed', 'rejected', 'spec bug', 'open'],
  split: (m, spans) => ({ key: spanKey(spans), got: m.slice(1).map(Number) }),
  rows: (col) => new Map(entriesOf(ledgerDigest(col).rework?.lensDispositionCounts).map(([k, c]) => [inertText(k), [c?.fixed, c?.rejected, c?.spec_bug, c?.open]])),
}

const rework = (col) => (isObject(ledgerDigest(col).rework) ? ledgerDigest(col).rework : {})
const wallTotals = (col) => (isObject(ledgerDigest(col).wallClock?.totals) ? ledgerDigest(col).wallClock.totals : {})

const EXCLUDED_FROM_ATTRIBUTION = {
  name: 'attribution counters',
  re: new RegExp(String.raw`^Excluded from attribution \(never silently dropped\): unattributable runs=${COUNT}, degraded-unattributed runs=${COUNT}, unattributable ci_wait/human_wait observations=${COUNT}, unattributable rework records=${COUNT}\.$`),
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
  re: new RegExp(String.raw`^(invalid_ac_ids_dropped(?= \(sanitised, non-conforming AC ids from lens findings/verdicts\))|invalid_record_values_dropped(?= \(sanitised, non-conforming values elsewhere -- verdicts/ac_verdicts\.verdict/lenses_run entries\))|invalid_fixed_ids_dropped(?= \(a fixed_findings confirmation that did not match a genuinely open prior finding\))|duplicate_fixed_ids_dropped(?= \(the same confirmed finding listed more than once in one round\))|duplicate fixed confirmations across rounds(?= \(the same finding id recorded fixed again in a later round\))|invalid_prior_ids_dropped(?= \(a supplied prior_findings id that did not match its own recomputed content -- mistyped, stale or fabricated\))) \([^)\n\u0060]{1,120}\): (\d{1,15}|null|${UNAVAILABLE})\.$`),
  names: ['dropped count'],
  split: (m) => ({ key: m[1], got: [/^\d+$/.test(m[2]) ? Number(m[2]) : null] }),
  rows: (col) => new Map(Object.entries(DROPPED_COUNTERS).map(([label, field]) => [label, [numOrNull(rework(col)[field])]])),
}

const ORPHANED_LINE = sp(new RegExp(String.raw`^Orphaned agent-compute runs \(never silently collapsed into one number\): start-only=(\d{1,15}|null|${UNAVAILABLE}) \(by kind: (none|¤: \d{1,15}(?:, ¤: \d{1,15})*)\), terminal-only=(\d{1,15}|null|${UNAVAILABLE}) \(by kind: (none|¤: \d{1,15}(?:, ¤: \d{1,15})*)\)\.$`))
const ORPHANED_RUNS = {
  name: 'orphaned runs',
  re: ORPHANED_LINE,
  names: ['start-only', 'terminal-only'],
  split: (m) => ({ key: 'orphaned', got: [m[1], m[3]].map((x) => (/^\d+$/.test(x) ? Number(x) : null)) }),
  rows: (col) => new Map([['orphaned', [numOrNull(wallTotals(col).agentComputeStartOnlyRuns), numOrNull(wallTotals(col).agentComputeTerminalOnlyRuns)]]]),
}

// ---- the remaining figure lines: rework counters, blocked TDD runs, suppression shares, sources, the plan-label note ----

// The workflow prints a count it was given as a number, `null`, or an "unavailable" marker for a reader that predates the field;
// a split figure also prints `not recorded` for null. These are compared as the fixed words they are, never as session text.
const COUNTISH = String.raw`(\d{1,15}|null|${UNAVAILABLE})`
const SPLITISH = String.raw`(\d{1,15}|not recorded|${UNAVAILABLE})`
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
  re: new RegExp(String.raw`^findings dropped from this tally: findings_truncated=${COUNTISH} \(findings the writer counted but could not fit on the line; the per-lens rows above are short by this many\), ac_verdicts_truncated=${COUNTISH}, unattributed \(lens value did not match a known lens\)=${COUNTISH}\.$`),
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
  re: new RegExp(String.raw`^No-spec review runs in window: ${COUNTISH} \(conducted=${SPLITISH}, direct=${SPLITISH}, round not recorded=${SPLITISH}\) \(findings reclassified from spec_bug to open on those runs: ${COUNTISH}\)\. Completed review runs carrying a conductor round, any spec: ${SPLITISH}\.$`),
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
  re: new RegExp(String.raw`^Completeness, schema_version >= 4 rows only(?: \(${COUNT} rows; ${COUNT} older rows excluded\): findings_truncated=${V4}, unattributed findings=${V4}, duplicate verdict groups collapsed=${V4}, no-spec review runs=${V4}, no-spec review runs conducted=${V4}, direct=${V4}, round not recorded=${V4}\. Completed review runs carrying a conductor round, any spec: ${V4}\.|: not recorded \(no such rows; ${COUNT} older rows excluded\)\.)$`),
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
  re: /^Blocked TDD runs unresolved in window \(upper bound: a task finished by hand leaves no resolution row\): (\d{1,15})$/,
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
  re: /^Blocked TDD runs unresolved, reason recorded \(post-T5\): (\d{1,15}|not recorded); not recorded \(pre-T5\): (\d{1,15}|not recorded)\.$/,
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
  re: /^unterminated_waits: (\d{1,15})$/,
  names: ['unterminated waits'],
  split: (m) => ({ key: 'total', got: [Number(m[1])] }),
  rows: (col) => (wallTotals(col).unterminatedWaits ? new Map([['total', [wallTotals(col).unterminatedWaits]]]) : new Map()),
}

const SEGMENTS = { ci_wait: 'ciWait', human_wait: 'humanWait', agent_compute: 'agentCompute' }
const SUPPRESSION_SHARE = {
  name: 'filtering',
  re: /^(ci_wait|human_wait|agent_compute): (\d{1,15})\/(\d{1,15}) runs unmeasured \((\d{1,3})%\) -- (?:at\/above the 20% suppression threshold: wall-clock proposals citing this segment are suppressed|below the 20% suppression threshold)$/,
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
  re: sp(/^Sources: ci_wait=¤, human_wait=¤, agent_compute=¤\.$/),
  names: ['ci wait source', 'human wait source', 'agent compute source'],
  textual: true,
  split: (m, spans) => ({ key: 'sources', got: spans.slice(0, 3) }),
  rows: (col) => {
    const src = ledgerDigest(col).wallClock?.source
    return isObject(src) ? new Map([['sources', [inertText(src.ci_wait), inertText(src.human_wait), inertText(src.agent_compute)]]]) : new Map()
  },
}

// The by-kind breakdown as the workflow renders it: each kind in a code span with its count, or `none`.
function formatByKind(byKind) {
  const entries = entriesOf(byKind)
  return entries.length > 0 ? entries.map(([k, n]) => `${BACKTICK}${inertText(k)}${BACKTICK}: ${n}`).join(', ') : 'none'
}
// A fragment of a skeleton with its tokens filled back in from the spans, the first one being spans[offset].
function refill(fragment, spans, offset) {
  let next = offset
  return fragment.replaceAll(SPAN_TOKEN, () => {
    const span = spans[next] ?? ''
    next += 1
    return `${BACKTICK}${span}${BACKTICK}`
  })
}
const tokensIn = (fragment) => fragment.split(SPAN_TOKEN).length - 1
const ORPHANED_KINDS = {
  name: 'orphaned runs',
  re: ORPHANED_LINE,
  names: ['start-only by kind', 'terminal-only by kind'],
  textual: true,
  split: (m, spans) => ({ key: 'kinds', got: [refill(m[2], spans, 0), refill(m[4], spans, tokensIn(m[2]))] }),
  rows: (col) => new Map([['kinds', [formatByKind(wallTotals(col).agentComputeStartOnlyByKind), formatByKind(wallTotals(col).agentComputeTerminalOnlyByKind)]]]),
}

export const ROW_CLASSES = [CI_JOB, CI_REPOSITORY, GH_CALLS, WALL_CLOCK_PLAN, WALL_CLOCK_TOTALS, NEVER_FAILING, NEVER_FAILING_LEFT_OUT, LEDGER_REPOSITORY, LEDGER_SKIPPED, TRIGGER_ACCURACY, REWORK, EXCLUDED_FROM_ATTRIBUTION, DROPPED_COUNTER, ORPHANED_RUNS, ORPHANED_KINDS, REWORK_FINDINGS_DROPPED, REWORK_NO_SPEC, REWORK_SCHEMA_V4, BLOCKED_COUNT, BLOCKED_REASONS, UNTERMINATED_TOTAL, SUPPRESSION_SHARE, WALL_CLOCK_SOURCES]

function rowReason(spec, want, got) {
  const diff = firstDifference(spec.names, want, got)
  if (!diff) return null
  return spec.textual ? `${F.FIGURE_MISMATCH} ${spec.name}: ${diff.name} differs from the collected one` : `${F.FIGURE_MISMATCH} ${spec.name}: ${diff.name} collected ${diff.want}, reported ${diff.got}`
}

function checkRowClass(spec, lines, col) {
  const wants = spec.rows(col)
  const reasons = []
  const seen = new Set()
  let index = 0
  for (const { skeleton, spans } of lines) {
    const m = spec.re.exec(skeleton)
    if (m === null) continue
    const parsed = spec.split(m, spans)
    const key = spec.byPosition ? String(index) : parsed.key
    index += 1
    const want = wants.get(key)
    if (want === undefined) {
      reasons.push(`${F.FIGURE_MISMATCH} ${spec.name}: a row the collected data does not hold`)
      continue
    }
    if (seen.has(key)) reasons.push(unknownShape(spec.name))
    seen.add(key)
    const problem = rowReason(spec, want, parsed.got)
    if (problem !== null) reasons.push(problem)
  }
  for (const [key, want] of wants) if (!seen.has(key)) reasons.push(`${F.FIGURE_MISMATCH} ${spec.name}: ${spec.names[0]} collected ${want[0]}, reported none`)
  return reasons
}

// ---- the shape of every line ----

const KNOWN_SHAPES = [...Object.values(SHAPES).map((shape) => shape.re), ...ROW_CLASSES.map((spec) => spec.re), ...LINE_SHAPES]
const isKnownShape = (skeleton) => FIXED_LINES.has(skeleton) || KNOWN_SHAPES.some((re) => re.test(skeleton))

// One fixed reason for any line with an odd number of backticks, and one for any line whose skeleton is not a shape the script writes.
export function checkLineShapes(report) {
  const reasons = new Set()
  for (const { line, skeleton } of parsedLines(report)) {
    if (backtickCount(line) % 2 === 1) reasons.add(F.ODD_BACKTICKS)
    else if (!isKnownShape(skeleton)) reasons.add(F.UNKNOWN_LINE)
  }
  return [...reasons]
}

// ---- recorded proposal outcomes and the plan-label note ----

// The proposal a line belongs to: a `### <id>: ...` heading or a `- <id>: ...` bullet starts one, a `## ` heading ends it.
function proposalIdAfter(line, current) {
  if (line.startsWith('## ')) return null
  const heading = /^(?:### |- )(\w{1,64}): /.exec(line)
  return heading ? heading[1] : current
}

// The adoption or rejection date an annotation line states (the text of its code span), or null for any other line.
function dateClaimIn({ skeleton, spans }) {
  if (ADOPTED_RE.test(skeleton)) return { kind: 'adoption', ts: spans[0] }
  return REJECTED_RE.test(skeleton) ? { kind: 'rejection', ts: spans[0] } : null
}

function outcomeProblem(claim, outcome) {
  const held = claim.kind === 'adoption' ? outcome.lastAdoptionTs : outcome.lastRejectionTs
  return inertText(held) === claim.ts ? null : `${F.FIGURE_MISMATCH} proposal outcome: ${claim.kind} date differs from the collected one`
}

// The recorded adoption and rejection dates a proposal's annotation shows, held to the outcome the ledger holds for that id.
export function checkProposalOutcomes(report, col) {
  const outcomes = ledgerDigest(col).proposalOutcomes
  const reasons = []
  let id = null
  for (const parsed of parsedLines(report)) {
    id = proposalIdAfter(parsed.line, id)
    const claim = dateClaimIn(parsed)
    if (claim === null) continue
    const held = id !== null && isObject(outcomes) && Object.hasOwn(outcomes, id) ? outcomes[id] : null
    const problem = held === null ? `${F.FIGURE_MISMATCH} proposal outcome: an outcome the collected data does not hold` : outcomeProblem(claim, held)
    if (problem !== null) reasons.push(problem)
  }
  return reasons
}

// The note the collector wrote about plan labels it left out is shown (flattened, inert) after a fixed label; the report must carry exactly it.
export function checkPlanLabelNote(report, col) {
  const note = col.digest?.plan_labels_note
  if (typeof note !== 'string' || note.trim() === '') return []
  const expected = inertText(note.replaceAll(/\s+/g, ' ').slice(0, 400))
  const shown = parsedLines(report).filter(({ skeleton, spans }) => PLAN_LABELS_NOTE_RE.test(skeleton) && spans[0] === expected)
  return shown.length === 1 ? [] : [`${F.FIGURE_MISMATCH} plan labels: note differs from the collected one`]
}

export function checkRows(report, col) {
  const lines = parsedLines(report)
  return [...ROW_CLASSES.flatMap((spec) => checkRowClass(spec, lines, col)), ...checkScoped(lines, col), ...checkProposalOutcomes(lines, col), ...checkPlanLabelNote(lines, col)]
}

// { reasons, reportedLedger }: every line's shape, and every figure in the report against the collected files.
export function checkFigures(result, report, col) {
  const lines = parsedLines(report)
  const ledger = checkLedger(lines, col)
  const reasons = [...checkLanes(result.lanes, col), ...checkLineShapes(lines), ...ledger.reasons, ...checkCi(lines, col), ...checkGit(lines, col), ...checkDigest(lines, col), ...checkRows(lines, col)]
  return { reasons, reportedLedger: ledger.reported }
}

// ---- the sidecar: the only copy of the id-to-target map for decided proposals ----

// The returned sidecar merged into the one on disk, so no entry is ever lost: every prior entry the returned one lacks is
// kept, a returned entry is added or replaces the prior one and counts as the newest, and only past `max` do the oldest
// go. The file carries no age, so age is insertion order: the order of the keys in the JSON file.
// Eviction (whole-branch review round 2, M3): an entry the ledger's recorded outcomes still reference is the only copy of the target text behind a
// recorded decision, so it goes last. `referenced` is the set of proposal ids the ledger records an outcome for. An entry is referenced when its key is
// in the set or the id its stored target hashes to now is (so a legacy-id entry and its current-id entry, which share one target, are one group and are
// kept or evicted together). Groups go unreferenced first and oldest first (a group's age is its newest member's position), then referenced ones, oldest
// first, only while still over the limit; how many referenced entries had to go is returned so the run can say so.
function evictionGroups(merged, referenced) {
  const groups = new Map()
  let index = 0
  for (const [key, value] of merged) {
    const current = isObject(value) && sidecarTargetOrReason(value).target !== undefined ? stableProposalId(value) : key
    const group = groups.get(current) ?? { keys: [], last: 0, referenced: referenced.has(current) }
    group.keys.push(key)
    group.last = index
    group.referenced ||= referenced.has(key)
    groups.set(current, group)
    index += 1
  }
  const byAge = (x, y) => x.last - y.last
  const all = [...groups.values()]
  return [...all.filter((g) => !g.referenced).sort(byAge), ...all.filter((g) => g.referenced).sort(byAge)]
}

// Drops whole groups, in that order, until `fits()` says the map is small enough. Returns the number of referenced entries dropped.
function evictUntil(merged, referenced, fits) {
  let evictedReferenced = 0
  for (const group of evictionGroups(merged, referenced)) {
    if (fits()) break
    for (const key of group.keys) merged.delete(key)
    if (group.referenced) evictedReferenced += group.keys.length
  }
  return evictedReferenced
}

const sidecarText = (obj) => JSON.stringify(obj, null, 2) + '\n'

// The returned sidecar merged into the one on disk, so no entry is ever lost to the merge itself: every prior entry the returned one lacks is kept, a
// returned entry is added or replaces the prior one and counts as the newest, and only past `max` do entries go, in the order above. The file carries no
// age, so age is insertion order: the order of the keys in the JSON file. { entries, evictedReferenced }.
export function mergeSidecarDetailed(existing, returned, max = SIDECAR_CARRY_MAX, referenced = new Set()) {
  const merged = new Map(Object.entries(existing))
  for (const [id, target] of Object.entries(returned)) {
    merged.delete(id)
    merged.set(id, target)
  }
  // The ids this run returns are named by the report it is placing, so they are protected like recorded ones.
  const evictedReferenced = evictUntil(merged, new Set([...referenced, ...Object.keys(returned)]), () => merged.size <= max)
  return { entries: Object.fromEntries(merged), evictedReferenced }
}

export const mergeSidecar = (existing, returned, max = SIDECAR_CARRY_MAX, referenced = new Set()) => mergeSidecarDetailed(existing, returned, max, referenced).entries

// The merged sidecar, shrunk in the same order until it fits the size cap (it cannot be placed over it). { entries, evictedReferenced }.
export function fitSidecarDetailed(merged, referenced = new Set()) {
  const kept = new Map(Object.entries(merged))
  const evictedReferenced = evictUntil(kept, referenced, () => Buffer.byteLength(sidecarText(Object.fromEntries(kept)), 'utf8') <= SIDECAR_CAP)
  return { entries: Object.fromEntries(kept), evictedReferenced }
}
export const fitSidecar = (merged, referenced = new Set()) => fitSidecarDetailed(merged, referenced).entries

// The proposal ids the ledger records an outcome for (every window, not the digest's capped few), read through the guarded read; none when the ledger
// is absent or cannot be read (nothing is then protected, and eviction is oldest first as it always was).
export function recordedOutcomeIds(root) {
  const got = readRepoFile(root, LEDGER_RELATIVE_PATH, FILE_CAP)
  return got.status === 'ok' ? new Set(aggregateProposalOutcomes(parseLedgerContent(got.text).records).keys()) : new Set()
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
    if (!PROPOSAL_ID.test(id)) return F.RETURNED_KEY
    if (sidecarTargetOrReason(value).target === undefined) return F.RETURNED_SHAPE
    if (stableProposalId(value) !== id) return F.RETURNED_HASH
    if (!named.has(id)) return F.RETURNED_UNNAMED
  }
  return null
}

// ---- the nonce the session passed on (H2) ----

// The result must carry the SHA-256 of the nonce the runner minted for this run (given to this process in its environment,
// never in its arguments), so a session steered by text in the digest into passing another nonce, or a result that did not
// come from a workflow run on this run's digest, is refused. null when it matches, else the one fixed reason.
export function nonceProblem(result, nonce) {
  if (typeof result.nonce_sha256 !== 'string') return F.NO_NONCE_HASH
  const want = createHash('sha256').update(typeof nonce === 'string' ? nonce : '').digest('hex')
  return result.nonce_sha256 === want && typeof nonce === 'string' && nonce !== '' ? null : F.NONCE_MISMATCH
}

// ---- the keyed digest the workflow returns over what it produced (M2) ----
//
// result_mac is SHA-256, as 64 lower-case hex characters, of this exact byte sequence (UTF-8):
//   <nonce> "\n" <report text exactly as returned> "\n" <canonicalJson(proposal_targets)> "\n" <canonicalJson(lanes)>
// where canonicalJson sorts object keys at every depth (the reader's own, the one the proposal-id block uses). The report and the targets are
// what is placed; the lanes are what this check reads to decide placement. workflows/optimise-cycle.js computes it with its own pure-JS
// SHA-256 (resultMacOf, inside its proposal-id block) and a parity test holds the two together over many inputs. What it proves: the reply
// the check was handed is the object a workflow run on this run's nonce returned. What it does not prove: who computed it. On the
// unattended path the session has no tool that can compute a SHA-256, which is an assumption (T5 probes whether the Workflow tool would
// run an inline script that could); on the attended path the session has a shell, so there it guards against accident, not a steered session.
export function resultMac(result, nonce) {
  const bytes = `${nonce}\n${result.report}\n${canonicalJson(result.proposal_targets)}\n${canonicalJson(result.lanes)}`
  return createHash('sha256').update(bytes, 'utf8').digest('hex')
}

// null when the reply's digest is the one this run's nonce and this reply's text give, else the one fixed reason.
export function macProblem(result, nonce) {
  if (typeof result.result_mac !== 'string' || !/^[0-9a-f]{64}$/.test(result.result_mac)) return F.NO_MAC
  if (typeof nonce !== 'string' || nonce === '') return F.MAC_MISMATCH
  return result.result_mac === resultMac(result, nonce) ? null : F.MAC_MISMATCH
}

// ---- a proposal that removes an always-on lens is refused, whoever signed the report (M2, second layer) ----
//
// The workflow's own rule (isAlwaysOnSecurityRemoval in workflows/optimise-cycle.js) drops such a proposal, so none can be in a report the
// workflow produced. These two values are that rule's, held to the workflow's by a parity test (a script cannot be imported).
export const ALWAYS_ON_LENS_NAMES = ['lens-security', 'lens-qa']
export const ALWAYS_ON_LENS_PHRASE_RE = /\b(lens-security|lens-qa|security lens|qa lens)\b/i
const PROPOSAL_SECTION_RE = /^## Proposals (?:\(ranked\)|previously adopted|\(insufficient data)/
const PROPOSAL_START_RE = /^(?:### |- )([0-9a-f]{16}): /

// The text of each proposal block in the three proposal sections, with the id that starts it.
function proposalBlocks(report) {
  const blocks = []
  let inSection = false
  for (const line of report.split('\n')) {
    if (line.startsWith('## ')) inSection = PROPOSAL_SECTION_RE.test(line)
    const start = inSection ? PROPOSAL_START_RE.exec(line) : null
    if (start) blocks.push({ id: start[1], text: line })
    else if (inSection && blocks.length > 0) blocks.at(-1).text += `\n${line}`
  }
  return blocks
}

export function proposesRemovingAlwaysOnLens(report, targets) {
  return proposalBlocks(report).some(({ id, text }) => {
    const target = isObject(targets) && Object.hasOwn(targets, id) ? targets[id] : null
    const named = isObject(target) && (ALWAYS_ON_LENS_NAMES.includes(target.lens) || target.touches_always_on_lens === true)
    return named || ALWAYS_ON_LENS_PHRASE_RE.test(`${text} ${target === null ? '' : JSON.stringify(target)}`)
  })
}

// ---- the whole check ----

function lanesThatCouldNotRun(col) {
  return LANES.filter((name) => laneState(col, name) === 'failed').map((name) => `${name} ${F.LANE_COULD_NOT_RUN}: ${modeToken(col.lane[name].mode)}`)
}

function readSession(sessionPath) {
  const got = readRepoFile(path.dirname(sessionPath), path.basename(sessionPath), FILE_CAP)
  if (got.status === 'ok') return { text: got.text }
  return { reason: F.SESSION_NOT_ENVELOPE, cause: got.status === 'too_large' ? 'oversized' : 'malformed' }
}

// What a session's reply amounts to: { reasons, cause, denied, reportedLedger, place, report, sidecar, targets }.
function judgeSession(sessionPath, col, strict, bounded, nonce, parse = parseSession) {
  const out = { reasons: [], denied: 'unknown', tools: 'none', reportedLedger: null, place: 'no' }
  const read = readSession(sessionPath)
  const parsed = read.reason ? read : parse(read.text)
  if (parsed.reason) return { ...out, denied: parsed.denied, tools: parsed.tools, reasons: [parsed.reason], cause: parsed.cause }
  const checked = checkResult(parsed.result, strict, bounded)
  if (checked.reason) return { ...out, denied: parsed.denied, tools: parsed.tools, reasons: [checked.reason], cause: checked.cause }
  const wrongNonce = nonceProblem(parsed.result, nonce)
  if (wrongNonce !== null) return { ...out, denied: parsed.denied, tools: parsed.tools, reasons: [wrongNonce], cause: 'nonce' }
  const wrongMac = macProblem(parsed.result, nonce)
  if (wrongMac !== null) return { ...out, denied: parsed.denied, tools: parsed.tools, reasons: [wrongMac], cause: 'mac' }
  if (proposesRemovingAlwaysOnLens(checked.report, checked.targets)) return { ...out, denied: parsed.denied, tools: parsed.tools, reasons: [F.ALWAYS_ON_PROPOSAL], cause: 'malformed' }
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
  const referenced = recordedOutcomeIds(sidecarRoot)
  const merged = mergeSidecarDetailed(existing.entries, judged.targets, SIDECAR_CARRY_MAX, referenced)
  const fitted = fitSidecarDetailed(merged.entries, referenced)
  if (merged.evictedReferenced + fitted.evictedReferenced > 0) raiseNotice(`sidecar-referenced-evicted=${merged.evictedReferenced + fitted.evictedReferenced}`)
  return { ...judged, sidecar: sidecarText(fitted.entries) }
}

// { tokens, denied, cause, reasons, place, report, sidecar }. `sessionPath` of '-' means no session ran; `attended` reads the
// returned object itself (parseResultObject) and prints the collected ledger count alone.
export function verifyRun({ dir, sessionPath, digestToken, repo, runTmp, home, sidecarRoot, nonce, attended = false, boundedPaths = [repo] }) {
  const col = loadCollected(dir)
  const strict = pathNeedles([home, dir, runTmp])
  const bounded = pathNeedles(boundedPaths)
  const parse = attended ? parseResultObject : parseSession
  const judged = sessionPath === '-' ? { reasons: [], denied: 'unknown', reportedLedger: null, place: 'no' } : withMergedSidecar(judgeSession(sessionPath, col, strict, bounded, nonce, parse), sidecarRoot, col)
  return { ...judged, tokens: tokensFor(col, digestToken, attended ? undefined : judged.reportedLedger) }
}

// ---- the sidecar lock and the placement of the two outputs (T4: the runner and the attended entry share these) ----
//
// The lock serialises the sidecar's read, merge and rename across runs ($1 is the main checkout, whose git directory is shared
// by its linked worktrees). It is a symlink whose target is its owner's token (`<pid>:<random>`): creating it is atomic with
// the owner already recorded, so no instant exists in which a held lock has no owner. A stale lock (its owner pid gone, or
// older than LOCK_STALE_MIN minutes, whatever the owner token says) is taken over by renaming it to a name only this taker uses
// and then looking at what was actually taken: only if it is the owner that was judged stale is it dropped; a fresh lock taken
// by mistake is put straight back (and, if that fails, a NOTICE is raised). Something that is not a symlink at the lock path (a
// directory or file an older version left) is not a lock of ours: it is renamed aside and removed, recursively only when it is a
// real directory. A link is only ever inspected with lstat and readlink, never followed. The file system calls go through `ops`
// so a test can place a fault between two steps.
export const LOCK_NAME = 'optimise-sidecar.lock'
export const LOCK_TRIES = 150
export const LOCK_WAIT_MS = 200
export const LOCK_STALE_MIN = 10
const STALE_BREAK_ATTEMPTS = 10
const TOKEN_RE = /^\d{1,10}:[0-9a-f]{12}$/
const STAGED_RE = /^\.optimise-output\.[0-9a-f]{12}$/

const notices = []
const raiseNotice = (token) => {
  if (!notices.includes(token)) notices.push(token)
}
// The notices raised since the last call, cleared.
export const drainNotices = () => notices.splice(0)

const lstatOrNull = (p) => {
  try {
    return fs.lstatSync(p)
  } catch {
    return null
  }
}
const readlinkOrNull = (p) => {
  try {
    return fs.readlinkSync(p)
  } catch {
    return null
  }
}
const removeFile = (p) => {
  try {
    fs.rmSync(p, { force: true })
    return true
  } catch {
    return false
  }
}

// Removes what was just renamed aside: a real directory recursively, anything else (a link included) as one file.
function discardAside(moved) {
  try {
    fs.rmSync(moved, { recursive: lstatOrNull(moved)?.isDirectory() === true, force: true })
  } catch {
    // a leftover renamed copy is harmless, and the next taker uses another name
  }
}

function lockPathOf(root) {
  const gitDir = path.join(root, '.git')
  return lstatOrNull(gitDir)?.isDirectory() ? path.join(gitDir, LOCK_NAME) : null
}

function ownerPid(owner) {
  const head = owner.split(':')[0]
  return /^\d{1,10}$/.test(head) ? Number(head) : null
}

function pidGone(pid) {
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    return error.code === 'ESRCH'
  }
}

export function lockLooksStale(lockPath, owner, now = Date.now()) {
  const pid = ownerPid(owner)
  if (pid !== null && pid > 0 && pidGone(pid)) return true
  const st = lstatOrNull(lockPath)
  return st !== null && now - st.mtimeMs > LOCK_STALE_MIN * 60000
}

function restoreLock(lockPath, taken, ops) {
  try {
    ops.symlinkSync(taken, lockPath)
  } catch {
    raiseNotice('lock-restore-failed')
  }
}

// Renames the lock to a name of this taker's, then looks at what was taken. `keep` is the owner the caller judged: anything
// else that was taken is put back.
function takeAway(lockPath, moved, keep, ops) {
  try {
    ops.renameSync(lockPath, moved)
  } catch {
    return false
  }
  const taken = readlinkOrNull(moved)
  if (taken !== null && taken !== keep) restoreLock(lockPath, taken, ops)
  discardAside(moved)
  return true
}

export function breakStale(lockPath, owner, token, ops = fs) {
  return takeAway(lockPath, `${lockPath}.stale.${token}`, owner, ops)
}

// A directory or file where the lock should be: not a lock of ours, so it is renamed aside and removed.
function breakForeign(lockPath, token, ops) {
  const moved = `${lockPath}.foreign.${token}`
  try {
    ops.renameSync(lockPath, moved)
  } catch {
    return false
  }
  discardAside(moved)
  return true
}

function makeLink(token, lockPath, ops) {
  try {
    ops.symlinkSync(token, lockPath)
    return 'held'
  } catch (error) {
    return error.code === 'EEXIST' ? 'exists' : 'error'
  }
}

// Looks at what is in the way of a lock that could not be made. True when it was stale or foreign and is gone (try again), false
// when it is somebody's live lock.
function clearInTheWay(lockPath, token, ops) {
  const st = lstatOrNull(lockPath)
  if (st === null) return true
  if (!st.isSymbolicLink()) return breakForeign(lockPath, token, ops)
  const owner = readlinkOrNull(lockPath)
  if (owner === null || !lockLooksStale(lockPath, owner)) return false
  breakStale(lockPath, owner, token, ops)
  return true
}

// One attempt, with stale locks broken: { status: 'held', token } | { status: 'busy' } | { status: 'none' } (no git directory to
// hold a lock) | { status: 'error' } (a lock could not be made here).
export function tryLock(root, pid, ops = fs) {
  const lockPath = lockPathOf(root)
  if (lockPath === null) return { status: 'none' }
  const token = `${pid}:${randomBytes(6).toString('hex')}`
  for (let attempt = 0; attempt < STALE_BREAK_ATTEMPTS; attempt += 1) {
    const made = makeLink(token, lockPath, ops)
    if (made === 'held') return { status: 'held', token }
    if (made === 'error') return { status: 'error' }
    if (!clearInTheWay(lockPath, token, ops)) return { status: 'busy' }
  }
  return { status: 'busy' }
}

// Whether the lock path still names this token. A takeover can displace a live holder when it takes a fresh lock by mistake and then cannot put it
// back (another taker having filled the path first); the holder finds out here, just before it commits, and gives up (L2). The window between this
// look and the rename that follows is the length of one system call.
export function holdsLock(root, token) {
  const lockPath = lockPathOf(root)
  return lockPath !== null && readlinkOrNull(lockPath) === token
}

// Releases the lock this token holds, and only that one: a lock that carries another token is put straight back.
export function unlock(root, token, ops = fs) {
  const lockPath = lockPathOf(root)
  if (lockPath === null || !TOKEN_RE.test(token)) return false
  return takeAway(lockPath, `${lockPath}.release.${token}`, token, ops)
}

const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

// Waits for a held lock: LOCK_TRIES tries LOCK_WAIT_MS apart, then `busy`.
export function acquireLock(root, pid, { tries = LOCK_TRIES, wait = pause, ops = fs } = {}) {
  for (let i = 0; i <= tries; i += 1) {
    const got = tryLock(root, pid, ops)
    if (got.status !== 'busy') return got
    wait(LOCK_WAIT_MS)
  }
  return { status: 'busy' }
}

// The result file as it is placed: from the per-run directory through the guarded read, a regular file (not a link), not
// empty, within its cap. { text } or { problem }.
function resultText(dir, name, cap) {
  const got = readRepoFile(dir, name, cap)
  if (got.status === 'ok') return got.text === '' ? { problem: D.EMPTY } : { text: got.text }
  if (got.status === 'too_large') return { problem: fill(D.TOO_LARGE, { cap }) }
  return { problem: lstatOrNull(path.join(dir, name))?.isSymbolicLink() ? D.IS_SYMLINK : D.NOT_REGULAR }
}

// Stages the text beside its destination as a fresh exclusive file of mode 0600. { tmp } or { problem }.
function stageText(text, dest, ops) {
  const destDir = path.dirname(dest)
  if (lstatOrNull(destDir)?.isSymbolicLink() || lstatOrNull(dest)?.isDirectory()) return { problem: D.DESTINATION }
  try {
    ops.mkdirSync(destDir, { recursive: true })
  } catch {
    return { problem: D.NO_DESTINATION_DIR }
  }
  const tmp = path.join(destDir, `.optimise-output.${randomBytes(6).toString('hex')}`)
  try {
    ops.writeFileSync(tmp, text, { flag: 'wx', mode: 0o600 })
  } catch {
    return { problem: D.NO_STAGING }
  }
  return { tmp }
}

// Removes the staged temp files a killed run left in the destination directories: regular files named exactly as this module names
// them, nothing else, and nothing reached through a link. Only called while the sidecar lock is held, so no other run of this
// module is staging at the same moment.
function sweepStaged(destDirs) {
  for (const dir of new Set(destDirs)) {
    if (lstatOrNull(dir)?.isDirectory() !== true) continue
    let names = []
    try {
      names = fs.readdirSync(dir)
    } catch {
      continue
    }
    for (const name of names) if (STAGED_RE.test(name) && lstatOrNull(path.join(dir, name))?.isFile()) removeFile(path.join(dir, name))
  }
}

const rejection = (what, problem) => `${what === 'report' ? F.REPORT_REJECTED : F.SIDECAR_REJECTED} ${problem}`

// Both outputs staged before either is renamed, the sidecar renamed first: it is a superset of the old one, so a failure
// before the report's rename leaves the old report beside a sidecar that still maps every id it names, never a new report
// beside an old sidecar. { problem } is null when both are in place; a failure leaves no staged temp file behind. The caller holds
// the sidecar lock.
export function placeOutputs({ dir, repo, sidecarRoot, stillHolds }, ops = fs) {
  const parts = [
    { what: 'report', name: 'result-report.md', cap: REPORT_CAP, dest: path.join(repo, REPORT_REL) },
    { what: 'sidecar', name: 'result-sidecar.json', cap: SIDECAR_CAP, dest: path.join(sidecarRoot, SIDECAR_REL) },
  ]
  sweepStaged(parts.map((part) => path.dirname(part.dest)))
  const staged = []
  const discard = () => staged.forEach((tmp) => removeFile(tmp))
  for (const part of parts) {
    const read = resultText(dir, part.name, part.cap)
    const got = read.problem ? read : stageText(read.text, part.dest, ops)
    if (got.problem) {
      discard()
      return { problem: rejection(part.what, got.problem) }
    }
    staged.push(got.tmp)
  }
  if (stillHolds && !stillHolds()) {
    discard()
    return { problem: F.LOCK_UNUSABLE }
  }
  const moved = (tmp, dest) => {
    try {
      ops.renameSync(tmp, dest)
      return true
    } catch {
      return false
    }
  }
  if (!moved(staged[1], parts[1].dest)) {
    discard()
    return { problem: F.MOVE_FAILED }
  }
  staged.pop()
  if (!moved(staged[0], parts[0].dest)) {
    discard()
    return { problem: F.MOVE_FAILED }
  }
  return { problem: null }
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
  const lines = [`TOKENS ${v.tokens}`, `DENIED ${v.denied}`]
  if (v.tools !== undefined) lines.push(`TOOLS ${v.tools}`)
  if (v.cause) lines.push(`CAUSE ${v.cause}`)
  for (const token of v.notices ?? []) lines.push(`NOTICE ${token}`)
  for (const reason of cappedReasons(v.reasons)) lines.push(`REASON ${reason}`)
  if (v.held) lines.push(`HELD ${v.held}`)
  lines.push(`PLACE ${v.place}`)
  if (v.placed === true) lines.push('PLACED yes')
  return `${lines.join('\n')}\n`
}

// The attended entry's output: one verdict first (PASS only when the report was placed and no reason was raised: a lane that
// could not run places the report and is still a FAIL), then the lines above.
export function formatAttended(v) {
  return `VERDICT ${v.place === 'yes' && v.reasons.length === 0 ? 'PASS' : 'FAIL'}\n${formatVerdict(v)}`
}

// ---- the proof that the output paths are ignored (written by optimise-report-ignore.mjs prepare, which may spawn git; this module may not) ----
//
// Placement needs it: a short-lived file in the per-run directory naming the main checkout, both output paths and when it was made.
// It is checked against the main checkout this run places in and consumed when used, so an operator who skipped the step, a proof for
// another checkout, a stale one or a used one all come to the same fixed FAIL. The per-run directory is private to the run.
export const PROOF_NAME = 'ignore-proof.json'
export const PROOF_MAX_AGE_MS = 2 * 3600 * 1000
function takeIgnoreProof(dir, root) {
  const got = readRepoFile(dir, PROOF_NAME, 4096)
  if (got.status !== 'ok') return false
  let proof
  try {
    proof = JSON.parse(got.text)
  } catch {
    return false
  }
  const age = Date.now() - proof?.at
  const fresh = Number.isFinite(age) && age < PROOF_MAX_AGE_MS && age > -60000
  const named = isObject(proof) && proof.report === REPORT_REL && proof.sidecar === SIDECAR_REL && typeof proof.root === 'string' && realPathOrNull(proof.root) === realPathOrNull(root)
  if (!fresh || !named || realPathOrNull(root) === null) return false
  removeFile(path.join(dir, PROOF_NAME))
  return true
}

// ---- the critical section: the runner's settle form and the attended entry both come through here ----

// A signal that arrives while the lock is held is answered only after the section has finished: the handler runs when the event
// loop next turns, which is after the (synchronous) read, merge and placement, so a stop never leaves a half-placed pair, a
// staged temp file or a held lock. Installed once, when the first lock is taken; before that a signal stops the process at once.
const SIGNAL_EXIT_CODES = { SIGTERM: 143, SIGINT: 130, SIGHUP: 129 }
let signalsGuarded = false
function guardSignals() {
  if (signalsGuarded) return
  signalsGuarded = true
  for (const [name, code] of Object.entries(SIGNAL_EXIT_CODES)) process.on(name, () => process.exit(code))
}

const lockReasons = { busy: F.LOCK_BUSY, none: F.LOCK_UNUSABLE, error: F.LOCK_UNUSABLE }

function writeResultFiles(dir, v) {
  fs.writeFileSync(`${dir}/result-report.md`, v.report, { mode: 0o600 })
  fs.writeFileSync(`${dir}/result-sidecar.json`, v.sidecar, { mode: 0o600 })
}

// A trusted result is placed when the per-run directory holds the proof that the output paths are ignored in this main checkout, and is
// not placed when the caller withheld it. With no proof the attended entry FAILs with the fixed reason; the runner's result is held
// (HELD ignore-proof, PLACE yes, nothing written) so it can make the paths ignored only now that it is about to place, and call again.
function placeTrusted(v, { dir, repo, sidecarRoot, place, attended }, ops, stillHolds) {
  if (v.place !== 'yes' || place === 'withheld') return v
  if (!takeIgnoreProof(dir, sidecarRoot)) return attended ? { ...v, reasons: [...v.reasons, F.IGNORE_PROOF], place: 'no' } : { ...v, held: 'ignore-proof' }
  writeResultFiles(dir, v)
  const placed = placeOutputs({ dir, repo, sidecarRoot, stillHolds }, ops)
  return placed.problem === null ? { ...v, placed: true } : { ...v, reasons: [...v.reasons, placed.problem], place: 'no' }
}

// `repo` is where the report is placed and `sidecarRoot` the main checkout whose .claude/ holds the sidecar and whose git directory
// holds the lock; `ignored` is the caller's word that both output paths are confirmed ignored there. The whole of this runs
// while the lock is held: the sidecar is read, validated, merged and placed inside it and nowhere else. { ...verdict, notices }.
async function criticalSection(opts, ops) {
  const { sidecarRoot, wait, tries } = opts
  const lock = acquireLock(sidecarRoot, process.pid, { wait, ops, ...(tries === undefined ? {} : { tries }) })
  if (lock.status !== 'held') return { ...verifyRun({ ...opts, sessionPath: '-' }), reasons: [lockReasons[lock.status]], place: 'no' }
  guardSignals()
  try {
    return placeTrusted(verifyRun(opts), opts, ops, () => holdsLock(sidecarRoot, lock.token))
  } finally {
    unlock(sidecarRoot, lock.token, ops)
  }
}

export async function settleRun(opts, ops = fs) {
  let verdict
  try {
    if (opts.analysedRepo !== undefined && !isMainCheckoutOf(opts.analysedRepo, opts.sidecarRoot)) return { ...verifyRun({ ...opts, sessionPath: '-' }), reasons: [F.MAIN_CHECKOUT], place: 'no', notices: [] }
    verdict = await criticalSection(opts, ops)
  } catch {
    verdict = { ...verifyRun({ ...opts, sessionPath: '-' }), reasons: [F.LOCK_HELPER_FAILED], place: 'no' }
  }
  return { ...verdict, notices: drainNotices() }
}

// ---- the attended entry (T4) ----
//
// The operator's own session collected into a private directory, called the workflow with the digest and a nonce, saved the object
// it returned unchanged, and made the two output paths ignored in the main checkout (and confirmed it with git). This is the whole
// of what happens next, in one run: the main checkout the skill resolved is checked against the repository, then the same
// critical section the runner uses. The session writes neither output itself.

// The pointer a linked worktree's .git file holds must name an entry under the main checkout's own worktrees directory, and that
// entry must point back at this worktree (git writes both): otherwise a repository could name another repository's entry as its own.
function pointsBackAtRepo(repo) {
  const pointer = readRepoFile(repo, '.git', REPO_FILE_CAPS.gitPointer)
  const first = pointer.status === 'ok' ? pointer.text.split('\n')[0] : ''
  if (!first.startsWith('gitdir: ')) return false
  const back = readRepoFile(path.resolve(repo, first.slice('gitdir: '.length).trim()), 'gitdir', REPO_FILE_CAPS.gitPointer)
  if (back.status !== 'ok') return false
  const named = realPathOrNull(back.text.trim())
  return named !== null && named === realPathOrNull(path.join(repo, '.git'))
}

// Whether `root` (an absolute path to a real directory that is not a link, holding a real .git directory) is the main checkout of
// `repo`: the repository itself, or the main checkout a linked worktree's pointer resolves to, by the reader's guarded reads.
export function isMainCheckoutOf(repo, root) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) return false
  if (!lstatOrNull(root)?.isDirectory() || !lstatOrNull(path.join(root, '.git'))?.isDirectory()) return false
  const resolved = resolveLedgerRoot(repo)
  const want = realPathOrNull(root)
  if (want === null) return false
  // A layout the reader cannot resolve (a submodule, a separate git directory) is only its own root, as before.
  if (resolved.unresolved) return realPathOrNull(repo) === want
  return realPathOrNull(resolved.root) === want && (realPathOrNull(repo) === want || pointsBackAtRepo(repo))
}

export async function attendedRun({ dir, resultFile, repo, root, home, nonce, wait, tries }, ops = fs) {
  const base = { dir, digestToken: 'ran', repo: root, boundedPaths: [repo, root], runTmp: dir, home, nonce, attended: true }
  return settleRun({ ...base, sessionPath: resultFile, sidecarRoot: root, analysedRepo: repo, place: 'place', wait, tries }, ops)
}

// ---- command line ----

function verifyMain(argv) {
  const [dir, sessionPath, digestToken, repo, runTmp, sidecarRoot] = argv
  const v = verifyRun({ dir, sessionPath, digestToken, repo, runTmp, home: process.env.HOME, sidecarRoot, nonce: process.env.OPTIMISE_VERIFY_NONCE })
  if (v.place === 'yes') writeResultFiles(dir, v)
  process.stdout.write(formatVerdict(v))
}

async function settleMain(argv) {
  const [dir, sessionPath, digestToken, repo, runTmp, sidecarRoot, mode] = argv
  const v = await settleRun({ dir, sessionPath, digestToken, repo: sidecarRoot, boundedPaths: [repo, sidecarRoot], runTmp, home: process.env.HOME, sidecarRoot, analysedRepo: repo, nonce: process.env.OPTIMISE_VERIFY_NONCE, place: mode === 'place' ? 'place' : 'withheld' })
  process.stdout.write(formatVerdict(v))
}

async function attendedMain(argv) {
  const [dir, resultFile, repo, root] = argv
  const v = await attendedRun({ dir, resultFile, repo, root, home: process.env.HOME, nonce: process.env.OPTIMISE_VERIFY_NONCE })
  process.stdout.write(formatAttended(v))
}

const COMMANDS = { settle: settleMain, attended: attendedMain }

export async function main(argv) {
  const command = COMMANDS[argv[0]]
  if (command) await command(argv.slice(1))
  else verifyMain(argv)
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
if (isMain) await main(process.argv.slice(2))
