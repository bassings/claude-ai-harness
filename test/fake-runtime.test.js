const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { runWorkflow } = require('./helpers/fake-runtime.js')

const FIXTURE = path.join(__dirname, 'fixtures', 'sample-workflow.js')

test('runWorkflow loads a workflow script from disk and runs it to its return value', async () => {
  const { result } = await runWorkflow(FIXTURE, {
    args: { x: 1 },
    agent: { first: { ok: true }, second: { ok: true } },
  })
  assert.equal(result.verdict, 'DONE')
  assert.deepEqual(result.a, { ok: true })
  assert.deepEqual(result.b, { ok: true })
})

test('runWorkflow records every agent call with its prompt and options', async () => {
  const { calls } = await runWorkflow(FIXTURE, {
    args: {},
    agent: { first: { ok: true }, second: { ok: true } },
  })
  assert.equal(calls.length, 2)
  assert.equal(calls[0].prompt, 'first prompt')
  assert.equal(calls[0].opts.label, 'first')
  assert.equal(calls[1].opts.label, 'second')
})

test('runWorkflow injects args, and a missing agent response (undefined) short-circuits the workflow like a real failed agent call', async () => {
  const { result, calls } = await runWorkflow(FIXTURE, {
    args: { x: 2 },
    agent: { first: undefined },
  })
  assert.equal(result.verdict, 'ABORTED')
  assert.equal(calls.length, 1, 'second agent call must never happen once the workflow aborts on the first')
})

test('runWorkflow injects a budget stub whose spent() is readable by the workflow', async () => {
  const { result } = await runWorkflow(FIXTURE, {
    args: {},
    agent: { first: { ok: true }, second: { ok: true } },
    budget: { spent: () => 4242 },
  })
  assert.equal(result.spent, 4242)
})

test('runWorkflow leaves budget as undefined when the caller supplies none, matching a workflow run with no token target set', async () => {
  const { result } = await runWorkflow(FIXTURE, {
    args: {},
    agent: { first: { ok: true }, second: { ok: true } },
  })
  assert.equal(result.spent, null)
})
