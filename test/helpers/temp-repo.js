// Shared helper for tests that need a real, throwaway git repo to run
// workflows/lib/ledger-append.mjs against. Used by test/ledger-append.test.js
// and test/ledger-seam.test.js (>=2 call sites, so a shared module rather
// than duplicated per file). SUITE_TMPDIR (round 3, item 4) is also reused
// directly by test/shell-injection.test.js for its PWNED_LEDGER marker
// files -- same class of leak (M4), same isolated-root-plus-exit-hook fix,
// so it reuses this module's existing mechanism rather than duplicating it.
//
// M4: every directory created via makeTempRepo() used to sit directly in the
// developer's shared TMPDIR, and cleanup only ran via test.after
// (cleanupTempRepos), which a test file that never reaches its after-hook --
// or simply never calls it -- skips entirely: measured at 2 failures in 71
// runs on a shared TMPDIR (getcwd errors after a directory vanished mid-setup)
// and 8 leftover repos after one deliberately failing test. The fix has two
// parts: (1) every repo this module creates is a child of ONE isolated
// mkdtemp'd root created once per process, not scattered directly across the
// developer's shared TMPDIR, which removes the collision surface a sweeper or
// another process's cleanup could hit; (2) that root is removed
// UNCONDITIONALLY via a process 'exit' handler, which fires whether the
// process's tests passed or failed (including process.exit() being called
// explicitly), rather than relying solely on every test file remembering to
// register test.after(cleanupTempRepos).
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { execFileSync, spawnSync } = require('node:child_process')
const { scrubGitEnv, sanitizedGitEnv } = require('./git-env.js')

// At module load, so every call site in the suite is covered -- including
// the ones that never import this helper and the child processes that
// inherit this env. See git-env.js for why cwd does not protect you.
scrubGitEnv()

const APPEND_SCRIPT = path.join(__dirname, '..', '..', 'workflows', 'lib', 'ledger-append.mjs')
const LEDGER_REL = '.claude/harness-ledger.jsonl'

// One parent temp root per process, isolating this suite's temp repos from
// the shared TMPDIR namespace entirely.
const SUITE_TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-append-suite-'))
if (!fs.existsSync(SUITE_TMPDIR)) {
  throw new Error(`temp-repo.js: the suite temp root vanished immediately after mkdtempSync (${SUITE_TMPDIR}) -- something outside this process is sweeping it`)
}

// Removes the ENTIRE suite temp root in one shot, regardless of how the
// process is exiting (a clean run, a failed test whose assertion the test
// runner caught, or an explicit process.exit()). This is the guard against
// leaks that test.after alone cannot provide -- it does not depend on any
// test file reaching or registering an after-hook at all.
process.on('exit', () => {
  try {
    fs.rmSync(SUITE_TMPDIR, { recursive: true, force: true })
  } catch (e) {
    // best-effort: never let cleanup itself crash the exit sequence
  }
})

const created = []

function sh(cmd, cwd) {
  return execFileSync('/bin/sh', ['-c', cmd], { cwd, encoding: 'utf8', env: sanitizedGitEnv() })
}

function makeTempRepo() {
  const dir = fs.mkdtempSync(path.join(SUITE_TMPDIR, 'repo-'))
  if (!fs.existsSync(dir)) {
    throw new Error(`temp-repo.js: makeTempRepo's directory vanished immediately after mkdtempSync (${dir}) -- not a git-init failure, the directory itself is gone`)
  }
  created.push(dir)
  sh('git init -q -b main', dir)
  if (!fs.existsSync(dir)) {
    throw new Error(`temp-repo.js: makeTempRepo's directory vanished during git init (${dir}) -- something removed it mid-setup`)
  }
  // Defence in depth against a git environment variable that outranks cwd
  // (git-env.js). The scrub above should make this unreachable; this
  // assertion is what makes a FUTURE unsanitised call site fail by name here
  // instead of silently committing fixtures into a real repository. It is
  // deliberately a resolved-identity check rather than a `.git` existence
  // check, because GIT_DIR can point anywhere while a stray `.git` still
  // exists locally.
  //
  // Neither side is realpath'd through `dir/.git` itself: in exactly the
  // case this catches, that path was never created (git re-initialised the
  // repo GIT_DIR named instead), so realpathSync would throw ENOENT and the
  // assertion would report a missing file rather than the escape. Compare
  // containment under `dir`, which always exists by this point.
  const resolvedGitDir = sh('git rev-parse --absolute-git-dir', dir).trim()
  const expectedRoot = fs.realpathSync(dir)
  const resolvedReal = fs.existsSync(resolvedGitDir) ? fs.realpathSync(resolvedGitDir) : resolvedGitDir
  if (!resolvedReal.startsWith(expectedRoot + path.sep)) {
    throw new Error(
      `temp-repo.js: makeTempRepo's git context escaped its own directory -- git resolved ${resolvedGitDir}, expected something under ${expectedRoot}. ` +
        'A git environment variable (GIT_DIR and friends) is overriding cwd, so fixture commands would land in that repository instead. ' +
        'Sanitise the environment at the offending call site via helpers/git-env.js.'
    )
  }
  sh('git config user.email test@example.com', dir)
  sh('git config user.name Test', dir)
  fs.writeFileSync(path.join(dir, 'README.md'), 'seed\n')
  sh('git add README.md && git commit -q -m seed', dir)
  return dir
}

function runAppend(cwd, payload) {
  // ledger-append.mjs shells out to git itself, including a write via
  // ensureGitignored(), so this spawn needs the same sanitising as a direct
  // git call -- the script-spawn case, not just the git-spawn case.
  return spawnSync('node', [APPEND_SCRIPT], { cwd, input: JSON.stringify(payload), encoding: 'utf8', env: sanitizedGitEnv() })
}

function readLedgerLines(repoRoot) {
  const p = path.join(repoRoot, LEDGER_REL)
  if (!fs.existsSync(p)) return []
  const raw = fs.readFileSync(p, 'utf8')
  return raw.split('\n').filter(Boolean)
}

// Register a directory created some other way (e.g. a worktree parent) for
// cleanup, without going through makeTempRepo().
function trackTempDir(dir) {
  created.push(dir)
}

function cleanupTempRepos() {
  for (const dir of created.splice(0, created.length)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

module.exports = { APPEND_SCRIPT, LEDGER_REL, SUITE_TMPDIR, sh, sanitizedGitEnv, makeTempRepo, runAppend, readLedgerLines, trackTempDir, cleanupTempRepos }
