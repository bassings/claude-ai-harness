// HARN-OPT-5 T5: the ledger:write step feeds the writer from a private file
// instead of an inline base64 shell string. Static pins on the prompt text in
// all three workflow copies (AC-SEC-3, AC-SEC-4, AC-SEC-5, AC-SEC-6,
// AC-SIMP-4, AC-DATA-7, AC-ARCH-9) plus the end-to-end clean-up proof
// (AC-SEC-4). The injection and round-trip proofs live in
// test/shell-injection.test.js.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { runWorkflow } = require('./helpers/fake-runtime.js')
const { extractLedgerPayload, START_DELIMITER, END_DELIMITER } = require('./helpers/extract-ledger-payload.js')
const { instructedCommands, actAsCompliantAgent, EXPECTED_STEP_2, EXPECTED_STEP_3, EXPECTED_STEP_5 } = require('./helpers/ledger-agent.js')
const { makeTempRepo, sh, cleanupTempRepos, readLedgerLines, SUITE_TMPDIR } = require('./helpers/temp-repo.js')
const { extractEncodedPayload } = require('./helpers/extract-ledger-payload.js')

// Review round 1 F1 and F4 (AC-SEC-4, AC-DATA-7): the exit-path and collision checks used to run over the WHOLE prompt,
// where step 1 and the closing paragraph also say "write_ok false" and step 5 says "after a collision", so reversing
// step 5 or deleting step 2's collision clause stayed green. Each check now reads its own numbered step only.
function step(prompt, n) {
  const start = prompt.indexOf(`\n${n}. `)
  assert.ok(start >= 0, `step ${n} not found`)
  const rest = prompt.slice(start + 1)
  const next = rest.search(/\n(\d\. |If the script)/)
  return next >= 0 ? rest.slice(0, next) : rest
}

test.after(cleanupTempRepos)

const WF_DIR = path.join(__dirname, '..', 'workflows')
const FILES = { 'tdd-task.js': { task: 'x' }, 'review-cycle.js': {}, 'plan-cycle.js': { spec: 'specs/x.md' } }
const MKTEMP = 'mktemp "${TMPDIR:-/tmp}/harn-ledger-XXXXXX"'

async function firstPrompt(file) {
  let calls
  try {
    ;({ calls } = await runWorkflow(path.join(WF_DIR, file), { args: FILES[file], agent: {} }))
  } catch (e) {
    calls = e.calls // review-cycle throws ScopeStepFailed after its first ledger write
  }
  return calls.find((c) => c.opts.label === 'ledger:write').prompt
}

function l5Block(file) {
  const lines = fs.readFileSync(path.join(WF_DIR, file), 'utf8').split('\n')
  const start = lines.findIndex((l) => l.startsWith('// Reads budget.spent() defensively'))
  const end = lines.findIndex((l, i) => i > start && l.startsWith('// The entire pre-existing workflow body'))
  assert.ok(start >= 0 && end > start, `${file}: L5 markers not found`)
  return { block: lines.slice(start, end).join('\n'), outside: [...lines.slice(0, start), ...lines.slice(end)].join('\n') }
}

