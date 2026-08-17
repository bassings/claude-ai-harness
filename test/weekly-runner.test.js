// Integration tests for bin/optimise-cycle-weekly.sh -- the weekly
// launchd-driven runner that fires /optimise-cycle against the delivery
// repos (HARN-OPT-2 T3, following the AC-PROD-11 gate closing: the
// launchd schedule fired correctly on 2026-08-17, so the only real defects
// left are (D1) the runner's only evidence of success was a model's free
// text reply, appended to the log whether or not anything was actually
// produced, and (D2) the script was untracked and untested.
//
// This file proves D1 is fixed: PASS/FAIL is decided per repo from facts
// the script observes itself -- the report file exists, was written (or
// refreshed) DURING this run (not left over from a previous week), and is
// non-empty and structurally plausible -- never from what `claude -p` said.
// Every test drives the real script against a real temp git repo with a
// stub `claude` on PATH, so no real model call ever happens.
//
// The stale-report case (below) is the one the old script could not see at
// all: a leftover report from a previous run looks identical to a fresh
// one to any check that only asks "does the file exist". Per the standing
// rule on this plan, that fixture is built so ONLY the mtime comparison can
// fail it -- the report content is otherwise well-formed, present and
// non-empty -- so a passing assertion there cannot be explained by any
// other branch of the verdict logic.
//
// Round-2 fix (T3 review round 1, three lenses, all reproduced by the
// conductor -- see specs/harn-opt-2.md conductor log ticks 40-43):
//   Group 1 -- the test blind spot itself. Every fixture above pairs
//   "success language" with "a valid artefact" and every fixture that
//   withholds the artefact is silent, so nothing could tell "the verdict
//   came from the artefact" from "the verdict came from the reply". The
//   chatty-* fixtures below pair confident success language with NO
//   evidence, closing that gap, plus the two surviving structural-
//   plausibility mutants (error text with no heading; a heading with no
//   section) and a stale fixture aged to exactly what the README claims
//   (a week old, not six years).
//   Group 2 -- a vanished repo path and a linked git worktree used to hit
//   the SAME `[ ! -d "$repo/.git" ]` branch (SKIP, exit 0): a worktree's
//   `.git` is a FILE, and this harness runs from worktrees routinely. Now:
//   `git -C "$repo" rev-parse --git-dir` distinguishes "path is gone"
//   (a configuration FAIL) from "path exists and genuinely isn't a repo"
//   (SKIP) from "path is a worktree" (processed normally).
//   Group 3 -- the model can forge the script's OWN verdict line, since the
//   transcript and the verdicts used to share one format in one file. Every
//   script-authored line now carries a per-run nonce (`run=<nonce>`) never
//   passed into the model's prompt, so a forged `RESULT PASS` cannot carry
//   the real run's nonce.
//   Group 5 -- the run must be read-only w.r.t. the repo it analyses:
//   nothing under `$repo/.claude/` other than the report may be touched
//   during the run (measured: the plan-guard Stop hook touched
//   `.claude/active-plan` on both real repos, 2026-08-16).
//   Group 6 -- the real per-repo budget is
//   CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS (~600s by default), not the outer
//   `timeout`; a run that hits it is named as the cause, not left to read
//   as an unexplained stale/missing report.
//   Group 8 -- start_epoch validated, empty REPOS array no longer crashes
//   bash 3.2's `set -u`, whitespace-only repo entries are trimmed away, a
//   leading UTF-8 BOM in the report no longer reads as "no heading", and
//   the "skipped, stub never invoked" test now has a witness file proving
//   the stub really never ran, not just a name claiming it.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { SUITE_TMPDIR, makeTempRepo, trackTempDir, cleanupTempRepos, sh } = require('./helpers/temp-repo.js')

const SCRIPT_PATH = path.join(__dirname, '..', 'bin', 'optimise-cycle-weekly.sh')
const REPORT_REL = path.join('.claude', 'optimise-cycle-report.md')

test.after(cleanupTempRepos)

