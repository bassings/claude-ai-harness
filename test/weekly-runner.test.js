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
//   Group 6 -- the real per-repo budget is
//   CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS (~600s by default), not the outer
//   `timeout`; a run that hits it is named as the cause, not left to read
//   as an unexplained stale/missing report.
//   Group 8 -- start_epoch validated, empty REPOS array no longer crashes
//   bash 3.2's `set -u`, whitespace-only repo entries are trimmed away, a
//   leading UTF-8 BOM in the report no longer reads as "no heading", and
//   the "skipped, stub never invoked" test now has a witness file proving
//   the stub really never ran, not just a name claiming it.
//
// SUBTRACTION ROUND (T3 review round 2, circuit-breaker escalated and
// ruled -- specs/harn-opt-2.md conductor log ticks 46-48). Two round-1
// guards are DELETED here, along with the tests that covered them, because
// review round 2 proved neither can fail in the way it claimed to:
//   - The former Group 3 (per-run verdict NONCE) is gone -- the header
//     carrying `run=$NONCE` was written to the log BEFORE `claude -p` ran,
//     on a path the model can read, so a forger only had to grep its own
//     log for the genuine nonce. The "forged RESULT PASS" test and the
//     nonce-extraction helper it depended on are gone with it.
//   - The former part of Group 5 (the `<repo>/.claude/` postcondition
//     walk) is gone -- defeated by `touch`-back-dating, missed writes
//     outside `.claude/` entirely, missed every deletion, and against a
//     real delivery repo's 50,120-file `.claude/` it would have wedged the
//     job for tens of minutes after `claude` returned. Both Group-5 tests
//     ("a file under .claude/ ... is touched" and "... PRE-DATES the run
//     is not flagged") are gone with it -- there is nothing left to prove.
//     `--settings disableAllHooks` (Group 4/5's flags) stays: it is real
//     defence in depth against the one measured mutation source, just not
//     a general read-only guarantee, and nothing here claims otherwise.
// This round also FIXES what survived review round 2:
//   - The ceiling detector no longer false-positives on a transcript that
//     merely NAMES the ceiling variable (this repo's own README does); it
//     is anchored to the CLI's real message instead, and the FAIL reason
//     now carries that message rather than only the bare env var name.
//   - The ceiling is lowered to 1200s (was 1800s) and the outer `timeout`
//     value is proven, by direct observation of the real invocation (not
//     an unused env override), to always equal CEILING_S + 60.
//   - A run with any FAIL prints one line to stderr, so the plist's
//     already-wired StandardErrorPath channel turns non-empty exactly when
//     there is something to see.
//   - The default repo list moved out of this file's hardcoded content
//     into $HOME/.claude/optimise-weekly-repos (never tracked anywhere);
//     every test below explicitly isolates $HOME so none of them can ever
//     read the real operator's config file by accident (the same
//     read-vs-real-config incident class the ledger's own
//     HARNESS_LEDGER_READONLY exception exists to prevent).
//   - The internal start_epoch check inside verdict_repo (former Group 8
//     duplicate) is gone -- it could never fire, since the caller already
//     `continue`s past an invalid start_epoch before verdict_repo is ever
//     called. The surviving (reachable, caller-level) test is tightened to
//     assert its exact reason string, not a loose pattern either check
//     could have produced.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync, execFileSync } = require('node:child_process')
const { SUITE_TMPDIR, makeTempRepo, trackTempDir, cleanupTempRepos, sh } = require('./helpers/temp-repo.js')

const SCRIPT_PATH = path.join(__dirname, '..', 'bin', 'optimise-cycle-weekly.sh')
const REPORT_REL = path.join('.claude', 'optimise-cycle-report.md')

test.after(cleanupTempRepos)

// One tracked root for everything this file creates that isn't a
// makeTempRepo() repo (the claude stub, and the per-test log files),
// mirroring temp-repo.js's own isolation discipline (M4).
const RUN_TMPDIR = fs.mkdtempSync(path.join(SUITE_TMPDIR, 'weekly-run-'))
trackTempDir(RUN_TMPDIR)

// Subtraction round item 9: the script's default repo list now comes from
// $HOME/.claude/optimise-weekly-repos. Every test in this file runs with
// $HOME pointed at an empty, tracked temp directory containing no such
// file, so a test that (deliberately or not) leaves OPTIMISE_WEEKLY_REPOS
// unset can never read the real operator's own config file -- the same
// class of incident the ledger's own HARNESS_LEDGER_READONLY exception
// exists to prevent for the ledger writer.
const ISOLATED_HOME = fs.mkdtempSync(path.join(RUN_TMPDIR, 'isolated-home-'))
trackTempDir(ISOLATED_HOME)

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
// Anchored to the CLI's real message, taken verbatim from the real
// 2026-08-16 log line quoted in specs/harn-opt-2.md conductor log tick 40.
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
  mentions-ceiling-var-only)
    mkdir -p .claude
    cat > ${JSON.stringify(REPORT_REL)} <<'REPORTEOF'
${VALID_REPORT}REPORTEOF
    echo "See CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS in the README for details."
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
// its own repos AND its own isolated $HOME (subtraction round item 9). `env`
// allows a test to override OPTIMISE_WEEKLY_REPOS with a raw (non-array-
// joined) string, for the whitespace/empty-array edge cases (Group 8), and
// to layer an extra PATH entry ahead of the shared stub (Group 6's ceiling
// tests, which need their own `claude`/`timeout` shims without disturbing
// every other test's).
// HARN-FIX-3 task 2 (AC-OPS-1..5): a guaranteed-nonexistent path, shared by
// every call below that does not explicitly opt into a real staleness
// fixture via opts.stalenessRemote. `git clone` against it fails
// immediately -- no network, no delay -- so every PRE-EXISTING test in this
// file (which knows nothing about the staleness check and must not be
// slowed down or made flaky by it) gets a fast, deterministic
// "could-not-check" for free, exactly like ISOLATED_HOME already does for
// HOME below.
const NO_STALENESS_REMOTE = path.join(RUN_TMPDIR, 'no-such-staleness-remote')

