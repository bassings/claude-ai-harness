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
const { provisionInstall } = require('./helpers/weekly-sandbox.js')
const CF = require('./helpers/collector-fixtures.js')

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
// The old shape-only fixture: a heading, a section heading and "n=3, clean.", with no figure the runner collected
// anywhere in it. Since HARN-RUNNER-2 T3 it is what a HOLLOW report looks like, and it must never score PASS (AC-QA-5).
const VALID_REPORT = '# Delivery optimiser report\n\nRepos: fixture\n\n## Sample completeness\nn=3, clean.\n'
const CHATTY_SUCCESS_LINE = 'Report written to .claude/optimise-cycle-report.md -- 5 ranked proposals.'
// Anchored to the CLI's real message, taken verbatim from the real 2026-08-16 log line quoted in
// specs/harn-opt-2.md conductor log tick 40.
const CEILING_LINE = 'Background tasks still running after 600s; terminating. Set CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0 to wait indefinitely.'
// HARN-RUNNER-2 T3 (AC-QA-18): the session returns text and writes nothing. The shared stub `claude` is
// test/helpers/stub-session.mjs, which runs the REAL workflow on the digest the runner collected and prints the
// `--output-format json` envelope; its behaviour is the marker each test drops into the repo it is about to run
// against (see that file's header for the modes). It drops a witness file on EVERY invocation (Group 8: the skip
// test's name claimed the stub was never invoked, but nothing checked that).
const STUB_SESSION = path.join(__dirname, 'helpers', 'stub-session.mjs')
const SESSION_EXEC = `${JSON.stringify(process.execPath)} ${JSON.stringify(STUB_SESSION)}`
// Ends a custom `claude` shim with the correct session.
const PASS_SESSION = `STUB_SESSION_MODE=pass exec ${SESSION_EXEC} "$@"`
// The runner's per-run directory, from the `Read(//<dir>/**)` allow rule the session is given.
const RUN_DIR_SNIPPET = `RUN_DIR=$(printf '%s\\n' "$@" | sed -n 's|^Read(/\\(/.*\\)/\\*\\*)$|\\1|p' | head -n 1)\n`
// The stub session drops WITNESS_REL into the repository it is run for (found from the runner's log, as the session no longer
// starts there), on every invocation.
const STUB_CLAUDE = `#!/bin/sh
exec ${SESSION_EXEC} "$@"
`
fs.writeFileSync(path.join(STUB_DIR, 'claude'), STUB_CLAUDE, { mode: 0o755 })
// The collector asks gh for the run list: this stub has no Actions history, which counts as a lane that ran.
fs.writeFileSync(path.join(STUB_DIR, 'gh'), '#!/bin/sh\nif [ "$1 $2" = "run list" ]; then echo "[]"; exit 0; fi\nexit 2\n', { mode: 0o755 })
// What the runner runs from $CLAUDE_HOME/workflows/lib/ (the collector and the helpers beside it): the default
// install every test shares, and every other install a test builds is given the same programs.
const DEFAULT_INSTALL = provisionInstall(fs.mkdtempSync(path.join(RUN_TMPDIR, 'default-install-')))

// T11 (AC-OPS-1): a stub notifier. The runner raises its FAIL notification
// through `osascript`, so a stub of that name sits in STUB_DIR, which every
// spawn in this file puts ahead of the real PATH: no test can ever raise a
// real operating-system notification. Each invocation appends one CALL line
// and one ARG line per argument to $OSA_RECORD, and exits with $OSA_EXIT
// (default 0). Both variables belong to the test harness, never the runner.
const STUB_OSASCRIPT = `#!/bin/sh
if [ -n "$OSA_RECORD" ]; then
  echo CALL >> "$OSA_RECORD"
  for a in "$@"; do printf 'ARG\t%s\n' "$a" >> "$OSA_RECORD"; done
fi
exit "\${OSA_EXIT:-0}"
`
fs.writeFileSync(path.join(STUB_DIR, 'osascript'), STUB_OSASCRIPT, { mode: 0o755 })

// Parses an OSA_RECORD file into one array of arguments per notifier call.
function readNotifyCalls(recordPath) {
  if (!fs.existsSync(recordPath)) return []
  const calls = []
  for (const line of fs.readFileSync(recordPath, 'utf8').split('\n')) {
    if (line === 'CALL') calls.push([])
    else if (line.startsWith('ARG\t')) calls[calls.length - 1].push(line.slice(4))
  }
  return calls
}

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
    TMPDIR: freshDir('tmpdir-'),
    OSA_RECORD: `${log}.notify`,
    OSA_EXIT: String(opts.notifierExit || 0),
    STUB_REPOS: opts.rawRepos !== undefined ? opts.rawRepos : repos.join('\n'),
    STUB_MARK_REPO: '1',
    ...(opts.env || {}),
  }
  for (const name of opts.unsetEnv || []) delete env[name]
  // The runner runs the collector from $CLAUDE_HOME/workflows/lib/ (AC-SEC-10), so every install, the default one
  // included, holds the real programs. Nothing a test already put there is replaced.
  env.CLAUDE_HOME = opts.claudeHome ? provisionInstall(opts.claudeHome) : DEFAULT_INSTALL
  if (opts.rawRepos !== undefined) {
    env.OPTIMISE_WEEKLY_REPOS = opts.rawRepos
  } else {
    env.OPTIMISE_WEEKLY_REPOS = repos.join('\n')
  }
  const res = spawnSync(SCRIPT_PATH, [], { encoding: 'utf8', timeout: 60000, env })
  const logContents = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : ''
  return { ...res, log, logContents, notifyCalls: readNotifyCalls(`${log}.notify`) }
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

test('weekly runner: a report left over from an earlier week is never taken for this run\'s -- the session returns nothing, the run FAILs, and the old report is untouched', () => {
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
  // The session returns nothing this run -- the report is left byte-for-byte as a previous week would have left it.
  // Since HARN-RUNNER-2 T3 the runner writes the report itself from the session's result, so the old "stale mtime"
  // check is gone: what protects the old report is that nothing is placed unless the result is trusted (AC-QA-13).
  setMarker(repo, 'noop')
  const { status, logContents } = runWeeklyScript([repo])
  assert.notEqual(status, 0, logContents)
  assert.match(logContents, resultLineRegex('FAIL', label(repo)), logContents)
  assert.match(logContents, /session output: empty/i, 'the FAIL reason must name the empty session output, not some other cause')
  assert.equal(fs.readFileSync(reportPath, 'utf8'), staleContent, 'the last good report is left untouched')
  assert.ok(Math.abs(fs.statSync(reportPath).mtimeMs - oldTime.getTime()) < 2000, 'and so is its mtime')
})

test('weekly runner: a session that returns nothing -- FAIL, and no report is written', () => {
  const repo = makeTempRepo()
  setMarker(repo, 'noop')
  const { status, logContents } = runWeeklyScript([repo])
  assert.notEqual(status, 0, logContents)
  assert.match(logContents, resultLineRegex('FAIL', label(repo)), logContents)
  assert.match(logContents, /session output: empty/i)
  assert.ok(!fs.existsSync(path.join(repo, REPORT_REL)))
})

test('weekly runner: a session that exits non-zero -- FAIL, even though it printed a complete, correct result, and nothing is written', () => {
  const repo = makeTempRepo()
  setMarker(repo, 'exit3')
  const { status, logContents } = runWeeklyScript([repo])
  assert.notEqual(status, 0, logContents)
  assert.match(logContents, resultLineRegex('FAIL', label(repo)), logContents)
  assert.match(logContents, /exited 3/, 'the FAIL reason must name the non-zero exit, not the report')
  assert.ok(!fs.existsSync(path.join(repo, REPORT_REL)), 'the runner scores before it writes: a failed session leaves no report (AC-QA-13)')
})

test('weekly runner: a session that returns a correct result and nothing else -- PASS, because the verdict comes from the content the runner can check, not from anything the session said', () => {
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
  const passRepo = makeTempRepo()
  setMarker(passRepo, 'pass')
  // A passing repo beside it, because a run in which EVERY path is skipped is
  // itself a FAIL (T11 escalation, finding 5, tested below).
  const { status, logContents } = runWeeklyScript([notARepo, passRepo])
  assert.equal(status, 0, logContents)
  assert.match(logContents, new RegExp(`SKIP ${escapeRegExp(label(notARepo))} \\(not a git repo\\)`), logContents)
  assert.ok(!new RegExp(`RESULT \\S+ ${escapeRegExp(label(notARepo))}`).test(logContents), 'a skipped, non-git directory must never produce a PASS/FAIL verdict line')
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
  setMarker(repo, 'chatty')
  const { status, logContents } = runWeeklyScript([repo])
  assert.notEqual(status, 0, logContents)
  assert.match(logContents, resultLineRegex('FAIL', label(repo)), logContents)
  assert.match(logContents, /session output: not a JSON envelope/i)
  assert.ok(!logContents.includes(CHATTY_SUCCESS_LINE), 'the session\'s own text never reaches the log')
  assert.ok(!fs.existsSync(path.join(repo, REPORT_REL)))
})

test('weekly runner (Group 1): confident success language while an OLD report is on disk -- FAIL, and the old report is untouched', () => {
  const repo = makeTempRepo()
  fs.mkdirSync(path.join(repo, '.claude'), { recursive: true })
  const reportPath = path.join(repo, REPORT_REL)
  fs.writeFileSync(reportPath, VALID_REPORT)
  const oldTime = new Date(Date.now() - 7 * 24 * 3600 * 1000)
  fs.utimesSync(reportPath, oldTime, oldTime)
  setMarker(repo, 'chatty')
  const { status, logContents } = runWeeklyScript([repo])
  assert.notEqual(status, 0, logContents)
  assert.match(logContents, resultLineRegex('FAIL', label(repo)), logContents)
  assert.match(logContents, /session output: not a JSON envelope/i)
  assert.equal(fs.readFileSync(reportPath, 'utf8'), VALID_REPORT, 'the language must not replace the report either')
})

