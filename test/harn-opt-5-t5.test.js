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
const { instructedCommands, actAsCompliantAgent } = require('./helpers/ledger-agent.js')
const { makeTempRepo, sh, cleanupTempRepos, readLedgerLines, SUITE_TMPDIR } = require('./helpers/temp-repo.js')

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
    assert.match(prompt, /\bWrite\b[^.]*tool|file-writing tool/i, 'tells the agent to use its file-writing tool (Write)')
    assert.match(prompt, /never[^.]*(shell|Bash)/i, 'forbids writing the payload via a shell command')
    assert.match(prompt, /read(ing)? the empty file first/i, 'covers the tool that needs a read before write')
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
    const afterRm = prompt.slice(prompt.indexOf('rm "<the file>"') - 600)
    for (const exitPath of [/write_ok:?\s*false/i, /(not found|cannot be found|could not be found)/i, /(fail(s|ed)? to start|node (itself )?(fail|could not start))/i]) {
      assert.match(prompt, exitPath, `delete step must cover exit path ${exitPath}`)
    }
    assert.match(afterRm, /every (exit )?path|regardless|in every case|always/i, 'the delete is stated as unconditional')
  })

  test(`${file}: a failed or empty mktemp, or a path that already holds content, reports write_ok false naming that and pipes nothing (AC-SEC-3, AC-DATA-7)`, async () => {
    const prompt = await firstPrompt(file)
    assert.match(prompt, /mktemp fails|if mktemp (fails|prints nothing)/i)
    assert.match(prompt, /already (exists|held|holds|has) content|collision/i)
    assert.match(prompt, /(do not|never|not) (run|pipe|feed)[^.]*(writer|ledger-append)|(writer|ledger-append)[^.]*(is )?not run/i, 'says nothing is piped to the writer on a collision')
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
for (const [file, key] of [['tdd-task.js', 'task'], ['plan-cycle.js', 'spec']]) {
  test(`${file}: every ledger:write payload round-trips deepEqual with braces, escaped quotes and the return-contract text in a field (AC-QA-15)`, async () => {
    let calls
    try {
      ;({ calls } = await runWorkflow(path.join(WF_DIR, file), { args: { [key]: BRACEY }, agent: {} }))
    } catch (e) {
      calls = e.calls
    }
    const writes = calls.filter((c) => c.opts.label === 'ledger:write')
    assert.ok(writes.length >= 1)
    for (const w of writes) {
      const payload = extractLedgerPayload(w.prompt)
      if (payload.outcome === 'started') assert.equal(payload[key], BRACEY)
      assert.deepEqual(payload, JSON.parse(JSON.stringify(payload)))
    }
  })
}
