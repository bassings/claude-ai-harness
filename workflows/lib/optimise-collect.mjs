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
//  - Every command has its own timeout and is killed, with its whole process
//    group, when it overruns or when this program is signalled.
//  - Output files are created 0600. Failure reasons are fixed text and numbers,
//    never gh or git output, so no commit subject, job name or address reaches a
//    reason or the log line.
//
// The timeout is the collectRepo argument timeoutMs, a test seam. It is not read
// from the environment or a config file.

import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { DEFAULT_LEDGER_WINDOW_LINES, parseGitLogRaw, countEscapedDefectCandidates, resolveProductSourceExcludeGlobs } from './optimise-read.mjs'

const READER_PATH = fileURLToPath(new URL('./optimise-read.mjs', import.meta.url))

// Per command, not per repository: a hung gh, git or reader is bounded on its own.
const COMMAND_TIMEOUT_MS = 120_000
const STDOUT_CAP_BYTES = 64 * 1024 * 1024
const STDERR_KEEP_CHARS = 4096
const GH_RUN_LIMIT = 100
const MIN_RUNS_NEVER_FAILED = 5
const GIT_LOG_MAX_COMMITS = 500

const GH_LIST_ARGV = ['run', 'list', '--limit', String(GH_RUN_LIMIT), '--json', 'databaseId,attempt,status,workflowName,startedAt']
const GIT_LOG_ARGV = ['log', `--max-count=${GIT_LOG_MAX_COMMITS}`, '--name-only', '--pretty=format:%x1e%P%x1f%s']
const GIT_ROOT_ARGV = ['rev-parse', '--show-toplevel']

const LEDGER_INPUTS = [
  { rel: '.claude', dir: true },
  { rel: '.claude/harness-ledger.jsonl', dir: false },
  { rel: '.claude/optimise-proposal-targets.json', dir: false },
]

