// HARN-OPT-5 T6: ensureGitignored checks first and, only when the ledger is
// not already ignored, replaces .git/info/exclude atomically (temp file in
// the target's own directory, then rename). Every write goes to a temp repo;
// the real ledger is never touched. Spec: specs/harn-opt-5.md, AC-DATA-1,
// AC-DATA-2, AC-DATA-4, AC-DATA-5, AC-DATA-6, AC-QA-18, AC-SEC-13.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { spawn, spawnSync } = require('node:child_process')
const { APPEND_SCRIPT, LEDGER_REL, SUITE_TMPDIR, sh, sanitizedGitEnv, makeTempRepo, runAppend, readLedgerLines, cleanupTempRepos } = require('./helpers/temp-repo.js')

test.after(cleanupTempRepos)

// Test-only hooks the implementation must honour (env-gated, zero cost when
// unset, same pattern as LEDGER_APPEND_TEST_RACE_WINDOW_MS):
//   LEDGER_APPEND_TEST_EXCLUDE_WINDOW_MS  sleep this long after the temp file
//     is written and before it is renamed over the exclude target.
//   LEDGER_APPEND_TEST_EXCLUDE_THROW=1    throw at that same point.
const WINDOW = 'LEDGER_APPEND_TEST_EXCLUDE_WINDOW_MS'
const THROW = 'LEDGER_APPEND_TEST_EXCLUDE_THROW'
const OPERATOR_LINES = '# operator note\n*.secret-scratch\n'

function excludePathOf(repo) {
  return path.join(repo, '.git', 'info', 'exclude')
}

function spawnWriter(repo, i, extraEnv = {}) {
  const child = spawn('node', [APPEND_SCRIPT], { cwd: repo, env: { ...sanitizedGitEnv(), ...extraEnv } })
  const done = new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('error', reject)
    child.on('close', (code, signal) => {
      let out = null
      try {
        out = JSON.parse(stdout.trim().split('\n').pop())
      } catch (e) {
        // killed or garbled, left null for the caller to judge
      }
      resolve({ code, signal, out, stdout, stderr })
    })
  })
  child.stdin.end(JSON.stringify({ schema_version: 1, kind: 'tdd_task', outcome: 'done', task: `writer-${i}` }))
  return { child, done }
}