test('weekly runner (Group 1, M5): a "report" that is plain error text with no markdown heading -- FAIL, names the missing heading', () => {
  const repo = makeTempRepo()
  setMarker(repo, 'no-heading')
  const { status, logContents } = runWeeklyScript([repo])
  assert.ok(!fs.existsSync(path.join(repo, REPORT_REL)), 'a report that is plain text is never written')
  assert.notEqual(status, 0, logContents)
  assert.match(logContents, resultLineRegex('FAIL', label(repo)), logContents)
  assert.match(logContents, /does not start with a markdown heading/i, logContents)
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
  setMarker(repo, 'mentions-ceiling-var')
  const { status, logContents } = runWeeklyScript([repo])
  assert.match(fs.readFileSync(path.join(repo, REPORT_REL), 'utf8'), /CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS/, 'sanity: the session\'s text really does mention the variable name')
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

// Since HARN-RUNNER-2 T3 the session's reply is parsed, never appended: nothing the model says reaches the log, so the
// three Group 7 / subtraction-round tests that pinned the transcript redaction step (an absolute path echoed back, a
// backtick-wrapped path, and the placeholder printed when redaction failed) are replaced by this one, which pins what
// they existed to protect: no absolute path, account name or session text in the log.
test('weekly runner (Group 7): a session whose text holds the repo\'s absolute path and the account name leaves neither in the log', () => {
  const whoami = sh('whoami', RUN_TMPDIR).trim()
  const homeLikeRoot = path.join(RUN_TMPDIR, 'home', whoami, 'repo-' + Math.random().toString(36).slice(2))
  fs.mkdirSync(homeLikeRoot, { recursive: true })
  sh('git init -q -b main', homeLikeRoot)
  sh('git -c user.email=fixture@example.invalid -c user.name=Fixture commit -q --allow-empty -m seed', homeLikeRoot)
  trackTempDir(homeLikeRoot)
  setMarker(homeLikeRoot, 'abs-paths')
  const { logContents, stderr } = runWeeklyScript([homeLikeRoot])
  assert.match(logContents, resultLineRegex('(?:PASS|FAIL)', label(homeLikeRoot)), `guard against vacuity: the run reached a verdict:\n${logContents}`)
  for (const [what, value] of [['the repo\'s absolute path', homeLikeRoot], ['the account name', whoami]]) {
    assert.ok(!logContents.includes(value), `the log must never contain ${what}:\n${logContents}`)
    assert.ok(!(stderr || '').includes(value), `nor stderr: ${stderr}`)
  }
})

// --- Group 8: small, cheap fixes -------------------------------------------

test('weekly runner (Group 8): an empty REPOS array (all-whitespace OPTIMISE_WEEKLY_REPOS) does not crash under bash 3.2 + set -u -- clean start/done, and since T11 (AC-OPS-2) exactly one RESULT line, the no-repos FAIL', () => {
  const { status, logContents, stderr } = runWeeklyScript([], { rawRepos: '   \n\n\t \n' })
  assert.notEqual(status, 0, logContents + stderr)
  assert.ok(!/unbound variable/.test(stderr || ''), `must not hit bash's unbound-variable error:\n${stderr}`)
  assert.match(logContents, /weekly optimise-cycle starting/, logContents)
  assert.match(logContents, /=== done/, logContents)
  assert.deepEqual(logContents.match(/^RESULT .*$/gm), ['RESULT FAIL - reason="no repos configured"'], 'an empty repo list produces only the no-repos FAIL')
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
    STUB_REPOS: repo,
    STUB_MARK_REPO: '1',
    OPTIMISE_WEEKLY_STALENESS_REMOTE: NO_STALENESS_REMOTE,
    TMPDIR: freshDir('tmpdir-'),
  }
  delete env.OPTIMISE_WEEKLY_REPOS
  env.CLAUDE_HOME = DEFAULT_INSTALL
  const res = spawnSync(SCRIPT_PATH, [], { encoding: 'utf8', timeout: 60000, env })
  const logContents = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : ''
  assert.equal(res.status, 0, logContents)
  assert.match(logContents, resultLineRegex('PASS', label(repo)), logContents)
  const resultCount = (logContents.match(/RESULT (PASS|FAIL)/g) || []).length
  assert.equal(resultCount, 1, `expected exactly one verdict line (blank config lines ignored), got:\n${logContents}`)
})

test('weekly runner (subtraction round, item 9): no $HOME/.claude/optimise-weekly-repos file and no OPTIMISE_WEEKLY_REPOS -- clean start/done, no SKIP lines, and since T11 (AC-OPS-2) the no-repos FAIL rather than exit 0 (a missing config file is not a crash)', () => {
  const fakeHome = fs.mkdtempSync(path.join(RUN_TMPDIR, 'fake-home-empty-'))
  trackTempDir(fakeHome)
  const log = freshLogPath()
  const env = {
    ...process.env,
    PATH: `${STUB_DIR}:${process.env.PATH}`,
    OPTIMISE_WEEKLY_LOG: log,
    HOME: fakeHome,
    STUB_REPOS: '',
    STUB_MARK_REPO: '1',
    OPTIMISE_WEEKLY_STALENESS_REMOTE: NO_STALENESS_REMOTE,
    TMPDIR: freshDir('tmpdir-'),
  }
  delete env.OPTIMISE_WEEKLY_REPOS
  env.CLAUDE_HOME = DEFAULT_INSTALL
  const res = spawnSync(SCRIPT_PATH, [], { encoding: 'utf8', timeout: 60000, env })
  const logContents = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : ''
  assert.notEqual(res.status, 0, logContents)
  assert.deepEqual(logContents.match(/^RESULT .*$/gm), ['RESULT FAIL - reason="no repos configured"'], 'no config file produces only the no-repos FAIL')
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
// (AC-OPS-1..5). See workflows/lib/install-consistency.mjs's
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
  // HIGH-2 (round-one review): includes agents/reviewer-*.md,
  // skills/conduct-plan/ (skills/optimise-cycle/ broadened to the whole
  // directory) and the two OPTIONAL bin/ files, so a fixture built from
  // this helper alone never trips unmatched_patterns/could-not-check as
  // an accident of an incomplete fixture -- a test that wants to exercise
  // unmatched_patterns does so deliberately, by omitting one of these.
  const files = {
    'AGENT-HARNESS.md': 'harness contract\n',
    'agents/lens-security.md': 'lens security\n',
    'agents/reviewer-verification.md': 'reviewer verification\n',
    'workflows/plan-cycle.js': 'plan cycle\n',
    'workflows/review-cycle.js': 'review cycle\n',
    'workflows/lib/install-consistency.mjs': 'the lib file itself\n',
    // The runner runs the collector from the install, so this one is the real program (the install is made from it).
    'workflows/lib/optimise-collect.mjs': fs.readFileSync(path.join(__dirname, '..', 'workflows', 'lib', 'optimise-collect.mjs'), 'utf8'),
    'hooks/hooks.json': '{}\n',
    'skills/optimise-cycle/SKILL.md': 'optimise-cycle skill\n',
    'skills/conduct-plan/SKILL.md': 'conduct-plan skill\n',
    'bin/optimise-cycle-weekly.sh': 'weekly runner\n',
    'bin/redact-transcript.mjs': 'redact transcript\n',
    'bin/sonar-rules-table.mjs': 'sonar rules table\n',
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
  for (const rel of [
    'AGENT-HARNESS.md',
    'agents/lens-security.md',
    'agents/reviewer-verification.md',
    'workflows/plan-cycle.js',
    'workflows/review-cycle.js',
    'workflows/lib/install-consistency.mjs',
    'workflows/lib/optimise-collect.mjs',
    'hooks/hooks.json',
    'skills/optimise-cycle/SKILL.md',
    'skills/conduct-plan/SKILL.md',
    'bin/optimise-cycle-weekly.sh',
    'bin/redact-transcript.mjs',
    'bin/sonar-rules-table.mjs',
  ]) {
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
  // L-4 (harn-fix-3, promoted 2026-08-24): hooks/hooks.json is now OPTIONAL
  // (the plugin manifest, absent by design on a manual install), so it can
  // no longer stand in as the REQUIRED-file-absent fixture this test needs
  // -- agents/reviewer-verification.md (still required) takes its place.
  fs.rmSync(path.join(install, 'agents', 'reviewer-verification.md'))
  const repo = makeTempRepo()
  setMarker(repo, 'pass')
  const { status, stderr, log, logContents } = runWeeklyScript([repo], { stalenessRemote: published, claudeHome: install })
  assert.equal(status, 0, logContents)
  assert.ok(stderr && stderr.trim().length > 0, `a drifted run must print something to stderr, not only to the log file -- got empty stderr:\n${logContents}`)
  assert.match(stderr, /drift/i, stderr)
  assert.ok(stderr.includes(log), `the stderr line must name the actual log path so an operator knows where to look; stderr was:\n${stderr}`)
  assert.match(stderr, /1 drifted, 1 missing/, `the stderr line must carry the exact count (1 drifted + 1 missing here), not merely say "drift happened"; stderr was:\n${stderr}`)
  assert.ok(!/agents\/lens-security\.md/.test(stderr), 'stderr must name a COUNT, never the file list -- the log line already carries that')
  assert.ok(!/reviewer-verification\.md/.test(stderr), 'stderr must name a COUNT, never the file list -- the log line already carries that')
})

test('weekly runner (AC-OPS-1): with ZERO delivery repos configured, the staleness check still runs exactly once', () => {
  const published = makePublishedRepo()
  const install = identicalInstallOf(published)
  const { status, logContents } = runWeeklyScript([], { stalenessRemote: published, claudeHome: install })
  // T11 (AC-OPS-2): zero repos is now a FAIL; the staleness check is unaffected.
  assert.notEqual(status, 0, logContents)
  const stalenessLines = logContents.match(/^STALENESS /gm) || []
  assert.equal(stalenessLines.length, 1, `expected exactly one staleness report with zero repos configured, got ${stalenessLines.length}:\n${logContents}`)
})

test('weekly runner (AC-OPS-4): a published file DELETED from the install is named as drift (missing), and a user-owned file the install has but the repo never shipped is never named', () => {
  const published = makePublishedRepo()
  const install = identicalInstallOf(published)
  // L-4 (harn-fix-3, promoted 2026-08-24): hooks/hooks.json is now OPTIONAL
  // (see the dedicated L-4 test below), so this REQUIRED-absence fixture
  // uses agents/reviewer-verification.md instead.
  fs.rmSync(path.join(install, 'agents', 'reviewer-verification.md'))
  fs.writeFileSync(path.join(install, 'CLAUDE.md'), 'user-owned, never published\n')
  const repo = makeTempRepo()
  setMarker(repo, 'pass')
  const { status, logContents } = runWeeklyScript([repo], { stalenessRemote: published, claudeHome: install })
  assert.equal(status, 0, logContents)
  assert.match(logContents, /^STALENESS drift /m, logContents)
  const line = logContents.match(/^STALENESS drift .*$/m)[0]
  const json = JSON.parse(line.slice(line.indexOf('{')))
  assert.deepEqual(json.missing, ['agents/reviewer-verification.md'])
  assert.ok(!logContents.includes('CLAUDE.md'), 'CLAUDE.md is user-owned and not in the consumer subset -- it must never be named')
})

// L-4 (harn-fix-3, promoted 2026-08-24 after being measured against a real
// install). hooks/hooks.json is the plugin manifest, read only by a
// `/plugin install`; README.md's manual-copy install wires the two
// PreToolUse hooks through ~/.claude/settings.json directly instead. Left
// as REQUIRED, this fired STALENESS drift on every weekly run for every
// manual install, forever -- verified against a real operator's install,
// whose settings.json genuinely carried both PreToolUse entries and no
// hooks.json at all.
test('weekly runner (L-4, harn-fix-3): a manual install with NO hooks/hooks.json, everything else current, reports STALENESS ok end to end -- the false positive that prompted this fix', () => {
  const published = makePublishedRepo()
  const install = identicalInstallOf(published)
  fs.rmSync(path.join(install, 'hooks', 'hooks.json'))
  const repo = makeTempRepo()
  setMarker(repo, 'pass')
  const { status, logContents } = runWeeklyScript([repo], { stalenessRemote: published, claudeHome: install })
  assert.equal(status, 0, logContents)
  assert.match(logContents, /^STALENESS ok /m, logContents)
  assert.ok(!logContents.includes('"missing":["hooks/hooks.json"]'), `hooks/hooks.json absent from a manual install must never be reported as missing:\n${logContents}`)
})

test('weekly runner (L-4, harn-fix-3): hooks/hooks.json PRESENT but with DIFFERENT content is still reported as STALENESS drift end to end -- a stale plugin install is a real problem', () => {
  const published = makePublishedRepo()
  const install = identicalInstallOf(published)
  fs.writeFileSync(path.join(install, 'hooks', 'hooks.json'), 'a stale, locally-edited plugin manifest\n')
  const repo = makeTempRepo()
  setMarker(repo, 'pass')
  const { status, logContents } = runWeeklyScript([repo], { stalenessRemote: published, claudeHome: install })
  assert.equal(status, 0, logContents)
  assert.match(logContents, /^STALENESS drift /m, logContents)
  const line = logContents.match(/^STALENESS drift .*$/m)[0]
  const json = JSON.parse(line.slice(line.indexOf('{')))
  assert.deepEqual(json.drifted, ['hooks/hooks.json'])
  assert.deepEqual(json.missing, [])
})

// ---- HIGH-2 (round-one review): the corrected subset, driven end to end ----
// The core defect: bin/optimise-cycle-weekly.sh (this very script) and
// skills/conduct-plan/ (the multi-PR plan driver) were BOTH omitted from
// the old subset, so either could be arbitrarily stale in a real install
// and the weekly log would say "STALENESS ok" over it. These tests drive
// the REAL script end to end against both, proving the fix closes the
// exact scenario, not merely a unit-level pattern-matching claim.

test('weekly runner (HIGH-2): a stale skills/conduct-plan/SKILL.md in the install is detected as drift end to end -- conduct-plan drives every multi-PR plan and was previously outside the subset entirely', () => {
  const published = makePublishedRepo()
  const install = identicalInstallOf(published)
  fs.writeFileSync(path.join(install, 'skills', 'conduct-plan', 'SKILL.md'), 'a stale, half-applied copy\n')
  const repo = makeTempRepo()
  setMarker(repo, 'pass')
  const { status, logContents } = runWeeklyScript([repo], { stalenessRemote: published, claudeHome: install })
  assert.equal(status, 0, logContents)
  assert.match(logContents, /^STALENESS drift /m, logContents)
  const line = logContents.match(/^STALENESS drift .*$/m)[0]
  const json = JSON.parse(line.slice(line.indexOf('{')))
  assert.deepEqual(json.drifted, ['skills/conduct-plan/SKILL.md'])
})

test('weekly runner (HIGH-2): a stale bin/optimise-cycle-weekly.sh in the install is detected as drift end to end -- the detector can now see itself', () => {
  const published = makePublishedRepo()
  const install = identicalInstallOf(published)
  fs.writeFileSync(path.join(install, 'bin', 'optimise-cycle-weekly.sh'), 'an old copy of this very script, without the staleness check at all\n')
  const repo = makeTempRepo()
  setMarker(repo, 'pass')
  const { status, logContents } = runWeeklyScript([repo], { stalenessRemote: published, claudeHome: install })
  assert.equal(status, 0, logContents)
  assert.match(logContents, /^STALENESS drift /m, logContents)
  const line = logContents.match(/^STALENESS drift .*$/m)[0]
  const json = JSON.parse(line.slice(line.indexOf('{')))
  assert.deepEqual(json.drifted, ['bin/optimise-cycle-weekly.sh'])
})

test('weekly runner (HIGH-2): an install with NO bin/ directory at all (a plugin install, or a manual install that never set up the weekly job) reports clean, not drift, over the OPTIONAL bin/ files\' absence', () => {
  const published = makePublishedRepo()
  const install = identicalInstallOf(published)
  fs.rmSync(path.join(install, 'bin'), { recursive: true, force: true })
  const repo = makeTempRepo()
  setMarker(repo, 'pass')
  const { status, logContents } = runWeeklyScript([repo], { stalenessRemote: published, claudeHome: install })
  assert.equal(status, 0, logContents)
  assert.match(logContents, /^STALENESS ok /m, logContents)
  assert.ok(!logContents.includes('"missing":["bin'), `an optional file's absence must never be reported as missing:\n${logContents}`)
})

// ---- MED-8 follow-through: a subset pattern matching nothing forces could-not-check, never a false "ok" ----
test('weekly runner (MED-8 follow-through): a published tree missing a WHOLE subset directory (simulating a rename) reports could-not-check end to end, never "ok", even though nothing in the intersection actually drifted', () => {
  const published = makePublishedRepo()
  fs.rmSync(path.join(published, 'hooks'), { recursive: true, force: true })
  sh('git add -A && git commit -q -m "simulate a hooks/ rename upstream"', published)
  // Built by hand rather than identicalInstallOf() (which would try to
  // read hooks/hooks.json from published and fail -- it no longer exists
  // there either, which is the whole point of this fixture).
  const install = makeInstallDir({
    'AGENT-HARNESS.md': fs.readFileSync(path.join(published, 'AGENT-HARNESS.md'), 'utf8'),
    'agents/lens-security.md': fs.readFileSync(path.join(published, 'agents', 'lens-security.md'), 'utf8'),
    'agents/reviewer-verification.md': fs.readFileSync(path.join(published, 'agents', 'reviewer-verification.md'), 'utf8'),
    'workflows/plan-cycle.js': fs.readFileSync(path.join(published, 'workflows', 'plan-cycle.js'), 'utf8'),
    'workflows/review-cycle.js': fs.readFileSync(path.join(published, 'workflows', 'review-cycle.js'), 'utf8'),
    'workflows/lib/install-consistency.mjs': fs.readFileSync(path.join(published, 'workflows', 'lib', 'install-consistency.mjs'), 'utf8'),
    'skills/optimise-cycle/SKILL.md': fs.readFileSync(path.join(published, 'skills', 'optimise-cycle', 'SKILL.md'), 'utf8'),
    'skills/conduct-plan/SKILL.md': fs.readFileSync(path.join(published, 'skills', 'conduct-plan', 'SKILL.md'), 'utf8'),
    'bin/optimise-cycle-weekly.sh': fs.readFileSync(path.join(published, 'bin', 'optimise-cycle-weekly.sh'), 'utf8'),
    'bin/redact-transcript.mjs': fs.readFileSync(path.join(published, 'bin', 'redact-transcript.mjs'), 'utf8'),
    // deliberately NO hooks/ at all -- matches the published repo post-removal
  })
  const repo = makeTempRepo()
  setMarker(repo, 'pass')
  const { status, logContents } = runWeeklyScript([repo], { stalenessRemote: published, claudeHome: install })
  assert.equal(status, 0, logContents)
  assert.match(logContents, /^STALENESS could-not-check /m, `a pattern matching zero published files must force could-not-check, never a bare "ok":\n${logContents}`)
  assert.ok(!/^STALENESS ok /m.test(logContents), logContents)
  const line = logContents.match(/^STALENESS could-not-check .*$/m)[0]
  const json = JSON.parse(line.slice(line.indexOf('{')))
  assert.ok(json.unmatched_patterns.includes('hooks/'), `expected "hooks/" in unmatched_patterns:\n${JSON.stringify(json.unmatched_patterns)}`)
})

test('weekly runner (AC-OPS-2): the staleness check never writes to the install, INCLUDING on a run that reports drift', () => {
  const published = makePublishedRepo()
  const install = identicalInstallOf(published)
  fs.writeFileSync(path.join(install, 'agents', 'lens-security.md'), 'drifted on purpose\n')
  // The sandbox provisions the collector and reader into the install; do that
  // before the snapshot so only the RUN's own writes can show as a change.
  provisionInstall(install)
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
  assert.match(logContents, /STALENESS could-not-check \{"error":"git clone of the staleness remote failed"\}/, logContents)
  assert.match(logContents, resultLineRegex('FAIL', label(repo)), logContents)
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

// --- staging the workflow script, so no run has to improvise one ----------
//
// Observed in the real log every week from 2026-08-30 to 2026-09-14, across
// all three repos: the Workflow tool resolves a workflow by NAME from the
// repo's own .claude/workflows/, not from the global ~/.claude/workflows/
// where the harness installs it. So each run copied the script into the repo
// under an invented name, then could not delete it -- `rm` is in the runner's
// own disallowedTools list, deliberately. Three weeks of untracked leftovers
// and a "delete this when convenient" note in a log nobody reads.
//
// The cleanup belongs in the runner, which has permission, not in the agent,
// which does not.

function withGlobalWorkflow(home, body) {
  const dir = path.join(home, 'workflows')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'optimise-cycle.js'), body)
  provisionInstall(home)
  return dir
}

// A `claude` stub that RECORDS whether the staged script was present at the
// moment it ran, then behaves like the shared stub's pass/fail markers.
//
// Without this witness, three of the tests below were vacuous: with no
// staging implemented at all, the file never exists, so "the staged copy is
// gone afterwards" is trivially true and the test passes against an empty
// implementation. Measured -- reverting the runner change left 3 of these 5
// green. The separating question is whether the file existed DURING the run,
// which only something running inside the run can answer.
const WITNESS_STAGED = '.optimise-weekly-staged-seen'
function witnessingClaudeStub(outcome) {
  const dir = fs.mkdtempSync(path.join(RUN_TMPDIR, 'witness-stub-'))
  const body = `#!/bin/sh
if [ -f .claude/workflows/optimise-cycle.js ]; then
  cat .claude/workflows/optimise-cycle.js > ${JSON.stringify(WITNESS_STAGED)}
fi
${outcome === 'fail' ? 'exit 1' : PASS_SESSION}
`
  fs.writeFileSync(path.join(dir, 'claude'), body, { mode: 0o755 })
  return dir
}
function stagedWasSeen(repo) {
  return fs.existsSync(path.join(repo, WITNESS_STAGED))
}

// --- T11 (specs/harn-audit-1.md): the guard stays on, an explicit allowlist,
// a FAIL is notified, and the run cleans up after itself ---------------------
//
// Nothing in this section raises a real notification, schedules a job or
// launches a real claude session: the notifier is the `osascript` stub in
// STUB_DIR, and every claude is a stub.

const { spawn } = require('node:child_process')
const LAST_RESULT_REL = path.join('.claude', 'logs', 'optimise-cycle-weekly.last-result')
const OLD_SCRIPT_VERSION = '2026-08-23.1'

function freshDir(prefix) {
  const dir = fs.mkdtempSync(path.join(RUN_TMPDIR, prefix))
  trackTempDir(dir)
  return dir
}

function freshHome() {
  return freshDir('home-')
}

// AC-OPS-1 ------------------------------------------------------------------

test('T11 AC-OPS-1: a FAIL raises exactly one notification naming the failing repo label and the first reason, and never an absolute path', () => {
  const repo = makeTempRepo()
  setMarker(repo, 'noop')
  const res = runWeeklyScript([repo])
  assert.notEqual(res.status, 0, res.logContents)
  assert.equal(res.notifyCalls.length, 1, `expected exactly one notification:\n${JSON.stringify(res.notifyCalls)}`)
  const text = res.notifyCalls[0].join('\n')
  assert.ok(text.includes(label(repo)), `the notification must name the failing repo label:\n${text}`)
  assert.match(text, /session output: empty/, 'and the first reason')
  assert.ok(!text.includes(path.dirname(repo)), `AC-SEC-10: never an absolute path:\n${text}`)
})

test('T11 AC-OPS-1: two failing repos still raise exactly one notification, naming both', () => {
  const a = makeTempRepo()
  const b = makeTempRepo()
  setMarker(a, 'noop')
  setMarker(b, 'noop')
  const res = runWeeklyScript([a, b])
  assert.equal(res.notifyCalls.length, 1, JSON.stringify(res.notifyCalls))
  const text = res.notifyCalls[0].join('\n')
  assert.ok(text.includes(label(a)) && text.includes(label(b)), text)
})

test('T11 AC-OPS-1: a PASS calls the notifier zero times', () => {
  const repo = makeTempRepo()
  setMarker(repo, 'pass')
  const res = runWeeklyScript([repo])
  assert.equal(res.status, 0, res.logContents)
  assert.equal(res.notifyCalls.length, 0, JSON.stringify(res.notifyCalls))
})

test('T11 AC-OPS-1: one PASS and one FAIL notifies once and names only the failing label', () => {
  const good = makeTempRepo()
  const bad = makeTempRepo()
  setMarker(good, 'pass')
  setMarker(bad, 'noop')
  const res = runWeeklyScript([good, bad])
  assert.equal(res.notifyCalls.length, 1, JSON.stringify(res.notifyCalls))
  const text = res.notifyCalls[0].join('\n')
  assert.ok(text.includes(label(bad)), text)
  assert.ok(!text.includes(label(good)), `the passing repo must not be named:\n${text}`)
})

test('T11 AC-OPS-1: a notifier that exits non-zero leaves NOTIFY-FAILED <exit code> in the run log, with the code it really exited with', () => {
  const repo = makeTempRepo()
  setMarker(repo, 'noop')
  const res = runWeeklyScript([repo], { notifierExit: 7 })
  assert.equal(res.notifyCalls.length, 1)
  assert.match(res.logContents, /^NOTIFY-FAILED 7$/m, res.logContents)
  assert.notEqual(res.status, 0, 'a failed notification must not turn a FAIL run into an exit 0')
})

test('T11 AC-OPS-1: a notifier that succeeds leaves no NOTIFY-FAILED line', () => {
  const repo = makeTempRepo()
  setMarker(repo, 'noop')
  const res = runWeeklyScript([repo])
  assert.equal(res.notifyCalls.length, 1)
  assert.ok(!/NOTIFY-FAILED/.test(res.logContents), res.logContents)
})

test('T11 AC-OPS-1: a repo label holding quotes and backslashes reaches the notifier as its own argument, never spliced into script text', () => {
  const hostile = 'q"uote\\back'
  const dir = path.join(freshDir('hostile-label-'), hostile)
  fs.mkdirSync(dir)
  execFileSync('git', ['init', '-q', dir])
  setMarker(dir, 'noop')
  const res = runWeeklyScript([dir])
  assert.equal(res.notifyCalls.length, 1, `${res.logContents}\n${JSON.stringify(res.notifyCalls)}`)
  const args = res.notifyCalls[0]
  const carriers = args.filter((a) => a.includes(hostile))
  assert.ok(carriers.length >= 1, `the label must be passed verbatim as data:\n${JSON.stringify(args)}`)
  for (const a of carriers) {
    assert.ok(!/display notification/.test(a), `the label must never sit inside AppleScript source:\n${a}`)
  }
})

test('T11 AC-OPS-1: the last-result file holds exactly one line (UTC timestamp, FAIL, label, reason) under $HOME/.claude/logs', () => {
  const repo = makeTempRepo()
  setMarker(repo, 'noop')
  const home = freshHome()
  const res = runWeeklyScript([repo], { home })
  const file = path.join(home, LAST_RESULT_REL)
  assert.ok(fs.existsSync(file), `missing ${LAST_RESULT_REL}:\n${res.logContents}`)
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
  assert.equal(lines.length, 1, lines.join('\n'))
  assert.match(lines[0], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z FAIL /, lines[0])
  assert.ok(lines[0].includes(label(repo)), lines[0])
  assert.match(lines[0], /session output: empty/, lines[0])
})

test('T11 AC-OPS-1: the last-result file survives the run and the next run overwrites it (FAIL then PASS leaves one PASS line)', () => {
  const repo = makeTempRepo()
  const home = freshHome()
  setMarker(repo, 'noop')
  runWeeklyScript([repo], { home })
  const file = path.join(home, LAST_RESULT_REL)
  assert.match(fs.readFileSync(file, 'utf8'), / FAIL /, 'the FAIL result must persist after the process exits')
  setMarker(repo, 'pass')
  runWeeklyScript([repo], { home })
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
  assert.equal(lines.length, 1, lines.join('\n'))
  assert.match(lines[0], /^\S+ PASS /, lines[0])
  assert.ok(lines[0].includes(label(repo)), lines[0])
})

// AC-OPS-2 ------------------------------------------------------------------

// The env var UNSET (runWeeklyScript always exports it), with an optional
// $HOME/.claude/optimise-weekly-repos body.
function runWithEnvUnset(configBody) {
  const home = freshHome()
  if (configBody !== null) {
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true })
    fs.writeFileSync(path.join(home, '.claude', 'optimise-weekly-repos'), configBody)
  }
  const log = freshLogPath()
  const env = {
    ...process.env,
    PATH: `${STUB_DIR}:${process.env.PATH}`,
    OPTIMISE_WEEKLY_LOG: log,
    HOME: home,
    OPTIMISE_WEEKLY_STALENESS_REMOTE: NO_STALENESS_REMOTE,
    OSA_RECORD: `${log}.notify`,
    TMPDIR: freshDir('tmpdir-'),
  }
  delete env.OPTIMISE_WEEKLY_REPOS
  env.CLAUDE_HOME = DEFAULT_INSTALL
  const res = spawnSync(SCRIPT_PATH, [], { encoding: 'utf8', timeout: 20000, env })
  const logContents = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : ''
  return { ...res, logContents, notifyCalls: readNotifyCalls(`${log}.notify`) }
}

const NO_REPOS_LINE = /^RESULT FAIL - reason="no repos configured"$/m

for (const [name, run] of [
  ['the env var holding only blank lines', () => runWeeklyScript([], { rawRepos: '   \n\n\t \n' })],
  ['the env var unset and the config file missing', () => runWithEnvUnset(null)],
  ['the env var unset and the config file holding only blank lines', () => runWithEnvUnset('\n  \n\t\n')],
]) {
  test(`T11 AC-OPS-2: ${name} -- RESULT FAIL "no repos configured", non-zero exit, one notification`, () => {
    const res = run()
    assert.match(res.logContents, NO_REPOS_LINE, res.logContents)
    assert.notEqual(res.status, 0, res.logContents)
    assert.equal(res.notifyCalls.length, 1, JSON.stringify(res.notifyCalls))
    assert.match(res.notifyCalls[0].join('\n'), /no repos configured/)
  })
}

test('T11 AC-OPS-2: a configured repo list produces no "no repos configured" line', () => {
  const repo = makeTempRepo()
  setMarker(repo, 'pass')
  const res = runWeeklyScript([repo])
  assert.ok(!/no repos configured/.test(res.logContents), res.logContents)
})

// AC-OPS-6 ------------------------------------------------------------------

test('T11 AC-OPS-6: the first log line of every run carries a SCRIPT_VERSION newer than the pre-T11 value, and it is the value the script declares', () => {
  const declared = fs.readFileSync(SCRIPT_PATH, 'utf8').match(/^SCRIPT_VERSION="([^"]+)"/m)[1]
  assert.match(declared, /^\d{4}-\d{2}-\d{2}\.\d+$/)
  assert.ok(declared > OLD_SCRIPT_VERSION, `SCRIPT_VERSION ${declared} must be bumped past ${OLD_SCRIPT_VERSION}`)
  const passRepo = makeTempRepo()
  setMarker(passRepo, 'pass')
  for (const res of [runWeeklyScript([passRepo]), runWeeklyScript([], { rawRepos: '' })]) {
    const first = res.logContents.split('\n')[0]
    assert.ok(first.includes(`version=${declared}`), `first line must carry version=${declared}:\n${first}`)
  }
})

