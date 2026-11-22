// A sandbox for driving bin/optimise-cycle-weekly.sh (HARN-RUNNER-2 T3): an isolated HOME and TMPDIR, an install
// directory ($CLAUDE_HOME) holding the real helper programs the runner runs from there, a stub `osascript`, a stub
// `claude` that is test/helpers/stub-session.mjs, and a stub `gh` and `git` that record what they were asked.
//
// Shared by test/harn-runner-2-t3.test.js and test/weekly-runner.test.js so the two cannot disagree about what a
// provisioned install holds. Every directory is created under the suite's own temporary root and removed with it.
const fs = require('node:fs')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')
const { SUITE_TMPDIR, trackTempDir } = require('./temp-repo.js')
const F = require('./collector-fixtures.js')

const ROOT = path.join(__dirname, '..', '..')
const SCRIPT_PATH = path.join(ROOT, 'bin', 'optimise-cycle-weekly.sh')
const STUB_SESSION = path.join(__dirname, 'stub-session.mjs')
const REPORT_REL = path.join('.claude', 'optimise-cycle-report.md')
const SIDECAR_REL = path.join('.claude', 'optimise-proposal-targets.json')
const RUNNER_DIR = 'optimise-weekly-runner'

const root = fs.mkdtempSync(path.join(SUITE_TMPDIR, 'weekly-sandbox-'))
trackTempDir(root)
let counter = 0
function freshDir(prefix) {
  counter += 1
  const dir = path.join(root, `${prefix}${counter}`)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

// The programs the runner runs from $CLAUDE_HOME/workflows/lib/: byte copies of this repository's own.
// Nothing already in the install is replaced, so a test that put its own file there keeps it.
function provisionInstall(claudeHome, { workflow = false } = {}) {
  const lib = path.join(claudeHome, 'workflows', 'lib')
  fs.mkdirSync(lib, { recursive: true })
  const copyNew = (from, to) => {
    if (!fs.existsSync(to)) fs.copyFileSync(from, to)
  }
  for (const name of fs.readdirSync(path.join(ROOT, 'workflows', 'lib'))) copyNew(path.join(ROOT, 'workflows', 'lib', name), path.join(lib, name))
  if (workflow) copyNew(path.join(ROOT, 'workflows', 'optimise-cycle.js'), path.join(claudeHome, 'workflows', 'optimise-cycle.js'))
  return claudeHome
}

// `claude` is the stub session; `osascript` records the notification; `gh` (when no recording stub set is given)
// reports no Actions history, which the collector counts as a lane that ran.
function stubBin() {
  const dir = freshDir('bin-')
  fs.writeFileSync(path.join(dir, 'claude'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(STUB_SESSION)} "$@"\n`, { mode: 0o755 })
  fs.writeFileSync(path.join(dir, 'osascript'), '#!/bin/sh\nif [ -n "$OSA_RECORD" ]; then echo CALL >> "$OSA_RECORD"; for a in "$@"; do printf \'ARG\\t%s\\n\' "$a" >> "$OSA_RECORD"; done; fi\nexit "${OSA_EXIT:-0}"\n', { mode: 0o755 })
  fs.writeFileSync(path.join(dir, 'gh'), '#!/bin/sh\nif [ "$1 $2" = "run list" ]; then echo "[]"; exit 0; fi\nexit 2\n', { mode: 0o755 })
  return dir
}

function readNotifyCalls(recordPath) {
  if (!fs.existsSync(recordPath)) return []
  const calls = []
  for (const line of fs.readFileSync(recordPath, 'utf8').split('\n')) {
    if (line === 'CALL') calls.push([])
    else if (line.startsWith('ARG\t')) calls[calls.length - 1].push(line.slice(4))
  }
  return calls
}

// Builds the environment for one runner invocation. `stubs` (collector-fixtures makeStubs) puts a recording gh and
// git ahead of the plain stub gh; PATH is otherwise the real one, which supplies node, timeout and the rest.
function runnerEnv(repos, opts = {}) {
  const home = opts.home || freshDir('home-')
  const tmpdir = opts.tmpdir || freshDir('tmp-')
  const log = path.join(freshDir('log-'), 'weekly.log')
  // The workflow is installed only when a test asks for it: with one the runner stages a copy into each repo.
  const claudeHome = opts.claudeHome || provisionInstall(freshDir('claudehome-'), { workflow: opts.workflow === true })
  const witness = freshDir('witness-')
  const bin = opts.stubBin || stubBin()
  // A recording stub set comes before the plain stubs, so its `gh` is the one that runs.
  const pathParts = [opts.extraPath, opts.stubs ? opts.stubs.bin : null, bin, process.env.PATH].filter(Boolean)
  const env = {
    ...process.env,
    PATH: pathParts.join(':'),
    OPTIMISE_WEEKLY_LOG: log,
    OPTIMISE_WEEKLY_REPOS: repos.join('\n'),
    OPTIMISE_WEEKLY_STALENESS_REMOTE: path.join(root, 'no-such-staleness-remote'),
    HOME: home,
    TMPDIR: tmpdir,
    CLAUDE_HOME: claudeHome,
    OSA_RECORD: `${log}.notify`,
    OSA_EXIT: '0',
    STUB_WITNESS_DIR: witness,
    // A repository's marker file overrides this; without either the stub session returns nothing.
    STUB_SESSION_MODE: 'pass',
    ...(opts.env || {}),
  }
  for (const name of opts.unsetEnv || []) delete env[name]
  return { env, home, tmpdir, log, claudeHome, witness }
}

function readLog(log) {
  return fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : ''
}

// Everything the stub session saw in each of its invocations, oldest first.
function sessions(witness) {
  const names = fs.readdirSync(witness).filter((n) => n.startsWith('session-')).sort((a, b) => a.localeCompare(b))
  return names.map((n) => {
    const stamp = n.slice('session-'.length, -'.json'.length)
    const seen = JSON.parse(fs.readFileSync(path.join(witness, n), 'utf8'))
    const read = (name) => {
      const f = path.join(witness, `seen-${name}-${stamp}.json`)
      return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null
    }
    return { ...seen, digest: read('digest'), ledger: read('ledger'), git: read('git'), ci: read('ci') }
  })
}

function runRunner(repos, opts = {}) {
  const ctx = runnerEnv(repos, opts)
  const res = spawnSync(SCRIPT_PATH, [], { encoding: 'utf8', timeout: opts.timeout || 120000, env: ctx.env, maxBuffer: 64 * 1024 * 1024 })
  const logContents = readLog(ctx.log)
  return { ...res, ...ctx, logContents, notifyCalls: readNotifyCalls(`${ctx.log}.notify`), sessions: () => sessions(ctx.witness) }
}

function startRunner(repos, opts = {}) {
  const ctx = runnerEnv(repos, opts)
  const child = spawn(SCRIPT_PATH, [], { env: ctx.env, stdio: 'ignore' })
  const done = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })))
  return { ...ctx, child, done, notifyCalls: () => readNotifyCalls(`${ctx.log}.notify`), sessions: () => sessions(ctx.witness) }
}

const marker = (repo, mode) => fs.writeFileSync(path.join(repo, '.optimise-weekly-test-marker'), `${mode}\n`)

// The one RESULT line the runner wrote for a repository label, or null.
function resultLine(logContents, label) {
  const m = logContents.match(new RegExp(`^RESULT (PASS|FAIL) ${label.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?: .*)?$`, 'm'))
  return m ? m[0] : null
}

module.exports = { ROOT, SCRIPT_PATH, STUB_SESSION, REPORT_REL, SIDECAR_REL, RUNNER_DIR, F, freshDir, provisionInstall, stubBin, readNotifyCalls, runnerEnv, runRunner, startRunner, sessions, marker, resultLine, readLog }
