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
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor

// L3: the fake agent stub previously ignored a workflow's declared `schema`
// entirely, so every test that claims to exercise a schema (four non-
// trivial ones across the three workflows) actually only exercised the JS
// fallback path that would run after the real runtime's structured-output
// enforcement had already rejected a malformed response -- a typo in a
// schema shipped with the suite green. validateEntry is the same
// dependency-free structural validator workflows/lib/ledger-append.mjs
// uses for the ledger envelope; it is general-purpose (required fields,
// additionalProperties, enum, pattern, array-of-object/array-of-primitive
// items) and reused here as-is rather than duplicated. Imported lazily via
// a cached dynamic import(): this file is CommonJS (no package.json sets
// "type": "module") and ledger-append.mjs is an ES module.
const LEDGER_APPEND_PATH = path.join(__dirname, '..', '..', 'workflows', 'lib', 'ledger-append.mjs')
let validateEntryPromise = null
function getValidateEntry() {
  if (!validateEntryPromise) {
    validateEntryPromise = import(pathToFileURL(LEDGER_APPEND_PATH).href).then((m) => m.validateEntry)
  }
  return validateEntryPromise
}

// Round 3 LOW (speculative, reviewer-verification): this is a BEST-EFFORT
// approximation of the production dynamic-workflow runtime's static
// rejection check, matched by regex against source text -- not an AST or
// evaluation-based check, because the spec states production rejects these
// constructs "statically at submission" but does not pin the mechanism it
// uses, and this helper cannot probe the live production runtime from a
// test's own process. It fails CLOSED on a `//` comment mention (stripped
// before matching, so a script may document these patterns in prose
// without being rejected) but is inherently unable to catch every possible
// obfuscation (e.g. re-deriving the literal strings "Date"/"import" via
// string concatenation or Unicode escapes, or reaching them through
// `globalThis`/`this` indirection). Accepted as a residual risk: the three
// real workflow scripts in this repo are clean (confirmed by grep finding
// zero mentions of "Date" or "Math" in any of them), so nothing ships
// broken today; the risk is a future workflow author writing an obfuscated
// form this regex set does not recognise. Re-derive this list whenever the
// production rejection mechanism is re-probed, rather than assuming it
// stays regex-shaped forever.
//
// Widened past the literal call forms (Date.now(), new Date(),
// Math.random()) to also catch the cheapest real obfuscations: Date
// accessed via bracket notation or aliased through a variable before being
// called (a bare `Date` token, since there is no legitimate reason for a
// workflow script to reference the Date class at all), and Math.random
// aliased through a variable before being called (`Math.random` as a bare
// property access, not requiring an immediate `(`). Math is NOT banned as
// a bare token -- only Math.random specifically -- since Math.floor,
// Math.max and similar ARE legitimate and are not restricted by the
// runtime; banning the whole Math object would be a real false positive
// against future legitimate code, not just today's three scripts.
// "import used as a bare identifier" (also named in the finding) was
// deliberately NOT added: `import` is a reserved word in JS syntax, so
// `const i = import` is a SyntaxError, not valid code that could ever
// reach this check -- there is no cheap, meaningful token-level guard to
// add for a bypass that the language itself does not allow.
const REJECTIONS = [
  { name: 'a static import declaration', re: /^\s*import\b/m },
  { name: 'a dynamic import() call', re: /\bimport\s*\(/ },
  { name: 'Date.now()', re: /\bDate\.now\s*\(/ },
  { name: 'new Date(...)', re: /\bnew\s+Date\s*\(/ },
  { name: 'Math.random()', re: /\bMath\.random\s*\(/ },
  { name: 'a bare reference to Date (bracket access or aliasing can reach Date.now() without matching the literal call forms above)', re: /\bDate\b/ },
  { name: 'Math.random accessed without an immediate call (aliasing through a variable can reach it without matching the literal call form above)', re: /\bMath\.random\b/ },
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
    let resp
    if (!responses || !(label in responses)) {
      resp = undefined
    } else {
      const scripted = responses[label]
      if (typeof scripted === 'function') resp = scripted(prompt, opts, calls.length)
      else if (Array.isArray(scripted)) {
        const i = perLabelIndex[label] || 0
        perLabelIndex[label] = i + 1
        resp = scripted[i]
      } else {
        resp = scripted
      }
    }
    // undefined represents "the agent failed or was stopped" -- a real
    // outcome the workflow must handle, not a malformed structured
    // response, so it is never validated against the schema.
    //
    // A response carrying __bypassSchemaValidation: true is a deliberate,
    // documented escape hatch: some workflows defend against a structured
    // response that violates their OWN declared schema anyway (e.g.
    // review-cycle.js's synthesis-missing-required-fields fallback,
    // AC-QA-13) -- defence in depth against the runtime's structured-output
    // enforcement somehow being bypassed. That is legitimately worth
    // testing even though production is not expected to ever produce it,
    // so a fixture may opt out explicitly rather than the check being
    // silently weakened for everyone.
    if (resp && typeof resp === 'object' && resp.__bypassSchemaValidation) {
      const { __bypassSchemaValidation, ...rest } = resp
      return rest
    }
    if (opts.schema && resp !== undefined) {
      const validateEntry = await getValidateEntry()
      const errors = validateEntry(resp, opts.schema)
      if (errors.length) {
        throw new Error(
          `fake-runtime: the scripted response for agent() label "${label}" does not match its declared schema ` +
          `(this is a test-fixture bug, not a workflow bug -- the real runtime would never let a non-conforming ` +
          `structured response through). If this fixture is DELIBERATELY simulating that impossible case (e.g. ` +
          `defensive fallback code), add __bypassSchemaValidation: true to the scripted response. ` +
          `Schema errors: ${errors.join('; ')}`
        )
      }
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

// L6: makeAgentStub used to be exported too, but no test file ever imports
// it directly -- every test goes through runWorkflow, which calls it
// internally. The export was dead code kept looking live only by its own
// name being visible here; the function itself stays (runWorkflow needs
// it), only the unused export path is removed.
module.exports = { runWorkflow }
