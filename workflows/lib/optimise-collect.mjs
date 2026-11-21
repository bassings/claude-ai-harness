#!/usr/bin/env node
// The optimiser's collector (HARN-RUNNER-2 T1): for ONE repository root and ONE
// output directory it gathers the ledger, git and CI data the optimiser's three
// lanes need, by running the fixed command forms below and the existing reader
// (workflows/lib/optimise-read.mjs), and writes one JSON file per lane into the
// output directory:
//
//   <outDir>/<lane>.json = { lane, status: 'ran' | 'failed', mode?, reason?,
//                            result: <reader output> | null, calls, wall_clock_s }
//
// A later program can therefore tell a lane that measured nothing (status 'ran',
// result with zeros) from a lane that never ran (status 'failed', result null,
// and a mode and reason saying why). ci.json also carries runCount, an integer
// only when the lane measured runs; a failed lane and the no_history case carry
// null, never a measured 0. The no_history case is status 'ran' with that mode.
// runCount counts the runs whose jobs were fetched; a run whose gh run view
// failed is data on that run (counted in ci.json's fetchFailedCount, and by mode
// in the reader's repoStats), never a measurement. When no run's jobs could be
// fetched, or gh listed no run with a usable id, the lane measured no job data
// and is failed, in the mode of the failure. A failed attempt-1 call alone leaves
// the run counted. fetchFailedCount is null whenever runCount is. timeoutCount
// is the part of fetchFailedCount that was never attempted because the ci lane's
// own budget ran out (see below); a lane in that state carries a fixed `reason`
// ("ci lane budget exhausted: F of N runs fetched") and is status ran when F > 0,
// failed in mode timeout when F is 0.
// Failed modes: timeout (any lane), could_not_read (ledger), absent_from_path,
// unauthenticated, rate_limited (ci), other.
//
// This is an ordinary Node program, importable (collectRepo) and a command-line
// program: `node optimise-collect.mjs <repository-root> <output-directory>`.
// It is the one place the optimiser spawns git or gh, so optimise-read.mjs stays
// a pure reader (AC-ARCH-5): the aggregation is imported from it or run through
// its own command-line interface, never reimplemented here.
//
// Containment, in one place:
//  - git is run only as `git -c safe.bareRepository=explicit -C <root> log ...`
//    and `... rev-parse --show-toplevel`; gh only as `gh run list ...` and
//    `gh run view <id> [--attempt 1] --json jobs`, from the repository root,
//    with GH_HOST, GH_REPO and GH_ENTERPRISE_TOKEN removed from its environment.
//    A run id reaches a command only when it is all digits.
//  - Every command is an argv array run without a shell; data moves between this
//    program and the reader through argv, stdin and stdout only. Nothing
//    collected is interpolated into a command string or evaluated.
//  - The reader that runs is the sibling of this file, never a copy inside the
//    analysed repository.
//  - A ledger or proposal-targets sidecar that is a symlink, or not a regular
//    file, is not read: the ledger lane fails as could_not_read.
//  - Every command (gh run list, gh run view, git log, git rev-parse, the reader)
//    has its own explicit timeout and is killed, with its whole process group,
//    when it overruns or when this program is signalled; a timeout names the
//    command in the lane's reason.
//  - Output files are created 0600. Failure reasons are fixed text and numbers,
//    never gh or git output (git's complaints are mapped to fixed text), so no
//    commit subject, job name or address reaches a reason or the log line.
//
// The timeouts are the collectRepo argument timeoutMs, a test seam: an object of
// per-command overrides keyed by command name ('ci lane' is the lane's budget).
// It is not read from the environment, a config file or the command line.
//
// Every path under an analysed repository that this program, or the reader
// functions it imports, can read. Each goes through the reader's guarded helpers
// (repoFileStatus, readRepoFile: no symlink, regular file, size cap), and a static
// test fails if a new read of a repository path appears outside them:
//   .git (a linked worktree pointer, 4 KiB cap)
//   <gitdir>/commondir (the shared git directory pointer of a linked worktree, 4 KiB cap)
//   .claude/harness-ledger.jsonl (64 MiB cap)
//   .claude/optimise-proposal-targets.json (1 MiB cap)
//   .claude/harness-triggers.json (1 MiB cap)
// The only unguarded read is the operator-configured root itself (isDirectory).
// git and gh read the repository by their own means and are bounded by timeouts.
//
// Time bound, for the runner (T3) that bounds this program from outside. A command
// is killed at its timeout and the call settles within KILL_GRACE_MS after that
// even if a descendant that left the process group holds the output open. The ci
// lane has an overall budget (20 minutes) checked before each `gh run view`; the
// call in flight when it expires can still run to its own timeout. So for ONE
// repository the worst case is perRepositoryWorstCaseMs(): reader (120 s + 2 s)
// + git log and git rev-parse (2 x 120 s + 2 x 2 s) + ci lane (1200 s + one gh run
// view 120 s + 2 s + reader 120 s + 2 s) = 1810 s, 30 minutes 10 seconds. N
// repositories collected one after another are N times that, before anything else
// the runner does.

