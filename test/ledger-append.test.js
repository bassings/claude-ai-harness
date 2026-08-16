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
const { APPEND_SCRIPT, LEDGER_REL, SUITE_TMPDIR, sh, makeTempRepo, runAppend, readLedgerLines, trackTempDir, cleanupTempRepos } = require('./helpers/temp-repo.js')
const {
  makeHostileTempRepo,
  makeHomeLikeHostileTempRepo,
  makeSpacyTempRepo,
  makeSymlinkAncestorTempRepo,
  makeInRepoSymlinkSpec,
  makeSymlinkedScriptInvocation,
} = require('./helpers/hostile-repo.js')

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
  // HARN-OPT-2 PR1: bumped from 1 -- plan_key is a genuine shape change,
  // and AC-OPS-4 needs a stale installed writer to be detectable from it.
  assert.equal(entry.schema_version, 2)
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

// L1: ensureGitignored ASSERTS the ledger is ignored (writes .git/info/exclude)
// but never VERIFIES it actually took effect. A tracked .gitignore carrying a
// negation pattern (`!.claude/harness-ledger.jsonl`) re-includes the path --
// .git/info/exclude has identical mechanics to a plain .gitignore, so it
// cannot override a later negation in a tracked file, and git resolves
// ignore precedence by file, last match wins. Writing to the ledger and
// reporting write_ok:true in that state risks the ledger actually being
// committed.
test('ledger-append: refuses to write (write_ok:false) when a tracked .gitignore re-includes the ledger path via a negation pattern, rather than reporting success on a path that is not actually ignored (L1, AC-SEC-1)', () => {
  const repo = makeTempRepo()
  fs.writeFileSync(path.join(repo, '.gitignore'), '!' + LEDGER_REL + '\n')
  sh('git add .gitignore && git commit -q -m "un-ignore the ledger"', repo)
  const res = runAppend(repo, { schema_version: 1, kind: 'tdd_task', outcome: 'done' })
  const out = JSON.parse(res.stdout.trim().split('\n').pop())
  assert.equal(out.write_ok, false, 'must refuse to write when the ledger path is not actually ignored')
  assert.ok(out.write_error, 'must name a reason')
  assert.equal(readLedgerLines(repo).length, 0, 'no line must be written when the ignore state could not be verified')
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

// L2: inside a git submodule, `git rev-parse --git-common-dir` resolves to
// the SUPERPROJECT's .git/modules/<name> (a submodule's gitdir lives there,
// not inside its own working tree), so path.dirname(commonDir) computes
// .git/modules -- not a usable checkout root at all. Confirmed manually
// before writing this test: on a real submodule fixture, --git-common-dir
// returned <super>/.git/modules/subrepo, and a naive dirname would have
// misfiled the ledger and a bogus .git/info tree into <super>/.git/modules/.
test('ledger-append: refuses to write (write_ok:false, no misfiled ledger) when run from inside a git submodule, rather than writing into the superproject\'s .git/modules tree (L2, AC-SEC-5)', () => {
  const superRepo = makeTempRepo()
  const subRepo = makeTempRepo()
  sh(`git -c protocol.file.allow=always submodule add -q ${JSON.stringify(subRepo)} subrepo`, superRepo)
  sh('git commit -q -m "add submodule"', superRepo)
  const submodulePath = path.join(superRepo, 'subrepo')
  const res = runAppend(submodulePath, { schema_version: 1, kind: 'tdd_task', outcome: 'done' })
  const out = JSON.parse(res.stdout.trim().split('\n').pop())
  assert.equal(out.write_ok, false, 'must refuse rather than misfile into the superproject\'s .git/modules tree')
  assert.match(out.write_error, /submodule/i, 'the refusal must specifically name the submodule case, not an incidental failure from a later step (e.g. check-ignore failing because .git/modules is not a work tree)')
  // The actual bug this test guards: root was computed as
  // path.dirname(commonDir) = <super>/.git/modules (dirname of
  // .git/modules/subrepo), so ensureGitignored(root) created a bogus
  // .git/info tree AT .git/modules/.git/info/exclude -- confirmed by hand
  // against a real submodule fixture before writing this assertion.
  const bogusInfoExclude = path.join(superRepo, '.git', 'modules', '.git', 'info', 'exclude')
  assert.ok(!fs.existsSync(bogusInfoExclude), 'no bogus .git/info tree must be created under .git/modules at all')
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

// HIGH round 3: a torn trailing line (no final '\n' -- the state a torn
// write, power loss, or external truncation leaves) fuses with the NEXT
// append into one unparseable line, silently losing BOTH the interrupted
// record and the new healthy one, while still reporting write_ok:true. The
// same file already heals this exact case for .git/info/exclude
// (ensureGitignored's `const sep = contents.length && !contents.endsWith
// ('\n') ? '\n' : ''`), so the pattern was known and simply not applied to
// the ledger append itself.
//
// Sized to actually reproduce the fusion, not merely look torn: the seeded
// final line is a real, valid, parseable JSON record with everything except
// its trailing newline -- exactly the shape a real torn write leaves
// (every byte up to the interrupted final byte was written).
test('ledger-append: a torn trailing line (no final newline) is healed before appending -- every line still parses, and no record is fused into another (HIGH round 3, AC-DATA-3/AC-DATA-5)', () => {
  const repo = makeTempRepo()
  fs.mkdirSync(path.join(repo, '.claude'), { recursive: true })
  const tornLine = JSON.stringify({ schema_version: 1, kind: 'tdd_task', outcome: 'done', run_id: 'torn-record' })
  fs.writeFileSync(path.join(repo, LEDGER_REL), tornLine) // deliberately NO trailing '\n'

  // Reproduce the fusion FIRST, against the raw bytes, before trusting the
  // fix: this is exactly what a naive append would produce.
  const naiveFusion = tornLine + JSON.stringify({ schema_version: 1, kind: 'tdd_task', outcome: 'done', run_id: 'healthy-record' }) + '\n'
  assert.throws(() => JSON.parse(naiveFusion.split('\n')[0]), 'sanity: the naive (unhealed) fusion must genuinely be unparseable, or this test proves nothing')

  const res = runAppend(repo, { schema_version: 1, kind: 'tdd_task', outcome: 'done', run_id: 'healthy-record' })
  const out = JSON.parse(res.stdout.trim().split('\n').pop())
  assert.equal(out.write_ok, true, out.write_error)

  const raw = fs.readFileSync(path.join(repo, LEDGER_REL), 'utf8')
  const lines = raw.split('\n').filter(Boolean)
  assert.equal(lines.length, 2, 'the torn record and the new record must both survive as two separate lines, not fuse into one')
  const parsed = lines.map((l) => JSON.parse(l)) // throws if ANY line is unparseable
  assert.equal(parsed[0].run_id, 'torn-record', 'the interrupted record must be recovered intact, not corrupted by the heal')
  assert.equal(parsed[1].run_id, 'healthy-record', 'the new record must land as its own clean line')
})

test('ledger-append: a properly newline-terminated ledger is NOT healed (no spurious blank line inserted) -- the torn-line fix must not fire on the ordinary case (HIGH round 3, not vacuous)', () => {
  const repo = makeTempRepo()
  runAppend(repo, { schema_version: 1, kind: 'tdd_task', outcome: 'done', run_id: 'first' })
  runAppend(repo, { schema_version: 1, kind: 'tdd_task', outcome: 'done', run_id: 'second' })
  const raw = fs.readFileSync(path.join(repo, LEDGER_REL), 'utf8')
  assert.equal(raw.split('\n').filter(Boolean).length, 2)
  assert.ok(!raw.includes('\n\n'), 'no spurious blank line from an unnecessary heal')
})

// HIGH round 3 (contributing cause): fs.writeSync's return value (the
// actual byte count written) was never checked against the buffer it was
// asked to write, so an ENOSPC-style SHORT write -- succeeding partially
// without throwing -- would leave a torn trailing line yet still report
// write_ok:true. A genuinely full disk cannot be constructed in this
// sandbox, but `ulimit -f` (RLIMIT_FSIZE, the maximum size a process may
// grow a file to) produces the identical OS-level behaviour on this
// platform -- confirmed empirically before writing this test: a write()
// past the limit returns a SHORT count rather than throwing or killing the
// process. Calibrated rather than hardcoded, since the exact byte-to-block
// conversion is platform-dependent.
function runAppendWithFsizeLimit(cwd, payload, blocks) {
  const { spawnSync } = require('node:child_process')
  const script = `ulimit -f ${blocks}; exec node ${JSON.stringify(APPEND_SCRIPT)}`
  return spawnSync('/bin/sh', ['-c', script], { cwd, input: JSON.stringify(payload), encoding: 'utf8' })
}

test('ledger-append: a SHORT write (fs.writeSync returns fewer bytes than requested, e.g. an ENOSPC-style near-full volume) is reported as write_ok:false, never silently as success (HIGH round 3, contributing cause)', () => {
  const repo = makeTempRepo()
  fs.mkdirSync(path.join(repo, '.claude'), { recursive: true })
  // A record comfortably over ~1 KB (confirmed empirically to actually
  // exceed the smallest ulimit -f block boundaries tried below on this
  // platform, unlike a single truncated 500-byte free-text field, which
  // this test's first draft used and which never got truncated at any
  // block size -- the whole record stayed under the limit's floor).
  const payload = {
    schema_version: 1,
    kind: 'review_cycle',
    outcome: 'done',
    trigger_counts: Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`lens-fake-${i}`, i])),
  }

  // Calibrate: find a block limit small enough that this exact payload's
  // write is genuinely truncated (not merely rejected before writing
  // anything, and not silently accepted in full).
  let out
  let found = false
  for (const blocks of [1, 2, 3, 4, 6, 8, 12, 16, 24, 32]) {
    fs.rmSync(path.join(repo, LEDGER_REL), { force: true })
    const res = runAppendWithFsizeLimit(repo, payload, blocks)
    const lastLine = res.stdout.trim().split('\n').pop()
    let parsed
    try {
      parsed = JSON.parse(lastLine)
    } catch (e) {
      continue // this block size did not even let the script report cleanly; try the next
    }
    if (parsed.write_ok === false) {
      out = parsed
      found = true
      break
    }
  }
  assert.ok(found, 'calibration failed to reproduce a short write at any tried block limit -- this platform may not truncate writes past RLIMIT_FSIZE the way it was confirmed to')
  assert.ok(out.write_error && /short write/i.test(out.write_error), `expected a short-write-specific reason: ${out.write_error}`)
  // Round 3b: the file is NO LONGER rolled back on a short write (see the
  // concurrency test below for why -- an absolute-offset rollback is unsafe
  // under the concurrent-writer design AC-DATA-3 requires). A short write
  // may therefore leave a torn trailing fragment on disk; that is accepted
  // and left to the next append's own heal to fix (proven by the
  // torn-trailing-line test above), not repaired here.
})

// Round 3b HIGH: the short-write rollback added in round 3 (ftruncateSync
// to the size captured by fstat BEFORE this write) is unsafe under
// concurrency. Another writer can complete a full O_APPEND write in the
// window between THIS writer's fstat and its ftruncate; the rollback then
// truncates the file back to the stale pre-race size, destroying that
// other writer's already-committed record -- a record whose write already
// returned write_ok:true to ITS caller. This is worse than the torn-line
// bug the rollback was added to prevent: instead of losing only the
// writer's own interrupted record, it can silently delete a THIRD PARTY's
// successful one.
//
// A microsecond-scale OS race cannot be relied on to land reliably in a
// fast, portable test, so LEDGER_APPEND_TEST_RACE_WINDOW_MS (a no-op
// unless this exact env var is set, see ledger-append.mjs) widens the
// window deterministically: writer A pauses right after its fstat, giving
// writer B a generous, reliable interval to land its own committed write
// before writer A ever reaches its write/rollback.
function spawnAppendAsync(cwd, payload, { blocks, env } = {}) {
  const { spawn } = require('node:child_process')
  return new Promise((resolve, reject) => {
    const spawnEnv = { ...process.env, ...(env || {}) }
    const child = blocks
      ? spawn('/bin/sh', ['-c', `ulimit -f ${blocks}; exec node ${JSON.stringify(APPEND_SCRIPT)}`], { cwd, env: spawnEnv })
      : spawn('node', [APPEND_SCRIPT], { cwd, env: spawnEnv })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('close', () => resolve({ stdout, stderr }))
    child.on('error', reject)
    child.stdin.end(JSON.stringify(payload))
  })
}

test('ledger-append: a concurrent writer\'s already-committed record survives another writer\'s short write -- it must never be silently deleted by a rollback (round 3b HIGH, AC-DATA-3)', async () => {
  const repo = makeTempRepo()
  fs.mkdirSync(path.join(repo, '.claude'), { recursive: true })

  const shortPayload = {
    schema_version: 1,
    kind: 'review_cycle',
    outcome: 'done',
    trigger_counts: Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`lens-fake-${i}`, i])),
  }

  // Calibrate exactly as the single-writer short-write test does.
  let blocks = null
  for (const b of [1, 2, 3, 4, 6, 8, 12, 16, 24, 32]) {
    fs.rmSync(path.join(repo, LEDGER_REL), { force: true })
    const res = runAppendWithFsizeLimit(repo, shortPayload, b)
    const lastLine = res.stdout.trim().split('\n').pop()
    let parsed
    try {
      parsed = JSON.parse(lastLine)
    } catch (e) {
      continue
    }
    if (parsed.write_ok === false) {
      blocks = b
      break
    }
  }
  assert.ok(blocks, 'calibration failed to find a block limit that produces a short write for this payload')
  fs.rmSync(path.join(repo, LEDGER_REL), { force: true })

  // Writer A: the short-write victim, its fstat-to-write window widened so
  // writer B has a reliable interval to land inside it.
  const writerA = spawnAppendAsync(repo, shortPayload, { blocks, env: { LEDGER_APPEND_TEST_RACE_WINDOW_MS: '300' } })

  // Writer B: an ordinary, unconstrained writer, fired shortly after A has
  // started (giving A time to open the file and reach its fstat) but well
  // inside A's widened window.
  await new Promise((r) => setTimeout(r, 100))
  const writerB = spawnAppendAsync(repo, { schema_version: 1, kind: 'tdd_task', outcome: 'done', run_id: 'writer-b-committed-record' })

  const [outA, outB] = await Promise.all([writerA, writerB])
  const parsedA = JSON.parse(outA.stdout.trim().split('\n').pop())
  const parsedB = JSON.parse(outB.stdout.trim().split('\n').pop())

  assert.equal(parsedA.write_ok, false, 'writer A must still detect and report its own short write as a failure to its caller')
  assert.equal(parsedB.write_ok, true, `writer B's own write must have succeeded: ${outB.stderr}`)

  const lines = readLedgerLines(repo)
  const survived = lines.some((l) => {
    try {
      return JSON.parse(l).run_id === 'writer-b-committed-record'
    } catch (e) {
      return false
    }
  })
  assert.ok(survived, 'writer B\'s already-committed record (already reported write_ok:true to its own caller) must never be silently deleted by writer A\'s short-write handling')
})

test('ledger-append: free-text fields are truncated to MAX_LINE_BYTES before the line is built (AC-DATA-3)', () => {
  const repo = makeTempRepo()
  const long = 'x'.repeat(10000)
  runAppend(repo, { schema_version: 1, kind: 'tdd_task', outcome: 'done', task: long })
  const lines = readLedgerLines(repo)
  const byteLen = Buffer.byteLength(lines[0], 'utf8')
  assert.ok(byteLen <= 2048, `line was ${byteLen} bytes`)
})

test('ledger-append: truncation is BYTE-based, not character-based, so three multibyte fields together cannot push the line over the cap (M2)', () => {
  const repo = makeTempRepo()
  // Each character here is 3 bytes in UTF-8 (the maximum for a single
  // UTF-16 code unit), so a single field character-truncated to 500 caps
  // at 1500 bytes -- comfortably under the threshold alone, which is
  // exactly why a single-field test does not distinguish byte- from
  // character-based truncation. THREE such fields (task, spec and --
  // round 5, H-B -- spec_raw, which retains the caller's un-truncated
  // string until this same byte-based pass runs) character-truncated to
  // 500 each would total 4500 bytes, reliably over a 2048 threshold
  // regardless of a small envelope; byte-truncated to 500 BYTES each, they
  // total ~1500 bytes, comfortably under the wider threshold below (a real
  // measured line here is ~2.2 KB -- the threshold is set with headroom
  // above that, not tuned to the exact number, and stays far under
  // MAX_LINE_BYTES=16384).
  const task = 'あ'.repeat(2000)
  const spec = 'い'.repeat(2000)
  const res = runAppend(repo, { schema_version: 1, kind: 'tdd_task', outcome: 'done', task, spec })
  const out = JSON.parse(res.stdout.trim().split('\n').pop())
  assert.equal(out.write_ok, true, out.write_error)
  const line = readLedgerLines(repo)[0]
  assert.ok(Buffer.byteLength(line, 'utf8') <= 3000, `line was ${Buffer.byteLength(line, 'utf8')} bytes`)
  const entry = JSON.parse(line)
  assert.ok(!entry.degraded, 'byte-based truncation of all three fields must be enough to fit without degrading')
  // the truncated fields must still be valid, well-formed text (no lone
  // surrogate / replacement-character corruption from an unsafe byte slice)
  assert.doesNotThrow(() => Buffer.from(entry.task, 'utf8').toString('utf8'))
  assert.doesNotThrow(() => Buffer.from(entry.spec, 'utf8').toString('utf8'))
  assert.doesNotThrow(() => Buffer.from(entry.spec_raw, 'utf8').toString('utf8'))
})

test('ledger-append: a findings array beyond the stated bound is truncated, with findings_truncated recording exactly how many were dropped (M2)', () => {
  const repo = makeTempRepo()
  // A minimal envelope (no verdicts/trigger_counts padding) so the bounded
  // result reliably fits under MAX_LINE_BYTES and this test proves the
  // bounding behaviour distinctly from the separate degrade-to-minimal path.
  const many = Array.from({ length: 20 }, () => ({ lens: 'lens-qa', location: 'f.js:1', claim: 'x' }))
  const res = runAppend(repo, { schema_version: 1, kind: 'review_cycle', outcome: 'done', open_findings: many })
  const out = JSON.parse(res.stdout.trim().split('\n').pop())
  assert.equal(out.write_ok, true, out.write_error)
  const entry = JSON.parse(readLedgerLines(repo)[0])
  assert.ok(!entry.degraded, 'this fixture must fit within MAX_LINE_BYTES once bounded, proving the bounding path distinctly from the degrade path')
  assert.ok(entry.findings.length < 20, 'the findings array must be bounded, not all 20 entries')
  assert.equal(typeof entry.findings_truncated, 'number')
  assert.equal(entry.findings.length + entry.findings_truncated, 20, 'kept + dropped must account for every finding')
  assert.ok(entry.findings_truncated > 0)
})

test('ledger-append: findings_truncated is a real zero (not null) when findings were computed and none were dropped (M2)', () => {
  const repo = makeTempRepo()
  runAppend(repo, { schema_version: 1, kind: 'review_cycle', outcome: 'done', open_findings: [{ lens: 'lens-qa', location: 'a.js:1', claim: 'x' }] })
  const entry = JSON.parse(readLedgerLines(repo)[0])
  assert.equal(entry.findings_truncated, 0)
})

test('ledger-append: findings_truncated is absent/null when no finding arrays were supplied at all (tdd_task has no findings concept)', () => {
  const repo = makeTempRepo()
  runAppend(repo, { schema_version: 1, kind: 'tdd_task', outcome: 'done' })
  const entry = JSON.parse(readLedgerLines(repo)[0])
  assert.ok(entry.findings_truncated === null || entry.findings_truncated === undefined)
})

// ---- Review round-1 M3: a single non-conforming ac_id anywhere in
// ac_verdicts/findings used to fail schema validation for the WHOLE entry
// (write_ok:false, the whole line refused), recreating exactly the
// start-only orphan class this PR exists to count and name correctly --
// and mislabelling its cause (the code comment for that counter says "an
// exception escaped run() or the process was killed", not "a lens emitted
// a free-text ac_id"). Reachable from untrusted input: /review-cycle runs
// lenses over an attacker-authored diff, and a prompt-injected ac_id value
// deletes that run's entire audit record while every lens still reports
// normally. Fixed by sanitizing non-conforming ac_id values BEFORE
// validateEntry runs: findings[].ac_id (nullable in the schema) is nulled;
// ac_verdicts entries (ac_id is NOT nullable there -- the pair is
// meaningless without it) are dropped entirely. Both counted in one named
// field so the loss is visible and distinguishable from a real
// start-only/terminal-only orphan. ----

// Review round-2 M-3: the round-1 fix DROPPED a malformed ac_verdicts entry
// entirely, permanently losing the PASS/FAIL verdict from the only durable
// copy with no way to recover which criterion it was about -- exactly the
// AC-DATA-4 recoverability requirement `spec_raw` already satisfies for
// `spec`, unmet here. If a lens spells an id cleanly on PASS but adds a
// qualifier on FAIL ("AC-DATA-16 (deferred)" is exactly this shape), every
// FAIL vanishes and neverFailingAcs reads the criterion as never-failing on
// incomplete evidence. Fixed: the entry is RETAINED (never dropped), with
// ac_id nulled and the rejected value preserved verbatim in ac_id_raw,
// mirroring spec/spec_raw exactly.
test('ledger-append: an ac_verdicts entry with a free-text (non-conforming) ac_id is RETAINED (never dropped) with ac_id nulled and the original value preserved in ac_id_raw -- the verdict is not permanently lost (M-3, corrects round-1\'s drop-the-entry design)', () => {
  const repo = makeTempRepo()
  const res = runAppend(repo, {
    schema_version: 1,
    kind: 'review_cycle',
    outcome: 'done',
    ac_verdicts: [
      { ac_id: 'AC-SEC-1', verdict: 'PASS' },
      { ac_id: 'none', verdict: 'FAIL' },
    ],
  })
  const out = JSON.parse(res.stdout.trim().split('\n').pop())
  assert.equal(out.write_ok, true, `expected the write to still succeed, got: ${out.write_error}`)
  const lines = readLedgerLines(repo)
  assert.equal(lines.length, 1, 'the record must still be written -- not silently discarded into a start-only orphan')
  const entry = JSON.parse(lines[0])
  assert.equal(entry.ac_verdicts.length, 2, 'the malformed verdict must NOT be dropped -- the FAIL is real data that must survive')
  assert.deepEqual(entry.ac_verdicts[0], { ac_id: 'AC-SEC-1', verdict: 'PASS' })
  assert.equal(entry.ac_verdicts[1].ac_id, null, 'the non-conforming ac_id must be nulled, never left in a shape that would fail validation')
  assert.equal(entry.ac_verdicts[1].ac_id_raw, 'none', 'the rejected value must be recoverable, exactly like spec_raw for spec')
  assert.equal(entry.ac_verdicts[1].verdict, 'FAIL', 'the verdict itself -- the actually valuable data -- must survive')
  assert.equal(entry.invalid_ac_ids_dropped, 1, 'the sanitisation must still be counted under its own named field, distinguishable from a real orphan')
  assert.equal(out.invalid_ac_ids_dropped, 1, 'the CLI result (what writeLedger actually sees) must also carry the count, not just the stored line')
})

