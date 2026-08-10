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

test('static: no file under workflows/, skills/ or hooks/ mentions optimise-cycle or an optimiser reference (AC-SIMP-7, AC-ARCH-8, AC-PROD-10). Citing the spec FILE PATH "specs/optimise-cycle.md" as a documentation source (as this test itself does, and as workflows/lib/ledger-append.mjs does when citing where the verified runtime facts are recorded) is not a reference to an optimiser implementation and is allowed.', () => {
  for (const dir of ['workflows', 'skills', 'hooks']) {
    for (const f of walk(path.join(ROOT, dir))) {
      const contents = fs.readFileSync(f, 'utf8').replaceAll('specs/optimise-cycle.md', '')
      assert.ok(!/optimise-cycle|optimize-cycle|optimiser|optimizer/i.test(contents), `${f} must not reference the optimiser (PR2, out of scope for PR1)`)
    }
  }
})

test('static: PR1 introduces no file whose path matches "optimise-cycle" (AC-SIMP-7)', () => {
  const all = [...walk(path.join(ROOT, 'workflows')), ...walk(path.join(ROOT, 'skills')), ...walk(path.join(ROOT, 'test')), ...walk(path.join(ROOT, 'docs'))]
  assert.ok(!all.some((f) => /optimise-cycle/.test(f)))
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
