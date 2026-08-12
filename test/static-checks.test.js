// Mechanical, diff-level checks for constraints that don't need a live agent
// to verify (the harness's own convention: AC-SIMP-<n> is checked directly
// against the diff, not by an agent lens).
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')

function readAll(...parts) {
  return fs.readFileSync(path.join(ROOT, ...parts), 'utf8')
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else out.push(full)
  }
  return out
}

// PR2 note: these two checks originally enforced AC-SIMP-7 ("PR 1's diff
// contains no file whose path matches optimise-cycle") by scanning the LIVE
// tree, which was correct only while PR 2 did not exist yet. Now that
// workflows/optimise-cycle.js and skills/optimise-cycle/ are real,
// permanent, in-scope deliverables, a live-tree scan of this kind can never
// pass again -- it would forever fail as written, for a reason with no
// bearing on either PR's correctness. AC-SIMP-7 is a claim about the PR 1
// DIFF specifically, which is now historical and immutable (PR 1
// squash-merged as d7eb2cc7e732cbab5c4d31441c04c6c037fa7cb9): checking it
// against that commit's own file list, rather than the live tree, keeps the
// guard meaningful and lets it stay true forever, exactly like checking any
// other already-merged commit's shape. This also incidentally fixes a
// latent path-based bug in the original form: it matched the FULL absolute
// path, so running the suite from a checkout whose own directory name
// happens to contain "optimise-cycle" (e.g. a worktree named
// t2-optimise-cycle, as PR 2's own build happened in) made it fail
// regardless of repo contents -- git's own file list is always
// repo-relative, so that failure mode cannot recur here.
test('static: PR1\'s merge commit (d7eb2cc) introduced no file whose path matches "optimise-cycle" (AC-SIMP-7, checked against the immutable historical commit rather than the live tree, which now legitimately contains PR 2\'s optimiser files)', () => {
  const out = require('node:child_process').execFileSync(
    'git',
    ['show', '--stat', '--format=', 'd7eb2cc7e732cbab5c4d31441c04c6c037fa7cb9'],
    { cwd: ROOT, encoding: 'utf8' }
  )
  const files = out
    .split('\n')
    .map((l) => l.split('|')[0].trim())
    .filter(Boolean)
  assert.ok(files.length > 10, 'sanity: expected PR1\'s merge commit to list many changed files')
  assert.ok(!files.some((f) => /optimise-cycle/.test(f)), `PR1's merge commit must not have introduced an optimise-cycle path; found: ${files.filter((f) => /optimise-cycle/.test(f))}`)
})

test('static: none of the three ORIGINAL instrumented workflows (tdd-task.js, review-cycle.js, plan-cycle.js), hooks/, or conduct-plan/SKILL.md reference the optimiser -- the dependency edge points one way (AC-ARCH-8) and no per-PR path invokes it (AC-PROD-10). The optimiser\'s OWN files (workflows/optimise-cycle.js, skills/optimise-cycle/) necessarily mention their own name and are excluded from this scan, same as this test file and workflows/lib/ledger-append.mjs are excluded for citing the spec path as a documentation source.', () => {
  const targets = [
    'workflows/tdd-task.js',
    'workflows/review-cycle.js',
    'workflows/plan-cycle.js',
    'workflows/lib/ledger-append.mjs',
    'skills/conduct-plan/SKILL.md',
    ...(fs.existsSync(path.join(ROOT, 'hooks')) ? walk(path.join(ROOT, 'hooks')).map((f) => path.relative(ROOT, f)) : []),
  ]
  for (const rel of targets) {
    const full = path.join(ROOT, rel)
    if (!fs.existsSync(full)) continue
    const contents = fs.readFileSync(full, 'utf8').replaceAll('specs/optimise-cycle.md', '')
    assert.ok(!/optimise-cycle|optimize-cycle|optimiser|optimizer/i.test(contents), `${rel} must not reference the optimiser: the dependency edge points one way (AC-ARCH-8) and nothing per-PR may invoke it (AC-PROD-10)`)
  }
})

test('static: no dependency manifest exists anywhere in the repo (AC-SIMP-1: no new runtime dependency)', () => {
  const all = walk(ROOT)
  const manifests = all.filter((f) => /package\.json$|requirements.*\.txt$|Cargo\.toml$|Gemfile$/.test(f))
  assert.deepEqual(manifests, [])
})

