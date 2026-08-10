#!/usr/bin/env node
// The run-ledger writer: a standalone, ordinary Node script, NOT a
// dynamic-workflow script. Workflow scripts (workflows/*.js) run in a
// sandbox that statically rejects any import (static or dynamic) and
// Date.now()/new Date()/Math.random() before execution even starts
// (confirmed against the live runtime; see specs/optimise-cycle.md's
// "Verified runtime facts" in the main checkout). They therefore cannot
// import this file, use node:crypto, or read the system clock themselves.
//
// This is the ONE place all of that lives instead:
//   - the JSONL envelope schema (AC-ARCH-5's single definition site)
//   - schema validation, free-text truncation
//   - findingId hashing (node:crypto; AC-QA-11 -- "derived mechanically in
//     script code" is satisfied by this being real-Node script code)
//   - the timestamp (real Date, since this process is not sandboxed) and
//     run_id (reused from the payload if supplied, for the start/terminal
//     pairing protocol -- AC-DATA-5)
//   - path resolution via `git rev-parse --git-common-dir` (AC-DATA-1,
//     AC-SEC-5), gitignore-ensure (AC-SEC-1), and the single-write() append
//     (AC-DATA-2, AC-DATA-3)
//
// A workflow's final agent() step is instructed (see the inline prompt-
// building in each of tdd-task.js/review-cycle.js/plan-cycle.js) to locate
// this script and run it via Bash, piping its own kind-specific payload to
// stdin as opaque JSON data -- never interpolated into a shell command or
// path (AC-SEC-6).
//
// Usage: node ledger-append.mjs < payload.json
// Prints exactly one line of JSON to stdout: {run_id, ts, write_ok, write_error}
// Always exits 0: a ledger write failure must never fail the caller's run.
//
// Every export below is also unit-testable directly (see
// test/ledger-append.test.js): importing this module for its exports does
// NOT run main() as a side effect -- only a direct `node ledger-append.mjs`
// invocation does (guarded below).

import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const SCHEMA_VERSION = 1

// Hard-coded and not configurable (AC-SIMP-2): resolved against the MAIN
// checkout root (never a worktree's own .claude/) via `git rev-parse
// --git-common-dir` below (AC-DATA-1, AC-SEC-5).
export const LEDGER_RELATIVE_PATH = '.claude/harness-ledger.jsonl'

// A single ledger line is written with one write() call (AC-DATA-3). This
// bounds the line so that append stays within the POSIX guarantee that a
// write() smaller than PIPE_BUF to an O_APPEND file descriptor is atomic;
// free-text fields are truncated to fit before the line is ever built.
export const MAX_LINE_BYTES = 2048

// M2: a stated bound on the findings array, so a run with an unusually
// large number of findings (a 7-lens envelope, or open_findings covering
// every finding every lens reported, H5) degrades gracefully -- the
// findings that DID fit are kept and findings_truncated records the rest,
// rather than the whole line silently failing to write once the count
// alone pushes it over MAX_LINE_BYTES.
export const MAX_FINDINGS = 15

const KINDS = ['tdd_task', 'review_cycle', 'plan_cycle', 'conduct_plan_event']
const OUTCOMES = ['done', 'blocked', 'aborted', 'no-op', 'started']
const SEVERITIES = ['Critical', 'High', 'Medium', 'Low']
// 'fixed' is never written by the workflows in this PR: no single run can
// know a finding from an earlier round was fixed. It is reserved for a
// later consumer that compares finding ids (AC-QA-11) across ledger lines.
const DISPOSITIONS = ['open', 'rejected', 'spec_bug', 'fixed']