import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { DEFAULT_LEDGER_WINDOW_LINES, MIN_RUNS_FOR_NEVER_FAILED, REPO_FILE_CAPS, escapedDefectsFigures, repoFileStatus, resolveLedgerRoot } from './optimise-read.mjs'

const READER_PATH = fileURLToPath(new URL('./optimise-read.mjs', import.meta.url))

// Per command, not per repository: a hung gh, git or reader is bounded on its own.
export const DEFAULT_COMMAND_TIMEOUTS_MS = {
  'gh run list': 120_000,
  'gh run view': 120_000,
  'git log': 120_000,
  'git rev-parse': 120_000,
  reader: 120_000,
  // Not a command: the ci lane's overall budget, checked before each gh run view.
  'ci lane': 20 * 60 * 1000,
}
// After a timeout or a size-cap kill the call settles this long later even if
// `close` never fires (a descendant in another session holding the output open).
export const KILL_GRACE_MS = 2000

export function perRepositoryWorstCaseMs(timeouts = DEFAULT_COMMAND_TIMEOUTS_MS) {
  const ledger = timeouts.reader + KILL_GRACE_MS
  const git = timeouts['git log'] + timeouts['git rev-parse'] + 2 * KILL_GRACE_MS
  const ci = timeouts['ci lane'] + timeouts['gh run view'] + KILL_GRACE_MS + timeouts.reader + KILL_GRACE_MS
  return ledger + git + ci
}
const STDOUT_CAP_BYTES = 64 * 1024 * 1024
const STDERR_KEEP_CHARS = 4096
const GH_RUN_LIMIT = 100
const GIT_LOG_MAX_COMMITS = 500

const GH_LIST_ARGV = ['run', 'list', '--limit', String(GH_RUN_LIMIT), '--json', 'databaseId,attempt,status,workflowName,startedAt']
const GIT_LOG_ARGV = ['log', `--max-count=${GIT_LOG_MAX_COMMITS}`, '--name-only', '--pretty=format:%x1e%P%x1f%s']
const GIT_ROOT_ARGV = ['rev-parse', '--show-toplevel']

const LEDGER_INPUT_FILES = [
  ['.claude/harness-ledger.jsonl', REPO_FILE_CAPS.ledger],
  ['.claude/optimise-proposal-targets.json', REPO_FILE_CAPS.sidecar],
]
const UNREADABLE_INPUT_REASONS = {
  not_regular: (rel) => `${rel} is a symlink or not a regular file`,
  too_large: (rel) => `${rel} is over the size limit`,
  unreadable: (rel) => `${rel} could not be inspected`,
}
const LEDGER_LOCATION_REASON = 'the ledger location could not be determined for this checkout layout'

