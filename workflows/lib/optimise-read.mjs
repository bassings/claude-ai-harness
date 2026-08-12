#!/usr/bin/env node
// The optimiser's read/aggregate helper: a standalone, ordinary Node
// script, NOT a dynamic-workflow script -- same reason and same pattern as
// workflows/lib/ledger-append.mjs (see that file's header): workflow
// scripts have no filesystem access, no imports, and the runtime statically
// rejects Date.now()/new Date()/Math.random() before execution, so all
// ledger reading, hostile-input tolerance, aggregation arithmetic and gh
// output parsing live here instead, invoked via Bash from an agent step
// inside workflows/optimise-cycle.js.
//
// AC-ARCH-8: this file is the optimiser's own reading of "the ledger
// envelope, git and gh" -- it deliberately reuses none of the three
// original PR1 workflows' own internals (plan cycle, review cycle, or the
// TDD task runner), and none of those three reference this file in turn
// (see test/optimise-static.test.js). It DOES read the envelope constants
// ledger-append.mjs already defines as the single definition site
// (AC-ARCH-5), rather than re-declaring them, since ledger-append.mjs is
// not one of the three workflows AC-ARCH-8 fences off.
//
// AC-SEC-9: every function below is READ-ONLY. Nothing in this file
// modifies a file on disk, in any form. Proven directly in
// test/optimise-read.test.js (sha256/mtime identity before and after a
// real CLI invocation against a real repo) and mechanically in
// test/optimise-static.test.js (a grep for write-shaped fs calls by name).
//
// AC-QA-21: every number the optimiser reports is computed here, in real
// script code, from parsed records -- never asserted by an agent. The same
// fixture fed through these functions twice yields byte-identical output
// (proven in test/optimise-read.test.js).

import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { LEDGER_RELATIVE_PATH, canonicalPlanKey, REDACTED_PATH_MARKER, NO_SPEC_PLAN_KEY } from './ledger-append.mjs'

// AC-ARCH-14: the default bound on how much ledger history a single
// aggregation pass reads -- proven against a >=2000-line synthetic ledger
// in test/optimise-read.test.js. Not configurable via env or a config file
// (AC-SIMP-2); a caller may override it via the optimiser workflow's own
// `args` (the same input surface the other PR1 workflows already expose
// for their own options), which is passed through to this CLI as an
// explicit --window flag.
export const DEFAULT_LEDGER_WINDOW_LINES = 2000

// AC-SIMP-10 / AC-QA-17: below this many usable ledger records, the
// optimiser emits zero harness-side proposals and reports insufficient
// data instead, naming this exact number. Five is chosen as the smallest
// sample from which "this lens's findings are mostly rejected" or "this AC
// never fails" stops being a single anecdote -- a documented, stated
// threshold, not a tuned performance ceiling (the same class of number
// AC-QA-22 vetoed at planning for being invented; this one is a minimum
// EVIDENCE size, not a latency budget).
export const MIN_RECORDS_FOR_PROPOSALS = 5

// AC-DATA-8: the minimum number of recorded runs before a "has never
// failed" claim about a CI job or an AC is treated as meaningful rather
// than insufficient data.
export const MIN_RUNS_FOR_NEVER_FAILED = 5

// AC-QA-20 / AC-ARCH-14: the citation pool is the ONLY set of ids the
// synthesis prompt ever sees and the ONLY set a proposal's citation is
// checked against -- capped small and separately from the (larger, up to
// DEFAULT_LEDGER_WINDOW_LINES) aggregation window, so a proposal's
// citation is always both real (present in what the optimiser actually
// processed) and cheap to embed in a prompt (never the full window).
export const CITATION_POOL_SIZE = 50

const ENVELOPE_REQUIRED = ['schema_version', 'run_id', 'ts', 'repo', 'kind']

// Parses raw ledger file content into usable records and a counted,
// reasoned skip list (AC-QA-16). Tolerates blank lines, a truncated final
// line, unknown extra fields, an unknown `kind`, and any `schema_version`
// (older or newer than this script's own understanding) -- only a line that
// is not valid JSON, or is valid JSON missing one of the envelope's own
// required identity fields, is skipped. Never throws.
export function parseLedgerContent(raw) {
  const records = []
  const skipped = []
  const schemaVersionsSeen = new Map()
  if (!raw) return { records, skipped, schemaVersionsSeen, truncatedFinalLine: false }
  const lines = raw.split('\n')
  // A file written by ledger-append.mjs always ends with a trailing '\n',
  // so split() yields one empty trailing element -- not a real line, and
  // must not be reported as a skip. A genuinely truncated final line (no
  // trailing '\n') instead yields a non-empty last element that is not
  // valid JSON, which the loop below counts normally.
  let truncatedFinalLine = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const lineNo = i + 1
    if (!line.trim()) continue
    let parsed
    try {
      parsed = JSON.parse(line)
    } catch (e) {
      // Review round-1 L1: JSON.parse's own SyntaxError message embeds a
      // snippet of the RAW (corrupt) input it failed on -- for a torn or
      // hand-edited line beginning with an absolute path, that snippet is
      // the leak itself, reaching this reader's JSON output and, from
      // there, a model prompt. A fixed reason naming only the line number,
      // never the parser's own message text, closes it.
      skipped.push({ line: lineNo, reason: `line ${lineNo} failed JSON parse (invalid JSON syntax)` })
      if (i === lines.length - 1) truncatedFinalLine = true
      continue
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      skipped.push({ line: lineNo, reason: `line ${lineNo} is valid JSON but not an object` })
      continue
    }
    const missing = ENVELOPE_REQUIRED.filter((k) => !(k in parsed))
    if (missing.length) {
      skipped.push({ line: lineNo, reason: `line ${lineNo} is missing required envelope field(s): ${missing.join(', ')}` })
      continue
    }
    records.push(parsed)
    const v = parsed.schema_version
    schemaVersionsSeen.set(v, (schemaVersionsSeen.get(v) || 0) + 1)
  }
  return { records, skipped, schemaVersionsSeen, truncatedFinalLine }
}

// Bounds how many records proceed to aggregation (AC-ARCH-14): keeps only
// the most recent `maxLines` records (by array order, which is file order,
// which is append order -- the ledger is append-only). This windowing
// happens here, in script code, BEFORE any of this content is placed into
// an agent prompt string.
export function windowRecords(records, maxLines = DEFAULT_LEDGER_WINDOW_LINES) {
  if (records.length <= maxLines) return { windowed: records, truncated: false, droppedCount: 0 }
  const droppedCount = records.length - maxLines
  return { windowed: records.slice(droppedCount), truncated: true, droppedCount }
}

function bumpDisposition(counts, lens, disposition) {
  if (!counts[lens]) counts[lens] = { fixed: 0, rejected: 0, spec_bug: 0, open: 0 }
  if (disposition in counts[lens]) counts[lens][disposition] += 1
}