// The envelope + payload schema for one ledger line. additionalProperties is
// false at every object level (AC-SEC-2): a field that is not declared here
// cannot reach the ledger, which is what keeps free-text lens evidence,
// finding locations and the review-cycle markdown report out of it.
export const LEDGER_ENTRY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['schema_version', 'run_id', 'ts', 'repo', 'kind', 'outcome', 'write_ok', 'write_error'],
  // M3: event_key is unconditionally optional above (some kinds have no
  // concept of it) but must be present for conduct_plan_event specifically
  // -- AC-QA-9's idempotent-replay dedup depends entirely on it, so a
  // conduct_plan_event line with no event_key would validate and be
  // written, defeating the whole mechanism. Declared here, in the schema
  // (AC-ARCH-5's single definition site), rather than as an ad-hoc check
  // in main(), so the rule stays discoverable from the schema object alone.
  requiredWhen: [{ when: { kind: 'conduct_plan_event' }, require: ['event_key'] }],
  properties: {
    schema_version: { type: 'integer', const: SCHEMA_VERSION },
    run_id: { type: 'string', minLength: 1 },
    // ISO-8601, sourced from this real (unsandboxed) process's clock
    // (AC-QA-10) -- never computed inside a workflow script.
    ts: { type: 'string', minLength: 1 },
    // Repo-relative identity only (e.g. "owner/repo" or a bare dir name).
    // Never an absolute path (AC-SEC-3).
    repo: { type: 'string', minLength: 1 },
    kind: { type: 'string', enum: KINDS },
    outcome: { type: 'string', enum: OUTCOMES },
    spec: { type: ['string', 'null'] },
    task: { type: ['string', 'null'] },
    round_key: { type: ['string', 'null'] },
    lenses_run: { type: 'array', items: { type: 'string' } },
    lenses_skipped: { type: 'array', items: { type: 'string' } },
    // H2 round 2: a bare `type: 'object'` bounded nothing about what lives
    // INSIDE the object -- a hostile payload could hide an absolute path or
    // a secret in an extra key with an arbitrary string value, and
    // additionalProperties:false (which only governs the OBJECT's own key
    // set) does not reach inside a dictionary-shaped value at all.
    // additionalProperties here is a value-schema (validateEntry's dict-value
    // extension, not the boolean form used elsewhere): every value in the
    // object must itself satisfy it.
    trigger_counts: { type: 'object', additionalProperties: { type: 'integer' } },
    verdicts: { type: 'object', additionalProperties: { type: 'string', enum: ['CLEAN', 'FINDINGS', 'BLOCKED'] } },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'lens', 'severity', 'disposition'],
        properties: {
          id: { type: 'string' },
          // M6: the evidence-exclusion guarantee ("lens evidence and
          // location strings are never written") was enforced by field
          // name only -- `lens` and `ac_id` were bare strings, so a secret
          // or a quoted source line routed through either field wrote
          // verbatim. additionalProperties:false on `evidence` itself
          // cannot catch this: it is a different route into the same line.
          lens: { type: 'string', pattern: '^(lens|reviewer)-[a-z]+$' },
          severity: { type: 'string', enum: SEVERITIES },
          ac_id: { type: ['string', 'null'], pattern: '^AC-[A-Z]+-[0-9]+$' },
          disposition: { type: 'string', enum: DISPOSITIONS },
        },
      },
    },
    spec_bug_count: { type: ['integer', 'null'] },
    rejected_finding_count: { type: ['integer', 'null'] },
    // M2: how many findings were computed but dropped to keep `findings`
    // within MAX_FINDINGS -- an integer (a real, measured 0 when nothing
    // was dropped) when finding arrays were supplied at all, null when
    // they were not (a kind with no findings concept, e.g. tdd_task).
    findings_truncated: { type: ['integer', 'null'] },
    rounds: { type: ['object', 'null'], additionalProperties: { type: 'integer' } },
    budget_spent: { type: ['number', 'null'] },
    // conduct_plan_event only: which state transition this line records, and
    // an idempotency key (run_id + event) so a re-tick that replays an
    // already-recorded event does not double-count it (AC-QA-9).
    event: { type: ['string', 'null'] },
    event_key: { type: ['string', 'null'] },
    // M2: true only when the record had to be shrunk to the minimal
    // envelope-only form because it still exceeded MAX_LINE_BYTES even
    // after byte-truncating free text and bounding findings -- absent/null
    // on an ordinary record, never false (unmeasured is not "definitely not
    // degraded", it is "no degradation was needed to decide").
    degraded: { type: ['boolean', 'null'] },
    write_ok: { type: 'boolean' },
    write_error: { type: ['string', 'null'] },
  },
}