// AC-SEC-8 ------------------------------------------------------------------

function argvRecordingClaude() {
  const dir = freshDir('argv-stub-')
  // The session starts in the per-run directory, so what it records goes to the repository by absolute path (found from the
  // repository list the runner was given), and its working directory is recorded too.
  const body = `#!/bin/sh
R="$(printf '%s\\n' "$OPTIMISE_WEEKLY_REPOS" | head -n 1)"
: > "$R/.claude-argv"
pwd -P > "$R/.claude-cwd"
for a in "$@"; do printf '%s\\n' "$a" >> "$R/.claude-argv"; done
${PASS_SESSION}
`
  fs.writeFileSync(path.join(dir, 'claude'), body, { mode: 0o755 })
  return dir
}

function capturedArgv(repo) {
  return fs.readFileSync(path.join(repo, '.claude-argv'), 'utf8').split('\n').filter((l) => l !== '')
}

function flagValues(argv, flag) {
  const i = argv.indexOf(flag)
  if (i < 0) return null
  const out = []
  for (let j = i + 1; j < argv.length && !argv[j].startsWith('--'); j += 1) out.push(argv[j])
  return out
}

test('T11 AC-SEC-8: the claude invocation passes an explicit --allowedTools list and a mode that denies the rest, with no hooks disabled and no bypass', () => {
  const repo = makeTempRepo()
  const res = runWeeklyScript([repo], { extraPath: argvRecordingClaude() })
  assert.equal(res.status, 0, res.logContents)
  const argv = capturedArgv(repo)
  const allowed = flagValues(argv, '--allowedTools')
  assert.ok(allowed && allowed.length > 0, `--allowedTools must be passed with entries:\n${argv.join('\n')}`)
  assert.deepEqual(flagValues(argv, '--permission-mode'), ['dontAsk'], 'unlisted tools must be denied, not prompted for or auto-approved')
  for (const bad of ['--dangerously-skip-permissions', 'bypassPermissions', 'auto', 'acceptEdits']) {
    assert.ok(!argv.includes(bad), `argv must not contain ${bad}`)
  }
  assert.ok(!argv.join('\n').includes('disableAllHooks'), 'the guard and snapshot hooks must stay on')
  const settings = flagValues(argv, '--settings')
  assert.ok(settings === null || !settings.join('').includes('disableAllHooks'))
})