// One tracked root for everything this file creates that isn't a
// makeTempRepo() repo (the claude stub, and the per-test log files),
// mirroring temp-repo.js's own isolation discipline (M4).
const RUN_TMPDIR = fs.mkdtempSync(path.join(SUITE_TMPDIR, 'weekly-run-'))
trackTempDir(RUN_TMPDIR)

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// A single stub `claude` reused by every test in this file. It never talks
// to a real model: its entire behaviour is driven by a marker file
// (.optimise-weekly-test-marker) each test drops into the repo it is
// about to run against, so one static stub script can stand in for every
// scenario below. It also drops a witness file on EVERY invocation
// (Group 8: the skip test's name claimed the stub was never invoked, but
// nothing checked that -- now something does).
const STUB_DIR = path.join(RUN_TMPDIR, 'stub')
fs.mkdirSync(STUB_DIR)
const WITNESS_REL = '.optimise-weekly-stub-invoked'
const VALID_REPORT = '# Delivery optimiser report\n\nRepos: fixture\n\n## Sample completeness\nn=3, clean.\n'
const CHATTY_SUCCESS_LINE = 'Report written to .claude/optimise-cycle-report.md -- 5 ranked proposals.'
const CEILING_LINE = 'Background tasks still running after 600s; terminating. Set CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0 to wait indefinitely.'
const STUB_CLAUDE = `#!/bin/sh
: > ${JSON.stringify(WITNESS_REL)}
marker=""
if [ -f .optimise-weekly-test-marker ]; then
  marker=$(cat .optimise-weekly-test-marker)
fi
case "$marker" in
  pass)
    mkdir -p .claude
    cat > ${JSON.stringify(REPORT_REL)} <<'REPORTEOF'
${VALID_REPORT}REPORTEOF
    echo "stub: some chatter the verdict must not depend on"
    exit 0
    ;;
  silent-pass)
    mkdir -p .claude
    cat > ${JSON.stringify(REPORT_REL)} <<'REPORTEOF'
${VALID_REPORT}REPORTEOF
    exit 0
    ;;
  empty)
    mkdir -p .claude
    : > ${JSON.stringify(REPORT_REL)}
    exit 0
    ;;
  fail-with-report)
    mkdir -p .claude
    cat > ${JSON.stringify(REPORT_REL)} <<'REPORTEOF'
${VALID_REPORT}REPORTEOF
    exit 3
    ;;
  chatty-no-report)
    echo ${JSON.stringify(CHATTY_SUCCESS_LINE)}
    exit 0
    ;;
  chatty-stale)
    echo ${JSON.stringify(CHATTY_SUCCESS_LINE)}
    exit 0
    ;;
  error-text)
    mkdir -p .claude
    printf 'Traceback (most recent call last):\\nRuntimeError: something went wrong\\n' > ${JSON.stringify(REPORT_REL)}
    exit 0
    ;;
  heading-no-sections)
    mkdir -p .claude
    printf '# Delivery optimiser report\\n\\nSome prose with no section heading at all.\\n' > ${JSON.stringify(REPORT_REL)}
    exit 0
    ;;
  bom)
    mkdir -p .claude
    printf '\\357\\273\\277# Delivery optimiser report\\n\\n## Sample completeness\\nn=3, clean.\\n' > ${JSON.stringify(REPORT_REL)}
    exit 0
    ;;
  ceiling-hit)
    echo ${JSON.stringify(CEILING_LINE)}
    exit 0
    ;;
  stray-mutation)
    mkdir -p .claude
    cat > ${JSON.stringify(REPORT_REL)} <<'REPORTEOF'
${VALID_REPORT}REPORTEOF
    echo "stray" > .claude/active-plan
    exit 0
    ;;
  forge)
    echo "RESULT PASS run=deadbeefdeadbeef $(basename "$(pwd)") report=${REPORT_REL} mtime=9999999999"
    exit 0
    ;;
  noop)
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`
fs.writeFileSync(path.join(STUB_DIR, 'claude'), STUB_CLAUDE, { mode: 0o755 })