// HARN-OPT-2 PR1 (AC-ARCH-1, AC-ARCH-4): the ONE place every plan-keyed
// aggregation below derives its bucket key from -- routes through the
// single shared canonicalPlanKey (imported from ledger-append.mjs, never
// redeclared here). Prefers a post-PR1 record's own `plan_key` (computed
// writer-side, so it already accounts for the ACTUAL working tree the
// record was authored from -- see ledger-append.mjs's AC-ARCH-3 worktree
// handling, which this reader cannot reproduce after the fact); falls back
// to re-deriving it from the retained `spec` field for a historical
// (pre-PR1) line that has no plan_key at all (AC-ARCH-5: one code path, no
// branch on schema_version).
//
// Returns null for a record with no attributable identity left at all
// (AC-QA-7): a `degraded:true` line drops spec/plan_key entirely to fit
// the minimal envelope, so there is nothing to canonicalise -- the caller
// must count this separately, never fold it into the no-spec bucket.
function planKeyForRecord(record, root = '') {
  if (!record || record.degraded) return null
  // Review round-1 M1 (read-side defence in depth): a STORED plan_key is
  // re-canonicalised, never trusted verbatim. A hand-edited or foreign
  // ledger line (the spec itself documents hand-injected records) can carry
  // a plan_key that itself leaks -- re-running it through the same shared
  // function costs nothing for an already-clean value (canonicalPlanKey is
  // idempotent) and closes that route the same way a hostile `spec` is
  // closed.
  if (typeof record.plan_key === 'string' && record.plan_key) return canonicalPlanKey(record.plan_key, root)
  return canonicalPlanKey(record.spec, root)
}

// Rework attribution (spec item 1) + AC-verdict aggregation keyed by
// (repo, spec, ac_id) -- AC-DATA-7: never by AC id alone, so the same AC id
// in two different specs (or the same spec name reused across two repos)
// reports as two distinct criteria, not one merged one. HARN-OPT-2 PR1: the
// key's `spec` segment (and the entry's reported `spec` field) is now the
// CANONICAL plan key, not the raw ledger value, so an absolute and a
// relative form of the same plan collapse into one entry (AC-ARCH-4) and a
// path that cannot be attributed to any single spec (out-of-repo, or the
// pre-existing redaction placeholder) is excluded entirely and counted
// under the returned `unattributableCount` instead of a plan-shaped bucket
// (AC-DATA-7, AC-OPS-5) -- `root`, optional, is the caller's already-
// resolved analysis root, used only for lexically relativising an absolute
// historical `spec` value; it is never touched by any fs call here.
export function aggregateRework(records, { root = '' } = {}) {
  const reviewRecords = records.filter((r) => r.kind === 'review_cycle')
  const lensDispositionCounts = {}
  const acVerdicts = new Map()
  let unattributableCount = 0
  // Review round-2 M-3: invalid_ac_ids_dropped is a real, measured integer
  // on a record only when the writer actually sanitised something (or
  // supplied 0 when nothing needed sanitising) -- summed here across every
  // review_cycle record in the window, exposed on the return so
  // optimise-cycle.js can render it beside the orphan counters.
  let invalidAcIdsDropped = 0
  for (const r of reviewRecords) {
    if (typeof r.invalid_ac_ids_dropped === 'number') invalidAcIdsDropped += r.invalid_ac_ids_dropped
    for (const f of r.findings || []) {
      bumpDisposition(lensDispositionCounts, f.lens, f.disposition)
    }
    const verdicts = r.ac_verdicts || []
    if (!verdicts.length) continue
    const planKey = planKeyForRecord(r, root)
    if (planKey === null || planKey === REDACTED_PATH_MARKER) {
      unattributableCount += verdicts.length
      continue
    }
    for (const v of verdicts) {
      // Review round-2 M-3: a sanitised entry (ac_id nulled by the writer,
      // AC-DATA-4-style ac_id_raw retained instead) must never reach the
      // bucket key -- `escapeKeyComponent(null)` stringifies to the
      // literal "null", which would silently merge EVERY sanitised
      // verdict from every different plan into one fake shared bucket,
      // exactly the "different plans merge" defect class this spec exists
      // to close. Excluded from bucketing entirely; already counted once
      // via invalidAcIdsDropped above, never counted twice.
      if (v.ac_id === null || v.ac_id === undefined) continue
      // Review round-2 M4: same injective-escaping fix as planBucketKey.
      const key = `${escapeKeyComponent(r.repo)}|${escapeKeyComponent(planKey)}|${escapeKeyComponent(v.ac_id)}`
      if (!acVerdicts.has(key)) acVerdicts.set(key, { repo: r.repo, spec: planKey, ac_id: v.ac_id, pass: 0, fail: 0, unverifiable: 0, n: 0 })
      const entry = acVerdicts.get(key)
      entry.n += 1
      if (v.verdict === 'PASS') entry.pass += 1
      else if (v.verdict === 'FAIL') entry.fail += 1
      else if (v.verdict === 'UNVERIFIABLE') entry.unverifiable += 1
    }
  }
  return { n: reviewRecords.length, lensDispositionCounts, acVerdicts, unattributableCount, invalidAcIdsDropped }
}

// AC-DATA-8: a "has never failed" claim states its window (here: the run
// count backing it) and is insufficient_data below minRuns, regardless of
// whether every recorded verdict happens to be PASS.
export function neverFailingAcs(acVerdicts, { minRuns = MIN_RUNS_FOR_NEVER_FAILED } = {}) {
  const out = []
  for (const [key, entry] of acVerdicts.entries()) {
    const insufficient_data = entry.n < minRuns
    out.push({
      key,
      repo: entry.repo,
      spec: entry.spec,
      ac_id: entry.ac_id,
      n: entry.n,
      insufficient_data,
      never_failed: insufficient_data ? null : entry.fail === 0,
    })
  }
  return out
}

const WAIT_EVENTS = ['ci_wait_started', 'ci_wait_ended', 'human_wait_started', 'human_wait_ended']

function planKeyFromEventKey(eventKey) {
  // event_key shape: "<plan file>:<task id>:<event>:<occurrence>" (see
  // skills/conduct-plan/SKILL.md). Rolled up to plan-file granularity only
  // (dropping task id): the ledger's own conduct_plan_event schema does not
  // carry a separate structured task-id field, only this composite string,
  // and per-task decomposition is not required by any AC in this PR --
  // stated here, and in the report, as a known simplification. The plan
  // file is the first colon-delimited segment (a repo-relative spec path,
  // per SKILL.md's instruction that it is never absolute, so it cannot
  // itself contain a colon on any platform this harness runs on).
  if (typeof eventKey !== 'string' || !eventKey.includes(':')) return null
  return eventKey.slice(0, eventKey.indexOf(':'))
}

function tsMs(ts) {
  const ms = Date.parse(ts)
  return Number.isFinite(ms) ? ms : null
}