function assertAllWriteOk(results) {
  results.forEach((r, i) => {
    assert.ok(r.out, `writer ${i} printed no result: stdout=${r.stdout} stderr=${r.stderr}`)
    assert.equal(r.out.write_ok, true, `writer ${i} write_ok false: ${r.out.write_error}`)
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitFor(fn, ms, what) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const v = fn()
    if (v) return v
    await sleep(10)
  }
  assert.fail('timed out waiting for ' + what)
}

function strayFiles(dir) {
  return fs.readdirSync(dir).filter((n) => n !== 'exclude')
}

test('T6 AC-DATA-1: 50 concurrent writers into an exclude holding two operator lines all return write_ok true, five fresh repos in a row', async () => {
  for (let round = 0; round < 5; round++) {
    const repo = makeTempRepo()
    fs.writeFileSync(excludePathOf(repo), OPERATOR_LINES)
    const writers = Array.from({ length: 50 }, (_, i) => spawnWriter(repo, i))
    const results = await Promise.all(writers.map((w) => w.done))
    assertAllWriteOk(results)
    const lines = readLedgerLines(repo)
    assert.equal(lines.length, 50, `round ${round}: ledger line count`)
    const ids = new Set(lines.map((l) => JSON.parse(l).run_id))
    assert.equal(ids.size, 50, `round ${round}: distinct run_ids`)
    const exclude = fs.readFileSync(excludePathOf(repo), 'utf8')
    assert.ok(exclude.startsWith(OPERATOR_LINES), `round ${round}: operator lines intact and in order`)
    assert.equal(exclude.split('\n').filter((l) => l.trim() === LEDGER_REL).length, 1, `round ${round}: ledger line exactly once`)
    // Round 1 L2 (AC-DATA-1): losing writers must remove their own temp file.
    assert.deepEqual(strayFiles(path.dirname(excludePathOf(repo))), [], `round ${round}: no stray temp files in .git/info`)
  }
})

test('T6 AC-DATA-2: the hook exists, and while writers sit inside the exclude replacement window the exclude never loses its operator lines and every writer succeeds', async () => {
  const src = fs.readFileSync(APPEND_SCRIPT, 'utf8')
  // Round 1 L3 (AC-DATA-6): the hook must be READ from process.env in code, not merely named in a comment.
  assert.ok(new RegExp(`process\\.env(\\.${WINDOW}\\b|\\[\\s*['"]${WINDOW}['"]\\s*\\])`).test(src), `ledger-append.mjs must read ${WINDOW} from process.env`)

  const repo = makeTempRepo()
  fs.writeFileSync(excludePathOf(repo), OPERATOR_LINES)
  const writers = Array.from({ length: 6 }, (_, i) => spawnWriter(repo, i, { [WINDOW]: '400' }))
  let sawBad = null
  let finished = false
  const all = Promise.all(writers.map((w) => w.done)).then((r) => ((finished = true), r))
  // Observer: the exclude target must always hold the operator lines intact,
  // a truncated or empty file here is exactly what a concurrent
  // `git check-ignore` would misread as "not ignored".
  while (!finished) {
    let bytes = ''
    try {
      bytes = fs.readFileSync(excludePathOf(repo), 'utf8')
    } catch (e) {
      sawBad = sawBad || 'unreadable: ' + e.message
    }
    if (!bytes.startsWith(OPERATOR_LINES)) sawBad = sawBad || `exclude observed without operator lines: ${JSON.stringify(bytes)}`
    await sleep(1)
  }
  const results = await all
  assert.equal(sawBad, null)
  assertAllWriteOk(results)
  assert.equal(readLedgerLines(repo).length, 6)
  // Round 1 L2 (AC-DATA-2): six writers raced; the five that lost must have cleaned up.
  assert.deepEqual(strayFiles(path.dirname(excludePathOf(repo))), [], 'no stray temp files in .git/info after the race')
})

test('T6 AC-QA-18: when the ledger is already ignored, no write touches the exclude (inode, mtime, bytes), even read-only', async (t) => {
  for (const via of ['exclude', 'gitignore']) {
    await t.test(`ignored via ${via}`, () => {
      const repo = makeTempRepo()
      const exclude = excludePathOf(repo)
      if (via === 'exclude') {
        fs.writeFileSync(exclude, OPERATOR_LINES + LEDGER_REL + '\n')
      } else {
        fs.writeFileSync(exclude, OPERATOR_LINES)
        fs.writeFileSync(path.join(repo, '.gitignore'), LEDGER_REL + '\n')
        sh('git add .gitignore && git commit -q -m ignore', repo)
      }
      const before = fs.statSync(exclude)
      const beforeBytes = fs.readFileSync(exclude)
      const infoDir = path.dirname(exclude)
      try {
        fs.chmodSync(exclude, 0o444)
        fs.chmodSync(infoDir, 0o555)
        const res = runAppend(repo, { schema_version: 1, kind: 'tdd_task', outcome: 'done' })
        const out = JSON.parse(res.stdout.trim().split('\n').pop())
        assert.equal(out.write_ok, true, out.write_error)
      } finally {
        fs.chmodSync(infoDir, 0o755)
        fs.chmodSync(exclude, 0o644)
      }
      const after = fs.statSync(exclude)
      assert.equal(after.ino, before.ino, 'inode unchanged')
      assert.equal(after.mtimeMs, before.mtimeMs, 'mtime unchanged')
      assert.ok(fs.readFileSync(exclude).equals(beforeBytes), 'bytes unchanged')
      assert.deepEqual(strayFiles(infoDir), [], 'no stray files in .git/info')
      assert.equal(readLedgerLines(repo).length, 1)
    })
  }
})

test('T6 AC-DATA-4: replacement is a rename from a uniquely named temp file beside the target; SIGKILL before the rename leaves the target byte-identical', async () => {
  const repo = makeTempRepo()
  const exclude = excludePathOf(repo)
  const infoDir = path.dirname(exclude)
  fs.writeFileSync(exclude, OPERATOR_LINES)
  const original = fs.readFileSync(exclude)
  const a = spawnWriter(repo, 1, { [WINDOW]: '60000' })
  const b = spawnWriter(repo, 2, { [WINDOW]: '60000' })
  const temps = await waitFor(() => (strayFiles(infoDir).length >= 2 ? strayFiles(infoDir) : null), 15000, 'two temp files beside the exclude target')
  assert.equal(new Set(temps).size, temps.length, 'temp names are unique per writer')
  assert.ok(fs.readFileSync(exclude).equals(original), 'target untouched while the temp files exist')
  a.child.kill('SIGKILL')
  b.child.kill('SIGKILL')
  await Promise.all([a.done, b.done])
  assert.ok(fs.readFileSync(exclude).equals(original), 'target byte-identical after SIGKILL before rename')

  // A leftover temp must neither break the next writer nor be read as the exclude.
  const leftover = path.join(infoDir, strayFiles(infoDir)[0])
  fs.writeFileSync(leftover, 'JUNK-FROM-A-DEAD-WRITER\n')
  const res = runAppend(repo, { schema_version: 1, kind: 'tdd_task', outcome: 'done' })
  const out = JSON.parse(res.stdout.trim().split('\n').pop())
  assert.equal(out.write_ok, true, out.write_error)
  const after = fs.readFileSync(exclude, 'utf8')
  assert.ok(after.startsWith(OPERATOR_LINES))
  assert.ok(!after.includes('JUNK'), 'leftover temp content must not leak into the exclude')
  assert.equal(after.split('\n').filter((l) => l.trim() === LEDGER_REL).length, 1)
})

test('T6 AC-DATA-4: an error thrown before the rename removes the writer\'s own temp file and leaves the target alone', async () => {
  const src = fs.readFileSync(APPEND_SCRIPT, 'utf8')
  assert.ok(new RegExp(`process\\.env(\\.${THROW}\\b|\\[\\s*['"]${THROW}['"]\\s*\\])`).test(src), `ledger-append.mjs must read ${THROW} from process.env`)
  const repo = makeTempRepo()
  const exclude = excludePathOf(repo)
  fs.writeFileSync(exclude, OPERATOR_LINES)
  const original = fs.readFileSync(exclude)
  const { done } = spawnWriter(repo, 1, { [THROW]: '1' })
  const r = await done
  assert.ok(r.out, `no result: ${r.stdout} ${r.stderr}`)
  assert.equal(r.out.write_ok, false, 'the injected failure must surface as write_ok false')
  assert.deepEqual(strayFiles(path.dirname(exclude)), [], 'own temp file deleted')
  assert.ok(fs.readFileSync(exclude).equals(original), 'target untouched')
  assert.equal(readLedgerLines(repo).length, 0)
})

test('T6 AC-DATA-5: a symlinked exclude stays a symlink to the same target, which gains the line and keeps its mode, with the temp file made beside the target', async () => {
  const repo = makeTempRepo()
  const exclude = excludePathOf(repo)
  const elsewhere = fs.mkdtempSync(path.join(SUITE_TMPDIR, 'elsewhere-'))
  const target = path.join(elsewhere, 'shared-exclude')
  fs.writeFileSync(target, OPERATOR_LINES)
  fs.chmodSync(target, 0o640)
  fs.rmSync(exclude, { force: true })
  fs.symlinkSync(target, exclude)

  // Temp placement: while paused, the stray file sits in the target's directory.
  const paused = spawnWriter(repo, 1, { [WINDOW]: '60000' })
  const temp = await waitFor(() => strayFiles(elsewhere).filter((n) => n !== 'shared-exclude')[0], 15000, 'temp file in the target directory')
  assert.ok(temp)
  assert.deepEqual(strayFiles(path.dirname(exclude)), [], 'no temp file in .git/info when the target lives elsewhere')
  paused.child.kill('SIGKILL')
  await paused.done
  fs.rmSync(path.join(elsewhere, temp), { force: true })

  const res = runAppend(repo, { schema_version: 1, kind: 'tdd_task', outcome: 'done' })
  const out = JSON.parse(res.stdout.trim().split('\n').pop())
  assert.equal(out.write_ok, true, out.write_error)
  assert.ok(fs.lstatSync(exclude).isSymbolicLink(), 'exclude is still a symlink')
  assert.equal(fs.readlinkSync(exclude), target, 'link still points at the same target')
  const contents = fs.readFileSync(target, 'utf8')
  assert.ok(contents.startsWith(OPERATOR_LINES))
  assert.ok(contents.split('\n').includes(LEDGER_REL), 'target contains the ledger path')
  assert.equal(fs.statSync(target).mode & 0o777, 0o640, 'target mode unchanged')
})

test('T6 AC-DATA-6: ensureGitignored has no truncating open of the exclude target and uses check-first plus rename', () => {
  const src = fs.readFileSync(APPEND_SCRIPT, 'utf8')
  const start = src.indexOf('function ensureGitignored(')
  assert.ok(start >= 0, 'ensureGitignored must exist')
  const end = src.indexOf('\n}\n', start)
  // Comments stripped so explaining why the old pattern was removed cannot trip the check.
  const body = src
    .slice(start, end)
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, ''))
    .join('\n')
  assert.ok(!/writeFileSync/.test(body), 'no fs.writeFileSync in ensureGitignored')
  assert.ok(!/openSync\([^)]*['"]w\+?['"]/.test(body) && !/flag:\s*['"]w/.test(body), "no open with the 'w' flag")
  assert.ok(!/truncate/i.test(body), 'no truncate')
  // Round 1 L3 (AC-DATA-6): other in-place or copy-over writers of the exclude target.
  assert.ok(!/copyFile(Sync)?\b/.test(body), 'no copyFile onto the exclude target')
  assert.ok(!/promises\s*\.\s*writeFile|\bwriteFile\s*\(/.test(body), 'no fs.promises.writeFile or writeFile')
  assert.ok(!/openSync\([^)]*['"]r\+['"]/.test(body) && !/ftruncate/i.test(body), "no 'r+' open or ftruncate")
  assert.ok(/renameSync/.test(body), 'replacement is by rename')
  assert.ok(/realpathSync/.test(body), 'the target is resolved with realpath')
  assert.ok(/check-ignore/.test(body), 'ignore status is checked first, inside ensureGitignored')
})

test('T6 AC-SEC-13: with a tracked negation re-including the ledger, every concurrent writer refuses and the ledger gains no line', async () => {
  const repo = makeTempRepo()
  fs.writeFileSync(path.join(repo, '.gitignore'), '!' + LEDGER_REL + '\n')
  sh('git add .gitignore && git commit -q -m negate', repo)
  const writers = Array.from({ length: 12 }, (_, i) => spawnWriter(repo, i))
  const results = await Promise.all(writers.map((w) => w.done))
  results.forEach((r, i) => {
    assert.ok(r.out, `writer ${i} printed no result: ${r.stdout} ${r.stderr}`)
    assert.equal(r.out.write_ok, false, `writer ${i} must refuse`)
    assert.match(r.out.write_error, /not actually gitignored/)
  })
  assert.equal(readLedgerLines(repo).length, 0)
})

// ---------------------------------------------------------------------------
// Fix round 1 (PR #13 review round 1).

function runOne(repo, extraEnv) {
  const res = spawnSync('node', [APPEND_SCRIPT], {
    cwd: repo,
    input: JSON.stringify({ schema_version: 1, kind: 'tdd_task', outcome: 'done' }),
    encoding: 'utf8',
    env: { ...sanitizedGitEnv(), ...(extraEnv || {}) },
  })
  return { ...res, out: JSON.parse(res.stdout.trim().split('\n').pop()) }
}

// Round 1 M1 (AC-SEC-13 intent): `git check-ignore` never reports a
// TRACKED path, so a force-added ledger exits 1 before and after the exclude
// line is written. The writer must refuse rather than append to a file git tracks.
test('T6 M1 AC-SEC-13: a force-added, committed ledger makes every concurrent writer refuse and leaves the ledger bytes unchanged', async () => {
  const repo = makeTempRepo()
  const ledger = path.join(repo, LEDGER_REL)
  fs.mkdirSync(path.dirname(ledger), { recursive: true })
  fs.writeFileSync(ledger, '{"tracked":"seed"}\n')
  sh(`git add -f ${LEDGER_REL} && git commit -q -m track-ledger`, repo)
  const before = fs.readFileSync(ledger)
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => spawnWriter(repo, i).done))
  results.forEach((r, i) => {
    assert.ok(r.out, `writer ${i} printed no result: ${r.stdout} ${r.stderr}`)
    assert.equal(r.out.write_ok, false, `writer ${i} must refuse a tracked ledger`)
    assert.match(r.out.write_error, /not actually gitignored/)
  })
  assert.ok(fs.readFileSync(ledger).equals(before), 'tracked ledger bytes unchanged')
})

