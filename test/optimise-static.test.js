// Mechanical, diff-level checks specific to PR2's optimiser deliverables --
// same convention as test/static-checks.test.js (harness rule: constraints
// that can be checked directly against the diff are, rather than trusted to
// an agent lens).
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { execFileSync } = require('node:child_process')

const ROOT = path.join(__dirname, '..')
function readAll(...parts) {
  return fs.readFileSync(path.join(ROOT, ...parts), 'utf8')
}

// ---- AC-ARCH-8: dependency edge points one way ----

test('static: workflows/optimise-cycle.js and workflows/lib/optimise-read.mjs reference none of plan-cycle, review-cycle or tdd-task by filename or internals (AC-ARCH-8)', () => {
  for (const f of ['workflows/optimise-cycle.js', 'workflows/lib/optimise-read.mjs']) {
    const contents = readAll(f)
    assert.ok(!/plan-cycle|review-cycle|tdd-task/.test(contents), `${f} must not reference plan-cycle, review-cycle or tdd-task`)
  }
})

test('static: the optimiser reads only run/job METADATA via gh, never a job log -- every mention of --log or a /logs endpoint in workflows/optimise-cycle.js sits within a clear prohibition ("never"/"do not"), never as an instruction to actually fetch one (AC-SEC-7)', () => {
  const contents = readAll('workflows', 'optimise-cycle.js')
  for (const re of [/--log\b/g, /\/logs\b/g]) {
    let m
    let matched = false
    while ((m = re.exec(contents))) {
      matched = true
      const windowStart = Math.max(0, m.index - 60)
      const windowText = contents.slice(windowStart, m.index + m[0].length + 10)
      assert.ok(/never|do not|don't/i.test(windowText), `mention of "${m[0]}" at offset ${m.index} is not clearly a prohibition: ...${windowText}...`)
    }
    assert.ok(matched, `sanity: expected at least one mention of ${re} (the explicit prohibition itself)`)
  }
})

// ---- AC-SEC-9: mechanical no-mutation grep ----

test('static: workflows/lib/optimise-read.mjs contains no filesystem WRITE call anywhere (fs.writeFileSync, fs.appendFileSync, fs.rmSync, fs.unlinkSync, fs.mkdirSync, fs.rename*) -- it is read-only by construction, not by discipline alone (AC-SEC-9)', () => {
  const contents = readAll('workflows', 'lib', 'optimise-read.mjs')
  const writeCalls = ['writeFileSync', 'appendFileSync', 'rmSync', 'unlinkSync', 'mkdirSync', 'renameSync', 'rmdirSync', 'writeSync', 'ftruncateSync']
  for (const call of writeCalls) {
    assert.ok(!contents.includes(call), `optimise-read.mjs must not call fs.${call} -- it is a read-only aggregator`)
  }
})

test('static: workflows/optimise-cycle.js instructs no mutating git or gh command outside an explicit prohibition -- every mention of a mutating verb sits within ~120 characters of a negation word ("do not"/"never"/"NOT") (AC-SEC-9)', () => {
  const contents = readAll('workflows', 'optimise-cycle.js')
  const mutatingPatterns = [/git\s+commit/g, /git\s+push/g, /gh\s+pr\s+(create|merge|edit)/g, /-X\s+(POST|PATCH|PUT|DELETE)/g]
  for (const re of mutatingPatterns) {
    let m
    while ((m = re.exec(contents))) {
      const windowStart = Math.max(0, m.index - 120)
      const windowText = contents.slice(windowStart, m.index + m[0].length + 20)
      assert.ok(/do not|don't|never|NOT\b/i.test(windowText), `mention of "${m[0]}" at offset ${m.index} is not clearly wrapped in a prohibition: ...${windowText}...`)
    }
  }
})

test('static: optimise-read.mjs never invokes git or gh itself (it processes already-fetched data; agents do the I/O) -- no execFileSync/spawnSync/execSync call anywhere in the file (AC-SEC-9, AC-ARCH-8)', () => {
  const contents = readAll('workflows', 'lib', 'optimise-read.mjs')
  assert.ok(!/execFileSync|spawnSync|execSync|child_process/.test(contents), 'optimise-read.mjs must not shell out at all -- it reads files and stdin only')
})

// ---- AC-QA-16: a new emitting kind requires no optimiser code change (mechanical proof by construction) ----

test('static: optimise-read.mjs declares no closed enum of every acceptable ledger `kind` value (unlike ledger-append.mjs\'s KINDS, which VALIDATES a write) -- only parseLedgerContent\'s envelope-required-field check can skip a line at read time, so a future unknown kind is retained, not rejected (AC-QA-16). RUN_KINDS (a short, unrelated list naming which THREE kinds represent a workflow run, used only to group agent-compute durations) is not the same thing and is allowed.', () => {
  const contents = readAll('workflows', 'lib', 'optimise-read.mjs')
  assert.ok(!/(?<![A-Za-z_])KINDS\s*=\s*\[/.test(contents), 'optimise-read.mjs must not declare a bare KINDS enum the way ledger-append.mjs does -- that would make a future kind require a code change here')
})

// ---- AC-QA-25: both install paths, plugin manifest exposure ----

test('static: skills/optimise-cycle/SKILL.md exists with valid frontmatter naming the skill (AC-QA-25)', () => {
  const skill = readAll('skills', 'optimise-cycle', 'SKILL.md')
  assert.ok(/^---\n/.test(skill), 'expected YAML frontmatter at the top of SKILL.md')
  assert.ok(/name:\s*optimise-cycle/.test(skill))
  assert.ok(/description:/.test(skill))
})

test('static: README.md documents installing optimise-cycle via both the plugin path and the manual copy path, and the manual copy block already covers workflows/, skills/, hooks/ (AC-QA-25)', () => {
  const readme = readAll('README.md')
  assert.ok(/optimise-cycle/.test(readme), 'README.md must mention optimise-cycle')
  assert.ok(/cp -r claude-ai-harness\/workflows\/\. ~\/\.claude\/workflows\//.test(readme))
  assert.ok(/cp -r claude-ai-harness\/skills\/\. ~\/\.claude\/skills\//.test(readme))
})

test('static: the plugin manifest (.claude-plugin/plugin.json) was updated (version bumped past PR1\'s 0.3.2) alongside the optimiser landing, so the manifest tracks that the plugin now exposes it (AC-QA-25)', () => {
  const manifest = JSON.parse(readAll('.claude-plugin', 'plugin.json'))
  assert.notEqual(manifest.version, '0.3.2', 'plugin.json version must be bumped for this feature')
})

test('static: both documented install paths, executed verbatim into a scratch config directory, resolve the optimiser skill and workflow files at the expected relative paths', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'optimise-install-check-'))
  try {
    // Manual copy path (README.md's own commands, with the repo root substituted for the cloned checkout).
    fs.mkdirSync(path.join(scratch, 'claude', 'workflows'), { recursive: true })
    fs.mkdirSync(path.join(scratch, 'claude', 'skills'), { recursive: true })
    execFileSync('/bin/sh', ['-c', `cp -r "${ROOT}/workflows/." "${scratch}/claude/workflows/"`])
    execFileSync('/bin/sh', ['-c', `cp -r "${ROOT}/skills/." "${scratch}/claude/skills/"`])
    assert.ok(fs.existsSync(path.join(scratch, 'claude', 'workflows', 'optimise-cycle.js')))
    assert.ok(fs.existsSync(path.join(scratch, 'claude', 'workflows', 'lib', 'optimise-read.mjs')))
    assert.ok(fs.existsSync(path.join(scratch, 'claude', 'skills', 'optimise-cycle', 'SKILL.md')))

    // Plugin path: the plugin's own directory structure already IS the
    // source layout claude-ai-harness ships (skills/, workflows/ discovered
    // by directory convention, same as skills/conduct-plan/ already is,
    // with no explicit per-skill registration in plugin.json) -- verify the
    // files exist at the plugin-relative paths a plugin install would read.
    assert.ok(fs.existsSync(path.join(ROOT, 'workflows', 'optimise-cycle.js')))
    assert.ok(fs.existsSync(path.join(ROOT, 'skills', 'optimise-cycle', 'SKILL.md')))
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true })
  }
})