test('T11 AC-SEC-8: the allowlist names no bare tool that would grant everything and has no Write entry', () => {
  const repo = makeTempRepo()
  runWeeklyScript([repo], { extraPath: argvRecordingClaude() })
  const allowed = flagValues(capturedArgv(repo), '--allowedTools')
  for (const bare of ['Bash', 'Write', 'Edit', 'NotebookEdit', 'WebFetch', 'WebSearch', '*']) {
    assert.ok(!allowed.includes(bare), `a bare ${bare} entry would grant the whole tool:\n${allowed.join('\n')}`)
  }
  assert.ok(!allowed.some((e) => /^Write\(/.test(e)), 'Write(...) is never matched by the CLI: only Edit rules cover file-editing tools')
  for (const entry of allowed.filter((e) => /^Bash\(/.test(e))) {
    assert.ok(!/^Bash\((rm|sudo|curl|wget|git push|git commit|git reset)\b/.test(entry), `a denied command must not be allowed: ${entry}`)
    for (const reader of ['cat', 'head', 'tail', 'ls', 'wc', 'date', 'echo', 'printf']) {
      assert.ok(!entry.startsWith(`Bash(${reader}`), `Read, Grep and Glob already cover reading; ${entry} would add an unscoped path`)
    }
  }
})

// A real headless run (Claude Code, dontAsk) printed `Ignoring --allowedTools
// rule "*)": Wildcard tool name "*)" is not supported in allow rules` for each
// rule holding a literal "$(git rev-parse --show-toplevel)": the CLI splits the
// rule at the inner parenthesis and discards it, and the command it meant to
// allow was refused. So no rule may carry a command substitution of either form.
// HARN-RUNNER-2 T3: the rules that held one are gone with every Bash rule, so this now pins that none comes back.
test('T11 escalation (real probe): no allow rule the runner passes contains a $( or backtick command substitution, which the CLI cannot parse in a rule', () => {
  const main = makeTempRepo()
  fs.writeFileSync(path.join(main, 'f'), 'x\n')
  sh('git add f', main)
  sh('git commit -q -m init', main)
  const wt = path.join(freshDir('wt-'), 'tree')
  sh(`git worktree add -q ${JSON.stringify(wt)}`, main)
  for (const [repo, home] of [[makeTempRepo(), undefined], [wt, freshDir('claudehome-')]]) {
    runWeeklyScript([repo], { claudeHome: home, extraPath: argvRecordingClaude() })
    const allowed = flagValues(capturedArgv(repo), '--allowedTools')
    assert.ok(allowed?.length > 0, 'guard against vacuity: claude ran with an allowlist')
    for (const entry of allowed) {
      assert.ok(!entry.includes('$(') && !entry.includes('`'), `a rule holding a command substitution is discarded by the CLI: ${entry}`)
    }
  }
})

test('T11 AC-SEC-8: neither the runner nor its plist contains disableAllHooks, even in a comment', () => {
  for (const f of ['optimise-cycle-weekly.sh', 'com.local.optimise-cycle-weekly.plist']) {
    const text = fs.readFileSync(path.join(__dirname, '..', 'bin', f), 'utf8')
    assert.ok(!text.includes('disableAllHooks'), `${f} must not mention disableAllHooks`)
  }
})

// AC-SIMP-3 -----------------------------------------------------------------

test('T11 AC-SIMP-3: the runner adds no overlap lock and no log rotation', () => {
  const text = fs.readFileSync(SCRIPT_PATH, 'utf8')
  // No overlap lock: runs are never serialised or refused because another is running. The one lock the runner takes is the short
  // mkdir lock on the proposal-targets sidecar's read, merge and rename (HARN-RUNNER-2 T3 L2), which only orders those few
  // seconds between runners that really do overlap, and is the only lock file named anywhere in the script.
  for (const banned of [/\bflock\b/, /\.pid\b/, /mv "\$LOG"/, /logrotate/]) {
    assert.ok(!banned.test(text), `the runner must not contain ${banned}`)
  }
  assert.deepEqual([...new Set(text.match(/[\w.-]*\.lock\b/g) || [])], ['optimise-sidecar.lock'], 'the sidecar lock is the only lock file')
})

// AC-OPS-4 and AC-DATA-14: cleanup -----------------------------------------

function waitFor(predicate, what, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const tick = () => {
      if (predicate()) return resolve()
      if (Date.now() - started > timeoutMs) return reject(new Error(`timed out waiting for ${what}`))
      setTimeout(tick, 50)
    }
    tick()
  })
}

// A claude that announces it is running, then waits to be killed.
function hangingClaude() {
  const dir = freshDir('hang-stub-')
  const body = `#!/bin/sh
R="$(printf '%s\n' "$OPTIMISE_WEEKLY_REPOS" | head -n 1)"
echo $$ > "$R/.claude-pid"
: > "$R/.ready"
exec sleep 30
`
  fs.writeFileSync(path.join(dir, 'claude'), body, { mode: 0o755 })
  return dir
}

function startRunner(repo, { home, claudeHome, tmpdir, extraPath }) {
  const log = freshLogPath()
  const env = {
    ...process.env,
    PATH: `${extraPath}:${STUB_DIR}:${process.env.PATH}`,
    OPTIMISE_WEEKLY_LOG: log,
    HOME: home,
    CLAUDE_HOME: provisionInstall(claudeHome),
    TMPDIR: tmpdir,
    OPTIMISE_WEEKLY_STALENESS_REMOTE: NO_STALENESS_REMOTE,
    OPTIMISE_WEEKLY_REPOS: repo,
    OSA_RECORD: `${log}.notify`,
    OSA_EXIT: '0',
  }
  const child = spawn(SCRIPT_PATH, [], { env, stdio: 'ignore' })
  const done = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })))
  return { child, log, done, notifyCalls: () => readNotifyCalls(`${log}.notify`) }
}