for (const file of Object.keys(FILES)) {
  test(`${file}: step 2 creates the payload file by exclusive create outside every git working tree, never a fixed or run_id-derived name (AC-SEC-3)`, async () => {
    const prompt = await firstPrompt(file)
    const cmds = instructedCommands(prompt)
    assert.deepEqual(cmds.mktemp, [MKTEMP], 'exactly the mktemp form the criteria name')
    assert.match(prompt, /outside (every|any|all) git working tree/i, 'names a directory outside every working tree')
    assert.match(prompt, /never[^.]*(show-toplevel|inside the (checkout|repo)|working tree|worktree)/i, 'forbids a path inside the checkout')
    assert.match(prompt, /never[^.]*(fixed (name|path)|run_id)/i, 'forbids a fixed name and a run_id-derived name')
    for (const m of prompt.matchAll(/harn-ledger/g)) {
      assert.ok(prompt.slice(m.index).startsWith('harn-ledger-XXXXXX'), 'every harn-ledger path is the mktemp template, never a fixed file')
    }
    assert.equal(/\/tmp\/[A-Za-z]/.test(prompt.replace(MKTEMP, '')), false, 'no literal path under /tmp outside the mktemp template')
  })

  test(`${file}: the encoded payload sits between a delimiter pair, writes use the file tool never a shell, and exactly one Bash command runs the writer (AC-SEC-1, AC-QA-15)`, async () => {
    const prompt = await firstPrompt(file)
    const lines = prompt.split('\n')
    assert.equal(lines.filter((l) => l === START_DELIMITER).length, 1)
    assert.equal(lines.filter((l) => l === END_DELIMITER).length, 1)
    // Review round 3 F1 (recurrence): the prose of step 3 (everything before the delimiter) pinned verbatim.
    const step3 = step(prompt, 3)
    assert.equal(step3.slice(0, step3.indexOf(START_DELIMITER)).replace(/\n$/, ''), EXPECTED_STEP_3, 'step 3 prose is exactly the agreed text')
    for (const clause of ['file-writing tool (the Write tool)', 'Never write it via a shell command', 'reading the empty file first']) {
      assert.ok(EXPECTED_STEP_3.includes(clause), `the agreed step 3 says: ${clause}`)
    }
    const cmds = instructedCommands(prompt)
    assert.deepEqual(cmds.node, ['node <path-to-ledger-append.mjs> < "<the file>"'])
    const at = (s) => prompt.indexOf(s)
    assert.ok(at(MKTEMP) < at(START_DELIMITER) && at(START_DELIMITER) < at(END_DELIMITER) && at(END_DELIMITER) < at(cmds.node[0]) && at(cmds.node[0]) < at(cmds.rm[0]), 'order: mktemp, payload, writer, rm')
  })

  test(`${file}: step 5 deletes exactly the one payload file on every exit path, with no glob, -r or directory (AC-SEC-4)`, async () => {
    const prompt = await firstPrompt(file)
    const cmds = instructedCommands(prompt)
    assert.deepEqual(cmds.rm, ['rm "<the file>"'])
    assert.equal(/\brm\s+-/.test(prompt), false, 'no rm flags anywhere in the prompt')
    assert.equal(/[*?]/.test(cmds.rm[0]), false, 'no glob in the delete command')
    // Review round 3 F1: pinned verbatim (a denylist of carve-out phrasings can always be rephrased around).
    assert.equal(step(prompt, 5), EXPECTED_STEP_5, 'step 5 is exactly the agreed text')
    for (const exitPath of ['successful write', 'write_ok false', 'not found', 'fails to start', 'collision']) {
      assert.ok(EXPECTED_STEP_5.includes(exitPath), `the agreed step 5 names exit path ${exitPath}`)
    }
    assert.ok(EXPECTED_STEP_5.includes('on every exit path'), 'the agreed step 5 is unconditional')
  })

  test(`${file}: a failed or empty mktemp, or a path that already holds content, reports write_ok false naming that and pipes nothing (AC-SEC-3, AC-DATA-7)`, async () => {
    const prompt = await firstPrompt(file)
    // Review round 3 F1 (recurrence): pinned verbatim, like step 5.
    assert.equal(step(prompt, 2), EXPECTED_STEP_2, 'step 2 is exactly the agreed text')
    for (const clause of ['If mktemp fails or prints nothing', 'already holds content', 'do not run the writer at all', 'do not pipe anything to it']) {
      assert.ok(EXPECTED_STEP_2.includes(clause), `the agreed step 2 says: ${clause}`)
    }
  })

  test(`${file}: step 1 keeps the H1 writer search order and its repo-local gate (AC-SEC-5)`, async () => {
    const prompt = await firstPrompt(file)
    const step1 = prompt.slice(prompt.indexOf('1. Find'), prompt.indexOf('2. '))
    const a = step1.indexOf('~/.claude/workflows/lib/ledger-append.mjs')
    const b = step1.indexOf('plugin directory')
    const c = step1.indexOf('git rev-parse --show-toplevel')
    assert.ok(a >= 0 && a < b && b < c, 'installed mirror, then plugin, then gated repo-local')
    assert.match(step1, /NEVER use a repo-local copy in any OTHER repo/)
  })

  test(`${file}: the prompt keeps its own brace-bearing return-contract text and the extractor still reads only the delimited payload (AC-QA-15)`, async () => {
    const prompt = await firstPrompt(file)
    assert.ok(prompt.includes('{run_id, ts, write_ok, write_error}'), 'sanity: the prose brace text the old heuristic tripped on is still present')
    assert.doesNotThrow(() => extractLedgerPayload(prompt))
  })

  test(`${file}: no shell transport left, encoder kept, and no ledger invocation outside the L5 block (AC-SEC-6, AC-SIMP-4, AC-ARCH-9)`, () => {
    const src = fs.readFileSync(path.join(WF_DIR, file), 'utf8')
    assert.equal(src.includes('base64 -d'), false)
    assert.equal(src.includes("printf '%s'"), false)
    assert.ok(src.includes('function toBase64(') && src.includes('const B64_ALPHABET'), 'toBase64 and B64_ALPHABET stay')
    const { block, outside } = l5Block(file)
    assert.ok(block.includes('mktemp'), 'the invocation lives inside the L5 block')
    // Conductor fix (T5 test defect 2): review-cycle.js legitimately uses mktemp outside the block for T4's per-lens
    // scratch roots (#14), so the check is on the ledger-append invocation itself, not on the word mktemp.
    assert.equal(/<path-to-ledger-append\.mjs>|node [^\n]*< "/.test(outside), false, 'no ledger-append shell command outside the L5 block')
  })
}

test('the three L5 blocks are byte-identical (AC-SEC-5, AC-ARCH-9)', () => {
  const [t, r, p] = Object.keys(FILES).map((f) => l5Block(f).block)
  assert.ok(t.includes('mktemp'), 'sanity: the block carries the new transport')
  assert.equal(r, t)
  assert.equal(p, t)
})

test('no file under workflows/ carries the shell transport strings (AC-SEC-6, AC-SIMP-4)', () => {
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]))
  for (const f of walk(WF_DIR)) {
    const text = fs.readFileSync(f, 'utf8')
    assert.equal(text.includes('base64 -d'), false, f)
    assert.equal(text.includes("printf '%s'"), false, f)
  }
})