// A stable id for a finding: same lens + normalised location + digest of the
// claim text yields the same id on a re-report; two different defects at the
// same file:line yield different ids (AC-QA-11).
export function findingId(lens, location, claim) {
  const normalisedLocation = String(location || '').trim().toLowerCase()
  const hash = createHash('sha256')
    .update(String(lens || ''))
    .update(' ')
    .update(normalisedLocation)
    .update(' ')
    .update(String(claim || ''))
    .digest('hex')
  return hash.slice(0, 16)
}

// Bounds a free-text field to `max` characters. Passes null/undefined
// through unchanged so "field not supplied" stays distinguishable from
// "field supplied and empty" (AC-DATA-3's truncation clause).
export function truncate(value, max) {
  if (value === null || value === undefined) return value
  const s = String(value)
  return s.length > max ? s.slice(0, max) : s
}

// M2: MAX_LINE_BYTES is a BYTE cap, but the previous truncate() bounded by
// character count, so 500 multibyte characters (e.g. 500 * 3-byte UTF-8
// characters = 1500 bytes) could still push a line over the limit on its
// own. Trims one character at a time (safe against splitting a surrogate
// pair mid-character, unlike slicing the encoded Buffer directly) until
// the UTF-8 byte length fits.
export function truncateBytes(value, maxBytes) {
  if (value === null || value === undefined) return value
  let s = String(value)
  while (Buffer.byteLength(s, 'utf8') > maxBytes) {
    s = s.slice(0, -1)
  }
  return s
}

// H2 round 2: the runtime "type" of a JSON value, distinguishing integers
// from other numbers (the schema uses 'integer' for count-shaped fields) and
// null from 'object' (typeof null === 'object' in JS, which is not useful
// here since the schema expresses nullability as a union member instead).
function jsonType(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (typeof value === 'number' && Number.isInteger(value)) return 'integer'
  return typeof value
}

// Checks `value` against a declared `type`, which may be a single type name
// or a union array (e.g. ['string', 'null']). 'number' accepts an integer
// too (an integer IS a number); 'integer' does not accept a non-integer
// number.
function typeMatches(value, declaredType) {
  if (!declaredType) return true
  const types = Array.isArray(declaredType) ? declaredType : [declaredType]
  const actual = jsonType(value)
  return types.some((t) => (t === 'number' ? actual === 'number' || actual === 'integer' : actual === t))
}