// Review round-2 M1 (reframe, not a third patch): the shared key a
// started/ended PAIR carries -- "<plan>:<task>:<occurrence>", with the
// event-name segment removed, so a ci_wait_started and its matching
// ci_wait_ended (same occurrence) produce the IDENTICAL key even though
// their own event_key strings differ only in that segment. This is what
// makes correct pairing possible without ever touching sort order: two
// events pair if and only if they share this key, never by adjacency.
function occurrenceKeyFromEventKey(eventKey, eventName) {
  if (typeof eventKey !== 'string') return null
  const marker = `:${eventName}:`
  const idx = eventKey.indexOf(marker)
  if (idx === -1) return null
  return eventKey.slice(0, idx) + ':' + eventKey.slice(idx + marker.length)
}

// Review round-2 M4: a bare `|`-join is not injective -- a literal "|"
// inside a repo identity (a remoteless repo's basename fallback, or a
// deliberately named checkout) or a spec path merges two DISTINCT (repo,
// plan) pairs into one bucket, summing durations and merging AC verdicts.
// Backslash-escaping "\" and "|" within each component before joining
// fixes this while staying IDENTICAL to the plain join whenever neither
// component actually contains "|" (the overwhelming common case) -- every
// `${repo}|${plan}`-shaped key elsewhere in this codebase and its tests
// keeps working unchanged.
function escapeKeyComponent(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/\|/g, '\\|')
}

// Review round-1 M5 (AC-DATA-7): the wall-clock bucket key, mirroring
// aggregateRework's `${repo}|${spec}` scheme exactly -- the same plan/spec
// path recurring in two different repos (a realistic case once this
// harness's own specs/ layout is mirrored into other repos) must never
// merge their waits into one bucket.
function planBucketKey(repo, plan) {
  return `${escapeKeyComponent(repo)}|${escapeKeyComponent(plan)}`
}

function ensurePlan(byPlan, key, repo, plan) {
  if (!byPlan.has(key)) {
    byPlan.set(key, {
      repo, plan,
      ciWaitSeconds: 0, ciWaitN: 0, ciWaitUnmeasuredN: 0,
      humanWaitSeconds: 0, humanWaitN: 0, humanWaitUnmeasuredN: 0,
      agentComputeSeconds: 0, agentComputeN: 0, agentComputeUnmeasuredN: 0,
      // Review round-1 H1: a well-formed start+terminal pair whose terminal
      // outcome is not 'done' (a crash the PR2 exception guard turned into
      // a pair instead of an orphan, or a deliberate BLOCKED/ABORTED
      // return) is real elapsed time but not a completion -- counted here,
      // under its own name, never folded into agentComputeSeconds/N.
      agentComputeAbortedSeconds: 0, agentComputeAbortedN: 0,
      unterminatedWaits: 0,
      unusableIntervals: [],
    })
  }
  return byPlan.get(key)
}