const SCRUBBED_ENV = ['GH_HOST', 'GH_REPO', 'GH_ENTERPRISE_TOKEN', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']
// A 403 alone is a permission refusal, not a rate limit: only the words, or a 429, are.
const RATE_LIMIT_RE = /rate limit|HTTP 429|too many requests/i
const UNAUTHENTICATED_RE = /auth login|not logged in|HTTP 401|authentication/i
const FETCH_MODES = new Set(['rate_limited', 'unauthenticated'])

// git's complaints mapped to fixed text; anything else is the exit status alone.
// git's own words (which can carry a path or an address) never reach a reason.
const GIT_FAILURE_REASONS = [
  [/not a git repository/i, 'the configured path is not a git repository'],
  [/dubious ownership|safe\.directory/i, 'git refused the repository because of its ownership (safe.directory)'],
  [/safe\.bareRepository|cannot use bare repository/i, 'git refused a bare repository layout'],
  [/does not have any commits yet|bad default revision/i, 'the repository has no commits'],
]
const GIT_TOPLEVEL_REASON = 'git toplevel does not match the repository root; the git log was not read from that repository'

function gitFailureReason(subcommand, res) {
  const known = GIT_FAILURE_REASONS.find(([pattern]) => pattern.test(res.stderr))
  return known ? known[1] : `git ${subcommand} exited with status ${res.status}`
}

// An object of per-command overrides; anything else (a number included) is ignored.
function resolveTimeouts(timeoutMs) {
  const timeouts = { ...DEFAULT_COMMAND_TIMEOUTS_MS }
  if (timeoutMs === null || typeof timeoutMs !== 'object') return timeouts
  for (const [name, ms] of Object.entries(timeoutMs)) if (Object.hasOwn(timeouts, name) && Number.isFinite(ms) && ms > 0) timeouts[name] = ms
  return timeouts
}

// A lane that could not run: a mode (machine-readable) and a fixed-text reason.
class LaneFailure extends Error {
  constructor(mode, reason) {
    super(reason)
    this.mode = mode
  }
}

function childEnv() {
  const env = { ...process.env, GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0' }
  for (const name of SCRUBBED_ENV) delete env[name]
  return env
}

// ---- running a command ----

const activeChildren = new Set()

function killGroup(child) {
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    try {
      child.kill('SIGKILL')
    } catch {
      // already gone
    }
  }
}

function killActiveChildren() {
  for (const child of activeChildren) killGroup(child)
}

// Resolves, never rejects for a command that ran badly: { status, signal, error,
// stdout, stderr, timedOut, tooLarge }. The child leads its own process group so
// a timeout or a signal to this program takes its descendants with it. The bound
// is hard: on a timeout or the size cap the group is killed, this end of every
// pipe is destroyed, and the call settles within KILL_GRACE_MS even if `close`
// never fires because a descendant outside the group still holds the output.
function runCommand(cmd, args, { cwd, env, input, timeoutMs }) {
  return new Promise((resolve) => {
    const out = { chunks: [], size: 0, tooLarge: false }
    const state = { stderr: '', timedOut: false, settled: false, grace: null, timer: null }
    const child = spawn(cmd, args, { cwd, env, detached: true, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] })
    activeChildren.add(child)
    const finish = (extra) => {
      if (state.settled) return
      state.settled = true
      clearTimeout(state.timer)
      clearTimeout(state.grace)
      activeChildren.delete(child)
      resolve({ status: null, signal: null, error: null, stdout: Buffer.concat(out.chunks).toString('utf8'), stderr: state.stderr, timedOut: state.timedOut, tooLarge: out.tooLarge, ...extra })
    }
    const abort = () => {
      killGroup(child)
      for (const stream of [child.stdout, child.stderr, child.stdin]) stream?.destroy()
      state.grace ??= setTimeout(() => finish({}), KILL_GRACE_MS)
    }
    state.timer = setTimeout(() => {
      state.timedOut = true
      abort()
    }, timeoutMs)
    child.stdout.on('data', (chunk) => {
      out.size += chunk.length
      if (out.size <= STDOUT_CAP_BYTES) {
        out.chunks.push(chunk)
        return
      }
      out.tooLarge = true
      abort()
    })
    child.stderr.on('data', (chunk) => {
      if (state.stderr.length < STDERR_KEEP_CHARS) state.stderr += chunk.toString('utf8')
    })
    child.once('error', (error) => finish({ error }))
    child.once('close', (status, signal) => finish({ status, signal }))
    if (input !== undefined) {
      child.stdin.on('error', () => {})
      child.stdin.end(input)
    }
  })
}

