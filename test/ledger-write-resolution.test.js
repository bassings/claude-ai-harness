// H1 (RCE): the ledger-write prompt in all three workflows previously
// resolved workflows/lib/ledger-append.mjs from the repo under review
// FIRST, before the installed mirror. /review-cycle is aimed at untrusted
// diffs, so a planted workflows/lib/ledger-append.mjs in any target repo
// would execute as the operator, with no lens ever having reported. The
// fix inverts the order: the installed mirror and plugin directory are
// checked first, and the repo-local copy is only ever accepted when the
// CURRENT repo is claude-ai-harness itself.
//
// These tests inspect the actual prompt text each workflow's first
// ledger:write agent call carries (captured through the fake runtime, not
// re-typed by hand), so they exercise the real, shipping prompt rather
// than a copy that could drift from it.
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { runWorkflow } = require('./helpers/fake-runtime.js')

const WORKFLOWS = {
  'tdd-task.js': { file: path.join(__dirname, '..', 'workflows', 'tdd-task.js'), args: { task: 'x' } },
  'review-cycle.js': { file: path.join(__dirname, '..', 'workflows', 'review-cycle.js'), args: {} },
  'plan-cycle.js': { file: path.join(__dirname, '..', 'workflows', 'plan-cycle.js'), args: { spec: 'specs/x.md' } },
}

// The very first agent() call every workflow makes is its start-record
// ledger:write (before any lens/work agent runs), so no scripted response
// is needed to capture it -- an unscripted call still records its prompt.
//
// An entirely unscripted agent (agent: {}) makes every call, including the
// scope step, resolve to undefined -- a totally failed scope agent. In
// review-cycle.js that now throws (AC-1 of the no-op-masquerading-as-
// success fix: a broken scope step must be loud, never a silent no-op), so
// the workflow's own promise rejects even though the FIRST ledger:write
// call still happened before the throw. runWorkflow attaches calls/logs to
// a rejection for exactly this reason (see its own comment); read from
// there when the run rejects, from the normal result otherwise, so this
// helper works for a workflow that returns AND one that legitimately
// throws after its first ledger write.
async function firstLedgerWritePrompt(file, args) {
  let calls
  try {
    ;({ calls } = await runWorkflow(file, { args, agent: {} }))
  } catch (e) {
    // Round-1 review finding 6: this helper is shared across all three
    // workflows, so a bare catch would swallow ANY unexpected throw from
    // ANY of them, not only review-cycle.js's deliberate scope-agent-failed
    // throw (AC-1). Narrowed to the one error this fixture is known to
    // produce -- an unexpected rejection (a different workflow throwing
    // where it should still return, or review-cycle throwing something
    // other than the scope-step failure) fails loudly here instead of
    // being silently absorbed and possibly masking a real regression.
    assert.match(
      String(e && e.message),
      /^ScopeStepFailed:/,
      `firstLedgerWritePrompt(${file}) caught an unexpected rejection -- only review-cycle.js's totally-failed-scope ` +
        `throw is expected here, so this must not be silently swallowed: ${e && e.message}`
    )
    calls = e.calls
  }
  const call = calls.find((c) => c.opts.label === 'ledger:write')
  assert.ok(call, 'expected a ledger:write call to have happened')
  return call.prompt
}

for (const [name, { file, args }] of Object.entries(WORKFLOWS)) {
  test(`${name}: the ledger-write prompt checks the installed mirror (~/.claude/workflows/lib/) BEFORE the repo-local copy (H1)`, async () => {
    const prompt = await firstLedgerWritePrompt(file, args)
    const mirrorIdx = prompt.indexOf('~/.claude/workflows/lib/ledger-append.mjs')
    const repoLocalIdx = prompt.indexOf('workflows/lib/ledger-append.mjs" in the current repo')
    assert.ok(mirrorIdx !== -1, 'prompt must mention the installed mirror path')
    assert.ok(repoLocalIdx !== -1, 'prompt must mention the repo-local path')
    assert.ok(mirrorIdx < repoLocalIdx, `installed mirror must be checked BEFORE the repo-local copy: mirror at ${mirrorIdx}, repo-local at ${repoLocalIdx}`)
  })

  test(`${name}: the ledger-write prompt gates the repo-local copy on a CONCRETE check that the current repo is claude-ai-harness itself, not just a mention of the name (H1)`, async () => {
    // "claude-ai-harness" already appears in the OLD prompt too, as the name
    // of the plugin directory to search -- an unrelated occurrence. A test
    // that only checks the bare word would pass on the OLD, vulnerable text
    // (verified: it did, before this assertion was tightened). The gate
    // must instead name a CONCRETE, checkable condition: the toplevel
    // basename, or the origin remote, actually being/naming
    // claude-ai-harness.
    const prompt = await firstLedgerWritePrompt(file, args)
    assert.ok(/basename/.test(prompt), 'prompt must instruct checking the toplevel basename')
    assert.ok(/origin/.test(prompt), 'prompt must instruct checking the origin remote as a fallback identity check')
    assert.ok(/is claude-ai-harness itself|claude-ai-harness itself/.test(prompt), 'prompt must state the concrete gate condition in these terms')
  })

  test(`${name}: the prompt explicitly forbids using a repo-local copy in any OTHER repo (H1)`, async () => {
    const prompt = await firstLedgerWritePrompt(file, args)
    assert.ok(/never use.{0,80}repo-local|repo-local copy in (any )?other repo|NEVER.{0,120}repo-local/is.test(prompt), 'the gate must be phrased as a hard restriction naming "repo-local" explicitly, not just a mention of claude-ai-harness')
  })
}

test('the ledger-write prompt is byte-identical across all three workflows (cross-check with the L5 static test, from the runtime side)', async () => {
  const prompts = await Promise.all(Object.values(WORKFLOWS).map(({ file, args }) => firstLedgerWritePrompt(file, args)))
  // the payload differs (base64-encoded, kind-specific), but the search-order
  // instructions in step 1 must be identical; compare just that clause
  const step1s = prompts.map((p) => p.slice(p.indexOf('1. Find'), p.indexOf('2. ')))
  assert.equal(step1s[1], step1s[0], 'review-cycle.js step 1 differs from tdd-task.js')
  assert.equal(step1s[2], step1s[0], 'plan-cycle.js step 1 differs from tdd-task.js')
})
