// Shared helper for tests that need a real, throwaway git repo to run
// workflows/lib/ledger-append.mjs against. Used by test/ledger-append.test.js
// and test/ledger-seam.test.js (>=2 call sites, so a shared module rather
// than duplicated per file).
//
// Every directory created via makeTempRepo() is tracked and removed by
// cleanupTempRepos(), which callers register once via
// `test.after(cleanupTempRepos)` (L4: the previous version of this helper
// leaked one directory per test with no cleanup at all).
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { execFileSync, spawnSync } = require('node:child_process')

const APPEND_SCRIPT = path.join(__dirname, '..', '..', 'workflows', 'lib', 'ledger-append.mjs')
const LEDGER_REL = '.claude/harness-ledger.jsonl'

const created = []

function sh(cmd, cwd) {
  return execFileSync('/bin/sh', ['-c', cmd], { cwd, encoding: 'utf8' })
}

function makeTempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-append-test-'))
  created.push(dir)
  sh('git init -q -b main', dir)
  sh('git config user.email test@example.com', dir)
  sh('git config user.name Test', dir)
  fs.writeFileSync(path.join(dir, 'README.md'), 'seed\n')
  sh('git add README.md && git commit -q -m seed', dir)
  return dir
}

function runAppend(cwd, payload) {
  return spawnSync('node', [APPEND_SCRIPT], { cwd, input: JSON.stringify(payload), encoding: 'utf8' })
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

module.exports = { APPEND_SCRIPT, LEDGER_REL, sh, makeTempRepo, runAppend, readLedgerLines, trackTempDir, cleanupTempRepos }
