// Fake-runtime test helper (AC-QA-1, AC-QA-2).
//
// Loads a dynamic-workflow script from disk and executes it exactly the way
// the real runtime does: `export const meta = ...` is the only module-level
// export, everything else is the body of an implicit async function that
// receives `agent`, `parallel`, `pipeline`, `phase`, `log`, `args` and
// `budget` as ambient bindings (not imports) and ends in a top-level
// `return`. A workflow script may additionally start with plain
// `import { a, b } from './relative.mjs'` lines pulling in a sibling module
// under the same directory (e.g. workflows/lib/*.mjs); those are resolved
// with a real dynamic import() and spliced in as extra bindings, mirroring
// what the production runtime is assumed to support for local, same-repo
// modules (untested against production; see docs/pr1-mutation-proofs.md).
//
// No filesystem access happens *inside* the compiled script itself (matching
// the real runtime): all fs/git/clock work the workflow needs is delegated
// to its own `agent()` calls, which is exactly what this helper stubs out.

const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor

const IMPORT_LINE_RE = /^import\s*\{([^}]+)\}\s*from\s*['"](\.[^'"]+)['"];?\s*$/gm
const META_EXPORT_RE = /^export\s+const\s+meta\s*=/m

// Parses and strips leading `import { a, b } from './x.mjs'` lines, resolving
// each named binding via dynamic import() against files on disk (no bundler,
// no dependency: this is Node's built-in ESM loader).
async function resolveLocalImports(source, baseDir) {
  const names = []
  const values = []
  let stripped = source
  let match
  IMPORT_LINE_RE.lastIndex = 0
  while ((match = IMPORT_LINE_RE.exec(source))) {
    const bindingNames = match[1].split(',').map((s) => s.trim()).filter(Boolean)
    const modPath = path.resolve(baseDir, match[2])
    const mod = await import(pathToFileURL(modPath).href)
    for (const name of bindingNames) {
      names.push(name)
      values.push(mod[name])
    }
    stripped = stripped.replace(match[0], '')
  }
  return { stripped, names, values }
}

// Compiles a workflow file's source into an AsyncFunction whose parameter
// list is the fixed runtime binding names plus any locally-imported names,
// in that order. Returns the function together with the import binding
// values (already resolved) so the caller only has to supply the fixed
// runtime stubs.
async function compile(filePath) {
  const source = fs.readFileSync(filePath, 'utf8')
  const baseDir = path.dirname(filePath)
  const { stripped, names: importNames, values: importValues } = await resolveLocalImports(source, baseDir)
  const body = stripped.replace(META_EXPORT_RE, 'const meta =')
  const paramNames = ['agent', 'parallel', 'pipeline', 'phase', 'log', 'args', 'budget', ...importNames]
  const fn = new AsyncFunction(...paramNames, body)
  return { fn, importValues }
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
// Returns { result, calls, logs, phases }.
async function runWorkflow(filePath, options = {}) {
  const { fn, importValues } = await compile(filePath)
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

  const result = await fn(
    agentStub,
    parallelStub,
    pipelineStub,
    phaseStub,
    logStub,
    options.args,
    options.budget,
    ...importValues
  )
  return { result, calls, logs, phases }
}

module.exports = { runWorkflow, makeAgentStub }