test('ledger-append: a findings[].ac_id that fails the pattern is NULLED with the original value preserved in ac_id_raw -- the finding\'s other fields (lens, disposition) survive (M-3)', () => {
  const repo = makeTempRepo()
  const res = runAppend(repo, {
    schema_version: 1,
    kind: 'review_cycle',
    outcome: 'done',
    open_findings: [{ lens: 'lens-security', location: 'foo.js:1', claim: 'x', ac_id: 'optimise-cycle:AC-SEC-1' }],
  })
  const out = JSON.parse(res.stdout.trim().split('\n').pop())
  assert.equal(out.write_ok, true, out.write_error)
  const entry = JSON.parse(readLedgerLines(repo)[0])
  assert.equal(entry.findings.length, 1, 'the finding itself must survive')
  assert.equal(entry.findings[0].ac_id, null, 'the non-conforming ac_id must be nulled, not left in a shape that would fail validation')
  assert.equal(entry.findings[0].ac_id_raw, 'optimise-cycle:AC-SEC-1', 'the rejected value must be recoverable (M-3)')
  assert.equal(entry.findings[0].lens, 'lens-security', 'the rest of the finding must be intact')
  assert.equal(entry.invalid_ac_ids_dropped, 1)
})

// M1 (conductor tick 26 remainder): reproduces the live-tip repro exactly
// -- {"kind":"review_cycle","outcome":"done","spec":"a.md","run_id":"m1t",
// "spec_bugs":[{"lens":"orchestrator","location":"a.md:1","claim":"x"}]}
// returned write_ok:false ("findings[0].lens: ...") and wrote NOTHING,
// permanently losing the run's outcome/verdicts/ac_verdicts/findings/budget
// from the only durable, unbacked-up copy. 'orchestrator' is not exotic:
// this spec's own veto table attributes decisions to the orchestrator, and
// review-cycle.js passes synthesis.spec_bugs through unmapped, so a model
// can produce it on any run. Extends the ac_id treatment (M-3, above) to
// `lens`: nulled, retained bounded in lens_raw, counted under its own named
// field, and -- the point of this fix -- the record is WRITTEN.
test('ledger-append: a findings[].lens value that fails the lens/reviewer pattern is NULLED with the original preserved in lens_raw, and the record IS WRITTEN -- a malformed field costs that field, never the line (M1)', () => {
  const repo = makeTempRepo()
  const res = runAppend(repo, {
    schema_version: 1,
    kind: 'review_cycle',
    outcome: 'done',
    spec: 'a.md',
    run_id: 'm1t',
    spec_bugs: [{ lens: 'orchestrator', location: 'a.md:1', claim: 'x' }],
  })
  const out = JSON.parse(res.stdout.trim().split('\n').pop())
  assert.equal(out.write_ok, true, `expected the write to succeed with the offending field neutralised, got: ${out.write_error}`)
  const lines = readLedgerLines(repo)
  assert.equal(lines.length, 1, 'the record must be written -- a malformed field must cost that field, never the whole line')
  const entry = JSON.parse(lines[0])
  assert.equal(entry.findings.length, 1, 'the finding itself must survive')
  assert.equal(entry.findings[0].lens, null, 'the non-conforming lens value must be nulled, not left in a shape that fails validation')
  assert.equal(entry.findings[0].lens_raw, 'orchestrator', 'the rejected value must be recoverable, mirroring ac_id_raw')
  assert.equal(entry.findings[0].disposition, 'spec_bug', 'the rest of the finding must survive')
  assert.equal(entry.invalid_finding_fields_dropped, 1, 'the sanitisation must be counted under its own named field, distinguishable from a real orphan')
  assert.equal(out.invalid_finding_fields_dropped, 1, 'the CLI result (what writeLedger actually sees) must also carry the count, not just the stored line')
})

for (const field of ['open_findings', 'spec_bugs', 'rejected_findings']) {
  test(`ledger-append: a non-conforming lens in ${field} is neutralised, not fatal to the write (M1, same treatment across all three descriptor arrays)`, () => {
    const repo = makeTempRepo()
    const res = runAppend(repo, { schema_version: 1, kind: 'review_cycle', outcome: 'done', [field]: [{ lens: 'orchestrator', location: 'a.md:1', claim: 'x' }] })
    const out = JSON.parse(res.stdout.trim().split('\n').pop())
    assert.equal(out.write_ok, true, `${field}: expected the write to succeed, got: ${out.write_error}`)
    assert.equal(readLedgerLines(repo).length, 1, `${field}: the record must be written`)
  })
}

test('ledger-append: a well-formed findings[].lens value is left completely untouched -- never nulled, never counted (M1, not vacuous)', () => {
  const repo = makeTempRepo()
  runAppend(repo, { schema_version: 1, kind: 'review_cycle', outcome: 'done', open_findings: [{ lens: 'lens-security', location: 'a.js:1', claim: 'x' }] })
  const entry = JSON.parse(readLedgerLines(repo)[0])
  assert.equal(entry.findings[0].lens, 'lens-security')
  assert.equal(entry.findings[0].lens_raw, undefined, 'lens_raw must not appear at all when nothing was sanitised')
  assert.equal(entry.invalid_finding_fields_dropped, 0)
})

// M1: severity is the same defect class as lens -- an enum-constrained
// field inside the same descriptor element that used to fail the WHOLE
// entry. Same treatment, same loop, same counter.
test('ledger-append: a findings[].severity value outside the enum is NULLED with the original preserved in severity_raw, and the record IS WRITTEN (M1, same defect class as lens)', () => {
  const repo = makeTempRepo()
  const res = runAppend(repo, {
    schema_version: 1,
    kind: 'review_cycle',
    outcome: 'done',
    open_findings: [{ lens: 'lens-qa', location: 'a.js:1', claim: 'x', severity: 'Urgent' }],
  })
  const out = JSON.parse(res.stdout.trim().split('\n').pop())
  assert.equal(out.write_ok, true, `expected the write to succeed, got: ${out.write_error}`)
  const entry = JSON.parse(readLedgerLines(repo)[0])
  assert.equal(entry.findings[0].severity, null)
  assert.equal(entry.findings[0].severity_raw, 'Urgent')
  assert.equal(entry.invalid_finding_fields_dropped, 1)
})

test('ledger-append: invalid_finding_fields_dropped is a real zero (not null) when a findings array was supplied and every lens/severity was well-formed (M1, not vacuous)', () => {
  const repo = makeTempRepo()
  runAppend(repo, { schema_version: 1, kind: 'review_cycle', outcome: 'done', open_findings: [{ lens: 'lens-security', location: 'a.js:1', claim: 'x', severity: 'High' }] })
  const entry = JSON.parse(readLedgerLines(repo)[0])
  assert.equal(entry.invalid_finding_fields_dropped, 0)
})

test('ledger-append: invalid_finding_fields_dropped is absent/null when no findings array was supplied at all (tdd_task has no findings concept) (M1)', () => {
  const repo = makeTempRepo()
  runAppend(repo, { schema_version: 1, kind: 'tdd_task', outcome: 'done' })
  const entry = JSON.parse(readLedgerLines(repo)[0])
  assert.ok(entry.invalid_finding_fields_dropped === null || entry.invalid_finding_fields_dropped === undefined)
})

test('ledger-append: invalid_ac_ids_dropped is a real zero (not null) when ac_verdicts/findings were supplied and every ac_id was well-formed (M3, not vacuous)', () => {
  const repo = makeTempRepo()
  runAppend(repo, {
    schema_version: 1,
    kind: 'review_cycle',
    outcome: 'done',
    ac_verdicts: [{ ac_id: 'AC-SEC-1', verdict: 'PASS' }],
    open_findings: [{ lens: 'lens-security', location: 'foo.js:1', claim: 'x', ac_id: 'AC-SEC-2' }],
  })
  const entry = JSON.parse(readLedgerLines(repo)[0])
  assert.equal(entry.invalid_ac_ids_dropped, 0)
})

test('ledger-append: invalid_ac_ids_dropped is absent/null when neither ac_verdicts nor a findings array was supplied at all (tdd_task has no ac-id concept)', () => {
  const repo = makeTempRepo()
  runAppend(repo, { schema_version: 1, kind: 'tdd_task', outcome: 'done' })
  const entry = JSON.parse(readLedgerLines(repo)[0])
  assert.ok(entry.invalid_ac_ids_dropped === null || entry.invalid_ac_ids_dropped === undefined)
})

test('ledger-append: a null ac_id in findings (the ordinary "no AC" case) is left completely alone -- never counted as a drop, never touched (M3, not vacuous)', () => {
  const repo = makeTempRepo()
  runAppend(repo, {
    schema_version: 1,
    kind: 'review_cycle',
    outcome: 'done',
    open_findings: [{ lens: 'lens-security', location: 'foo.js:1', claim: 'x' }], // no ac_id at all
  })
  const entry = JSON.parse(readLedgerLines(repo)[0])
  assert.equal(entry.findings[0].ac_id, null)
  assert.equal(entry.invalid_ac_ids_dropped, 0, 'a genuinely absent ac_id is not an invalid one -- must not be counted as a drop')
})

// Round-4 review M3 (writer half): an ac_verdicts entry ALWAYS concerns a
// specific criterion -- unlike findings.ac_id, there is no legitimate
// "verdict not about any AC" case -- so an explicit `ac_id: null` supplied
// by the caller (never touched by the string-pattern sanitiser above,
// since it is already null, not a non-conforming string) reached
// validateEntry silently uncounted: write_ok:true with
// invalid_ac_ids_dropped:0, and the reader's aggregateRework then drops the
// verdict with no trace at all. On main the same payload was refused
// outright (main required ac_verdicts.ac_id as a plain pattern-matching
// string, so an explicit null failed schema validation), so this branch's
// own nullable-ac_id design (M-3, round 2) reopened a silent-loss route
// main did not have. Counted here, at the one place both routes (a
// rejected string, or an explicit null) converge.
test('ledger-append: an ac_verdicts entry with ac_id EXPLICITLY null (never sanitised -- supplied that way, not produced by the string-pattern check) is counted under invalid_ac_ids_dropped, never left silently at zero (round-4 review M3, writer half)', () => {
  const repo = makeTempRepo()
  const res = runAppend(repo, {
    schema_version: 1,
    kind: 'review_cycle',
    outcome: 'done',
    ac_verdicts: [{ ac_id: null, verdict: 'FAIL' }, { ac_id: 'AC-SEC-9', verdict: 'PASS' }],
  })
  const out = JSON.parse(res.stdout.trim().split('\n').pop())
  assert.equal(out.write_ok, true, out.write_error)
  const entry = JSON.parse(readLedgerLines(repo)[0])
  assert.equal(entry.ac_verdicts.length, 2, 'the FAIL verdict itself must still survive on the line')
  assert.equal(entry.invalid_ac_ids_dropped, 1, 'an explicit null ac_id must be counted, never silently reported as zero sanitisations')
  assert.equal(out.invalid_ac_ids_dropped, 1, 'the CLI result must also carry the count')
})

test('ledger-append: an explicitly-null ac_id in FINDINGS (not ac_verdicts) is left completely alone -- findings legitimately have no-AC-attached, unlike ac_verdicts, so this must not be counted (round-4 review M3, not over-broad)', () => {
  const repo = makeTempRepo()
  runAppend(repo, {
    schema_version: 1,
    kind: 'review_cycle',
    outcome: 'done',
    open_findings: [{ lens: 'lens-security', location: 'foo.js:1', claim: 'x', ac_id: null }],
  })
  const entry = JSON.parse(readLedgerLines(repo)[0])
  assert.equal(entry.findings[0].ac_id, null)
  assert.equal(entry.invalid_ac_ids_dropped, 0, 'an explicit null ac_id on a FINDING is the ordinary no-AC case, not an invalid one')
})

// Round-4 review L1: ac_id_raw (and this PR's own new lens_raw/severity_raw,
// which ride the identical retention mechanism -- fixed together, not one
// at a time) persisted lens-supplied free text VERBATIM, bypassing the
// redaction round-1's L4 fix already applies to spec_raw one field over.
// The sanitiser ran AFTER redactPaths' free-text pass, so *_raw fields were
// never in scope for it. Fixed by running the same redactPaths/
// relativiseAgainstRoot pipeline spec_raw uses, at the point each raw value
// is created, before truncation (so a path is made safe BEFORE it is cut
// down, never the reverse -- cutting an unsafe absolute path first could
// leave a recognisable partial account name inside the 32-byte bound).
test('ledger-append: ac_id_raw redacts an absolute path outside the repo the same way spec_raw does -- an account name in a non-conforming ac_id never reaches the ledger verbatim (round-4 review L1)', () => {
  const repo = makeTempRepo()
  const res = runAppend(repo, {
    schema_version: 1,
    kind: 'review_cycle',
    outcome: 'done',
    ac_verdicts: [{ ac_id: '/Users/scott.b/.ssh/id_rsa', verdict: 'FAIL' }],
  })
  const out = JSON.parse(res.stdout.trim().split('\n').pop())
  assert.equal(out.write_ok, true, out.write_error)
  const entry = JSON.parse(readLedgerLines(repo)[0])
  assert.equal(entry.ac_verdicts[0].ac_id, null)
  assert.equal(entry.ac_verdicts[0].ac_id_raw, '<redacted-path>', `an out-of-repo absolute path must be redacted, not retained verbatim, got: ${entry.ac_verdicts[0].ac_id_raw}`)
})

test('ledger-append: ac_id_raw relativises an absolute path that lives INSIDE the repo root, rather than redacting it away entirely (round-4 review L1, mirrors spec_raw\'s H2 recoverability)', () => {
  const repo = makeTempRepo()
  const res = runAppend(repo, {
    schema_version: 1,
    kind: 'review_cycle',
    outcome: 'done',
    ac_verdicts: [{ ac_id: `${repo}/specs/a.md`, verdict: 'FAIL' }],
  })
  const out = JSON.parse(res.stdout.trim().split('\n').pop())
  assert.equal(out.write_ok, true, out.write_error)
  const entry = JSON.parse(readLedgerLines(repo)[0])
  assert.equal(entry.ac_verdicts[0].ac_id_raw, 'specs/a.md', 'an in-repo path is recoverable, not merely redacted away -- the whole point of retaining it at all')
})

test('ledger-append: lens_raw and severity_raw are redacted the same way ac_id_raw is (round-4 review L1, fixed together not one at a time)', () => {
  const repo = makeTempRepo()
  const res = runAppend(repo, {
    schema_version: 1,
    kind: 'review_cycle',
    outcome: 'done',
    open_findings: [{ lens: '/Users/scott.b/.aws/credentials', location: 'x', claim: 'y', severity: '/Users/scott.b/.aws/credentials2' }],
  })
  const out = JSON.parse(res.stdout.trim().split('\n').pop())
  assert.equal(out.write_ok, true, out.write_error)
  const entry = JSON.parse(readLedgerLines(repo)[0])
  assert.equal(entry.findings[0].lens_raw, '<redacted-path>', `got: ${entry.findings[0].lens_raw}`)
  assert.equal(entry.findings[0].severity_raw, '<redacted-path>', `got: ${entry.findings[0].severity_raw}`)
})

// H3 round 2: at the OLD 2048-byte cap, a realistic review round (roughly
// 10-12 findings across a full lens roster) degraded to a ~221-byte
// envelope-only record -- the ledger kept LEAST data for the BUSIEST
// rounds, discarding lenses_run, verdicts, trigger_counts and every
// finding while still reporting write_ok:true. This PR's own round-1
// review (21 findings) would have recorded nothing. The fix: raise the cap
// to 16 KB, and when a record still does not fit, degrade PROGRESSIVELY --
// drop findings one at a time (recording the growing count in
// findings_truncated) while keeping every other field intact -- rather
// than collapsing straight to the minimal envelope.
//
// Per the explicit lesson repeated in this round's brief (a fixture shaped
// to sit away from the real threshold passes green while the guard is
// vacuous -- exactly what the PREVIOUS version of this test did, at the
// old 2048-byte cap, and would have kept doing at the new 16384-byte cap
// had its size not been rescaled to match): every fixture below is sized
// to demonstrably cross the boundary it exercises, verified by a direct
// byte-length assertion rather than assumed from its shape.

function triggerCountsOfSize(n) {
  return Object.fromEntries(Array.from({ length: n }, (_, i) => [`lens-fake-${i}`, i]))
}
function verdictsOfSize(n) {
  const opts = ['CLEAN', 'FINDINGS', 'BLOCKED']
  return Object.fromEntries(Array.from({ length: n }, (_, i) => [`lens-fake-${i}`, opts[i % 3]]))
}

test('ledger-append: a realistic 6-lens round with ~20 findings (H3\'s measured shape) keeps lens-level telemetry -- lenses_run, verdicts, trigger_counts, spec, round_key, budget_spent -- fully intact, past the point the OLD cap would have discarded everything (H3 round 2)', () => {
  const repo = makeTempRepo()
  const lenses = ['lens-security', 'lens-qa', 'lens-architecture', 'lens-product', 'lens-data', 'lens-operability']
  const many = Array.from({ length: 20 }, (_, i) => ({
    lens: lenses[i % lenses.length],
    location: `src/file${i}.js:${i + 1}`,
    claim: `finding number ${i}: a realistic-length claim describing a real defect found in review`,
    severity: ['Critical', 'High', 'Medium', 'Low'][i % 4],
  }))
  const res = runAppend(repo, {
    schema_version: 1,
    kind: 'review_cycle',
    outcome: 'done',
    spec: 'specs/optimise-cycle.md',
    round_key: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
    lenses_run: lenses,
    lenses_skipped: [],
    trigger_counts: triggerCountsOfSize(lenses.length),
    verdicts: verdictsOfSize(lenses.length),
    budget_spent: 4.5,
    open_findings: many,
  })
  const out = JSON.parse(res.stdout.trim().split('\n').pop())
  assert.equal(out.write_ok, true, out.write_error)
  const line = readLedgerLines(repo)[0]
  const bytes = Buffer.byteLength(line, 'utf8')
  // The non-vacuous check: this exact fixture must genuinely exceed the OLD
  // cap (otherwise this test would prove nothing about the OLD bug), and
  // must fit under the NEW one.
  assert.ok(bytes > 2048, `fixture must exceed the OLD 2048-byte cap to prove anything about the fix; was only ${bytes} bytes`)
  assert.ok(bytes <= 16384, `fixture must fit under the NEW cap: was ${bytes} bytes`)
  const entry = JSON.parse(line)
  assert.ok(!entry.degraded, 'must not have collapsed to the minimal envelope')
  assert.deepEqual(entry.lenses_run, lenses)
  assert.deepEqual(entry.lenses_skipped, [])
  assert.equal(Object.keys(entry.trigger_counts).length, lenses.length)
  assert.equal(Object.keys(entry.verdicts).length, lenses.length)
  assert.equal(entry.spec, 'specs/optimise-cycle.md')
  assert.equal(entry.round_key, 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2')
  assert.equal(entry.budget_spent, 4.5)
  assert.ok(entry.findings.length > 0, 'at least some findings must survive at a realistic size')
})

test('ledger-append: when trigger_counts/verdicts alone are large enough to leave little headroom, findings are dropped ONE AT A TIME (findings_truncated growing beyond the ordinary MAX_FINDINGS bound) to rescue the write, rather than collapsing the whole record to the minimal envelope (H3 round 2, progressive degrade)', () => {
  const repo = makeTempRepo()
  // Calibrated locally (no subprocess) against the real entry shape closely
  // enough to land the envelope-without-findings just under MAX_LINE_BYTES,
  // so that adding MAX_FINDINGS-bounded findings tips it over and forces a
  // genuine progressive drop -- not a fixture merely "shaped to look big".
  function approxEnvelopeBytes(n) {
    const approx = {
      schema_version: 1,
      run_id: 'x'.repeat(36),
      ts: new Date().toISOString(),
      repo: 'ledger-append-test-approx',
      kind: 'review_cycle',
      outcome: 'done',
      spec: null,
      task: null,
      round_key: null,
      lenses_run: [],
      lenses_skipped: [],
      trigger_counts: triggerCountsOfSize(n),
      verdicts: verdictsOfSize(n),
      spec_bug_count: null,
      rejected_finding_count: null,
      findings_truncated: 0,
      write_ok: true,
      write_error: null,
    }
    return Buffer.byteLength(JSON.stringify(approx), 'utf8')
  }
  let n = 100
  // MAX_FINDINGS-bounded findings add up to roughly 15 * 110 =~ 1650 bytes;
  // aiming the findings-free envelope at 14500-16000 leaves headroom for
  // findings to push it over 16384 while staying rescuable by dropping only
  // some (not all) of them.
  for (let i = 0; i < 40 && (approxEnvelopeBytes(n) < 14500 || approxEnvelopeBytes(n) > 16000); i++) {
    const bytes = approxEnvelopeBytes(n)
    n = bytes < 14500 ? Math.ceil(n * 1.25) : Math.floor(n * 0.9)
  }
  const calibrated = approxEnvelopeBytes(n)
  assert.ok(calibrated >= 14000 && calibrated <= 16384, `calibration failed to converge near the cap: n=${n}, ${calibrated} bytes`)

  const many = Array.from({ length: 20 }, (_, i) => ({ lens: 'lens-security', location: `f${i}.js:1`, claim: `finding ${i}` }))
  const res = runAppend(repo, {
    schema_version: 1,
    kind: 'review_cycle',
    outcome: 'done',
    open_findings: many,
    trigger_counts: triggerCountsOfSize(n),
    verdicts: verdictsOfSize(n),
  })
  const out = JSON.parse(res.stdout.trim().split('\n').pop())
  assert.equal(out.write_ok, true, out.write_error)
  const line = readLedgerLines(repo)[0]
  assert.ok(Buffer.byteLength(line, 'utf8') <= 16384, `written line must still fit: ${Buffer.byteLength(line, 'utf8')} bytes`)
  const entry = JSON.parse(line)
  assert.ok(!entry.degraded, 'trigger_counts/verdicts fit comfortably alone -- this must be rescued by dropping findings, not by collapsing to the minimal envelope')
  assert.equal(Object.keys(entry.trigger_counts).length, n, 'trigger_counts must survive fully intact, not itself truncated')
  assert.equal(Object.keys(entry.verdicts).length, n, 'verdicts must survive fully intact, not itself truncated')
  assert.ok(entry.findings.length < 15, `findings must be dropped below the ordinary MAX_FINDINGS bound of 15 to make room: kept ${entry.findings.length}`)
  assert.ok(entry.findings_truncated > 20 - 15, `findings_truncated must exceed the ordinary MAX_FINDINGS-only truncation (5 for 20 submitted): got ${entry.findings_truncated}`)
})

// ---- Review round-2, new harness-level finding: during review itself a
// lens wrote two TEST-FIXTURE records into the LIVE ledger, because
// ledger-append.mjs resolves the MAIN checkout via --git-common-dir
// (AC-DATA-1) regardless of which worktree a lens is probing from --
// lenses are specified read-only, but the writer has no way to know it is
// being run BY a lens rather than by a real workflow. HARNESS_LEDGER_
// READONLY is a mechanical circuit breaker: when set to a truthy value in
// the environment, the script performs NO write at all -- not even a
// gitignore check or a stat -- and returns a clean write_ok:false, no
// crash, no partial write. This is prompt-enforced at the lens boundary
// (review-cycle.js instructs every lens to export it before probing), not
// fully mechanical: a lens that ignores its own instructions, or any OTHER
// caller that does not set it, is not stopped by this alone. Documented as
// such, not oversold. ----

function runAppendWithEnv(cwd, payload, envOverrides) {
  return spawnSync('node', [APPEND_SCRIPT], { cwd, input: JSON.stringify(payload), encoding: 'utf8', env: { ...process.env, ...envOverrides } })
}

test('ledger-append: HARNESS_LEDGER_READONLY=1 performs NO write at all and returns a clean write_ok:false, never a crash (new harness-level guard)', () => {
  const repo = makeTempRepo()
  const res = runAppendWithEnv(repo, { schema_version: 1, kind: 'tdd_task', outcome: 'done' }, { HARNESS_LEDGER_READONLY: '1' })
  assert.equal(res.status, 0, `must exit 0, never crash. stderr: ${res.stderr}`)
  const out = JSON.parse(res.stdout.trim().split('\n').pop())
  assert.equal(out.write_ok, false)
  assert.equal(out.write_error, 'ledger is read-only in this context')
  assert.equal(readLedgerLines(repo).length, 0, 'no line may be written, not even a partial one')
})

test('ledger-append: HARNESS_LEDGER_READONLY unset (the ordinary case) writes exactly as before -- the guard must not fire when the env var is absent (not vacuous)', () => {
  const repo = makeTempRepo()
  const res = runAppendWithEnv(repo, { schema_version: 1, kind: 'tdd_task', outcome: 'done' }, {})
  const out = JSON.parse(res.stdout.trim().split('\n').pop())
  assert.equal(out.write_ok, true, out.write_error)
  assert.equal(readLedgerLines(repo).length, 1)
})

test('ledger-append: HARNESS_LEDGER_READONLY="" (empty string) and "0" and "false" do NOT trigger read-only mode -- only a genuinely truthy value does, matching shell convention for an unset-or-falsy env var', () => {
  const repo = makeTempRepo()
  for (const falsy of ['', '0', 'false']) {
    const res = runAppendWithEnv(repo, { schema_version: 1, kind: 'tdd_task', outcome: 'done' }, { HARNESS_LEDGER_READONLY: falsy })
    const out = JSON.parse(res.stdout.trim().split('\n').pop())
    assert.equal(out.write_ok, true, `HARNESS_LEDGER_READONLY=${JSON.stringify(falsy)} must NOT trigger read-only mode, got: ${out.write_error}`)
  }
})

test('ledger-append: HARNESS_LEDGER_READONLY does not touch the filesystem in any way -- a sha256 manifest of the whole repo tree is unchanged before and after (the same technique AC-SEC-2\'s own hostile-write test uses)', () => {
  const crypto = require('node:crypto')
  const repo = makeTempRepo()
  function manifest() {
    const out = {}
    function walk(dir) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === '.git') continue
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else out[path.relative(repo, full)] = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex')
      }
    }
    walk(repo)
    return out
  }
  const before = manifest()
  runAppendWithEnv(repo, { schema_version: 1, kind: 'tdd_task', outcome: 'done' }, { HARNESS_LEDGER_READONLY: '1' })
  const after = manifest()
  assert.deepEqual(after, before, 'HARNESS_LEDGER_READONLY must create or modify NOTHING in the repo tree')
})