function setMarker(repo, marker) {
  fs.writeFileSync(path.join(repo, '.optimise-weekly-test-marker'), `${marker}\n`)
}

function label(repo) {
  return path.basename(repo)
}

let logCounter = 0
function freshLogPath() {
  logCounter += 1
  return path.join(RUN_TMPDIR, `weekly-${logCounter}.log`)
}

// Drives the real script against real repos with the stub claude first on
// PATH. Deliberately does NOT touch the script's default (unset
// OPTIMISE_WEEKLY_REPOS) repo list -- that path is read-only production
// config and this suite never invokes it, since every call here supplies
// its own repos. `env` allows a test to override OPTIMISE_WEEKLY_REPOS
// with a raw (non-array-joined) string, for the whitespace/empty-array
// edge cases (Group 8), and to layer an extra PATH entry ahead of the
// shared stub (Group 8's start_epoch test, which needs its own `date`
// stub without disturbing every other test's).
function runWeeklyScript(repos, opts = {}) {
  const log = freshLogPath()
  const extraPath = opts.extraPath ? `${opts.extraPath}:` : ''
  const env = {
    ...process.env,
    PATH: `${extraPath}${STUB_DIR}:${process.env.PATH}`,
    OPTIMISE_WEEKLY_LOG: log,
  }
  if (opts.rawRepos !== undefined) {
    env.OPTIMISE_WEEKLY_REPOS = opts.rawRepos
  } else {
    env.OPTIMISE_WEEKLY_REPOS = repos.join('\n')
  }
  const res = spawnSync(SCRIPT_PATH, [], { encoding: 'utf8', timeout: 20000, env })
  const logContents = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : ''
  return { ...res, log, logContents }
}

// Extracts the per-run nonce from the header line every run writes first
// (Group 3). Every genuine RESULT/SKIP line this script writes carries the
// same nonce; nothing the model prints ever can, since the nonce is never
// passed into its prompt.
function extractNonce(logContents) {
  const m = logContents.match(/weekly optimise-cycle starting run=([0-9a-fA-F]+)/)
  assert.ok(m, `could not find the run header / nonce in the log:\n${logContents}`)
  return m[1]
}

function trustedResultRegex(nonce, verdict, repoLabel) {
  return new RegExp(`RESULT ${verdict} run=${nonce} ${escapeRegExp(repoLabel)}(?:\\s|$)`)
}

test('weekly runner: healthy run -- report written fresh during the run -- PASS, exit 0', () => {
  const repo = makeTempRepo()
  setMarker(repo, 'pass')
  const { status, logContents } = runWeeklyScript([repo])
  assert.equal(status, 0, logContents)
  const nonce = extractNonce(logContents)
  assert.match(logContents, trustedResultRegex(nonce, 'PASS', label(repo)), logContents)
})

test('weekly runner: a report that already exists with an OLD mtime and is NOT rewritten this run -- FAIL (the shape a status-only check cannot see at all)', () => {
  const repo = makeTempRepo()
  fs.mkdirSync(path.join(repo, '.claude'), { recursive: true })
  const reportPath = path.join(repo, REPORT_REL)
  const staleContent = '# Delivery optimiser report\n\nRepos: fixture\n\n## Sample completeness\nold but otherwise well-formed\n'
  fs.writeFileSync(reportPath, staleContent)
  // Group 1 (M11): aged to exactly what README.md's "a leftover report
  // from a previous week" claim actually describes -- a WEEK old, not the
  // old six-year-old fixture that only proved a six-year-old report is
  // caught (back-dating start_epoch by a week shipped green against it).
  const oldTime = new Date(Date.now() - 7 * 24 * 3600 * 1000)
  fs.utimesSync(reportPath, oldTime, oldTime)
  // The stub does nothing this run -- the report is left byte-for-byte as
  // a previous week would have left it. Non-empty, present, well-formed:
  // the ONLY thing wrong with it is that it predates this run.
  setMarker(repo, 'noop')
  const { status, logContents } = runWeeklyScript([repo])
  assert.notEqual(status, 0, logContents)
  const nonce = extractNonce(logContents)
  assert.match(logContents, trustedResultRegex(nonce, 'FAIL', label(repo)), logContents)
  assert.match(logContents, /stale/i, 'the FAIL reason must name staleness, not some other cause')
  assert.equal(fs.readFileSync(reportPath, 'utf8'), staleContent, 'sanity: the stub really left the report untouched')
})