// Round 1 M1: any check-ignore exit other than 1 (here 128) is an error, not "unmatched".
test('T6 M1 AC-SEC-13: a corrupt .git/index (check-ignore exits non-1) fails closed with write_ok false and no ledger line', () => {
  const repo = makeTempRepo()
  fs.writeFileSync(path.join(repo, '.git', 'index'), 'NOT-AN-INDEX-garbage-garbage-garbage')
  const probe = spawnSync('git', ['check-ignore', '-q', LEDGER_REL], { cwd: repo })
  assert.ok(probe.status !== 0 && probe.status !== 1, `fixture must force a non-1 exit, got ${probe.status}`)
  // Conductor, after fix round 1: the status check (only exit 1 means
  // unmatched) was the one mutant that survived, because the post-write check
  // also fails closed; its own effect is that the writer never touches the
  // exclude file on a non-1 exit, so pin that too.
  const excludePath = path.join(repo, '.git', 'info', 'exclude')
  fs.mkdirSync(path.dirname(excludePath), { recursive: true })
  fs.writeFileSync(excludePath, '# untouched\n')
  const { out } = runOne(repo)
  assert.equal(out.write_ok, false)
  assert.match(out.write_error, /not actually gitignored/)
  assert.equal(readLedgerLines(repo).length, 0)
  assert.equal(fs.readFileSync(excludePath, 'utf8'), '# untouched\n', 'a non-1 check-ignore exit must not write the exclude file')
})

