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

// The production dynamic-workflow runtime statically rejects a set of
// patterns before a script ever executes (confirmed by probe against the
// live runtime, recorded in the main checkout's specs/optimise-cycle.md):
// static `import ... from`, dynamic `import()`, Date.now(), new Date() and
// Math.random(). This helper must reject the same patterns, the same way
// (before evaluation, not as a runtime exception), so a script that would
// fail to launch in production also fails to load here.

test('runWorkflow rejects a script containing a static import declaration, before any agent stub runs', async () => {
  await assert.rejects(
    () => runWorkflow(path.join(__dirname, 'fixtures', 'rejects-static-import.js'), { args: {}, agent: {} }),
    /import/i
  )
})

test('runWorkflow rejects a script containing a dynamic import() call', async () => {
  await assert.rejects(
    () => runWorkflow(path.join(__dirname, 'fixtures', 'rejects-dynamic-import.js'), { args: {}, agent: {} }),
    /import/i
  )
})

test('runWorkflow rejects a script calling Date.now()', async () => {
  await assert.rejects(
    () => runWorkflow(path.join(__dirname, 'fixtures', 'rejects-date-now.js'), { args: {}, agent: {} }),
    /Date\.now/
  )
})

test('runWorkflow rejects a script calling new Date(), with or without arguments', async () => {
  await assert.rejects(
    () => runWorkflow(path.join(__dirname, 'fixtures', 'rejects-new-date.js'), { args: {}, agent: {} }),
    /new Date/
  )
})

test('runWorkflow rejects a script calling Math.random()', async () => {
  await assert.rejects(
    () => runWorkflow(path.join(__dirname, 'fixtures', 'rejects-math-random.js'), { args: {}, agent: {} }),
    /Math\.random/
  )
})

test('runWorkflow does NOT reject a script that only mentions these patterns inside a // comment', async () => {
  const { result } = await runWorkflow(path.join(__dirname, 'fixtures', 'mentions-in-comment-only.js'), { args: {}, agent: {} })
  assert.equal(result.verdict, 'DONE')
})

