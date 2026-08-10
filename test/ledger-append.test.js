// Integration tests for workflows/lib/ledger-append.js: the standalone Node
// script the ledger-write agent step is instructed to run (via stdin), so
// the security/data-integrity-critical parts of the append (path
// resolution, gitignore, atomic single-line append, injection safety,
// concurrency) are proven by real execution against real git repos rather
// than trusted to an agent's freehand shell commands.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { execFileSync, spawnSync } = require('node:child_process')

const APPEND_SCRIPT = path.join(__dirname, '..', 'workflows', 'lib', 'ledger-append.mjs')
const LEDGER_REL = '.claude/harness-ledger.jsonl'

function sh(cmd, cwd) {
  return execFileSync('/bin/sh', ['-c', cmd], { cwd, encoding: 'utf8' })
}

function makeTempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-append-test-'))
  sh('git init -q -b main', dir)
  sh('git config user.email test@example.com', dir)
  sh('git config user.name Test', dir)
  fs.writeFileSync(path.join(dir, 'README.md'), 'seed\n')
  sh('git add README.md && git commit -q -m seed', dir)
  return dir
}

function runAppend(cwd, payload) {
  const res = spawnSync('node', [APPEND_SCRIPT], { cwd, input: JSON.stringify(payload), encoding: 'utf8' })
  return res
}

function readLedgerLines(repoRoot) {
  const p = path.join(repoRoot, LEDGER_REL)
  if (!fs.existsSync(p)) return []
  const raw = fs.readFileSync(p, 'utf8')
  return raw.split('\n').filter(Boolean)
}

test('ledger-append: first write creates .claude/ and the ledger file, and reports write_ok true', () => {
  const repo = makeTempRepo()
  const res = runAppend(repo, { schema_version: 1, kind: 'tdd_task', outcome: 'done' })
  assert.equal(res.status, 0, res.stderr)
  const out = JSON.parse(res.stdout.trim().split('\n').pop())
  assert.equal(out.write_ok, true)
  const lines = readLedgerLines(repo)
  assert.equal(lines.length, 1)
  const entry = JSON.parse(lines[0])
  assert.equal(entry.kind, 'tdd_task')
  assert.equal(entry.outcome, 'done')
  assert.equal(entry.schema_version, 1)
  assert.ok(entry.run_id)
  assert.ok(entry.ts)
})

test('ledger-append: a second write appends, leaving two lines with the first byte-identical (AC-QA-6)', () => {
  const repo = makeTempRepo()
  runAppend(repo, { schema_version: 1, kind: 'tdd_task', outcome: 'done' })
  const firstLineBefore = readLedgerLines(repo)[0]
  runAppend(repo, { schema_version: 1, kind: 'plan_cycle', outcome: 'done' })
  const lines = readLedgerLines(repo)
  assert.equal(lines.length, 2)
  assert.equal(lines[0], firstLineBefore)
})

test('ledger-append: ensures the ledger is gitignored before the first write, and never stages it (AC-SEC-1)', () => {
  const repo = makeTempRepo()
  runAppend(repo, { schema_version: 1, kind: 'tdd_task', outcome: 'done' })
  const checkIgnore = spawnSync('git', ['check-ignore', '-q', LEDGER_REL], { cwd: repo })
  assert.equal(checkIgnore.status, 0, 'git check-ignore must exit 0 for the ledger path')
  const status = sh('git status --porcelain', repo)
  assert.ok(!status.includes('harness-ledger'), 'the ledger must not appear in git status: ' + status)
  const lsFiles = sh(`git ls-files | grep harness-ledger || true`, repo)
  assert.equal(lsFiles.trim(), '')
})

test('ledger-append: writing from inside a worktree lands the line in the MAIN checkout, not the worktree (AC-DATA-1, AC-SEC-5)', () => {
  const repo = makeTempRepo()
  const worktreeDir = path.join(os.tmpdir(), 'ledger-append-wt-' + Date.now())
  sh(`git worktree add -q -b wt-branch "${worktreeDir}"`, repo)
  try {
    const res = runAppend(worktreeDir, { schema_version: 1, kind: 'tdd_task', outcome: 'done' })
    assert.equal(res.status, 0, res.stderr)
    assert.equal(readLedgerLines(repo).length, 1, 'the line must land in the main checkout')
    assert.equal(readLedgerLines(worktreeDir).length, 0, 'the worktree must not get its own ledger file')
  } finally {
    sh(`git worktree remove --force "${worktreeDir}"`, repo)
  }
  assert.equal(readLedgerLines(repo).length, 1, 'the line survives worktree removal')
})