async function runTool(ctx, stats, name, cmd, args, { cwd, input } = {}) {
  stats.calls += 1
  const res = await runCommand(cmd, args, { cwd, env: ctx.env, input, timeoutMs: ctx.timeouts[name] })
  if (res.timedOut) throw new LaneFailure('timeout', `${name} timeout: exceeded ${ctx.timeouts[name]} ms`)
  return res
}

function parseJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

// ---- the reader ----

async function readerJson(ctx, stats, command, input, extraArgs = []) {
  const res = await runTool(ctx, stats, 'reader', process.execPath, [READER_PATH, command, ...extraArgs], { input })
  const parsed = res.status === 0 && !res.tooLarge ? parseJson(res.stdout) : null
  if (parsed === null || typeof parsed !== 'object') {
    const detail = res.tooLarge ? 'output over the size limit' : `status ${res.status}`
    throw new LaneFailure('other', `the reader failed for ${command} (${detail})`)
  }
  if (typeof parsed.error === 'string') throw new LaneFailure('other', `the reader reported an error for ${command}`)
  return parsed
}

// ---- ledger lane ----

// Absent is fine (an uninstrumented repository); anything else that is not a
// regular file under its size cap is a reason not to read. The checks, and the
// directories on the way, are the reader's guarded helper.
function unreadableLedgerInput(ledgerRoot) {
  for (const [rel, cap] of LEDGER_INPUT_FILES) {
    const { status } = repoFileStatus(ledgerRoot, rel, cap)
    if (status !== 'ok' && status !== 'absent') return UNREADABLE_INPUT_REASONS[status](rel)
  }
  return null
}

async function ledgerLane(ctx, stats) {
  const location = resolveLedgerRoot(ctx.root)
  if (location.unresolved) throw new LaneFailure('could_not_read', LEDGER_LOCATION_REASON)
  const ledgerRoot = path.resolve(location.root)
  const unreadable = unreadableLedgerInput(ledgerRoot)
  if (unreadable) throw new LaneFailure('could_not_read', unreadable)
  return { result: await readerJson(ctx, stats, 'ledger', undefined, [ledgerRoot, `--window=${DEFAULT_LEDGER_WINDOW_LINES}`]) }
}

// The ledger identity the git figure is matched by (null when the ledger lane
// gave none); taken from the ledger lane's own output, never read from the ledger again.
function ledgerIdentity(ledgerRecord) {
  const identity = ledgerRecord.result?.perRepo?.[0]?.root
  return typeof identity === 'string' ? identity : null
}

// ---- git lane ----

async function gitCall(ctx, stats, argv) {
  const res = await runTool(ctx, stats, `git ${argv[0]}`, 'git', ['-c', 'safe.bareRepository=explicit', '-C', ctx.root, ...argv])
  if (res.error) throw new LaneFailure('other', res.error.code === 'ENOENT' ? 'git was not found on PATH' : `git ${argv[0]} could not be started`)
  if (res.tooLarge) throw new LaneFailure('other', `git ${argv[0]} output exceeded the size limit`)
  if (res.status !== 0) throw new LaneFailure('other', gitFailureReason(argv[0], res))
  return res.stdout
}

