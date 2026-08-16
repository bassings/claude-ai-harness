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

// HARN-OPT-2 PR1: bumped from 1 -- plan_key (below) is a genuine shape
// change to every written line, and AC-OPS-4 needs a stale installed
// mirror (~/.claude/workflows/lib/ledger-append.mjs, still writing the old
// shape) to be detectable from the report rather than failing silently.
export const SCHEMA_VERSION = 2

// Hard-coded and not configurable (AC-SIMP-2): resolved against the MAIN
// checkout root (never a worktree's own .claude/) via `git rev-parse
// --git-common-dir` below (AC-DATA-1, AC-SEC-5).
export const LEDGER_RELATIVE_PATH = '.claude/harness-ledger.jsonl'

// A single ledger line is written with one write() call (AC-DATA-3), which
// keeps a concurrent append from interleaving with this one regardless of
// size (not because of PIPE_BUF, which governs pipe writes specifically,
// not an O_APPEND write to a regular file -- the real guarantee is simply
// that one write() syscall's bytes land contiguously). Free-text fields are
// truncated to fit before the line is ever built.
//
// H3 round 2: this was 2048, and a realistic review round (roughly 10-12
// findings across a full lens roster) measured at ~2300-2500 bytes once
// bounded -- already over the old cap, so the record degraded to a
// ~221-byte envelope-only line, discarding lenses_run, verdicts,
// trigger_counts and every finding while still reporting write_ok:true.
// The ledger kept least data for the busiest rounds. 16 KB leaves ample
// headroom for a realistic round (see the fixture in
// test/ledger-append.test.js measuring the real shape) while still being a
// generous, not unbounded, ceiling on a single write().
export const MAX_LINE_BYTES = 16384

// M2: a stated bound on the findings array, so a run with an unusually
// large number of findings (a 7-lens envelope, or open_findings covering
// every finding every lens reported, H5) degrades gracefully -- the
// findings that DID fit are kept and findings_truncated records the rest,
// rather than the whole line silently failing to write once the count
// alone pushes it over MAX_LINE_BYTES.
export const MAX_FINDINGS = 15

// H4: a defensive bound on ac_verdicts, mirroring MAX_FINDINGS's shape
// rather than its expected frequency of use.
export const MAX_AC_VERDICTS = 200

// Review round-2 M-3: ac_id_raw retains a rejected ac_id for recoverability
// (AC-DATA-4's pattern, applied to ac_id), but ac_id was deliberately kept
// free of free text (AC-SEC-2, "no free text, ever") to prevent a secret or
// a quoted source line being routed through it (M6). Bounded short enough
// that a realistic citation form (a cross-spec-prefixed id, ~23 bytes;
// "AC-DATA-16 (deferred)", 22 bytes) survives whole, while a longer
// injection payload is cut down to a prefix, not retained whole -- a
// considered, bounded exposure, not the zero-free-text guarantee the field
// otherwise holds.
export const AC_ID_RAW_MAX_BYTES = 32

const KINDS = ['tdd_task', 'review_cycle', 'plan_cycle', 'conduct_plan_event']
const OUTCOMES = ['done', 'blocked', 'aborted', 'no-op', 'started']
// Review round-1 M3: the single definition site for the ac_id shape,
// shared by the schema declarations below AND by sanitizeAcIds (which
// removes/nulls a non-conforming value BEFORE validateEntry runs, so one
// free-text ac_id from a lens no longer fails the WHOLE record).
const AC_ID_PATTERN_STR = '^AC-[A-Z]+-[0-9]+$'
const AC_ID_RE = new RegExp(AC_ID_PATTERN_STR)
// M1 (round 4 remainder): the single definition site for the `lens` shape,
// shared by the schema declaration above and by the findings sanitiser
// (which nulls a non-conforming value BEFORE validateEntry runs, mirroring
// AC_ID_PATTERN_STR/AC_ID_RE exactly).
const LENS_PATTERN_STR = '^(lens|reviewer)-[a-z]+$'
const LENS_RE = new RegExp(LENS_PATTERN_STR)
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
  required: ['schema_version', 'run_id', 'ts', 'repo', 'kind', 'write_ok', 'write_error'],
  // M3: event_key is unconditionally optional above (some kinds have no
  // concept of it) but must be present for conduct_plan_event specifically
  // -- AC-QA-9's idempotent-replay dedup depends entirely on it, so a
  // conduct_plan_event line with no event_key would validate and be
  // written, defeating the whole mechanism. Declared here, in the schema
  // (AC-ARCH-5's single definition site), rather than as an ad-hoc check
  // in main(), so the rule stays discoverable from the schema object alone.
  //
  // L4: outcome used to be unconditionally required, so every
  // conduct_plan_event line -- including the ones recording an ENDING
  // (ci_wait_ended, human_wait_ended, pr_merged) -- had to carry
  // outcome: "started" just to satisfy the schema, purely to have
  // something valid to put there. Grouping ledger lines by (kind, outcome)
  // then read every conduct_plan_event line as "started", never empty or
  // honest about what it actually records. outcome is not a meaningful
  // concept for this kind at all, so it is required only for the three
  // kinds that actually have a terminal outcome.
  requiredWhen: [
    { when: { kind: 'conduct_plan_event' }, require: ['event_key'] },
    { when: { kind: 'tdd_task' }, require: ['outcome'] },
    { when: { kind: 'review_cycle' }, require: ['outcome'] },
    { when: { kind: 'plan_cycle' }, require: ['outcome'] },
  ],
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
    // HARN-OPT-2 PR1 round 5 (AC-DATA-4): the caller's original spec
    // string, retained verbatim -- see main()'s own comment at the write
    // site for why this exists. Never emitted by the reader (AC-SEC-3).
    spec_raw: { type: ['string', 'null'] },
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
          //
          // M1 (round 4 remainder): `lens` and `severity` are now nullable,
          // matching ac_id's own M-3 treatment below -- a non-conforming
          // value used to fail validateEntry for the WHOLE entry
          // (write_ok:false, the record gone from the only durable copy).
          // The findings sanitiser nulls the value and retains it, bounded,
          // in *_raw instead, so one bad field costs that field, never the
          // line. Reuses AC_ID_RAW_MAX_BYTES's bound and its reasoning
          // (M6, below): long enough for a realistic value, short enough
          // that a hostile payload appended after it is cut off.
          lens: { type: ['string', 'null'], pattern: LENS_PATTERN_STR },
          lens_raw: { type: ['string', 'null'] },
          severity: { type: ['string', 'null'], enum: SEVERITIES },
          severity_raw: { type: ['string', 'null'] },
          ac_id: { type: ['string', 'null'], pattern: AC_ID_PATTERN_STR },
          // Review round-2 M-3: when ac_id is nulled by the sanitiser
          // below (a non-conforming value), the rejected value is
          // retained here, bounded to AC_ID_RAW_MAX_BYTES -- the AC-DATA-4
          // recoverability pattern already used for spec/spec_raw, applied
          // to ac_id. Bounded (not verbatim) because ac_id was
          // deliberately kept free of free text (AC-SEC-2); see the
          // sanitiser's own comment for the considered tradeoff.
          ac_id_raw: { type: ['string', 'null'] },
          disposition: { type: 'string', enum: DISPOSITIONS },
        },
      },
    },
    // H4: AC verdicts, collected from every lens's structured response
    // (review-cycle.js), were computed and then simply discarded -- no
    // field existed to hold them, so "which ACs never fail" had no data
    // source at all. {ac_id, verdict} pairs only, same evidence-exclusion
    // discipline as `findings` (AC-SEC-2: no free text, ever).
    ac_verdicts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['ac_id', 'verdict'],
        properties: {
          // Review round-2 M-3: nullable, matching findings.ac_id -- a
          // non-conforming ac_id is now RETAINED (never dropped), with
          // ac_id nulled and the original preserved in ac_id_raw below.
          // The round-1 design dropped the whole {ac_id, verdict} entry,
          // permanently losing a PASS/FAIL verdict from the only durable
          // copy with no way to recover which criterion it concerned.
          ac_id: { type: ['string', 'null'], pattern: AC_ID_PATTERN_STR },
          ac_id_raw: { type: ['string', 'null'] },
          verdict: { type: 'string', enum: ['PASS', 'FAIL', 'UNVERIFIABLE'] },
        },
      },
    },
    spec_bug_count: { type: ['integer', 'null'] },
    rejected_finding_count: { type: ['integer', 'null'] },
    // Review round-1 M3: how many ac_id values (across ac_verdicts entries
    // dropped entirely, and findings[].ac_id values nulled) failed the
    // AC-<LENS>-<n> pattern and were sanitized before validateEntry ran --
    // a real, measured integer when either array was supplied at all
    // (including a real 0 when every value was well-formed), null when
    // neither was supplied (mirrors findings_truncated's own semantics).
    // Named distinctly from AC-OPS-2's start-only/terminal-only orphan
    // counters so this cause is never mistaken for a start-only orphan's
    // actual causes (the process being killed before the terminal write,
    // or the terminal write itself failing for a reason this sanitiser
    // does not cover).
    invalid_ac_ids_dropped: { type: ['integer', 'null'] },
    // M1 (round 4 remainder): companion counter for invalid_ac_ids_dropped
    // -- how many findings[].lens/severity values were non-conforming and
    // nulled (with the rejected value retained, bounded, in lens_raw/
    // severity_raw). Named separately rather than folded into
    // invalid_ac_ids_dropped: a different field failed for a different
    // reason, and conflating the two would make one counter answer two
    // different operator questions. Same null-vs-zero semantics as
    // invalid_ac_ids_dropped: a real 0 when findings were supplied and all
    // were well-formed, null when no findings array was supplied at all.
    invalid_finding_fields_dropped: { type: ['integer', 'null'] },
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
    // HARN-OPT-2 PR1 (AC-DATA-4): the plan-identity canonicalisation
    // function's own output for this record's `spec` (or the no-spec/
    // out-of-repo sentinel), computed and written alongside the retained
    // `spec` field itself -- never in place of it, so a canonicaliser
    // defect is correctable on READ from the retained field alone, without
    // rewriting the append-only ledger. Optional (not in `required`): a
    // pre-PR1 line has no plan_key at all, and read-side normalisation
    // (not a rewrite of the stored line) is what makes it usable (AC-ARCH-5).
    plan_key: { type: ['string', 'null'] },
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