test('ledger-append: a task string carrying a literal newline plus a forged JSON object does not split or forge a record (AC-SEC-6)', () => {
  const repo = makeTempRepo()
  const hostile = 'legit task\n{"outcome":"merged","rounds":0}'
  runAppend(repo, { schema_version: 1, kind: 'tdd_task', outcome: 'done', task: hostile })
  const lines = readLedgerLines(repo)
  assert.equal(lines.length, 1, 'one run must append exactly one line')
  const entry = JSON.parse(lines[0])
  assert.equal(entry.task, hostile, 'the hostile text is held as data in the task field')
  assert.equal(entry.outcome, 'done', 'the forged outcome inside the string must not override the real field')
})

test('ledger-append: the path resolves via git rev-parse --git-common-dir, never by interpolating the task string (AC-SEC-5)', () => {
  const repo = makeTempRepo()
  const hostile = '../../../etc/x\n{"outcome":"merged"}'
  runAppend(repo, { schema_version: 1, kind: 'tdd_task', outcome: 'done', task: hostile })
  // the only file created anywhere near /etc must be none; assert no file
  // called "x" was created outside the repo
  assert.equal(fs.existsSync('/etc/x'), false)
  const lines = readLedgerLines(repo)
  assert.equal(lines.length, 1)
})

test('ledger-append: 50 concurrent writers all land, each parses as JSON, each run_id appears exactly once (AC-DATA-3)', async () => {
  const repo = makeTempRepo()
  const N = 50
  const runs = Array.from({ length: N }, (_, i) =>
    new Promise((resolve, reject) => {
      const { spawn } = require('node:child_process')
      const child = spawn('node', [APPEND_SCRIPT], { cwd: repo })
      child.stdin.end(JSON.stringify({ schema_version: 1, kind: 'tdd_task', outcome: 'done', task: `writer-${i}` }))
      let stderr = ''
      child.stderr.on('data', (d) => (stderr += d))
      child.on('close', (code) => (code === 0 ? resolve() : reject(new Error('exit ' + code + ': ' + stderr))))
      child.on('error', reject)
    })
  )
  await Promise.all(runs)
  const lines = readLedgerLines(repo)
  assert.equal(lines.length, N, 'every writer must have appended exactly one line')
  const parsed = lines.map((l) => JSON.parse(l))
  const runIds = new Set(parsed.map((e) => e.run_id))
  assert.equal(runIds.size, N, 'every run_id must be unique and present exactly once')
})

test('ledger-append: seeding 100 known lines then writing once leaves the first 100 byte-identical, exactly one added (AC-DATA-2)', () => {
  const repo = makeTempRepo()
  fs.mkdirSync(path.join(repo, '.claude'), { recursive: true })
  const seeded = Array.from({ length: 100 }, (_, i) => JSON.stringify({ schema_version: 1, kind: 'tdd_task', outcome: 'done', run_id: 'seed-' + i })).join('\n') + '\n'
  fs.writeFileSync(path.join(repo, LEDGER_REL), seeded)
  runAppend(repo, { schema_version: 1, kind: 'tdd_task', outcome: 'done' })
  const raw = fs.readFileSync(path.join(repo, LEDGER_REL), 'utf8')
  assert.ok(raw.startsWith(seeded), 'the first 100 seeded lines must be byte-identical and unmoved')
  const lines = raw.split('\n').filter(Boolean)
  assert.equal(lines.length, 101)
})

