// Behavioural coverage for skills/conduct-plan/SKILL.md's protection of
// .claude/conductor-prior-findings.json (specs/record-fixed-findings.md,
// fix round 4).
//
// Kept OUT of test/static-checks.test.js on purpose: that file's own header
// comment states it deliberately never builds temp repos and never imports
// helpers/temp-repo.js, shelling to git directly against THIS repo instead.
// The checks below need a throwaway repo that is NOT claude-ai-harness --
// that is the entire point of fix round 4, finding 1 (a protection proven
// only in this repo's own .gitignore does not travel to a delivery repo) --
// so they belong in their own file, the same reason
// test/optimise-report-ignore.test.js is separate from static-checks.test.js.
//
// Fix round 3 protected this path by adding one line to THIS repo's own
// .gitignore and pinned it with a test asserting a real `git check-ignore`
// against THIS repo (still present in static-checks.test.js). That line
// never installs into a delivery repo (the harness installs
// AGENT-HARNESS.md, agents/, workflows/, hooks/ and skills/ -- never
// .gitignore), so a conductor running anywhere else found the path
// genuinely untracked but NOT ignored. Fix round 4 replaces that with the
// same mechanism the run ledger and the optimiser's own report already use:
// workflows/lib/optimise-report-ignore.mjs's ensureIgnored(root,
// relativePath), which writes to the CURRENT repo's own
// .git/info/exclude and verifies with a real `git check-ignore`, refusing
// to report success if a tracked .gitignore re-includes the path.
//
// Fix round 3's own test for this (previously at
// test/static-checks.test.js:339-361) pinned the WORDING of the
// instruction rather than its behaviour, and two mutations reinstating the
// exact defect it was meant to catch left the suite green: (1) adding a
// sentence telling the conductor to also append prior_findings content to
// `## Conductor log` (the tracked plan file), which the old test's negative
// assertion -- anchored on one exact old sentence -- did not match once
// reworded; (2) repointing the mechanical steps at a tracked path
// (specs/prior-findings.json) while leaving the old, still-correct
// filename in the explanatory paragraph above, which satisfied the old
// test's bare `.includes()` check on its own. The tests below replace that
// wording pin with (a) a structural check that SKILL.md's extracted
// `WRITE TARGET` set is EXACTLY `.claude/conductor-prior-findings.json` and
// nothing else -- which fails on mutation (2) regardless of wording, since
// the extraction reads the actual instructed path rather than matching a
// fixed phrase, so repointing it to `specs/prior-findings.json` changes the
// extracted set; (b) proving that named target is genuinely git-ignorable,
// in a throwaway repo (not claude-ai-harness) with no pre-existing
// .gitignore entry, via the real ensure-ignored mechanism, which is the
// AC-1 proof that the protection actually works somewhere other than here;
// and (c) a structural count on how many times the mechanical-steps block
// names the `## Conductor log` heading -- legitimately exactly once (the
// prohibition sentence) -- which fails on mutation (1) regardless of how
// the added sentence is worded, because it still has to name that heading
// to be a coherent instruction at all.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { makeTempRepo, cleanupTempRepos } = require('./helpers/temp-repo.js')

const ROOT = path.join(__dirname, '..')
const IGNORE_SCRIPT = path.join(ROOT, 'workflows', 'lib', 'optimise-report-ignore.mjs')

function readSkill() {
  return fs.readFileSync(path.join(ROOT, 'skills', 'conduct-plan', 'SKILL.md'), 'utf8')
}

function mechanicalStepsBlock(skill) {
  const start = skill.indexOf('Mechanical steps for `prior_findings`')
  const end = skill.indexOf('What this proves and what it does not')
  assert.ok(start !== -1 && end > start, 'could not locate the mechanical-steps block')
  return skill.slice(start, end)
}