// L6: a character-based truncate() lived here until this round -- superseded
// by truncateBytes below (M2: MAX_LINE_BYTES is a BYTE cap, and a
// character-based bound could still push a line over it on its own with
// multibyte input) and never called anywhere in the real write path even
// before that, kept alive only by its own direct unit test. Deleted, along
// with that test, rather than left as dead code that looks live.
//
// Bounds a free-text field to `maxBytes` UTF-8 bytes. Passes null/undefined
// through unchanged so "field not supplied" stays distinguishable from
// "field supplied and empty" (AC-DATA-3's truncation clause). Trims one
// character at a time (safe against splitting a surrogate pair
// mid-character, unlike slicing the encoded Buffer directly) until the
// UTF-8 byte length fits.
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
// FINDING 1 (confirmed pre-existing on main too, not a regression): a null
// or non-object descriptor element crashed here (`f.lens` on `null`) with
// an unhandled TypeError, before validateEntry ever ran -- Node exits
// non-zero, nothing written, not even a parseable write_ok:false. A
// malformed element now becomes `null` in the entries array instead,
// which flows through (via allFindings) into entry.findings below and is
// caught there by the EXISTING findings.items.type:'object' schema check
// -- the same clean write_ok:false degrade the findings/ac_verdicts
// sanitiser already relies on for a malformed non-null element (see its
// own comment, further down this file). Applied once, here, so all three
// callers (spec_bugs, rejected_findings, open_findings) get it
// consistently rather than three separate special cases.
function computeFindings(descriptors, disposition) {
  if (!Array.isArray(descriptors)) return { entries: [], count: null }
  const entries = descriptors.map((f) => {
    if (!f || typeof f !== 'object') return null
    return {
      id: findingId(f.lens, f.location, f.claim),
      lens: f.lens,
      severity: f.severity || 'Low',
      ac_id: f.ac_id || null,
      disposition,
    }
  })
  return { entries, count: entries.length }
}

const TRUNCATABLE_FIELDS = ['task', 'spec', 'spec_raw', 'round_key', 'event', 'event_key']

// Matches an absolute POSIX path (leading /, at least one more non-blank
// segment) or a Windows drive-letter path, wherever it appears inside a
// string -- not just when the whole field IS a path (a `task` description
// is free text that may simply mention one). The leading slash must be at
// the very start of the string or preceded by whitespace/an opening quote
// or paren: without that anchor, a genuinely relative path that merely
// CONTAINS a slash (e.g. "specs/foo.md") would have its "/foo.md" tail
// misread as an absolute path and mangled.
//
// Review round-2, Decision 1: round-1's M1 widened this prefix class to
// "anything not legal in a path segment", intending to fail closed on
// shape. In practice a real path routinely contains characters outside
// that class -- a space, a paren, a non-ASCII directory name -- so the
// widened form matched INSIDE ordinary, entirely safe relative specs and
// destroyed them (H1, H2). Restored to main's narrow form. This regex is
// no longer applied to `spec` at all (see canonicalPlanKey and its cwd/root
// lexical resolution in main(), below) -- it is used only for genuinely
// free-text fields (task, round_key, event, event_key) where a shape-based
// scan over prose is the best available tool, matching main's own scope.
const ABSOLUTE_PATH_RE = /(^|[\s'"(])([A-Za-z]:\\[^\s'")]+|\/[^\s'")]+)/g

// The fixed marker for a path that cannot be safely recorded: an absolute
// path outside the repo root, or (HARN-OPT-2 PR1, AC-SEC-1 case d) a
// relative path whose "../" segments lexically resolve outside it. Named
// and exported once (AC-ARCH-1) so the writer's own `spec`/`plan_key`
// fields and the reader's unattributable-bucket handling (AC-DATA-7,
// AC-OPS-5) agree on one literal value, rather than each hand-rolling it.
export const REDACTED_PATH_MARKER = '<redacted-path>'

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
    return prefix + REDACTED_PATH_MARKER
  })
}

