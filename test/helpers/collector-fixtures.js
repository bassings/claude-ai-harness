// Shared fixtures for the collector tests (HARN-RUNNER-2 T1 and T1b), moved out of
// test/harn-runner-2-t1.test.js unchanged: stub `gh` and `git` executables placed first
// on PATH, real temporary git repositories, and helpers that run the collector.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync, execFileSync } = require('node:child_process')
const { pathToFileURL } = require('node:url')
const { makeTempRepo, trackTempDir, SUITE_TMPDIR, sh, sanitizedGitEnv, LEDGER_REL } = require('./temp-repo.js')

const COLLECTOR = path.join(__dirname, '..', '..', 'workflows', 'lib', 'optimise-collect.mjs')
const REAL_GIT = sh('command -v git', SUITE_TMPDIR).trim()

// ---- stubs ----

function makeStubs({ gh = true } = {}) {
  const dir = fs.mkdtempSync(path.join(SUITE_TMPDIR, 'stubs-'))
  trackTempDir(dir)
  const bin = path.join(dir, 'bin')
  fs.mkdirSync(bin)
  fs.symlinkSync(process.execPath, path.join(bin, 'node'))
  const stubs = { dir, bin, log: path.join(dir, 'calls.log'), pids: path.join(dir, 'pids') }
  fs.writeFileSync(stubs.log, '')
  fs.writeFileSync(stubs.pids, '')
  fs.writeFileSync(path.join(bin, 'git'), gitStub(stubs), { mode: 0o755 })
  if (gh) fs.writeFileSync(path.join(bin, 'gh'), ghStub(stubs), { mode: 0o755 })
  return stubs
}

// Records argv (tab separated) and, when asked, hangs. The stubs reset their own
// PATH to the system tools, because the collector's PATH is the stub directory
// alone (so a missing gh is genuinely missing). A hang is the stub plus a
// BACKGROUND GRANDCHILD that outlives the stub if only the stub is killed: both
// pids are witnessed, and the grandchild keeps the stdout pipe open, so a kill of
// the child alone leaves the collector waiting. Only the process group dies together.
const HANG = `hang() { sleep 30 & echo $$ >> "$PIDS"; echo $! >> "$PIDS"; wait; exit 0; }
detach_holder() { perl -e 'use POSIX qw(setsid); setsid(); open(F, ">>", $ARGV[0]); print F "$$\\n"; close(F); sleep 30' "$PIDS" & }`

// A stub that leaves a descendant in its OWN session (so no process-group kill reaches it)
// holding the output pipe open: only a hard bound on the call itself can return.

function gitStub({ dir, log, pids }) {
  return `#!/bin/sh
PATH=/usr/bin:/bin
PIDS="${pids}"
${HANG}
{ printf 'GIT'; for a in "$@"; do printf '\\t%s' "$a"; done; printf '\\n'; } >> "${log}"
root=''; prev=''
for a in "$@"; do if [ "$prev" = "-C" ]; then root="$a"; fi; prev="$a"; done
sub="$5"
if [ -f "${dir}/git-sleep" ] && grep -qxF -- "$root" "${dir}/git-sleep"; then
  if [ ! -f "${dir}/git-sleep-cmd" ] || [ "$(cat "${dir}/git-sleep-cmd")" = "$sub" ]; then hang; fi
fi
if [ -f "${dir}/git-huge" ] && [ "$sub" = "log" ]; then head -c 70000000 /dev/zero | tr '\\0' 'a'; exit 0; fi
if [ -f "${dir}/git-stderr" ]; then cat "${dir}/git-stderr" >&2; exit 128; fi
if [ -f "${dir}/git-empty-log" ] && [ "$sub" = "log" ]; then exit 0; fi
exec "${REAL_GIT}" "$@"
`
}

