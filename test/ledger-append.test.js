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
const { pathToFileURL } = require('node:url')
const { spawnSync } = require('node:child_process')
const { APPEND_SCRIPT, LEDGER_REL, sh, makeTempRepo, runAppend, readLedgerLines, trackTempDir, cleanupTempRepos } = require('./helpers/temp-repo.js')

const APPEND_MODULE_URL = pathToFileURL(APPEND_SCRIPT).href

// L4: every makeTempRepo() call in this file is tracked by the shared
// helper and removed here, once, after the whole file's tests finish.
test.after(cleanupTempRepos)

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

test('ledger-append: ts is real ISO-8601 UTC with milliseconds, and is close to the test\'s own clock at write time (M5: the only prior assertion was assert.ok(entry.ts), which "not-a-timestamp" satisfies)', () => {
  const repo = makeTempRepo()
  const before = Date.now()
  runAppend(repo, { schema_version: 1, kind: 'tdd_task', outcome: 'done' })
  const after = Date.now()
  const entry = JSON.parse(readLedgerLines(repo)[0])
  assert.match(entry.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, `ts was not ISO-8601 UTC with milliseconds: ${entry.ts}`)
  const parsed = Date.parse(entry.ts)
  assert.ok(!Number.isNaN(parsed), `ts did not parse as a real date: ${entry.ts}`)
  assert.ok(parsed >= before - 1000 && parsed <= after + 1000, `ts (${entry.ts}) was not within a second of the write actually happening`)
})