for (const file of Object.keys(FILES)) {
  test(`${file}: with HARNESS_LEDGER_READONLY=1 forcing write_ok false, no payload file is left and the checkout is unchanged (AC-SEC-4 end to end)`, async () => {
    const prompt = await firstPrompt(file)
    const repo = makeTempRepo()
    const scratch = fs.mkdtempSync(path.join(SUITE_TMPDIR, 'scratch-'))
    const status = () => sh('git status --porcelain --ignored', repo)
    const before = status()
    const run = actAsCompliantAgent(prompt, { cwd: repo, scratchDir: scratch, writerEnvPrefix: 'HARNESS_LEDGER_READONLY=1 ' })
    assert.equal(run.result.write_ok, false)
    assert.deepEqual(fs.readdirSync(scratch), [], 'the scratch directory is empty: the payload file was deleted')
    assert.equal(fs.existsSync(run.file), false)
    assert.equal(status(), before, 'git status --porcelain --ignored identical before and after')
    assert.deepEqual(readLedgerLines(repo), [])
  })
}

// AC-QA-15: a payload full of the characters the old "first {" heuristic
// tripped on round-trips exactly, for every ledger:write call a run makes.
const BRACEY = 'a } b { c \\"d\\" "e" {run_id, ts, write_ok, write_error} {"x":"}"}'
// Review round 1 F5 (AC-QA-15): review-cycle.js is driven too (BRACEY as a finding claim and a spec-bug claim), and the
// old self-comparison (a parsed value always equals its own JSON round-trip) is replaced by a check that the text
// between the delimiters is the canonical base64 of the decoded payload, so the workflow's own encoder, the delimiter
// extraction and the decode agree byte for byte.
const SCOPE = {
  base: 'main', head_sha: 'abcdef1234567890', head_tree: '1111111111111111111111111111111111111111',
  files: [{ path: 'src/foo.js', status: 'M' }], new_dependency_entries: false, new_modules: false, custom_rules: null,
  harness_triggers_file_exists: false,
  consistency: { ok: true, consistent: true, blind: false, checked_dir: '/fake/install', lens_files_checked: 9, doc_fields: ['recurrence'], agent_fields: ['recurrence'], missing_in_review_schema: [], missing_in_plan_schema: [], review_only_props: [], plan_only_props: [], error: null, escape_hatch_active: false },
}
const cleanLens = () => ({ verdict: 'CLEAN', coverage: { examined: 'x', verified_by: 'y', could_not_check: 'z' }, findings: [], head_sha_measured: 'abcdef1234567890', head_tree_measured: '1111111111111111111111111111111111111111' })
const reviewAgents = (claim) => ({
  'scope:diff': SCOPE,
  'lens-security': cleanLens(), 'lens-qa': cleanLens(),
  synthesis: { report: '### VERDICT\nFINDINGS', spec_bugs: [{ lens: 'lens-qa', location: 'foo.js:1', claim }], rejected_findings: [] },
  'ledger:write': { run_id: 'r1', ts: 'x', write_ok: true, write_error: null },
})
const RUNS = [
  ['tdd-task.js', { args: { task: BRACEY }, agent: {} }, (p) => p.task],
  ['plan-cycle.js', { args: { spec: BRACEY }, agent: {} }, (p) => p.spec],
  // With no spec in play, review-cycle reclassifies the synthesis's spec bugs as ordinary open findings (D4).
  ['review-cycle.js', { args: {}, agent: reviewAgents(BRACEY) }, (p) => [...(p.spec_bugs || []), ...(p.open_findings || [])].map((f) => f.claim).find((c) => c === BRACEY) || null],
]
for (const [file, opts, carried] of RUNS) {
  test(`${file}: every ledger:write payload round-trips with braces, escaped quotes and the return-contract text in a field, and the delimited text is its canonical base64 (AC-QA-15)`, async () => {
    let calls
    try {
      ;({ calls } = await runWorkflow(path.join(WF_DIR, file), opts))
    } catch (e) {
      calls = e.calls
    }
    const writes = calls.filter((c) => c.opts.label === 'ledger:write')
    assert.ok(writes.length >= 2, 'a started and a terminal write')
    let seen = 0
    for (const w of writes) {
      const payload = extractLedgerPayload(w.prompt)
      if (carried(payload) === BRACEY) seen++
      assert.equal(extractEncodedPayload(w.prompt), Buffer.from(JSON.stringify(payload), 'utf8').toString('base64'), 'the delimited text is exactly the canonical base64 of the payload')
      assert.ok(!w.prompt.includes(BRACEY), 'the raw text never appears in the prompt')
    }
    assert.ok(seen >= 1, `BRACEY must reach at least one payload of ${file}`)
  })
}