test('weekly runner: stub produces no report at all -- FAIL', () => {
  const repo = makeTempRepo()
  setMarker(repo, 'noop')
  const { status, logContents } = runWeeklyScript([repo])
  assert.notEqual(status, 0, logContents)
  const nonce = extractNonce(logContents)
  assert.match(logContents, trustedResultRegex(nonce, 'FAIL', label(repo)), logContents)
  assert.match(logContents, /missing/i)
  assert.ok(!fs.existsSync(path.join(repo, REPORT_REL)))
})

test('weekly runner: report file created but zero-length -- FAIL', () => {
  const repo = makeTempRepo()
  setMarker(repo, 'empty')
  const { status, logContents } = runWeeklyScript([repo])
  assert.notEqual(status, 0, logContents)
  const nonce = extractNonce(logContents)
  assert.match(logContents, trustedResultRegex(nonce, 'FAIL', label(repo)), logContents)
  assert.match(logContents, /empty/i)
})

test('weekly runner: stub exits non-zero -- FAIL, even though it left a report that looks otherwise fine', () => {
  const repo = makeTempRepo()
  setMarker(repo, 'fail-with-report')
  const { status, logContents } = runWeeklyScript([repo])
  assert.notEqual(status, 0, logContents)
  const nonce = extractNonce(logContents)
  assert.match(logContents, trustedResultRegex(nonce, 'FAIL', label(repo)), logContents)
  assert.match(logContents, /exited 3/, 'the FAIL reason must name the non-zero exit, not the report shape')
  const reportPath = path.join(repo, REPORT_REL)
  assert.ok(fs.existsSync(reportPath) && fs.statSync(reportPath).size > 0, 'sanity: the report itself is fine -- exit code alone must be what fails this')
})

test('weekly runner: stub exits 0 and prints nothing on stdout (the exact CouchPotato shape), while a fresh valid report IS written -- PASS, because the verdict comes from the artefact, not the reply', () => {
  const repo = makeTempRepo()
  setMarker(repo, 'silent-pass')
  const { status, logContents } = runWeeklyScript([repo])
  assert.equal(status, 0, logContents)
  const nonce = extractNonce(logContents)
  assert.match(logContents, trustedResultRegex(nonce, 'PASS', label(repo)), logContents)
})

test('weekly runner: one repo passing and one failing -- overall exit non-zero, BOTH verdicts present in the log', () => {
  const repoPass = makeTempRepo()
  const repoFail = makeTempRepo()
  setMarker(repoPass, 'pass')
  setMarker(repoFail, 'noop')
  const { status, logContents } = runWeeklyScript([repoPass, repoFail])
  assert.notEqual(status, 0, logContents)
  const nonce = extractNonce(logContents)
  assert.match(logContents, trustedResultRegex(nonce, 'PASS', label(repoPass)), logContents)
  assert.match(logContents, trustedResultRegex(nonce, 'FAIL', label(repoFail)), logContents)
})

test('weekly runner: a directory that is not a git repo is skipped, not failed, and the stub is never invoked for it (witnessed, not just asserted by name)', () => {
  const notARepo = fs.mkdtempSync(path.join(RUN_TMPDIR, 'not-a-repo-'))
  const { status, logContents } = runWeeklyScript([notARepo])
  assert.equal(status, 0, logContents)
  const nonce = extractNonce(logContents)
  assert.match(logContents, new RegExp(`SKIP ${escapeRegExp(label(notARepo))} \\(not a git repo\\) run=${nonce}`), logContents)
  assert.ok(!logContents.includes('RESULT'), 'a skipped, non-git directory must never produce a PASS/FAIL verdict line')
  assert.ok(!fs.existsSync(path.join(notARepo, WITNESS_REL)), 'witness: the stub must genuinely never have run for a skipped directory')
})