// The figures come from the reader's escapedDefectsFigures, in process and given
// the identity: the reader's own escaped-defects command would also read the
// ledger, and a ledger that is a symlink or a directory must not be read. The
// toplevel check is inside that function: git must have read this root's history,
// not an enclosing repository's.
async function gitLane(ctx, stats, identity) {
  const log = await gitCall(ctx, stats, GIT_LOG_ARGV)
  if (log.length === 0) throw new LaneFailure('other', 'git log returned no commits')
  const toplevel = (await gitCall(ctx, stats, GIT_ROOT_ARGV)).trim()
  const figures = escapedDefectsFigures({ rawLog: log, toplevel, root: ctx.root, identity })
  if (figures.rejected) throw new LaneFailure('other', GIT_TOPLEVEL_REASON)
  return { result: figures }
}

// ---- ci lane ----

// null when the call worked, otherwise the failure mode.
function ghFailureMode(res) {
  if (res.error) return res.error.code === 'ENOENT' ? 'absent_from_path' : 'other'
  if (res.tooLarge) return 'other'
  if (res.status === 0) return null
  if (RATE_LIMIT_RE.test(res.stderr)) return 'rate_limited'
  return UNAUTHENTICATED_RE.test(res.stderr) ? 'unauthenticated' : 'other'
}

const GH_FAILURE_REASONS = {
  absent_from_path: 'gh was not found on PATH',
  unauthenticated: 'gh is not authenticated',
  rate_limited: 'gh reported a rate limit',
}

function ghCall(ctx, stats, argv) {
  return runTool(ctx, stats, `gh ${argv[0]} ${argv[1]}`, 'gh', argv, { cwd: ctx.root })
}

// One run's jobs: { jobs } or { error: <fetch mode> }. A failed view is data on
// that run, not a failed lane; a timeout of the call is the lane's. A view is not
// attempted once the lane's budget has run out: that is { error: 'timeout' }.
async function fetchJobs(ctx, stats, argv, deadline) {
  if (Date.now() >= deadline) return { error: 'timeout' }
  const res = await ghCall(ctx, stats, argv)
  const mode = ghFailureMode(res)
  if (mode) return { error: FETCH_MODES.has(mode) ? mode : 'other' }
  const parsed = parseJson(res.stdout)
  if (!parsed || !Array.isArray(parsed.jobs)) return { error: 'other' }
  return { jobs: parsed.jobs.filter((job) => job && typeof job.name === 'string') }
}

function durationSeconds(job) {
  const started = Date.parse(job.startedAt)
  const ended = Date.parse(job.completedAt)
  return Number.isFinite(started) && Number.isFinite(ended) && ended >= started ? (ended - started) / 1000 : null
}

const toJob = (job) => ({ name: job.name, conclusion: typeof job.conclusion === 'string' ? job.conclusion : null, duration_s: durationSeconds(job) })

async function runEntry(ctx, stats, label, run, deadline) {
  const id = String(run?.databaseId)
  if (!/^\d+$/.test(id)) return null
  const entry = { repo: label, workflow: run.workflowName, id, attempt: run.attempt, status: run.status, started_at: run.startedAt, jobs: [] }
  const latest = await fetchJobs(ctx, stats, ['run', 'view', id, '--json', 'jobs'], deadline)
  if (latest.error) {
    entry.fetch_error = latest.error
    return entry
  }
  entry.jobs = latest.jobs.map(toJob)
  if (Number.isInteger(run.attempt) && run.attempt > 1) {
    const first = await fetchJobs(ctx, stats, ['run', 'view', id, '--attempt', '1', '--json', 'jobs'], deadline)
    if (first.error) entry.attempt1_fetch_error = first.error
    else entry.attempt1_jobs = first.jobs.map(({ name, conclusion }) => ({ name, conclusion: typeof conclusion === 'string' ? conclusion : null }))
  }
  return entry
}

async function listRuns(ctx, stats) {
  const res = await ghCall(ctx, stats, GH_LIST_ARGV)
  const mode = ghFailureMode(res)
  if (mode) throw new LaneFailure(mode, GH_FAILURE_REASONS[mode] || `gh run list exited with status ${res.status}`)
  const runs = parseJson(res.stdout)
  if (!Array.isArray(runs)) throw new LaneFailure('other', 'gh run list returned output that is not a JSON array')
  return runs
}