// ---- AC-PROD-10: concrete cadence, no per-PR invocation ----

test('static: skills/optimise-cycle/SKILL.md states a concrete default cadence (weekly), not a placeholder like "N" (AC-PROD-10)', () => {
  const skill = readAll('skills', 'optimise-cycle', 'SKILL.md')
  assert.ok(/weekly/i.test(skill))
  assert.ok(!/\bN conducted plans\b/.test(skill), 'must not leave a literal unfilled "N" placeholder')
})

test('static: no per-PR path invokes the optimiser -- grep across workflows/, skills/ and hooks/ (excluding the optimiser\'s own files) shows no call from review-cycle, tdd-task, plan-cycle or conduct-plan\'s per-task loop (AC-PROD-10). conduct-plan/SKILL.md\'s pre-existing citation of "specs/optimise-cycle.md" as an EXAMPLE repo-relative plan-file path (illustrating event_key format, unrelated to invoking the optimiser) is not a reference to invoking it and is allowed, same exception test/static-checks.test.js already applies.', () => {
  for (const f of ['workflows/tdd-task.js', 'workflows/review-cycle.js', 'workflows/plan-cycle.js', 'skills/conduct-plan/SKILL.md']) {
    const contents = readAll(f).replaceAll('specs/optimise-cycle.md', '')
    assert.ok(!/optimise-cycle|optimize-cycle|optimiser|optimizer/i.test(contents), `${f} must not invoke the optimiser`)
  }
})