// --- Group 2: vanished repo / worktree fails open -------------------------

test('weekly runner (Group 2): a configured repo path that does NOT exist on disk is a configuration FAIL, not a silent SKIP -- exit non-zero, and the stub is never invoked', () => {
  const goneRepo = path.join(RUN_TMPDIR, 'this-path-was-never-created')
  assert.ok(!fs.existsSync(goneRepo), 'sanity: the path must genuinely not exist')
  const { status, logContents } = runWeeklyScript([goneRepo])
  assert.notEqual(status, 0, logContents)
  const nonce = extractNonce(logContents)
  assert.match(logContents, trustedResultRegex(nonce, 'FAIL', label(goneRepo)), logContents)
  assert.match(logContents, /does not exist/i, logContents)
  assert.ok(!logContents.includes('SKIP'), 'a vanished path must never read as a deliberate SKIP')
  assert.ok(!fs.existsSync(path.join(goneRepo, WITNESS_REL)), 'witness: the stub must never run against a path that does not exist')
})

test('weekly runner (Group 2): a linked git WORKTREE is processed normally, not skipped as "not a git repo" -- its .git is a FILE, and worktrees are this harness\'s normal execution mode', () => {
  const main = makeTempRepo()
  const worktreePath = path.join(RUN_TMPDIR, `worktree-${path.basename(main)}`)
  sh(`git worktree add ${JSON.stringify(worktreePath)} -b ${JSON.stringify(`wt-${path.basename(main)}`)}`, main)
  trackTempDir(worktreePath)
  assert.ok(fs.statSync(path.join(worktreePath, '.git')).isFile(), 'sanity: a linked worktree\'s .git must be a FILE, not a directory')
  setMarker(worktreePath, 'pass')
  const { status, logContents } = runWeeklyScript([worktreePath])
  assert.equal(status, 0, logContents)
  const nonce = extractNonce(logContents)
  assert.match(logContents, trustedResultRegex(nonce, 'PASS', label(worktreePath)), logContents)
  assert.ok(!logContents.includes(`SKIP ${label(worktreePath)}`), 'a worktree must never be skipped as "not a git repo"')
})

// --- Group 1: the test blind spot D1 was meant to close -------------------

test('weekly runner (Group 1): confident success language on stdout with NO report written at all -- FAIL, not fooled by "Report written to ... -- N ranked proposals."', () => {
  const repo = makeTempRepo()
  setMarker(repo, 'chatty-no-report')
  const { status, logContents } = runWeeklyScript([repo])
  assert.match(logContents, new RegExp(escapeRegExp(CHATTY_SUCCESS_LINE)), 'sanity: the stub must actually have emitted the success language this test exists to distrust')
  assert.notEqual(status, 0, logContents)
  const nonce = extractNonce(logContents)
  assert.match(logContents, trustedResultRegex(nonce, 'FAIL', label(repo)), logContents)
  assert.match(logContents, /missing/i)
  assert.ok(!fs.existsSync(path.join(repo, REPORT_REL)))
})

test('weekly runner (Group 1): confident success language while the on-disk report is STALE (left over, not rewritten this run) -- FAIL, the language must not override the mtime check', () => {
  const repo = makeTempRepo()
  fs.mkdirSync(path.join(repo, '.claude'), { recursive: true })
  const reportPath = path.join(repo, REPORT_REL)
  fs.writeFileSync(reportPath, VALID_REPORT)
  const oldTime = new Date(Date.now() - 7 * 24 * 3600 * 1000)
  fs.utimesSync(reportPath, oldTime, oldTime)
  setMarker(repo, 'chatty-stale')
  const { status, logContents } = runWeeklyScript([repo])
  assert.match(logContents, new RegExp(escapeRegExp(CHATTY_SUCCESS_LINE)), 'sanity: the stub must actually have emitted the success language this test exists to distrust')
  assert.notEqual(status, 0, logContents)
  const nonce = extractNonce(logContents)
  assert.match(logContents, trustedResultRegex(nonce, 'FAIL', label(repo)), logContents)
  assert.match(logContents, /stale/i)
})