// Wall-clock decomposition (spec item 2). AC-ARCH-13: every segment here
// comes from exactly ONE source -- the ledger's own conduct_plan_event pairs
// for ci_wait/human_wait, and tdd_task/review_cycle/plan_cycle start/
// terminal run_id pairs for agent_compute. gh data never enters this
// function; CI duration/queue time (a distinct measure from ci_wait, which
// tracks how long the CONDUCTOR was in the waiting state, not how long the
// CI run itself took) is aggregated separately by aggregateCi, from gh only.
//
// Review round-1 M3/M4 (AC-QA-10, AC-OPS-3): every pair with an unparseable
// timestamp on EITHER side, or an orphan start/terminal with no partner at
// all, is counted as an UNMEASURED attempt (never silently dropped, never
// turned into a fabricated duration by doing arithmetic on a null) --
// tracked per segment so totals can report null (unmeasured) rather than a
// misleadingly measured-looking 0 when a segment has zero measured runs but
// at least one unmeasured attempt.
// HARN-OPT-2 PR1 (AC-ARCH-4): `root`, optional, is the caller's already-
// resolved analysis root, used only to lexically relativise an absolute
// historical spec/event_key plan segment via the shared canonicalPlanKey --
// never touched by any fs call here.
export function aggregateWallClock(records, { root = '' } = {}) {
  const byPlan = new Map()

  // ---- ci_wait / human_wait, from conduct_plan_event pairs ----
  //
  // Review round-2 M1: pairing used to sort each bucket's starts and ends
  // by timestamp and zip them by INDEX -- so an orphan (a started with no
  // ended, or vice versa, e.g. a crash/resume or a torn ledger line) could
  // mispair with an unrelated event and both fabricate a wrong duration
  // AND silently drop the real event it belonged with. Pairing by the
  // shared occurrence key (see occurrenceKeyFromEventKey) makes that whole
  // class of bug unrepresentable: two events pair if and only if they
  // share a key, independent of sort order or how many of each exist.
  // Review round-1 H2: two DIFFERENT out-of-repo plans must never merge
  // into one ci_wait/human_wait bucket -- shared across both event names
  // below, mirroring agentComputeUnattributed's own counter in shape.
  let unattributableWaits = 0
  for (const eventName of ['ci_wait', 'human_wait']) {
    const startedByBucket = new Map() // bucketKey -> Map(occKey -> {ms, repo, plan}); a null-occKey event can never be matched, kept in its own list
    const endedByBucket = new Map()
    const nullOccByBucket = new Map() // bucketKey -> {starts: [...], ends: [...]}
    for (const r of records) {
      if (r.kind !== 'conduct_plan_event') continue
      const rawPlan = planKeyFromEventKey(r.event_key)
      if (!rawPlan) continue
      // Only a record actually relevant to THIS pass (this loop runs once
      // per eventName, and `records` is the same full array each time) --
      // checked BEFORE the marker/count logic below so an unattributable
      // record is never counted once per eventName it is irrelevant to.
      const isStarted = r.event === `${eventName}_started`
      const isEnded = r.event === `${eventName}_ended`
      if (!isStarted && !isEnded) continue
      // AC-ARCH-4: the ci_wait/human_wait bucket key routes through the
      // SAME shared canonicalisation as agent_compute and aggregateRework,
      // so an absolute and a relative form of the same plan file's
      // event_key segment collapse into one bucket here too.
      const plan = canonicalPlanKey(rawPlan, root)
      // Review round-1 H2: an out-of-repo (or otherwise unattributable)
      // plan is never bucketed -- agent_compute already had this guard;
      // ci_wait/human_wait did not, so two DIFFERENT out-of-repo plans
      // collapsed into one bucket literally named "<redacted-path>" and had
      // their durations SUMMED. Counted here instead, never merged.
      if (plan === REDACTED_PATH_MARKER) {
        unattributableWaits += 1
        continue
      }
      const repo = r.repo || 'unknown'
      const bucketKey = planBucketKey(repo, plan)
      const ms = tsMs(r.ts)
      const occKey = occurrenceKeyFromEventKey(r.event_key, r.event)
      const target = isStarted ? startedByBucket : endedByBucket
      if (occKey === null) {
        if (!nullOccByBucket.has(bucketKey)) nullOccByBucket.set(bucketKey, { starts: [], ends: [], repo, plan })
        nullOccByBucket.get(bucketKey)[isStarted ? 'starts' : 'ends'].push({ ms })
        continue
      }
      if (!target.has(bucketKey)) target.set(bucketKey, new Map())
      target.get(bucketKey).set(occKey, { ms, repo, plan })
    }

    const bucketKeys = new Set([...startedByBucket.keys(), ...endedByBucket.keys(), ...nullOccByBucket.keys()])
    for (const bucketKey of bucketKeys) {
      const starts = startedByBucket.get(bucketKey) || new Map()
      const ends = endedByBucket.get(bucketKey) || new Map()
      const nullOcc = nullOccByBucket.get(bucketKey) || { starts: [], ends: [] }
      // repo/plan are identical for every event sharing a bucketKey (both
      // are inputs to the key itself), so any one entry's values suffice.
      const anyEntry = [...starts.values()][0] || [...ends.values()][0] || nullOcc
      const bucket = ensurePlan(byPlan, bucketKey, anyEntry.repo, anyEntry.plan)
      const unmeasuredField = `${eventName === 'ci_wait' ? 'ciWait' : 'humanWait'}UnmeasuredN`

      const occKeys = new Set([...starts.keys(), ...ends.keys()])
      for (const occKey of occKeys) {
        const s = starts.get(occKey)
        const e = ends.get(occKey)
        if (s && e) {
          if (s.ms === null || e.ms === null) {
            bucket.unusableIntervals.push({ event: eventName, reason: `${eventName} interval has an unparseable timestamp on the ${s.ms === null ? 'started' : 'ended'} event` })
            bucket[unmeasuredField] += 1
            continue
          }
          const durationS = (e.ms - s.ms) / 1000
          if (!(durationS >= 0)) {
            bucket.unusableIntervals.push({ event: eventName, reason: `${eventName} interval is negative or out of order (end before start)` })
            bucket[unmeasuredField] += 1
            continue
          }
          if (eventName === 'ci_wait') { bucket.ciWaitSeconds += durationS; bucket.ciWaitN += 1 }
          else { bucket.humanWaitSeconds += durationS; bucket.humanWaitN += 1 }
        } else if (s && !e) {
          // A started with no matching ended at this occurrence: unterminated.
          bucket.unterminatedWaits += 1
          bucket[unmeasuredField] += 1
        } else if (!s && e) {
          // Round-2 M1: an ended with no matching started at this
          // occurrence -- NEVER paired with an unrelated started event.
          // Recorded with a reason, counted as unmeasured, not silently
          // dropped and not treated as a valid measurement.
          bucket.unusableIntervals.push({ event: eventName, reason: `${eventName} ended event has no matching started event (occurrence key: ${occKey})` })
          bucket[unmeasuredField] += 1
        }
      }
      // A malformed event_key (no parseable occurrence) can never be
      // trusted to pair with anything -- each one is its own unmeasured
      // attempt, never guessed at by adjacency.
      for (const s of nullOcc.starts) { bucket.unterminatedWaits += 1; bucket[unmeasuredField] += 1 }
      for (const e of nullOcc.ends) {
        bucket.unusableIntervals.push({ event: eventName, reason: `${eventName} ended event has a malformed event_key and cannot be paired` })
        bucket[unmeasuredField] += 1
      }
    }
  }

  // ---- agent_compute, from tdd_task/review_cycle/plan_cycle start/terminal pairs ----
  const RUN_KINDS = ['tdd_task', 'review_cycle', 'plan_cycle']
  const byRunId = new Map()
  for (const r of records) {
    if (!RUN_KINDS.includes(r.kind) || !r.run_id) continue
    if (!byRunId.has(r.run_id)) byRunId.set(r.run_id, [])
    byRunId.get(r.run_id).push(r)
  }
  // HARN-OPT-2 PR1 (AC-ARCH-4, AC-DATA-7, AC-OPS-5, AC-QA-7): plan identity
  // for the pair routes through the single shared planKeyForRecord helper,
  // preferring whichever record in the pair carries a real identity. Three
  // outcomes, counted and named distinctly, never conflated:
  //   - every record in the pair is degraded (no spec/plan_key survives at
  //     all): counted under degradedUnattributedRuns, never folded into
  //     the no-spec bucket (AC-QA-7);
  //   - the canonical key is the out-of-repo/redaction marker: counted
  //     under unattributableRuns, never rendered as a plan-shaped bucket,
  //     and never merged with a DIFFERENT out-of-repo plan (AC-DATA-7,
  //     AC-OPS-5);
  //   - otherwise, a real (possibly no-spec-sentinel) plan key: bucketed
  //     as before.
  let degradedUnattributedRuns = 0
  let unattributableRuns = 0
  // HARN-OPT-2 PR2 (AC-OPS-2): the two orphan classes named and counted
  // SEPARATELY, in addition to the combined agentComputeUnmeasuredN/Runs
  // total below -- a start-only orphan (an exception escaped run() before
  // the terminal write, or the process was killed) and a terminal-only
  // orphan (the START write itself failed) are different defects with
  // different fixes, so a fix landed for one must never read as progress on
  // the other. "By kind" breaks each down by tdd_task/review_cycle/plan_cycle.
  let agentComputeStartOnlyRuns = 0
  let agentComputeTerminalOnlyRuns = 0
  // Review round-1 M1: accumulated in whatever order run_ids are first
  // encountered (record order), then re-serialised in RUN_KINDS' fixed
  // order below -- so JSON.stringify(totals) is byte-identical regardless
  // of input order, which the AC-QA-13 fixture now actually exercises with
  // two different kinds per class.
  const agentComputeStartOnlyByKindRaw = {}
  const agentComputeTerminalOnlyByKindRaw = {}
  // Review round-1 H1: real elapsed time for a crashed/aborted/blocked
  // pair, excluded from agentComputeSeconds (that statistic means
  // completed-run duration only).
  let agentComputeAbortedPairs = 0
  for (const [, pair] of byRunId.entries()) {
    const repo = pair[0]?.repo || 'unknown'
    // Review round-1 M4: orphan SHAPE is classified before either identity
    // `continue` below, using only starts.length/terminals.length -- no
    // plan key required -- so an orphan whose plan identity is
    // unattributable or fully degraded still lands in exactly one counted
    // bucket instead of neither. This does not change byPlan bucketing,
    // which still requires a real identity and is computed further down.
    const starts = pair.filter((p) => p.outcome === 'started')
    const terminals = pair.filter((p) => p.outcome !== 'started')
    if (pair.length === 1 && starts.length === 1) {
      agentComputeStartOnlyRuns += 1
      const k = pair[0].kind
      agentComputeStartOnlyByKindRaw[k] = (agentComputeStartOnlyByKindRaw[k] || 0) + 1
    } else if (pair.length === 1 && terminals.length === 1) {
      agentComputeTerminalOnlyRuns += 1
      const k = pair[0].kind
      agentComputeTerminalOnlyByKindRaw[k] = (agentComputeTerminalOnlyByKindRaw[k] || 0) + 1
    }
    // Review round-1 M3: order-independent, main's own semantics restored
    // (`pair.find(p => p.spec)?.spec`). The PREVIOUS "first non-null wins"
    // rule treated NO_SPEC_PLAN_KEY as "non-null" too, so a no-spec record
    // sitting first in file/array order won over a partner that DID carry a
    // real spec -- order-DEPENDENT, and the no-spec sentinel won by default
    // rather than by any real evidence. Collect every key in the pair, then
    // prefer the first one that is neither null (degraded) NOR the no-spec
    // sentinel; fall back to the sentinel only when nothing in the pair has
    // a real one, and to "fully degraded" only when EVERY record in the
    // pair is degraded (nothing at all survives to attribute).
    const keys = pair.map((p) => planKeyForRecord(p, root))
    if (keys.every((k) => k === null)) {
      degradedUnattributedRuns += 1
      continue
    }
    const plan = keys.find((k) => k !== null && k !== NO_SPEC_PLAN_KEY) ?? NO_SPEC_PLAN_KEY
    if (plan === REDACTED_PATH_MARKER) {
      unattributableRuns += 1
      continue
    }
    const key = planBucketKey(repo, plan)
    // HARN-OPT-2 PR2 (AC-DATA-10): a measured duration is only ever
    // computed for a run_id shared by EXACTLY one 'started' record and
    // EXACTLY one terminal (non-'started') record. Every other shape --
    // a lone record of either kind, two started, two terminal, or three or
    // more sharing one run_id -- is unmeasured, and arithmetic is never
    // performed on it. Before this, `pair.length` alone gated whether a
    // duration was computed, so e.g. two 'started' records sharing a
    // run_id (their timestamps subtracted anyway) fabricated a duration for
    // an attempt that never actually finished.
    if (!(pair.length === 2 && starts.length === 1 && terminals.length === 1)) {
      ensurePlan(byPlan, key, repo, plan).agentComputeUnmeasuredN += 1
      continue
    }
    const times = pair.map((p) => tsMs(p.ts)).filter((t) => t !== null)
    const bucket = ensurePlan(byPlan, key, repo, plan)
    if (times.length < 2) {
      bucket.agentComputeUnmeasuredN += 1
      continue
    }
    // Math.max(...times) - Math.min(...times) is the SPAN between the two
    // parseable timestamps regardless of which record carried which value,
    // so unlike the ci_wait/human_wait pairing above (which subtracts a
    // specific end from a specific start, and so CAN go negative on a
    // corrupted or reordered pair) this can never be negative -- there is
    // no unreachable branch to guard here.
    const durationS = (Math.max(...times) - Math.min(...times)) / 1000
    // Review round-1 H1, corrected by round-2 M-4: a well-formed pair whose
    // terminal outcome is a genuine CRASH is excluded from the measured
    // completion statistic. PR2's own exception-guard fix (the three
    // instrumented workflow scripts) turns a crash from an orphan into
    // exactly this shape -- a real start paired with a real terminal whose
    // outcome is 'aborted' -- so treating it as measured would let a
    // workflow that crashes on EVERY run report as a fully measured,
    // healthy repo, and would silently disarm isUnmeasuredSegmentMotivated
    // (optimise-cycle.js), the gate that exists to stop a proposal being
    // built on unmeasurable data.
    //
    // Round-2 M-4: round-1 gated on `outcome !== 'done'`, which wrongly
    // swept up 'blocked' (a legitimate terminating verdict one of the
    // instrumented workflows returns) and 'no-op' (another's ordinary
    // no-changes-found case, __outcome:'no-op') as if they were
    // crashes -- both are genuine COMPLETIONS with real, meaningful
    // durations. 'aborted' is the ONLY outcome the exception guard actually
    // produces for a crash (AC-SIMP-6: no new OUTCOMES value was ever
    // added), so it is the only value excluded here. done/blocked/no-op are
    // all measured; their real duration is real and known -- reported
    // under agentComputeSeconds/agentComputeN like any other completion.
    // The crash-only path's duration is still real and known (not null),
    // but it is a crash duration, not a work duration: reported under its
    // own name, EXCLUDED from agentComputeSeconds/agentComputeN, and
    // counted a second time toward agentComputeUnmeasuredN so the segment
    // still reads as unmeasured for the safety gate's purposes.
    if (terminals[0].outcome === 'aborted') {
      bucket.agentComputeAbortedSeconds += durationS
      bucket.agentComputeAbortedN += 1
      bucket.agentComputeUnmeasuredN += 1
      agentComputeAbortedPairs += 1
      continue
    }
    bucket.agentComputeSeconds += durationS
    bucket.agentComputeN += 1
  }
  // Review round-1 M1: rebuild both byKind maps in RUN_KINDS' fixed order,
  // regardless of which run_id was first encountered in the input records
  // -- the raw accumulation above is order-dependent (insertion order),
  // this rebuild is not.
  function orderByKind(raw) {
    const ordered = {}
    for (const k of RUN_KINDS) {
      if (k in raw) ordered[k] = raw[k]
    }
    for (const k of Object.keys(raw)) {
      if (!(k in ordered)) ordered[k] = raw[k]
    }
    return ordered
  }
  const agentComputeStartOnlyByKind = orderByKind(agentComputeStartOnlyByKindRaw)
  const agentComputeTerminalOnlyByKind = orderByKind(agentComputeTerminalOnlyByKindRaw)

  const totals = {
    ciWaitSeconds: 0, ciWaitMeasuredRuns: 0, ciWaitUnmeasuredRuns: 0,
    humanWaitSeconds: 0, humanWaitMeasuredRuns: 0, humanWaitUnmeasuredRuns: 0,
    agentComputeSeconds: 0, agentComputeMeasuredRuns: 0, agentComputeUnmeasuredRuns: 0,
    unterminatedWaits: 0,
    degradedUnattributedRuns,
    unattributableRuns,
    unattributableWaits,
    agentComputeStartOnlyRuns,
    agentComputeTerminalOnlyRuns,
    agentComputeStartOnlyByKind,
    agentComputeTerminalOnlyByKind,
    agentComputeAbortedPairs,
    agentComputeAbortedSeconds: 0,
  }
  for (const bucket of byPlan.values()) {
    totals.ciWaitSeconds += bucket.ciWaitSeconds
    totals.ciWaitMeasuredRuns += bucket.ciWaitN
    totals.ciWaitUnmeasuredRuns += bucket.ciWaitUnmeasuredN
    totals.humanWaitSeconds += bucket.humanWaitSeconds
    totals.humanWaitMeasuredRuns += bucket.humanWaitN
    totals.humanWaitUnmeasuredRuns += bucket.humanWaitUnmeasuredN
    totals.agentComputeSeconds += bucket.agentComputeSeconds
    totals.agentComputeMeasuredRuns += bucket.agentComputeN
    totals.agentComputeUnmeasuredRuns += bucket.agentComputeUnmeasuredN
    totals.agentComputeAbortedSeconds += bucket.agentComputeAbortedSeconds
    totals.unterminatedWaits += bucket.unterminatedWaits
  }
  // AC-OPS-3: unmeasured is never silently reported as a measured zero. A
  // segment with ZERO measured runs but AT LEAST ONE unmeasured attempt
  // reports null (genuinely unknown), distinguishable from a segment with
  // zero measured AND zero unmeasured runs (nothing of that kind happened
  // in the window at all -- a real, measured zero). A segment with at
  // least one MEASURED run keeps its real sum regardless of unmeasured
  // attempts elsewhere: partial measurement is reported, not nulled out.
  if (totals.ciWaitMeasuredRuns === 0 && totals.ciWaitUnmeasuredRuns > 0) totals.ciWaitSeconds = null
  if (totals.humanWaitMeasuredRuns === 0 && totals.humanWaitUnmeasuredRuns > 0) totals.humanWaitSeconds = null
  if (totals.agentComputeMeasuredRuns === 0 && totals.agentComputeUnmeasuredRuns > 0) totals.agentComputeSeconds = null

  // Review round-2 L-7: byPlan (a Map) previously followed record-
  // ENCOUNTER order, not a stable sorted order -- AC-QA-13's byte-identity
  // requirement held for `.totals` (a plain sum, order-independent by
  // construction) but not for byPlan itself, so a future consumer that
  // merges or re-orders records (a multi-repo aggregate, a resumed read)
  // would produce a differently-ordered report. Sorted by key here, the
  // single place byPlan is ever returned, rather than at each call site.
  const sortedByPlan = new Map([...byPlan.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))

  return {
    byPlan: sortedByPlan,
    totals,
    source: {
      ci_wait: 'ledger:conduct_plan_event',
      human_wait: 'ledger:conduct_plan_event',
      agent_compute: 'ledger:tdd_task|review_cycle|plan_cycle start/terminal pair',
    },
  }
}