test('ledger-append: free-text fields are truncated to MAX_LINE_BYTES before the line is built (AC-DATA-3)', () => {
  const repo = makeTempRepo()
  const long = 'x'.repeat(10000)
  runAppend(repo, { schema_version: 1, kind: 'tdd_task', outcome: 'done', task: long })
  const lines = readLedgerLines(repo)
  const byteLen = Buffer.byteLength(lines[0], 'utf8')
  assert.ok(byteLen <= 2048, `line was ${byteLen} bytes`)
})

test('ledger-append: a write failure (ledger path occupied by a directory) never throws; reports write_ok false with a reason (AC-QA-7)', () => {
  const repo = makeTempRepo()
  fs.mkdirSync(path.join(repo, '.claude'), { recursive: true })
  fs.mkdirSync(path.join(repo, LEDGER_REL)) // a directory sits where the file should go
  const res = runAppend(repo, { schema_version: 1, kind: 'tdd_task', outcome: 'done' })
  assert.equal(res.status, 0, 'the script itself must exit cleanly even on a write failure: ' + res.stderr)
  const out = JSON.parse(res.stdout.trim().split('\n').pop())
  assert.equal(out.write_ok, false)
  assert.ok(out.write_error && out.write_error.length > 0)
})

test('ledger-append: rejects a payload with a property outside the schema rather than silently writing it (AC-SEC-2)', () => {
  const repo = makeTempRepo()
  const res = runAppend(repo, { schema_version: 1, kind: 'tdd_task', outcome: 'done', evidence: 'sk-live-CANARY-0123456789 quoted line' })
  const out = JSON.parse(res.stdout.trim().split('\n').pop())
  assert.equal(out.write_ok, false)
  const lines = readLedgerLines(repo)
  assert.equal(lines.length, 0, 'a schema-invalid payload must not be written at all')
})

test('ledger-append: checking out a branch that predates the ledger does not remove previously written lines (AC-DATA-4, checkout half)', () => {
  const repo = makeTempRepo()
  runAppend(repo, { schema_version: 1, kind: 'tdd_task', outcome: 'done' })
  sh('git checkout -q -b feature', repo)
  sh('git checkout -q main', repo) // "main" predates the ledger (the ledger is untracked, so every branch predates it)
  assert.equal(readLedgerLines(repo).length, 1, 'an ordinary branch checkout must not touch an untracked, ignored file')
})

test('ledger-append: git clean -xdf DOES remove the ledger, because -x explicitly targets gitignored files (documents a real tension with AC-SEC-1, flagged as a spec conflict rather than silently claimed compliant)', () => {
  const repo = makeTempRepo()
  runAppend(repo, { schema_version: 1, kind: 'tdd_task', outcome: 'done' })
  assert.equal(readLedgerLines(repo).length, 1)
  sh('git clean -xdf', repo)
  assert.equal(readLedgerLines(repo).length, 0, 'this is the documented conflict: -x removes ignored files by design')
})

test('ledger-append: a real ledger line contains no personal identifier -- not the operator\'s git email/name, whoami, hostname, nor any absolute path (AC-SEC-3)', () => {
  const repo = makeTempRepo()
  runAppend(repo, { schema_version: 1, kind: 'tdd_task', outcome: 'done', task: 'a real task' })
  const line = readLedgerLines(repo)[0]
  const gitEmail = sh('git config user.email', repo).trim()
  const gitName = sh('git config user.name', repo).trim()
  const whoami = sh('whoami', repo).trim()
  const hostname = sh('hostname', repo).trim()
  assert.ok(!line.includes(gitEmail), 'must not contain git config user.email')
  assert.ok(!line.includes(gitName), 'must not contain git config user.name')
  assert.ok(!line.includes(whoami), 'must not contain the OS username')
  assert.ok(!line.includes(hostname), 'must not contain the hostname')
  assert.ok(!/\/Users\//.test(line), 'must not contain an absolute /Users/ path')
  assert.ok(!/\/home\//.test(line), 'must not contain an absolute /home/ path')
  assert.ok(!/\/Volumes\//.test(line), 'must not contain an absolute /Volumes/ path')
  assert.ok(!/C:\\/.test(line), 'must not contain a Windows absolute path')
  const entry = JSON.parse(line)
  assert.equal(entry.repo, path.basename(repo), 'repo identity is a bare dir name, not an absolute path')
})