test('weekly runner (Group 1, M5): a "report" that is plain error text with no markdown heading -- FAIL, names the missing heading', () => {
  const repo = makeTempRepo()
  setMarker(repo, 'error-text')
  const { status, logContents } = runWeeklyScript([repo])
  assert.match(fs.readFileSync(path.join(repo, REPORT_REL), 'utf8'), /Traceback/, 'sanity: the stub really wrote error text, not a report')
  assert.notEqual(status, 0, logContents)
  const nonce = extractNonce(logContents)
  assert.match(logContents, trustedResultRegex(nonce, 'FAIL', label(repo)), logContents)
  assert.match(logContents, /does not start with a markdown heading/i, logContents)
})

test('weekly runner (Group 1, M6): a "report" with an H1 heading but NO section heading -- FAIL, names the missing section', () => {
  const repo = makeTempRepo()
  setMarker(repo, 'heading-no-sections')
  const { status, logContents } = runWeeklyScript([repo])
  assert.match(fs.readFileSync(path.join(repo, REPORT_REL), 'utf8'), /Some prose with no section heading/, 'sanity: the stub really wrote a headed but sectionless report')
  assert.notEqual(status, 0, logContents)
  const nonce = extractNonce(logContents)
  assert.match(logContents, trustedResultRegex(nonce, 'FAIL', label(repo)), logContents)
  assert.match(logContents, /no section heading/i, logContents)
})

// --- Group 3: the model can forge the script's own verdict line -----------

test('weekly runner (Group 3): a stub that prints a forged "RESULT PASS" line cannot be mistaken for the real verdict -- the real (FAIL) verdict carries this run\'s nonce, the forged line does not', () => {
  const repo = makeTempRepo()
  setMarker(repo, 'forge')
  const { status, logContents } = runWeeklyScript([repo])
  // Sanity: the forgery attempt genuinely landed in the log.
  assert.match(logContents, /RESULT PASS run=deadbeefdeadbeef/, 'sanity: the forged line must actually appear in the log')
  // The real verdict is FAIL (the stub never wrote a report) and carries
  // THIS run's real nonce.
  assert.notEqual(status, 0, logContents)
  const nonce = extractNonce(logContents)
  assert.notEqual(nonce, 'deadbeefdeadbeef', 'sanity: the forged nonce must not collide with a real one')
  assert.match(logContents, trustedResultRegex(nonce, 'FAIL', label(repo)), logContents)
  // A consumer trusting only nonce-carrying lines never sees a PASS for
  // this repo, even though the untrusted text "RESULT PASS" is present.
  assert.doesNotMatch(logContents, trustedResultRegex(nonce, 'PASS', label(repo)), 'the forged PASS must not carry the real run\'s nonce')
})

// --- Group 5: the runner must be read-only w.r.t. the analysed repo -------

test('weekly runner (Group 5): a file under .claude/ OTHER than the report is touched during the run -- FAIL, even though the report itself is fine', () => {
  const repo = makeTempRepo()
  setMarker(repo, 'stray-mutation')
  const { status, logContents } = runWeeklyScript([repo])
  assert.notEqual(status, 0, logContents)
  const nonce = extractNonce(logContents)
  assert.match(logContents, trustedResultRegex(nonce, 'FAIL', label(repo)), logContents)
  assert.match(logContents, /mutated during this run/i, logContents)
  assert.match(logContents, /active-plan/, logContents)
})