function ghStub({ dir, log, pids }) {
  return `#!/bin/sh
PATH=/usr/bin:/bin
PIDS="${pids}"
${HANG}
{ printf 'GH\\t%s' "$(pwd -P)"; for a in "$@"; do printf '\\t%s' "$a"; done; printf '\\n'; } >> "${log}"
printf 'ENV\\tGH_HOST=%s\\tGH_REPO=%s\\tGH_ENTERPRISE_TOKEN=%s\\n' "\${GH_HOST-unset}" "\${GH_REPO-unset}" "\${GH_ENTERPRISE_TOKEN-unset}" >> "${log}"
fail_with() {
  case "$1" in
    sleep) hang ;;
    unauth) echo 'To get started with GitHub CLI, please run:  gh auth login' >&2; exit 4 ;;
    ratelimit) echo 'gh: API rate limit exceeded for user ID 1 (HTTP 403)' >&2; exit 1 ;;
    ratelimit429) echo 'gh: request failed (HTTP 429)' >&2; exit 1 ;;
    ratelimittext) echo 'gh: API rate limit exceeded for user ID 1' >&2; exit 1 ;;
    forbidden) echo 'gh: Resource not accessible by integration (HTTP 403)' >&2; exit 1 ;;
    other) echo 'gh: something unexpected happened' >&2; exit 1 ;;
    detach) detach_holder; exit 0 ;;
    huge) head -c 70000000 /dev/zero | tr '\\0' 'a'; exit 0 ;;
  esac
}
mode=$(cat "${dir}/gh-mode" 2>/dev/null || echo ok)
fail_with "$mode"
if [ "$1 $2" = "run list" ]; then cat "${dir}/runs.json"; exit 0; fi
if [ "$1 $2" = "run view" ]; then
  key="$3"; if [ "$4" = "--attempt" ]; then key="$3-a1"; fi
  vmode=$(cat "${dir}/view-mode" 2>/dev/null || echo ok)
  if [ "$vmode" != ok ] && { [ ! -f "${dir}/view-fail" ] || grep -qxF -- "$key" "${dir}/view-fail"; }; then fail_with "$vmode"; fi
  if [ "$4" = "--attempt" ]; then f="${dir}/view-$3-a1.json"; else f="${dir}/view-$3.json"; fi
  if [ -f "${dir}/view-slow" ]; then sleep "$(cat "${dir}/view-slow")"; fi
  if [ -f "$f" ]; then cat "$f"; exit 0; fi
  echo 'no such run' >&2; exit 1
fi
exit 2
`
}

function setGhMode(stubs, mode) {
  fs.writeFileSync(path.join(stubs.dir, 'gh-mode'), mode)
}

// Failure for `gh run view` calls only. `keys` lists the calls that fail: a run id
// for its latest-attempt call, `<id>-a1` for its attempt-1 call; omitted, every view fails.
function setViewFailure(stubs, mode, keys = null) {
  fs.writeFileSync(path.join(stubs.dir, 'view-mode'), mode)
  if (keys) fs.writeFileSync(path.join(stubs.dir, 'view-fail'), keys.join('\n') + '\n')
}

function setGhRuns(stubs, runs, views = {}) {
  fs.writeFileSync(path.join(stubs.dir, 'runs.json'), JSON.stringify(runs))
  for (const [name, body] of Object.entries(views)) fs.writeFileSync(path.join(stubs.dir, `view-${name}.json`), JSON.stringify(body))
}

const job = (name, conclusion = 'success') => ({ name, conclusion, startedAt: '2026-11-01T00:00:00Z', completedAt: '2026-11-01T00:01:00Z' })
const run = (id, attempt = 1) => ({ databaseId: id, attempt, status: 'completed', workflowName: 'ci', startedAt: '2026-11-01T00:00:00Z' })

function recorded(stubs, tool) {
  return fs
    .readFileSync(stubs.log, 'utf8')
    .split('\n')
    .filter((l) => l.startsWith(`${tool}\t`))
    .map((l) => l.split('\t').slice(1))
}

// ---- repository fixtures ----

const ledgerLine = (i, extra = {}) =>
  JSON.stringify({ schema_version: 1, run_id: `r${i}`, ts: new Date(Date.UTC(2026, 7, 1, 0, 0, i)).toISOString(), repo: 'demo', kind: 'tdd_task', outcome: 'done', write_ok: true, write_error: null, ...extra })

function gitIn(root, args, env = {}) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', env: { ...sanitizedGitEnv(), ...env } })
}