// Review round 1 F5 (AC-QA-15): the extractor is strict by contract, and prose that looks like a payload is ignored.
const b64 = (o) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64')
const wrap = (encoded, before = '', after = '') => `${before}\n${START_DELIMITER}\n${encoded}\n${END_DELIMITER}\n${after}`
test('extractEncodedPayload: exactly one start and one end delimiter, in order, or it throws (AC-QA-15)', () => {
  const enc = b64({ kind: 'tdd_task', outcome: 'started' })
  assert.throws(() => extractEncodedPayload(`no delimiters here ${enc}`), /expected exactly one/)
  assert.throws(() => extractEncodedPayload(`${START_DELIMITER}\n${START_DELIMITER}\n${enc}\n${END_DELIMITER}`), /found 2 start/)
  assert.throws(() => extractEncodedPayload(`${END_DELIMITER}\n${enc}\n${START_DELIMITER}`), /expected exactly one/)
  assert.throws(() => extractEncodedPayload(wrap(enc) + `\n${END_DELIMITER}`), /found 1 start, 2 end/)
})
test('extractEncodedPayload: a long base64-looking run and braces in the surrounding prose are never mistaken for the payload (AC-QA-15)', () => {
  const real = { kind: 'tdd_task', outcome: 'started', task: 'the real one' }
  const decoy = b64({ kind: 'tdd_task', outcome: 'started', task: 'DECOY' })
  const prose = `Return {run_id, ts, write_ok, write_error}. Example: ${decoy} and {"x":"}"} ` + 'A'.repeat(80)
  assert.equal(extractEncodedPayload(wrap(b64(real), prose, prose)), b64(real))
  assert.deepEqual(extractLedgerPayload(wrap(b64(real), prose, prose)), real)
})