// The runner keeps its temp files under one parent directory of TMPDIR, and
// each invocation owns one run.XXXXXX directory inside it (T11 round 3).
const RUNNER_DIR = 'optimise-weekly-runner'
const RUN_DIR_RE = /^run\.[A-Za-z0-9]{6}$/

function runDirs(dir) {
  const parent = path.join(dir, RUNNER_DIR)
  if (!fs.existsSync(parent)) return []
  return fs.readdirSync(parent).filter((n) => RUN_DIR_RE.test(n)).map((n) => path.join(parent, n))
}

// Every file the runner holds for a run (the collected data, the session's output): all of it must be gone afterwards.
function transcripts(dir) {
  return runDirs(dir).flatMap((d) => fs.readdirSync(d, { recursive: true }))
}

function killIfAlive(pidFile) {
  try { process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 'SIGKILL') } catch (e) { /* already gone */ }
}

const SIGNAL_NUMBER = { SIGTERM: 15, SIGINT: 2, SIGHUP: 1 }

for (const sig of ['SIGTERM', 'SIGINT']) {
  test(`T11 AC-OPS-4: after ${sig} mid-run no per-run file remains, claude is stopped, and the outcome is recorded as FAIL and notified (M1)`, async () => {
    const repo = makeTempRepo()
    const claudeHome = freshDir('claudehome-')
    withGlobalWorkflow(claudeHome, '// global v1\nconst WEEKLY_RUNNER_CONTRACT = 2\n')
    const tmp = freshDir('tmp-')
    const home = freshHome()
    const lastResult = path.join(home, LAST_RESULT_REL)
    fs.mkdirSync(path.dirname(lastResult), { recursive: true })
    fs.writeFileSync(lastResult, '2026-01-01T00:00:00Z PASS labels="earlier" reasons=""\n')
    const run = startRunner(repo, { home, claudeHome, tmpdir: tmp, extraPath: hangingClaude() })
    const pidFile = path.join(repo, '.claude-pid')
    try {
      await waitFor(() => fs.existsSync(path.join(repo, '.ready')), 'claude to start')
      assert.ok(transcripts(tmp).length > 0, 'guard against vacuity: the per-run directory holds files while claude runs')
      run.child.kill(sig)
      await Promise.race([run.done, new Promise((_, rej) => setTimeout(() => rej(new Error('runner did not exit after the signal')), 20000))])
      assert.deepEqual(transcripts(tmp), [], 'the per-run files must be gone')
      assert.deepEqual(runDirs(tmp), [], 'the run\'s own directory must be gone')
      let alive = true
      try { process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 0) } catch (e) { alive = false }
      assert.equal(alive, false, 'claude must not be left running after the runner is told to stop')
      const n = SIGNAL_NUMBER[sig]
      const lines = fs.readFileSync(lastResult, 'utf8').split('\n').filter(Boolean)
      assert.equal(lines.length, 1, lines.join('\n'))
      assert.match(lines[0], / FAIL /, `the pre-seeded PASS must not survive a killed run:\n${lines[0]}`)
      assert.ok(lines[0].includes(`killed by signal ${n}`), lines[0])
      assert.match(fs.readFileSync(run.log, 'utf8'), new RegExp(`^RESULT FAIL - reason="killed by signal ${n}"$`, 'm'))
      assert.equal(run.notifyCalls().length, 1, 'the notifier is called once')
    } finally {
      killIfAlive(pidFile)
    }
  })
}