function runWeeklyScript(repos, opts = {}) {
  const log = freshLogPath()
  const extraPath = opts.extraPath ? `${opts.extraPath}:` : ''
  const env = {
    ...process.env,
    PATH: `${extraPath}${STUB_DIR}:${process.env.PATH}`,
    OPTIMISE_WEEKLY_LOG: log,
    HOME: opts.home || ISOLATED_HOME,
    OPTIMISE_WEEKLY_STALENESS_REMOTE: opts.stalenessRemote || NO_STALENESS_REMOTE,
  }
  if (opts.claudeHome) {
    env.CLAUDE_HOME = opts.claudeHome
  } else {
    delete env.CLAUDE_HOME
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

function resultLineRegex(verdict, repoLabel) {
  return new RegExp(`RESULT ${verdict} ${escapeRegExp(repoLabel)}(?:\\s|$)`)
}

// Extracts just the one RESULT line for a given repo/verdict, so a reason
// assertion can be anchored to what the SCRIPT itself decided rather than
// matching anywhere in the whole log -- which would also match the stub's
// own unrelated chatter (Group 6's false-positive fix exists precisely
// because a loose whole-log match like this used to hide that bug).
function extractResultLine(logContents, verdict, repoLabel) {
  const re = new RegExp(`^RESULT ${verdict} ${escapeRegExp(repoLabel)}.*$`, 'm')
  const m = logContents.match(re)
  assert.ok(m, `could not find a RESULT ${verdict} line for ${repoLabel} in the log:\n${logContents}`)
  return m[0]
}

test('weekly runner: healthy run -- report written fresh during the run -- PASS, exit 0', () => {
  const repo = makeTempRepo()
  setMarker(repo, 'pass')
  const { status, logContents } = runWeeklyScript([repo])
  assert.equal(status, 0, logContents)
  assert.match(logContents, resultLineRegex('PASS', label(repo)), logContents)
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
  assert.match(logContents, resultLineRegex('FAIL', label(repo)), logContents)
  assert.match(logContents, /stale/i, 'the FAIL reason must name staleness, not some other cause')
  assert.equal(fs.readFileSync(reportPath, 'utf8'), staleContent, 'sanity: the stub really left the report untouched')
})

test('weekly runner: stub produces no report at all -- FAIL', () => {
  const repo = makeTempRepo()
  setMarker(repo, 'noop')
  const { status, logContents } = runWeeklyScript([repo])
  assert.notEqual(status, 0, logContents)
  assert.match(logContents, resultLineRegex('FAIL', label(repo)), logContents)
  assert.match(logContents, /missing/i)
  assert.ok(!fs.existsSync(path.join(repo, REPORT_REL)))
})

test('weekly runner: report file created but zero-length -- FAIL', () => {
  const repo = makeTempRepo()
  setMarker(repo, 'empty')
  const { status, logContents } = runWeeklyScript([repo])
  assert.notEqual(status, 0, logContents)
  assert.match(logContents, resultLineRegex('FAIL', label(repo)), logContents)
  assert.match(logContents, /empty/i)
})

test('weekly runner: stub exits non-zero -- FAIL, even though it left a report that looks otherwise fine', () => {
  const repo = makeTempRepo()
  setMarker(repo, 'fail-with-report')
  const { status, logContents } = runWeeklyScript([repo])
  assert.notEqual(status, 0, logContents)
  assert.match(logContents, resultLineRegex('FAIL', label(repo)), logContents)
  assert.match(logContents, /exited 3/, 'the FAIL reason must name the non-zero exit, not the report shape')
  const reportPath = path.join(repo, REPORT_REL)
  assert.ok(fs.existsSync(reportPath) && fs.statSync(reportPath).size > 0, 'sanity: the report itself is fine -- exit code alone must be what fails this')
})

test('weekly runner: stub exits 0 and prints nothing on stdout (the exact CouchPotato shape), while a fresh valid report IS written -- PASS, because the verdict comes from the artefact, not the reply', () => {
  const repo = makeTempRepo()
  setMarker(repo, 'silent-pass')
  const { status, logContents } = runWeeklyScript([repo])
  assert.equal(status, 0, logContents)
  assert.match(logContents, resultLineRegex('PASS', label(repo)), logContents)
})

test('weekly runner: one repo passing and one failing -- overall exit non-zero, BOTH verdicts present in the log', () => {
  const repoPass = makeTempRepo()
  const repoFail = makeTempRepo()
  setMarker(repoPass, 'pass')
  setMarker(repoFail, 'noop')
  const { status, logContents } = runWeeklyScript([repoPass, repoFail])
  assert.notEqual(status, 0, logContents)
  assert.match(logContents, resultLineRegex('PASS', label(repoPass)), logContents)
  assert.match(logContents, resultLineRegex('FAIL', label(repoFail)), logContents)
})

test('weekly runner: a directory that is not a git repo is skipped, not failed, and the stub is never invoked for it (witnessed, not just asserted by name)', () => {
  const notARepo = fs.mkdtempSync(path.join(RUN_TMPDIR, 'not-a-repo-'))
  const { status, logContents } = runWeeklyScript([notARepo])
  assert.equal(status, 0, logContents)
  assert.match(logContents, new RegExp(`SKIP ${escapeRegExp(label(notARepo))} \\(not a git repo\\)`), logContents)
  assert.ok(!logContents.includes('RESULT'), 'a skipped, non-git directory must never produce a PASS/FAIL verdict line')
  assert.ok(!fs.existsSync(path.join(notARepo, WITNESS_REL)), 'witness: the stub must genuinely never have run for a skipped directory')
})

// --- Group 2: vanished repo / worktree fails open -------------------------

test('weekly runner (Group 2): a configured repo path that does NOT exist on disk is a configuration FAIL, not a silent SKIP -- exit non-zero, and the stub is never invoked', () => {
  const goneRepo = path.join(RUN_TMPDIR, 'this-path-was-never-created')
  assert.ok(!fs.existsSync(goneRepo), 'sanity: the path must genuinely not exist')
  const { status, logContents } = runWeeklyScript([goneRepo])
  assert.notEqual(status, 0, logContents)
  assert.match(logContents, resultLineRegex('FAIL', label(goneRepo)), logContents)
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
  assert.match(logContents, resultLineRegex('PASS', label(worktreePath)), logContents)
  assert.ok(!logContents.includes(`SKIP ${label(worktreePath)}`), 'a worktree must never be skipped as "not a git repo"')
})

// --- Group 1: the test blind spot D1 was meant to close -------------------

test('weekly runner (Group 1): confident success language on stdout with NO report written at all -- FAIL, not fooled by "Report written to ... -- N ranked proposals."', () => {
  const repo = makeTempRepo()
  setMarker(repo, 'chatty-no-report')
  const { status, logContents } = runWeeklyScript([repo])
  assert.match(logContents, new RegExp(escapeRegExp(CHATTY_SUCCESS_LINE)), 'sanity: the stub must actually have emitted the success language this test exists to distrust')
  assert.notEqual(status, 0, logContents)
  assert.match(logContents, resultLineRegex('FAIL', label(repo)), logContents)
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
  assert.match(logContents, resultLineRegex('FAIL', label(repo)), logContents)
  assert.match(logContents, /stale/i)
})

test('weekly runner (Group 1, M5): a "report" that is plain error text with no markdown heading -- FAIL, names the missing heading', () => {
  const repo = makeTempRepo()
  setMarker(repo, 'error-text')
  const { status, logContents } = runWeeklyScript([repo])
  assert.match(fs.readFileSync(path.join(repo, REPORT_REL), 'utf8'), /Traceback/, 'sanity: the stub really wrote error text, not a report')
  assert.notEqual(status, 0, logContents)
  assert.match(logContents, resultLineRegex('FAIL', label(repo)), logContents)
  assert.match(logContents, /does not start with a markdown heading/i, logContents)
})

test('weekly runner (Group 1, M6): a "report" with an H1 heading but NO section heading -- FAIL, names the missing section', () => {
  const repo = makeTempRepo()
  setMarker(repo, 'heading-no-sections')
  const { status, logContents } = runWeeklyScript([repo])
  assert.match(fs.readFileSync(path.join(repo, REPORT_REL), 'utf8'), /Some prose with no section heading/, 'sanity: the stub really wrote a headed but sectionless report')
  assert.notEqual(status, 0, logContents)
  assert.match(logContents, resultLineRegex('FAIL', label(repo)), logContents)
  assert.match(logContents, /no section heading/i, logContents)
})

// --- Group 6: the real timeout is ~600s, not 3600 --------------------------

test('weekly runner (Group 6): the transcript shows the background-wait ceiling was hit -- FAIL names the ceiling as the cause, anchored to the CLI\'s real message rather than a bare mention of the env var name', () => {
  const repo = makeTempRepo()
  setMarker(repo, 'ceiling-hit')
  const { status, logContents } = runWeeklyScript([repo])
  assert.match(logContents, /Background tasks still running after \d+s; terminating/, 'sanity: the stub must actually have emitted the ceiling message')
  assert.notEqual(status, 0, logContents)
  const resultLine = extractResultLine(logContents, 'FAIL', label(repo))
  assert.match(resultLine, /background wait ceiling reached/i, resultLine)
  assert.match(resultLine, /Background tasks still running after \d+s; terminating/, resultLine)
})

// Subtraction round item 6 (tick 47 finding): the OLD detector greped for
// the bare variable NAME anywhere in the transcript, so a transcript that
// merely mentions it -- this repo's own README now does -- forced a FAIL
// on an otherwise perfectly good run. Fixed by anchoring to the CLI's real
// message; this test proves the false positive is gone, not just that the
// true positive above still fires (a detector could pass both by matching
// broadly AND narrowly at once -- this is the case that tells them apart).
test('weekly runner (subtraction round, item 6): a transcript that merely NAMES the ceiling variable in prose (not the CLI\'s real message) does not false-positive as a ceiling hit -- PASS, since the report is otherwise valid and fresh', () => {
  const repo = makeTempRepo()
  setMarker(repo, 'mentions-ceiling-var-only')
  const { status, logContents } = runWeeklyScript([repo])
  assert.match(logContents, /CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS/, 'sanity: the transcript really does mention the variable name')
  assert.equal(status, 0, logContents)
  assert.match(logContents, resultLineRegex('PASS', label(repo)), logContents)
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

// Subtraction round item 7: the ceiling was lowered to 1200s (was 1800s),
// and the outer `timeout` value must equal CEILING_S + 60 -- proven here by
// OBSERVING the real invocation directly (a `timeout` shim on PATH
// recording its own numeric argument), not by setting an env var the
// script never reads and trusting the arithmetic blind. Per the owner's
// own note on this plan, a test that overrides CEILING_MS via environment
// (the script hardcodes it, so such an override does nothing) would ship
// green regardless of whether the relationship actually holds -- this is
// exactly that trap, avoided.
test('weekly runner (subtraction round, item 7): the outer `timeout` value observed at the real invocation equals CEILING_S + 60, and the ceiling itself is 1200s', () => {
  const repo = makeTempRepo()
  setMarker(repo, 'pass')
  const printerDir = fs.mkdtempSync(path.join(RUN_TMPDIR, 'timeout-printer-'))
  trackTempDir(printerDir)
  const ceilingFile = path.join(printerDir, 'ceiling.txt')
  const timeoutArgFile = path.join(printerDir, 'timeout-arg.txt')
  const realTimeoutBin = execFileSync('/bin/sh', ['-c', 'command -v timeout'], { encoding: 'utf8' }).trim()
  assert.ok(realTimeoutBin, 'sanity: a real `timeout` binary must be resolvable on this machine to run this test')
  const claudeShim = `#!/bin/sh\nprintf '%s' "$CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS" > ${JSON.stringify(ceilingFile)}\nexec ${JSON.stringify(path.join(STUB_DIR, 'claude'))} "$@"\n`
  fs.writeFileSync(path.join(printerDir, 'claude'), claudeShim, { mode: 0o755 })
  // Records the seconds argument the script invokes `timeout` with
  // (`timeout -k 60 <seconds> claude ...`, so $3 is the value), then execs
  // straight through to the REAL binary (resolved above, outside
  // printerDir, so this shim cannot recursively invoke itself).
  const timeoutShim = `#!/bin/sh\nprintf '%s' "$3" > ${JSON.stringify(timeoutArgFile)}\nexec ${JSON.stringify(realTimeoutBin)} "$@"\n`
  fs.writeFileSync(path.join(printerDir, 'timeout'), timeoutShim, { mode: 0o755 })
  const { status, logContents } = runWeeklyScript([repo], { extraPath: printerDir })
  assert.equal(status, 0, logContents)
  const ceilingMs = Number(fs.readFileSync(ceilingFile, 'utf8'))
  const timeoutS = Number(fs.readFileSync(timeoutArgFile, 'utf8'))
  assert.ok(Number.isInteger(ceilingMs) && ceilingMs > 0, `ceiling must be a real positive value, got ${ceilingMs}`)
  assert.equal(ceilingMs, 1200000, 'the ceiling must be 1200s (1,200,000ms), per the subtraction round\'s lowered budget')
  assert.equal(timeoutS, ceilingMs / 1000 + 60, `outer timeout (${timeoutS}s) must equal CEILING_S + 60 (${ceilingMs / 1000 + 60}s)`)
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

// Subtraction round item 4: proves the SAME real leak (a backtick-wrapped
// absolute path -- Claude's default way of formatting one) that specs/
// harn-opt-2.md conductor log tick 46 found surviving redactPaths
// unchanged. Built from the REAL account username and a realistic
// home-shaped root, following this suite's existing home-like-root
// convention (see ledger-append.test.js), rather than hardcoding this
// machine's actual username or repo names into a public repo.
test('weekly runner (subtraction round, item 4): a backtick-wrapped absolute path in the model\'s transcript -- the real leak shape found in the archived 2026-08-16 log -- is redacted, not left verbatim', () => {
  const whoami = sh('whoami', RUN_TMPDIR).trim()
  const homeLikeRoot = path.join(RUN_TMPDIR, 'home', whoami, 'repo-' + Math.random().toString(36).slice(2))
  fs.mkdirSync(homeLikeRoot, { recursive: true })
  sh('git init -q', homeLikeRoot)
  trackTempDir(homeLikeRoot)
  const echoDir = fs.mkdtempSync(path.join(RUN_TMPDIR, 'backtick-claude-'))
  trackTempDir(echoDir)
  // The exact shape of the real leaked line: a backtick-quoted absolute
  // path immediately followed by an em dash and prose, with NO whitespace
  // between the opening backtick and the path -- the one shape
  // ABSOLUTE_PATH_RE's old prefix class (start-of-string, whitespace,
  // quote or paren) could not anchor on at all.
  const shim = `#!/bin/sh\necho "\\\`${homeLikeRoot}/${REPORT_REL}\\\` -- 3 ranked proposals."\nmkdir -p .claude\ncat > ${JSON.stringify(REPORT_REL)} <<'REPORTEOF'\n${VALID_REPORT}REPORTEOF\nexit 0\n`
  fs.writeFileSync(path.join(echoDir, 'claude'), shim, { mode: 0o755 })
  const { status, logContents } = runWeeklyScript([homeLikeRoot], { extraPath: echoDir })
  assert.equal(status, 0, logContents)
  assert.ok(!logContents.includes(homeLikeRoot), `the log must never contain the repo's raw absolute path -- found it in:\n${logContents}`)
  assert.ok(!logContents.includes(whoami), `the log must never contain the account name -- found it in:\n${logContents}`)
  assert.match(logContents, /ranked proposals/i, logContents)
})

// Subtraction round item 5 (specs/harn-opt-2.md conductor log tick 46):
// when redaction itself fails, the script must fall back to a labelled
// placeholder, never the raw transcript -- and the placeholder message
// itself must never leak $REDACT_SCRIPT's absolute account path, which
// review round 2 found it doing. Forces the fallback branch with a `node`
// shim that always fails, rather than renaming/removing the real
// bin/redact-transcript.mjs on disk, which every other test in this file
// (and a concurrently-running test file) might also depend on.
test('weekly runner (subtraction round, item 5): when the redaction step fails, the log carries the RELATIVE fallback placeholder (bin/redact-transcript.mjs), never $REDACT_SCRIPT\'s absolute path, and the raw unredacted transcript never reaches the log', () => {
  const repo = makeTempRepo()
  const echoDir = fs.mkdtempSync(path.join(RUN_TMPDIR, 'redact-fail-'))
  trackTempDir(echoDir)
  const RAW_MARKER = 'RAW-TRANSCRIPT-MARKER-should-never-reach-the-log'
  const shim = `#!/bin/sh\necho ${JSON.stringify(RAW_MARKER)}\nmkdir -p .claude\ncat > ${JSON.stringify(REPORT_REL)} <<'REPORTEOF'\n${VALID_REPORT}REPORTEOF\nexit 0\n`
  fs.writeFileSync(path.join(echoDir, 'claude'), shim, { mode: 0o755 })
  // Stands in for "the redaction step is unavailable or errors": `node`
  // always exits 1, so `node "$REDACT_SCRIPT" ... && ...` in the script
  // takes its `else` branch regardless of whether the real script file
  // exists.
  fs.writeFileSync(path.join(echoDir, 'node'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
  const { status, logContents } = runWeeklyScript([repo], { extraPath: echoDir })
  assert.equal(status, 0, logContents)
  assert.ok(!logContents.includes(RAW_MARKER), `the raw unredacted transcript must never reach the log when redaction fails:\n${logContents}`)
  assert.match(logContents, /transcript omitted: redaction step failed or is unavailable/, logContents)
  assert.match(logContents, /bin\/redact-transcript\.mjs/, 'the fallback message must name the script by its relative path')
  assert.ok(!/\/Users\/|\/Volumes\/|\/home\//.test(logContents), 'the fallback message must never leak an absolute account path via $REDACT_SCRIPT')
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
  assert.match(logContents, resultLineRegex('PASS', label(repo)), logContents)
  const resultCount = (logContents.match(/RESULT (PASS|FAIL)/g) || []).length
  const skipCount = (logContents.match(/SKIP /g) || []).length
  assert.equal(resultCount + skipCount, 1, `expected exactly one verdict/skip line, got:\n${logContents}`)
})

test('weekly runner (Group 8): a leading UTF-8 BOM on an otherwise well-formed report does not read as "no heading" -- PASS', () => {
  const repo = makeTempRepo()
  setMarker(repo, 'bom')
  const { status, logContents } = runWeeklyScript([repo])
  assert.equal(status, 0, logContents)
  assert.match(logContents, resultLineRegex('PASS', label(repo)), logContents)
})

// Subtraction round item 10: the guard duplicated INSIDE verdict_repo is
// now deleted as unreachable (the caller at the script's own start_epoch
// capture already `continue`s past an invalid one before verdict_repo is
// ever invoked), so this is tightened to the exact reason string the ONE
// remaining, reachable check produces -- previously a loose
// /start_epoch|start time/i pattern that either check could have matched,
// which could not tell "the reachable check fired" from "the dead one
// somehow did".
test('weekly runner (Group 8, tightened per subtraction round item 10): an invalid start_epoch (a `date +%s` failure) FAILS the repo with the caller-level reason -- the only check that can ever actually run', () => {
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
  assert.match(logContents, resultLineRegex('FAIL', label(repo)), logContents)
  assert.match(logContents, /could not capture a valid run start time \(start_epoch\)/, logContents)
})

// --- Group 7: drift marker --------------------------------------------------

test('weekly runner (Group 7): the run header names a script version, so the log shows which copy of the script actually ran (drift detection)', () => {
  const repo = makeTempRepo()
  setMarker(repo, 'pass')
  const { status, logContents } = runWeeklyScript([repo])
  assert.equal(status, 0, logContents)
  const header = logContents.split('\n')[0]
  assert.match(header, /version=\S+/, `the starting header must carry a version= marker:\n${header}`)
})

// --- Subtraction round item 8: audible failure on stderr -------------------

test('weekly runner (subtraction round, item 8): a run with any FAIL prints one line to stderr naming the log path, so the plist\'s already-wired StandardErrorPath channel (0 bytes since 11 Aug) turns non-empty exactly when there is something to see', () => {
  const repo = makeTempRepo()
  setMarker(repo, 'noop')
  const { status, stderr, log, logContents } = runWeeklyScript([repo])
  assert.notEqual(status, 0, logContents)
  assert.match(stderr || '', /weekly optimise-cycle FAILED/, `expected a FAILED line on stderr, got:\n${stderr}`)
  assert.ok((stderr || '').includes(log), 'the stderr line should name the log file an operator should read')
})

test('weekly runner (subtraction round, item 8): a fully passing run prints nothing to stderr', () => {
  const repo = makeTempRepo()
  setMarker(repo, 'pass')
  const { status, stderr, logContents } = runWeeklyScript([repo])
  assert.equal(status, 0, logContents)
  assert.equal((stderr || '').trim(), '', `expected empty stderr on a clean pass, got:\n${stderr}`)
})

// --- Subtraction round item 9: repo list from operator config, not hardcoded here

test('weekly runner (subtraction round, item 9): the default repo list is read from $HOME/.claude/optimise-weekly-repos (one path per line), not hardcoded in this public repo, when OPTIMISE_WEEKLY_REPOS is unset', () => {
  const repo = makeTempRepo()
  setMarker(repo, 'pass')
  const fakeHome = fs.mkdtempSync(path.join(RUN_TMPDIR, 'fake-home-'))
  trackTempDir(fakeHome)
  fs.mkdirSync(path.join(fakeHome, '.claude'), { recursive: true })
  // Blank lines mixed in must be ignored, same discipline as the
  // OPTIMISE_WEEKLY_REPOS test-seam parsing above (Group 8).
  fs.writeFileSync(path.join(fakeHome, '.claude', 'optimise-weekly-repos'), `\n${repo}\n   \n`)
  const log = freshLogPath()
  const env = {
    ...process.env,
    PATH: `${STUB_DIR}:${process.env.PATH}`,
    OPTIMISE_WEEKLY_LOG: log,
    HOME: fakeHome,
    OPTIMISE_WEEKLY_STALENESS_REMOTE: NO_STALENESS_REMOTE,
  }
  delete env.OPTIMISE_WEEKLY_REPOS
  delete env.CLAUDE_HOME
  const res = spawnSync(SCRIPT_PATH, [], { encoding: 'utf8', timeout: 20000, env })
  const logContents = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : ''
  assert.equal(res.status, 0, logContents)
  assert.match(logContents, resultLineRegex('PASS', label(repo)), logContents)
  const resultCount = (logContents.match(/RESULT (PASS|FAIL)/g) || []).length
  assert.equal(resultCount, 1, `expected exactly one verdict line (blank config lines ignored), got:\n${logContents}`)
})

test('weekly runner (subtraction round, item 9): no $HOME/.claude/optimise-weekly-repos file and no OPTIMISE_WEEKLY_REPOS -- clean start/done with no RESULT or SKIP lines, exit 0 (a missing config file is not a crash)', () => {
  const fakeHome = fs.mkdtempSync(path.join(RUN_TMPDIR, 'fake-home-empty-'))
  trackTempDir(fakeHome)
  const log = freshLogPath()
  const env = {
    ...process.env,
    PATH: `${STUB_DIR}:${process.env.PATH}`,
    OPTIMISE_WEEKLY_LOG: log,
    HOME: fakeHome,
    OPTIMISE_WEEKLY_STALENESS_REMOTE: NO_STALENESS_REMOTE,
  }
  delete env.OPTIMISE_WEEKLY_REPOS
  delete env.CLAUDE_HOME
  const res = spawnSync(SCRIPT_PATH, [], { encoding: 'utf8', timeout: 20000, env })
  const logContents = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : ''
  assert.equal(res.status, 0, logContents)
  assert.ok(!logContents.includes('RESULT'), 'no config file must produce no verdict lines')
  assert.ok(!logContents.includes('SKIP'), 'no config file must produce no skip lines')
})

// Found by this repo's FIRST EVER CI run, on both node versions, in a script
// that had only ever executed on macOS.
//
// `stat -f %m` is BSD's "format" flag. On GNU/Linux `-f` means "file system
// status": it SUCCEEDS, exit 0, printing a block of filesystem information.
// The old form was `stat -f %m ... || stat -c %Y ...`, so the `||` fallback
// never ran, `[ "$mtime" -lt "$start_epoch" ]` failed with "integer
// expression expected", and that block went to stderr on every clean pass --
// tripping the "a fully passing run prints nothing to stderr" guarantee.
//
// A fallback chained on EXIT STATUS cannot protect against a command that
// succeeds with the wrong OUTPUT. That is the defect, and it is why the fix
// validates the shape of the result rather than trusting `||`.
//
// This test does not depend on the platform it runs on: it puts a stub `stat`
// on PATH that behaves like GNU's (accepts -f, exits 0, prints a filesystem
// block; accepts -c %Y, prints an epoch), so a regression to BSD-first is
// caught on macOS too, where the real bug is invisible.
test('weekly runner: a GNU-behaving stat (where -f SUCCEEDS with filesystem info) does not leak that block to stderr -- the mtime read validates its result rather than chaining on exit status', () => {
  const stubDir = fs.mkdtempSync(path.join(RUN_TMPDIR, 'gnustat-'))
  try {
    const stub = path.join(stubDir, 'stat')
    fs.writeFileSync(
      stub,
      [
        '#!/bin/sh',
        '# Emulates GNU stat: -f is "file system status" and SUCCEEDS.',
        'case "$1" in',
        '  -f) echo "  File: \\"$2\\""; echo "    ID: deadbeef Namelen: 255 Type: ext2/ext3"; exit 0 ;;',
        '  -c) shift; fmt="$1"; shift; if [ "$fmt" = "%Y" ]; then date +%s; exit 0; fi; exit 1 ;;',
        'esac',
        'exit 1',
      ].join('\n') + '\n'
    )
    fs.chmodSync(stub, 0o755)

    const repo = makeTempRepo()
    setMarker(repo, 'pass')
    const res = runWeeklyScript([repo], { extraPath: stubDir })

    // Without a clean pass the mtime branch is never reached and this test
    // measures nothing -- it silently passed for that reason on first write.
    assert.equal(res.status, 0, `expected a clean pass so the mtime branch executes; log:\n${res.logContents}`)

    assert.ok(
      !/integer expression expected/.test(res.stderr),
      `the mtime read must not feed non-numeric output into a numeric comparison; stderr was:\n${res.stderr}`
    )
    assert.ok(
      !/Namelen|Block size|filesystem/i.test(res.stderr),
      `filesystem information must never reach stderr; stderr was:\n${res.stderr}`
    )
  } finally {
    fs.rmSync(stubDir, { recursive: true, force: true })
  }
})

// ============================================================================
// HARN-FIX-3 task 2 of 2: the consumer-install staleness check
// (AC-OPS-1..5, AC-ARCH-2). See workflows/lib/install-consistency.mjs's
// CONSUMER_SUBSET_PATTERNS/checkStaleness for the comparison logic itself
// (unit-tested there directly); this file proves the BASH plumbing around
// it -- once-per-invocation placement, never writing to the install, the
// no-network path, and the header/report stamp -- by driving the real
// script end to end, the same discipline every test above already uses.
// ============================================================================

// A real git repo (makeTempRepo() already seeds README.md + an initial
// commit) populated with one file per AC-OPS-4 pattern shape, then
// committed -- this stands in for "published main" as the staleness
// check's --depth 1 clone source. Entirely local and offline: git clones a
// local path with no network involved, so these tests never depend on
// real connectivity or the real GitHub repo.
function makePublishedRepo(overrides = {}) {
  const repo = makeTempRepo()
  const files = {
    'AGENT-HARNESS.md': 'harness contract\n',
    'agents/lens-security.md': 'lens security\n',
    'workflows/plan-cycle.js': 'plan cycle\n',
    'workflows/review-cycle.js': 'review cycle\n',
    'workflows/lib/install-consistency.mjs': 'the lib file itself\n',
    'hooks/hooks.json': '{}\n',
    'skills/optimise-cycle/SKILL.md': 'optimise-cycle skill\n',
    ...overrides,
  }
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(repo, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, content)
  }
  sh('git add -A && git commit -q -m "consumer subset files"', repo)
  return repo
}

// A plain (non-git) directory standing in for $CLAUDE_HOME -- the
// staleness check only ever reads it, never expects it to be a repo.
function makeInstallDir(files) {
  const dir = fs.mkdtempSync(path.join(RUN_TMPDIR, 'install-'))
  trackTempDir(dir)
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, content)
  }
  return dir
}

function identicalInstallOf(publishedRepoDir) {
  const files = {}
  for (const rel of ['AGENT-HARNESS.md', 'agents/lens-security.md', 'workflows/plan-cycle.js', 'workflows/review-cycle.js', 'workflows/lib/install-consistency.mjs', 'hooks/hooks.json', 'skills/optimise-cycle/SKILL.md']) {
    files[rel] = fs.readFileSync(path.join(publishedRepoDir, rel), 'utf8')
  }
  return makeInstallDir(files)
}

function hashInstallTree(dir) {
  return fs
    .readdirSync(dir, { recursive: true })
    .sort()
    .map((f) => {
      const p = path.join(dir, f)
      return fs.statSync(p).isFile() ? `${f}:${fs.readFileSync(p, 'utf8')}` : `${f}/`
    })
}

test('weekly runner (AC-OPS-4): an identical install reports no drift -- STALENESS ok, drift:[]', () => {
  const published = makePublishedRepo()
  const install = identicalInstallOf(published)
  const repo = makeTempRepo()
  setMarker(repo, 'pass')
  const { status, logContents } = runWeeklyScript([repo], { stalenessRemote: published, claudeHome: install })
  assert.equal(status, 0, logContents)
  assert.match(logContents, /STALENESS ok /, logContents)
  const line = logContents.match(/^STALENESS ok .*$/m)[0]
  const json = JSON.parse(line.slice(line.indexOf('{')))
  assert.equal(json.ok, true)
  assert.deepEqual(json.drift, [])
})

test('weekly runner (AC-OPS-1/AC-OPS-4): a fixture install with one modified file produces exactly one drift report naming that file, regardless of how many delivery repos are configured', () => {
  const published = makePublishedRepo()
  const install = identicalInstallOf(published)
  fs.writeFileSync(path.join(install, 'agents', 'lens-security.md'), 'a stale, locally-edited copy\n')
  const repoA = makeTempRepo()
  const repoB = makeTempRepo()
  setMarker(repoA, 'pass')
  setMarker(repoB, 'pass')
  const { status, logContents } = runWeeklyScript([repoA, repoB], { stalenessRemote: published, claudeHome: install })
  assert.equal(status, 0, logContents)
  const stalenessLines = logContents.match(/^STALENESS /gm) || []
  assert.equal(stalenessLines.length, 1, `AC-OPS-1: expected exactly ONE staleness report regardless of REPOS count (2 here), got ${stalenessLines.length}:\n${logContents}`)
  // Coordinator ruling 2026-08-23: a drifted result must use the "drift"
  // status token, never "ok" -- "ok" collapsed the clean and drifted cases
  // into the same human-scannable prefix, which is the defect this fix
  // closes. Assert both that "drift" appears and that "ok" specifically
  // does NOT (a weaker /STALENESS (ok|drift) / match would not catch a
  // regression back to always saying "ok").
  assert.match(logContents, /^STALENESS drift /m, logContents)
  assert.ok(!/^STALENESS ok /m.test(logContents), 'a genuinely drifted install must never be reported under the "ok" token')
  const line = logContents.match(/^STALENESS drift .*$/m)[0]
  const json = JSON.parse(line.slice(line.indexOf('{')))
  assert.deepEqual(json.drifted, ['agents/lens-security.md'], 'the drift report must name the one modified file')
})

test('weekly runner (drift visibility, coordinator ruling 2026-08-23): a run that reports drift ALSO prints one line to stderr naming the log path and a count, never the file list -- "recorded but invisible" (log-only) is the exact defect this closes', () => {
  const published = makePublishedRepo()
  const install = identicalInstallOf(published)
  fs.writeFileSync(path.join(install, 'agents', 'lens-security.md'), 'a stale, locally-edited copy\n')
  fs.rmSync(path.join(install, 'hooks', 'hooks.json'))
  const repo = makeTempRepo()
  setMarker(repo, 'pass')
  const { status, stderr, log, logContents } = runWeeklyScript([repo], { stalenessRemote: published, claudeHome: install })
  assert.equal(status, 0, logContents)
  assert.ok(stderr && stderr.trim().length > 0, `a drifted run must print something to stderr, not only to the log file -- got empty stderr:\n${logContents}`)
  assert.match(stderr, /drift/i, stderr)
  assert.ok(stderr.includes(log), `the stderr line must name the actual log path so an operator knows where to look; stderr was:\n${stderr}`)
  assert.match(stderr, /1 drifted, 1 missing/, `the stderr line must carry the exact count (1 drifted + 1 missing here), not merely say "drift happened"; stderr was:\n${stderr}`)
  assert.ok(!/agents\/lens-security\.md/.test(stderr), 'stderr must name a COUNT, never the file list -- the log line already carries that')
  assert.ok(!/hooks\.json/.test(stderr), 'stderr must name a COUNT, never the file list -- the log line already carries that')
})

test('weekly runner (AC-OPS-1): with ZERO delivery repos configured, the staleness check still runs exactly once', () => {
  const published = makePublishedRepo()
  const install = identicalInstallOf(published)
  const { status, logContents } = runWeeklyScript([], { stalenessRemote: published, claudeHome: install })
  assert.equal(status, 0, logContents)
  const stalenessLines = logContents.match(/^STALENESS /gm) || []
  assert.equal(stalenessLines.length, 1, `expected exactly one staleness report with zero repos configured, got ${stalenessLines.length}:\n${logContents}`)
})

test('weekly runner (AC-OPS-4): a published file DELETED from the install is named as drift (missing), and a user-owned file the install has but the repo never shipped is never named', () => {
  const published = makePublishedRepo()
  const install = identicalInstallOf(published)
  fs.rmSync(path.join(install, 'hooks', 'hooks.json'))
  fs.writeFileSync(path.join(install, 'CLAUDE.md'), 'user-owned, never published\n')
  const repo = makeTempRepo()
  setMarker(repo, 'pass')
  const { status, logContents } = runWeeklyScript([repo], { stalenessRemote: published, claudeHome: install })
  assert.equal(status, 0, logContents)
  assert.match(logContents, /^STALENESS drift /m, logContents)
  const line = logContents.match(/^STALENESS drift .*$/m)[0]
  const json = JSON.parse(line.slice(line.indexOf('{')))
  assert.deepEqual(json.missing, ['hooks/hooks.json'])
  assert.ok(!logContents.includes('CLAUDE.md'), 'CLAUDE.md is user-owned and not in the consumer subset -- it must never be named')
})

test('weekly runner (AC-OPS-2): the staleness check never writes to the install, INCLUDING on a run that reports drift', () => {
  const published = makePublishedRepo()
  const install = identicalInstallOf(published)
  fs.writeFileSync(path.join(install, 'agents', 'lens-security.md'), 'drifted on purpose\n')
  const before = hashInstallTree(install)
  const repo = makeTempRepo()
  setMarker(repo, 'pass')
  const { status, logContents } = runWeeklyScript([repo], { stalenessRemote: published, claudeHome: install })
  assert.equal(status, 0, logContents)
  assert.match(logContents, /"drifted":\["agents\/lens-security\.md"\]/, 'sanity: this run must genuinely have reported drift')
  const after = hashInstallTree(install)
  assert.deepEqual(after, before, 'AC-OPS-2: no file under the install may change content, and no new file may appear')
})

test('weekly runner (AC-OPS-3): an unreachable remote path produces "could-not-check", exit 0, and does not fail the weekly run even when a delivery repo also fails', () => {
  const goneRemote = path.join(RUN_TMPDIR, 'unreachable-staleness-remote-does-not-exist')
  assert.ok(!fs.existsSync(goneRemote), 'sanity: the remote path must genuinely not exist')
  const repo = makeTempRepo()
  setMarker(repo, 'pass')
  const { status, logContents } = runWeeklyScript([repo], { stalenessRemote: goneRemote })
  assert.equal(status, 0, logContents)
  assert.match(logContents, /STALENESS could-not-check /, logContents)
  assert.match(logContents, resultLineRegex('PASS', label(repo)), 'the delivery-repo run itself must be unaffected by the staleness check failing')
})

test('weekly runner (AC-OPS-3): an unreachable remote never flips overall exit status even when the ONLY configured repo also fails', () => {
  const goneRemote = path.join(RUN_TMPDIR, 'unreachable-staleness-remote-does-not-exist-2')
  const repo = makeTempRepo()
  setMarker(repo, 'noop') // the delivery repo genuinely fails (missing report)
  const { status, logContents } = runWeeklyScript([repo], { stalenessRemote: goneRemote })
  assert.notEqual(status, 0, logContents) // fails because of the REPO, not the staleness check
  assert.match(logContents, /STALENESS could-not-check install_source_commit=\S+ \{"error":"git clone of the staleness remote failed"\}/, logContents)
  assert.match(logContents, resultLineRegex('FAIL', label(repo)), logContents)
})

test('weekly runner (AC-ARCH-2/AC-ARCH-3): the installed AGENT-HARNESS.md\'s SOURCE_COMMIT stamp is reported BOTH on the run header line and on the staleness check\'s own report line', () => {
  const sha = 'd'.repeat(40)
  // The stamp must be readable WITHOUT it also causing drift -- published
  // and install both carry the identical stamped AGENT-HARNESS.md, so this
  // test isolates stamp reporting from the "drift" token added by the
  // 2026-08-23 fix above. Stamping only the install's copy (as an earlier
  // version of this test did) made the two AGENT-HARNESS.md's content
  // genuinely differ, which is real drift -- that version of this test
  // asserted "STALENESS ok" on a run that should have said "STALENESS
  // drift", which is exactly the invisible-drift defect the coordinator's
  // 2026-08-23 review caught.
  const stampedAgentHarness = `<!-- SOURCE_COMMIT: ${sha} -->\nharness contract\n`
  const published = makePublishedRepo({ 'AGENT-HARNESS.md': stampedAgentHarness })
  const install = identicalInstallOf(published)
  const repo = makeTempRepo()
  setMarker(repo, 'pass')
  const { status, logContents } = runWeeklyScript([repo], { stalenessRemote: published, claudeHome: install })
  assert.equal(status, 0, logContents)
  assert.match(logContents, new RegExp(`weekly optimise-cycle starting.*install_source_commit=${sha}`), 'the header line must name the installed stamp')
  assert.match(logContents, new RegExp(`^STALENESS ok install_source_commit=${sha} `, 'm'), 'the staleness report\'s own line must also name the installed stamp')
})

test('weekly runner (AC-ARCH-2): when the install has no readable stamp at all, both lines say "unknown" rather than a stale or fabricated value', () => {
  const published = makePublishedRepo()
  const install = identicalInstallOf(published) // no SOURCE_COMMIT line in this fixture's AGENT-HARNESS.md
  const repo = makeTempRepo()
  setMarker(repo, 'pass')
  const { status, logContents } = runWeeklyScript([repo], { stalenessRemote: published, claudeHome: install })
  assert.equal(status, 0, logContents)
  assert.match(logContents, /weekly optimise-cycle starting.*install_source_commit=unknown/, logContents)
  assert.match(logContents, /^STALENESS ok install_source_commit=unknown /m, logContents)
})

test('weekly runner (anti-vacuity, end to end): a "published" remote that clones successfully but has ZERO consumer-subset files is reported could-not-check, never as a clean "no drift" -- the guard that finds nothing and calls that clean is the failure shape this repo has hit before', () => {
  const emptyPublished = makeTempRepo() // a real, clonable git repo with only README.md -- no subset files at all
  const install = makeInstallDir({ 'AGENT-HARNESS.md': 'harness\n' })
  const repo = makeTempRepo()
  setMarker(repo, 'pass')
  const { status, logContents } = runWeeklyScript([repo], { stalenessRemote: emptyPublished, claudeHome: install })
  assert.equal(status, 0, logContents)
  assert.match(logContents, /STALENESS could-not-check /, `a zero-file comparison must never read as "STALENESS ok":\n${logContents}`)
  assert.ok(!/^STALENESS ok /m.test(logContents), `must not report ok when nothing was actually compared:\n${logContents}`)
})