test('ledger-append: two successive writes have non-decreasing timestamps (M5)', async () => {
  const repo = makeTempRepo()
  runAppend(repo, { schema_version: 1, kind: 'tdd_task', outcome: 'done' })
  await new Promise((resolve) => setTimeout(resolve, 5))
  runAppend(repo, { schema_version: 1, kind: 'tdd_task', outcome: 'done' })
  const [first, second] = readLedgerLines(repo).map((l) => JSON.parse(l))
  assert.ok(Date.parse(second.ts) >= Date.parse(first.ts), `ts went backwards: ${first.ts} then ${second.ts}`)
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

test('ledger-append: a repo with a COMMITTED .gitignore is left completely untouched -- no diff, nothing to stage (M7: the old ensureGitignored edited the user\'s own tracked .gitignore in place, so `git status --porcelain` reported it modified; .git/info/exclude is untracked, repo-local, and has the identical ignore effect without touching anything the operator owns)', () => {
  const repo = makeTempRepo()
  fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n*.log\n')
  sh('git add .gitignore && git commit -q -m "add gitignore"', repo)
  const gitignoreBefore = fs.readFileSync(path.join(repo, '.gitignore'), 'utf8')

  runAppend(repo, { schema_version: 1, kind: 'tdd_task', outcome: 'done' })

  const gitignoreAfter = fs.readFileSync(path.join(repo, '.gitignore'), 'utf8')
  assert.equal(gitignoreAfter, gitignoreBefore, 'the tracked .gitignore must be byte-identical: it must never be edited')
  const status = sh('git status --porcelain', repo)
  assert.equal(status.trim(), '', `the working tree must be completely clean, nothing to stage: got ${JSON.stringify(status)}`)
  const checkIgnore = spawnSync('git', ['check-ignore', '-q', LEDGER_REL], { cwd: repo })
  assert.equal(checkIgnore.status, 0, 'the ledger must still be ignored (via .git/info/exclude, not .gitignore)')
})

test('ledger-append: the ledger is ignored via .git/info/exclude, which is itself untracked and repo-local (M7)', () => {
  const repo = makeTempRepo()
  runAppend(repo, { schema_version: 1, kind: 'tdd_task', outcome: 'done' })
  const excludeContents = fs.readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf8')
  assert.ok(excludeContents.includes(LEDGER_REL), '.git/info/exclude must list the ledger path')
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

test('ledger-append: a write-failure error message does not echo the repo\'s absolute path (L6, the failure-path variant of H2)', () => {
  const repo = makeTempRepo()
  fs.mkdirSync(path.join(repo, '.claude'), { recursive: true })
  fs.mkdirSync(path.join(repo, LEDGER_REL)) // a directory sits where the file should go, forcing an EISDIR
  const res = runAppend(repo, { schema_version: 1, kind: 'tdd_task', outcome: 'done' })
  const out = JSON.parse(res.stdout.trim().split('\n').pop())
  assert.equal(out.write_ok, false)
  assert.ok(!out.write_error.includes(repo), `write_error echoed the repo's absolute path: ${out.write_error}`)
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

function assertNoAbsolutePaths(line, label) {
  assert.ok(!/\/Users\//.test(line), `${label}: must not contain an absolute /Users/ path`)
  assert.ok(!/\/home\//.test(line), `${label}: must not contain an absolute /home/ path`)
  assert.ok(!/\/Volumes\//.test(line), `${label}: must not contain an absolute /Volumes/ path`)
  assert.ok(!/C:\\/.test(line), `${label}: must not contain a Windows absolute path`)
}

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
  assertNoAbsolutePaths(line, 'plain task')
  const entry = JSON.parse(line)
  assert.equal(entry.repo, path.basename(repo), 'repo identity is a bare dir name, not an absolute path')
})

test('ledger-append: an absolute spec path UNDER the repo root is relativised, not rejected, and never appears absolute in the line (H2, AC-SEC-3)', () => {
  const repo = makeTempRepo()
  const absoluteSpec = path.join(repo, 'specs', 'optimise-cycle.md')
  const res = runAppend(repo, { schema_version: 1, kind: 'review_cycle', outcome: 'done', spec: absoluteSpec })
  const out = JSON.parse(res.stdout.trim().split('\n').pop())
  assert.equal(out.write_ok, true, out.write_error)
  const line = readLedgerLines(repo)[0]
  assertNoAbsolutePaths(line, 'relativised spec')
  assert.ok(!line.includes(repo), 'the line must not contain the repo\'s own absolute temp-dir path either')
  const entry = JSON.parse(line)
  assert.equal(entry.spec, 'specs/optimise-cycle.md', 'spec must be relativised against the repo root')
})

test('ledger-append: a task string containing an embedded absolute path has that path relativised/redacted, never left absolute, in the line (H2, AC-SEC-3)', () => {
  const repo = makeTempRepo()
  const absolutePathInText = path.join(repo, 'src', 'foo.js')
  const res = runAppend(repo, { schema_version: 1, kind: 'tdd_task', outcome: 'done', task: `fix the bug in ${absolutePathInText}` })
  const out = JSON.parse(res.stdout.trim().split('\n').pop())
  assert.equal(out.write_ok, true, out.write_error)
  const line = readLedgerLines(repo)[0]
  assertNoAbsolutePaths(line, 'task with embedded absolute path')
  assert.ok(!line.includes(repo), 'the line must not contain the repo\'s own absolute temp-dir path either')
  const entry = JSON.parse(line)
  assert.ok(entry.task.includes('src/foo.js'), `expected the relativised path to survive as data: ${entry.task}`)
})

test('ledger-append: an absolute spec path OUTSIDE the repo root cannot be relativised and is redacted rather than leaked verbatim (H2)', () => {
  const repo = makeTempRepo()
  const res = runAppend(repo, { schema_version: 1, kind: 'review_cycle', outcome: 'done', spec: '/etc/some-other-machines-file.md' })
  const out = JSON.parse(res.stdout.trim().split('\n').pop())
  assert.equal(out.write_ok, true, out.write_error)
  const line = readLedgerLines(repo)[0]
  assert.ok(!line.includes('/etc/some-other-machines-file.md'), 'an out-of-repo absolute path must never reach the ledger verbatim')
})

test('ledger-append: reuses a caller-supplied run_id instead of generating a fresh one, so a start record and its terminal record can share identity (AC-DATA-5)', () => {
  const repo = makeTempRepo()
  const startRes = runAppend(repo, { schema_version: 1, kind: 'tdd_task', outcome: 'started' })
  const startOut = JSON.parse(startRes.stdout.trim().split('\n').pop())
  runAppend(repo, { schema_version: 1, kind: 'tdd_task', outcome: 'done', run_id: startOut.run_id })
  const lines = readLedgerLines(repo).map((l) => JSON.parse(l))
  assert.equal(lines.length, 2)
  assert.equal(lines[0].outcome, 'started')
  assert.equal(lines[1].outcome, 'done')
  assert.equal(lines[0].run_id, lines[1].run_id, 'the start and terminal records must share one run_id')
})

test('ledger-append: a start record with no matching terminal record (run killed mid-flight) leaves the start line intact and parseable, distinguishable by its run_id having no "done"/"blocked"/"aborted" companion (AC-DATA-5)', () => {
  const repo = makeTempRepo()
  const startRes = runAppend(repo, { schema_version: 1, kind: 'tdd_task', outcome: 'started' })
  const startOut = JSON.parse(startRes.stdout.trim().split('\n').pop())
  // simulate the process being killed before the terminal write ever runs
  const lines = readLedgerLines(repo).map((l) => JSON.parse(l))
  assert.equal(lines.length, 1)
  assert.equal(lines[0].outcome, 'started')
  assert.equal(lines[0].run_id, startOut.run_id)
  const terminalOutcomes = lines.filter((l) => l.run_id === startOut.run_id && l.outcome !== 'started')
  assert.equal(terminalOutcomes.length, 0, 'a reader can tell this run_id has a start but no terminal record: aborted/unterminated')
})

// ---- Finding computation moved from review-cycle.js (workflow scripts have
// no node:crypto, so they can no longer compute findingId themselves; they
// send raw spec_bugs/rejected_findings descriptors and ledger-append.mjs
// computes ids and dispositions -- AC-QA-11's "derived mechanically in
// script code" is satisfied by this being real-Node script code). ----

test('ledger-append: computes findings + counts from raw spec_bugs/rejected_findings arrays (AC-QA-13, AC-QA-11)', () => {
  const repo = makeTempRepo()
  runAppend(repo, {
    schema_version: 1,
    kind: 'review_cycle',
    outcome: 'done',
    spec_bugs: [{ lens: 'lens-qa', location: 'foo.js:1', claim: 'no AC covers this' }],
    rejected_findings: [{ lens: 'lens-security', location: 'bar.js:2', claim: 'false alarm', ac_id: 'AC-SEC-1' }],
  })
  const entry = JSON.parse(readLedgerLines(repo)[0])
  assert.equal(entry.spec_bug_count, 1)
  assert.equal(entry.rejected_finding_count, 1)
  assert.equal(entry.findings.length, 2)
  assert.ok(entry.findings.every((f) => f.id && f.lens && f.severity && f.disposition))
  assert.ok(entry.findings.some((f) => f.disposition === 'spec_bug'))
  assert.ok(entry.findings.some((f) => f.disposition === 'rejected' && f.ac_id === 'AC-SEC-1'))
  assert.ok(!('spec_bugs' in entry), 'the raw descriptor array must not itself reach the schema-validated entry')
  assert.ok(!('rejected_findings' in entry))
})

test('ledger-append: spec_bugs/rejected_findings sent as null (malformed synthesis) yields null counts, not zero (AC-QA-13, AC-OPS-3)', () => {
  const repo = makeTempRepo()
  runAppend(repo, { schema_version: 1, kind: 'review_cycle', outcome: 'done', spec_bugs: null, rejected_findings: null })
  const entry = JSON.parse(readLedgerLines(repo)[0])
  assert.equal(entry.spec_bug_count, null)
  assert.equal(entry.rejected_finding_count, null)
  assert.deepEqual(entry.findings, [])
})

test('ledger-append: a real empty array of spec_bugs/rejected_findings yields a genuine zero count, distinguishable from null (AC-OPS-3)', () => {
  const repo = makeTempRepo()
  runAppend(repo, { schema_version: 1, kind: 'review_cycle', outcome: 'done', spec_bugs: [], rejected_findings: [] })
  const entry = JSON.parse(readLedgerLines(repo)[0])
  assert.equal(entry.spec_bug_count, 0)
  assert.equal(entry.rejected_finding_count, 0)
})

test('ledger-append: finding ids are stable across two separate invocations with identical descriptors (AC-QA-11)', () => {
  const repoA = makeTempRepo()
  const repoB = makeTempRepo()
  const descriptor = { spec_bugs: [{ lens: 'lens-qa', location: 'foo.js:1', claim: 'no AC covers this' }], rejected_findings: [] }
  runAppend(repoA, { schema_version: 1, kind: 'review_cycle', outcome: 'done', ...descriptor })
  runAppend(repoB, { schema_version: 1, kind: 'review_cycle', outcome: 'done', ...descriptor })
  const entryA = JSON.parse(readLedgerLines(repoA)[0])
  const entryB = JSON.parse(readLedgerLines(repoB)[0])
  assert.equal(entryA.findings[0].id, entryB.findings[0].id)
})

test('ledger-append: two different defects at the same file:line yield different finding ids (AC-QA-11)', () => {
  const repo = makeTempRepo()
  runAppend(repo, {
    schema_version: 1,
    kind: 'review_cycle',
    outcome: 'done',
    spec_bugs: [
      { lens: 'lens-qa', location: 'foo.js:10', claim: 'missing input validation' },
      { lens: 'lens-qa', location: 'foo.js:10', claim: 'SQL injection via string concat' },
    ],
    rejected_findings: [],
  })
  const entry = JSON.parse(readLedgerLines(repo)[0])
  assert.notEqual(entry.findings[0].id, entry.findings[1].id)
})

// ---- Unit tests for the pure functions, relocated from the now-deleted
// workflows/lib/ledger.mjs: they live in ledger-append.mjs now, since it is
// the sole real-Node script permitted to use node:crypto and own the
// schema; workflow scripts cannot import them (see docs/pr1-mutation-proofs.md). ----

test('ledger-append module: exposes a hard-coded relative path, not a configurable one (AC-SIMP-2)', async () => {
  const { LEDGER_RELATIVE_PATH } = await import(APPEND_MODULE_URL)
  assert.equal(LEDGER_RELATIVE_PATH, '.claude/harness-ledger.jsonl')
})

test('ledger-append module: importing it for its exports does not itself write a ledger line (main() is guarded)', async () => {
  const repo = makeTempRepo()
  const before = readLedgerLines(repo).length
  await import(APPEND_MODULE_URL)
  assert.equal(readLedgerLines(repo).length, before, 'import must not run main() as a side effect')
})

test('ledger-append module: findingId is stable for the same lens+location+claim', async () => {
  const { findingId } = await import(APPEND_MODULE_URL)
  assert.equal(findingId('lens-security', 'foo.js:10', 'x'), findingId('lens-security', 'foo.js:10', 'x'))
})

test('ledger-append module: findingId differs across lenses for identical location and claim text', async () => {
  const { findingId } = await import(APPEND_MODULE_URL)
  assert.notEqual(findingId('lens-security', 'foo.js:10', 'same'), findingId('lens-qa', 'foo.js:10', 'same'))
})

test('ledger-append module: truncate bounds long strings and passes null/undefined through unchanged', async () => {
  const { truncate } = await import(APPEND_MODULE_URL)
  assert.equal(truncate('short', 100), 'short')
  assert.ok(truncate('x'.repeat(1000), 50).length <= 50)
  assert.equal(truncate(null, 10), null)
  assert.equal(truncate(undefined, 10), undefined)
})

test('ledger-append module: validateEntry rejects an entry with an unknown top-level property (additionalProperties:false, AC-SEC-2)', async () => {
  const { validateEntry } = await import(APPEND_MODULE_URL)
  const entry = { schema_version: 1, run_id: 'r', ts: 't', repo: 'r', kind: 'tdd_task', outcome: 'done', write_ok: true, write_error: null, evidence: 'leak' }
  const errors = validateEntry(entry)
  assert.ok(errors.some((e) => /evidence/.test(e)))
})

test('ledger-append module: validateEntry rejects a missing required field', async () => {
  const { validateEntry } = await import(APPEND_MODULE_URL)
  const errors = validateEntry({ run_id: 'r', ts: 't', repo: 'r', kind: 'tdd_task', outcome: 'done', write_ok: true, write_error: null })
  assert.ok(errors.some((e) => /schema_version/.test(e)))
})

test('ledger-append module: LEDGER_ENTRY_SCHEMA never declares an "evidence", "location" or "report" property (AC-SEC-2)', async () => {
  const { LEDGER_ENTRY_SCHEMA } = await import(APPEND_MODULE_URL)
  const props = Object.keys(LEDGER_ENTRY_SCHEMA.properties)
  assert.ok(!props.includes('evidence'))
  assert.ok(!props.includes('location'))
  assert.ok(!props.includes('report'))
})

test('ledger-append module: findings schema entries only carry lens, severity, ac id and disposition (AC-SEC-2)', async () => {
  const { LEDGER_ENTRY_SCHEMA } = await import(APPEND_MODULE_URL)
  const findingProps = Object.keys(LEDGER_ENTRY_SCHEMA.properties.findings.items.properties)
  assert.deepEqual(findingProps.sort(), ['ac_id', 'disposition', 'id', 'lens', 'severity'])
  assert.equal(LEDGER_ENTRY_SCHEMA.properties.findings.items.additionalProperties, false)
})

test('ledger-append module: MAX_LINE_BYTES is a small fixed bound suitable for a single atomic write()', async () => {
  const { MAX_LINE_BYTES } = await import(APPEND_MODULE_URL)
  assert.ok(MAX_LINE_BYTES > 0 && MAX_LINE_BYTES <= 4096)
})

test('ledger-append: computes an "open" disposition for open_findings, alongside spec_bug/rejected (H5)', () => {
  const repo = makeTempRepo()
  runAppend(repo, {
    schema_version: 1,
    kind: 'review_cycle',
    outcome: 'done',
    open_findings: [{ lens: 'lens-security', location: 'foo.js:10', claim: 'missing auth check', severity: 'High' }],
  })
  const entry = JSON.parse(readLedgerLines(repo)[0])
  assert.equal(entry.findings.length, 1)
  assert.equal(entry.findings[0].disposition, 'open')
  assert.equal(entry.findings[0].lens, 'lens-security')
  assert.equal(entry.findings[0].severity, 'High')
  assert.ok(!('open_findings' in entry), 'the raw descriptor array must not itself reach the schema-validated entry')
})

test('ledger-append: open, spec_bug and rejected findings all coexist in the same findings array with distinct dispositions (H5)', () => {
  const repo = makeTempRepo()
  runAppend(repo, {
    schema_version: 1,
    kind: 'review_cycle',
    outcome: 'done',
    open_findings: [{ lens: 'lens-security', location: 'a.js:1', claim: 'open one', severity: 'High' }],
    spec_bugs: [{ lens: 'lens-qa', location: 'b.js:2', claim: 'spec bug one' }],
    rejected_findings: [{ lens: 'lens-qa', location: 'c.js:3', claim: 'rejected one' }],
  })
  const entry = JSON.parse(readLedgerLines(repo)[0])
  const byDisposition = Object.fromEntries(entry.findings.map((f) => [f.disposition, f]))
  assert.equal(entry.findings.length, 3)
  assert.equal(byDisposition.open.claim === undefined, true, 'claim text itself must never reach the ledger (AC-SEC-2), only id/lens/severity/disposition')
  assert.ok(byDisposition.open && byDisposition.spec_bug && byDisposition.rejected)
})

test('ledger-append: a finding\'s "lens" field is constrained to the roster pattern, so routing a secret through it is rejected rather than written verbatim (M6)', () => {
  const repo = makeTempRepo()
  const res = runAppend(repo, {
    schema_version: 1,
    kind: 'review_cycle',
    outcome: 'done',
    spec_bugs: [{ lens: 'secret sk-live-CANARY-9999 seen at ... process.env.API_KEY', location: 'x', claim: 'y' }],
  })
  const out = JSON.parse(res.stdout.trim().split('\n').pop())
  assert.equal(out.write_ok, false, 'a lens field that is not a real roster identifier must be rejected, not written')
  assert.equal(readLedgerLines(repo).length, 0)
})

test('ledger-append: a finding\'s "ac_id" field is constrained to the AC-<LENS>-<n> pattern, so a quoted source line routed through it is rejected rather than written verbatim (M6)', () => {
  const repo = makeTempRepo()
  const res = runAppend(repo, {
    schema_version: 1,
    kind: 'review_cycle',
    outcome: 'done',
    spec_bugs: [{ lens: 'lens-qa', location: 'x', claim: 'y', ac_id: 'AC-X-1 quoted source: const key = 0xdeadbeef' }],
  })
  const out = JSON.parse(res.stdout.trim().split('\n').pop())
  assert.equal(out.write_ok, false, 'an ac_id field that is not a real AC-<LENS>-<n> identifier must be rejected, not written')
  assert.equal(readLedgerLines(repo).length, 0)
})

test('ledger-append: a genuine lens name and a genuine AC id both pass through normally (M6, not vacuous)', () => {
  const repo = makeTempRepo()
  const res = runAppend(repo, {
    schema_version: 1,
    kind: 'review_cycle',
    outcome: 'done',
    spec_bugs: [{ lens: 'lens-security', location: 'x', claim: 'y', ac_id: 'AC-SEC-1' }],
    rejected_findings: [{ lens: 'reviewer-verification', location: 'x', claim: 'y' }],
  })
  const out = JSON.parse(res.stdout.trim().split('\n').pop())
  assert.equal(out.write_ok, true, out.write_error)
  const entry = JSON.parse(readLedgerLines(repo)[0])
  assert.equal(entry.findings.find((f) => f.disposition === 'spec_bug').ac_id, 'AC-SEC-1')
  assert.equal(entry.findings.find((f) => f.disposition === 'rejected').lens, 'reviewer-verification')
})