// Trigger accuracy (spec item 4): per lens, how often it ran and returned
// CLEAN with nothing in its own trigger surface (a candidate for narrowing
// harness-triggers.json) versus CLEAN after genuinely examining matched
// files, versus returning FINDINGS.
//
// Review round-1 L1 (AC-OPS-3): a CLEAN run with a null (unmeasured)
// trigger_count -- the lens ran but never reported one -- is neither
// "nothing in scope" (triggerCount===0) nor "examined matched files and
// found nothing" (a real positive count); it is unmeasured, and folding it
// into cleanWithMatches would erase that distinction and quietly treat
// missing instrumentation as evidence for a narrow-this-trigger proposal.
export function aggregateTriggerAccuracy(records) {
  const byLens = {}
  for (const r of records) {
    if (r.kind !== 'review_cycle') continue
    for (const lens of r.lenses_run || []) {
      if (!byLens[lens]) byLens[lens] = { cleanWithZeroTrigger: 0, cleanWithMatches: 0, findingsWithMatches: 0, cleanTriggerUnmeasured: 0, total: 0 }
      const bucket = byLens[lens]
      bucket.total += 1
      const triggerCount = r.trigger_counts && lens in r.trigger_counts ? r.trigger_counts[lens] : null
      const verdict = r.verdicts && r.verdicts[lens]
      if (verdict === 'CLEAN' && triggerCount === 0) bucket.cleanWithZeroTrigger += 1
      else if (verdict === 'CLEAN' && triggerCount === null) bucket.cleanTriggerUnmeasured += 1
      else if (verdict === 'CLEAN') bucket.cleanWithMatches += 1
      else if (verdict === 'FINDINGS') bucket.findingsWithMatches += 1
    }
  }
  return { byLens }
}