// The class, not only the signals the runner traps: any abnormal end (a
// SIGHUP here, which has no handler of its own) reaches the EXIT path and
// must read as FAIL, never leave the previous PASS standing.
test('T11 AC-OPS-4: an abnormal end the runner has no handler for (SIGHUP) still records FAIL and notifies, because the outcome is written from the EXIT path and defaults to FAIL (M1)', async () => {
  const repo = makeTempRepo()
  const claudeHome = freshDir('claudehome-')
  const home = freshHome()
  const lastResult = path.join(home, LAST_RESULT_REL)
  fs.mkdirSync(path.dirname(lastResult), { recursive: true })
  fs.writeFileSync(lastResult, '2026-01-01T00:00:00Z PASS labels="earlier" reasons=""\n')
  const run = startRunner(repo, { home, claudeHome, tmpdir: freshDir('tmp-'), extraPath: hangingClaude() })
  const pidFile = path.join(repo, '.claude-pid')
  try {
    await waitFor(() => fs.existsSync(path.join(repo, '.ready')), 'claude to start')
    run.child.kill('SIGHUP')
    await Promise.race([run.done, new Promise((_, rej) => setTimeout(() => rej(new Error('runner did not exit after SIGHUP')), 20000))])
    const line = fs.readFileSync(lastResult, 'utf8')
    assert.match(line, / FAIL /, line)
    assert.equal(run.notifyCalls().length, 1)
    assert.match(fs.readFileSync(run.log, 'utf8'), /^RESULT FAIL - reason="/m)
  } finally {
    killIfAlive(pidFile)
  }
})

test('T11 AC-OPS-4: a claude that is SIGKILLed mid-run (the shape of the timeout\'s second-stage kill; the timeout itself is not exercised, since TIMEOUT_S has no test seam) leaves no transcript temp file and no staged workflow, and the repo FAILs', () => {
  const repo = makeTempRepo()
  const claudeHome = freshDir('claudehome-')
  withGlobalWorkflow(claudeHome, '// global v1\nconst WEEKLY_RUNNER_CONTRACT = 2\n')
  const tmp = freshDir('tmp-')
  const killed = freshDir('killed-stub-')
  fs.writeFileSync(path.join(killed, 'claude'), '#!/bin/sh\n: > "$PWD/.session-started"\nkill -KILL $$\n', { mode: 0o755 })
  const res = runWeeklyScript([repo], { claudeHome, extraPath: killed, env: { TMPDIR: tmp } })
  assert.match(res.logContents, resultLineRegex('FAIL', label(repo)))
  assert.deepEqual(transcripts(tmp), [])
})

test('T11 AC-DATA-14: with nothing staged and no transcript yet, the exit cleanup deletes nothing (an unrelated optimise-weekly-transcript.* file survives)', () => {
  const tmp = freshDir('tmp-')
  const decoy = path.join(tmp, 'optimise-weekly-transcript.decoy')
  fs.writeFileSync(decoy, 'not ours\n')
  const res = runWeeklyScript([], { rawRepos: '', env: { TMPDIR: tmp } })
  assert.match(res.logContents, NO_REPOS_LINE, 'guard against vacuity: the run really ended through the exit path')
  assert.equal(fs.readFileSync(decoy, 'utf8'), 'not ours\n')
})

test('T11 AC-SEC-10: the per-run directory lives under CLAUDE_HOME when TMPDIR is unset, never in a shared /tmp', () => {
  const repo = makeTempRepo()
  const claudeHome = freshDir('claudehome-')
  const lister = freshDir('ls-stub-')
  fs.writeFileSync(path.join(lister, 'claude'), `#!/bin/sh
${RUN_DIR_SNIPPET}R="$(printf '%s\\n' "$OPTIMISE_WEEKLY_REPOS" | head -n 1)"
printf '%s\\n' "$RUN_DIR" > "$R/.run-dir"
ls "$RUN_DIR" > "$R/.home-listing"
${PASS_SESSION}
`, { mode: 0o755 })
  fs.mkdirSync(path.join(repo, '.claude'), { recursive: true })
  const res = runWeeklyScript([repo], { claudeHome, unsetEnv: ['TMPDIR'], extraPath: lister })
  assert.equal(res.status, 0, res.logContents)
  const listing = fs.readFileSync(path.join(repo, '.home-listing'), 'utf8').split('\n')
  assert.ok(listing.includes('digest.json'), `expected the collected files in the per-run directory while running:\n${listing.join('\n')}`)
  const runDir = fs.readFileSync(path.join(repo, '.run-dir'), 'utf8').trim()
  assert.ok(runDir.startsWith(`${fs.realpathSync(claudeHome)}/${RUNNER_DIR}/run.`), `expected the per-run directory under CLAUDE_HOME's runner directory, got ${runDir}`)
})

test('T11 AC-DATA-14: the runner has exactly one cleanup function, every rm sits inside it, and the exit and signal traps all reach it', () => {
  const lines = fs.readFileSync(SCRIPT_PATH, 'utf8').split('\n')
  const code = lines.map((l, i) => ({ l, i })).filter(({ l }) => !/^\s*#/.test(l))
  const defs = code.filter(({ l }) => /^cleanup\w*\(\) \{/.test(l))
  assert.equal(defs.length, 1, 'exactly one cleanup function')
  const name = defs[0].l.match(/^(\w+)\(\)/)[1]
  const start = defs[0].i
  const end = lines.findIndex((l, i) => i > start && l === '}')
  const outside = code.filter(({ l, i }) => (i < start || i > end) && /(^|&&\s*|\|\|\s*|;\s*|then\s+)(rm|rmdir)\s/.test(l))
  assert.deepEqual(outside.map(({ l }) => l.trim()), [], 'no rm outside the cleanup function')
  const exitTrap = code.find(({ l }) => /^trap /.test(l) && l.includes('EXIT'))
  assert.ok(exitTrap, 'an EXIT trap')
  const handler = exitTrap.l.match(/^trap '?(\w+)'? EXIT/)[1]
  const handlerStart = lines.findIndex((l) => l.startsWith(`${handler}() {`))
  const handlerEnd = lines.findIndex((l, i) => i > handlerStart && l === '}')
  assert.ok(handler === name || lines.slice(handlerStart, handlerEnd).some((l) => l.trim() === name || l.trim() === `${name} final`), 'the EXIT trap runs the cleanup function')
  for (const sigName of ['TERM', 'INT']) {
    assert.ok(code.some(({ l }) => /^trap /.test(l) && l.includes(sigName)), `a trap for ${sigName}`)
  }
})

test('T11 AC-DATA-14: the staleness check\'s clone directory is gone after a run (it goes through the same cleanup function as the transcript and the staged copy)', () => {
  const published = makePublishedRepo()
  const install = identicalInstallOf(published)
  const tmp = freshDir('tmp-')
  const repo = makeTempRepo()
  setMarker(repo, 'pass')
  const res = runWeeklyScript([repo], { stalenessRemote: published, claudeHome: install, env: { TMPDIR: tmp } })
  assert.match(res.logContents, /^STALENESS ok /m, `guard against vacuity: the clone really happened:\n${res.logContents}`)
  assert.deepEqual(fs.readdirSync(path.join(tmp, RUNNER_DIR)), [], 'no optimise-weekly-staleness.* directory may be left behind')
})

// --- T11 fix round 1 -------------------------------------------------------

// M3: the cleanup after each repo is pinned by a two-repo run. With one repo
// the EXIT trap cleans the same state whether or not the in-loop call runs.
// Each invocation appends its own per-run directory to $PER_RUN_RECORD, and first notes every earlier one that still exists.
function listingClaude() {
  const dir = freshDir('listing-stub-')
  fs.writeFileSync(path.join(dir, 'claude'), `#!/bin/sh
${RUN_DIR_SNIPPET}if [ -f "$PER_RUN_RECORD" ]; then
  while IFS= read -r earlier; do
    case "$earlier" in ALIVE*) ;; *) [ -e "$earlier" ] && echo "ALIVE $earlier" >> "$PER_RUN_RECORD.alive" ;; esac
  done < "$PER_RUN_RECORD"
fi
echo "$RUN_DIR" >> "$PER_RUN_RECORD"
${PASS_SESSION}
`, { mode: 0o755 })
  return dir
}

test('T11 M3: with two repos, the first repo\'s collected files are gone before the second repo\'s session starts', () => {
  const a = makeTempRepo()
  const b = makeTempRepo()
  const claudeHome = freshDir('claudehome-')
  const tmp = freshDir('tmp-')
  const record = path.join(freshDir('record-'), 'dirs')
  const res = runWeeklyScript([a, b], { claudeHome, extraPath: listingClaude(), env: { TMPDIR: tmp, PER_RUN_RECORD: record } })
  assert.equal(res.status, 0, res.logContents)
  const dirs = fs.readFileSync(record, 'utf8').split('\n').filter(Boolean)
  assert.equal(dirs.length, 2, 'guard against vacuity: both sessions ran')
  assert.notEqual(dirs[0], dirs[1], 'each repository is handed a directory of its own, so the second session cannot read the first\'s data')
  const alivePath = `${record}.alive`
  const alive = fs.existsSync(alivePath) ? fs.readFileSync(alivePath, 'utf8') : ''
  assert.equal(alive, '', `the first repo's per-run directory must be gone before B's session starts: ${alive}`)
  assert.equal(fs.existsSync(path.join(a, '.claude', 'workflows')), false, 'nothing is written into the first repository\'s .claude/workflows')
  assert.equal(fs.existsSync(path.join(b, '.claude', 'workflows')), false)
})

// L1 ------------------------------------------------------------------------

test('T11 L1: claude is told to load user settings only, so an analysed repo\'s own settings cannot widen the allowlist or add hooks', () => {
  const repo = makeTempRepo()
  runWeeklyScript([repo], { extraPath: argvRecordingClaude() })
  assert.deepEqual(flagValues(capturedArgv(repo), '--setting-sources'), ['user'])
})

// L2 + L7 -------------------------------------------------------------------




// L3 ------------------------------------------------------------------------

test('T11 L3: the runner\'s temp files live in a runner-owned mode-700 parent, in a mode-700 directory of their own per run', () => {
  const repo = makeTempRepo()
  const tmp = freshDir('tmp-')
  const modeProbe = freshDir('mode-stub-')
  fs.writeFileSync(path.join(modeProbe, 'claude'), `#!/bin/sh
${RUN_DIR_SNIPPET}R="$(printf '%s\\n' "$OPTIMISE_WEEKLY_REPOS" | head -n 1)"
ls -ld "$RUN_DIR" > "$R/.runner-mode"
ls -l "$RUN_DIR" > "$R/.runner-files-mode"
ls -ld "$(dirname "$RUN_DIR")" > "$R/.parent-mode"
${PASS_SESSION}
`, { mode: 0o755 })
  const res = runWeeklyScript([repo], { extraPath: modeProbe, env: { TMPDIR: tmp } })
  assert.equal(res.status, 0, res.logContents)
  assert.match(fs.readFileSync(path.join(repo, '.runner-mode'), 'utf8'), /^drwx------/, 'the per-run directory is mode 700')
  assert.match(fs.readFileSync(path.join(repo, '.parent-mode'), 'utf8'), /^drwx------/, 'the parent is mode 700')
  for (const line of fs.readFileSync(path.join(repo, '.runner-files-mode'), 'utf8').split('\n').filter((l) => l.startsWith('-'))) {
    assert.match(line, /^-rw-------/, `every collected file is mode 600 or tighter: ${line}`)
  }
})

function backdate(p, hours) {
  const t = new Date(Date.now() - hours * 3600 * 1000)
  if (fs.lstatSync(p).isSymbolicLink()) fs.lutimesSync(p, t, t)
  else fs.utimesSync(p, t, t)
}

test('T11 L3: after a SIGKILL, a run directory left behind is removed by a later run once it is older than the threshold, and is named in the log; an unrelated same-named file outside survives', async () => {
  const repo = makeTempRepo()
  const claudeHome = freshDir('claudehome-')
  const tmp = freshDir('tmp-')
  const home = freshHome()
  const decoy = path.join(tmp, 'optimise-weekly-transcript.decoy')
  fs.writeFileSync(decoy, 'not ours\n')
  const run = startRunner(repo, { home, claudeHome, tmpdir: tmp, extraPath: hangingClaude() })
  const pidFile = path.join(repo, '.claude-pid')
  let leftover
  try {
    await waitFor(() => fs.existsSync(path.join(repo, '.ready')), 'claude to start')
    run.child.kill('SIGKILL')
    await run.done
    leftover = runDirs(tmp)
    assert.equal(leftover.length, 1, 'guard against vacuity: SIGKILL leaves the run directory (and its files) behind')
    assert.ok(transcripts(tmp).length > 0)
  } finally {
    killIfAlive(pidFile)
  }
  const fresh = runWeeklyScript([repo], { home, claudeHome, extraPath: witnessingClaudeStub('pass'), env: { TMPDIR: tmp } })
  assert.equal(fs.existsSync(leftover[0]), true, 'a directory this fresh may belong to a live sibling, so it must survive')
  assert.ok(!/REMOVED-STALE-RUN-DIR/.test(fresh.logContents), fresh.logContents)
  backdate(leftover[0], 48)
  const res = runWeeklyScript([repo], { home, claudeHome, extraPath: witnessingClaudeStub('pass'), env: { TMPDIR: tmp } })
  assert.equal(fs.existsSync(leftover[0]), false, 'the stale directory must be gone')
  assert.match(res.logContents, new RegExp(`^REMOVED-STALE-RUN-DIR ${escapeRegExp(path.basename(leftover[0]))}$`, 'm'), res.logContents)
  assert.equal(fs.readFileSync(decoy, 'utf8'), 'not ours\n', 'a same-named file outside the runner directory is never touched')
})

test('T11 L3: the start-up sweep removes only a stale run.XXXXXX directory this user owns -- never a fresh sibling, a 23-hour-old one, a differently named directory, a file, a symlink (or its target), or anything a stale directory links to', () => {
  const tmp = freshDir('tmp-')
  const outside = freshDir('outside-')
  fs.writeFileSync(path.join(outside, 'sentinel'), 'outside\n')
  const parent = path.join(tmp, RUNNER_DIR)
  fs.mkdirSync(parent, { mode: 0o700 })
  const mk = (name, hours, fill) => {
    const d = path.join(parent, name)
    fs.mkdirSync(d)
    if (fill) fill(d)
    backdate(d, hours)
    return d
  }
  const stale = mk('run.STALE1', 25, (d) => {
    fs.writeFileSync(path.join(d, 'report.md'), 'x\n')
    fs.symlinkSync(path.join(outside, 'sentinel'), path.join(d, 'link-out'))
  })
  const edge = mk('run.EDGE23', 23, (d) => fs.writeFileSync(path.join(d, 'report.md'), 'edge\n'))
  const sibling = mk('run.FRESH1', 0, (d) => fs.writeFileSync(path.join(d, 'report.md'), 'sibling\n'))
  const other = mk('other.OLD111', 48, (d) => fs.writeFileSync(path.join(d, 'f'), 'other\n'))
  const short = mk('run.ABCDE', 48)
  const long = mk('run.ABCDEFG', 48)
  const file = path.join(parent, 'run.FILE11')
  fs.writeFileSync(file, 'a file\n')
  backdate(file, 48)
  const link = path.join(parent, 'run.LINK11')
  const linkTarget = freshDir('link-target-')
  fs.writeFileSync(path.join(linkTarget, 'kept'), 'kept\n')
  backdate(linkTarget, 48)
  fs.symlinkSync(linkTarget, link)
  backdate(link, 48)
  const repo = makeTempRepo()
  const res = runWeeklyScript([repo], { extraPath: scratchClaude(WRITE_VALID), env: { TMPDIR: tmp } })
  assert.equal(res.status, 0, res.logContents)
  assert.equal(fs.existsSync(stale), false, 'the stale directory is removed')
  assert.equal(fs.readFileSync(path.join(outside, 'sentinel'), 'utf8'), 'outside\n', 'a link inside a stale directory is not followed')
  for (const keep of [edge, sibling, other, short, long, file]) assert.equal(fs.existsSync(keep), true, `${keep} must survive`)
  assert.equal(fs.readFileSync(path.join(sibling, 'report.md'), 'utf8'), 'sibling\n', 'a concurrent sibling\'s files are untouched')
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true, 'a symlink named like a run directory is left alone')
  assert.equal(fs.readFileSync(path.join(linkTarget, 'kept'), 'utf8'), 'kept\n', 'and so is its target')
  assert.deepEqual(res.logContents.match(/^REMOVED-STALE-RUN-DIR .*$/gm), ['REMOVED-STALE-RUN-DIR run.STALE1'])
})

test('T11 round 3: a symlink where the runner parent should be is refused before anything is changed, and its target is not chmodded or swept', () => {
  const repo = makeTempRepo()
  const tmp = freshDir('tmp-')
  const target = freshDir('parent-target-')
  fs.chmodSync(target, 0o755)
  fs.writeFileSync(path.join(target, 'sentinel'), 'kept\n')
  const stale = path.join(target, 'run.STALE1')
  fs.mkdirSync(stale)
  backdate(stale, 48)
  fs.symlinkSync(target, path.join(tmp, RUNNER_DIR))
  const res = runWeeklyScript([repo], { extraPath: argvRecordingClaude(), env: { TMPDIR: tmp } })
  assert.notEqual(res.status, 0)
  assert.match(res.logContents, /^RESULT FAIL - reason="runner temp directory is not a directory this user owns/m, res.logContents)
  assert.equal(fs.statSync(target).mode & 0o777, 0o755, 'the link target must not be chmodded')
  assert.equal(fs.existsSync(stale), true, 'and nothing under it may be swept')
  assert.equal(fs.existsSync(path.join(repo, '.claude-argv')), false)
})

// L6 ------------------------------------------------------------------------

// --- T11 fix round 2, rewritten by HARN-RUNNER-2 T3: the session writes nothing ---------
//
// Measured for real (Claude Code 2.1.322, dontAsk): every write into .claude/ is refused whatever the allow rule.
// Since T3 the session writes no file at all and has no shell: it Reads the digest from the runner's per-run
// directory, returns the workflow's result as text, and the runner (the trusted side) checks it and writes the report
// and the sidecar itself. The tests that pinned the scratch-file mechanism (the two scratch Edit rules, the old output-path
// and proposal-targets prompt arguments, the git -C rules, the sidecar being optional, and the five rejections
// of a hostile scratch file) are gone; test/harn-runner-2-t3.test.js pins what replaced them.

// The per-run directory a session was given, read from its `Read(//<dir>/**)` allow rule.
function runDirFromArgv(argv) {
  const rule = flagValues(argv, '--allowedTools').find((e) => /^Read\(\/\/.+\/\*\*\)$/.test(e))
  assert.ok(rule, `the session must be given a Read rule for one directory: ${flagValues(argv, '--allowedTools').join(' ')}`)
  return rule.slice('Read(/'.length, -'/**)'.length)
}

// A claude that is told its per-run directory by its Read rule (it exits 3 if it is not told any), reads its
// --session-id, then runs `action`. An action that ends in WRITE_VALID returns the correct result.
function scratchClaude(action) {
  const dir = freshDir('scratch-stub-')
  fs.writeFileSync(path.join(dir, 'claude'), `#!/bin/sh
${RUN_DIR_SNIPPET}[ -n "$RUN_DIR" ] || exit 3
prev=""
for a in "$@"; do
  if [ "$prev" = "--session-id" ]; then SESSION_ID="$a"; fi
  prev="$a"
done
${action}
`, { mode: 0o755 })
  return dir
}

const WRITE_VALID = PASS_SESSION
const FINAL_SIDECAR_REL = path.join('.claude', 'optimise-proposal-targets.json')

test('T11 R2: a runner temp directory path the optimiser would refuse (a .claude segment) stops the run with a FAIL and a notification, before any claude', () => {
  const repo = makeTempRepo()
  const tmp = path.join(freshDir('dotclaude-'), '.claude', 'tmp')
  fs.mkdirSync(tmp, { recursive: true })
  const res = runWeeklyScript([repo], { extraPath: argvRecordingClaude(), env: { TMPDIR: tmp } })
  assert.notEqual(res.status, 0)
  assert.match(res.logContents, /^RESULT FAIL - reason="runner temp directory path cannot be given to the optimiser/m, res.logContents)
  assert.equal(res.notifyCalls.length, 1)
  assert.equal(fs.existsSync(path.join(repo, '.claude-argv')), false, 'claude must never have run')
})

test('T11 R2: a runner temp directory path with a character the optimiser would refuse (a space) stops the run with a FAIL, before any claude', () => {
  const repo = makeTempRepo()
  const tmp = path.join(freshDir('space-'), 'a b')
  fs.mkdirSync(tmp)
  const res = runWeeklyScript([repo], { extraPath: argvRecordingClaude(), env: { TMPDIR: tmp } })
  assert.notEqual(res.status, 0)
  assert.match(res.logContents, /^RESULT FAIL - reason="runner temp directory path cannot be given to the optimiser/m, res.logContents)
  assert.equal(fs.existsSync(path.join(repo, '.claude-argv')), false, 'claude must never have run')
})

test('T11 R2: the report and the sidecar the runner writes from the result land in .claude/, and no per-run file or temp file is left', () => {
  const repo = makeTempRepo()
  const tmp = freshDir('tmp-')
  const res = runWeeklyScript([repo], { extraPath: scratchClaude(WRITE_VALID), env: { TMPDIR: tmp } })
  assert.equal(res.status, 0, res.logContents)
  assert.match(res.logContents, resultLineRegex('PASS', label(repo)))
  assert.match(fs.readFileSync(path.join(repo, REPORT_REL), 'utf8'), /^# Delivery optimiser report\n/)
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(repo, FINAL_SIDECAR_REL), 'utf8')), {}, 'the sidecar is the result\'s proposal_targets, which is empty for a run with no proposals')
  assert.deepEqual(runDirs(tmp), [], 'the run\'s own directory, and with it every collected file, is gone')
  assert.deepEqual(fs.readdirSync(path.join(repo, '.claude')).filter((n) => n.startsWith('.optimise-output')), [], 'no temp file left beside the report')
})

test('T11 R2: a result with no sidecar FAILs naming the sidecar, and no report is written either (AC-PROD-4)', () => {
  const repo = makeTempRepo()
  setMarker(repo, 'no-sidecar')
  const res = runWeeklyScript([repo])
  assert.notEqual(res.status, 0, res.logContents)
  assert.match(extractResultLine(res.logContents, 'FAIL', label(repo)), /sidecar/i)
  assert.equal(fs.existsSync(path.join(repo, REPORT_REL)), false)
  assert.equal(fs.existsSync(path.join(repo, FINAL_SIDECAR_REL)), false)
})

test('T11 R2: for a linked worktree the report lands in the worktree and the sidecar in the main checkout, where the optimiser reads it', () => {
  const main = makeTempRepo()
  fs.writeFileSync(path.join(main, 'f'), 'x\n')
  sh('git add f', main)
  sh('git commit -q -m init', main)
  const wt = path.join(freshDir('wt-'), 'tree')
  sh(`git worktree add -q ${JSON.stringify(wt)}`, main)
  const res = runWeeklyScript([wt], { extraPath: scratchClaude(WRITE_VALID) })
  assert.equal(res.status, 0, res.logContents)
  assert.equal(fs.existsSync(path.join(wt, REPORT_REL)), true)
  assert.equal(fs.existsSync(path.join(main, FINAL_SIDECAR_REL)), true, 'the sidecar belongs under the roster root the workflow resolves')
  assert.equal(fs.existsSync(path.join(wt, FINAL_SIDECAR_REL)), false)
})

test('T11 R2: the move never writes through a symlink that sits where the final report goes', () => {
  const repo = makeTempRepo()
  const target = path.join(freshDir('link-target-'), 'created-through-the-link')
  fs.mkdirSync(path.join(repo, '.claude'), { recursive: true })
  fs.symlinkSync(target, path.join(repo, REPORT_REL))
  const res = runWeeklyScript([repo], { extraPath: scratchClaude(WRITE_VALID) })
  assert.equal(fs.existsSync(target), false, 'nothing may be created at the link target')
  assert.equal(fs.lstatSync(path.join(repo, REPORT_REL)).isSymbolicLink(), false, 'the link itself is replaced')
  assert.match(fs.readFileSync(path.join(repo, REPORT_REL), 'utf8'), /^# Delivery optimiser report\n/)
  assert.equal(res.status, 0, res.logContents)
})


test('T11 R2: a directory sitting where the final report goes is refused, not moved into', () => {
  const repo = makeTempRepo()
  fs.mkdirSync(path.join(repo, REPORT_REL), { recursive: true })
  const res = runWeeklyScript([repo], { extraPath: scratchClaude(WRITE_VALID) })
  assert.match(res.logContents, /report rejected: .*destination/, res.logContents)
  assert.deepEqual(fs.readdirSync(path.join(repo, REPORT_REL)), [], 'nothing may be moved into the directory')
  assert.notEqual(res.status, 0)
})

test('T11 R2: a report just under the size cap that is one enormous line is judged quickly (bash 3.2 pattern matching on a multi-megabyte string is quadratic), and FAILs for having no heading', () => {
  const repo = makeTempRepo()
  setMarker(repo, 'huge-no-heading')
  const res = runWeeklyScript([repo])
  assert.notEqual(res.status, null, 'the runner must finish well inside the test timeout, not hang in the heading check')
  assert.match(res.logContents, resultLineRegex('FAIL', label(repo)))
  assert.match(res.logContents, /does not start with a markdown heading/)
})


// --- T11 round 3: no state shared between runs ------------------------------

test('T11 round 3: two runs sharing one TMPDIR get different per-run directories, and no fixed file name is shared', () => {
  const tmp = freshDir('tmp-')
  const a = makeTempRepo()
  const b = makeTempRepo()
  runWeeklyScript([a], { extraPath: argvRecordingClaude(), env: { TMPDIR: tmp } })
  runWeeklyScript([b], { extraPath: argvRecordingClaude(), env: { TMPDIR: tmp } })
  const da = runDirFromArgv(capturedArgv(a))
  const db = runDirFromArgv(capturedArgv(b))
  assert.notEqual(da, db)
  for (const dir of [da, db]) assert.ok(dir.startsWith(`${fs.realpathSync(tmp)}/${RUNNER_DIR}/`), `the per-run directory is under the runner parent: ${dir}`)
  assert.deepEqual(runDirs(tmp), [], 'each run removed its own directory')
})

// F2 ----------------------------------------------------------------------------

// F6 ----------------------------------------------------------------------------


// F5 ----------------------------------------------------------------------------

test('T11 round 3 (F5): the last-result file says RUNNING as soon as a run starts, so a run that is SIGKILLed leaves RUNNING and not last week\'s PASS', async () => {
  const repo = makeTempRepo()
  const home = freshHome()
  const lastResult = path.join(home, LAST_RESULT_REL)
  fs.mkdirSync(path.dirname(lastResult), { recursive: true })
  fs.writeFileSync(lastResult, '2026-01-01T00:00:00Z PASS labels="earlier" reasons=""\n')
  const run = startRunner(repo, { home, claudeHome: freshDir('claudehome-'), tmpdir: freshDir('tmp-'), extraPath: hangingClaude() })
  const pidFile = path.join(repo, '.claude-pid')
  try {
    await waitFor(() => fs.existsSync(path.join(repo, '.ready')), 'claude to start')
    run.child.kill('SIGKILL')
    await run.done
  } finally {
    killIfAlive(pidFile)
  }
  assert.match(fs.readFileSync(lastResult, 'utf8'), /^\S+ RUNNING /, 'an operator must be able to see that the last run never finished')
})

test('T11 round 3 (F5): a failed write of the last-result file is logged as LAST-RESULT-WRITE-FAILED', () => {
  const repo = makeTempRepo()
  setMarker(repo, 'pass')
  const home = freshHome()
  fs.mkdirSync(path.join(home, LAST_RESULT_REL), { recursive: true })
  const res = runWeeklyScript([repo], { home })
  assert.match(res.logContents, /^LAST-RESULT-WRITE-FAILED$/m, res.logContents)
})

// --- T11 escalation round ----------------------------------------------------

// Finding 1 (gh host-naming denies, the git -C and report-ignore rules, the NO-ROOTED-RULES note) is gone with every
// Bash rule (HARN-RUNNER-2 T3, AC-SEC-16): the session has no shell, and test/harn-runner-2-t3.test.js asserts that
// none of those entries, and none of the code that built them, is present.

// Finding 3: the staged copy is compared with the bytes actually staged (the
// marker), not with the global file, which may change during the run.
// Finding 4: a SIGKILL leftover is deleted only while it still matches its
// marker byte for byte. A developer's edit to it makes it theirs.
// Finding 5: a run that checks nothing is not a PASS.
test('T11 escalation (finding 5): a run in which every configured path is skipped (none is a git repo) FAILs "no repos checked (all skipped)", exits non-zero, notifies once and records FAIL', () => {
  const a = freshDir('plain-a-')
  const b = freshDir('plain-b-')
  const home = freshHome()
  const res = runWeeklyScript([a, b], { home })
  assert.match(res.logContents, new RegExp(`SKIP ${escapeRegExp(label(a))} \\(not a git repo\\)`), 'guard against vacuity: both were skipped')
  assert.match(res.logContents, /^RESULT FAIL - reason="no repos checked \(all skipped\)"$/m, res.logContents)
  assert.notEqual(res.status, 0, res.logContents)
  assert.equal(res.notifyCalls.length, 1, JSON.stringify(res.notifyCalls))
  assert.match(res.notifyCalls[0].join('\n'), /no repos checked \(all skipped\)/)
  assert.match(fs.readFileSync(path.join(home, LAST_RESULT_REL), 'utf8'), /^\S+ FAIL .*no repos checked \(all skipped\)/)
})

test('T11 escalation (finding 5): an empty repo list still reports only "no repos configured", not a second all-skipped FAIL', () => {
  const res = runWeeklyScript([], { rawRepos: '' })
  assert.match(res.logContents, NO_REPOS_LINE, res.logContents)
  assert.ok(!/all skipped/.test(res.logContents), res.logContents)
})

// Finding 6: an older installed workflow does not accept what the runner hands it;
// such a run would FAIL every repo with a symptom and not the cause.
// Round 4 M3: the fixture is main's real optimise-cycle.js from before this
// change, not a synthetic string. That file already contains the word
// report_path (as a return-value key), so a check that greps for the word
// passes it; only the explicit contract constant tells the two apart.
const PRE_T11_WORKFLOW = path.join(__dirname, 'fixtures', 'optimise-cycle.main-before-t11.js.txt')

test('T11 escalation (finding 6, round 4 M3): the real pre-change optimise-cycle.js from main FAILs the run with a reason naming bin/install.sh, before any collector or claude runs or anything is staged', () => {
  const repo = makeTempRepo()
  const claudeHome = freshDir('claudehome-')
  const old = fs.readFileSync(PRE_T11_WORKFLOW, 'utf8')
  assert.ok(old.length > 10000 && old.includes('report_path'), 'guard against vacuity: the fixture is the real file, and it does contain the word report_path')
  assert.ok(!old.includes('WEEKLY_RUNNER_CONTRACT'), 'and it carries no contract constant')
  withGlobalWorkflow(claudeHome, old)
  const home = freshHome()
  const res = runWeeklyScript([repo], { home, claudeHome, extraPath: argvRecordingClaude() })
  assert.match(res.logContents, /^RESULT FAIL - reason="installed optimise-cycle\.js [^"]*bin\/install\.sh"$/m, res.logContents)
  assert.ok(!/report_path/.test(res.logContents), 'the reason no longer names a mechanism that is gone')
  assert.ok(!/^COLLECT /m.test(res.logContents), 'no collector ran')
  assert.notEqual(res.status, 0)
  assert.equal(res.notifyCalls.length, 1, JSON.stringify(res.notifyCalls))
  assert.match(res.notifyCalls[0].join('\n'), /bin\/install\.sh/)
  assert.match(fs.readFileSync(path.join(home, LAST_RESULT_REL), 'utf8'), / FAIL /)
  assert.equal(fs.existsSync(path.join(repo, '.claude-argv')), false, 'claude must never have run')
  assert.equal(fs.existsSync(path.join(repo, '.claude', 'workflows')), false, 'nothing may be staged')
})

test('T11 escalation (finding 6): the installed optimise-cycle.js this repository ships runs normally', () => {
  const repo = makeTempRepo()
  const claudeHome = freshDir('claudehome-')
  withGlobalWorkflow(claudeHome, fs.readFileSync(path.join(__dirname, '..', 'workflows', 'optimise-cycle.js'), 'utf8'))
  const res = runWeeklyScript([repo], { claudeHome, extraPath: argvRecordingClaude() })
  assert.equal(res.status, 0, res.logContents)
  assert.ok(!/bin\/install\.sh/.test(res.logContents), res.logContents)
})

test('T11 escalation (round 4 M3): the contract the runner requires is the one this repo\'s optimise-cycle.js declares, so the two cannot drift apart unnoticed', () => {
  const runner = fs.readFileSync(SCRIPT_PATH, 'utf8').match(/^REQUIRED_WORKFLOW_CONTRACT=(\d+)$/m)
  const workflow = fs.readFileSync(path.join(__dirname, '..', 'workflows', 'optimise-cycle.js'), 'utf8').match(/^const WEEKLY_RUNNER_CONTRACT = (\d+)$/m)
  assert.ok(runner && workflow, 'both sides declare the contract')
  assert.equal(runner[1], workflow[1])
})

// Round 5 M3: the "lower than required" comparison itself, not only a copy with
// no constant. REQUIRED is read from the runner so the tests follow it when it
// is raised; today REQUIRED-1 is 0, which the check must treat as lower.
function requiredContract() {
  return Number(fs.readFileSync(SCRIPT_PATH, 'utf8').match(/^REQUIRED_WORKFLOW_CONTRACT=(\d+)$/m)[1])
}

test('T11 escalation (round 5 M3): an installed optimise-cycle.js declaring a contract one below the required value FAILs naming bin/install.sh and never invokes claude', () => {
  const required = requiredContract()
  const repo = makeTempRepo()
  const claudeHome = freshDir('claudehome-')
  withGlobalWorkflow(claudeHome, `// an older contract\nconst WEEKLY_RUNNER_CONTRACT = ${required - 1}\n`)
  const res = runWeeklyScript([repo], { claudeHome, extraPath: argvRecordingClaude() })
  assert.match(res.logContents, /^RESULT FAIL - reason="installed optimise-cycle\.js [^"]*bin\/install\.sh"$/m, res.logContents)
  assert.notEqual(res.status, 0)
  assert.equal(fs.existsSync(path.join(repo, '.claude-argv')), false, 'claude must never have run')
})

test('T11 escalation (round 5 M3): an installed optimise-cycle.js declaring a contract one above the required value proceeds to the session', () => {
  const required = requiredContract()
  const repo = makeTempRepo()
  const claudeHome = freshDir('claudehome-')
  withGlobalWorkflow(claudeHome, `// a newer contract\nconst WEEKLY_RUNNER_CONTRACT = ${required + 1}\n`)
  const res = runWeeklyScript([repo], { claudeHome, extraPath: argvRecordingClaude() })
  // The installed file is not a real workflow, so the stand-in session cannot run it: what is pinned is that the run is not
  // stopped for the newer contract and goes on to start the session.
  assert.ok(!/bin\/install\.sh/.test(res.logContents), res.logContents)
  assert.equal(fs.existsSync(path.join(repo, '.claude-argv')), true, 'claude ran')
})

// Round 4 items 2 and 3 (the `git remote get-url origin` rule, and the session's GIT_CONFIG_COUNT carrying
// safe.bareRepository=explicit, including the caller-count cases) are gone: the session has no git (AC-SEC-16), and
// the collector pins safe.bareRepository=explicit on every git command it runs itself (AC-SEC-8, pinned in
// test/harn-runner-2-t1.test.js).

// Finding 7: a timeout names itself.
for (const [code, reason] of [[124, 'timed out after 1260s'], [137, 'killed after timeout grace']]) {
  test(`T11 escalation (finding 7): claude ending with exit ${code} FAILs with the reason "${reason}"`, () => {
    const repo = makeTempRepo()
    const stub = freshDir(`exit-${code}-stub-`)
    fs.writeFileSync(path.join(stub, 'claude'), `#!/bin/sh\nexit ${code}\n`, { mode: 0o755 })
    const res = runWeeklyScript([repo], { extraPath: stub })
    const line = extractResultLine(res.logContents, 'FAIL', label(repo))
    assert.ok(line.includes(`reason="${reason}`), line)
    assert.ok(!line.includes(`claude exited ${code}`), `the bare exit code names no cause:\n${line}`)
    assert.match(res.notifyCalls[0].join('\n'), new RegExp(escapeRegExp(reason)))
  })
}