// HARN-OPT-2 PR1 (AC-ARCH-3): a narrowing PRE-PASS, run before redactPaths,
// that makes an absolute path repo-relative when it lives under `root` and
// leaves it COMPLETELY UNCHANGED otherwise -- unlike redactPaths, it never
// redacts. This is what lets a path authored inside a linked WORKTREE
// (whose own absolute root differs from the main checkout's) get relativised
// against the worktree's own root first, before the general pass (which
// only knows the main checkout root) ever sees it: a path still absolute
// after this pre-pass either belongs to the main root (the next pass
// handles it) or is genuinely outside every root this writer knows about
// (the next pass correctly marks it).
function relativiseAgainstRoot(value, root) {
  if (value === null || value === undefined || !root) return value
  const s = String(value)
  return s.replace(ABSOLUTE_PATH_RE, (whole, prefix, absPath) => {
    if (absPath === root || absPath.startsWith(root + path.sep)) {
      const rel = path.relative(root, absPath)
      return prefix + (rel === '' ? '.' : rel)
    }
    return whole
  })
}

// HARN-OPT-2 PR1: the no-spec sentinel (AC-QA-2) -- distinguishable from
// every real spec value, including one literally named "unspecified" (the
// literal string a real, if confusingly-named, spec file could use).
// Review round-1 L5: the plain string '<no-spec>' was itself a LEGAL single
// path segment, so a spec file literally named "<no-spec>" collided with
// it. canonicalPlanKey never emits a TRAILING "/" in a real key (a
// trailing-slash segment is always dropped as empty by the segment loop
// below), so appending one makes the sentinel structurally unproducible
// from any real spec path, not merely implausible -- while the trailing
// "/" still starts with a safe character, so it does not itself trip the
// M1 shape check below.
export const NO_SPEC_PLAN_KEY = '<no-spec>/'

const WINDOWS_DRIVE_ABS_RE = /^[A-Za-z]:[\\/]/

// HARN-OPT-2 PR1: plan-identity canonicalisation, the single definition
// site (AC-ARCH-1) the writer and the reader both call. PURE (AC-ARCH-2,
// AC-SEC-2): string arguments in, a string out, no fs/child_process/
// process.cwd()/realpath anywhere in this function -- the canonical value
// for a given `spec` is byte-identical whether the target exists, does
// not, or is a symlink to somewhere hostile (AC-DATA-3 case e: a symlinked
// spec keeps its OWN lexical path, since this function never resolves a
// symlink's target -- collapsing that route would require realpath, which
// was explicitly struck from scope at planning).
//
// Review round-2, Decision 1: no regex is used to find a path's boundary
// here, ever. `root` is a plain STRING prefix (or an ARRAY of candidate
// string prefixes, tried in order -- the writer may need to try both
// `cwdRoot` and `root`, plus PWD when it names the writer's own cwd) to
// lexically strip from an absolute `spec` -- never touched by any fs call
// here. The caller (main(), below) resolves which real root string(s) to
// pass; this function itself only ever does string/array arithmetic with
// whatever it is handed, and stays that way deliberately (round 5, H-A: an
// earlier attempt to realpath `spec`'s own directory in main() before
// calling this function was reverted -- it made plan identity depend on
// filesystem STATE, not just the spec string, which is exactly what this
// function's purity exists to prevent; see main()'s own comment at the
// call site). An absolute spec reached through a symlinked ancestor
// directory that none of the candidate roots match lexically records the
// out-of-repo marker -- a known, documented, deterministic limitation.
// There is no longer a "final shape" regex check on the derived key
// either (round-1's UNSAFE_EMBEDDED_SLASH_RE): it fired on legitimate
// already-relative segments containing ordinary punctuation ("specs/plan
// (v2)/a.md") indistinguishably from a genuine embedded leak, because
// after segment-splitting the two look identical. Redaction now happens
// only when relativisation against every known candidate root genuinely
// fails (AC-SEC-1 cases c/d) -- never as a second-guess of an already-
// resolved value.
export function canonicalPlanKey(spec, root) {
  if (spec === NO_SPEC_PLAN_KEY || spec === REDACTED_PATH_MARKER) return spec
  if (typeof spec !== 'string' || spec === '') return NO_SPEC_PLAN_KEY
  const candidateRoots = (Array.isArray(root) ? root : [root])
    .filter((r) => typeof r === 'string' && r)
    .map((r) => r.replace(/[\\/]+$/, ''))
  let rel = spec
  const isAbsolute = spec.startsWith('/') || WINDOWS_DRIVE_ABS_RE.test(spec)
  if (isAbsolute) {
    const matchedRoot = candidateRoots.find((r) => spec === r || spec.startsWith(r + '/') || spec.startsWith(r + '\\'))
    if (matchedRoot !== undefined) {
      rel = spec.slice(matchedRoot.length).replace(/^[\\/]+/, '')
    } else {
      // An absolute path that matches none of the known candidate roots:
      // cannot be safely made repo-relative (AC-SEC-1 case c).
      return REDACTED_PATH_MARKER
    }
  }
  // Lexical normalisation only (AC-DATA-3): forward-slash-join, then
  // collapse "." and ".." segments by plain array arithmetic -- no
  // fs.realpath, no existence check of any kind. A ".." with nothing left
  // to pop lexically escapes the root (AC-SEC-1 case d): a relative spec
  // like "../../../home/<user>/.ssh/config" has no leading slash at all,
  // so it was never absolute in the branch above, and without this check
  // it would be recorded verbatim.
  const posixRel = rel.split(/[\\/]+/).join('/')
  const segments = []
  for (const seg of posixRel.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      if (segments.length === 0) return REDACTED_PATH_MARKER
      segments.pop()
    } else {
      segments.push(seg)
    }
  }
  if (segments.length === 0) return REDACTED_PATH_MARKER
  return segments.join('/')
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