test('weekly runner (Group 5): a file under .claude/ that PRE-DATES the run is not flagged -- only files touched DURING this run trip the postcondition', () => {
  const repo = makeTempRepo()
  fs.mkdirSync(path.join(repo, '.claude'), { recursive: true })
  const preexisting = path.join(repo, '.claude', 'active-plan')
  fs.writeFileSync(preexisting, 'pre-existing, untouched by this run\n')
  const oldTime = new Date(Date.now() - 3600 * 1000)
  fs.utimesSync(preexisting, oldTime, oldTime)
  setMarker(repo, 'pass')
  const { status, logContents } = runWeeklyScript([repo])
  assert.equal(status, 0, logContents)
  const nonce = extractNonce(logContents)
  assert.match(logContents, trustedResultRegex(nonce, 'PASS', label(repo)), logContents)
})

// --- Group 6: the real timeout is ~600s, not 3600 --------------------------

test('weekly runner (Group 6): the transcript shows the background-wait ceiling was hit -- FAIL names the ceiling as the cause, not only the resulting missing report', () => {
  const repo = makeTempRepo()
  setMarker(repo, 'ceiling-hit')
  const { status, logContents } = runWeeklyScript([repo])
  assert.match(logContents, /CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS/, 'sanity: the stub must actually have emitted the ceiling message')
  assert.notEqual(status, 0, logContents)
  const nonce = extractNonce(logContents)
  assert.match(logContents, trustedResultRegex(nonce, 'FAIL', label(repo)), logContents)
  assert.match(logContents, /ceiling/i, logContents)
})

test('weekly runner (Group 6): CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS is exported to a stated, non-default value before claude is invoked', () => {
  const repo = makeTempRepo()
  setMarker(repo, 'pass')
  const printerDir = fs.mkdtempSync(path.join(RUN_TMPDIR, 'ceiling-printer-'))
  trackTempDir(printerDir)
  // Wrap the stub: a tiny shim that records CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS
  // then execs through to the real stub, so this test still gets a PASS
  // verdict via the normal marker mechanism.
  const shim = `#!/bin/sh\nprintf '%s' "$CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS" > ${JSON.stringify(path.join(printerDir, 'ceiling.txt'))}\nexec ${JSON.stringify(path.join(STUB_DIR, 'claude'))} "$@"\n`
  fs.writeFileSync(path.join(printerDir, 'claude'), shim, { mode: 0o755 })
  const { status, logContents } = runWeeklyScript([repo], { extraPath: printerDir })
  assert.equal(status, 0, logContents)
  const recorded = fs.readFileSync(path.join(printerDir, 'ceiling.txt'), 'utf8')
  assert.match(recorded, /^[0-9]+$/, `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS must be set to a numeric value, got ${JSON.stringify(recorded)}`)
  assert.ok(Number(recorded) > 0, 'the ceiling must be a real, positive budget, stated rather than left unset')
})

// --- Group 7: log hygiene --------------------------------------------------