const SCRUBBED_ENV = ['GH_HOST', 'GH_REPO', 'GH_ENTERPRISE_TOKEN', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']
const RATE_LIMIT_RE = /rate limit|HTTP 403|HTTP 429/i
const UNAUTHENTICATED_RE = /auth login|not logged in|HTTP 401|authentication/i
const FETCH_MODES = new Set(['rate_limited', 'unauthenticated'])

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
// a timeout or a signal to this program takes its descendants with it.
function runCommand(cmd, args, { cwd, env, input, timeoutMs }) {
  return new Promise((resolve) => {
    const out = { chunks: [], size: 0, tooLarge: false }
    const state = { stderr: '', timedOut: false, settled: false }
    const child = spawn(cmd, args, { cwd, env, detached: true, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] })
    activeChildren.add(child)
    const timer = setTimeout(() => {
      state.timedOut = true
      killGroup(child)
    }, timeoutMs)
    const finish = (extra) => {
      if (state.settled) return
      state.settled = true
      clearTimeout(timer)
      activeChildren.delete(child)
      resolve({ status: null, signal: null, error: null, stdout: Buffer.concat(out.chunks).toString('utf8'), stderr: state.stderr, timedOut: state.timedOut, tooLarge: out.tooLarge, ...extra })
    }
    child.stdout.on('data', (chunk) => {
      out.size += chunk.length
      if (out.size > STDOUT_CAP_BYTES) {
        out.tooLarge = true
        killGroup(child)
      } else {
        out.chunks.push(chunk)
      }
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

async function runTool(ctx, stats, cmd, args, { cwd, input } = {}) {
  stats.calls += 1
  return runCommand(cmd, args, { cwd, env: ctx.env, input, timeoutMs: ctx.timeoutMs })
}

function timeoutFailure(name, what, ctx) {
  return new LaneFailure('timeout', `${name} timeout: ${what} exceeded ${ctx.timeoutMs} ms`)
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
  const res = await runTool(ctx, stats, process.execPath, [READER_PATH, command, ...extraArgs], { input })
  if (res.timedOut) throw timeoutFailure('reader', `${command}`, ctx)
  const parsed = res.status === 0 && !res.tooLarge ? parseJson(res.stdout) : null
  if (parsed === null || typeof parsed !== 'object') throw new LaneFailure('other', `the reader failed for ${command} (status ${res.status})`)
  if (typeof parsed.error === 'string') throw new LaneFailure('other', `the reader reported an error for ${command}`)
  return parsed
}

// ---- ledger lane ----

// A linked worktree keeps its ledger in the main checkout (the same rule the
// ledger writer follows). Read from the filesystem alone, so no extra git form
// is run; anything unexpected leaves the configured root as it was.
function resolveLedgerRoot(root) {
  try {
    const dotGit = path.join(root, '.git')
    if (!fs.lstatSync(dotGit).isFile()) return root
    const first = fs.readFileSync(dotGit, 'utf8').split('\n')[0]
    if (!first.startsWith('gitdir: ')) return root
    const gitDir = path.resolve(root, first.slice('gitdir: '.length).trim())
    if (path.basename(path.dirname(gitDir)) !== 'worktrees') return root
    const common = path.resolve(gitDir, fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim())
    return path.basename(common) === '.git' ? path.dirname(common) : root
  } catch {
    return root
  }
}

// lstat, never stat: a symlink is reported as a symlink and its target is not
// touched. Absent is fine (an uninstrumented repository); anything else that is
// not the expected kind of entry is a reason not to read.
function unreadableLedgerInput(ledgerRoot) {
  for (const { rel, dir } of LEDGER_INPUTS) {
    let st
    try {
      st = fs.lstatSync(path.join(ledgerRoot, rel))
    } catch (error) {
      if (error && error.code === 'ENOENT') continue
      return `${rel} could not be inspected`
    }
    if (dir ? !st.isDirectory() : !st.isFile()) return `${rel} is a symlink or not a regular ${dir ? 'directory' : 'file'}`
  }
  return null
}

async function ledgerLane(ctx, stats) {
  const ledgerRoot = path.resolve(resolveLedgerRoot(ctx.root))
  const unreadable = unreadableLedgerInput(ledgerRoot)
  if (unreadable) throw new LaneFailure('could_not_read', unreadable)
  const result = await readerJson(ctx, stats, 'ledger', undefined, [ledgerRoot, `--window=${DEFAULT_LEDGER_WINDOW_LINES}`])
  // The ledger identity the git figure is matched by (null when the ledger lane
  // gave none); taken from this lane's own output, never read from the ledger again.
  const identity = result.perRepo?.[0]?.root
  ctx.repoIdentity = typeof identity === 'string' ? identity : null
  return { result }
}

// ---- git lane ----

async function gitCall(ctx, stats, argv) {
  const res = await runTool(ctx, stats, 'git', ['-c', 'safe.bareRepository=explicit', '-C', ctx.root, ...argv])
  if (res.timedOut) throw timeoutFailure('git', `git ${argv[0]}`, ctx)
  if (res.error) throw new LaneFailure('other', res.error.code === 'ENOENT' ? 'git was not found on PATH' : `git ${argv[0]} could not be started`)
  if (res.tooLarge) throw new LaneFailure('other', `git ${argv[0]} output exceeded the size limit`)
  if (res.status !== 0) throw new LaneFailure('other', `git ${argv[0]} exited with status ${res.status}`)
  return res.stdout
}

function sameDirectory(a, b) {
  try {
    return fs.realpathSync(a) === fs.realpathSync(b)
  } catch {
    return false
  }
}

// The figures come from the reader's exported functions, in process: the reader's
// own escaped-defects command would also read the ledger, and a ledger that is a
// symlink or a directory must not be read. The toplevel check is the reader's own
// rule: git must have read this root's history, not an enclosing repository's.
async function gitLane(ctx, stats) {
  const log = await gitCall(ctx, stats, GIT_LOG_ARGV)
  if (log.length === 0) throw new LaneFailure('other', 'git log returned no commits')
  const toplevel = (await gitCall(ctx, stats, GIT_ROOT_ARGV)).trim()
  if (!toplevel || !sameDirectory(toplevel, ctx.root)) throw new LaneFailure('other', 'git toplevel does not match the repository root; the git log was not read from that repository')
  const result = { ...countEscapedDefectCandidates(parseGitLogRaw(log), resolveProductSourceExcludeGlobs(ctx.root)), repo: ctx.repoIdentity ?? null }
  return { result }
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

async function ghCall(ctx, stats, argv) {
  const res = await runTool(ctx, stats, 'gh', argv, { cwd: ctx.root })
  if (res.timedOut) throw timeoutFailure('gh', `gh ${argv[0]} ${argv[1]}`, ctx)
  return res
}

// One run's jobs: { jobs } or { error: <fetch mode> }. A failed view is data on
// that run, not a failed lane; a timeout is the lane's.
async function fetchJobs(ctx, stats, argv) {
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

async function runEntry(ctx, stats, label, run) {
  const id = String(run?.databaseId)
  if (!/^\d+$/.test(id)) return null
  const entry = { repo: label, workflow: run.workflowName, id, attempt: run.attempt, status: run.status, started_at: run.startedAt, jobs: [] }
  const latest = await fetchJobs(ctx, stats, ['run', 'view', id, '--json', 'jobs'])
  if (latest.error) {
    entry.fetch_error = latest.error
    return entry
  }
  entry.jobs = latest.jobs.map(toJob)
  if (Number.isInteger(run.attempt) && run.attempt > 1) {
    const first = await fetchJobs(ctx, stats, ['run', 'view', id, '--attempt', '1', '--json', 'jobs'])
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
async function collectEntries(ctx, stats, label, runs) {
  const entries = []
  for (const run of runs) {
    const entry = await runEntry(ctx, stats, label, run)
    if (entry) entries.push(entry)
  }
  return entries
}

async function ciLane(ctx, stats) {
  const startedAt = Date.now()
  const label = path.basename(path.resolve(ctx.root))
  const runs = await listRuns(ctx, stats)
  const entries = await collectEntries(ctx, stats, label, runs)
  const noHistory = runs.length === 0
  const failures = noHistory ? [{ repo: label, mode: 'no_history', command: 'gh run list', error: '' }] : []
  const ghStats = [{ repo: label, wall_clock_s: seconds(Date.now() - startedAt), gh_calls: stats.calls }]
  const payload = JSON.stringify({ runs: entries, requestedLimit: GH_RUN_LIMIT, minRunsNeverFailed: MIN_RUNS_NEVER_FAILED })
  const result = { ...(await readerJson(ctx, stats, 'ci', payload)), failures, ghStats }
  return noHistory ? { mode: 'no_history', runCount: null, result } : { runCount: entries.length, result }
}

// ---- lanes and files ----

const seconds = (ms) => Math.round(ms) / 1000

function writeLane(outDir, record) {
  const file = path.join(outDir, `${record.lane}.json`)
  fs.writeFileSync(file, JSON.stringify(record) + '\n', { mode: 0o600 })
  fs.chmodSync(file, 0o600)
}

function failedRecord(lane, error) {
  const mode = error instanceof LaneFailure ? error.mode : 'other'
  const reason = error instanceof LaneFailure ? error.message : `unexpected ${error && error.name ? error.name : 'error'}`
  return { lane, status: 'failed', mode, reason, result: null, ...(lane === 'ci' ? { runCount: null } : {}) }
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
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

function laneToken(record) {
  if (record.status === 'ran') return `${record.lane}=${record.mode ? `ran:${record.mode}` : 'ran'}`
  return `${record.lane}=failed:${record.mode}`
}

// One line per repository: status per lane, call count and wall-clock seconds.
// Fixed fields only; nothing collected, and no path, appears in it.
function logLine(records) {
  const calls = records.map((r) => `${r.lane}:${r.calls}`).join(',')
  const wall = records.map((r) => `${r.lane}:${r.wall_clock_s}`).join(',')
  return `COLLECT ${records.map(laneToken).join(' ')} calls=${calls} wall_clock_s=${wall}`
}

// Collects one repository into outDir. Resolves with { lanes, line } even when
// lanes failed; the failures are in the lane files. Rejects only for a bad call.
export async function collectRepo({ root, outDir, timeoutMs = COMMAND_TIMEOUT_MS } = {}) {
  if (typeof root !== 'string' || !root || typeof outDir !== 'string' || !outDir) throw new TypeError('collectRepo needs a root and an outDir')
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 })
  const ctx = { root, outDir, timeoutMs, env: childEnv() }
  const bad = (mode) => () => {
    throw new LaneFailure(mode, 'the repository root is not a directory')
  }
  const rootOk = isDirectory(root)
  const ledger = await runLane(ctx, 'ledger', rootOk ? ledgerLane : bad('could_not_read'))
  const git = await runLane(ctx, 'git', rootOk ? gitLane : bad('other'))
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
    process.stderr.write(`COLLECT failed: ${error && error.name ? error.name : 'error'}\n`)
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