// L2: inside a git submodule, --git-common-dir resolves to the
// SUPERPROJECT's .git/modules/<name> (a submodule's gitdir lives there, not
// inside its own working tree), so path.dirname(commonDir) computes
// .git/modules -- not a usable checkout root, and ensureGitignored would
// then write a bogus .git/info tree there (confirmed against a real
// submodule fixture: <super>/.git/modules/.git/info/exclude gets created).
// --show-superproject-working-tree prints the superproject's path when run
// from inside a submodule, and nothing (with exit 0) otherwise, so it is a
// direct, purpose-built detection rather than pattern-matching the path.
function resolveMainCheckoutRoot(cwd) {
  const superprojectRoot = git(['rev-parse', '--show-superproject-working-tree'], cwd)
  if (superprojectRoot) {
    throw new Error('refusing to write from inside a git submodule (superproject at ' + superprojectRoot + '): --git-common-dir resolves to the superproject\'s .git/modules/<name>, not a usable checkout root -- run this from the submodule\'s own repo directly, or from the superproject')
  }
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

// HARN-OPT-2 PR1 (AC-DATA-2): `mainRoot` is the already-resolved MAIN
// checkout root (resolveMainCheckoutRoot, shared for a repo and every one
// of its linked worktrees via --git-common-dir). The remoteless fallback
// used to re-derive its own toplevel via a SECOND `git rev-parse
// --show-toplevel` call from `cwd` -- which, run from inside a linked
// worktree, returns the WORKTREE's own directory, not the main checkout,
// so a remoteless worktree recorded its own throwaway directory name as
// repo identity and split every bucket. Using the basename of the
// already-resolved main root instead makes a write from any worktree of a
// repo agree with a write from its main checkout, by construction.
function resolveRepoIdentity(cwd, mainRoot) {
  try {
    const url = git(['remote', 'get-url', 'origin'], cwd)
    if (REMOTE_HOST_RE.test(url)) {
      const m = url.match(/[/:]([^/:]+\/[^/]+?)(\.git)?$/)
      if (m) return m[1]
    }
  } catch (e) {
    // no remote; fall through
  }
  if (mainRoot) return path.basename(mainRoot)
  try {
    return path.basename(git(['rev-parse', '--show-toplevel'], cwd))
  } catch (e) {
    return 'unknown'
  }
}

// HARN-OPT-2 PR1 (AC-ARCH-3): the CURRENT working tree's own root -- a
// linked worktree's own directory when writing from inside one, identical
// to the main checkout root otherwise. Used ONLY to make an absolute path
// authored inside a worktree repo-relative (via relativiseAgainstRoot,
// above) before the general redaction pass -- which knows only the main
// checkout root -- ever runs. This is the fs/git-touching half of that
// resolution; canonicalPlanKey itself stays pure and never calls this.
// AC-QA-20: fs-only (walking up for the nearest `.git` entry, file or
// directory -- a linked worktree's own root has a `.git` FILE containing
// `gitdir: <path>`; an ordinary checkout has a `.git` DIRECTORY; either
// marks `dir` as a working tree's own toplevel), never a git subprocess.
// This mirrors `git rev-parse --show-toplevel`'s own resolution closely
// enough for this purpose without adding a 4th git call to every write --
// today's count (with an origin remote configured: --show-superproject-
// working-tree, --git-common-dir, remote get-url origin, check-ignore) must
// not grow by one just to resolve the CURRENT working tree's root, which an
// ordinary fs stat walk already answers just as well for this narrow use
// (never resolving GIT_DIR/GIT_WORK_TREE overrides or core.worktree, which
// only a real `git rev-parse` call could -- accepted, since those are rare
// enough that AC-QA-20's subprocess-count guarantee outweighs them here).
function resolveWorkingTreeRoot(cwd) {
  let dir = path.resolve(cwd)
  while (true) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
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

// A truthy env value opts into read-only mode; empty string, "0" and
// "false" (case-insensitive) are treated as unset, matching common shell
// convention for a boolean env var.
function isReadonlyEnvTruthy(v) {
  if (v === undefined || v === null) return false
  const s = String(v).trim().toLowerCase()
  return s !== '' && s !== '0' && s !== 'false'
}

export function main() {
  // Review round-2, new harness-level guard: lenses are specified
  // read-only, but this script resolves the MAIN checkout via
  // --git-common-dir regardless of which worktree it is invoked from
  // (AC-DATA-1), so a lens probing this writer from its own isolated
  // worktree still writes to the operator's real, unbacked-up ledger --
  // exactly what happened during review round 2 (two synthetic records
  // appeared in the live ledger). When HARNESS_LEDGER_READONLY is set to a
  // truthy value, NOTHING below runs: no stdin parse, no git subprocess,
  // no gitignore check, no write -- a clean refusal, before any of that
  // machinery starts. This is enforced at the LENS PROMPT boundary
  // (review-cycle.js instructs every lens to export it before probing),
  // not fully mechanical: a lens that does not follow its own
  // instructions, or a caller other than a lens, is not stopped by this
  // alone. Documented as such, not oversold.
  if (isReadonlyEnvTruthy(process.env.HARNESS_LEDGER_READONLY)) {
    return result(randomUUID(), new Date().toISOString(), false, 'ledger is read-only in this context')
  }
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
  // path (H2) needs to know the repo root first. HARN-OPT-2 PR1: cwdRoot
  // (the CURRENT working tree's own root -- a linked worktree's own
  // directory, when applicable) is resolved alongside root (the MAIN
  // checkout's root) so a worktree-authored absolute spec can be
  // relativised against the root it was actually authored under
  // (AC-ARCH-3), and so repo identity's remoteless fallback uses the main
  // checkout's basename rather than the worktree's own (AC-DATA-2).
  let repo
  let root
  let cwdRoot
  try {
    root = resolveMainCheckoutRoot(cwd)
    cwdRoot = resolveWorkingTreeRoot(cwd)
    repo = resolveRepoIdentity(cwd, root)
  } catch (e) {
    return result(run_id, ts, false, 'could not resolve the main checkout via git rev-parse: ' + stripRoot(e.message, root))
  }
  const ledgerPath = path.join(root, LEDGER_RELATIVE_PATH)

  // HARN-OPT-2 PR1: the candidate root strings canonicalPlanKey lexically
  // matches an absolute spec (or, round 5/H-C, an absolute event_scope plan
  // segment) against -- cwdRoot and root, plus PWD itself when it names the
  // same directory as cwd (compared by inode, not string; a real shell's
  // `cd <symlinked-dir>` sets PWD to the exact unresolved argument, which
  // process.cwd() would otherwise silently normalise away). Computed once,
  // here, and reused below by both the event_scope canonicalisation and the
  // spec canonicalisation. canonicalPlanKey itself stays pure (AC-ARCH-2,
  // AC-SEC-2, AC-DATA-3): every fs call needed to build this candidate list
  // happens HERE, in main(), never inside it.
  const specRootCandidates = [cwdRoot, root]
  if (process.env.PWD) {
    try {
      if (fs.statSync(process.env.PWD).ino === fs.statSync(cwd).ino) specRootCandidates.push(process.env.PWD)
    } catch (e) {
      // PWD does not resolve, or does not name the same directory as cwd: not a usable candidate
    }
  }

  // M2: the occurrence discriminator inside a conduct_plan_event's event_key
  // ("<plan file>:<task id>:<event>:<occurrence>") used to be computed by
  // the conducting AGENT, in prose, by counting matching lines itself
  // before calling this script -- an uncounted or mis-counted occurrence
  // silently reads as a benign duplicate (the dedup check below matches on
  // the whole key), so a genuinely new event vanishes with a success
  // response and no way to detect it after the fact. The script already
  // reads this exact file for that same dedup check, so it mints the key
  // itself instead of trusting the caller's count: a caller supplies
  // event_scope ("<plan file>:<task id>:<event>", no occurrence), and this
  // counts existing event_key values starting with "<event_scope>:" to
  // mint occurrence = count + 1, returned in the result so the caller can
  // log or display it, never re-derived by the caller itself.
  //
  // Round 5 (H-C, AC-ARCH-6): the plan-file segment (everything before the
  // FIRST colon, matching the reader's own planKeyFromEventKey parsing) is
  // canonicalised BEFORE it is used to build the counting prefix or the
  // final event_key -- resolved against the writer's own cwd first when
  // relative, EXACTLY like `spec` itself below (this segment is documented
  // to follow spec's own convention, including a "../" reached from a
  // subdirectory naming a real in-repo file -- H1's fix for `spec`, applied
  // here identically, or a caller's ordinary relative plan path would
  // wrongly redact to the marker the moment it starts with ".."). SKILL.md's
  // convention is that this segment is always already repo-relative, but
  // nothing rejects a caller that (accidentally or otherwise) supplies an
  // absolute one, and the RAW-prefix counting this replaces broke in two
  // ways for that case: occurrence always reset to 1 (a differently-spelled
  // absolute path never matched a prior line's raw prefix, so every write
  // looked like the first), and the free-text redaction pass over event_key
  // further down -- which knows nothing about cwdRoot/PWD the way
  // canonicalPlanKey does -- could consume the whole colon-delimited tail
  // into a single regex match, losing the occurrence suffix entirely and
  // dropping the record as a silent false-duplicate with write_ok: true.
  // Canonicalising here first means event_key's plan segment is already
  // relative (or the fixed marker) by the time the free-text pass sees it,
  // so that pass is a no-op for it.
  if (payload.kind === 'conduct_plan_event' && typeof payload.event_scope === 'string' && payload.event_scope) {
    const colonIdx = payload.event_scope.indexOf(':')
    let rawPlanSegment = colonIdx === -1 ? payload.event_scope : payload.event_scope.slice(0, colonIdx)
    const restOfScope = colonIdx === -1 ? '' : payload.event_scope.slice(colonIdx)
    if (rawPlanSegment && !(rawPlanSegment.startsWith('/') || WINDOWS_DRIVE_ABS_RE.test(rawPlanSegment))) {
      rawPlanSegment = path.resolve(cwd, rawPlanSegment)
    }
    const canonicalScope = canonicalPlanKey(rawPlanSegment, specRootCandidates) + restOfScope
    const prefix = canonicalScope + ':'
    let count = 0
    if (fs.existsSync(ledgerPath)) {
      const existing = fs.readFileSync(ledgerPath, 'utf8')
      for (const existingLine of existing.split('\n')) {
        if (!existingLine.trim()) continue
        try {
          const parsed = JSON.parse(existingLine)
          if (typeof parsed.event_key === 'string' && parsed.event_key.startsWith(prefix)) count += 1
        } catch (e) {
          // a truncated/corrupt line is not a match; never let it crash the count
        }
      }
    }
    payload.event_key = `${canonicalScope}:${count + 1}`
  }

  // Relativise every recorded FREE-TEXT path mention against the repo root
  // BEFORE truncation (H2, AC-SEC-3): an absolute path under the root
  // becomes repo-relative, one outside it is redacted. Applied to task,
  // round_key, event and event_key -- NOT spec/spec_raw, which have their
  // own dedicated, regex-free pipeline below (Decision 1: a shape-based
  // free-text regex must never run over a structured path value;
  // task/round_key/event/event_key stay regex-based because they genuinely
  // are free text with no single unambiguous base to resolve an embedded
  // mention against -- event_key's own PLAN segment is the one exception,
  // already canonicalised above, before this pass ever sees it).
  // HARN-OPT-2 PR1 (AC-ARCH-3): when writing from inside a linked worktree
  // (cwdRoot differs from the main checkout root), first relativise every
  // one of these fields against the WORKTREE's own root -- a plain lexical
  // string substitution using the fs-resolved cwdRoot from above. A path
  // still absolute after this pre-pass either belongs to the main root (the
  // next pass handles it) or is genuinely outside every root this writer
  // knows about (the next pass correctly marks it).
  const FREE_TEXT_FIELDS = TRUNCATABLE_FIELDS.filter((f) => f !== 'spec' && f !== 'spec_raw')
  if (cwdRoot && cwdRoot !== root) {
    for (const field of FREE_TEXT_FIELDS) {
      if (field in payload) payload[field] = relativiseAgainstRoot(payload[field], cwdRoot)
    }
    if (Array.isArray(payload.lenses_run)) payload.lenses_run = payload.lenses_run.map((v) => relativiseAgainstRoot(v, cwdRoot))
    if (Array.isArray(payload.lenses_skipped)) payload.lenses_skipped = payload.lenses_skipped.map((v) => relativiseAgainstRoot(v, cwdRoot))
  }
  for (const field of FREE_TEXT_FIELDS) {
    if (field in payload) payload[field] = redactPaths(payload[field], root)
  }
  // lenses_run/lenses_skipped are arrays of lens-name strings in the
  // ordinary case, but the schema does not constrain their contents to the
  // roster pattern (unlike `findings[].lens`), so a string element can carry
  // an absolute path just like any other free-text field.
  if (Array.isArray(payload.lenses_run)) payload.lenses_run = payload.lenses_run.map((v) => redactPaths(v, root))
  if (Array.isArray(payload.lenses_skipped)) payload.lenses_skipped = payload.lenses_skipped.map((v) => redactPaths(v, root))

  // Review round-2, Decision 1: `spec` is plan IDENTITY, not free text, and
  // write-time redaction of it was never required in the first place -- the
  // ledger is local and gitignored by the AC-SEC-1 design decision, so there
  // is no privacy requirement to redact data INSIDE it; AC-SEC-3's
  // requirement is about the report and the agent prompts, the OUTPUT
  // boundary. C1, H1, H2 and H3 were one root cause: a shape-based free-text
  // regex applied destructively to spec, which real paths (a space, a
  // paren, a non-ASCII segment, a symlinked root) defeat. Replaced with
  // pure lexical resolution against KNOWN root strings -- never a regex
  // guessing at where a path ends.
  //
  // A relative spec is resolved against the writer's own cwd first (lexical
  // only: path.resolve does no fs I/O of its own; `cwd` was already
  // captured via process.cwd() before any of this ran -- the same value
  // root/cwdRoot's OWN resolution already depends on, so this stays
  // internally consistent. AC-DATA-3's "lexical, never realpath-based"
  // constraint is on canonicalPlanKey itself, which never touches cwd or
  // makes any fs call at all). The result is then matched lexically against
  // specRootCandidates, computed once above.
  //
  // Round 5 (H-A, REVERTING round 4): an earlier version of this resolved
  // the real form of an absolute spec's own directory (via
  // fs.realpathSync.native) before matching, to recover a spec reached
  // through a symlinked ANCESTOR directory. That satisfied the LETTER of
  // "canonicalPlanKey stays pure" (the realpath call lived in main(), not
  // inside it) while violating what the purity requirement is FOR:
  // AC-SEC-2's "byte-identical whether the target exists, does not exist,
  // or is a symlink" and AC-DATA-3's "lexical, never realpath-based" are
  // about the RESOLUTION'S OWN BEHAVIOUR, not about which function the fs
  // call physically sits in. Proven: the IDENTICAL spec string recorded
  // '<redacted-path>' before a symlink existed on disk at the relevant path,
  // and 'specs/a.md' after one was created at that exact path -- plan
  // identity had become filesystem-STATE-dependent, reintroducing the same
  // class of bucket-splitting hazard AC-DATA-3 exists to prevent, plus an
  // fs syscall per write driven by caller-supplied input. Removed entirely.
  // An absolute spec reached through a symlinked ancestor now records the
  // out-of-repo marker -- a narrow, DETERMINISTIC degradation (see README's
  // "Known limitations"), strictly preferable to an identity that depends
  // on what happens to exist on disk at the moment of the write.
  // Captured BEFORE path.resolve touches it below: "as the caller supplied
  // it" (H-B) means the literal string in the payload, not a
  // cwd-resolved-then-thrown-away intermediate -- a relative spec's own
  // raw form is exactly as recoverable-useful as an absolute one's, and
  // resolving it against cwd first would silently bake this writer's own
  // temp/checkout path into spec_raw for the overwhelmingly common
  // (relative-spec) case, which is not "the caller's string" by any
  // reading.
  const specRawInput = typeof payload.spec === 'string' ? payload.spec : null
  if (typeof payload.spec === 'string' && payload.spec && !(payload.spec.startsWith('/') || WINDOWS_DRIVE_ABS_RE.test(payload.spec))) {
    payload.spec = path.resolve(cwd, payload.spec)
  }
  const planKey = canonicalPlanKey(payload.spec, specRootCandidates)
  // AC-DATA-4: the retained `spec` field tracks the SAME resolution as
  // plan_key -- never left as a raw, unresolved caller string (which could
  // still be an absolute path or a "../" traversal) and never blindly
  // overwritten when there was nothing to resolve (null/empty/wrong-typed
  // spec keeps its own original value here; the no-spec sentinel is a
  // plan_key concept, not something to write into `spec` itself).
  //
  // Round 5 (H-B): `spec` alone is no longer enough for AC-DATA-4's own
  // recoverability requirement, because it is now ALWAYS the derived form
  // -- there is nothing left to re-derive FROM if canonicalPlanKey itself
  // has a defect (proven vacuous: a canonicaliser mutated to silently
  // lowercase every key, merging distinct plans, left the old recoverability
  // test green, because it re-derived from a field that already WAS the
  // canonical key). `spec_raw` retains the caller's original string,
  // exactly as supplied, before path.resolve or canonicalisation touched
  // it: the insurance policy that makes a future canonicaliser defect --
  // this PR has shipped a write-time identity-destroying one in every round
  // so far -- correctable without needing to replay the original caller.
  // Bounded the same way every other free-text field is (truncateBytes
  // below); excluded from FREE_TEXT_FIELDS above for the same reason
  // `spec` is (identity data, not prose; no write-time privacy requirement
  // to redact it, per Decision 1). The reader never emits this field (see
  // optimise-read.mjs).
  //
  // NOT retained when planKey is REDACTED_PATH_MARKER: AC-SEC-1 cases c/d
  // (an absolute spec outside every known root, or a relative spec whose
  // ".." lexically escapes the root) exist specifically to keep a hostile
  // path -- e.g. "../../../home/<user>/.ssh/config" -- OUT of the ledger
  // altogether, not merely out of the canonical key. Retaining it verbatim
  // in spec_raw would undo that protection through a side door: the exact
  // string case d exists to redact would still reach the ledger file, just
  // one field over. Decision 1's "no write-time privacy requirement"
  // applies to a spec that resolves somewhere IN the repo (an operator's
  // own path, already visible in the checkout); it was never licence to
  // retain a value canonicalPlanKey has already judged unsafe to record at
  // all.
  const specWasOverwritten = typeof payload.spec === 'string' && payload.spec !== '' && planKey !== NO_SPEC_PLAN_KEY
  if (specWasOverwritten) {
    payload.spec = planKey
    // Review round-1 L4 (AC-SEC-1's headline sentence, which forbids ANY
    // absolute path or account name in a ledger line -- not just in
    // plan_key/spec): specRawInput, for an in-repo ABSOLUTE spec, is the
    // caller's literal absolute string, e.g.
    // an absolute path shaped like /Volumes/<disk>/<user>/repos/<repo>/specs/a.md
    // on a real checkout, which
    // carries the local account name. Relativised here the SAME lexical,
    // root-matching way `spec` is a few lines above -- but deliberately
    // WITHOUT canonicalPlanKey's "./"/"../"-collapsing step, so spec_raw
    // is never simply re-derived FROM the same canonicalisation it exists
    // to insure against (that would silently reintroduce round 5's
    // original vacuous-recoverability defect, one layer over). Only the
    // absolute prefix is stripped; everything after it, including any
    // awkward "../" segments, survives untouched (proven distinct from
    // plan_key in ledger-append.test.js). A relative spec_raw is already
    // safe and passes through unchanged. Out-of-repo specs are unchanged:
    // spec_raw stays withheld entirely (AC-SEC-1 cases c/d).
    if (planKey !== REDACTED_PATH_MARKER) {
      const rawIsAbsolute = typeof specRawInput === 'string' && (specRawInput.startsWith('/') || WINDOWS_DRIVE_ABS_RE.test(specRawInput))
      if (rawIsAbsolute) {
        const matchedRoot = specRootCandidates
          .filter((r) => typeof r === 'string' && r)
          .map((r) => r.replace(/[\\/]+$/, ''))
          .find((r) => specRawInput === r || specRawInput.startsWith(r + '/') || specRawInput.startsWith(r + '\\'))
        // Review round-2 L-3: fails CLOSED (withholds the value) rather
        // than falling open to the caller's verbatim absolute string. This
        // branch is provably unreachable today -- canonicalPlanKey already
        // matched this exact string against this exact candidate list to
        // produce a non-marker planKey, so matchedRoot cannot be undefined
        // here -- but a future divergence between the two matching
        // computations must lose recoverability, never leak the account
        // name through the side door this fallback used to be.
        payload.spec_raw = matchedRoot !== undefined ? specRawInput.slice(matchedRoot.length).replace(/^[\\/]+/, '') : undefined
      } else {
        payload.spec_raw = specRawInput
      }
    }
  }

  // Truncate free-text fields AFTER the above: `spec`/`spec_raw` are now
  // already their final form (the short canonical key, or the caller's
  // original string) in the ordinary case, so truncating here is a
  // defensive bound on a pathological input, not the routine path it was
  // when spec went through free-text redaction first. Byte-based (M2), not
  // character-based: MAX_LINE_BYTES is a byte cap, and a field of
  // multibyte characters could exceed it on its own even at a "reasonable"
  // character count.
  for (const field of TRUNCATABLE_FIELDS) {
    if (field in payload) payload[field] = truncateBytes(payload[field], 500)
  }
  // plan_key mirrors spec's post-truncation value when spec was actually
  // set to the canonical form above; otherwise it is the standalone
  // computed key (truncated the same way, for the same pathological-input
  // reason truncateBytes exists at all).
  payload.plan_key = specWasOverwritten ? payload.spec : truncateBytes(planKey, 500)

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
  // event_scope is consumed above to mint event_key (M2) and must never
  // itself reach the schema-validated entry: it is not a declared field, and
  // additionalProperties:false would reject the whole write if it leaked
  // through here.
  const { spec_bugs, rejected_findings, open_findings, event_scope, ...restPayload } = payload
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
  // H4: bounded defensively like `findings`, though in practice ac_verdicts
  // is sized by the spec's own AC count times the lens roster -- a few
  // dozen entries at most -- so this is a safety net against a pathological
  // input, not a path expected to fire on a real run (unlike MAX_FINDINGS,
  // which does fire routinely; no separate truncated-count field is kept
  // for the same reason AC-SIMP-4 favours the simplest guard that closes
  // the real risk).
  if (Array.isArray(entry.ac_verdicts)) entry.ac_verdicts = entry.ac_verdicts.slice(0, MAX_AC_VERDICTS)

  // Review round-1 M3, corrected by round-2 M-2/M-3: a single non-conforming
  // ac_id (free text like "none", a comma-joined list, a cross-spec-prefixed
  // id) used to fail validateEntry for the WHOLE entry -- write_ok:false,
  // the entire line refused, recreating exactly the start-only orphan class
  // AC-OPS-2 exists to count and name correctly, with the wrong cause.
  // Sanitized here, granularly, before validateEntry ever runs.
  //
  // Round-2 M-2 (a regression this loop introduced against `main`, which
  // handled a null ARRAY ELEMENT cleanly via validateEntry's own type
  // check): `f`/`v` must be checked for null/non-object BEFORE `.ac_id` is
  // read, or a null element throws a TypeError that crashes the whole
  // script -- no parseable result at all, which is worse than the defect
  // being fixed (writeLedger falls into its failure branch with nothing to
  // parse, manufacturing an orphan either way). A malformed non-null
  // element (string/number/array) is left untouched here and still caught
  // by validateEntry exactly as on `main`.
  //
  // Round-2 M-3 (round-1 DROPPED the whole ac_verdicts entry, permanently
  // losing a PASS/FAIL verdict with no way to recover which criterion it
  // concerned -- unlike spec_raw's AC-DATA-4 insurance for spec): both
  // findings[].ac_id and ac_verdicts[].ac_id are now nullable, and a
  // rejected value is retained (bounded, AC_ID_RAW_MAX_BYTES) in ac_id_raw
  // rather than discarded -- the entry itself is NEVER dropped. Every
  // sanitisation is counted in one place so an operator can tell this
  // apart from a real orphan, and returned from result() so writeLedger
  // sees it too.
  // Round-4 review L1: ac_id_raw (and lens_raw/severity_raw below) is a
  // FREE-TEXT field carrying whatever the caller supplied -- exactly the
  // same class of value task/round_key/event/event_key already go
  // through relativiseAgainstRoot+redactPaths for, above. The sanitiser
  // below runs AFTER that pass, so these *_raw fields were never in scope
  // for it: a non-conforming ac_id/lens/severity containing an absolute
  // path leaked the operator's account name verbatim into the ledger.
  // Reuses the SAME redaction pipeline (never a parallel one), applied
  // BEFORE truncation so a path is made safe before it is cut down, not
  // after (cutting first could leave a recognisable path fragment inside
  // the bound).
  function redactRawField(value) {
    let v = cwdRoot && cwdRoot !== root ? relativiseAgainstRoot(value, cwdRoot) : value
    return redactPaths(v, root)
  }
  let invalidAcIdsDropped = 0
  // M1 (round 4 remainder): a non-conforming `lens` or `severity` value
  // used to fail validateEntry for the WHOLE entry, exactly the ac_id
  // defect above -- reproduced live: `spec_bugs: [{lens:'orchestrator',
  // location:'a.md:1', claim:'x'}]` (a value this spec's own veto table
  // uses, so a model can emit it on any run) returned write_ok:false and
  // wrote nothing, permanently losing the run's outcome, verdicts,
  // ac_verdicts, findings and budget from the only durable copy. The lost
  // run then reappeared as a start-only orphan with the wrong stated
  // cause (see the corrected comment on invalid_ac_ids_dropped's schema
  // declaration, above). Same treatment as ac_id, in the SAME loop over
  // entry.findings so spec_bugs/rejected_findings/open_findings (already
  // merged into entry.findings by computeFindings, above) all get it
  // uniformly -- reusing the existing mechanism rather than a parallel one.
  let invalidFindingFieldsDropped = 0
  if (Array.isArray(entry.findings)) {
    for (const f of entry.findings) {
      if (!f || typeof f !== 'object') continue // M-2: left for validateEntry to reject the whole entry, as main did
      if (typeof f.ac_id === 'string' && !AC_ID_RE.test(f.ac_id)) {
        f.ac_id_raw = truncateBytes(redactRawField(f.ac_id), AC_ID_RAW_MAX_BYTES)
        f.ac_id = null
        invalidAcIdsDropped += 1
      }
      if (typeof f.lens === 'string' && !LENS_RE.test(f.lens)) {
        f.lens_raw = truncateBytes(redactRawField(f.lens), AC_ID_RAW_MAX_BYTES)
        f.lens = null
        invalidFindingFieldsDropped += 1
      }
      if (typeof f.severity === 'string' && !SEVERITIES.includes(f.severity)) {
        f.severity_raw = truncateBytes(redactRawField(f.severity), AC_ID_RAW_MAX_BYTES)
        f.severity = null
        invalidFindingFieldsDropped += 1
      }
    }
  }
  if (Array.isArray(entry.ac_verdicts)) {
    for (const v of entry.ac_verdicts) {
      if (!v || typeof v !== 'object') continue // M-2: left for validateEntry to reject the whole entry, as main did
      if (typeof v.ac_id === 'string' && !AC_ID_RE.test(v.ac_id)) {
        v.ac_id_raw = truncateBytes(redactRawField(v.ac_id), AC_ID_RAW_MAX_BYTES)
        v.ac_id = null
        invalidAcIdsDropped += 1
      } else if (v.ac_id === null) {
        // Round-4 review M3 (writer half): an ac_verdicts entry ALWAYS
        // concerns a specific criterion (unlike findings.ac_id, which
        // legitimately has no-AC-attached) -- an explicit null supplied by
        // the caller, never touched by the string-pattern branch above
        // since it was never a string, must still be counted, or a FAIL
        // verdict can vanish from the reader's aggregate while
        // invalid_ac_ids_dropped reports 0 sanitisations, which is exactly
        // the false-clean signal an operator would trust. On `main` the
        // same payload was refused outright (ac_id was not nullable at
        // all); this branch's own nullable design reopened the route.
        invalidAcIdsDropped += 1
      }
    }
  }
  if (Array.isArray(entry.findings) || Array.isArray(entry.ac_verdicts)) {
    entry.invalid_ac_ids_dropped = invalidAcIdsDropped
  }
  if (Array.isArray(entry.findings)) {
    entry.invalid_finding_fields_dropped = invalidFindingFieldsDropped
  }

  const errors = validateEntry(entry)
  if (errors.length) {
    return result(run_id, ts, false, 'payload failed ledger schema validation: ' + errors.join('; '))
  }

  let line = JSON.stringify(entry)

  // H3 round 2: the record used to jump straight from "fits" to "collapsed
  // to the bare envelope" the moment it exceeded MAX_LINE_BYTES, discarding
  // lenses_run, verdicts, trigger_counts and every finding together even
  // though findings are, by a wide margin, the least valuable data to lose
  // first (a lens's verdict and trigger count survive as one entry each; a
  // finding is many). Drop findings ONE AT A TIME instead, recording the
  // growing count in findings_truncated, before ever touching anything
  // else -- lenses_run, lenses_skipped, verdicts, trigger_counts, spec,
  // round_key and budget_spent all survive this loop untouched. Bounded by
  // Array.isArray(entry.findings): a kind with no findings concept at all
  // must not gain an empty findings array as a side effect of this loop.
  if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES && Array.isArray(entry.findings)) {
    const baseTruncated = entry.findings_truncated || 0
    let dropped = 0
    while (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES && entry.findings.length > 0) {
      entry.findings = entry.findings.slice(0, -1)
      dropped += 1
      entry.findings_truncated = baseTruncated + dropped
      line = JSON.stringify(entry)
    }
  }

  if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) {
    // Every finding has already been dropped (or there were none to drop)
    // and the record still does not fit -- some other field (an unusually
    // large trigger_counts/verdicts object, most plausibly) is the actual
    // cause. Degrade to the minimal valid record -- envelope plus outcome
    // plus a degraded flag -- as the genuine last resort, rather than
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
    // L1: ensureGitignored only ASSERTS the ledger is ignored (writes
    // .git/info/exclude); it never VERIFIES the assertion took effect. A
    // tracked .gitignore carrying a later negation pattern
    // (`!.claude/harness-ledger.jsonl`) re-includes the path -- git
    // resolves ignore precedence by file, last match wins, and
    // .git/info/exclude has no special priority over a tracked .gitignore.
    // Writing and reporting success in that state risks the ledger
    // actually being committed, the exact outcome AC-SEC-1 forbids.
    try {
      execFileSync('git', ['check-ignore', '-q', LEDGER_RELATIVE_PATH], { cwd: root })
    } catch (e) {
      return result(run_id, ts, false, 'the ledger path is not actually gitignored (a tracked .gitignore may re-include it with a negation pattern) -- refusing to write rather than risk it being committed')
    }
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
    //
    // HIGH round 3: a torn trailing line -- no final '\n', the state a torn
    // write, power loss, or external truncation leaves -- previously fused
    // with this record on append into one unparseable line, corrupting
    // BOTH the interrupted record and this new healthy one, silently, with
    // write_ok:true still returned. Mirrors the identical heal
    // ensureGitignored already applies above to .git/info/exclude: read the
    // last byte and prepend a healing '\n' first when the file is
    // non-empty and does not already end in one. Opened 'a+' rather than
    // 'a' so the same fd can both read that last byte (via fstat + read)
    // and append -- 'a' alone is write-only and cannot read at all. The
    // heal and the record are folded into ONE write() call (not two), so a
    // crash mid-write still cannot leave a half-healed, half-appended
    // state: either both land, or neither does.
    const fd = fs.openSync(ledgerPath, 'a+')
    try {
      let healPrefix = ''
      const stats = fs.fstatSync(fd)
      if (stats.size > 0) {
        const lastByte = Buffer.alloc(1)
        fs.readSync(fd, lastByte, 0, 1, stats.size - 1)
        if (lastByte[0] !== 0x0a /* '\n' */) healPrefix = '\n'
      }
      // TEST-ONLY, a no-op unless a test sets this exact env var: widens the
      // window between the fstat above and the write below so a concurrency
      // test can reliably land a concurrent writer's append inside it,
      // rather than depending on unpredictable OS scheduling to win a
      // microsecond-scale race. Never set outside this repo's own test
      // suite (round-3b concurrency finding, see
      // test/ledger-append.test.js).
      const testRaceWindowMs = Number(process.env.LEDGER_APPEND_TEST_RACE_WINDOW_MS || 0)
      if (testRaceWindowMs > 0) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, testRaceWindowMs)
      }
      // Byte length, not string length: MAX_LINE_BYTES and the short-write
      // check below are both byte-based, and `line` may already contain
      // multibyte UTF-8 (free text is truncated by byte length elsewhere,
      // never by character count).
      const buf = Buffer.from(healPrefix + line + '\n', 'utf8')
      // Contributing cause named in the finding: fs.writeSync's return
      // value (the actual bytes written) was previously never checked
      // against the buffer it was asked to write. An ENOSPC short write
      // near a full volume can succeed partially without throwing,
      // leaving a torn trailing line yet reporting success -- exactly the
      // corruption this whole fix exists to prevent, just from the write
      // side instead of a pre-existing one.
      const written = fs.writeSync(fd, buf)
      if (written !== buf.length) {
        // Round 3b: this used to roll the file back to `stats.size`
        // (captured by fstat above, BEFORE this write) via ftruncateSync.
        // That is unsafe under the concurrent-writer design AC-DATA-3
        // requires: another writer can complete a full O_APPEND write in
        // the window between THIS writer's fstat and its ftruncate, and an
        // absolute-offset truncate back to the stale pre-race size deletes
        // that other writer's already-committed record too -- a record
        // whose write already returned write_ok:true to ITS caller. Fixing
        // this correctly would require an exclusive lock around fstat
        // through ftruncate, which the design deliberately avoids (that is
        // exactly what makes the plain O_APPEND single-write() approach
        // simple and lock-free in the first place). §12: a change reverted
        // for being worse keeps the simpler original -- the fix is to
        // report the failure and leave the file alone, not to "repair" it.
        // The partial bytes this failed attempt DID write (if any) are
        // left in place: a self-inflicted torn trailing line, exactly the
        // pre-existing case the heal above already exists to fix on the
        // NEXT append (this is not new risk -- a torn trailing line is
        // already a supported, tolerated state per AC-DATA-5).
        return result(run_id, ts, false, `short write to the ledger: wrote ${written} of ${buf.length} bytes (disk full?)`)
      }
    } finally {
      fs.closeSync(fd)
    }
  } catch (e) {
    return result(run_id, ts, false, 'append failed: ' + stripRoot(e.message, root))
  }

  // M2: the caller passed event_scope, not the full key -- return the
  // minted key so the caller can log/display it, never re-derive it itself.
  // Review round-2 M-3: invalid_ac_ids_dropped rides on the CLI result too
  // (not just the stored line), so writeLedger (in each of the three
  // workflow scripts) can log a visible line when a sanitisation actually
  // happened, the same way it already surfaces a write failure.
  const extra = {}
  if (entry.event_key) extra.event_key = entry.event_key
  if (typeof entry.invalid_ac_ids_dropped === 'number') extra.invalid_ac_ids_dropped = entry.invalid_ac_ids_dropped
  // M1 (round 4 remainder): invalid_finding_fields_dropped rides on the CLI
  // result too, mirroring invalid_ac_ids_dropped exactly, above.
  if (typeof entry.invalid_finding_fields_dropped === 'number') extra.invalid_finding_fields_dropped = entry.invalid_finding_fields_dropped
  return Object.keys(extra).length ? { ...result(run_id, ts, true, null), ...extra } : result(run_id, ts, true, null)
}