// A minimal, dependency-free structural validator against
// LEDGER_ENTRY_SCHEMA: required fields present, no properties outside the
// declared set, enums honoured. Not a general JSON Schema engine -- just
// enough to keep this dependency-free (AC-SIMP-1).
export function validateEntry(entry, schema = LEDGER_ENTRY_SCHEMA, pathPrefix = '') {
  const errors = []
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    return [`${pathPrefix || '(root)'}: expected an object`]
  }
  for (const key of schema.required || []) {
    if (!(key in entry)) errors.push(`${pathPrefix}${key}: required property missing`)
  }
  // M3: conditional-required rules, e.g. event_key is only required when
  // kind === 'conduct_plan_event'. Generic (matches every key/value pair
  // in `when`) so future kind-specific requirements can reuse it rather
  // than each needing its own ad-hoc check.
  for (const rule of schema.requiredWhen || []) {
    const matches = Object.entries(rule.when).every(([k, v]) => entry[k] === v)
    if (matches) {
      for (const key of rule.require) {
        if (!(key in entry) || entry[key] === null || entry[key] === undefined) {
          errors.push(`${pathPrefix}${key}: required when ${JSON.stringify(rule.when)}`)
        }
      }
    }
  }
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(entry)) {
      if (!(key in schema.properties)) errors.push(`${pathPrefix}${key}: not an allowed property`)
    }
  }
  for (const [key, propSchema] of Object.entries(schema.properties || {})) {
    if (!(key in entry)) continue
    const value = entry[key]
    // H2 round 2: previously the ONLY checks below this line were enum,
    // pattern and array-item shape -- a property's own declared `type` was
    // never enforced, so a number, an object, or an array could sit in a
    // field declared `type: 'string'` (or vice versa) and validate cleanly.
    // A type mismatch makes every check below meaningless for this value
    // (matching an enum/pattern against the wrong kind of value is not a
    // real check), so it short-circuits the rest of this property's checks.
    if (propSchema.type && !typeMatches(value, propSchema.type)) {
      errors.push(`${pathPrefix}${key}: expected type ${JSON.stringify(propSchema.type)}, got ${jsonType(value)}`)
      continue
    }
    // Dictionary-shaped objects (trigger_counts, verdicts, rounds): the key
    // set is caller-defined (a lens name, a counter name), so
    // additionalProperties:false cannot apply -- but every VALUE in the
    // object must still satisfy a declared value-schema, or an arbitrary
    // extra key can carry an absolute path or a secret through untyped.
    if (value !== null && typeof value === 'object' && !Array.isArray(value) && propSchema.additionalProperties && typeof propSchema.additionalProperties === 'object') {
      const valueSchema = propSchema.additionalProperties
      for (const [dictKey, dictValue] of Object.entries(value)) {
        const dictPath = `${pathPrefix}${key}.${dictKey}`
        if (valueSchema.type && !typeMatches(dictValue, valueSchema.type)) {
          errors.push(`${dictPath}: expected type ${JSON.stringify(valueSchema.type)}, got ${jsonType(dictValue)}`)
          continue
        }
        if (valueSchema.enum && !valueSchema.enum.includes(dictValue)) {
          errors.push(`${dictPath}: "${dictValue}" is not one of ${JSON.stringify(valueSchema.enum)}`)
        }
      }
    }
    if (propSchema.enum && value !== null && value !== undefined && !propSchema.enum.includes(value)) {
      errors.push(`${pathPrefix}${key}: "${value}" is not one of ${JSON.stringify(propSchema.enum)}`)
    }
    if (propSchema.pattern && value !== null && value !== undefined && !new RegExp(propSchema.pattern).test(value)) {
      errors.push(`${pathPrefix}${key}: "${value}" does not match ${propSchema.pattern}`)
    }
    if (propSchema.type === 'array' && propSchema.items && Array.isArray(value)) {
      const itemsSchema = propSchema.items
      if (itemsSchema.type === 'object' || itemsSchema.properties) {
        // Object-item arrays (e.g. findings): recurse fully, including the
        // additionalProperties/required checks above.
        value.forEach((item, i) => {
          errors.push(...validateEntry(item, itemsSchema, `${pathPrefix}${key}[${i}].`))
        })
      } else {
        // Primitive-item arrays (e.g. lenses_run: string[]): checking each
        // element against the object-shaped validateEntry contract above
        // would reject every element outright (a string is never "an
        // object"), silently refusing the entire record. Check the
        // primitive's own type/enum instead.
        value.forEach((item, i) => {
          const itemPath = `${pathPrefix}${key}[${i}]`
          if (itemsSchema.type && typeof item !== itemsSchema.type) {
            errors.push(`${itemPath}: expected ${itemsSchema.type}, got ${typeof item}`)
          }
          if (itemsSchema.enum && !itemsSchema.enum.includes(item)) {
            errors.push(`${itemPath}: "${item}" is not one of ${JSON.stringify(itemsSchema.enum)}`)
          }
        })
      }
    }
  }
  return errors
}

// Turns raw finding descriptors ({lens, location, claim, severity?, ac_id?})
// into schema-shaped {id, lens, severity, ac_id, disposition} entries, or a
// null count when the descriptor array itself is null (AC-QA-13: a
// malformed synthesis response is unmeasured, never silently zero) versus a
// genuine empty array, which yields a real zero count (AC-OPS-3).
function computeFindings(descriptors, disposition) {
  if (!Array.isArray(descriptors)) return { entries: [], count: null }
  const entries = descriptors.map((f) => ({
    id: findingId(f.lens, f.location, f.claim),
    lens: f.lens,
    severity: f.severity || 'Low',
    ac_id: f.ac_id || null,
    disposition,
  }))
  return { entries, count: entries.length }
}

const TRUNCATABLE_FIELDS = ['task', 'spec', 'round_key', 'event', 'event_key']

// Matches an absolute POSIX path (leading /, at least one more non-blank
// segment) or a Windows drive-letter path, wherever it appears inside a
// string -- not just when the whole field IS a path (a `task` description
// is free text that may simply mention one). The leading slash must be at
// the very start of the string or preceded by whitespace/an opening quote
// or paren: without that anchor, a genuinely relative path that merely
// CONTAINS a slash (e.g. "specs/foo.md") would have its "/foo.md" tail
// misread as an absolute path and mangled.
const ABSOLUTE_PATH_RE = /(^|[\s'"(])([A-Za-z]:\\[^\s'")]+|\/[^\s'")]+)/g