// The per-run calls are made one after another: gh's rate limit is the scarce
// thing here, and a timeout must stop the lane at the first overrun.
async function collectEntries(ctx, stats, label, runs, deadline) {
  const entries = []
  for (const run of runs) {
    // Deliberately sequential: gh's rate limit, the budget check before each call, and a deterministic order.
    const entry = await runEntry(ctx, stats, label, run, deadline)
    if (entry) entries.push(entry)
  }
  return entries
}

const budgetReason = (fetched, total) => `ci lane budget exhausted: ${fetched} of ${total} runs fetched`

// No run's jobs were measured: gh listed nothing usable, every view failed, or
// the budget ran out before the first one.
function assertJobsMeasured(entries) {
  if (entries.length === 0) throw new LaneFailure('other', 'gh run list returned no run with a usable id')
  const failed = entries.filter((entry) => entry.fetch_error)
  if (failed.length < entries.length) return
  if (failed.some((entry) => entry.fetch_error === 'timeout')) throw new LaneFailure('timeout', budgetReason(0, entries.length))
  throw new LaneFailure(failed[0].fetch_error, `gh run view failed for all ${entries.length} runs, so no job data was measured`)
}

async function ciLane(ctx, stats) {
  const startedAt = Date.now()
  const label = path.basename(path.resolve(ctx.root))
  const runs = await listRuns(ctx, stats)
  const entries = await collectEntries(ctx, stats, label, runs, startedAt + ctx.timeouts['ci lane'])
  const noHistory = runs.length === 0
  if (!noHistory) assertJobsMeasured(entries)
  const fetchFailedCount = entries.filter((entry) => entry.fetch_error).length
  const timeoutCount = entries.filter((entry) => entry.fetch_error === 'timeout').length
  const failures = noHistory ? [{ repo: label, mode: 'no_history', command: 'gh run list', error: '' }] : []
  const ghStats = [{ repo: label, wall_clock_s: seconds(Date.now() - startedAt), gh_calls: stats.calls }]
  const payload = JSON.stringify({ runs: entries, requestedLimit: GH_RUN_LIMIT, minRunsNeverFailed: MIN_RUNS_FOR_NEVER_FAILED })
  const result = { ...(await readerJson(ctx, stats, 'ci', payload)), failures, ghStats }
  if (noHistory) return { mode: 'no_history', runCount: null, fetchFailedCount: null, timeoutCount: null, result }
  const runCount = entries.length - fetchFailedCount
  return { runCount, fetchFailedCount, timeoutCount, ...(timeoutCount > 0 ? { reason: budgetReason(runCount, entries.length) } : {}), result }
}

// ---- lanes and files ----

const seconds = (ms) => Math.round(ms) / 1000

function writeLane(outDir, record) {
  const file = path.join(outDir, `${record.lane}.json`)
  fs.writeFileSync(file, JSON.stringify(record) + '\n', { mode: 0o600 })
  fs.chmodSync(file, 0o600)
}

// An unexpected error as a fixed vocabulary only: its class, its code and its
// syscall, each accepted only if it has the shape of one. Never its message, which
// can carry a path or a tool's output.
const SAFE_ERROR_PARTS = [['name', /^[A-Za-z][A-Za-z0-9]{0,39}$/], ['code', /^[A-Z][A-Z0-9_]{1,39}$/], ['syscall', /^[a-z][a-z0-9_]{1,39}$/]]
function describeError(error) {
  const parts = SAFE_ERROR_PARTS.map(([key, shape]) => (typeof error?.[key] === 'string' && shape.test(error[key]) ? error[key] : null))
  return parts.filter(Boolean).join(' ') || 'error'
}