// Only run as a CLI when invoked directly (`node ledger-append.mjs`), never
// as a side effect of another module importing this file for its exports
// (tests do exactly that).
//
// FINDING 2 (round-2 triage, confirmed pre-existing on main too): Node's
// ESM loader resolves `import.meta.url` through symlinks -- it always
// reports this module's REAL, target path -- but `path.resolve` on
// `process.argv[1]` only resolves `.`/`..`/relative segments lexically; it
// never follows a symlink. `node <symlinked-path>/ledger-append.mjs` then
// makes the comparison below false even though the caller ran this exact
// file: `isMain` reads false, the CLI branch never runs, and the process
// exits 0 with zero bytes of output -- success-shaped silence, no write,
// no error signal at all. This is live in production wherever the
// resolved script path crosses a symlinked ancestor (macOS's
// /tmp -> /private/tmp, $TMPDIR's /var/folders -> /private/var/folders, or
// any symlinked home/volume/install ancestor for
// ~/.claude/workflows/lib/...). Fixed by resolving `process.argv[1]`
// through fs.realpathSync.native (which does follow symlinks, matching
// what import.meta.url already does) before comparing. Guarded in
// try/catch and falling back to the lexical form on failure (e.g. a
// genuinely nonexistent argv[1], which should never happen for a running
// script, but must fail toward the pre-fix behaviour rather than throw
// during a plain import that never intended to invoke the CLI at all).
function resolveArgvPathForIsMain(argPath) {
  const lexical = path.resolve(argPath)
  try {
    return fs.realpathSync.native(lexical)
  } catch (e) {
    return lexical
  }
}
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolveArgvPathForIsMain(process.argv[1])
if (isMain) {
  const out = main()
  process.stdout.write(JSON.stringify(out) + '\n')
  process.exit(0)
}