// CI waste (spec item 3): expects an array of {workflow, job, conclusion,
// started_at, duration_s} already extracted by the agent step from `gh`
// output (this script never calls gh itself -- agents do I/O, per the
// runtime facts). Tolerant of missing fields on an individual run (skips
// that run from the aggregate rather than throwing).
//
// Review round-1 M6 (AC-DATA-8): a "never failed" claim is gated on THREE
// conditions, not just the sample-size floor -- insufficientData (too few
// runs), truncated (the window boundary was hit, so history older than
// what was fetched is invisible: a failure at run 101 of a 100-run fetch
// cannot be seen), and renameSuspect (this job's own first observed run
// starts strictly after the dataset's true earliest run, suggesting either
// a genuinely new job or one renamed from something with its own,
// unexamined failure history -- either way, "never failed" oversells what
// is actually known). Any one of the three nulls the claim.
export function aggregateCi(runs, { minRunsNeverFailed = MIN_RUNS_FOR_NEVER_FAILED, requestedLimit = null } = {}) {
  const byJob = new Map()
  for (const run of runs || []) {
    if (!run || !run.workflow || !run.job) continue
    const key = `${run.workflow}::${run.job}`
    if (!byJob.has(key)) byJob.set(key, { workflow: run.workflow, job: run.job, runs: [] })
    byJob.get(key).runs.push(run)
  }
  const out = new Map()
  for (const [key, group] of byJob.entries()) {
    const jobRuns = group.runs.slice().sort((a, b) => (a.started_at || '').localeCompare(b.started_at || ''))
    const n = jobRuns.length
    const insufficientData = n < minRunsNeverFailed
    const truncated = requestedLimit !== null && n >= requestedLimit
    const rawNeverFailed = insufficientData ? null : jobRuns.every((r) => r.conclusion === 'success')
    const durations = jobRuns.map((r) => r.duration_s).filter((d) => typeof d === 'number' && Number.isFinite(d))
    const meanDurationS = durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : null
    out.set(key, {
      workflow: group.workflow,
      job: group.job,
      n,
      windowStart: jobRuns.length ? jobRuns[0].started_at : null,
      windowEnd: jobRuns.length ? jobRuns[jobRuns.length - 1].started_at : null,
      truncated,
      insufficientData,
      renameSuspect: false, // filled in below, once every job's windowStart is known
      neverFailed: truncated ? null : rawNeverFailed,
      meanDurationS,
    })
  }
  // renameSuspect needs every job's windowStart computed first, to find the
  // dataset's true earliest run to compare each job's own start against.
  let overallEarliestMs = null
  for (const entry of out.values()) {
    const ms = tsMs(entry.windowStart)
    if (ms !== null && (overallEarliestMs === null || ms < overallEarliestMs)) overallEarliestMs = ms
  }
  for (const entry of out.values()) {
    const ms = tsMs(entry.windowStart)
    entry.renameSuspect = overallEarliestMs !== null && ms !== null && ms > overallEarliestMs
    if (entry.renameSuspect) entry.neverFailed = null
  }
  return { byJob: out }
}

