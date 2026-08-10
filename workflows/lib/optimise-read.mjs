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
// envelope, git and gh" -- it deliberately reuses no plan-cycle.js,
// review-cycle.js or tdd-task.js internals, and none of those three
// reference this file (see test/static-checks.test.js). It DOES read the
// envelope constants ledger-append.mjs already defines as the single
// definition site (AC-ARCH-5), rather than re-declaring them, since
// ledger-append.mjs is not one of the three workflows AC-ARCH-8 fences off.
//
// AC-SEC-9: every function below is READ-ONLY. Nothing in this file calls
// fs.writeFileSync, fs.rmSync, fs.appendFileSync, or any git/gh mutating
// command. Proven directly in test/optimise-read.test.js (sha256/mtime
// identity before and after a real CLI invocation against a real repo) and
// mechanically in test/static-checks.test.js (a grep for write-shaped calls).
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
// (AC-SIMP-2); a caller may override it via the workflow's own `args`
// (the same surface plan-cycle/review-cycle already expose for e.g. `base`),
// which the workflow passes through to this CLI as an explicit --window flag.
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

function ensurePlan(byPlan, plan) {
  if (!byPlan.has(plan)) {
    byPlan.set(plan, {
      ciWaitSeconds: 0, ciWaitN: 0,
      humanWaitSeconds: 0, humanWaitN: 0,
      agentComputeSeconds: 0, agentComputeN: 0,
      unterminatedWaits: 0,
      unusableIntervals: [],
    })
  }
  return byPlan.get(plan)
}

// Wall-clock decomposition (spec item 2). AC-ARCH-13: every segment here
// comes from exactly ONE source -- the ledger's own conduct_plan_event pairs
// for ci_wait/human_wait, and tdd_task/review_cycle/plan_cycle start/
// terminal run_id pairs for agent_compute. gh data never enters this
// function; CI duration/queue time (a distinct measure from ci_wait, which
// tracks how long the CONDUCTOR was in the waiting state, not how long the
// CI run itself took) is aggregated separately by aggregateCi, from gh only.
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
      const ms = tsMs(r.ts)
      if (r.event === `${eventName}_started`) started.push({ plan, ms })
      else if (r.event === `${eventName}_ended`) ended.push({ plan, ms })
    }
    const byPlanStarts = new Map()
    const byPlanEnds = new Map()
    const pushInto = (map, key, value) => {
      if (!map.has(key)) map.set(key, [])
      map.get(key).push(value)
    }
    for (const s of started) pushInto(byPlanStarts, s.plan, s.ms)
    for (const e of ended) pushInto(byPlanEnds, e.plan, e.ms)
    const plans = new Set([...byPlanStarts.keys(), ...byPlanEnds.keys()])
    for (const plan of plans) {
      const starts = (byPlanStarts.get(plan) || []).slice().sort((a, b) => a - b)
      const ends = (byPlanEnds.get(plan) || []).slice().sort((a, b) => a - b)
      const bucket = ensurePlan(byPlan, plan)
      const pairCount = Math.min(starts.length, ends.length)
      for (let i = 0; i < pairCount; i++) {
        const durationS = (ends[i] - starts[i]) / 1000
        if (!(durationS >= 0)) {
          bucket.unusableIntervals.push({ event: eventName, reason: `${eventName} interval is negative or out of order (end before start)` })
          continue
        }
        if (eventName === 'ci_wait') { bucket.ciWaitSeconds += durationS; bucket.ciWaitN += 1 }
        else { bucket.humanWaitSeconds += durationS; bucket.humanWaitN += 1 }
      }
      if (starts.length > ends.length) bucket.unterminatedWaits += starts.length - ends.length
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
    if (pair.length < 2) continue // an orphan start or terminal with no partner: not enough to compute a duration
    const spec = pair.find((p) => p.spec)?.spec || null
    const plan = spec || 'unspecified'
    const times = pair.map((p) => tsMs(p.ts)).filter((t) => t !== null)
    if (times.length < 2) continue
    const durationS = (Math.max(...times) - Math.min(...times)) / 1000
    const bucket = ensurePlan(byPlan, plan)
    if (durationS >= 0) { bucket.agentComputeSeconds += durationS; bucket.agentComputeN += 1 }
  }

  const totals = { ciWaitSeconds: 0, humanWaitSeconds: 0, agentComputeSeconds: 0, unterminatedWaits: 0 }
  for (const bucket of byPlan.values()) {
    totals.ciWaitSeconds += bucket.ciWaitSeconds
    totals.humanWaitSeconds += bucket.humanWaitSeconds
    totals.agentComputeSeconds += bucket.agentComputeSeconds
    totals.unterminatedWaits += bucket.unterminatedWaits
  }

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
export function aggregateTriggerAccuracy(records) {
  const byLens = {}
  for (const r of records) {
    if (r.kind !== 'review_cycle') continue
    for (const lens of r.lenses_run || []) {
      if (!byLens[lens]) byLens[lens] = { cleanWithZeroTrigger: 0, cleanWithMatches: 0, findingsWithMatches: 0, total: 0 }
      const bucket = byLens[lens]
      bucket.total += 1
      const triggerCount = r.trigger_counts && lens in r.trigger_counts ? r.trigger_counts[lens] : null
      const verdict = r.verdicts && r.verdicts[lens]
      if (verdict === 'CLEAN' && triggerCount === 0) bucket.cleanWithZeroTrigger += 1
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
    const neverFailed = insufficientData ? null : jobRuns.every((r) => r.conclusion === 'success')
    const durations = jobRuns.map((r) => r.duration_s).filter((d) => typeof d === 'number' && Number.isFinite(d))
    const meanDurationS = durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : null
    out.set(key, {
      workflow: group.workflow,
      job: group.job,
      n,
      windowStart: jobRuns.length ? jobRuns[0].started_at : null,
      windowEnd: jobRuns.length ? jobRuns[jobRuns.length - 1].started_at : null,
      truncated: requestedLimit !== null && n >= requestedLimit,
      insufficientData,
      neverFailed,
      meanDurationS,
    })
  }
  return { byJob: out }
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
  return {
    n: windowed.length,
    windowTruncated: truncated,
    windowDroppedCount: droppedCount,
    perRepo,
    skipped: combinedSkipped,
    rework: { n: rework.n, lensDispositionCounts: rework.lensDispositionCounts, acVerdicts: [...rework.acVerdicts.values()] },
    neverFailingAcs: neverFailing,
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