function makeRepo({ ledger = null, fix = 0, other = 0, subjects = [], author = null } = {}) {
  const root = makeTempRepo()
  if (ledger !== null) {
    fs.mkdirSync(path.join(root, '.claude'), { recursive: true })
    fs.writeFileSync(path.join(root, LEDGER_REL), ledger)
  }
  const identity = author ? ['-c', `user.email=${author}`, '-c', 'user.name=Canary Author'] : []
  const messages = [...Array.from({ length: fix }, (_, i) => `fix: defect ${i}`), ...Array.from({ length: other }, (_, i) => `feat: thing ${i}`), ...subjects]
  for (const m of messages) gitIn(root, [...identity, 'commit', '-q', '--allow-empty', '-m', m])
  return root
}

const validLedger = (k, extra = {}) => Array.from({ length: k }, (_, i) => ledgerLine(i, extra)).join('\n') + '\n'

// ---- running the collector ----

function scratchDir() {
  const d = fs.mkdtempSync(path.join(SUITE_TMPDIR, 'scratch-'))
  trackTempDir(d)
  return d
}

function childEnv(stubs, extra = {}) {
  return { PATH: stubs.bin, HOME: stubs.dir, LANG: 'C', ...extra }
}

function runCli(stubs, root, outDir, extraEnv = {}) {
  return spawnSync(process.execPath, [COLLECTOR, root, outDir], { cwd: scratchDir(), env: childEnv(stubs, extraEnv), encoding: 'utf8', timeout: 120000 })
}

function collect(stubs, root, extraEnv = {}) {
  const outDir = scratchDir()
  const res = runCli(stubs, root, outDir, extraEnv)
  assert.equal(res.status, 0, `the collector CLI must exit 0 when it ran, status ${res.status}, stderr: ${res.stderr}`)
  return { outDir, res }
}

const lane = (outDir, name) => JSON.parse(fs.readFileSync(path.join(outDir, `${name}.json`), 'utf8'))

const DRIVER = `import(process.argv[1]).then(async (m) => { const lines = []; for (const o of JSON.parse(process.argv[2])) lines.push((await m.collectRepo(o)).line); process.stdout.write(lines.join('\\n')) }).catch((e) => { console.error(String(e && e.stack)); process.exit(3) })`

function runDriver(stubs, optsList, extraEnv = {}) {
  return spawnSync(process.execPath, ['-e', DRIVER, pathToFileURL(COLLECTOR).href, JSON.stringify(optsList)], { cwd: scratchDir(), env: childEnv(stubs, extraEnv), encoding: 'utf8', timeout: 120000 })
}

async function waitFor(pred, ms = 10000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (pred()) return true
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return pred()
}

const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const witnessedPids = (stubs) => fs.readFileSync(stubs.pids, 'utf8').split('\n').filter(Boolean).map(Number)

// A stub hang is the stub and a background grandchild: both must have been seen,
// and both must be gone, which only a kill of the whole process group achieves.
async function assertWitnessedGone(stubs, label) {
  const pids = witnessedPids(stubs)
  assert.ok(pids.length >= 2, `${label}: the stub and its background grandchild must both have been witnessed, saw ${pids.length}`)
  for (const pid of pids) assert.ok(await waitFor(() => !alive(pid), 3000), `${label}: process ${pid} survived`)
}

function killWitnessed(stubs) {
  for (const pid of witnessedPids(stubs)) if (alive(pid)) process.kill(pid, 'SIGKILL')
}

function allOutput(outDir, res) {
  const files = fs.readdirSync(outDir).map((f) => fs.readFileSync(path.join(outDir, f), 'utf8'))
  return [...files, res ? res.stdout + res.stderr : ''].join('\n')
}

function treeListing(root) {
  return fs.readdirSync(root, { recursive: true }).filter((f) => !f.startsWith('.git' + path.sep) && f !== '.git').sort()
}

module.exports = { COLLECTOR, REAL_GIT, makeStubs, HANG, gitStub, ghStub, setGhMode, setViewFailure, setGhRuns, job, run, recorded, ledgerLine, gitIn, makeRepo, validLedger, scratchDir, childEnv, runCli, collect, lane, DRIVER, runDriver, waitFor, alive, witnessedPids, assertWitnessedGone, killWitnessed, allOutput, treeListing }