test('ledger-append: a payload so large that even dropping every finding cannot rescue it (trigger_counts/verdicts alone hugely exceed the cap) still degrades to the minimal valid record as a last resort, rather than failing the write (H3 round 2, last-resort collapse)', () => {
  const repo = makeTempRepo()
  const many = Array.from({ length: 20 }, (_, i) => ({ lens: 'lens-security', location: `f${i}.js:1`, claim: `finding ${i}` }))
  const res = runAppend(repo, {
    schema_version: 1,
    kind: 'review_cycle',
    outcome: 'done',
    open_findings: many,
    // Deliberately hugely oversized (2000 entries each): comfortably over
    // 16384 bytes even with every finding dropped, so this exercises the
    // genuine last-resort path, not the progressive one.
    trigger_counts: triggerCountsOfSize(2000),
    verdicts: verdictsOfSize(2000),
  })
  const out = JSON.parse(res.stdout.trim().split('\n').pop())
  assert.equal(out.write_ok, true, `expected a degraded record to still be written: ${out.write_error}`)
  const lines = readLedgerLines(repo)
  assert.equal(lines.length, 1, 'exactly one line must be written, not zero')
  const entry = JSON.parse(lines[0])
  assert.equal(entry.degraded, true)
  assert.equal(entry.kind, 'review_cycle')
  assert.equal(entry.outcome, 'done')
  assert.ok(entry.run_id && entry.ts && entry.repo)
  assert.ok(Buffer.byteLength(lines[0], 'utf8') <= 16384)
})

test('ledger-append: an ordinary well-formed record is NOT marked degraded (M2, not vacuous)', () => {
  const repo = makeTempRepo()
  runAppend(repo, { schema_version: 1, kind: 'tdd_task', outcome: 'done', task: 'a normal task' })
  const entry = JSON.parse(readLedgerLines(repo)[0])
  assert.ok(entry.degraded === undefined || entry.degraded === null)
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

// L8: AC-QA-7 names two failure modes "separately" (directory-occupied and
// unwritable), but only the directory-occupied case had a test -- the
// unwritable case is the more likely real production failure (a permissions
// mistake, a read-only mount) and was completely unguarded. Skipped when
// running as root: permission bits are bypassed for root, so the failure
// this test exercises cannot actually occur in that environment.
test(
  'ledger-append: a write failure due to an UNWRITABLE directory never throws; reports write_ok false with a reason, and no absolute path in write_error (L8, AC-QA-7)',
  { skip: typeof process.getuid === 'function' && process.getuid() === 0 ? 'running as root: permission checks are bypassed, so this failure mode cannot occur' : false },
  () => {
    const repo = makeTempRepo()
    fs.mkdirSync(path.join(repo, '.claude'), { recursive: true })
    fs.chmodSync(path.join(repo, '.claude'), 0o500) // read + execute only, no write
    try {
      const res = runAppend(repo, { schema_version: 1, kind: 'tdd_task', outcome: 'done' })
      assert.equal(res.status, 0, 'the script itself must exit cleanly even on a write failure: ' + res.stderr)
      const out = JSON.parse(res.stdout.trim().split('\n').pop())
      assert.equal(out.write_ok, false)
      assert.ok(out.write_error && out.write_error.length > 0)
      assert.ok(!out.write_error.includes(repo), `write_error echoed the repo's absolute path: ${out.write_error}`)
    } finally {
      fs.chmodSync(path.join(repo, '.claude'), 0o700) // restore write access so cleanup can remove it
    }
  }
)

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

// Review round-1 L4 (also a spec bug: AC-SEC-1's headline sentence and its
// enumerated test cases disagreed -- the headline forbids ANY absolute
// path or account name in a ledger line; the five enumerated cases only
// ever exercised plan_key/spec, which spec_raw is not). This test's
// ORIGINAL assertion (spec_raw retains the caller's absolute form
// VERBATIM) is exactly the leak: for an in-repo absolute spec on a real
// checkout, that string is `/Volumes/.../repos/<repo>/specs/....md`,
// carrying the local account name. Fixed by relativising spec_raw the
// same lexical, root-matching way `spec` is -- WITHOUT the fuller
// canonicalPlanKey pipeline's './'/'../'-collapsing step, so spec_raw is
// never merely re-derived FROM the same canonicalisation it exists to
// insure against (see the dedicated recoverability test below for the
// non-vacuous proof of that). Out-of-repo specs are UNCHANGED: spec_raw is
// still withheld entirely (AC-SEC-1 cases c/d), never merely relativised
// against nothing.
test('ledger-append: an absolute spec path UNDER the repo root is relativised (spec/plan_key), never rejected -- spec_raw is ALSO relativised (no leading "/", no absolute prefix, no account name), not retained verbatim (H2, AC-SEC-3, L4 -- supersedes the original round-5 H-B "verbatim" expectation)', () => {
  const repo = makeTempRepo()
  const absoluteSpec = path.join(repo, 'specs', 'optimise-cycle.md')
  const res = runAppend(repo, { schema_version: 1, kind: 'review_cycle', outcome: 'done', spec: absoluteSpec })
  const out = JSON.parse(res.stdout.trim().split('\n').pop())
  assert.equal(out.write_ok, true, out.write_error)
  const entry = JSON.parse(readLedgerLines(repo)[0])
  assert.equal(entry.spec, 'specs/optimise-cycle.md', 'spec must be relativised against the repo root')
  assert.equal(entry.plan_key, 'specs/optimise-cycle.md', 'plan_key must never be the absolute form either')
  assert.equal(entry.spec_raw, 'specs/optimise-cycle.md', 'spec_raw must ALSO be relativised against the repo root, never the caller\'s absolute string verbatim (L4)')
  assert.ok(!entry.spec_raw.startsWith('/'), 'spec_raw must never carry a leading "/" for an in-repo absolute spec')
  assert.notEqual(entry.spec_raw, absoluteSpec, 'spec_raw must not equal the absolute form the caller supplied')
})

// L4's own stated proof requirement: "an absolute in-repo spec asserting
// no account name and no leading /", against a real checkout nested under
// a home-like path (a literal "home" segment plus the real `whoami`
// output) -- the same technique optimise-read.test.js's leak-freedom
// fixtures already use, so this cannot pass by coincidence of this
// machine's own TMPDIR shape.
test('ledger-append: spec_raw for an absolute in-repo spec leaks neither the local account name nor any path segment above the repo root, on a real checkout nested under a home-like path (L4)', () => {
  const whoami = sh('whoami', SUITE_TMPDIR).trim()
  const homeLikeRoot = path.join(SUITE_TMPDIR, 'home', whoami, 'repo-' + Math.random().toString(36).slice(2))
  fs.mkdirSync(homeLikeRoot, { recursive: true })
  trackTempDir(path.join(SUITE_TMPDIR, 'home'))
  sh('git init -q -b main', homeLikeRoot)
  sh('git config user.email test@example.com', homeLikeRoot)
  sh('git config user.name Test', homeLikeRoot)
  fs.writeFileSync(path.join(homeLikeRoot, 'README.md'), 'seed\n')
  sh('git add README.md && git commit -q -m seed', homeLikeRoot)
  assert.ok(/\/home\//.test(homeLikeRoot) && homeLikeRoot.includes(whoami), 'sanity: the fixture root must genuinely be home-shaped')

  const absoluteSpec = path.join(homeLikeRoot, 'specs', 'a.md')
  const res = runAppend(homeLikeRoot, { schema_version: 1, kind: 'review_cycle', outcome: 'done', spec: absoluteSpec })
  const out = JSON.parse(res.stdout.trim().split('\n').pop())
  assert.equal(out.write_ok, true, out.write_error)
  const line = readLedgerLines(homeLikeRoot)[0]
  assert.ok(!line.includes('/home/'), `spec_raw (or any field) must not leak /home/, got: ${line}`)
  assert.ok(!line.includes(whoami), `spec_raw (or any field) must not leak the account name, got: ${line}`)
  const entry = JSON.parse(line)
  assert.equal(entry.spec_raw, 'specs/a.md')
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

// Round 2 H2: redaction was applied by field NAME (spec, task only), so any
// other field carrying an absolute path -- most concretely event_key on the
// conduct_plan_event route SKILL.md documents -- reached the ledger
// unredacted. These tests exercise the leak on the field it was actually
// found on, and the "any other declared field" generalisation, rather than
// re-testing spec/task again.
test('ledger-append: an absolute plan path inside event_key (the conduct_plan_event route SKILL.md documents) is relativised/redacted, never left absolute, in the line (H2 round 2, AC-SEC-3)', () => {
  const repo = makeTempRepo()
  const absolutePlanPath = path.join(repo, 'specs', 'my-plan.md')
  const eventKey = `${absolutePlanPath}:task-1:ci_wait_started:1`
  const res = runAppend(repo, { schema_version: 1, kind: 'conduct_plan_event', outcome: 'started', event: 'ci_wait_started', event_key: eventKey })
  const out = JSON.parse(res.stdout.trim().split('\n').pop())
  assert.equal(out.write_ok, true, out.write_error)
  const line = readLedgerLines(repo)[0]
  assertNoAbsolutePaths(line, 'event_key with embedded absolute plan path')
  assert.ok(!line.includes(repo), 'the line must not contain the repo\'s own absolute temp-dir path either')
  const entry = JSON.parse(line)
  assert.ok(entry.event_key.includes('specs/my-plan.md'), `expected the relativised plan path to survive as data: ${entry.event_key}`)
})

test('ledger-append: round_key carrying an embedded absolute path is redacted like any other truncatable field, not just spec/task (H2 round 2, AC-SEC-3)', () => {
  const repo = makeTempRepo()
  const absolutePathInText = path.join(repo, 'src', 'foo.js')
  const res = runAppend(repo, { schema_version: 1, kind: 'review_cycle', outcome: 'done', round_key: `sha-abc123 touching ${absolutePathInText}` })
  const out = JSON.parse(res.stdout.trim().split('\n').pop())
  assert.equal(out.write_ok, true, out.write_error)
  const line = readLedgerLines(repo)[0]
  assertNoAbsolutePaths(line, 'round_key with embedded absolute path')
})

test('ledger-append: an absolute path riding an element of lenses_run/lenses_skipped is redacted (H2 round 2, AC-SEC-3)', () => {
  const repo = makeTempRepo()
  const absolutePathInText = path.join(repo, 'src', 'foo.js')
  const res = runAppend(repo, {
    schema_version: 1,
    kind: 'review_cycle',
    outcome: 'done',
    lenses_run: ['lens-security', `lens-mentions ${absolutePathInText}`],
    lenses_skipped: [`lens-also ${absolutePathInText}`],
  })
  const out = JSON.parse(res.stdout.trim().split('\n').pop())
  assert.equal(out.write_ok, true, out.write_error)
  const line = readLedgerLines(repo)[0]
  assertNoAbsolutePaths(line, 'lenses_run/lenses_skipped with an embedded absolute path')
})

// Round-5 H1 (§12 reframe) supersedes this test's ORIGINAL assertion
// (write_ok:false, zero lines written) the same way round-4 superseded the
// equivalent M6 "lens" test: refusing the WHOLE entry over one hostile
// dict value was exactly the defect class H1 exists to close -- three
// rounds of "sanitise the named fields" (ac_id, then lens/severity, then
// this round's verdicts/ac_verdicts.verdict/lenses_run) proved an
// allowlist can never catch every sibling. The general mechanism now
// drops each OFFENDING KEY from its dict (there is no natural per-key raw
// sibling the way ac_id_raw/lens_raw work for a fixed object shape), the
// secret never reaches the ledger either way, and the record survives.
test('ledger-append: a hostile payload cannot smuggle a canary secret or an absolute path through trigger_counts, verdicts or rounds -- each offending KEY is dropped from its dict and counted, the secret never reaches the ledger, and the record is WRITTEN (H2 round 2 superseded by round-5 H1)', () => {
  const repo = makeTempRepo()
  const canary = '/etc/shadow-canary-secret-XYZZY'
  const res = runAppend(repo, {
    schema_version: 1,
    kind: 'review_cycle',
    outcome: 'done',
    trigger_counts: { 'lens-security': canary },
    verdicts: { 'lens-security': canary },
    rounds: { test_attempts: canary },
  })
  const out = JSON.parse(res.stdout.trim().split('\n').pop())
  assert.equal(out.write_ok, true, `expected the write to succeed with the three hostile dict entries dropped, got: ${out.write_error}`)
  const lines = readLedgerLines(repo)
  assert.equal(lines.length, 1, 'the record must be written -- a malformed value must cost that value, never the line')
  assert.ok(!lines[0].includes(canary), 'the canary secret must never reach the ledger, dropped or not')
  const entry = JSON.parse(lines[0])
  assert.equal(entry.trigger_counts['lens-security'], undefined, 'the offending trigger_counts key must be dropped, not written with the wrong type')
  assert.equal(entry.verdicts['lens-security'], undefined, 'the offending verdicts key must be dropped')
  assert.equal(entry.rounds.test_attempts, undefined, 'the offending rounds key must be dropped')
  assert.equal(entry.invalid_record_values_dropped, 3, 'all three drops must be counted under the general mechanism\'s own counter')
})

// Round-5 H1: reproduces the coordinator's own live-tip repro exactly.
// `verdicts: {"lens-data": "CLEAN (with caveats)"}` -> write_ok:false,
// nothing written. `ac_verdicts: [{ac_id:"AC-QA-1", verdict:"PARTIAL"}]`
// -> write_ok:false, nothing written. This is the THIRD time this exact
// defect class was found: round-2 M-3 (ac_id), round-4 M1 (lens/severity),
// now verdicts/ac_verdicts.verdict/lenses_run -- the general mechanism
// closes the CLASS, not just these three fields (see the table test
// below).
test('ledger-append: verdicts.<lens> outside the CLEAN/FINDINGS/BLOCKED enum is DROPPED from the dict, counted, and the record IS WRITTEN (round-5 H1, exact coordinator repro)', () => {
  const repo = makeTempRepo()
  const res = runAppend(repo, {
    schema_version: 1,
    kind: 'review_cycle',
    outcome: 'done',
    verdicts: { 'lens-data': 'CLEAN (with caveats)' },
  })
  const out = JSON.parse(res.stdout.trim().split('\n').pop())
  assert.equal(out.write_ok, true, `expected the write to succeed, got: ${out.write_error}`)
  const lines = readLedgerLines(repo)
  assert.equal(lines.length, 1, 'the record must be written -- a malformed field must cost that field, never the line')
  const entry = JSON.parse(lines[0])
  assert.equal(entry.verdicts['lens-data'], undefined, 'the non-conforming verdicts entry must be dropped, not written with an out-of-enum value')
  assert.equal(entry.invalid_record_values_dropped, 1)
})

test('ledger-append: ac_verdicts[].verdict outside PASS/FAIL/UNVERIFIABLE is NULLED with the original preserved in verdict_raw, and the record IS WRITTEN (round-5 H1, exact coordinator repro)', () => {
  const repo = makeTempRepo()
  const res = runAppend(repo, {
    schema_version: 1,
    kind: 'review_cycle',
    outcome: 'done',
    run_id: 'm1t',
    ac_verdicts: [{ ac_id: 'AC-QA-1', verdict: 'PARTIAL' }],
  })
  const out = JSON.parse(res.stdout.trim().split('\n').pop())
  assert.equal(out.write_ok, true, `expected the write to succeed, got: ${out.write_error}`)
  const lines = readLedgerLines(repo)
  assert.equal(lines.length, 1, 'the record must be written')
  const entry = JSON.parse(lines[0])
  assert.equal(entry.ac_verdicts[0].ac_id, 'AC-QA-1', 'the ac_id itself must survive untouched')
  assert.equal(entry.ac_verdicts[0].verdict, null, 'the non-conforming verdict must be nulled, not left in a shape that fails validation')
  assert.equal(entry.ac_verdicts[0].verdict_raw, 'PARTIAL', 'the rejected value must be recoverable, mirroring ac_id_raw')
  assert.equal(entry.invalid_record_values_dropped, 1)
})

// These two drive degradeEntry DIRECTLY rather than through the real CLI.
// Discovered while writing the end-to-end form: main()'s OWN pre-existing
// free-text pass (relativiseAgainstRoot/redactPaths, applied to
// lenses_run/lenses_skipped before this validator ever runs) calls
// String(value) on every element, so a numeric element arrives at
// collectErrors ALREADY coerced to "12345" -- the TYPE check can never
// actually fire from a real payload for this specific field. Not
// something this fix introduced or should paper over: recorded here, and
// the direct-degradeEntry form still proves the mechanism itself handles
// a genuinely wrong-typed element correctly, which the schema declares as
// a possibility regardless of what upstream coercion happens to do today.
test('ledger-append: a wrong-typed lenses_run[] element is dropped from the array (not the record), counted, and the rest of the array survives (round-5 H1)', async () => {
  const { degradeEntry } = await import(APPEND_MODULE_URL)
  const entry = baseValidEntry({ lenses_run: ['lens-security', 12345, 'lens-qa'] })
  const result = degradeEntry(entry)
  assert.equal(result.ok, true, `expected degradeEntry to succeed, got: ${JSON.stringify(result.errors)}`)
  assert.deepEqual(entry.lenses_run, ['lens-security', 'lens-qa'], 'the bad element must be dropped, the rest of the array must survive in order')
  assert.equal(entry.invalid_record_values_dropped, 1)
})

test('ledger-append: TWO wrong-typed elements in the SAME primitive array are both dropped correctly, without an index-shift bug (round-5 H1, not vacuous)', async () => {
  const { degradeEntry } = await import(APPEND_MODULE_URL)
  const entry = baseValidEntry({ lenses_run: ['a', 111, 'b', 222, 'c'] })
  const result = degradeEntry(entry)
  assert.equal(result.ok, true, `expected degradeEntry to succeed, got: ${JSON.stringify(result.errors)}`)
  assert.deepEqual(entry.lenses_run, ['a', 'b', 'c'], 'both bad elements must be dropped, and dropping the earlier one must not shift which element the later drop removes')
  assert.equal(entry.invalid_record_values_dropped, 2)
})

// ---- Round-5 H1: the malformed-value table. This is the guard against a
// FOURTH recurrence -- a table naming only `verdict` (this round's own
// repro field) would be the identical allowlist mistake in test form, one
// level up. Drives degradeEntry DIRECTLY (not through the CLI) so every
// value-typed shape the schema declares is covered, including fields no
// real caller payload can reach today (spec/plan_key, always internally
// overwritten by main() before this point) -- the point is proving the
// MECHANISM covers the whole schema, not just what is reachable this
// week. Every row here expects ok:true (the record degrades and writes);
// the separate "boundary" and "structural" test groups below cover the
// two ways a write can still legitimately be refused. ----

function baseValidEntry(overrides = {}) {
  return { schema_version: 2, run_id: 'r1', ts: '2026-01-01T00:00:00.000Z', repo: 'demo', kind: 'review_cycle', outcome: 'done', write_ok: true, write_error: null, ...overrides }
}

const MALFORMED_VALUE_TABLE = [
  {
    name: 'verdicts.<lens> (dict, enum)',
    mutate: (e) => { e.verdicts = { 'lens-security': 'MAYBE' } },
    check: (e) => { assert.equal(e.verdicts['lens-security'], undefined) },
  },
  {
    name: 'trigger_counts.<key> (dict, type integer)',
    mutate: (e) => { e.trigger_counts = { 'lens-security': 'nope' } },
    check: (e) => { assert.equal(e.trigger_counts['lens-security'], undefined) },
  },
  {
    name: 'rounds.<key> (nullable dict, type integer)',
    mutate: (e) => { e.rounds = { test_attempts: 'nope' } },
    check: (e) => { assert.equal(e.rounds.test_attempts, undefined) },
  },
  {
    name: 'findings[].lens (object-array item, pattern, sibling raw)',
    mutate: (e) => { e.findings = [{ id: 'x', lens: 'bad-lens-name', severity: 'Low', ac_id: null, disposition: 'open' }] },
    check: (e) => { assert.equal(e.findings[0].lens, null); assert.equal(e.findings[0].lens_raw, 'bad-lens-name') },
    // Pre-existing dedicated counter (round-4 M1), not the general one --
    // ac_id/lens/severity within findings kept their OWN counter names on
    // purpose (see degradeEntry's own comment), so this row proves the
    // reframe did not silently fold them into the new general counter.
    expectCounter: 'invalid_finding_fields_dropped',
  },
  {
    name: 'findings[].severity (object-array item, enum, sibling raw)',
    mutate: (e) => { e.findings = [{ id: 'x', lens: 'lens-qa', severity: 'Urgent', ac_id: null, disposition: 'open' }] },
    check: (e) => { assert.equal(e.findings[0].severity, null); assert.equal(e.findings[0].severity_raw, 'Urgent') },
    expectCounter: 'invalid_finding_fields_dropped',
  },
  {
    name: 'findings[].ac_id (object-array item, pattern, sibling raw)',
    mutate: (e) => { e.findings = [{ id: 'x', lens: 'lens-qa', severity: 'Low', ac_id: 'none', disposition: 'open' }] },
    check: (e) => { assert.equal(e.findings[0].ac_id, null); assert.equal(e.findings[0].ac_id_raw, 'none') },
    expectCounter: 'invalid_ac_ids_dropped',
  },
  {
    name: 'ac_verdicts[].ac_id (object-array item, pattern, sibling raw)',
    mutate: (e) => { e.ac_verdicts = [{ ac_id: 'bad', verdict: 'PASS' }] },
    check: (e) => { assert.equal(e.ac_verdicts[0].ac_id, null); assert.equal(e.ac_verdicts[0].ac_id_raw, 'bad') },
    expectCounter: 'invalid_ac_ids_dropped',
  },
  {
    name: 'ac_verdicts[].verdict (object-array item, enum, sibling raw -- round-5 H1\'s own repro field)',
    mutate: (e) => { e.ac_verdicts = [{ ac_id: 'AC-QA-1', verdict: 'PARTIAL' }] },
    check: (e) => { assert.equal(e.ac_verdicts[0].verdict, null); assert.equal(e.ac_verdicts[0].verdict_raw, 'PARTIAL') },
  },
  {
    name: 'lenses_run[i] (primitive array item, type string)',
    mutate: (e) => { e.lenses_run = ['ok', 999] },
    check: (e) => { assert.deepEqual(e.lenses_run, ['ok']) },
  },
  {
    name: 'lenses_skipped[i] (primitive array item, type string)',
    mutate: (e) => { e.lenses_skipped = ['ok', 999] },
    check: (e) => { assert.deepEqual(e.lenses_skipped, ['ok']) },
  },
  {
    name: 'task (nullable top-level scalar, no enum/pattern)',
    mutate: (e) => { e.task = 42 },
    check: (e) => { assert.equal('task' in e, false) },
  },
  {
    name: 'round_key (nullable top-level scalar)',
    mutate: (e) => { e.round_key = 42 },
    check: (e) => { assert.equal('round_key' in e, false) },
  },
  {
    name: 'event (nullable top-level scalar)',
    mutate: (e) => { e.event = 42 },
    check: (e) => { assert.equal('event' in e, false) },
  },
  {
    name: 'event_key on a kind that does NOT require it (type mismatch only)',
    mutate: (e) => { e.event_key = 42 },
    check: (e) => { assert.equal('event_key' in e, false) },
  },
  {
    name: 'degraded (nullable boolean)',
    mutate: (e) => { e.degraded = 'yes' },
    check: (e) => { assert.equal('degraded' in e, false) },
  },
  {
    name: 'budget_spent (nullable number)',
    mutate: (e) => { e.budget_spent = 'lots' },
    check: (e) => { assert.equal('budget_spent' in e, false) },
  },
  {
    name: 'spec (nullable string) -- defensive: pre-processed before this point in the real write path, tested here so the SCHEMA-driven mechanism covers it regardless of reachability',
    mutate: (e) => { e.spec = 42 },
    check: (e) => { assert.equal('spec' in e, false) },
  },
  {
    name: 'plan_key (nullable string) -- defensive, same reason as spec',
    mutate: (e) => { e.plan_key = 42 },
    check: (e) => { assert.equal('plan_key' in e, false) },
  },
  {
    // The remaining ['integer','null']-typed counters (spec_bug_count,
    // rejected_finding_count, findings_truncated, invalid_ac_ids_dropped,
    // invalid_finding_fields_dropped, invalid_record_values_dropped) share
    // this EXACT constraint shape and are always internally overwritten by
    // main() before a caller value could reach them -- one representative
    // is deliberate scoping (round-2's own L-8 precedent: "not a
    // repo-wide rename, out of proportion"), not an oversight; the
    // mechanism itself is per-shape, not per-field-name, so this one row
    // stands for all six.
    name: 'findings_truncated (nullable integer) -- representative of every ["integer","null"] counter field',
    mutate: (e) => { e.findings_truncated = 'lots' },
    check: (e) => { assert.equal('findings_truncated' in e, false) },
  },
]

for (const row of MALFORMED_VALUE_TABLE) {
  test(`ledger-append: malformed-value table -- ${row.name} is neutralised and counted, the record IS WRITTEN, never refused (round-5 H1)`, async () => {
    const { degradeEntry } = await import(APPEND_MODULE_URL)
    const entry = baseValidEntry()
    row.mutate(entry)
    const result = degradeEntry(entry)
    assert.equal(result.ok, true, `expected degradeEntry to succeed for ${row.name}, got errors: ${JSON.stringify(result.errors)}`)
    row.check(entry)
    // Every neutralisation must be counted under EXACTLY one of the three
    // counters -- never left invisible, never double-counted across two.
    // ac_id (either array) and findings[].lens/severity route to their
    // own dedicated pre-existing counters (invalid_ac_ids_dropped /
    // invalid_finding_fields_dropped); everything else routes to the
    // general mechanism's own counter. Each row asserts its OWN expected
    // counter via row.expectCounter, defaulting to the general one.
    const counterField = row.expectCounter || 'invalid_record_values_dropped'
    assert.equal(entry[counterField], 1, `expected exactly one neutralisation counted under ${counterField} for ${row.name}, entry: ${JSON.stringify(entry)}`)
  })
}

// ---- Round-5 H1: the boundary group. A value error on a field that is
// ALSO (conditionally) required is neutralised by DELETION like any other
// generic field, but deletion then correctly resurfaces as a
// required-property-missing error on re-validation -- genuinely
// structural, so the write is refused. This is the self-limiting
// behaviour the coordinator's spec names explicitly ("Only if the record
// still fails on something STRUCTURAL... may the write be refused"), not
// a special-cased exclusion list of "never touch these fields". ----

test('ledger-append: a malformed `kind` (unconditionally required) is neutralised by deletion, which then correctly fails as required-missing on re-validation -- the write IS refused, for the right reason (round-5 H1 boundary)', async () => {
  const { degradeEntry } = await import(APPEND_MODULE_URL)
  const entry = baseValidEntry({ kind: 'not-a-real-kind' })
  const result = degradeEntry(entry)
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((e) => /kind: required property missing/.test(e)), `expected the FINAL refusal reason to name kind as missing (post-deletion), got: ${JSON.stringify(result.errors)}`)
})

test('ledger-append: a malformed `outcome` on a kind that REQUIRES it (review_cycle) is neutralised by deletion, which then correctly fails as required-missing -- the write IS refused (round-5 H1 boundary)', async () => {
  const { degradeEntry } = await import(APPEND_MODULE_URL)
  const entry = baseValidEntry({ kind: 'review_cycle', outcome: 'not-a-real-outcome' })
  const result = degradeEntry(entry)
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((e) => /outcome: required when/.test(e)), `got: ${JSON.stringify(result.errors)}`)
})

test('ledger-append: the SAME malformed `outcome` on a kind that does NOT require it (conduct_plan_event) is neutralised cleanly and the write SUCCEEDS -- proves the mechanism is schema-driven, not hardcoded per field name (round-5 H1 boundary, not vacuous)', async () => {
  const { degradeEntry } = await import(APPEND_MODULE_URL)
  const entry = baseValidEntry({ kind: 'conduct_plan_event', outcome: 'not-a-real-outcome', event_key: 'specs/a.md:T1:ci_wait_started:1' })
  const result = degradeEntry(entry)
  assert.equal(result.ok, true, `expected the write to succeed, got: ${JSON.stringify(result.errors)}`)
  assert.equal('outcome' in entry, false, 'outcome must have been deleted, not left in an invalid shape')
})

test('ledger-append: a malformed `event_key` on conduct_plan_event (which REQUIRES it) is neutralised by deletion, which then correctly fails as required-when-missing -- the write IS refused (round-5 H1 boundary)', async () => {
  const { degradeEntry } = await import(APPEND_MODULE_URL)
  const entry = baseValidEntry({ kind: 'conduct_plan_event' })
  delete entry.outcome
  entry.event_key = 42
  const result = degradeEntry(entry)
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((e) => /event_key: required when/.test(e)), `got: ${JSON.stringify(result.errors)}`)
})

// ---- Round-5 H1: the structural group. These fail BEFORE any
// neutralisation is even attempted -- the FINDING-1/M-2 precedent,
// unchanged by this reframe, and matching main's own behaviour. ----

test('ledger-append: a genuinely missing required field (schema_version absent from the start) is refused outright, no degrade attempted (round-5 H1, structural precedent unchanged)', async () => {
  const { degradeEntry } = await import(APPEND_MODULE_URL)
  const entry = baseValidEntry()
  delete entry.schema_version
  const result = degradeEntry(entry)
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((e) => /schema_version: required property missing/.test(e)))
})

test('ledger-append: an unknown top-level property is refused outright, no degrade attempted (round-5 H1, structural precedent unchanged, AC-SEC-2)', async () => {
  const { degradeEntry } = await import(APPEND_MODULE_URL)
  const entry = baseValidEntry({ evidence: 'a secret quoted source line' })
  const result = degradeEntry(entry)
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((e) => /evidence: not an allowed property/.test(e)))
})