// Every legitimate write instruction for this feature is tagged
// `WRITE TARGET: `<path>`` at its actual write site (mirrors how the block
// already names event_key, disposition: 'fixed', etc. as exact anchors
// elsewhere in this file). Line-wrapped prose can put a line break between
// WRITE and TARGET:, so \s+ rather than a literal space.
function writeTargets(text) {
  return [...text.matchAll(/WRITE\s+TARGET:\s*`([^`]+)`/g)].map((m) => m[1])
}

test.after(cleanupTempRepos)

test('conduct-plan prior_findings protection: SKILL.md names at least one WRITE TARGET for .claude/conductor-prior-findings.json, and none for anything else', () => {
  const skill = readSkill()
  const targets = new Set(writeTargets(skill))
  assert.ok(targets.size > 0, 'expected at least one WRITE TARGET tag in SKILL.md')
  assert.deepEqual([...targets], ['.claude/conductor-prior-findings.json'], `every WRITE TARGET in SKILL.md must be the untracked prior_findings store, got: ${[...targets].join(', ')}`)
})

test('conduct-plan prior_findings protection: every WRITE TARGET named in SKILL.md is genuinely git-ignorable via the documented mechanism, in a throwaway repo that starts with no .gitignore entry for it at all (fix round 4, finding 1 -- this is NOT claude-ai-harness, so a protection that only worked here would not be caught)', () => {
  const skill = readSkill()
  const targets = [...new Set(writeTargets(skill))]
  assert.ok(targets.length > 0, 'expected at least one WRITE TARGET to verify')
  const repo = makeTempRepo()
  // Sanity: the repo really starts with no ignore rule for these paths.
  for (const target of targets) {
    const before = spawnSync('git', ['check-ignore', '-q', target], { cwd: repo })
    assert.notEqual(before.status, 0, `sanity check failed: ${target} was already ignored before ensure-ignored ran`)
  }
  for (const target of targets) {
    const res = spawnSync('node', [IGNORE_SCRIPT, repo, target], { encoding: 'utf8' })
    assert.equal(res.status, 0, res.stderr)
    const out = JSON.parse(res.stdout.trim())
    assert.equal(out.ignored, true, `optimise-report-ignore.mjs must report ignored:true for ${target}, got error: ${out.error}`)
    const after = spawnSync('git', ['check-ignore', '-q', target], { cwd: repo })
    assert.equal(after.status, 0, `git check-ignore must exit 0 for ${target} after ensure-ignored ran`)
  }
})

test('conduct-plan prior_findings protection: the mechanical-steps block names the `## Conductor log` heading at most once -- its own prohibition -- so a second instruction referencing it (an instruction to also write prior_findings content there, however worded) is caught structurally', () => {
  const skill = readSkill()
  const block = mechanicalStepsBlock(skill)
  const mentions = (block.match(/## Conductor log/g) || []).length
  assert.equal(mentions, 1, `the mechanical-steps block must name "## Conductor log" exactly once (the prohibition sentence); found ${mentions} -- a second mention is the fix round 2 defect reappearing under different wording`)
})

test('conduct-plan prior_findings protection: SKILL.md documents that the harness install does not carry .gitignore into a delivery repo, and names the real ensure-ignored mechanism rather than reasserting the withdrawn claim', () => {
  const skill = readSkill()
  assert.ok(/does not|never install|not.*install/i.test(skill) && /\.gitignore/.test(skill), 'SKILL.md must say plainly that the harness install does not carry .gitignore into a delivery repo')
  assert.ok(skill.includes('optimise-report-ignore.mjs'), 'SKILL.md must name the real ensure-ignored script, not merely assert the file is gitignored')
  assert.ok(/check-ignore/.test(skill), 'SKILL.md must mention verifying with a real git check-ignore')
  assert.ok(/do not write|refus/i.test(skill), 'SKILL.md must instruct refusing to write when the path is not actually confirmed ignored')
})

test('conduct-plan prior_findings protection: the Done step (step 6) prunes THIS plan\'s own entries from .claude/conductor-prior-findings.json, scoped by the <plan file>: key prefix, and leaves a different plan\'s entries untouched (fix round 4, finding 3 -- nothing previously deleted this data, so it survived every task of every plan the repo ever conducted)', () => {
  const skill = readSkill()
  const doneIdx = skill.indexOf('6. **Done?**')
  const disciplineIdx = skill.indexOf('## Discipline')
  assert.ok(doneIdx !== -1 && disciplineIdx > doneIdx, 'could not locate the Done step (step 6)')
  const doneBlock = skill.slice(doneIdx, disciplineIdx)
  assert.ok(doneBlock.includes('.claude/conductor-prior-findings.json'), 'step 6 must name the untracked prior_findings store')
  assert.ok(/<plan file>:/.test(doneBlock), 'step 6 must scope the prune to keys prefixed by <plan file>:, not the whole store')
  assert.ok(/untouched|left as is|not.*delete/i.test(doneBlock), 'step 6 must state that another plan\'s entries are left alone, not wiped along with this one')
  assert.equal(writeTargets(doneBlock).filter((t) => t === '.claude/conductor-prior-findings.json').length, 1, 'step 6 must carry its own WRITE TARGET tag for the pruned write-back')
})