// Replaces every absolute path found inside `value` with its path relative
// to `root` when it lives under the repo (H2: the common, recoverable
// case -- an operator's own repo path leaking into the ledger), or with a
// fixed redaction marker when it does not (an absolute path elsewhere on
// disk cannot be made repo-relative, and leaving it verbatim is exactly
// the leak AC-SEC-3 forbids; relativising is preferred over rejecting the
// whole record so a path mention never silently drops a run's telemetry).
// Passes null/undefined/non-strings through unchanged.
export function redactPaths(value, root) {
  if (value === null || value === undefined) return value
  const s = String(value)
  return s.replace(ABSOLUTE_PATH_RE, (whole, prefix, absPath) => {
    if (root && (absPath === root || absPath.startsWith(root + path.sep))) {
      const rel = path.relative(root, absPath)
      return prefix + (rel === '' ? '.' : rel)
    }
    return prefix + '<redacted-path>'
  })
}

// Strips every occurrence of `root` (an absolute path) out of free text,
// e.g. an error message, without needing the fuller redactPaths pattern
// match -- used on paths a Node error object hands back verbatim
// (L6: the failure-path variant of H2).
function stripRoot(text, root) {
  if (!root) return text
  return String(text).split(root).join('<repo>')
}

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8')
  } catch (e) {
    return ''
  }
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function resolveMainCheckoutRoot(cwd) {
  const commonDir = git(['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd)
  return path.dirname(commonDir)
}

// H2 round 2: an origin remote is not always a recognised host form -- it
// can be a bare local filesystem path (`git remote add origin
// <absolute-path-to-some-other-clone>`, a common local-clone workflow), and
// the old code's regex matched that just as happily as a real host URL,
// extracting the path's own trailing two segments (which can include a
// username, as one operator's local layout did) as `repo`. Only a
// recognised remote-host form -- scp-like `user@host:path` syntax, or an
// explicit URL scheme -- is trusted for identity; anything else falls
// through to the toplevel-basename fallback below, same as no remote at all.
const REMOTE_HOST_RE = /^(?:[\w.-]+@[\w.-]+:|(?:https?|ssh|git):\/\/)/

function resolveRepoIdentity(cwd) {
  try {
    const url = git(['remote', 'get-url', 'origin'], cwd)
    if (REMOTE_HOST_RE.test(url)) {
      const m = url.match(/[/:]([^/:]+\/[^/]+?)(\.git)?$/)
      if (m) return m[1]
    }
  } catch (e) {
    // no remote; fall through
  }
  try {
    return path.basename(git(['rev-parse', '--show-toplevel'], cwd))
  } catch (e) {
    return 'unknown'
  }
}

// M7: ignores the ledger via .git/info/exclude rather than editing the
// operator's own tracked .gitignore. Both have identical ignore effect
// (git reads .git/info/exclude exactly like a repo-root .gitignore), but
// info/exclude is itself untracked and repo-local -- it was never the
// operator's file to begin with, so writing to it can never turn up as a
// diff on a tracked file, never needs staging, and never gets swept into
// an unrelated `git add -A`.
function ensureGitignored(root) {
  const gitDir = path.join(root, '.git')
  const infoDir = path.join(gitDir, 'info')
  const excludePath = path.join(infoDir, 'exclude')
  fs.mkdirSync(infoDir, { recursive: true })
  let contents = ''
  if (fs.existsSync(excludePath)) contents = fs.readFileSync(excludePath, 'utf8')
  const lines = contents.split('\n')
  if (!lines.some((l) => l.trim() === LEDGER_RELATIVE_PATH)) {
    const sep = contents.length && !contents.endsWith('\n') ? '\n' : ''
    fs.writeFileSync(excludePath, contents + sep + LEDGER_RELATIVE_PATH + '\n')
  }
}

function result(run_id, ts, write_ok, write_error) {
  return { run_id, ts, write_ok, write_error: write_error || null }
}

export function main() {
  const cwd = process.cwd()
  const ts = new Date().toISOString()
  let payload
  try {
    const raw = readStdin()
    payload = raw.trim() ? JSON.parse(raw) : {}
  } catch (e) {
    return result(randomUUID(), ts, false, 'payload was not valid JSON: ' + e.message)
  }
  // A caller may supply run_id to pair a terminal record with an earlier
  // start record (the start/terminal protocol, AC-DATA-5); otherwise a
  // fresh one is generated, as for any ordinary single-record write.
  const run_id = typeof payload.run_id === 'string' && payload.run_id ? payload.run_id : randomUUID()

  // Resolved BEFORE redaction/truncation below: relativising an absolute
  // path (H2) needs to know the repo root first.
  let repo
  let root
  try {
    root = resolveMainCheckoutRoot(cwd)
    repo = resolveRepoIdentity(cwd)
  } catch (e) {
    return result(run_id, ts, false, 'could not resolve the main checkout via git rev-parse: ' + stripRoot(e.message, root))
  }

  // Relativise every recorded path against the repo root BEFORE truncation
  // (H2, AC-SEC-3): an absolute path under the root becomes repo-relative,
  // one outside it is redacted, so a leaked path never survives to the
  // ledger line whichever field it arrived in. H2 round 2: this previously
  // ran on `spec` and `task` only, by field NAME -- the conduct_plan_event
  // route documented in SKILL.md puts an absolute plan path inside
  // event_key, which was never covered, so it reached the ledger verbatim.
  // Looping over every TRUNCATABLE_FIELDS entry (which already lists
  // round_key, event and event_key alongside spec/task) closes that route
  // and any future one that reuses the same free-text field list, rather
  // than requiring a matching addition here every time that list grows.
  for (const field of TRUNCATABLE_FIELDS) {
    if (field in payload) payload[field] = redactPaths(payload[field], root)
  }
  // lenses_run/lenses_skipped are arrays of lens-name strings in the
  // ordinary case, but the schema does not constrain their contents to the
  // roster pattern (unlike `findings[].lens`), so a string element can carry
  // an absolute path just like any other free-text field.
  if (Array.isArray(payload.lenses_run)) payload.lenses_run = payload.lenses_run.map((v) => redactPaths(v, root))
  if (Array.isArray(payload.lenses_skipped)) payload.lenses_skipped = payload.lenses_skipped.map((v) => redactPaths(v, root))

  // Truncate free-text fields BEFORE validation/serialisation so an
  // oversized field cannot push the line over the single-write() bound.
  // Byte-based (M2), not character-based: MAX_LINE_BYTES is a byte cap, and
  // a field of multibyte characters could exceed it on its own even at a
  // "reasonable" character count.
  for (const field of TRUNCATABLE_FIELDS) {
    if (field in payload) payload[field] = truncateBytes(payload[field], 500)
  }

  // Finding computation (moved here from review-cycle.js: workflow scripts
  // have no node:crypto): raw spec_bugs/rejected_findings/open_findings
  // descriptors come in as data; schema-shaped {id, lens, severity, ac_id,
  // disposition} entries go out. open_findings (H5) is every finding a
  // lens actually reported, disposition 'open' -- without it, an accepted
  // finding that later gets fixed leaves no trace on any ledger line, and
  // "which lenses produce findings that get fixed" is uncomputable no
  // matter how the ledger is read.
  const specBugs = computeFindings(payload.spec_bugs, 'spec_bug')
  const rejected = computeFindings(payload.rejected_findings, 'rejected')
  const open = computeFindings(payload.open_findings, 'open')
  const { spec_bugs, rejected_findings, open_findings, ...restPayload } = payload
  const allFindings = [...specBugs.entries, ...rejected.entries, ...open.entries]
  // M2: bound the findings array at MAX_FINDINGS rather than letting an
  // unusually finding-heavy run (a 7-lens envelope, or H5's open_findings
  // covering every finding every lens reported) push the whole line over
  // the byte cap by count alone; findings_truncated records exactly how
  // many were dropped, a real measured number, never silently zero.
  const findingsFields =
    'spec_bugs' in payload || 'rejected_findings' in payload || 'open_findings' in payload
      ? {
          findings: allFindings.slice(0, MAX_FINDINGS),
          findings_truncated: Math.max(0, allFindings.length - MAX_FINDINGS),
          spec_bug_count: specBugs.count,
          rejected_finding_count: rejected.count,
        }
      : {}

  const entry = {
    ...restPayload,
    ...findingsFields,
    schema_version: SCHEMA_VERSION,
    run_id,
    ts,
    repo,
    write_ok: true,
    write_error: null,
  }

  const errors = validateEntry(entry)
  if (errors.length) {
    return result(run_id, ts, false, 'payload failed ledger schema validation: ' + errors.join('; '))
  }

  let line = JSON.stringify(entry)
  if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) {
    // M2: even after byte-truncating free text and bounding findings to
    // MAX_FINDINGS, the record can still be too large (many verdict/
    // trigger_counts keys, for instance). Degrade to the minimal valid
    // record -- envelope plus outcome plus a degraded flag -- rather than
    // writing nothing: a run with an unusually large amount of data is
    // exactly the run whose trace matters most downstream, not the one
    // that should vanish from the ledger entirely.
    const minimal = {
      schema_version: entry.schema_version,
      run_id: entry.run_id,
      ts: entry.ts,
      repo: entry.repo,
      kind: entry.kind,
      outcome: entry.outcome,
      degraded: true,
      write_ok: true,
      write_error: null,
    }
    const minimalErrors = validateEntry(minimal)
    if (minimalErrors.length) {
      // Should not be reachable (the envelope fields are always small and
      // already validated above), but never crash regardless.
      return result(run_id, ts, false, `line exceeded MAX_LINE_BYTES (${MAX_LINE_BYTES}) even after degrading to a minimal record: ${minimalErrors.join('; ')}`)
    }
    line = JSON.stringify(minimal)
    if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) {
      return result(run_id, ts, false, `even the minimal degraded record exceeded MAX_LINE_BYTES (${MAX_LINE_BYTES})`)
    }
  }

  try {
    ensureGitignored(root)
    const ledgerPath = path.join(root, LEDGER_RELATIVE_PATH)
    fs.mkdirSync(path.dirname(ledgerPath), { recursive: true })

    // M3: a conduct_plan_event replay (the conducting agent re-ticking and
    // re-observing a transition it already logged) must not double-count.
    // Rather than relying on the calling agent's own grep-before-append
    // (prose, unenforceable), the writer itself is idempotent by
    // construction: skip the append if this exact event_key already
    // appears in the ledger. This is a read-then-append, not a
    // read-modify-write of existing bytes (AC-DATA-2's append-only
    // guarantee is about never rewriting or truncating an existing line,
    // which this does not do); it does carry a narrow TOCTOU race under
    // truly concurrent writers racing on the identical event_key, accepted
    // as low-risk since conduct_plan_event lines come from one conducting
    // agent's sequential ticks, not parallel writers of the same event.
    if (entry.event_key && fs.existsSync(ledgerPath)) {
      const existing = fs.readFileSync(ledgerPath, 'utf8')
      const alreadyPresent = existing.split('\n').some((existingLine) => {
        if (!existingLine.trim()) return false
        try {
          return JSON.parse(existingLine).event_key === entry.event_key
        } catch (e) {
          return false // a truncated/corrupt line is not a match; never let it crash the check
        }
      })
      if (alreadyPresent) {
        return { ...result(run_id, ts, true, null), duplicate: true }
      }
    }

    // A single write() call, in append mode, of a line under MAX_LINE_BYTES:
    // POSIX guarantees this is atomic against other O_APPEND writers
    // (AC-DATA-3). Never read-modify-write.
    const fd = fs.openSync(ledgerPath, 'a')
    try {
      fs.writeSync(fd, line + '\n')
    } finally {
      fs.closeSync(fd)
    }
  } catch (e) {
    return result(run_id, ts, false, 'append failed: ' + stripRoot(e.message, root))
  }

  return result(run_id, ts, true, null)
}

// Only run as a CLI when invoked directly (`node ledger-append.mjs`), never
// as a side effect of another module importing this file for its exports
// (tests do exactly that).
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
if (isMain) {
  const out = main()
  process.stdout.write(JSON.stringify(out) + '\n')
  process.exit(0)
}