test('static: the three instrumented workflow scripts contain no EXECUTABLE import, Date.now(), new Date() or Math.random() (the runtime statically rejects all four before execution; mentioning them in a // comment, e.g. explaining why, is fine). workflows/lib/ledger-append.mjs is deliberately EXCLUDED: it is real, unsandboxed Node code and is expected to use all four.', () => {
  for (const f of ['workflows/tdd-task.js', 'workflows/review-cycle.js', 'workflows/plan-cycle.js']) {
    const code = readAll(f)
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, ''))
      .join('\n')
    assert.ok(!/^\s*import\b/m.test(code), `${f} contains an import declaration, which production statically rejects`)
    assert.ok(!/\bimport\s*\(/.test(code), `${f} contains a dynamic import(), which production statically rejects`)
    assert.ok(!/Date\.now\(\)/.test(code), `${f} contains executable Date.now()`)
    assert.ok(!/new Date\(/.test(code), `${f} contains executable new Date(`)
    assert.ok(!/Math\.random\(\)/.test(code), `${f} contains executable Math.random()`)
  }
})

test('static: no new file under workflows/, skills/ or docs/ hardcodes an absolute /Users/ or /Volumes/ path, or a private target repo name (AC-ARCH-9)', () => {
  const targets = [
    ...walk(path.join(ROOT, 'workflows')),
    ...walk(path.join(ROOT, 'skills')),
    fs.existsSync(path.join(ROOT, 'docs')) ? walk(path.join(ROOT, 'docs')) : [],
  ].flat()
  for (const f of targets) {
    const contents = fs.readFileSync(f, 'utf8')
    // A real leaked path has a segment after the prefix (e.g. /Users/scott/);
    // documentation is allowed to mention the bare pattern /Users/ itself
    // when describing what to reject (as this very test's name does).
    assert.ok(!/\/Users\/[a-zA-Z0-9_.-]/.test(contents), `${f} hardcodes an absolute /Users/ path`)
    assert.ok(!/\/Volumes\/[a-zA-Z0-9_.-]/.test(contents), `${f} hardcodes an absolute /Volumes/ path`)
    assert.ok(!/said.?of.?you|couchpotato/i.test(contents), `${f} names a private target repo`)
  }
})

test('static: the ledger envelope field list appears in exactly one file (AC-ARCH-5). It lives in workflows/lib/ledger-append.mjs, not a separate ledger.mjs: workflow scripts cannot import anything, so the envelope owner must be the real-Node script they invoke via Bash, not a module they pull in.', () => {
  const all = [...walk(path.join(ROOT, 'workflows')), ...walk(path.join(ROOT, 'skills'))]
  const definitionSites = all.filter((f) => {
    const contents = fs.readFileSync(f, 'utf8')
    return contents.includes('LEDGER_ENTRY_SCHEMA') && contents.includes('additionalProperties')
  })
  assert.deepEqual(definitionSites.map((f) => path.relative(ROOT, f)), ['workflows/lib/ledger-append.mjs'])
})