test('T6 M1 AC-SEC-13: a symlinked .claude directory (check-ignore exits 128, beyond a symbolic link) fails closed', () => {
  const repo = makeTempRepo()
  const elsewhere = fs.mkdtempSync(path.join(SUITE_TMPDIR, 'claude-elsewhere-'))
  fs.rmSync(path.join(repo, '.claude'), { recursive: true, force: true })
  fs.symlinkSync(elsewhere, path.join(repo, '.claude'))
  const probe = spawnSync('git', ['check-ignore', '-q', LEDGER_REL], { cwd: repo })
  assert.ok(probe.status !== 0 && probe.status !== 1, `fixture must force a non-1 exit, got ${probe.status}`)
  const { out } = runOne(repo)
  assert.equal(out.write_ok, false)
  assert.equal(fs.existsSync(path.join(elsewhere, 'harness-ledger.jsonl')), false, 'nothing written through the symlink')
})

// Round 1 L1 (AC-SEC-13): `-v` output splits on ':' so a colon in the excludes
// path misreads a negation as ignored. The parser must use -z fields.
test('T6 L1 AC-SEC-13: a global excludes file whose path contains a colon and which negates the ledger makes the writer refuse', () => {
  const repo = makeTempRepo()
  const dir = fs.mkdtempSync(path.join(SUITE_TMPDIR, 'colon-'))
  const excl = path.join(dir, 'a:b')
  fs.writeFileSync(excl, '!' + LEDGER_REL + '\n')
  sh(`git config core.excludesFile ${JSON.stringify(excl)}`, repo)
  const probe = spawnSync('git', ['check-ignore', '-v', LEDGER_REL], { cwd: repo, encoding: 'utf8' })
  assert.equal(probe.status, 0, 'fixture: git must report the negation')
  const { out } = runOne(repo)
  assert.equal(out.write_ok, false, 'negation via a colon path must be refused')
  assert.match(out.write_error, /not actually gitignored/)
  assert.equal(readLedgerLines(repo).length, 0)
})