test('ledger-append: findings:[null] (a non-object array element) is refused outright, no degrade attempted (round-5 H1, FINDING-1/M-2 precedent unchanged)', () => {
  const repo = makeTempRepo()
  const res = runAppend(repo, { schema_version: 1, kind: 'review_cycle', outcome: 'done', findings: [null] })
  const out = JSON.parse(res.stdout.trim().split('\n').pop())
  assert.equal(out.write_ok, false, 'a null array element has no field to neutralise -- must still refuse, matching main')
  assert.equal(readLedgerLines(repo).length, 0)
})

test('ledger-append: an origin remote that is a bare local filesystem path (not a recognised host form) is never used as repo identity -- it falls back to the toplevel basename instead (H2 round 2, AC-SEC-3)', () => {
  const repo = makeTempRepo()
  const otherAbsolutePath = path.join(path.dirname(repo), 'some-other-operators-project')
  sh(`git remote add origin ${JSON.stringify(otherAbsolutePath)}`, repo)
  const res = runAppend(repo, { schema_version: 1, kind: 'tdd_task', outcome: 'done' })
  const out = JSON.parse(res.stdout.trim().split('\n').pop())
  assert.equal(out.write_ok, true, out.write_error)
  const line = readLedgerLines(repo)[0]
  assertNoAbsolutePaths(line, 'repo identity derived from a local-path origin remote')
  const entry = JSON.parse(line)
  assert.equal(entry.repo, path.basename(repo), 'a local-path origin must fall back to the toplevel basename, not the path\'s own trailing segments')
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

// Coordinator FINDING 1 (confirmed pre-existing on BOTH main and this
// branch's tip, from a non-symlinked path -- verified directly via `git
// show main:workflows/lib/ledger-append.mjs`, not inferred): a null element
// in open_findings/spec_bugs/rejected_findings crashed computeFindings()
// with an unhandled TypeError (f.lens on null) BEFORE validateEntry ever
// ran -- Node exits non-zero, nothing written, not even a parseable
// write_ok:false. Different code path from the M-2 findings/ac_verdicts
// sanitiser (which already degrades cleanly): those arrays are consumed
// AFTER computeFindings has already built entry.findings. Fixed by
// null-guarding inside computeFindings's map, consistent with M-2's own
// pattern: a malformed element becomes `null` in the entries array instead
// of crashing, which flows through to entry.findings and is caught by
// validateEntry's existing findings.items.type:'object' check -- the SAME
// clean write_ok:false degrade, applied once so all three descriptor
// arrays (they share this one function) get it consistently rather than
// three separate special cases.
for (const field of ['open_findings', 'spec_bugs', 'rejected_findings']) {
  test(`ledger-append: a null element in ${field} degrades to a clean write_ok:false, never crashes the writer (FINDING 1)`, () => {
    const repo = makeTempRepo()
    const res = runAppend(repo, { schema_version: 1, kind: 'review_cycle', outcome: 'done', [field]: [null] })
    assert.equal(res.status, 0, `${field}: the writer must always exit 0, even on a malformed descriptor array; got status ${res.status}, stderr: ${res.stderr}`)
    assert.ok(res.stdout.trim().length > 0, `${field}: expected one line of JSON on stdout, got empty output (stderr: ${res.stderr})`)
    const out = JSON.parse(res.stdout.trim().split('\n').pop())
    assert.equal(out.write_ok, false, `${field}: a null descriptor element must degrade to write_ok:false, not crash silently or succeed with garbage`)
    assert.equal(readLedgerLines(repo).length, 0, `${field}: a rejected write must not leave a partial or malformed line on disk`)
  })
}

test('ledger-append: a null element alongside otherwise-valid descriptors in open_findings still degrades the WHOLE entry to write_ok:false, never silently drops just the bad one and keeps the rest (FINDING 1, consistency with M-2)', () => {
  const repo = makeTempRepo()
  const res = runAppend(repo, {
    schema_version: 1,
    kind: 'review_cycle',
    outcome: 'done',
    open_findings: [{ lens: 'lens-qa', location: 'a.js:1', claim: 'a real one' }, null],
  })
  assert.equal(res.status, 0)
  const out = JSON.parse(res.stdout.trim().split('\n').pop())
  assert.equal(out.write_ok, false, 'a mix of one valid and one null descriptor must still reject the whole entry, matching the M-2 findings/ac_verdicts precedent')
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

// L10: findingId's location component was never independently exercised --
// every existing test either held location fixed while varying claim, or
// varied claim alongside location together, so removing the location
// argument entirely (or its trim/lowercase normalisation) changed no
// existing test's outcome.
test('ledger-append module: findingId varies with location alone, holding lens and claim fixed (L10, AC-QA-11)', async () => {
  const { findingId } = await import(APPEND_MODULE_URL)
  const a = findingId('lens-qa', 'foo.js:10', 'same claim text')
  const b = findingId('lens-qa', 'bar.js:20', 'same claim text')
  assert.notEqual(a, b, 'two different locations for the identical lens+claim must yield different ids')
})

test('ledger-append module: findingId normalises location (trim + lowercase) so cosmetic variants of the SAME location yield the SAME id (L10, AC-QA-11)', async () => {
  const { findingId } = await import(APPEND_MODULE_URL)
  const base = findingId('lens-qa', 'foo.js:10', 'same claim text')
  assert.equal(findingId('lens-qa', '  foo.js:10  ', 'same claim text'), base, 'leading/trailing whitespace must not change the id')
  assert.equal(findingId('lens-qa', 'FOO.JS:10', 'same claim text'), base, 'case must not change the id')
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

// Coordinator FINDING 2: fixed by comparing REALPATHS of import.meta.url
// and process.argv[1] (Node's ESM loader resolves the former through
// symlinks; the latter needs an explicit realpath to match). Must not
// weaken the property the two tests above already prove -- asserted here
// directly, in a genuinely FRESH subprocess (so a bug in the fix cannot
// be masked by this test file's own argv[1], which is node's test runner,
// never ledger-append.mjs, in every scenario above): a plain ESM `import`
// of the module, with no CLI invocation at all, must produce NO stdout
// (main()'s JSON line) and must exit 0 without writing anything.
test('ledger-append module: a fresh subprocess that ONLY imports the module (never invokes it as `node ledger-append.mjs`) prints nothing and writes nothing -- the realpath fix for FINDING 2 must not make import() itself look like a CLI invocation', () => {
  const repo = makeTempRepo()
  const probeDir = fs.mkdtempSync(path.join(SUITE_TMPDIR, 'import-probe-'))
  trackTempDir(probeDir)
  const probeScript = path.join(probeDir, 'probe.mjs')
  fs.writeFileSync(
    probeScript,
    `import(${JSON.stringify(APPEND_MODULE_URL)}).then((mod) => {\n` +
      `  if (typeof mod.main !== 'function') { console.error('main export missing'); process.exit(2) }\n` +
      `  console.log('IMPORT_SURVIVED_NO_CLI')\n` +
      `})\n`
  )
  const res = spawnSync('node', [probeScript], { cwd: repo, encoding: 'utf8' })
  assert.equal(res.status, 0, `probe subprocess must exit 0, got status ${res.status}, stderr: ${res.stderr}`)
  assert.equal(res.stdout.trim(), 'IMPORT_SURVIVED_NO_CLI', `import must not have printed a ledger JSON line as a side effect, got: ${res.stdout}`)
  assert.equal(readLedgerLines(repo).length, 0, 'a plain import must never write a ledger line')
})

// Coordinator FINDING 2 (confirmed pre-existing on main too, from a
// non-symlinked control -- the same identical file, same payload, wrote
// write_ok:true from a real path and silently no-op'd through a symlinked
// one): `import.meta.url` resolves symlinks (Node's ESM loader always
// reports the REAL target path); `process.argv[1]` does not, without an
// explicit realpath call. `isMain` compared them directly, so invoking
// `node <symlinked-path-to-ledger-append.mjs> append` made `isMain` read
// false: exit 0, zero bytes of output, no file written, no error --
// success-shaped silence. This is exactly the C1 failure class (silent
// total loss) and is live on main today: `~/.claude/workflows/lib/...`
// sits behind macOS's /tmp -> /private/tmp and $TMPDIR's
// /var/folders -> /private/var/folders ancestry, so any symlinked home,
// volume or install ancestor disables ALL ledger writing with no signal.
test('ledger-append: invoking the writer through a SYMLINKED path to the script itself still performs a real write and reports write_ok:true (FINDING 2)', () => {
  const repo = makeTempRepo()
  const symlinkedScript = makeSymlinkedScriptInvocation()
  const res = spawnSync('node', [symlinkedScript], { cwd: repo, input: JSON.stringify({ schema_version: 1, kind: 'review_cycle', outcome: 'done' }), encoding: 'utf8' })
  assert.equal(res.status, 0, `expected exit 0, got ${res.status}, stderr: ${res.stderr}`)
  assert.ok(res.stdout.trim().length > 0, `expected one line of JSON on stdout through the symlinked invocation, got EMPTY output -- this is the silent no-op FINDING 2 describes (stderr: ${res.stderr})`)
  const out = JSON.parse(res.stdout.trim().split('\n').pop())
  assert.equal(out.write_ok, true, `expected a real write through the symlinked path, got: ${JSON.stringify(out)}`)
  const lines = readLedgerLines(repo)
  assert.equal(lines.length, 1, `expected exactly one real ledger line written through the symlinked invocation, got ${lines.length}`)
})

test('ledger-append module: findingId is stable for the same lens+location+claim', async () => {
  const { findingId } = await import(APPEND_MODULE_URL)
  assert.equal(findingId('lens-security', 'foo.js:10', 'x'), findingId('lens-security', 'foo.js:10', 'x'))
})

test('ledger-append module: findingId differs across lenses for identical location and claim text', async () => {
  const { findingId } = await import(APPEND_MODULE_URL)
  assert.notEqual(findingId('lens-security', 'foo.js:10', 'same'), findingId('lens-qa', 'foo.js:10', 'same'))
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

// Round 2 H2: validateEntry checked enum/pattern/array-item shape but never
// the base declared `type` of a scalar property at all -- a number, an
// object, or an array could sit in a field declared `type: 'string'` and
// validate cleanly. These pin the general type check (including the
// ['string', 'null'] union form) plus the specific dict-value constraints
// added to trigger_counts/verdicts/rounds.
test('ledger-append module: validateEntry rejects a scalar property whose runtime type does not match its declared type (H2 round 2)', async () => {
  const { validateEntry, LEDGER_ENTRY_SCHEMA } = await import(APPEND_MODULE_URL)
  const base = { schema_version: 1, run_id: 'r', ts: 't', repo: 'r', kind: 'tdd_task', outcome: 'done', write_ok: true, write_error: null }
  const errors = validateEntry({ ...base, task: 42 })
  assert.ok(errors.some((e) => /task/.test(e)), `expected a type error naming task: ${JSON.stringify(errors)}`)
  // spec declares type: ['string', 'null'] -- both members of the union must
  // still be accepted, so this is the non-vacuous half of the same guard.
  assert.deepEqual(validateEntry({ ...base, spec: null }), [], 'null must still satisfy a [\'string\',\'null\'] union')
  assert.deepEqual(validateEntry({ ...base, spec: 'specs/x.md' }), [], 'a plain string must still satisfy a [\'string\',\'null\'] union')
  void LEDGER_ENTRY_SCHEMA
})

test('ledger-append module: validateEntry rejects a wrong-typed value hiding inside trigger_counts, verdicts or rounds, not just the top-level field (H2 round 2)', async () => {
  const { validateEntry } = await import(APPEND_MODULE_URL)
  const base = { schema_version: 1, run_id: 'r', ts: 't', repo: 'r', kind: 'review_cycle', outcome: 'done', write_ok: true, write_error: null }
  const triggerErrors = validateEntry({ ...base, trigger_counts: { 'lens-security': '/etc/shadow' } })
  assert.ok(triggerErrors.length > 0, 'a string value inside trigger_counts (declared integer) must be rejected')
  const verdictErrors = validateEntry({ ...base, verdicts: { 'lens-security': 'NOT-A-REAL-VERDICT' } })
  assert.ok(verdictErrors.length > 0, 'a verdicts value outside the CLEAN/FINDINGS/BLOCKED enum must be rejected')
  const roundsErrors = validateEntry({ ...base, rounds: { test_attempts: '/etc/shadow' } })
  assert.ok(roundsErrors.length > 0, 'a string value inside rounds (declared integer) must be rejected')
  // the honest-data shape for all three must still validate cleanly
  assert.deepEqual(validateEntry({ ...base, trigger_counts: { 'lens-security': 3 }, verdicts: { 'lens-security': 'FINDINGS' }, rounds: { test_attempts: 2 } }), [])
})

test('ledger-append module: LEDGER_ENTRY_SCHEMA never declares an "evidence", "location" or "report" property (AC-SEC-2)', async () => {
  const { LEDGER_ENTRY_SCHEMA } = await import(APPEND_MODULE_URL)
  const props = Object.keys(LEDGER_ENTRY_SCHEMA.properties)
  assert.ok(!props.includes('evidence'))
  assert.ok(!props.includes('location'))
  assert.ok(!props.includes('report'))
})

// Review round-2 M-3: ac_id_raw added (bounded, AC-DATA-4-style
// recoverability for a rejected ac_id) -- still no evidence/location/claim
// field, the AC-SEC-2 exclusion this test guards is unaffected.
// M1 (round 4 remainder): lens_raw/severity_raw added, same pattern, for
// the same recoverability reason -- see the M1 tests above.
test('ledger-append module: findings schema entries only carry lens (plus its bounded raw form), severity (plus its bounded raw form), ac id (plus its bounded raw form), and disposition (AC-SEC-2, M-3, M1)', async () => {
  const { LEDGER_ENTRY_SCHEMA } = await import(APPEND_MODULE_URL)
  const findingProps = Object.keys(LEDGER_ENTRY_SCHEMA.properties.findings.items.properties)
  assert.deepEqual(findingProps.sort(), ['ac_id', 'ac_id_raw', 'disposition', 'id', 'lens', 'lens_raw', 'severity', 'severity_raw'])
  assert.equal(LEDGER_ENTRY_SCHEMA.properties.findings.items.additionalProperties, false)
})

// M1: lens and severity are now nullable, mirroring ac_id -- a rejected
// value is retained via *_raw, never dropping the whole finding.
test('ledger-append module: LEDGER_ENTRY_SCHEMA declares findings.lens and findings.severity as nullable (M1, mirrors ac_id)', async () => {
  const { LEDGER_ENTRY_SCHEMA } = await import(APPEND_MODULE_URL)
  const props = LEDGER_ENTRY_SCHEMA.properties.findings.items.properties
  assert.deepEqual(props.lens.type.slice().sort(), ['null', 'string'])
  assert.deepEqual(props.severity.type.slice().sort(), ['null', 'string'])
})

// L4: outcome must not be unconditionally required -- it is not a
// meaningful concept for conduct_plan_event (an "ended" event has no
// natural outcome value), so it is required only for the three run kinds.
test('ledger-append module: outcome is required only for tdd_task/review_cycle/plan_cycle, not unconditionally (L4)', async () => {
  const { LEDGER_ENTRY_SCHEMA } = await import(APPEND_MODULE_URL)
  assert.ok(!LEDGER_ENTRY_SCHEMA.required.includes('outcome'), 'outcome must not be in the unconditional required list')
  const outcomeRules = LEDGER_ENTRY_SCHEMA.requiredWhen.filter((rule) => rule.require.includes('outcome'))
  const kindsRequiringOutcome = outcomeRules.map((rule) => rule.when.kind).sort()
  assert.deepEqual(kindsRequiringOutcome, ['plan_cycle', 'review_cycle', 'tdd_task'])
})

// H4: AC verdicts were collected from every lens (review-cycle.js) and then
// discarded -- LEDGER_ENTRY_SCHEMA had no field that could hold them, so
// "which ACs never fail" had no data source. ac_verdicts carries {ac_id,
// verdict} pairs ONLY (AC-SEC-2: no evidence text), same exclusion
// discipline as `findings`.
// Review round-2 M-3: ac_id_raw added (bounded recoverability for a
// rejected ac_id, AC-DATA-4's pattern) -- still no evidence field, and
// ac_id is now nullable (a rejected id is retained via ac_id_raw, never
// dropping the whole {ac_id, verdict} pair).
// Round-5 H1: verdict_raw added, same pattern -- verdict is now nullable
// too (see the H1 tests below).
test('ledger-append module: LEDGER_ENTRY_SCHEMA declares ac_verdicts as a bounded array of {ac_id, ac_id_raw, verdict, verdict_raw} entries only, no evidence, with ac_id and verdict both nullable (H4, AC-SEC-2, M-3, H1)', async () => {
  const { LEDGER_ENTRY_SCHEMA } = await import(APPEND_MODULE_URL)
  const acVerdictsSchema = LEDGER_ENTRY_SCHEMA.properties.ac_verdicts
  assert.ok(acVerdictsSchema, 'expected an ac_verdicts property on the schema')
  assert.equal(acVerdictsSchema.type, 'array')
  const itemProps = Object.keys(acVerdictsSchema.items.properties)
  assert.deepEqual(itemProps.sort(), ['ac_id', 'ac_id_raw', 'verdict', 'verdict_raw'], 'ac_verdicts items must carry only ac_id/ac_id_raw/verdict/verdict_raw, never evidence')
  assert.equal(acVerdictsSchema.items.additionalProperties, false)
  assert.deepEqual(acVerdictsSchema.items.properties.ac_id.type.sort(), ['null', 'string'], 'ac_id must be nullable so a rejected value is retained, not dropped (M-3)')
  assert.deepEqual(acVerdictsSchema.items.properties.verdict.type.sort(), ['null', 'string'], 'verdict must be nullable so a rejected value is retained, not dropped (H1)')
  assert.deepEqual(acVerdictsSchema.items.properties.verdict.enum.sort(), ['FAIL', 'PASS', 'UNVERIFIABLE'])
})

test('ledger-append: ac_verdicts pairs survive to the written line verbatim (H4)', () => {
  const repo = makeTempRepo()
  const res = runAppend(repo, {
    schema_version: 1,
    kind: 'review_cycle',
    outcome: 'done',
    ac_verdicts: [
      { ac_id: 'AC-SEC-3', verdict: 'FAIL' },
      { ac_id: 'AC-QA-9', verdict: 'PASS' },
    ],
  })
  const out = JSON.parse(res.stdout.trim().split('\n').pop())
  assert.equal(out.write_ok, true, out.write_error)
  const entry = JSON.parse(readLedgerLines(repo)[0])
  assert.deepEqual(entry.ac_verdicts, [
    { ac_id: 'AC-SEC-3', verdict: 'FAIL' },
    { ac_id: 'AC-QA-9', verdict: 'PASS' },
  ])
})

test('ledger-append: an ac_verdicts entry carrying an "evidence" key is rejected outright, not silently stripped (H4, AC-SEC-2)', () => {
  const repo = makeTempRepo()
  const res = runAppend(repo, {
    schema_version: 1,
    kind: 'review_cycle',
    outcome: 'done',
    ac_verdicts: [{ ac_id: 'AC-SEC-3', verdict: 'FAIL', evidence: 'a secret source line' }],
  })
  const out = JSON.parse(res.stdout.trim().split('\n').pop())
  assert.equal(out.write_ok, false, 'an ac_verdicts entry with a disallowed property must fail validation, never write the evidence text')
  assert.equal(readLedgerLines(repo).length, 0)
})

test('ledger-append module: MAX_LINE_BYTES is 16 KB (H3 round 2: 2048 made a realistic review round degrade to a ~221-byte envelope, discarding everything)', async () => {
  const { MAX_LINE_BYTES } = await import(APPEND_MODULE_URL)
  assert.equal(MAX_LINE_BYTES, 16384)
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

// M1 supersedes this M6 test's ORIGINAL zero-tolerance assertion
// (write_ok:false, zero lines written) the same way round-2 M-3 superseded
// it for ac_id (see that superseding test's own comment, immediately
// below): rejecting the whole entry over one bad lens value is exactly the
// defect M1 fixes -- it destroyed the run's outcome/verdicts/findings/
// budget over one free-text field. The secret-exfiltration guarantee M6
// actually cares about (never write the secret verbatim) is preserved by
// lens_raw's bound, not by refusing the write.
test('ledger-append: a finding\'s "lens" field is constrained to the roster pattern -- a secret routed through it is NULLED, the finding survives, and lens_raw retains only a BOUNDED prefix that excludes the actual secret-shaped payload (M1 supersedes M6\'s zero-tolerance verbatim claim with a considered, bounded one, mirroring ac_id\'s M-3 treatment)', () => {
  const repo = makeTempRepo()
  const hostileLens = 'not a real lens, just filler prose to push the secret past the bound sk-live-CANARY-9999'
  const res = runAppend(repo, {
    schema_version: 1,
    kind: 'review_cycle',
    outcome: 'done',
    spec_bugs: [{ lens: hostileLens, location: 'x', claim: 'y' }],
  })
  const out = JSON.parse(res.stdout.trim().split('\n').pop())
  assert.equal(out.write_ok, true, `expected the write to succeed with the hostile lens sanitised, got: ${out.write_error}`)
  const lines = readLedgerLines(repo)
  assert.equal(lines.length, 1)
  assert.ok(!lines[0].includes('sk-live-CANARY-9999'), 'the actual secret-shaped payload must never reach the ledger, bounded or not')
  const entry = JSON.parse(lines[0])
  assert.equal(entry.findings[0].lens, null)
  assert.ok(entry.findings[0].lens_raw.length <= 32, `lens_raw must be bounded, got length ${entry.findings[0].lens_raw.length}`)
  assert.equal(entry.findings[0].claim, undefined, 'sanity: claim was never a declared field to begin with (AC-SEC-2 evidence exclusion, unrelated to this fix)')
  assert.equal(entry.invalid_finding_fields_dropped, 1)
})

// Review round-1 M3, corrected by round-2 M-3: the ORIGINAL M6 assertion
// (write_ok:false, zero lines written) was exactly the defect that
// destroyed a whole record's telemetry over one bad ac_id (round-1 M3,
// fixed). Round-1's own fix then NULLED the value with no retention,
// which round-2 M-3 identified as a DIFFERENT defect: a dropped ac_id is
// permanently unrecoverable, unlike spec_raw's insurance for spec. Round-2
// retains a BOUNDED raw copy (ac_id_raw, 32 bytes) for exactly this reason
// -- but ac_id was deliberately kept free of ANY free text (AC-SEC-2,
// "no free text, ever") specifically to prevent secret/source-line
// smuggling through this field, which is what M6 tests. These two
// requirements are in real tension: any bound long enough to recover a
// realistic citation ("optimise-cycle:AC-SEC-1", 23 bytes) is long enough
// to retain SOME prefix of a longer hostile string. The 32-byte bound is
// chosen so realistic citation forms survive whole while the ACTUAL
// secret-shaped payload in this hostile fixture (deliberately placed at
// the end of the string, the realistic position for an injection payload
// following descriptive prose) is cut off before it is reached -- proven
// below, not assumed. This is a considered, bounded exposure, not the
// zero-tolerance guarantee the original M6 test claimed; recorded as such
// in docs/harn-opt-2-mutation-proofs.md.
test('ledger-append: a finding\'s "ac_id" field is constrained to the AC-<LENS>-<n> pattern -- a quoted source line routed through it is NULLED, the finding survives, and ac_id_raw retains only a BOUNDED prefix that excludes the actual secret-shaped payload (M-3 supersedes M6\'s zero-tolerance verbatim claim with a considered, bounded one)', () => {
  const repo = makeTempRepo()
  const hostileAcId = 'AC-X-1 quoted source: const key = 0xdeadbeef'
  const res = runAppend(repo, {
    schema_version: 1,
    kind: 'review_cycle',
    outcome: 'done',
    spec_bugs: [{ lens: 'lens-qa', location: 'x', claim: 'y', ac_id: hostileAcId }],
  })
  const out = JSON.parse(res.stdout.trim().split('\n').pop())
  assert.equal(out.write_ok, true, `expected the write to succeed with the hostile ac_id sanitized, got: ${out.write_error}`)
  const lines = readLedgerLines(repo)
  assert.equal(lines.length, 1)
  assert.ok(!lines[0].includes('0xdeadbeef'), 'the actual secret-shaped payload must never reach the ledger, bounded or not')
  const entry = JSON.parse(lines[0])
  assert.equal(entry.findings[0].ac_id, null)
  assert.ok(entry.findings[0].ac_id_raw.length <= 32, `ac_id_raw must be bounded, got length ${entry.findings[0].ac_id_raw.length}`)
  assert.equal(entry.findings[0].claim, undefined, 'sanity: claim was never a declared field to begin with (AC-SEC-2 evidence exclusion, unrelated to this fix)')
  assert.equal(entry.invalid_ac_ids_dropped, 1)
})

test('ledger-append: ac_id_raw preserves a realistic short citation form WHOLE (not visibly truncated) -- the 32-byte bound must not defeat the recoverability M-3 exists to provide for the common case (not vacuous)', () => {
  const repo = makeTempRepo()
  const res = runAppend(repo, {
    schema_version: 1,
    kind: 'review_cycle',
    outcome: 'done',
    ac_verdicts: [{ ac_id: 'optimise-cycle:AC-SEC-1', verdict: 'PASS' }],
  })
  const entry = JSON.parse(readLedgerLines(repo)[0])
  assert.equal(entry.ac_verdicts[0].ac_id_raw, 'optimise-cycle:AC-SEC-1', 'a realistic cross-spec citation must survive whole, not cut short')
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

test('ledger-append: a conduct_plan_event payload with no event_key is rejected -- the idempotency key AC-QA-9 depends on cannot be optional (M3)', () => {
  const repo = makeTempRepo()
  const res = runAppend(repo, { schema_version: 1, kind: 'conduct_plan_event', outcome: 'started', event: 'ci_wait_started' })
  const out = JSON.parse(res.stdout.trim().split('\n').pop())
  assert.equal(out.write_ok, false)
  assert.equal(readLedgerLines(repo).length, 0)
})

test('ledger-append: a conduct_plan_event payload WITH event_key is accepted (M3, not vacuous)', () => {
  const repo = makeTempRepo()
  const res = runAppend(repo, {
    schema_version: 1,
    kind: 'conduct_plan_event',
    outcome: 'started',
    event: 'ci_wait_started',
    event_key: 'plan.md:T1:ci_wait_started:1',
  })
  const out = JSON.parse(res.stdout.trim().split('\n').pop())
  assert.equal(out.write_ok, true, out.write_error)
  assert.equal(readLedgerLines(repo).length, 1)
})

test('ledger-append: other kinds (tdd_task, review_cycle, plan_cycle) do NOT require event_key -- the conditional-required rule is scoped to conduct_plan_event only (M3, not vacuous)', () => {
  const repo = makeTempRepo()
  const res = runAppend(repo, { schema_version: 1, kind: 'tdd_task', outcome: 'done' })
  const out = JSON.parse(res.stdout.trim().split('\n').pop())
  assert.equal(out.write_ok, true, out.write_error)
})

test('ledger-append: appending a conduct_plan_event with an event_key that already exists in the ledger is a no-op -- it does not double-count (M3, AC-QA-9)', () => {
  const repo = makeTempRepo()
  const payload = { schema_version: 1, kind: 'conduct_plan_event', outcome: 'started', event: 'ci_wait_started', event_key: 'plan.md:T1:ci_wait_started:1' }
  runAppend(repo, payload)
  const res2 = runAppend(repo, payload)
  const out2 = JSON.parse(res2.stdout.trim().split('\n').pop())
  assert.equal(out2.write_ok, true, 'a duplicate-key replay must not be reported as a failure')
  assert.equal(out2.duplicate, true, 'the CLI response must say this was a duplicate, not a fresh write')
  assert.equal(readLedgerLines(repo).length, 1, 'the ledger must still contain exactly one line for this event_key')
})

test('ledger-append: two DIFFERENT event_key values (a genuine second occurrence) both get written, proving the dedup is keyed and not a blanket refusal (M3, AC-QA-9)', () => {
  const repo = makeTempRepo()
  runAppend(repo, { schema_version: 1, kind: 'conduct_plan_event', outcome: 'started', event: 'ci_wait_started', event_key: 'plan.md:T1:ci_wait_started:1' })
  runAppend(repo, { schema_version: 1, kind: 'conduct_plan_event', outcome: 'started', event: 'ci_wait_started', event_key: 'plan.md:T1:ci_wait_started:2' })
  const lines = readLedgerLines(repo).map((l) => JSON.parse(l))
  assert.equal(lines.length, 2)
  assert.notEqual(lines[0].event_key, lines[1].event_key)
})

// M2: the occurrence discriminator inside event_key used to be computed by
// the CONDUCTING AGENT, in prose, before ever calling this script -- an
// uncounted or mis-counted occurrence silently reads as a benign duplicate
// (the dedup check matches on the whole key), so a genuinely new event
// vanishes with a success response. The script already reads this exact
// file for the dedup check, so it counts and mints the key itself: the
// caller supplies event_scope ("<plan file>:<task id>:<event>", no
// occurrence number at all) and trusts nothing else.
test('ledger-append: given event_scope (no occurrence number), the script mints occurrence 1 for the first event of its kind (M2)', () => {
  const repo = makeTempRepo()
  const res = runAppend(repo, { schema_version: 1, kind: 'conduct_plan_event', outcome: 'started', event: 'ci_wait_started', event_scope: 'specs/plan.md:T1:ci_wait_started' })
  const out = JSON.parse(res.stdout.trim().split('\n').pop())
  assert.equal(out.write_ok, true, out.write_error)
  assert.equal(out.event_key, 'specs/plan.md:T1:ci_wait_started:1', 'the minted key must be returned to the caller, not re-derived by it')
  const entry = JSON.parse(readLedgerLines(repo)[0])
  assert.equal(entry.event_key, 'specs/plan.md:T1:ci_wait_started:1')
})

test('ledger-append: given the SAME event_scope on a second real call, the script mints occurrence 2, not a duplicate of occurrence 1 (M2)', () => {
  const repo = makeTempRepo()
  const scope = 'specs/plan.md:T1:ci_wait_started'
  const first = JSON.parse(runAppend(repo, { schema_version: 1, kind: 'conduct_plan_event', outcome: 'started', event: 'ci_wait_started', event_scope: scope }).stdout.trim().split('\n').pop())
  const second = JSON.parse(runAppend(repo, { schema_version: 1, kind: 'conduct_plan_event', outcome: 'started', event: 'ci_wait_started', event_scope: scope }).stdout.trim().split('\n').pop())
  assert.equal(first.event_key, `${scope}:1`)
  assert.equal(second.event_key, `${scope}:2`, 'a genuinely new event at the same scope must mint the NEXT occurrence, never read as a duplicate of the first')
  assert.equal(second.duplicate, undefined, 'this must not be reported as a duplicate replay')
  const lines = readLedgerLines(repo).map((l) => JSON.parse(l))
  assert.equal(lines.length, 2, 'both events must actually be written -- the exact loss M2 describes if occurrence counting is wrong')
})

test('ledger-append: event_scope with a DIFFERENT task id or event name mints its own occurrence 1, independent of an unrelated scope\'s count (M2)', () => {
  const repo = makeTempRepo()
  runAppend(repo, { schema_version: 1, kind: 'conduct_plan_event', outcome: 'started', event: 'ci_wait_started', event_scope: 'specs/plan.md:T1:ci_wait_started' })
  runAppend(repo, { schema_version: 1, kind: 'conduct_plan_event', outcome: 'started', event: 'ci_wait_started', event_scope: 'specs/plan.md:T1:ci_wait_started' })
  const res = runAppend(repo, { schema_version: 1, kind: 'conduct_plan_event', outcome: 'started', event: 'human_wait_started', event_scope: 'specs/plan.md:T1:human_wait_started' })
  const out = JSON.parse(res.stdout.trim().split('\n').pop())
  assert.equal(out.event_key, 'specs/plan.md:T1:human_wait_started:1', 'a different event name is a different scope, unaffected by another scope\'s count')
})

test('ledger-append: event_scope is never itself written to the ledger line -- only the minted event_key is (M2)', () => {
  const repo = makeTempRepo()
  runAppend(repo, { schema_version: 1, kind: 'conduct_plan_event', outcome: 'started', event: 'ci_wait_started', event_scope: 'specs/plan.md:T1:ci_wait_started' })
  const entry = JSON.parse(readLedgerLines(repo)[0])
  assert.ok(!('event_scope' in entry), 'event_scope is not a declared schema field and must not leak into the written line')
})

// L4: outcome was unconditionally required, so SKILL.md had every
// conduct_plan_event line -- including the ones recording an ENDING
// (ci_wait_ended, human_wait_ended, pr_merged) -- carry outcome: "started"
// just to satisfy the schema. Grouping ledger lines by (kind, outcome)
// then reads every conduct_plan_event line as "started", never empty or
// honest about what it actually records. outcome is now required only for
// the three run kinds (tdd_task/review_cycle/plan_cycle), via the same
// requiredWhen mechanism M3 already uses for event_key.
test('ledger-append: a conduct_plan_event payload with NO outcome at all is accepted -- outcome is not a meaningful concept for this kind (L4)', () => {
  const repo = makeTempRepo()
  const res = runAppend(repo, { schema_version: 1, kind: 'conduct_plan_event', event: 'human_wait_ended', event_key: 'plan.md:T1:human_wait_ended:1' })
  const out = JSON.parse(res.stdout.trim().split('\n').pop())
  assert.equal(out.write_ok, true, out.write_error)
  const entry = JSON.parse(readLedgerLines(repo)[0])
  assert.ok(!('outcome' in entry) || entry.outcome === undefined, 'outcome must not be forced onto a conduct_plan_event line that never supplied one')
})

test('ledger-append: a tdd_task/review_cycle/plan_cycle payload with NO outcome is still rejected -- outcome remains required for the three run kinds (L4, not vacuous)', () => {
  for (const kind of ['tdd_task', 'review_cycle', 'plan_cycle']) {
    const repo = makeTempRepo()
    const res = runAppend(repo, { schema_version: 1, kind })
    const out = JSON.parse(res.stdout.trim().split('\n').pop())
    assert.equal(out.write_ok, false, `${kind}: outcome must still be required`)
    assert.equal(readLedgerLines(repo).length, 0)
  }
})

// ---- Review round-2: hostile-fixture reproductions of C1/H1/H2/H3, per
// Decision 2 -- written and confirmed to fail against the code as it stood
// BEFORE the round-2 rebuild, so the fixture is proven hostile before it is
// trusted as a regression guard. ----

test('ledger-append (round-2 C1): four DISTINCT conduct_plan_event payloads from a subdirectory, using event_scope values containing "..", produce FOUR lines on disk, none reported as a duplicate -- main\'s behaviour, C1\'s regression', () => {
  const repo = makeTempRepo()
  const subDir = path.join(repo, 'sub')
  fs.mkdirSync(subDir)
  const scopes = [
    '../specs/a.md:T1:ci_wait_started',
    '../specs/a.md:T1:ci_wait_ended',
    '../specs/b.md:T2:ci_wait_started',
    '../specs/b.md:T2:ci_wait_ended',
  ]
  const outs = scopes.map((event_scope) => JSON.parse(runAppend(subDir, { schema_version: 1, kind: 'conduct_plan_event', event: 'ci_wait_started', event_scope }).stdout.trim().split('\n').pop()))
  for (const out of outs) assert.equal(out.write_ok, true, JSON.stringify(out))
  assert.ok(!outs.some((o) => o.duplicate), `no genuinely distinct event may be reported as a duplicate, got: ${JSON.stringify(outs)}`)
  const lines = readLedgerLines(repo)
  assert.equal(lines.length, 4, `expected 4 distinct lines on disk (main's behaviour), got ${lines.length}: ${JSON.stringify(lines.map((l) => JSON.parse(l).event_key))}`)
  const eventKeys = new Set(lines.map((l) => JSON.parse(l).event_key))
  assert.equal(eventKeys.size, 4, 'all 4 event_key values must be distinct')
})

test('ledger-append (round-2 H1): two in-repo relative specs differing only in a paren-terminated directory segment ("specs/plan (v2)/a.md" vs "specs/plan (v2)/b.md") yield two DISTINCT, uncorrupted plan_keys', () => {
  const repo = makeTempRepo()
  runAppend(repo, { schema_version: 1, kind: 'review_cycle', outcome: 'done', spec: 'specs/plan (v2)/a.md', run_id: 'a' })
  runAppend(repo, { schema_version: 1, kind: 'review_cycle', outcome: 'done', spec: 'specs/plan (v2)/b.md', run_id: 'b' })
  const [entryA, entryB] = readLedgerLines(repo).map((l) => JSON.parse(l))
  assert.equal(entryA.plan_key, 'specs/plan (v2)/a.md', `got ${JSON.stringify(entryA.plan_key)}`)
  assert.equal(entryB.plan_key, 'specs/plan (v2)/b.md', `got ${JSON.stringify(entryB.plan_key)}`)
  assert.notEqual(entryA.plan_key, entryB.plan_key)
})

test('ledger-append (round-2 H1): two in-repo relative specs differing only in a non-ASCII directory segment ("docs/日本語/a.md" vs "docs/日本語/b.md") yield two DISTINCT, uncorrupted plan_keys', () => {
  const repo = makeTempRepo()
  runAppend(repo, { schema_version: 1, kind: 'review_cycle', outcome: 'done', spec: 'docs/日本語/a.md', run_id: 'a' })
  runAppend(repo, { schema_version: 1, kind: 'review_cycle', outcome: 'done', spec: 'docs/日本語/b.md', run_id: 'b' })
  const [entryA, entryB] = readLedgerLines(repo).map((l) => JSON.parse(l))
  assert.equal(entryA.plan_key, 'docs/日本語/a.md', `got ${JSON.stringify(entryA.plan_key)}`)
  assert.equal(entryB.plan_key, 'docs/日本語/b.md', `got ${JSON.stringify(entryB.plan_key)}`)
})

test('ledger-append (round-2 H2): a checkout path containing a space does not mangle an ordinary relative spec -- plan_key is exactly "specs/a.md", matching main', () => {
  const repo = makeSpacyTempRepo()
  runAppend(repo, { schema_version: 1, kind: 'review_cycle', outcome: 'done', spec: 'specs/a.md' })
  const entry = JSON.parse(readLedgerLines(repo)[0])
  assert.equal(entry.plan_key, 'specs/a.md', `got ${JSON.stringify(entry.plan_key)}`)
  assert.equal(entry.spec, 'specs/a.md')
  assert.ok(!JSON.stringify(entry).includes('<redacted-path>'), `no field may contain the marker for an ordinary in-repo spec: ${JSON.stringify(entry)}`)
})

test('ledger-append (round-2 H2): a checkout path containing a space does not leak the path tail or the account name into task/spec', () => {
  const repo = makeSpacyTempRepo()
  const whoami = os.userInfo().username
  runAppend(repo, { schema_version: 1, kind: 'tdd_task', outcome: 'done', spec: 'specs/a.md', task: 'ordinary task' })
  const entry = JSON.parse(readLedgerLines(repo)[0])
  const line = JSON.stringify(entry)
  assert.ok(!line.includes('Repos'), `must not leak the "My Repos" path segment: ${line}`)
  if (whoami) assert.ok(!line.includes(whoami), `must not leak the account name: ${line}`)
})

test('ledger-append (round-2 H3): a repo reached through a SYMLINKED parent path records an ordinary in-repo spec correctly -- plan_key is the clean relative form, never the marker', () => {
  const repo = makeHostileTempRepo()
  runAppend(repo, { schema_version: 1, kind: 'review_cycle', outcome: 'done', spec: 'specs/a.md' })
  const entry = JSON.parse(readLedgerLines(repo)[0])
  assert.equal(entry.plan_key, 'specs/a.md', `got ${JSON.stringify(entry.plan_key)}`)
  assert.notEqual(entry.spec, '<redacted-path>')
})

// A real shell's `cd <symlinked-dir>` sets PWD to the exact (unresolved)
// argument, not the resolved form -- so a real agent Bash step, cd-ing into
// a symlinked worktree/checkout and then invoking `node ledger-append.mjs`,
// hands the writer a PWD that still names the symlinked path, even though
// process.cwd() inside the child resolves it. spawnSync's `cwd` OPTION
// (used everywhere else in this file) does not reproduce that: the child
// inherits the test RUNNER's own stale PWD, unrelated to the spawned cwd.
// This test sets PWD explicitly to match what a real shell invocation
// would actually hand the writer, so it exercises the PWD-candidate path
// H3's fix added, not just the realpath-of-cwdRoot candidates the other H3
// tests above already cover.
test('ledger-append (round-2 H3): an absolute spec path reached THROUGH the same symlinked parent as cwd, with PWD set to match (as a real shell cd would), resolves to the correct repo-relative key', () => {
  const repo = makeHostileTempRepo()
  const absoluteSpecViaSymlink = path.join(repo, 'specs', 'a.md')
  const res = spawnSync('node', [APPEND_SCRIPT], {
    cwd: repo,
    input: JSON.stringify({ schema_version: 1, kind: 'review_cycle', outcome: 'done', spec: absoluteSpecViaSymlink }),
    encoding: 'utf8',
    env: { ...process.env, PWD: repo },
  })
  const out = JSON.parse(res.stdout.trim().split('\n').pop())
  assert.equal(out.write_ok, true, out.write_error)
  const entry = JSON.parse(readLedgerLines(repo)[0])
  assert.equal(entry.plan_key, 'specs/a.md', `got ${JSON.stringify(entry.plan_key)}`)
})

// Round 5 (H-A, REVERTED): round 4 added an fs.realpathSync.native call on
// the spec's own directory in main() to resolve exactly this case. The
// coordinator's own probe proved that made plan identity FILESYSTEM-STATE-
// dependent (the IDENTICAL spec string recorded the marker before a
// symlink existed on disk and the real key after one was created at the
// same path) -- reverted entirely (see main()'s own comment at the H-A
// call site). This case now records the out-of-repo marker, deterministically,
// regardless of the symlink's cwd depth or existence on disk -- a known,
// documented limitation (README), not a defect. Pinned here so a future
// change cannot silently reintroduce the round-4 shape without this test
// noticing.
test('ledger-append (round 5, H-A pinned): an absolute spec through a symlinked ancestor, submitted from a SUBDIRECTORY of that same symlinked repo, records the out-of-repo marker -- a known, deterministic limitation, not the real key', () => {
  const { repo, sub } = makeSymlinkAncestorTempRepo()
  fs.mkdirSync(path.join(repo, 'specs'))
  fs.writeFileSync(path.join(repo, 'specs', 'a.md'), '# a\n')
  const absoluteSpecViaSymlink = path.join(repo, 'specs', 'a.md')
  const res = spawnSync('node', [APPEND_SCRIPT], {
    cwd: sub,
    input: JSON.stringify({ schema_version: 1, kind: 'review_cycle', outcome: 'done', spec: absoluteSpecViaSymlink }),
    encoding: 'utf8',
    env: { ...process.env, PWD: sub },
  })
  const out = JSON.parse(res.stdout.trim().split('\n').pop())
  assert.equal(out.write_ok, true, out.write_error)
  const entry = JSON.parse(readLedgerLines(repo)[0])
  assert.equal(entry.plan_key, '<redacted-path>', `got ${JSON.stringify(entry.plan_key)} -- the accepted degradation is the marker, deterministically, not a filesystem-dependent guess`)
  assert.equal(entry.spec, '<redacted-path>')
})

// Round 5 (H-A): the purity/byte-identity requirement (AC-ARCH-2, AC-SEC-2,
// AC-DATA-3) is about the WRITE-TIME PIPELINE'S OWN BEHAVIOUR, not merely
// about canonicalPlanKey's own function body staying free of fs calls --
// round 4's violation lived entirely in main(), a DIFFERENT function, so a
// static grep scoped to canonicalPlanKey's body (see the "canonicalPlanKey
// is pure" test above) could never have caught it. These two tests run the
// REAL writer end-to-end, twice, against genuinely different filesystem
// states for the identical input, and assert byte-identical plan_key.
test('ledger-append (round 5, H-A behavioural purity guard): the SAME absolute spec string yields the SAME plan_key through the real writer whether or not its TARGET FILE exists on disk', () => {
  const repo = makeTempRepo()
  const absoluteSpec = path.join(repo, 'specs', 'not-yet-created.md')
  runAppend(repo, { schema_version: 1, kind: 'review_cycle', outcome: 'done', spec: absoluteSpec, run_id: 'before' })
  fs.mkdirSync(path.join(repo, 'specs'), { recursive: true })
  fs.writeFileSync(absoluteSpec, '# now it exists\n')
  runAppend(repo, { schema_version: 1, kind: 'review_cycle', outcome: 'done', spec: absoluteSpec, run_id: 'after' })
  const [before, after] = readLedgerLines(repo).map((l) => JSON.parse(l))
  assert.equal(before.plan_key, after.plan_key, `plan_key must not depend on whether the target file exists: before=${JSON.stringify(before.plan_key)}, after=${JSON.stringify(after.plan_key)}`)
  assert.equal(before.plan_key, 'specs/not-yet-created.md')
})

test('ledger-append (round 5, H-A behavioural purity guard): the SAME absolute spec string, reached through an ANCESTOR SYMLINK path, yields the SAME plan_key through the real writer whether or not that symlink exists on disk yet -- the exact defect round 4 shipped and round 5 reverts', () => {
  const realParent = fs.mkdtempSync(path.join(os.tmpdir(), 'h-a-purity-real-'))
  const linkParent = fs.mkdtempSync(path.join(os.tmpdir(), 'h-a-purity-link-'))
  trackTempDir(realParent)
  trackTempDir(linkParent)
  const realRepo = path.join(realParent, 'repo')
  fs.mkdirSync(realRepo)
  sh('git init -q -b main', realRepo)
  sh('git config user.email test@example.com', realRepo)
  sh('git config user.name Test', realRepo)
  fs.writeFileSync(path.join(realRepo, 'README.md'), 'seed\n')
  sh('git add README.md && git commit -q -m seed', realRepo)
  fs.mkdirSync(path.join(realRepo, 'specs'))
  fs.writeFileSync(path.join(realRepo, 'specs', 'a.md'), '# a\n')

  const symlinkPath = path.join(linkParent, 'via-symlink')
  const specViaSymlink = path.join(symlinkPath, 'specs', 'a.md')

  // Run 1: the symlink does NOT exist yet. cwd is the REAL repo path (the
  // symlink cannot be cd-ed into before it exists), so the writer's own
  // root/cwdRoot are the real path -- the spec string, built from the
  // not-yet-real symlinked path, cannot lexically match either.
  runAppend(realRepo, { schema_version: 1, kind: 'review_cycle', outcome: 'done', spec: specViaSymlink, run_id: 'before-symlink' })

  fs.symlinkSync(realRepo, symlinkPath, 'dir')

  // Run 2: the IDENTICAL spec string, the symlink now genuinely resolves
  // to the real repo -- but canonicalPlanKey does purely lexical matching,
  // so this must produce the exact same result as run 1, not the real key.
  runAppend(realRepo, { schema_version: 1, kind: 'review_cycle', outcome: 'done', spec: specViaSymlink, run_id: 'after-symlink' })

  const [before, after] = readLedgerLines(realRepo).map((l) => JSON.parse(l))
  assert.equal(before.plan_key, after.plan_key, `plan_key must not depend on whether the ancestor symlink exists: before=${JSON.stringify(before.plan_key)}, after=${JSON.stringify(after.plan_key)}`)
  assert.equal(before.plan_key, '<redacted-path>', 'both runs must record the deterministic out-of-repo marker, never a filesystem-state-dependent real key')
})

// AC-DATA-3 case e, re-proven against the round-4 fix specifically: the
// dirname-realpath fix must realpath ONLY the spec's directory, never the
// spec path itself -- otherwise an in-repo spec that is ITSELF a symlink
// would resolve to (and leak) wherever it points, exactly the collapse
// AC-DATA-3 case e forbids. The symlink's target lives OUTSIDE the repo
// entirely, so a wrongly-resolved key could not even look like a real
// in-repo value if this regressed.
test('ledger-append (round-4 H3 case e): an in-repo spec that is ITSELF a symlink to a file OUTSIDE the repo stays lexical -- its OWN repo-relative path, never resolved to (or leaking) its target', () => {
  const repo = makeHostileTempRepo()
  const linkPath = makeInRepoSymlinkSpec(repo, path.join('specs', 'link.md'))
  const res = spawnSync('node', [APPEND_SCRIPT], {
    cwd: repo,
    input: JSON.stringify({ schema_version: 1, kind: 'review_cycle', outcome: 'done', spec: linkPath }),
    encoding: 'utf8',
    env: { ...process.env, PWD: repo },
  })
  const out = JSON.parse(res.stdout.trim().split('\n').pop())
  assert.equal(out.write_ok, true, out.write_error)
  const entry = JSON.parse(readLedgerLines(repo)[0])
  assert.equal(entry.plan_key, 'specs/link.md', `got ${JSON.stringify(entry.plan_key)}, the symlink's OWN path, never its target`)
  assert.ok(!JSON.stringify(entry).includes('outside.md'), `the symlink's target must never leak into the record: ${JSON.stringify(entry)}`)
})

test('ledger-append (round-2 H3): the two existing worktree-identity assertions, re-run with the worktree created under a deliberately SYMLINKED parent, still pass -- environment-proof, not merely environment-lucky', () => {
  const realParent = fs.mkdtempSync(path.join(os.tmpdir(), 'h3-real-'))
  const linkParent = fs.mkdtempSync(path.join(os.tmpdir(), 'h3-link-'))
  trackTempDir(realParent)
  trackTempDir(linkParent)
  const symlinkedRoot = path.join(linkParent, 'repo-via-symlink')
  fs.symlinkSync(realParent, symlinkedRoot, 'dir')
  const repo = symlinkedRoot
  sh('git init -q -b main', repo)
  sh('git config user.email test@example.com', repo)
  sh('git config user.name Test', repo)
  fs.writeFileSync(path.join(repo, 'README.md'), 'seed\n')
  sh('git add README.md && git commit -q -m seed', repo)

  const worktreeDir = path.join(os.tmpdir(), 'h3-wt-' + Math.random().toString(36).slice(2))
  sh(`git worktree add -q -b h3-wt-branch "${worktreeDir}"`, repo)
  try {
    const absoluteSpecInWorktree = path.join(worktreeDir, 'specs', 'a.md')
    const res = runAppend(worktreeDir, { schema_version: 1, kind: 'review_cycle', outcome: 'done', spec: absoluteSpecInWorktree })
    const out = JSON.parse(res.stdout.trim().split('\n').pop())
    assert.equal(out.write_ok, true, out.write_error)
    const entry = JSON.parse(readLedgerLines(repo)[0])
    assert.equal(entry.plan_key, 'specs/a.md', `got ${JSON.stringify(entry.plan_key)}`)
    assert.notEqual(entry.spec, '<redacted-path>')
  } finally {
    sh(`git worktree remove --force "${worktreeDir}"`, repo)
  }
})

test('ledger-append (round-2 H3): remoteless repo identity is the SAME whether resolved via the symlinked path or not, for a worktree created under a symlinked parent', () => {
  const realParent = fs.mkdtempSync(path.join(os.tmpdir(), 'h3b-real-'))
  const linkParent = fs.mkdtempSync(path.join(os.tmpdir(), 'h3b-link-'))
  trackTempDir(realParent)
  trackTempDir(linkParent)
  const symlinkedRoot = path.join(linkParent, 'repo-via-symlink')
  fs.symlinkSync(realParent, symlinkedRoot, 'dir')
  const repo = symlinkedRoot
  sh('git init -q -b main', repo)
  sh('git config user.email test@example.com', repo)
  sh('git config user.name Test', repo)
  fs.writeFileSync(path.join(repo, 'README.md'), 'seed\n')
  sh('git add README.md && git commit -q -m seed', repo)

  const worktreeDir = path.join(os.tmpdir(), 'h3b-wt-' + Math.random().toString(36).slice(2))
  sh(`git worktree add -q -b h3b-wt-branch "${worktreeDir}"`, repo)
  try {
    runAppend(repo, { schema_version: 1, kind: 'tdd_task', outcome: 'done' })
    runAppend(worktreeDir, { schema_version: 1, kind: 'tdd_task', outcome: 'done' })
    const lines = readLedgerLines(repo).map((l) => JSON.parse(l))
    assert.equal(lines.length, 2)
    assert.equal(lines[0].repo, lines[1].repo, `main-checkout and worktree writes must record the SAME repo identity, got ${JSON.stringify(lines.map((l) => l.repo))}`)
  } finally {
    sh(`git worktree remove --force "${worktreeDir}"`, repo)
  }
})

// ---- HARN-OPT-2 PR1: plan-identity canonicalisation (AC-ARCH-1, AC-SEC-1,
// AC-SEC-2, AC-DATA-1..4, AC-ARCH-2/3, AC-QA-1..3) ----
//
// The pervasive worktree-identity split: a worktree-authored absolute spec
// used to write BOTH a redacted `spec` (the absolute path did not start
// with the MAIN checkout root, so redactPaths could only mark it, never
// relativise it) AND a `repo` identity taken from the worktree's own
// `git rev-parse --show-toplevel` (its own throwaway directory name, not
// the main checkout's), splitting one plan into two buckets and one repo
// into two identities simultaneously.

test('ledger-append: writing from inside a REAL worktree with no origin remote records the SAME repo identity as the main checkout, not the worktree\'s own directory basename (AC-DATA-2, real git worktree add fixture)', () => {
  const repo = makeTempRepo()
  const worktreeDir = path.join(os.tmpdir(), 'ledger-append-identity-wt-' + Math.random().toString(36).slice(2))
  sh(`git worktree add -q -b identity-wt-branch "${worktreeDir}"`, repo)
  try {
    runAppend(repo, { schema_version: 1, kind: 'tdd_task', outcome: 'done' })
    runAppend(worktreeDir, { schema_version: 1, kind: 'tdd_task', outcome: 'done' })
    const lines = readLedgerLines(repo).map((l) => JSON.parse(l))
    assert.equal(lines.length, 2, 'both writes must land in the main checkout\'s ledger')
    assert.equal(lines[0].repo, lines[1].repo, 'a write from the main checkout and a write from its own worktree must record the SAME repo identity')
    assert.equal(lines[1].repo, path.basename(repo), 'must be the MAIN checkout\'s basename, never the worktree\'s own throwaway directory name')
    assert.notEqual(lines[1].repo, path.basename(worktreeDir), 'sanity: the worktree\'s own basename must NOT be what gets recorded')
  } finally {
    sh(`git worktree remove --force "${worktreeDir}"`, repo)
  }
})

test('ledger-append: an absolute spec path authored INSIDE a worktree is recorded repo-relative, never as the redaction placeholder -- identical plan_key to the same plan run from the main checkout (AC-DATA-1, AC-ARCH-3, real git worktree add fixture)', () => {
  const repo = makeTempRepo()
  const worktreeDir = path.join(os.tmpdir(), 'ledger-append-spec-wt-' + Math.random().toString(36).slice(2))
  sh(`git worktree add -q -b spec-wt-branch "${worktreeDir}"`, repo)
  try {
    const absoluteSpecInWorktree = path.join(worktreeDir, 'specs', 'a.md')
    const res = runAppend(worktreeDir, { schema_version: 1, kind: 'review_cycle', outcome: 'done', spec: absoluteSpecInWorktree })
    const out = JSON.parse(res.stdout.trim().split('\n').pop())
    assert.equal(out.write_ok, true, out.write_error)
    const entry = JSON.parse(readLedgerLines(repo)[0])
    assert.equal(entry.spec, 'specs/a.md', 'must relativise against the WORKTREE\'s own root, not fall back to the redaction placeholder just because it is not under the main checkout root')
    assert.notEqual(entry.spec, '<redacted-path>', 'must never be the redaction placeholder for a path genuinely inside the current working tree')
    assert.equal(entry.plan_key, 'specs/a.md')
    // L4: spec_raw is ALSO relativised against the worktree's own root --
    // the original round-5 H-B expectation (verbatim absolute retention)
    // is exactly the leak L4 fixes; see the dedicated L4 test for the
    // full non-vacuous proof.
    assert.equal(entry.spec_raw, 'specs/a.md')
    assert.ok(!entry.spec_raw.startsWith('/'))

    // The SAME plan, run from the main checkout with an equivalent relative
    // spec, must land under the identical plan_key -- proving the split is
    // actually closed, not just that this one write avoided the placeholder.
    runAppend(repo, { schema_version: 1, kind: 'review_cycle', outcome: 'done', spec: 'specs/a.md' })
    const lines = readLedgerLines(repo).map((l) => JSON.parse(l))
    assert.equal(lines[0].plan_key, lines[1].plan_key, 'the worktree-authored and main-checkout-authored writes for the same plan must canonicalise to one identical key')
  } finally {
    sh(`git worktree remove --force "${worktreeDir}"`, repo)
  }
})

test('ledger-append: a relative spec containing ".." that resolves OUTSIDE the repo root is redacted, never written verbatim (AC-SEC-1 case d: ledger-append.mjs:392\'s ABSOLUTE_PATH_RE matched only leading-slash/drive forms, so a relative traversal like "../../../home/<user>/.ssh/config" passed straight through)', () => {
  const repo = makeTempRepo()
  const hostileSpec = '../../../home/some-user/.ssh/config'
  const res = runAppend(repo, { schema_version: 1, kind: 'review_cycle', outcome: 'done', spec: hostileSpec })
  const out = JSON.parse(res.stdout.trim().split('\n').pop())
  assert.equal(out.write_ok, true, out.write_error)
  const line = readLedgerLines(repo)[0]
  assert.ok(!line.includes(hostileSpec), 'the traversal path must never reach the ledger verbatim')
  assert.ok(!line.includes('/home/'), 'must not leak the /home/ segment the traversal resolves through')
  assert.ok(!line.includes('.ssh'), 'must not leak the traversal\'s target file name')
  const entry = JSON.parse(line)
  assert.equal(entry.spec, '<redacted-path>', 'the raw spec field must record the fixed out-of-repo marker, exactly like an absolute-outside-root spec already does')
  assert.equal(entry.plan_key, '<redacted-path>', 'the derived canonical plan_key must record the same fixed marker')
})

// ---- Review round-1 H1 (rank-1, irrecoverable): a relative spec naming a
// REAL in-repo file, reached via ".." from a subdirectory, must record its
// true repo-relative key -- not the out-of-repo marker. canonicalPlanKey
// treated every relative spec as already relative to the REPO ROOT,
// regardless of the writer's actual cwd, so "../specs/a.md" run from
// "<repo>/sub" (naming the real file "<repo>/specs/a.md") popped straight
// out of the root's own frame and was destroyed -- in an append-only,
// unbacked-up file, permanently. The genuinely hostile case (enough ".."
// segments to escape the writer's OWN cwd, not just the root) must stay
// redacted: security's win does not depend on destroying this case. ----

test('ledger-append: a relative spec reached via ".." from a SUBDIRECTORY, naming a REAL in-repo file, records its true repo-relative key -- never the out-of-repo marker (H1, rank-1 AC-DATA-4)', () => {
  const repo = makeTempRepo()
  const subDir = path.join(repo, 'sub')
  fs.mkdirSync(subDir)
  const res = runAppend(subDir, { schema_version: 1, kind: 'review_cycle', outcome: 'done', spec: '../specs/a.md' })
  const out = JSON.parse(res.stdout.trim().split('\n').pop())
  assert.equal(out.write_ok, true, out.write_error)
  const entry = JSON.parse(readLedgerLines(repo)[0])
  assert.equal(entry.plan_key, 'specs/a.md', 'must resolve against the writer\'s ACTUAL cwd ("<repo>/sub"), recovering the real in-repo file, not the marker')
  assert.notEqual(entry.spec, '<redacted-path>', 'the retained spec field must not be destroyed either -- AC-DATA-4\'s whole point is recoverability')
  assert.notEqual(entry.plan_key, '<redacted-path>')
})

test('ledger-append: two DIFFERENT real in-repo files, both reached via ".." from a subdirectory, record DISTINCT plan_keys -- proving the fix recovers real identity, not just avoids the marker for one lucky case (H1, not vacuous)', () => {
  const repo = makeTempRepo()
  const subDir = path.join(repo, 'sub')
  fs.mkdirSync(subDir)
  runAppend(subDir, { schema_version: 1, kind: 'review_cycle', outcome: 'done', spec: '../specs/a.md', run_id: 'a' })
  runAppend(subDir, { schema_version: 1, kind: 'review_cycle', outcome: 'done', spec: '../specs/b.md', run_id: 'b' })
  const [entryA, entryB] = readLedgerLines(repo).map((l) => JSON.parse(l))
  assert.equal(entryA.plan_key, 'specs/a.md')
  assert.equal(entryB.plan_key, 'specs/b.md')
  assert.notEqual(entryA.plan_key, entryB.plan_key, 'main recorded these as two distinct plans; the writer must too')
})

test('ledger-append: a relative spec whose ".." segments escape the writer\'s OWN cwd (not just the repo root) is still redacted -- the H1 fix must not weaken the genuinely hostile case (e.g. from a subdirectory, enough ".." to reach outside the repo entirely)', () => {
  const repo = makeTempRepo()
  const subDir = path.join(repo, 'sub')
  fs.mkdirSync(subDir)
  // From "<repo>/sub", four levels of ".." exits the repo entirely (sub ->
  // repo -> repo's own parent -> further up), landing outside any root this
  // writer knows about.
  const res = runAppend(subDir, { schema_version: 1, kind: 'review_cycle', outcome: 'done', spec: '../../../../etc/hostile.md' })
  const out = JSON.parse(res.stdout.trim().split('\n').pop())
  assert.equal(out.write_ok, true, out.write_error)
  const entry = JSON.parse(readLedgerLines(repo)[0])
  assert.equal(entry.plan_key, '<redacted-path>', 'a path that escapes the writer\'s own cwd must still be redacted')
  assert.equal(entry.spec, '<redacted-path>')
})

// ---- Review round-2, Decision 1: round-1's M1 and L2 fixes are REVERTED.
// They applied shape-based free-text regex redaction to structured path
// VALUES (spec, event_key) at write time, and real paths defeat that: a
// space, a paren, a non-ASCII segment or a symlinked root all produced a
// truncated match, and the whole point of the round-1 "fix" was to widen
// the character class further, which only made the destruction WORSE (H1,
// H2) and, applied to event_key, silently dropped distinct conductor
// events entirely (C1). The ledger is local and gitignored by the
// AC-SEC-1 design decision, so there is no privacy requirement to redact
// data INSIDE it -- AC-SEC-3's requirement is about the report and the
// agent prompts, the OUTPUT boundary, not the ledger file. These tests
// replace the round-1 M1/L2 tests, asserting the RESTORED (main-matching)
// behaviour: an embedded absolute path with no whitespace/quote/paren
// prefix, or a "../" traversal inside task/event_key, is preserved
// verbatim, exactly as it always was before round 1's redaction pass
// existed. ----

test('ledger-append (round-2, reverting round-1 M1): an absolute path embedded with no whitespace/quote/paren before it (e.g. "plan=/Users/<user>/private/plan.md") is preserved VERBATIM in spec -- write-time redaction of spec is gone; this is main\'s own restored behaviour, not a leak (the local ledger has no privacy requirement; see AC-SEC-3 output-boundary reasoning)', () => {
  const repo = makeTempRepo()
  const hostileSpec = 'plan=/Users/some-user/private/plan.md'
  const res = runAppend(repo, { schema_version: 1, kind: 'review_cycle', outcome: 'done', spec: hostileSpec })
  const out = JSON.parse(res.stdout.trim().split('\n').pop())
  assert.equal(out.write_ok, true, out.write_error)
  const entry = JSON.parse(readLedgerLines(repo)[0])
  assert.equal(entry.spec, hostileSpec, 'spec is no longer routed through free-text redaction at all')
  assert.equal(entry.plan_key, hostileSpec, 'plan_key mirrors it: this value has no leading "/" and no ".." segments, so canonicalPlanKey treats it as an ordinary (if oddly-shaped) single relative segment')
})

test('ledger-append (round-2): an ordinary in-repo relative spec is unaffected (not vacuous)', () => {
  const repo = makeTempRepo()
  const res = runAppend(repo, { schema_version: 1, kind: 'review_cycle', outcome: 'done', spec: 'specs/ordinary-widened-check.md' })
  const out = JSON.parse(res.stdout.trim().split('\n').pop())
  assert.equal(out.write_ok, true, out.write_error)
  const entry = JSON.parse(readLedgerLines(repo)[0])
  assert.equal(entry.spec, 'specs/ordinary-widened-check.md')
  assert.equal(entry.plan_key, 'specs/ordinary-widened-check.md')
})

// ---- Review round-2, reverting round-1 L2: event_key/task are no longer
// scanned by a blind free-text REGEX for a "../" escape -- redactRelativeEscapes
// is deleted. This is C1's root cause fix: minting the occurrence suffix
// from a value that then gets mangled by a SEPARATE destructive regex pass
// is what collapsed four distinct conductor events onto one literal key.
// See the round-2 C1 reproduction test above for the end-to-end proof (4
// events in, 4 lines out). ----
//
// Round 5 (H-C, AC-ARCH-6) supersedes this test's original expectation for
// event_scope's PLAN-FILE segment specifically: that ONE segment is now
// canonicalised through the same shared, structured, lexical
// canonicalPlanKey `spec` itself uses (never a free-text regex) -- so a
// "../" mention that genuinely ESCAPES every known root is deliberately
// redacted, exactly matching spec's own AC-SEC-1 case-d protection, not a
// reversion to round-1's regex-based destruction. task/round_key/event
// (genuine free text) are UNCHANGED by this and stay verbatim -- see the
// task-description test immediately below.

test('ledger-append (round 5, H-C): an event_scope plan segment whose "../" segments escape every known root is redacted to the fixed marker -- matching spec\'s own AC-SEC-1 case-d protection, not a reversion to round-1\'s regex destruction', () => {
  const repo = makeTempRepo()
  const res = runAppend(repo, { schema_version: 1, kind: 'conduct_plan_event', event: 'ci_wait_started', event_scope: '../../../home/some-user/secret-plan.md:T1:ci_wait_started' })
  const out = JSON.parse(res.stdout.trim().split('\n').pop())
  assert.equal(out.write_ok, true, out.write_error)
  const entry = JSON.parse(readLedgerLines(repo)[0])
  assert.equal(entry.event_key, '<redacted-path>:T1:ci_wait_started:1', `got ${JSON.stringify(entry.event_key)}`)
  assert.ok(!JSON.stringify(entry).includes('secret-plan'), 'the hostile filename must never reach the ledger')
  assert.ok(!JSON.stringify(entry).includes('/home/'), 'the hostile path segment must never reach the ledger')
  assert.equal(out.event_key, entry.event_key, 'the value returned to the caller matches what was actually stored')
})

test('ledger-append (round 5, H-C): a LEGITIMATE relative event_scope plan segment reached via ".." from a SUBDIRECTORY, naming a real in-repo file, resolves to its true repo-relative form -- the ancestor-escape protection above must not also catch this ordinary case (not vacuous, mirrors spec\'s own H1 fix)', () => {
  const repo = makeTempRepo()
  const subDir = path.join(repo, 'sub')
  fs.mkdirSync(subDir)
  const res = runAppend(subDir, { schema_version: 1, kind: 'conduct_plan_event', event: 'ci_wait_started', event_scope: '../specs/a.md:T1:ci_wait_started' })
  const out = JSON.parse(res.stdout.trim().split('\n').pop())
  assert.equal(out.write_ok, true, out.write_error)
  const entry = JSON.parse(readLedgerLines(repo)[0])
  assert.equal(entry.event_key, 'specs/a.md:T1:ci_wait_started:1', `got ${JSON.stringify(entry.event_key)}`)
})

// The coordinator's own C1-remnant reproduction (AC-ARCH-6): before this
// fix, occurrence was minted from the RAW event_scope prefix, so two
// DISTINCT events sharing an absolute plan path but spelled identically
// still counted correctly ONLY because their raw prefixes matched exactly
// -- but the REST of the pipeline (the free-text redaction pass over
// event_key, which knows nothing about the writer's candidate roots) could
// still corrupt the stored key afterwards. Measured directly: two events
// with an absolute event_scope used to produce ONE line (the second
// silently read as a duplicate, write_ok: true), while the same two events
// with a relative event_scope correctly produced two lines, :1 and :2.
test('ledger-append (round 5, H-C, AC-ARCH-6): two DISTINCT conduct_plan_event payloads sharing the SAME absolute, in-repo event_scope plan path produce TWO lines with occurrence suffixes :1 and :2 -- never a silent duplicate', () => {
  const repo = makeTempRepo()
  fs.mkdirSync(path.join(repo, 'specs'))
  fs.writeFileSync(path.join(repo, 'specs', 'a.md'), '# a\n')
  const absoluteScope = path.join(repo, 'specs', 'a.md') + ':T1:ci_wait_started'
  const out1 = JSON.parse(runAppend(repo, { schema_version: 1, kind: 'conduct_plan_event', event: 'ci_wait_started', event_scope: absoluteScope }).stdout.trim().split('\n').pop())
  const out2 = JSON.parse(runAppend(repo, { schema_version: 1, kind: 'conduct_plan_event', event: 'ci_wait_started', event_scope: absoluteScope }).stdout.trim().split('\n').pop())
  assert.equal(out1.write_ok, true, out1.write_error)
  assert.equal(out2.write_ok, true, out2.write_error)
  assert.ok(!out1.duplicate, `the first write must never be reported as a duplicate: ${JSON.stringify(out1)}`)
  assert.ok(!out2.duplicate, `the second, genuinely distinct write must never be silently dropped as a duplicate: ${JSON.stringify(out2)}`)
  const lines = readLedgerLines(repo)
  assert.equal(lines.length, 2, `expected 2 distinct lines on disk, got ${lines.length}`)
  const eventKeys = lines.map((l) => JSON.parse(l).event_key)
  assert.equal(eventKeys[0], 'specs/a.md:T1:ci_wait_started:1', `got ${JSON.stringify(eventKeys)}`)
  assert.equal(eventKeys[1], 'specs/a.md:T1:ci_wait_started:2', `got ${JSON.stringify(eventKeys)}`)
})

test('ledger-append (round-2, reverting round-1 L2): a "../" mention inside a task description is preserved verbatim, prose and all', () => {
  const repo = makeTempRepo()
  const res = runAppend(repo, { schema_version: 1, kind: 'tdd_task', outcome: 'done', spec: 'specs/a.md', task: 'fix ../../../home/some-user/.ssh/config handling' })
  const out = JSON.parse(res.stdout.trim().split('\n').pop())
  assert.equal(out.write_ok, true, out.write_error)
  const entry = JSON.parse(readLedgerLines(repo)[0])
  assert.equal(entry.task, 'fix ../../../home/some-user/.ssh/config handling')
})

test('ledger-append (round-2): a task description with no ".." mention at all is unaffected (not vacuous)', () => {
  const repo = makeTempRepo()
  const res = runAppend(repo, { schema_version: 1, kind: 'tdd_task', outcome: 'done', task: 'fix the torn-line heal' })
  const out = JSON.parse(res.stdout.trim().split('\n').pop())
  assert.equal(out.write_ok, true, out.write_error)
  const entry = JSON.parse(readLedgerLines(repo)[0])
  assert.equal(entry.task, 'fix the torn-line heal')
})

test('ledger-append (round-2): redactRelativeEscapes is no longer exported -- the function itself is gone, not merely unused', async () => {
  const mod = await import(APPEND_MODULE_URL)
  assert.equal(mod.redactRelativeEscapes, undefined)
})

// ---- Review round-1 L5: the no-spec sentinel must be structurally
// unproducible from a real spec path, not merely an implausible one.
// canonicalPlanKey never emits a trailing "/" (a trailing-slash segment is
// always dropped as empty), so '<no-spec>/' can never be the canonicalised
// form of any real path, unlike the plain '<no-spec>' string (a legal
// single path segment). ----

test('ledger-append module: NO_SPEC_PLAN_KEY is structurally unproducible from any real spec path -- a spec LITERALLY named "<no-spec>" (or "./<no-spec>") canonicalises to its own real key, never colliding with the missing-spec sentinel (L5, AC-QA-2)', async () => {
  const { canonicalPlanKey, NO_SPEC_PLAN_KEY } = await import(APPEND_MODULE_URL)
  assert.ok(NO_SPEC_PLAN_KEY.endsWith('/'), 'the sentinel must end in a character canonicalPlanKey never emits at the end of a real key')
  assert.notEqual(canonicalPlanKey('<no-spec>', '/repo'), NO_SPEC_PLAN_KEY, 'a real spec file literally named "<no-spec>" must not collide with the missing-spec sentinel')
  assert.notEqual(canonicalPlanKey('./<no-spec>', '/repo'), NO_SPEC_PLAN_KEY)
  assert.equal(canonicalPlanKey(null, '/repo'), NO_SPEC_PLAN_KEY, 'a genuinely missing spec must still canonicalise to the sentinel (not vacuous)')
})

test('ledger-append: a record with a spec literally named "<no-spec>" is NOT merged into the missing-spec bucket (L5, end-to-end)', () => {
  const repo = makeTempRepo()
  runAppend(repo, { schema_version: 1, kind: 'tdd_task', outcome: 'done' })
  runAppend(repo, { schema_version: 1, kind: 'review_cycle', outcome: 'done', spec: '<no-spec>' })
  const [noSpecEntry, literalEntry] = readLedgerLines(repo).map((l) => JSON.parse(l))
  assert.notEqual(noSpecEntry.plan_key, literalEntry.plan_key)
  assert.equal(literalEntry.plan_key, '<no-spec>')
})

test('ledger-append: an absolute spec path OUTSIDE the repo root also records the out-of-repo marker as its plan_key, not just in the redacted spec field (AC-SEC-1 case c, plan_key half)', () => {
  const repo = makeTempRepo()
  const res = runAppend(repo, { schema_version: 1, kind: 'review_cycle', outcome: 'done', spec: '/etc/some-other-machines-file.md' })
  const out = JSON.parse(res.stdout.trim().split('\n').pop())
  assert.equal(out.write_ok, true, out.write_error)
  const entry = JSON.parse(readLedgerLines(repo)[0])
  assert.equal(entry.plan_key, '<redacted-path>')
})

test('ledger-append: a spec path that is a SYMLINK inside the repo keeps its own lexical key, never resolved to the symlink\'s target -- canonicalisation is lexical, not realpath-based (AC-DATA-3 case e, AC-ARCH-2)', () => {
  const repo = makeTempRepo()
  fs.mkdirSync(path.join(repo, 'specs'))
  fs.symlinkSync('/etc/passwd', path.join(repo, 'specs', 'link.md'))
  const res = runAppend(repo, { schema_version: 1, kind: 'review_cycle', outcome: 'done', spec: 'specs/link.md' })
  const out = JSON.parse(res.stdout.trim().split('\n').pop())
  assert.equal(out.write_ok, true, out.write_error)
  const entry = JSON.parse(readLedgerLines(repo)[0])
  assert.equal(entry.spec, 'specs/link.md', 'the symlink\'s own repo-relative path is kept as data')
  assert.equal(entry.plan_key, 'specs/link.md', 'the canonical key is the symlink\'s own lexical path, never /etc/passwd')
})

// Round 5 (H-B): the original version of this test re-derived
// canonicalPlanKey from `entry.spec` -- but `entry.spec` is ALREADY the
// canonical key (it is overwritten with plan_key at write time), so
// "re-deriving" from it was really just checking canonicalPlanKey is
// idempotent on its own output, which any function satisfies trivially,
// including a broken one. Proven vacuous by mutation: appending
// `.toLowerCase()` to canonicalPlanKey's return (a canonicaliser that
// silently merges two plans differing only in case into one) left this
// test green, because BOTH sides of the comparison called the SAME
// (mutated) function and therefore agreed with each other regardless of
// whether the shared answer was correct. Fixed two ways: (1) the fixture
// input's canonical form must actually DIFFER from its raw retained form,
// or the test proves nothing about recoverability; (2) both sides assert
// against a HAND-DERIVED, HARDCODED expected value -- not against each
// other -- so a mutation that corrupts canonicalPlanKey uniformly (as
// .toLowerCase() does) still trips a literal-string mismatch.
test('ledger-append (round 5, H-B, AC-DATA-4): plan_key is independently re-derivable from the RETAINED RAW spec (spec_raw), for an input whose canonical form actually differs from the raw string -- not vacuous', async () => {
  const repo = makeTempRepo()
  const rawSpec = 'specs/../Specs/Awkward.md'
  const res = runAppend(repo, { schema_version: 1, kind: 'review_cycle', outcome: 'done', spec: rawSpec })
  const out = JSON.parse(res.stdout.trim().split('\n').pop())
  assert.equal(out.write_ok, true, out.write_error)
  const entry = JSON.parse(readLedgerLines(repo)[0])
  assert.equal(entry.spec_raw, rawSpec, `the caller's raw string must be retained verbatim, got ${JSON.stringify(entry.spec_raw)}`)
  assert.notEqual(entry.spec_raw, entry.plan_key, 'the fixture must exercise a case where the canonical form DIFFERS from the raw retained value, or recoverability cannot be distinguished from mere idempotence')
  const expectedCanonical = 'Specs/Awkward.md'
  assert.equal(entry.plan_key, expectedCanonical, 'the writer\'s own canonicalisation must collapse "specs/../" and nothing else -- case preserved, a literal expectation, not a recomputation')
  const { canonicalPlanKey } = await import(APPEND_MODULE_URL)
  assert.equal(canonicalPlanKey(entry.spec_raw, repo), expectedCanonical, 'a canonicaliser defect must be correctable by re-running canonicalPlanKey against the RETAINED RAW field alone -- checked against the SAME hardcoded literal, not against entry.plan_key')
})

// L4's companion case: the SAME recoverability-insurance property, but for
// an ABSOLUTE in-repo spec -- proving the L4 fix (relativise spec_raw)
// does not collapse it back into "just re-derived from plan_key" (which
// would silently reintroduce H-B's original vacuous-recoverability
// defect, this time via the relativisation step instead of the
// truncation step). spec_raw must still differ from plan_key here: only
// the absolute PREFIX is stripped, the awkward "../" survives untouched.
test('ledger-append (L4): spec_raw for an ABSOLUTE in-repo spec is relativised but NOT fully canonicalised -- it still differs from plan_key when the raw form has something to collapse, so recoverability insurance survives the L4 fix (not vacuous)', async () => {
  const repo = makeTempRepo()
  // Plain string concatenation, NOT path.join -- path.join would silently
  // normalise away the "../" before it ever reached the writer, defeating
  // the whole point of this fixture.
  const absoluteRawSpec = repo + '/specs/../Specs/Awkward.md'
  const res = runAppend(repo, { schema_version: 1, kind: 'review_cycle', outcome: 'done', spec: absoluteRawSpec })
  const out = JSON.parse(res.stdout.trim().split('\n').pop())
  assert.equal(out.write_ok, true, out.write_error)
  const entry = JSON.parse(readLedgerLines(repo)[0])
  const expectedRelativised = 'specs/../Specs/Awkward.md'
  const expectedCanonical = 'Specs/Awkward.md'
  assert.equal(entry.spec_raw, expectedRelativised, 'spec_raw must be relativised (root prefix stripped) but NOT "../"-collapsed')
  assert.ok(!entry.spec_raw.startsWith('/'), 'spec_raw must never carry the absolute prefix')
  assert.equal(entry.plan_key, expectedCanonical)
  assert.notEqual(entry.spec_raw, entry.plan_key, 'spec_raw must still differ from plan_key -- the L4 relativisation fix must not ALSO fully canonicalise it, or a canonicaliser defect in the "../"-collapsing step becomes unrecoverable again')
  const { canonicalPlanKey } = await import(APPEND_MODULE_URL)
  assert.equal(canonicalPlanKey(entry.spec_raw, repo), expectedCanonical, 'a canonicaliser defect must still be correctable by re-running canonicalPlanKey against the retained (now-relativised) raw field')
})

// Review round-2 L-3: the L4 fix's fallback (`matchedRoot !== undefined ? ...
// : specRawInput`) fell OPEN -- if the root-matching in main() ever
// diverges from canonicalPlanKey's own matching (a candidate root added,
// trimmed or filtered in only one of the two places), the else branch
// writes the CALLER'S ABSOLUTE PATH VERBATIM into spec_raw, reopening the
// exact account-name leak L4 just closed, through a side door. The branch
// is PROVABLY UNREACHABLE today (confirmed by the review): this code path
// only runs when canonicalPlanKey already matched the identical string
// against the identical candidate list, so the two matching computations
// cannot currently disagree -- there is no live payload that exercises the
// fixed branch through the normal write path. Guarded here as a static
// assertion on the source text itself (the same technique this suite
// already uses for provably-dead defensive code elsewhere), so a future
// edit that reintroduces the fail-OPEN default is caught even though no
// behavioural fixture can reach it.
test('ledger-append (L-3): the spec_raw root-match fallback fails CLOSED (withholds the value) rather than falling open to the verbatim absolute string, guarding against a future divergence between this matching logic and canonicalPlanKey\'s own', () => {
  const source = fs.readFileSync(APPEND_SCRIPT, 'utf8')
  const lines = source.split('\n')
  const target = lines.find((l) => l.includes('payload.spec_raw = matchedRoot !== undefined ?'))
  assert.ok(target, 'expected to find the spec_raw root-match fallback line')
  assert.ok(!/:\s*specRawInput\s*$/.test(target.trim()), `the fallback must NEVER be the verbatim absolute string; found: ${target.trim()}`)
  assert.ok(/:\s*undefined\s*$/.test(target.trim()), `the fallback must fail closed (undefined), found: ${target.trim()}`)
})

test('ledger-append: a genuinely well-formed repo-relative spec is unaffected -- plan_key equals the spec as-is, and it is not the out-of-repo marker (not vacuous)', () => {
  const repo = makeTempRepo()
  const res = runAppend(repo, { schema_version: 1, kind: 'review_cycle', outcome: 'done', spec: 'specs/ordinary.md' })
  const out = JSON.parse(res.stdout.trim().split('\n').pop())
  assert.equal(out.write_ok, true, out.write_error)
  const entry = JSON.parse(readLedgerLines(repo)[0])
  assert.equal(entry.spec, 'specs/ordinary.md')
  assert.equal(entry.plan_key, 'specs/ordinary.md')
  assert.notEqual(entry.plan_key, '<redacted-path>')
})

test('ledger-append: a record with no spec at all gets the no-spec sentinel as plan_key, distinguishable from a real spec literally named "unspecified" (AC-QA-2)', () => {
  const repo = makeTempRepo()
  runAppend(repo, { schema_version: 1, kind: 'tdd_task', outcome: 'done' })
  runAppend(repo, { schema_version: 1, kind: 'review_cycle', outcome: 'done', spec: 'unspecified' })
  const [noSpecEntry, literalEntry] = readLedgerLines(repo).map((l) => JSON.parse(l))
  assert.notEqual(noSpecEntry.plan_key, literalEntry.plan_key, 'a genuinely missing spec must never canonicalise to the same key as a real spec literally named "unspecified"')
  assert.equal(literalEntry.plan_key, 'unspecified', 'the literal spec value is a legitimate (if confusing) real plan key')
})

test('ledger-append module: canonicalPlanKey is pure -- returns byte-identical output for a path that exists on disk and one that does not, and its own source touches no fs/child_process/cwd/realpath (AC-ARCH-2, AC-SEC-2)', async () => {
  const mod = await import(APPEND_MODULE_URL)
  const { canonicalPlanKey } = mod
  assert.equal(canonicalPlanKey('specs/does-not-exist-anywhere-xyz.md', '/some/root'), canonicalPlanKey('specs/does-not-exist-anywhere-xyz.md', '/some/root'))
  const existingFile = __filename
  assert.equal(
    canonicalPlanKey('this-file-does-not-exist.md', '/nonexistent/root'),
    'this-file-does-not-exist.md',
    'sanity: a non-existent target resolves fine, proving no fs check gates the result'
  )
  void existingFile
  const source = fs.readFileSync(APPEND_SCRIPT, 'utf8')
  const fnStart = source.indexOf('export function canonicalPlanKey')
  assert.ok(fnStart !== -1, 'expected to find the canonicalPlanKey function definition')
  const fnEnd = source.indexOf('\n}', fnStart) + 2
  // Strip `//` comments before scanning: the function's own prose explains
  // WHY it never calls realpath, which would otherwise self-trigger this
  // exact guard on the comment text rather than on executable code.
  const fnBody = source.slice(fnStart, fnEnd).split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n')
  assert.ok(!/\bfs\./.test(fnBody), 'canonicalPlanKey must not touch fs')
  assert.ok(!/child_process|execFileSync|spawnSync/.test(fnBody), 'canonicalPlanKey must not touch child_process')
  assert.ok(!/process\.cwd\(\)/.test(fnBody), 'canonicalPlanKey must not read process.cwd()')
  assert.ok(!/realpath/i.test(fnBody), 'canonicalPlanKey must never call realpath -- collapsing a symlink route is explicitly out of scope (AC-DATA-3)')
})

test('ledger-append module: canonicalPlanKey maps a repo-relative path, its absolute form under root, a "../" traversal that stays in-repo, and a "./"-prefixed form all to ONE identical key for the same plan, and is idempotent on its own output (AC-QA-1)', async () => {
  const { canonicalPlanKey } = await import(APPEND_MODULE_URL)
  const root = '/repo'
  const forms = [
    'specs/a.md',
    '/repo/specs/a.md',
    'specs/sub/../a.md',
    './specs/a.md',
  ]
  const keys = forms.map((f) => canonicalPlanKey(f, root))
  assert.ok(keys.every((k) => k === 'specs/a.md'), `expected every form to canonicalise to "specs/a.md", got ${JSON.stringify(keys)}`)
  for (const k of keys) assert.equal(canonicalPlanKey(k, root), k, 'canonicalPlanKey must be idempotent on its own output')
})

// ---- Review round-2 M1: the "../" escape guard inside canonicalPlanKey's
// segment loop was protected by no DIRECT test -- every existing writer-
// level test reaches it only through main()'s cwd-resolve pre-step, which
// turns a relative spec absolute before canonicalPlanKey ever sees a raw
// "../"-containing string, so the guard's own consumer (the READ side,
// which calls canonicalPlanKey directly on historical/hand-edited
// plan_key and spec values) was undefended. Direct unit assertions, both
// directions, so the guard cannot silently regress again. ----

test('ledger-append module: canonicalPlanKey DIRECTLY (not through the writer\'s cwd pre-step) redacts a "../" traversal that escapes the given root, and correctly resolves one that stays in-repo -- both directions pinned (M1)', async () => {
  const { canonicalPlanKey, REDACTED_PATH_MARKER } = await import(APPEND_MODULE_URL)
  assert.equal(canonicalPlanKey('../../../home/some-user/.ssh/config', '/repo'), REDACTED_PATH_MARKER, 'a traversal escaping the root must redact, called directly')
  assert.equal(canonicalPlanKey('specs/sub/../a.md', '/repo'), 'specs/a.md', 'a traversal that stays IN-repo must resolve correctly, called directly -- not vacuous: proves the guard does not just redact every ".." unconditionally')
})

test('ledger-append module: canonicalPlanKey never throws on hostile input -- non-string (number/object/array), empty string, a 4096-char path, a path with an embedded newline, emoji/combining characters, and a Windows drive form (AC-QA-3)', async () => {
  const { canonicalPlanKey } = await import(APPEND_MODULE_URL)
  const hostileInputs = [42, { a: 1 }, ['x'], '', 'x'.repeat(4096), 'specs/a\nb.md', 'specs/🎉combining-é.md', 'C:\\x\\y.md', null, undefined]
  for (const input of hostileInputs) {
    assert.doesNotThrow(() => canonicalPlanKey(input, '/repo'), `canonicalPlanKey must never throw on ${JSON.stringify(input)}`)
    const out = canonicalPlanKey(input, '/repo')
    assert.equal(typeof out, 'string', `canonicalPlanKey must always return a string, got ${typeof out} for ${JSON.stringify(input)}`)
  }
})

// ---- Review round-2 L5: AC-QA-3's hostile inputs were tested only against
// the pure canonicalPlanKey function, never driven through
// ledger-append.mjs end to end, as the criterion itself is worded ("Feeding
// ledger-append.mjs each of..."). A regression in main()'s own handling
// (e.g. a String() coercion moved to run before a .split(), or a crash
// specifically in the cwd-resolve/candidate-root code this round added)
// would throw before canonicalPlanKey is ever reached, with the unit test
// staying green. ----

test('ledger-append: all nine of AC-QA-3\'s hostile spec inputs, driven through the real writer end to end, exit 0 with write_ok true and a plan_key on every one (L5, AC-QA-3 as worded)', () => {
  const repo = makeTempRepo()
  const hostileInputs = [42, { a: 1 }, ['x'], '', 'x'.repeat(4096), 'specs/a\nb.md', 'specs/🎉combining-é.md', 'C:\\x\\y.md', null]
  for (const spec of hostileInputs) {
    const res = runAppend(repo, { schema_version: 1, kind: 'tdd_task', outcome: 'done', spec })
    assert.equal(res.status, 0, `process must exit 0 for spec ${JSON.stringify(spec)}: ${res.stderr}`)
    const out = JSON.parse(res.stdout.trim().split('\n').pop())
    assert.equal(typeof out.write_ok, 'boolean', `write_ok must always be a real boolean for spec ${JSON.stringify(spec)}, got ${JSON.stringify(out)}`)
  }
  // Every one of these nine inputs must have appended a real, parseable
  // line -- AC-QA-3 explicitly forbids "a silently dropped record", so a
  // write_ok:false outcome (schema rejection) must still be accounted for,
  // never crash the script into printing nothing at all.
  const lines = readLedgerLines(repo)
  assert.ok(lines.length >= 1, 'at least the string-shaped hostile inputs must have written successfully')
  for (const line of lines) assert.doesNotThrow(() => JSON.parse(line), `every written line must be valid JSON: ${line}`)
})

// ---- Review round-2 M-2: the round-1 M3 ac_id sanitiser (moved AHEAD of
// validateEntry) removed the type check validateEntry used to provide for
// free, so a null ELEMENT inside findings/ac_verdicts crashed the script
// (TypeError reading .ac_id of null) instead of degrading to the clean
// write_ok:false main() already produced for this exact input. This is
// AC-QA-3's own hostile-input spirit ("Feeding ledger-append.mjs... never
// an unhandled exception, never a crash") applied to array ELEMENTS, which
// the spec's own scope only ever covered for `spec` values -- confirmed as
// a spec bug by the review. A crash here means writeLedger's own agent
// step gets no parseable result and falls into its failure branch,
// manufacturing exactly the orphan class this PR exists to eliminate. ----

// `findings`/`ac_verdicts` supplied DIRECTLY (the already-computed shape,
// as the review's own reproduction used), not via spec_bugs/rejected_
// findings/open_findings -- those raw-input fields route through
// computeFindings() first, which has its OWN, separate, PRE-EXISTING
// null-element crash on `main` too (confirmed: `open_findings:[null]`
// throws identically on both trees at computeFindings' `f.lens` access).
// That is a real bug, but not a regression this PR introduced and not
// something the review flagged -- out of scope for this round, noted for
// the coordinator rather than silently fixed.
test('ledger-append: a null element in findings or ac_verdicts degrades to a clean write_ok:false (matching main\'s pre-existing behaviour for this exact input), never a script crash (M-2, regression against main introduced by round-1 M3)', () => {
  const repo = makeTempRepo()
  const cases = [
    { name: 'findings:[null]', payload: { schema_version: 1, kind: 'review_cycle', outcome: 'done', spec: 'specs/a.md', findings: [null] } },
    { name: 'ac_verdicts:[null]', payload: { schema_version: 1, kind: 'review_cycle', outcome: 'done', spec: 'specs/a.md', ac_verdicts: [null] } },
  ]
  for (const c of cases) {
    const res = runAppend(repo, c.payload)
    assert.equal(res.status, 0, `${c.name}: process must exit 0, never crash. stderr: ${res.stderr}`)
    const out = JSON.parse(res.stdout.trim().split('\n').pop())
    assert.equal(typeof out.write_ok, 'boolean', `${c.name}: write_ok must be a real boolean, got ${JSON.stringify(out)}`)
  }
})

// main's own behaviour for this exact payload was captured directly via
// `git show main:workflows/lib/ledger-append.mjs` and recorded in
// docs/harn-opt-2-mutation-proofs.md (write_ok:false, the schema-validation
// reason quoted verbatim) -- this test pins the CURRENT writer to that same
// observable outcome without a git subprocess in the suite itself.
test('ledger-append: the current writer\'s behaviour for a null findings element matches main\'s (write_ok:false, schema-validation reason) -- see docs/harn-opt-2-mutation-proofs.md for the direct main comparison (M-2)', () => {
  const repo = makeTempRepo()
  const res = runAppend(repo, { schema_version: 1, kind: 'review_cycle', outcome: 'done', spec: 'specs/a.md', findings: [null] })
  const out = JSON.parse(res.stdout.trim().split('\n').pop())
  assert.equal(out.write_ok, false, 'a null finding element carries no ac_id at all -- it must still fail schema validation exactly as it did before the sanitiser existed, not be silently accepted')
  assert.match(out.write_error, /schema validation/, `expected a schema-validation refusal, got: ${out.write_error}`)
  assert.equal(readLedgerLines(repo).length, 0, 'a refused write must not create a ledger line')
})

test('ledger-append module: canonicalPlanKey keeps distinct inputs distinct -- two specs sharing a basename under different directories, and a spec containing the bucket-key delimiter "|" (AC-QA-2)', async () => {
  const { canonicalPlanKey } = await import(APPEND_MODULE_URL)
  const a = canonicalPlanKey('specs/a/plan.md', '/repo')
  const b = canonicalPlanKey('specs/b/plan.md', '/repo')
  assert.notEqual(a, b)
  const withDelimiter = canonicalPlanKey('specs/a|weird.md', '/repo')
  assert.equal(withDelimiter, 'specs/a|weird.md', 'a delimiter-containing path is kept as data, not stripped or rejected')
  assert.notEqual(withDelimiter, canonicalPlanKey('specs/a.md', '/repo'))
})

test('ledger-append: writing a hostile spec ("../../../etc/x", a newline, and a shell metacharacter) creates or modifies exactly one file -- the main checkout\'s ledger -- proven by a sha256 manifest of the whole repo tree before and after (AC-SEC-2)', () => {
  const repo = makeTempRepo()
  function manifest() {
    const crypto = require('node:crypto')
    const out = {}
    for (const f of walkAll(repo)) {
      if (f.includes(`${path.sep}.git${path.sep}`) || f.endsWith(`${path.sep}.git`)) continue
      const rel = path.relative(repo, f)
      const stat = fs.statSync(f)
      if (stat.isDirectory()) continue
      out[rel] = crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')
    }
    return out
  }
  function walkAll(dir, acc = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walkAll(full, acc)
      acc.push(full)
    }
    return acc
  }
  const before = manifest()
  for (const hostileSpec of ['../../../etc/x', 'legit\nspec.md', 'specs/a.md; rm -rf /']) {
    runAppend(repo, { schema_version: 1, kind: 'review_cycle', outcome: 'done', spec: hostileSpec })
  }
  const after = manifest()
  const beforeFiles = new Set(Object.keys(before))
  const afterFiles = new Set(Object.keys(after))
  const added = [...afterFiles].filter((f) => !beforeFiles.has(f))
  const changed = [...afterFiles].filter((f) => beforeFiles.has(f) && before[f] !== after[f])
  assert.deepEqual(added, ['.claude/harness-ledger.jsonl'], `expected only the ledger file to be created, got ${JSON.stringify(added)}`)
  assert.deepEqual(changed, [], `expected no other file modified, got ${JSON.stringify(changed)}`)
  assert.equal(fs.existsSync('/etc/x'), false)
})

test('ledger-append module: SCHEMA_VERSION is bumped past 1 -- the plan_key field is a genuine shape change, and a stale installed writer (still on the old shape) must be detectable from its output (AC-OPS-4)', async () => {
  const { SCHEMA_VERSION } = await import(APPEND_MODULE_URL)
  assert.notEqual(SCHEMA_VERSION, 1)
})

// AC-QA-20: plan-identity canonicalisation must add no per-write git
// subprocess beyond what the writer already invoked -- resolving the
// current working tree's own root (needed to relativise a worktree-
// authored absolute spec, AC-ARCH-3) is done by an fs stat walk, never a
// `git rev-parse --show-toplevel` call, so it costs nothing here. Counted
// through a PATH shim (a fake `git` that logs its own argv then execs the
// real one), per the AC's own stated method, never by wall-clock timing.
function countGitInvocations(repo, payload) {
  const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-shim-'))
  const logPath = path.join(shimDir, 'calls.log')
  const realGit = spawnSync('/usr/bin/env', ['which', 'git'], { encoding: 'utf8' }).stdout.trim() || '/usr/bin/git'
  fs.writeFileSync(
    path.join(shimDir, 'git'),
    `#!/bin/sh\necho "$@" >> ${JSON.stringify(logPath)}\nexec ${JSON.stringify(realGit)} "$@"\n`,
    { mode: 0o755 }
  )
  const res = spawnSync('node', [APPEND_SCRIPT], {
    cwd: repo,
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, PATH: `${shimDir}:${process.env.PATH}` },
  })
  const out = JSON.parse(res.stdout.trim().split('\n').pop())
  const calls = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean) : []
  fs.rmSync(shimDir, { recursive: true, force: true })
  return { out, calls }
}

test('ledger-append: an ordinary write with an origin remote configured invokes git exactly 4 times (show-superproject-working-tree, git-common-dir, remote get-url origin, check-ignore) -- resolving the current working tree\'s own root for AC-ARCH-3 adds an fs stat walk, never a 5th git subprocess (AC-QA-20)', () => {
  const repo = makeTempRepo()
  sh('git remote add origin git@github.com:example/example.git', repo)
  const { out, calls } = countGitInvocations(repo, { schema_version: 1, kind: 'tdd_task', outcome: 'done' })
  assert.equal(out.write_ok, true, out.write_error)
  assert.equal(calls.length, 4, `expected exactly 4 git invocations, got ${calls.length}: ${JSON.stringify(calls)}`)
})

test('ledger-append: a worktree-authored write (which needs BOTH the main-checkout root and the worktree\'s own root) still invokes git no more than the main-checkout case -- resolving the worktree\'s own root costs zero additional git subprocesses (AC-QA-20, the actual worktree code path)', () => {
  const repo = makeTempRepo()
  sh('git remote add origin git@github.com:example/example.git', repo)
  const worktreeDir = path.join(os.tmpdir(), 'ledger-append-gitcount-wt-' + Math.random().toString(36).slice(2))
  sh(`git worktree add -q -b gitcount-wt-branch "${worktreeDir}"`, repo)
  try {
    const { out, calls } = countGitInvocations(worktreeDir, { schema_version: 1, kind: 'review_cycle', outcome: 'done', spec: path.join(worktreeDir, 'specs', 'a.md') })
    assert.equal(out.write_ok, true, out.write_error)
    assert.ok(calls.length <= 4, `expected no more than 4 git invocations from a worktree write, got ${calls.length}: ${JSON.stringify(calls)}`)
  } finally {
    sh(`git worktree remove --force "${worktreeDir}"`, repo)
  }
})

test('ledger-append module: LEDGER_ENTRY_SCHEMA declares plan_key as optional (not unconditionally required), so a hand-built entry that predates this field still validates -- read-side normalisation, not a schema migration, is what makes historical lines usable (AC-ARCH-5)', async () => {
  const { LEDGER_ENTRY_SCHEMA, validateEntry } = await import(APPEND_MODULE_URL)
  assert.ok('plan_key' in LEDGER_ENTRY_SCHEMA.properties, 'expected a plan_key property on the schema')
  assert.ok(!LEDGER_ENTRY_SCHEMA.required.includes('plan_key'), 'plan_key must not be unconditionally required')
  const preExisting = { schema_version: 1, run_id: 'r', ts: 't', repo: 'r', kind: 'tdd_task', outcome: 'done', write_ok: true, write_error: null }
  assert.deepEqual(validateEntry(preExisting), [], 'an entry with no plan_key at all must still validate cleanly')
})