function failedRecord(lane, error) {
  const mode = error instanceof LaneFailure ? error.mode : 'other'
  const reason = error instanceof LaneFailure ? error.message : `unexpected ${describeError(error)}`
  return { lane, status: 'failed', mode, reason, result: null, ...(lane === 'ci' ? { runCount: null, fetchFailedCount: null, timeoutCount: null } : {}) }
}

async function runLane(ctx, lane, fn) {
  const startedAt = Date.now()
  const stats = { calls: 0 }
  let record
  try {
    record = { lane, status: 'ran', ...(await fn(ctx, stats)) }
  } catch (error) {
    record = failedRecord(lane, error)
  }
  record.calls = stats.calls
  record.wall_clock_s = seconds(Date.now() - startedAt)
  writeLane(ctx.outDir, record)
  return record
}

function isDirectory(p) {
  try {
    // operator-configured root, not repository content
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

function laneToken(record) {
  if (record.status === 'ran') {
    const state = record.mode ? `ran:${record.mode}` : 'ran'
    return `${record.lane}=${state}`
  }
  return `${record.lane}=failed:${record.mode}`
}

// One line per repository: status per lane, call count and wall-clock seconds.
// Fixed fields only; nothing collected, and no path, appears in it. When the ci
// lane measured runs, the counts fetched and not fetched (and how many of those
// were never attempted for want of budget) show partial degradation.
function logLine(records) {
  const calls = records.map((r) => `${r.lane}:${r.calls}`).join(',')
  const wall = records.map((r) => `${r.lane}:${r.wall_clock_s}`).join(',')
  const ci = records.find((r) => r.lane === 'ci')
  const ciRuns = Number.isInteger(ci?.runCount) ? ` ci_runs=fetched:${ci.runCount},not_fetched:${ci.fetchFailedCount},timeout:${ci.timeoutCount}` : ''
  return `COLLECT ${records.map(laneToken).join(' ')} calls=${calls} wall_clock_s=${wall}${ciRuns}`
}

// Collects one repository into outDir. Resolves with { lanes, line } even when
// lanes failed; the failures are in the lane files. Rejects only for a bad call.
export async function collectRepo({ root, outDir, timeoutMs } = {}) {
  if (typeof root !== 'string' || !root || typeof outDir !== 'string' || !outDir) throw new TypeError('collectRepo needs a root and an outDir')
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 })
  const ctx = { root, outDir, timeouts: resolveTimeouts(timeoutMs), env: childEnv() }
  const bad = (mode) => () => {
    throw new LaneFailure(mode, 'the repository root is not a directory')
  }
  const rootOk = isDirectory(root)
  const ledger = await runLane(ctx, 'ledger', rootOk ? ledgerLane : bad('could_not_read'))
  const git = await runLane(ctx, 'git', rootOk ? (c, st) => gitLane(c, st, ledgerIdentity(ledger)) : bad('other'))
  const ci = await runLane(ctx, 'ci', rootOk ? ciLane : bad('other'))
  const records = [ledger, git, ci]
  return { lanes: { ledger, git, ci }, line: logLine(records) }
}

// ---- command line ----

function installSignalHandlers() {
  for (const [name, code] of [['SIGTERM', 143], ['SIGINT', 130], ['SIGHUP', 129]]) {
    process.once(name, () => {
      killActiveChildren()
      process.stderr.write(`COLLECT interrupted by ${name}\n`)
      process.exit(code)
    })
  }
}

async function cli(argv) {
  if (argv.length !== 2) {
    process.stderr.write('usage: node optimise-collect.mjs <repository-root> <output-directory>\n')
    return 2
  }
  installSignalHandlers()
  try {
    const { line } = await collectRepo({ root: argv[0], outDir: argv[1] })
    process.stdout.write(line + '\n')
    return 0
  } catch (error) {
    process.stderr.write(`COLLECT failed: ${describeError(error)}\n`)
    return 1
  }
}

function isMainModule() {
  try {
    return Boolean(process.argv[1]) && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])
  } catch {
    return false
  }
}

if (isMainModule()) process.exitCode = await cli(process.argv.slice(2))