// Round 1 L2 (AC-QA-19): CRLF, a trailing line with no newline, and a missing .git/info.
test('T6 L2 AC-QA-19: existing exclude bytes (CRLF, last line unterminated) are preserved exactly and the ledger line appended after one newline', () => {
  const repo = makeTempRepo()
  const original = '# c\r\nfoo\r\nlast-no-newline'
  fs.writeFileSync(excludePathOf(repo), original)
  const { out } = runOne(repo)
  assert.equal(out.write_ok, true, out.write_error)
  assert.equal(fs.readFileSync(excludePathOf(repo), 'utf8'), original + '\n' + LEDGER_REL + '\n')
  assert.deepEqual(strayFiles(path.dirname(excludePathOf(repo))), [])
})

test('T6 L2 AC-QA-19: a missing .git/info directory is created and the write succeeds', () => {
  const repo = makeTempRepo()
  fs.rmSync(path.join(repo, '.git', 'info'), { recursive: true, force: true })
  const { out } = runOne(repo)
  assert.equal(out.write_ok, true, out.write_error)
  assert.equal(fs.readFileSync(excludePathOf(repo), 'utf8'), LEDGER_REL + '\n')
})


// ---------------------------------------------------------------------------
// Fix round 2 (PR #13 review round 2, F1 to F5).

