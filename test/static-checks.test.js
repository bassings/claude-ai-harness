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

test('static: no file under workflows/, skills/ or hooks/ mentions optimise-cycle or an optimiser reference (AC-SIMP-7, AC-ARCH-8, AC-PROD-10)', () => {
  for (const dir of ['workflows', 'skills', 'hooks']) {
    for (const f of walk(path.join(ROOT, dir))) {
      const contents = fs.readFileSync(f, 'utf8')
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

test('static: the three instrumented workflow scripts and the ledger schema module contain no EXECUTABLE Date.now(), new Date() or Math.random() (the runtime statically rejects these; mentioning them in a // comment, e.g. explaining why, is fine)', () => {
  for (const f of ['workflows/tdd-task.js', 'workflows/review-cycle.js', 'workflows/plan-cycle.js', 'workflows/lib/ledger.mjs']) {
    const code = readAll(f)
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, ''))
      .join('\n')
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

test('static: the ledger envelope field list appears in exactly one file (AC-ARCH-5)', () => {
  const all = [...walk(path.join(ROOT, 'workflows')), ...walk(path.join(ROOT, 'skills'))]
  const definitionSites = all.filter((f) => {
    const contents = fs.readFileSync(f, 'utf8')
    return contents.includes('LEDGER_ENTRY_SCHEMA') && contents.includes('additionalProperties')
  })
  assert.deepEqual(definitionSites.map((f) => path.relative(ROOT, f)), ['workflows/lib/ledger.mjs'])
})

test('static: workflows/lib/ledger.mjs is imported by at least two workflow files (AC-SIMP-12)', () => {
  const importers = ['workflows/tdd-task.js', 'workflows/review-cycle.js', 'workflows/plan-cycle.js'].filter((f) =>
    readAll(f).includes("from './lib/ledger.mjs'")
  )
  assert.ok(importers.length >= 2, `expected >=2 importers, got ${importers.length}`)
})

test('static: no workflow file has lifecycle machinery for the ledger -- no rotation, compaction, pruning, size cap or schema-version migration code (AC-SIMP-4)', () => {
  for (const f of ['workflows/lib/ledger.mjs', 'workflows/lib/ledger-append.mjs']) {
    const contents = readAll(f)
    assert.ok(!/rotat|compact|prune|migrat/i.test(contents), `${f} appears to contain lifecycle machinery`)
  }
})

test('static: conduct-plan/SKILL.md instructs logging CI-wait, human-wait, PR-raised and PR-merged events to the ledger, and instructs a dedup check before appending (AC-QA-9; behavioural correctness of a prose skill is NOT exercised by this test, only its presence in the instructions)', () => {
  const skill = readAll('skills', 'conduct-plan', 'SKILL.md')
  for (const event of ['ci_wait_started', 'ci_wait_ended', 'human_wait_started', 'human_wait_ended', 'pr_raised', 'pr_merged']) {
    assert.ok(skill.includes(event), `SKILL.md must mention the ${event} event`)
  }
  assert.ok(skill.includes('ledger-append.mjs'))
  assert.ok(/event_key/.test(skill) && /already/.test(skill), 'SKILL.md must instruct checking for an existing event_key before appending (idempotent replay)')
})