// Review round-1 M7 (AC-DATA-10): reads a proposal's recorded outcome
// events, so a rejected proposal is not silently re-raised and a proposal
// adopted-then-reverted twice is flagged. Per skills/optimise-cycle/
// SKILL.md, a human (or the conductor, at the moment of the decision)
// appends a `conduct_plan_event` line shaped
// {event: "proposal_adopted"|"proposal_rejected"|"proposal_reverted",
// event_scope: "<proposal_id>:<event>"}; ledger-append.mjs mints
// event_key as "<event_scope>:<occurrence>" = "<proposal_id>:<event>:<n>".
// proposal_id is a 16-hex-char sha256 slice (stableProposalId) and so
// never itself contains a colon, making the first colon-delimited segment
// an unambiguous key.
const PROPOSAL_OUTCOME_EVENTS = ['proposal_adopted', 'proposal_rejected', 'proposal_reverted']
export function aggregateProposalOutcomes(records) {
  const byProposalId = new Map()
  for (const r of records) {
    if (r.kind !== 'conduct_plan_event') continue
    if (!PROPOSAL_OUTCOME_EVENTS.includes(r.event)) continue
    if (typeof r.event_key !== 'string') continue
    const parts = r.event_key.split(':')
    if (parts.length < 2 || parts[1] !== r.event) continue // malformed or inconsistent event_key: not trusted
    const proposalId = parts[0]
    if (!byProposalId.has(proposalId)) byProposalId.set(proposalId, { adopted: [], rejected: [], reverted: [] })
    const bucket = byProposalId.get(proposalId)
    if (r.event === 'proposal_adopted') bucket.adopted.push(r.ts)
    else if (r.event === 'proposal_rejected') bucket.rejected.push(r.ts)
    else if (r.event === 'proposal_reverted') bucket.reverted.push(r.ts)
  }
  const out = new Map()
  for (const [id, bucket] of byProposalId.entries()) {
    // Records are processed in ledger (append) order, so the LAST pushed
    // rejection is the most recent one, not necessarily the max by string
    // comparison (which would be wrong across a DST boundary or a mixed
    // timestamp format) -- ledger append order is the correct ordering.
    const lastRejectionTs = bucket.rejected.length ? bucket.rejected[bucket.rejected.length - 1] : null
    out.set(id, {
      adoptedCount: bucket.adopted.length,
      rejectedCount: bucket.rejected.length,
      revertedCount: bucket.reverted.length,
      lastRejectionTs,
      revertedTwiceOrMore: bucket.reverted.length >= 2,
    })
  }
  return out
}

// The bounded pool of real, citable ledger run_ids (AC-QA-20, AC-ARCH-14):
// deduplicated, most-recent-first, capped at CITATION_POOL_SIZE. This is
// the ONLY set of ids the synthesis prompt is shown and the ONLY set a
// proposal's citation is checked against.
export function citationPool(records, size = CITATION_POOL_SIZE) {
  const seen = new Set()
  const pool = []
  for (let i = records.length - 1; i >= 0 && pool.length < size; i--) {
    const id = records[i].run_id
    if (typeof id === 'string' && id && !seen.has(id)) {
      seen.add(id)
      pool.push(id)
    }
  }
  return pool
}

// AC-PROD-7's escaped-defect counter-metric, derived from git history: a
// deliberately named HEURISTIC PROXY, not a causal per-PR attribution --
// counts commit subjects using the conventional-commit "fix:" type
// (optionally scoped, e.g. "fix(ledger):"), which is the closest thing this
// codebase's own commit convention (§6: "Conventional commits (feat:,
// fix:, test:, docs:, refactor:)") gives for "a change that repaired
// something already shipped" without requiring a real causal link back to
// a specific merged PR, which nothing in the ledger or git history
// captures today. Matches only at the START of the subject line (a commit
// merely mentioning "fix:" in prose, e.g. a docs commit, must not count).
const FIX_COMMIT_RE = /^fix(\([^)]*\))?:/i
export function countEscapedDefectCandidates(commits) {
  const list = Array.isArray(commits) ? commits : []
  const count = list.filter((c) => c && typeof c.subject === 'string' && FIX_COMMIT_RE.test(c.subject.trim())).length
  return {
    count,
    n_commits_examined: list.length,
    method: 'heuristic proxy: count of commit subjects starting with the conventional-commit "fix:" type (optionally scoped) within the examined window -- NOT a verified causal attribution to a specific merged PR; a fix: commit unrelated to any recent proposal still counts, and a genuine escaped defect fixed under a different commit-message type is missed',
  }
}

// Review round-2 M2: `JSON.stringify(value, Object.keys(target).sort())`
// looked like it canonicalised the whole object, but a replacer ARRAY is
// applied identically at EVERY nesting level of JSON.stringify's own
// traversal, not just the top level -- so a key present only inside a
// nested object (never in the top-level target's own key list) is
// filtered OUT at that inner level, and every nested object serialises to
// "{}" regardless of its content. Two targets differing only in a nested
// field (e.g. {trigger:{glob:'*.js'}} vs {trigger:{glob:'*.py'}}) hashed
// identically as a result. Recurses and sorts keys at EVERY level instead,
// so nested content is never silently dropped and key order never matters
// at any depth.
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort()
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

// A stable proposal id derived from the TARGET a proposal is about (never
// its prose wording), so the same target re-proposed across cycles is
// recognisable as the same proposal (AC-DATA-10). Real-Node sha256, same
// pattern as ledger-append.mjs's findingId.
export function stableProposalId(target) {
  const canonical = canonicalJson(target)
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16)
}

// ---- CLI ----

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8')
  } catch (e) {
    return ''
  }
}

function parseArgs(argv) {
  const positional = []
  let window = DEFAULT_LEDGER_WINDOW_LINES
  for (const a of argv) {
    const m = /^--window=(\d+)$/.exec(a)
    if (m) window = Number(m[1])
    else positional.push(a)
  }
  return { positional, window }
}

function mapToObject(m) {
  return Object.fromEntries([...m.entries()])
}

// AC-SEC-3 (round 2): perRepo[].root used to be the raw, caller-supplied
// analysis path verbatim -- a real leak, not merely "the caller's own
// already-known argument": workflows/optimise-cycle.js renders it directly
// into the persisted report and the synthesis prompt whenever no friendlier
// label has been resolved elsewhere (`d.repoLabels[entry.root] ||
// entry.root`), so an operator's home-directory-bearing checkout path
// reached both. Derives a non-identifying handle instead, from data this
// file already has no fs-privileged reason to withhold: the `repo` identity
// the WRITER already resolved and redacted for its own records (the same
// value every other part of this output already keys on -- byPlan, rework),
// falling back to a bare basename (never the full path) when no record
// exists to derive one from (an uninstrumented repo, or one whose every
// line was skipped). No git/gh call is made here (this file stays read-only
// and shells out to nothing, per AC-SEC-9/AC-ARCH-8) -- purely a string/
// array read over records already parsed.
function derivePerRepoLabel(records, root) {
  const withRepo = records.find((r) => typeof r.repo === 'string' && r.repo)
  if (withRepo) return withRepo.repo
  // Review round-1 M7: the fallback used to be the root's own basename --
  // but for a home-shaped analysis root (e.g. `<scratch>/Users/<user>`,
  // the operator's own home directory or one directly beneath it), the
  // basename CAN BE the account name itself, leaking exactly what AC-SEC-3
  // exists to redact. This branch fires for precisely the common
  // "uninstrumented" case (no ledger file at all, so no record to derive a
  // real identity from), so it must never fall back to any part of the raw
  // path -- a fixed, non-identifying constant instead.
  return REDACTED_PATH_MARKER
}