function writeOnce(repo, extraEnv) {
  return runOne(repo, extraEnv)
}

// Round 2 F1 (AC-DATA-5, AC-SEC-13): a DANGLING symlinked exclude was treated
// as absent and the rename landed over the link. Fail closed instead.
test('T6 round 2 F1 AC-DATA-5: a dangling symlinked exclude stays a symlink with the same link string; write_ok false, the condition named, the resolved path never leaked, no ledger line', () => {
  const repo = makeTempRepo()
  const exclude = excludePathOf(repo)
  const gone = path.join(SUITE_TMPDIR, 'dangling-target-dir-f1', 'does-not-exist')
  fs.rmSync(exclude, { force: true })
  fs.symlinkSync(gone, exclude)
  const { out } = writeOnce(repo)
  assert.ok(fs.lstatSync(exclude).isSymbolicLink(), 'exclude must still be a symlink, not a regular file')
  assert.equal(fs.readlinkSync(exclude), gone, 'link string unchanged')
  assert.equal(out.write_ok, false)
  assert.match(out.write_error, /exclude path is a dangling symlink/)
  assert.ok(!out.write_error.includes(gone), 'the resolved path must not appear in write_error')
  assert.equal(readLedgerLines(repo).length, 0)
  assert.deepEqual(strayFiles(path.dirname(exclude)), [], 'no stray temp file')
})

// Round 2 F2 (AC-QA-18): hermetic against the operator's global git ignore.
test('T6 round 2 F2 AC-QA-18: makeTempRepo is hermetic against a global excludes file (core.excludesFile is /dev/null)', () => {
  const repo = makeTempRepo()
  assert.equal(sh('git config --local --get core.excludesFile', repo).trim(), '/dev/null')
})

test('T6 round 2 F2 AC-QA-18: a repo-local core.excludesFile already ignoring .claude/ means write_ok true with the exclude untouched (inode, mtime, bytes)', () => {
  const repo = makeTempRepo()
  const dir = fs.mkdtempSync(path.join(SUITE_TMPDIR, 'local-excl-'))
  const excl = path.join(dir, 'ignore')
  fs.writeFileSync(excl, '.claude/\n')
  sh(`git config core.excludesFile ${JSON.stringify(excl)}`, repo)
  const exclude = excludePathOf(repo)
  fs.mkdirSync(path.dirname(exclude), { recursive: true })
  fs.writeFileSync(exclude, OPERATOR_LINES)
  const before = fs.statSync(exclude)
  const beforeBytes = fs.readFileSync(exclude)
  const { out } = writeOnce(repo)
  assert.equal(out.write_ok, true, out.write_error)
  const after = fs.statSync(exclude)
  assert.equal(after.ino, before.ino, 'inode unchanged')
  assert.equal(after.mtimeMs, before.mtimeMs, 'mtime unchanged')
  assert.ok(fs.readFileSync(exclude).equals(beforeBytes), 'bytes unchanged')
  assert.equal(readLedgerLines(repo).length, 1)
})

