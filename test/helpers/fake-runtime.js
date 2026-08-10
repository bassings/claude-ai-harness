// Fake-runtime test helper (AC-QA-1, AC-QA-2).
//
// Loads a dynamic-workflow script from disk and executes it exactly the way
// the real runtime does: `export const meta = ...` is the only module-level
// export, everything else is the body of an implicit async function that
// receives `agent`, `parallel`, `pipeline`, `phase`, `log`, `args` and
// `budget` as ambient bindings (not imports) and ends in a top-level
// `return`.
//
// Before compiling anything, the source is checked against the same static
// pre-checks the production dynamic-workflow runtime applies before a
// script ever executes (confirmed by probing the live runtime; see
// specs/optimise-cycle.md's "Verified runtime facts" in the main checkout):
// no `import ... from` declaration, no dynamic `import()` call, no
// `Date.now()`, no `new Date(...)`, no `Math.random()`. A script violating
// any of these is rejected here the same way production rejects it -- before
// evaluation, not as a runtime exception -- so workflow scripts that would
// fail to launch in production also fail to load in this helper. Workflow
// scripts are therefore fully self-contained: no local imports are possible,
// so any code they need (including node:crypto-dependent helpers like
// hashing) must live in a real-Node script invoked via an agent's Bash step,
// never imported.
//
// No filesystem access happens *inside* the compiled script itself (matching
// the real runtime): all fs/git/clock work a workflow needs is delegated to
// its own `agent()` calls, which is exactly what this helper stubs out.

const fs = require('node:fs')

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor

// Static rejection patterns, matched against the source with `//` line
// comments stripped first so a script may still MENTION these patterns in
// prose without being rejected (only executable code is checked).
const REJECTIONS = [
  { name: 'a static import declaration', re: /^\s*import\b/m },
  { name: 'a dynamic import() call', re: /\bimport\s*\(/ },
  { name: 'Date.now()', re: /\bDate\.now\s*\(/ },
  { name: 'new Date(...)', re: /\bnew\s+Date\s*\(/ },
  { name: 'Math.random()', re: /\bMath\.random\s*\(/ },
]

function stripLineComments(source) {
  return source
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n')
}

function assertProductionSafe(source, filePath) {
  const code = stripLineComments(source)
  for (const rule of REJECTIONS) {
    if (rule.re.test(code)) {
      throw new Error(
        `${filePath}: contains ${rule.name}, which the dynamic-workflow runtime statically rejects before ` +
        `execution ("Workflow scripts must be deterministic" / no local imports). Fix the script, not this check.`
      )
    }
  }
}

const META_EXPORT_RE = /^export\s+const\s+meta\s*=/m

// Compiles a workflow file's source into an AsyncFunction whose parameter
// list is the fixed runtime binding names. Throws (does not return a
// promise that rejects later) if the source fails the static pre-check --
// this mirrors production rejecting at submission, before any agent call
// could possibly happen.
function compile(filePath) {
  const source = fs.readFileSync(filePath, 'utf8')
  assertProductionSafe(source, filePath)
  const body = source.replace(META_EXPORT_RE, 'const meta =')
  const paramNames = ['agent', 'parallel', 'pipeline', 'phase', 'log', 'args', 'budget']
  return new AsyncFunction(...paramNames, body)
}

// Builds a stub `agent(prompt, opts)` that records every call and resolves
// scripted responses, keyed by `opts.label` (the convention every workflow
// script in this repo already uses). A response may be:
//   - a plain value: returned on every call with that label
//   - an array: consumed in order across repeated calls with that label
//     (e.g. retry loops like write-test#1, write-test#2)
//   - a function(prompt, opts, callIndex): computed dynamically
// A label with no scripted response resolves to undefined, matching a real
// agent call that failed or was stopped.
function makeAgentStub(responses, calls) {
  const perLabelIndex = {}
  return async function agent(prompt, opts = {}) {
    const record = { prompt, opts }
    calls.push(record)
    const label = opts.label || ''
    if (!responses || !(label in responses)) return undefined
    const resp = responses[label]
    if (typeof resp === 'function') return resp(prompt, opts, calls.length)
    if (Array.isArray(resp)) {
      const i = perLabelIndex[label] || 0
      perLabelIndex[label] = i + 1
      return resp[i]
    }
    return resp
  }
}

// Runs the workflow at filePath to completion against fake runtime stubs.
// options:
//   args    - the value the workflow sees as its `args` global
//   agent   - map of label -> scripted response (see makeAgentStub)
//   budget  - a budget stub ({spent(): number, total?: number|null}); omit
//             to simulate a run with no budget object at all
// Returns { result, calls, logs, phases }. Throws synchronously (wrapped in
// the returned rejected promise) if the script fails the static pre-check.
async function runWorkflow(filePath, options = {}) {
  const fn = compile(filePath)
  const calls = []
  const logs = []
  const phases = []
  const agentStub = makeAgentStub(options.agent, calls)
  const parallelStub = async (thunks) => Promise.all(thunks.map((t) => t()))
  const pipelineStub = async (thunks) => {
    let value
    for (const t of thunks) value = await t(value)
    return value
  }
  const phaseStub = (title) => phases.push(title)
  const logStub = (msg) => logs.push(msg)

  const result = await fn(agentStub, parallelStub, pipelineStub, phaseStub, logStub, options.args, options.budget)
  return { result, calls, logs, phases }
}

module.exports = { runWorkflow, makeAgentStub }