function runLedgerCommand(roots, window) {
  const perRepo = []
  let combinedRecords = []
  let combinedSkipped = []
  for (let rootIndex = 0; rootIndex < roots.length; rootIndex++) {
    const root = roots[rootIndex]
    const ledgerPath = path.join(root, LEDGER_RELATIVE_PATH)
    let raw = ''
    let exists = false
    if (fs.existsSync(ledgerPath)) {
      exists = true
      raw = fs.readFileSync(ledgerPath, 'utf8')
    }
    const { records, skipped, schemaVersionsSeen, truncatedFinalLine } = parseLedgerContent(raw)
    const label = derivePerRepoLabel(records, root)
    // Review round-1 M5: rootIndex is the stable, positional, non-
    // identifying key a caller (optimise-cycle.js) can use to look up its
    // OWN friendlier label for this same root -- `root` here is a derived
    // identity/basename (AC-SEC-3), not the raw path, so a caller cannot
    // key its own lookup by it any more.
    perRepo.push({ root: label, rootIndex, uninstrumented: !exists, recordCount: records.length, skippedCount: skipped.length, schemaVersionsSeen: mapToObject(schemaVersionsSeen), truncatedFinalLine })
    combinedRecords = combinedRecords.concat(records)
    combinedSkipped = combinedSkipped.concat(skipped)
  }
  const { windowed, truncated, droppedCount } = windowRecords(combinedRecords, window)
  // HARN-OPT-2 PR1: plan-identity canonicalisation of an absolute historical
  // spec value needs the actual analysis root as a lexical string to strip.
  // Simplification, stated here rather than hidden: when MULTIPLE roots are
  // analysed in one invocation, only the FIRST one is used for this -- an
  // absolute historical spec belonging to a DIFFERENT listed root falls
  // through to the safe out-of-repo marker (never merged, never leaked)
  // rather than being relativised against the wrong root. The common case
  // (one root per invocation, per AC-SEC-3's own documented usage) is
  // unaffected.
  const canonicalRoot = roots[0] || ''
  const rework = aggregateRework(windowed, { root: canonicalRoot })
  const neverFailing = neverFailingAcs(rework.acVerdicts, {})
  const wallClock = aggregateWallClock(windowed, { root: canonicalRoot })
  const trigger = aggregateTriggerAccuracy(windowed)
  const proposalOutcomes = aggregateProposalOutcomes(windowed)
  return {
    n: windowed.length,
    windowTruncated: truncated,
    windowDroppedCount: droppedCount,
    perRepo,
    skipped: combinedSkipped,
    rework: { n: rework.n, lensDispositionCounts: rework.lensDispositionCounts, acVerdicts: [...rework.acVerdicts.values()], unattributableCount: rework.unattributableCount, invalidAcIdsDropped: rework.invalidAcIdsDropped },
    neverFailingAcs: neverFailing,
    proposalOutcomes: mapToObject(proposalOutcomes),
    wallClock: { byPlan: mapToObject(new Map([...wallClock.byPlan.entries()])), totals: wallClock.totals, source: wallClock.source },
    triggerAccuracy: trigger,
    citationPool: citationPool(windowed),
  }
}

function runCiCommand(payload) {
  const runs = Array.isArray(payload && payload.runs) ? payload.runs : []
  const requestedLimit = payload && typeof payload.requestedLimit === 'number' ? payload.requestedLimit : null
  const minRunsNeverFailed = payload && typeof payload.minRunsNeverFailed === 'number' ? payload.minRunsNeverFailed : MIN_RUNS_FOR_NEVER_FAILED
  const { byJob } = aggregateCi(runs, { minRunsNeverFailed, requestedLimit })
  const seen = new Set()
  const ciCitationPool = []
  for (let i = runs.length - 1; i >= 0 && ciCitationPool.length < CITATION_POOL_SIZE; i--) {
    const id = runs[i] && runs[i].id
    if ((typeof id === 'string' || typeof id === 'number') && !seen.has(id)) {
      seen.add(id)
      ciCitationPool.push(String(id))
    }
  }
  return { byJob: mapToObject(byJob), citationPool: ciCitationPool }
}

export function main() {
  const argv = process.argv.slice(2)
  const command = argv[0]
  const { positional, window } = parseArgs(argv.slice(1))
  if (command === 'ledger') {
    const roots = positional.length ? positional : [process.cwd()]
    return runLedgerCommand(roots, window)
  }
  if (command === 'ci') {
    const raw = readStdin()
    let payload
    try {
      payload = raw.trim() ? JSON.parse(raw) : {}
    } catch (e) {
      // Review round-2 L2: JSON.parse's own SyntaxError message embeds a
      // snippet of the RAW input it failed on -- matching L1's already-
      // fixed ledger-line-parser leak, applied here too. This command is
      // fed agent-assembled `gh` output, which optimise-cycle.js carries
      // into the synthesis prompt and the report.
      return { error: 'stdin was not valid JSON (invalid JSON syntax)', byJob: {} }
    }
    return runCiCommand(payload)
  }
  if (command === 'escaped-defects') {
    const raw = readStdin()
    let payload
    try {
      payload = raw.trim() ? JSON.parse(raw) : {}
    } catch (e) {
      // Review round-2 L2: same fix as the `ci` command above.
      return { error: 'stdin was not valid JSON (invalid JSON syntax)', count: null }
    }
    return countEscapedDefectCandidates(Array.isArray(payload && payload.commits) ? payload.commits : [])
  }
  if (command === 'ids') {
    const raw = readStdin()
    let payload
    try {
      payload = raw.trim() ? JSON.parse(raw) : {}
    } catch (e) {
      // Review round-2 L2: same fix as the `ci` command above.
      return { error: 'stdin was not valid JSON (invalid JSON syntax)', ids: [] }
    }
    const targets = Array.isArray(payload && payload.targets) ? payload.targets : []
    return { ids: targets.map((target) => ({ target, proposal_id: stableProposalId(target) })) }
  }
  return { error: `unknown command "${command}"; expected "ledger", "ci", "escaped-defects" or "ids"` }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
if (isMain) {
  const out = main()
  process.stdout.write(JSON.stringify(out) + '\n')
  process.exit(0)
}