// ---- AC-DATA-10: the skill names who records adoption/rejection/reversion, and when ----

test('static: skills/optimise-cycle/SKILL.md names WHO writes a proposal adoption/rejection/reversion record and WHEN, and the exact mechanism (conduct_plan_event, no new ledger kind) (AC-DATA-10)', () => {
  const skill = readAll('skills', 'optimise-cycle', 'SKILL.md')
  assert.ok(/proposal_adopted/.test(skill) && /proposal_rejected/.test(skill) && /proposal_reverted/.test(skill))
  assert.ok(/conduct_plan_event/.test(skill), 'must reuse the existing ledger kind, not invent a new one')
  assert.ok(/human|operator|conductor/i.test(skill), 'must name who writes the record')
  assert.ok(/proposal_id/.test(skill))
})

// ---- AC-PROD-7: escaped-defect metric named and its limitation stated ----

test('static: skills/optimise-cycle/SKILL.md states the escaped-defect metric is a heuristic, not a verified causal attribution, and names who/what computes it', () => {
  const skill = readAll('skills', 'optimise-cycle', 'SKILL.md')
  assert.ok(/heuristic/i.test(skill))
  assert.ok(/escaped-defects/.test(skill))
})

// ---- Review round-2 L4 (AC-QA-20): the perf bound is measured but was
// enforced by no test at all. The cheaper structural guard the AC itself
// names -- rather than a timing assertion, which is real but slower and
// carries a small flake risk under load -- is that the per-record parsing/
// aggregation loops never make a filesystem call: an O(1)-per-record
// contract, checked by construction rather than by a stopwatch. Extracts
// each function's own source (start line to the next column-0 closing
// brace) so a legitimate fs call elsewhere in the file (reading the ledger
// file itself, once, at the CLI layer) is not mistaken for one inside a
// loop that runs once per record. ----

function extractFunctionBody(contents, fnNameSignature) {
  const lines = contents.split('\n')
  const start = lines.findIndex((l) => l.startsWith(fnNameSignature))
  assert.ok(start >= 0, `could not locate the start of ${fnNameSignature}`)
  let end = -1
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i] === '}') { end = i; break }
  }
  assert.ok(end > start, `could not locate the closing brace of ${fnNameSignature}`)
  return lines.slice(start, end + 1).join('\n')
}

test('static: optimise-read.mjs\'s per-record loops (parseLedgerContent, aggregateRework, aggregateWallClock) contain no filesystem call -- an O(1)-per-record contract enforced by construction, not by a timing test (L4, AC-QA-20)', () => {
  const contents = readAll('workflows', 'lib', 'optimise-read.mjs')
  for (const signature of ['export function parseLedgerContent(', 'export function aggregateRework(', 'export function aggregateWallClock(']) {
    const body = extractFunctionBody(contents, signature)
    assert.ok(!/\bfs\./.test(body), `${signature} must contain no fs.* call -- got a match in:\n${body}`)
  }
})