test('static: plan-identity canonicalisation (canonicalPlanKey) has exactly one definition site (AC-ARCH-1), mirroring the LEDGER_ENTRY_SCHEMA single-definition-site test above -- only workflows/lib/ledger-append.mjs defines it; every other caller (workflows/lib/optimise-read.mjs) imports it rather than re-declaring a second normalisation implementation of its own.', () => {
  const all = [...walk(path.join(ROOT, 'workflows')), ...walk(path.join(ROOT, 'skills'))]
  const definitionSites = all.filter((f) => /\bfunction\s+canonicalPlanKey\s*\(/.test(fs.readFileSync(f, 'utf8')))
  assert.deepEqual(definitionSites.map((f) => path.relative(ROOT, f)), ['workflows/lib/ledger-append.mjs'])
})

test('static: ledger-append.mjs is INVOKED by at least two workflows (AC-SIMP-12, arbitrated: "imported by >=2 files" becomes "invoked by >=2 workflows" for a script workflow scripts can only run via Bash, never import)', () => {
  const invokers = ['workflows/tdd-task.js', 'workflows/review-cycle.js', 'workflows/plan-cycle.js'].filter((f) =>
    readAll(f).includes('ledger-append.mjs')
  )
  assert.ok(invokers.length >= 2, `expected >=2 invokers, got ${invokers.length}`)
})

test('static: no workflow-lib file has lifecycle machinery for the ledger -- no rotation, compaction, pruning, size cap or schema-version migration code (AC-SIMP-4)', () => {
  const contents = readAll('workflows', 'lib', 'ledger-append.mjs')
  assert.ok(!/rotat|compact|prune|migrat/i.test(contents), 'ledger-append.mjs appears to contain lifecycle machinery')
})

test('static: no workflow script directly under workflows/ (not workflows/lib/) contains an import statement, static or dynamic (production statically rejects both before execution -- see specs/optimise-cycle.md "Verified runtime facts" in the main checkout)', () => {
  const directChildren = fs.readdirSync(path.join(ROOT, 'workflows'), { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.js'))
    .map((e) => path.join(ROOT, 'workflows', e.name))
  assert.ok(directChildren.length > 0, 'sanity: expected at least one workflow script')
  for (const f of directChildren) {
    const code = fs.readFileSync(f, 'utf8').split('\n').map((line) => line.replace(/\/\/.*$/, '')).join('\n')
    assert.ok(!/^\s*import\b/m.test(code), `${f} contains a static import declaration`)
    assert.ok(!/\bimport\s*\(/.test(code), `${f} contains a dynamic import() call`)
  }
})

test('static: conduct-plan/SKILL.md instructs logging CI-wait, human-wait, PR-raised and PR-merged events to the ledger, names event_key as required, and documents an occurrence discriminator in the key (AC-QA-9, M3; behavioural correctness of a prose skill is NOT exercised by this test, only its presence in the instructions)', () => {
  const skill = readAll('skills', 'conduct-plan', 'SKILL.md')
  for (const event of ['ci_wait_started', 'ci_wait_ended', 'human_wait_started', 'human_wait_ended', 'pr_raised', 'pr_merged']) {
    assert.ok(skill.includes(event), `SKILL.md must mention the ${event} event`)
  }
  assert.ok(skill.includes('ledger-append.mjs'))
  assert.ok(/event_key/.test(skill), 'SKILL.md must mention event_key')
  assert.ok(/occurrence/i.test(skill), 'M3: the documented key format must include an occurrence discriminator, since the same event can genuinely repeat for one task')
  assert.ok(/idempotent|no-op|duplicate/i.test(skill), 'SKILL.md must state that a replayed event_key does not double-count')
})

test('static: AGENT-HARNESS.md\'s ledger paragraph carries the absolute-timestamp justification and the git-history survival clause, not just README.md (L3, AC-SEC-3/AC-SEC-4)', () => {
  const doc = readAll('AGENT-HARNESS.md')
  assert.ok(/timestamp/i.test(doc), 'AGENT-HARNESS.md must justify why an absolute timestamp is retained')
  assert.ok(/git\s+history/i.test(doc), 'AGENT-HARNESS.md must state that a deliberately committed line survives in git history')
})

test('static: README.md\'s "Delete it" instruction also states that the next run recreates the ledger and there is no off switch (L12, AC-PROD-9)', () => {
  const readme = readAll('README.md')
  const deleteIdx = readme.indexOf('Delete it')
  assert.ok(deleteIdx !== -1, 'expected a "Delete it" instruction in README.md')
  const nearby = readme.slice(deleteIdx, deleteIdx + 400)
  assert.ok(/recreates it|recreated/i.test(nearby), 'must state that the next run recreates the deleted ledger, near the delete instruction')
  assert.ok(/no (way to|setting)|no off switch|cannot.*opt/i.test(nearby), 'must state there is no way to turn ledger writes off, near the delete instruction')
})

test('static: README.md\'s Retention note states that git clean -xdf deletes the ledger (it is gitignored) and how to keep it, and records the AC-DATA-4/AC-SEC-1 arbitration explicitly, not just in a test comment (round 3 LOW)', () => {
  const readme = readAll('README.md')
  assert.ok(/git clean -xdf/.test(readme), 'README.md must mention git clean -xdf by name')
  const cleanIdx = readme.indexOf('git clean -xdf')
  const nearby = readme.slice(cleanIdx, cleanIdx + 500)
  assert.ok(/delete|remove/i.test(nearby), 'must state that git clean -xdf deletes/removes the ledger')
  assert.ok(/-e |exclude|move it outside/i.test(nearby), 'must state how to keep the ledger through a git clean -xdf')
  assert.ok(/arbitration/i.test(readme), 'README.md must record the AC-DATA-4/AC-SEC-1 conflict as an explicit arbitration, not just in a test comment')
  assert.ok(/AC-DATA-4/.test(readme) && /AC-SEC-1/.test(readme), 'the arbitration must name both conflicting ACs')
})

test('static: README.md\'s Retention paragraph states the ledger is a single local copy, that nothing backs it up or replicates it, that it is lost with the main checkout, and names the condition under which that would be revisited (round-2 M5, AC-DATA-17)', () => {
  const readme = readAll('README.md')
  assert.ok(/single local copy|only copy/i.test(readme), 'README.md must state the ledger is the single/only local copy')
  assert.ok(/not backed up|no backup|nothing\s+backs it up/i.test(readme), 'README.md must state nothing backs up the ledger')
  assert.ok(/lost\s+(along with|with|if)\s+the\s+main\s+checkout/i.test(readme), 'README.md must state the ledger is lost if the main checkout is lost')
  assert.ok(/cloud-reachable|revisit/i.test(readme), 'README.md must name the condition under which the no-backup decision would be revisited')
})

test('static: README.md does NOT claim the ledger is removed by worktree deletion -- it resolves to the MAIN checkout root via git-common-dir, so removing a linked worktree never removes it (round-2 M5, AC-DATA-17 worktree-deletion clause was factually wrong)', () => {
  const readme = readAll('README.md')
  assert.ok(!/removed by worktree deletion|worktree deletion removes|deleting a worktree removes/i.test(readme), 'README.md must not claim the ledger is removed by worktree deletion -- it lives at the main checkout root and survives it')
  assert.ok(/survives (a |linked )?worktree|worktree removal (does not|never)/i.test(readme), 'README.md must state the ledger SURVIVES worktree removal, since it resolves to the main checkout root')
})

test('static: README.md names the step that refreshes the installed ~/.claude/workflows/lib mirror after a workflows/lib change, and gives an exact command that confirms the installed copy matches the repo (AC-OPS-4)', () => {
  const readme = readAll('README.md')
  assert.ok(/AC-OPS-4/.test(readme), 'README.md must record this under its AC-OPS-4 heading')
  assert.ok(/cp -r claude-ai-harness\/workflows\/lib\/\. ~\/\.claude\/workflows\/lib\//.test(readme), 'README.md must give the exact re-sync command for workflows/lib specifically')
  assert.ok(/diff -rq claude-ai-harness\/workflows\/lib ~\/\.claude\/workflows\/lib/.test(readme), 'README.md must give an exact command that confirms the installed copy matches the repo')
  assert.ok(/schemaVersionsSeen/.test(readme), 'README.md must state that a stale mirror is also detectable from the report\'s per-repo schema_version mix')
})

test('static: L5 -- the inlined run-ledger invocation block (readBudgetSpent, ledgerWritePrompt, writeLedger) is byte-identical across all three workflow files. Workflow scripts cannot import, so this trio is necessarily duplicated three times; without a guard pinning them, a fix landed in one or two copies fails silently in the third -- the same failure class as C1.', () => {
  function extractBlock(fileName) {
    const contents = readAll('workflows', fileName)
    const lines = contents.split('\n')
    const start = lines.findIndex((l) => l.startsWith('// Reads budget.spent() defensively'))
    const end = lines.findIndex((l, i) => i > start && l.startsWith('// The entire pre-existing workflow body'))
    assert.ok(start >= 0 && end > start, `${fileName}: could not locate the run-ledger helper block markers`)
    return lines.slice(start, end).join('\n')
  }
  const tdd = extractBlock('tdd-task.js')
  const review = extractBlock('review-cycle.js')
  const plan = extractBlock('plan-cycle.js')
  assert.ok(tdd.length > 500, 'sanity: the extracted block should be substantial, not an empty match')
  assert.equal(review, tdd, 'review-cycle.js\'s run-ledger helper block has drifted from tdd-task.js\'s')
  assert.equal(plan, tdd, 'plan-cycle.js\'s run-ledger helper block has drifted from tdd-task.js\'s')
})