test('weekly runner (Group 7): the model\'s transcript is redacted before landing in the log -- an absolute path the stub echoes back is never present verbatim', () => {
  const repo = makeTempRepo()
  const echoDir = fs.mkdtempSync(path.join(RUN_TMPDIR, 'echo-claude-'))
  trackTempDir(echoDir)
  const shim = `#!/bin/sh\necho "Report written to ${repo}/${REPORT_REL} -- 1 ranked proposal."\nmkdir -p .claude\ncat > ${JSON.stringify(REPORT_REL)} <<'REPORTEOF'\n${VALID_REPORT}REPORTEOF\nexit 0\n`
  fs.writeFileSync(path.join(echoDir, 'claude'), shim, { mode: 0o755 })
  const { status, logContents } = runWeeklyScript([repo], { extraPath: echoDir })
  assert.equal(status, 0, logContents)
  assert.ok(!logContents.includes(repo), `the log must never contain the repo's raw absolute path -- found it in:\n${logContents}`)
  assert.ok(!/\/Volumes\/|\/Users\//.test(logContents) || repo.startsWith('/private'), 'no absolute filesystem path prefix should survive redaction')
  // The relative report path stays legible -- redaction relativises paths
  // inside the analysed repo rather than blanking them.
  assert.match(logContents, /ranked proposal/i, logContents)
})

// --- Group 8: small, cheap fixes -------------------------------------------

test('weekly runner (Group 8): an empty REPOS array (all-whitespace OPTIMISE_WEEKLY_REPOS) does not crash under bash 3.2 + set -u -- clean start/done with no RESULT or SKIP lines', () => {
  const { status, logContents, stderr } = runWeeklyScript([], { rawRepos: '   \n\n\t \n' })
  assert.equal(status, 0, logContents + stderr)
  assert.ok(!/unbound variable/.test(stderr || ''), `must not hit bash's unbound-variable error:\n${stderr}`)
  assert.match(logContents, /weekly optimise-cycle starting/, logContents)
  assert.match(logContents, /=== done/, logContents)
  assert.ok(!logContents.includes('RESULT'), 'an empty repo list must produce no verdict lines')
  assert.ok(!logContents.includes('SKIP'), 'an empty repo list must produce no skip lines')
})

test('weekly runner (Group 8): a whitespace-only line in OPTIMISE_WEEKLY_REPOS is trimmed away, not treated as a repo path of spaces', () => {
  const repo = makeTempRepo()
  setMarker(repo, 'pass')
  const { status, logContents } = runWeeklyScript([], { rawRepos: `${repo}\n   \n` })
  assert.equal(status, 0, logContents)
  const nonce = extractNonce(logContents)
  assert.match(logContents, trustedResultRegex(nonce, 'PASS', label(repo)), logContents)
  const resultCount = (logContents.match(/RESULT (PASS|FAIL)/g) || []).length
  const skipCount = (logContents.match(/SKIP /g) || []).length
  assert.equal(resultCount + skipCount, 1, `expected exactly one verdict/skip line, got:\n${logContents}`)
})

test('weekly runner (Group 8): a leading UTF-8 BOM on an otherwise well-formed report does not read as "no heading" -- PASS', () => {
  const repo = makeTempRepo()
  setMarker(repo, 'bom')
  const { status, logContents } = runWeeklyScript([repo])
  assert.equal(status, 0, logContents)
  const nonce = extractNonce(logContents)
  assert.match(logContents, trustedResultRegex(nonce, 'PASS', label(repo)), logContents)
})

test('weekly runner (Group 8): an invalid start_epoch (a `date +%s` failure) FAILS the repo instead of silently skipping the staleness check', () => {
  const repo = makeTempRepo()
  fs.mkdirSync(path.join(repo, '.claude'), { recursive: true })
  const reportPath = path.join(repo, REPORT_REL)
  const staleContent = VALID_REPORT
  fs.writeFileSync(reportPath, staleContent)
  const oldTime = new Date(Date.now() - 7 * 24 * 3600 * 1000)
  fs.utimesSync(reportPath, oldTime, oldTime)
  setMarker(repo, 'noop')
  const dateDir = fs.mkdtempSync(path.join(RUN_TMPDIR, 'bad-date-'))
  trackTempDir(dateDir)
  // Intercepts ONLY `date +%s` (the start_epoch capture); every other
  // `date` invocation (the UTC timestamp headers) falls through to the
  // real system date, so this test isolates exactly the one call this
  // guard is meant to cover.
  const dateShim = `#!/bin/sh\nif [ "$1" = "+%s" ]; then\n  echo ""\nelse\n  exec /bin/date "$@"\nfi\n`
  fs.writeFileSync(path.join(dateDir, 'date'), dateShim, { mode: 0o755 })
  const { status, logContents } = runWeeklyScript([repo], { extraPath: dateDir })
  assert.notEqual(status, 0, logContents)
  const nonce = extractNonce(logContents)
  assert.match(logContents, trustedResultRegex(nonce, 'FAIL', label(repo)), logContents)
  assert.match(logContents, /start_epoch|start time/i, logContents)
})
