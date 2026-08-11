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
import { LEDGER_RELATIVE_PATH } from './ledger-append.mjs'

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
      skipped.push({ line: lineNo, reason: `line ${lineNo} failed JSON parse: ${e.message}` })
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

// Rework attribution (spec item 1) + AC-verdict aggregation keyed by
// (repo, spec, ac_id) -- AC-DATA-7: never by AC id alone, so the same AC id
// in two different specs (or the same spec name reused across two repos)
// reports as two distinct criteria, not one merged one.
export function aggregateRework(records) {
  const reviewRecords = records.filter((r) => r.kind === 'review_cycle')
  const lensDispositionCounts = {}
  const acVerdicts = new Map()
  for (const r of reviewRecords) {
    for (const f of r.findings || []) {
      bumpDisposition(lensDispositionCounts, f.lens, f.disposition)
    }
    for (const v of r.ac_verdicts || []) {
      const key = `${r.repo}|${r.spec}|${v.ac_id}`
      if (!acVerdicts.has(key)) acVerdicts.set(key, { repo: r.repo, spec: r.spec, ac_id: v.ac_id, pass: 0, fail: 0, unverifiable: 0, n: 0 })
      const entry = acVerdicts.get(key)
      entry.n += 1
      if (v.verdict === 'PASS') entry.pass += 1
      else if (v.verdict === 'FAIL') entry.fail += 1
      else if (v.verdict === 'UNVERIFIABLE') entry.unverifiable += 1
    }
  }
  return { n: reviewRecords.length, lensDispositionCounts, acVerdicts }
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

// Review round-1 M5 (AC-DATA-7): the wall-clock bucket key, mirroring
// aggregateRework's `${repo}|${spec}` scheme exactly -- the same plan/spec
// path recurring in two different repos (a realistic case once this
// harness's own specs/ layout is mirrored into other repos) must never
// merge their waits into one bucket.
function planBucketKey(repo, plan) {
  return `${repo}|${plan}`
}

function ensurePlan(byPlan, key, repo, plan) {
  if (!byPlan.has(key)) {
    byPlan.set(key, {
      repo, plan,
      ciWaitSeconds: 0, ciWaitN: 0, ciWaitUnmeasuredN: 0,
      humanWaitSeconds: 0, humanWaitN: 0, humanWaitUnmeasuredN: 0,
      agentComputeSeconds: 0, agentComputeN: 0, agentComputeUnmeasuredN: 0,
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
export function aggregateWallClock(records) {
  const byPlan = new Map()

  // ---- ci_wait / human_wait, from conduct_plan_event pairs ----
  for (const eventName of ['ci_wait', 'human_wait']) {
    const started = []
    const ended = []
    for (const r of records) {
      if (r.kind !== 'conduct_plan_event') continue
      const plan = planKeyFromEventKey(r.event_key)
      if (!plan) continue
      const repo = r.repo || 'unknown'
      const ms = tsMs(r.ts)
      if (r.event === `${eventName}_started`) started.push({ repo, plan, ms })
      else if (r.event === `${eventName}_ended`) ended.push({ repo, plan, ms })
    }
    const byKeyStarts = new Map()
    const byKeyEnds = new Map()
    const pushInto = (map, key, value) => {
      if (!map.has(key)) map.set(key, [])
      map.get(key).push(value)
    }
    for (const s of started) pushInto(byKeyStarts, planBucketKey(s.repo, s.plan), { ms: s.ms, repo: s.repo, plan: s.plan })
    for (const e of ended) pushInto(byKeyEnds, planBucketKey(e.repo, e.plan), { ms: e.ms, repo: e.repo, plan: e.plan })
    const keys = new Set([...byKeyStarts.keys(), ...byKeyEnds.keys()])
    for (const key of keys) {
      const starts = (byKeyStarts.get(key) || []).slice().sort((a, b) => (a.ms ?? 0) - (b.ms ?? 0))
      const ends = (byKeyEnds.get(key) || []).slice().sort((a, b) => (a.ms ?? 0) - (b.ms ?? 0))
      const repo = (starts[0] || ends[0]).repo
      const plan = (starts[0] || ends[0]).plan
      const bucket = ensurePlan(byPlan, key, repo, plan)
      const pairCount = Math.min(starts.length, ends.length)
      for (let i = 0; i < pairCount; i++) {
        const startMs = starts[i].ms
        const endMs = ends[i].ms
        if (startMs === null || endMs === null) {
          bucket.unusableIntervals.push({ event: eventName, reason: `${eventName} interval has an unparseable timestamp on the ${startMs === null ? 'started' : 'ended'} event` })
          bucket[`${eventName === 'ci_wait' ? 'ciWait' : 'humanWait'}UnmeasuredN`] += 1
          continue
        }
        const durationS = (endMs - startMs) / 1000
        if (!(durationS >= 0)) {
          bucket.unusableIntervals.push({ event: eventName, reason: `${eventName} interval is negative or out of order (end before start)` })
          bucket[`${eventName === 'ci_wait' ? 'ciWait' : 'humanWait'}UnmeasuredN`] += 1
          continue
        }
        if (eventName === 'ci_wait') { bucket.ciWaitSeconds += durationS; bucket.ciWaitN += 1 }
        else { bucket.humanWaitSeconds += durationS; bucket.humanWaitN += 1 }
      }
      if (starts.length > ends.length) {
        const unterminated = starts.length - ends.length
        bucket.unterminatedWaits += unterminated
        bucket[`${eventName === 'ci_wait' ? 'ciWait' : 'humanWait'}UnmeasuredN`] += unterminated
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
  for (const [, pair] of byRunId.entries()) {
    const repo = pair[0]?.repo || 'unknown'
    const spec = pair.find((p) => p.spec)?.spec || null
    const plan = spec || 'unspecified'
    const key = planBucketKey(repo, plan)
    if (pair.length < 2) {
      // An orphan start or terminal with no partner: an attempt we know
      // happened but cannot measure a duration for -- unmeasured, never
      // simply skipped uncounted.
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
    bucket.agentComputeSeconds += durationS
    bucket.agentComputeN += 1
  }

  const totals = {
    ciWaitSeconds: 0, ciWaitMeasuredRuns: 0, ciWaitUnmeasuredRuns: 0,
    humanWaitSeconds: 0, humanWaitMeasuredRuns: 0, humanWaitUnmeasuredRuns: 0,
    agentComputeSeconds: 0, agentComputeMeasuredRuns: 0, agentComputeUnmeasuredRuns: 0,
    unterminatedWaits: 0,
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

  return {
    byPlan,
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

// A stable proposal id derived from the TARGET a proposal is about (never
// its prose wording), so the same target re-proposed across cycles is
// recognisable as the same proposal (AC-DATA-10). Real-Node sha256, same
// pattern as ledger-append.mjs's findingId.
export function stableProposalId(target) {
  const canonical = JSON.stringify(target, Object.keys(target).sort())
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

function runLedgerCommand(roots, window) {
  const perRepo = []
  let combinedRecords = []
  let combinedSkipped = []
  for (const root of roots) {
    const ledgerPath = path.join(root, LEDGER_RELATIVE_PATH)
    let raw = ''
    let exists = false
    if (fs.existsSync(ledgerPath)) {
      exists = true
      raw = fs.readFileSync(ledgerPath, 'utf8')
    }
    const { records, skipped, schemaVersionsSeen, truncatedFinalLine } = parseLedgerContent(raw)
    perRepo.push({ root, uninstrumented: !exists, recordCount: records.length, skippedCount: skipped.length, schemaVersionsSeen: mapToObject(schemaVersionsSeen), truncatedFinalLine })
    combinedRecords = combinedRecords.concat(records)
    combinedSkipped = combinedSkipped.concat(skipped)
  }
  const { windowed, truncated, droppedCount } = windowRecords(combinedRecords, window)
  const rework = aggregateRework(windowed)
  const neverFailing = neverFailingAcs(rework.acVerdicts, {})
  const wallClock = aggregateWallClock(windowed)
  const trigger = aggregateTriggerAccuracy(windowed)
  const proposalOutcomes = aggregateProposalOutcomes(windowed)
  return {
    n: windowed.length,
    windowTruncated: truncated,
    windowDroppedCount: droppedCount,
    perRepo,
    skipped: combinedSkipped,
    rework: { n: rework.n, lensDispositionCounts: rework.lensDispositionCounts, acVerdicts: [...rework.acVerdicts.values()] },
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
      return { error: 'stdin was not valid JSON: ' + e.message, byJob: {} }
    }
    return runCiCommand(payload)
  }
  if (command === 'escaped-defects') {
    const raw = readStdin()
    let payload
    try {
      payload = raw.trim() ? JSON.parse(raw) : {}
    } catch (e) {
      return { error: 'stdin was not valid JSON: ' + e.message, count: null }
    }
    return countEscapedDefectCandidates(Array.isArray(payload && payload.commits) ? payload.commits : [])
  }
  if (command === 'ids') {
    const raw = readStdin()
    let payload
    try {
      payload = raw.trim() ? JSON.parse(raw) : {}
    } catch (e) {
      return { error: 'stdin was not valid JSON: ' + e.message, ids: [] }
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