// Round 2 F3 (AC-DATA-5, spec bug, refuse rather than bypass): a rename forks a hard-linked exclude.
test('T6 round 2 F3 AC-DATA-5: a hard-linked exclude is refused, the inode is still shared, the bytes are unchanged, the condition is named and no ledger line is written', () => {
  const repo = makeTempRepo()
  const exclude = excludePathOf(repo)
  const other = path.join(fs.mkdtempSync(path.join(SUITE_TMPDIR, 'hardlink-')), 'other-name')
  fs.writeFileSync(exclude, OPERATOR_LINES)
  fs.linkSync(exclude, other)
  const { out } = writeOnce(repo)
  assert.equal(out.write_ok, false)
  assert.match(out.write_error, /hard link/i)
  assert.equal(fs.statSync(exclude).ino, fs.statSync(other).ino, 'still one shared inode')
  assert.equal(fs.statSync(exclude).nlink, 2)
  assert.equal(fs.readFileSync(exclude, 'utf8'), OPERATOR_LINES)
  assert.equal(fs.readFileSync(other, 'utf8'), OPERATOR_LINES)
  assert.equal(readLedgerLines(repo).length, 0)
  assert.deepEqual(strayFiles(path.dirname(exclude)), [], 'no stray temp file')
})

// Round 2 F4 (AC-DATA-5, spec bug): a read-only exclude in a writable .git/info
// was silently replaced where the old in-place write failed with EACCES.
test('T6 round 2 F4 AC-DATA-5: a read-only (0444) exclude is refused with the condition named, bytes and mode unchanged, no ledger line', () => {
  const repo = makeTempRepo()
  const exclude = excludePathOf(repo)
  fs.writeFileSync(exclude, OPERATOR_LINES)
  try {
    fs.chmodSync(exclude, 0o444)
    const { out } = writeOnce(repo)
    assert.equal(out.write_ok, false)
    assert.match(out.write_error, /not writable|read-only/i)
    assert.equal(fs.readFileSync(exclude, 'utf8'), OPERATOR_LINES)
    assert.equal(fs.statSync(exclude).mode & 0o777, 0o444, 'mode unchanged')
    assert.equal(readLedgerLines(repo).length, 0)
    assert.deepEqual(strayFiles(path.dirname(exclude)), [], 'no stray temp file')
  } finally {
    fs.chmodSync(exclude, 0o644)
  }
})

// Round 2 F5 (AC-DATA-4): an operator edit between the writer's read and its rename was lost.
test('T6 round 2 F5 AC-DATA-4: an operator line appended while the writer sits in the replacement window survives alongside the ledger line', async () => {
  const repo = makeTempRepo()
  const exclude = excludePathOf(repo)
  fs.writeFileSync(exclude, OPERATOR_LINES)
  const w = spawnWriter(repo, 1, { [WINDOW]: '1500' })
  await waitFor(() => strayFiles(path.dirname(exclude))[0], 15000, 'temp file in .git/info')
  fs.appendFileSync(exclude, '*.added-during-window\n')
  const r = await w.done
  assert.ok(r.out, `no result: ${r.stdout} ${r.stderr}`)
  assert.equal(r.out.write_ok, true, r.out.write_error)
  const lines = fs.readFileSync(exclude, 'utf8').split('\n')
  assert.ok(lines.includes('*.added-during-window'), 'the operator edit made during the window must survive')
  assert.ok(lines.includes('*.secret-scratch'), 'original operator lines survive')
  assert.ok(lines.includes(LEDGER_REL), 'ledger line present')
  assert.equal(readLedgerLines(repo).length, 1)
  assert.deepEqual(strayFiles(path.dirname(exclude)), [])
})
