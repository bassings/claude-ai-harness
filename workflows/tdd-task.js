export const meta = {
  name: 'tdd-task',
  description: 'Script-enforced TDD for one scoped change: implementation is unreachable until the failing test is verified RED for the right reason, and GREEN is proven against unmodified tests',
  whenToUse: 'For one PR-sized behaviour change. Args: {task: string (required), spec?: string, suite_command?: string (broader gate to run at GREEN), test_hint?: string (where tests live / how to run them)}',
  phases: [
    { title: 'Test', detail: 'write the minimal failing test, nothing else' },
    { title: 'RED', detail: 'independent verifier runs it: must fail, for the right reason' },
    { title: 'Implement', detail: 'minimum code to pass; test files are frozen' },
    { title: 'GREEN', detail: 'verify pass, suite green, test files byte-identical' },
  ],
}

// args can arrive as a JSON-encoded string depending on the caller; normalise before use
let opts = args
if (typeof opts === 'string') { try { opts = JSON.parse(opts) } catch (e) { opts = null } }
opts = opts || {}
if (!opts.task) throw new Error('tdd-task requires args.task: the behaviour to implement')

const specNote = opts.spec ? `The governing spec is ${opts.spec}; the task should satisfy its acceptance criteria.` : ''
const hintNote = opts.test_hint ? `Test location/runner hint: ${opts.test_hint}.` : ''
const MAX_ATTEMPTS = 3

// Attempt counters live outside run(): they are ledger telemetry only, never
// part of the existing, publicly-documented return shape (AC-ARCH-10).
const rounds = { test_attempts: 0, implement_attempts: 0 }

// harn-fix-4: both the Test and Implement phases below dispatch
// agentType: 'implementer', and a null agent() result at either site
// previously aborted with a bare "test-writer agent failed" / "implementer
// agent failed" -- naming neither the agent type nor where a missing
// definition would come from. This workflow script has no filesystem
// access (it cannot import, and cannot read agents/implementer.md to check
// up front -- see the toBase64/ledgerWritePrompt comments below for the
// same constraint), and the Test phase call is already the FIRST thing
// run() does, so there is no earlier point to move a check to. What is
// achievable is making the abort itself legible: name the agentType, name
// where the missing definition would live, and say plainly this is a hint
// (the most common cause of a null result here), not a diagnosis this
// script is able to make -- a transient agent failure would look identical
// from this vantage point. Deliberately placed OUTSIDE the L5 shared
// run-ledger block below (see test/static-checks.test.js's L5 guard):
// this helper is tdd-task-specific, and the block it would otherwise sit
// inside is pinned byte-identical across all three workflow files.
function agentDispatchFailedReason(phaseLabel) {
  return (
    `${phaseLabel} phase: agent() returned no result for agentType: 'implementer'. This workflow cannot check ` +
    `your install from here (workflow scripts have no filesystem access), so this is a hint, not a diagnosis: the ` +
    `most common cause is that no 'implementer' agent definition is installed. tdd-task's Test and Implement ` +
    `phases both dispatch agentType: 'implementer'; a fresh install needs agents/implementer.md (see README.md's ` +
    `install steps). If that file is already installed, the failure is something else -- check the agent step's ` +
    `own output.`
  )
}

// ---- Run-ledger helpers, inlined (workflow scripts cannot import: the
// runtime statically rejects any import statement, so
// workflows/lib/ledger-append.mjs -- the single definition site for the
// envelope schema, AC-ARCH-5 -- is invoked via Bash, never imported). ----

// Reads budget.spent() defensively: null (never 0) when budget is absent or
// throws, so "unmeasured" stays distinguishable from "measured zero"
// (AC-QA-15, AC-OPS-3).
function readBudgetSpent() {
  if (!budget || typeof budget.spent !== 'function') return null
  try {
    const v = budget.spent()
    return typeof v === 'number' && Number.isFinite(v) ? v : null
  } catch (e) {
    return null
  }
}

// Builds the prompt for the ledger-write agent step. `payload` is passed as
// opaque base64-encoded data via stdin (AC-SEC-6, H1): the payload may
// contain arbitrary lens-authored or task text (a finding's claim, a task
// string) with no sanitisation, and JSON.stringify does not escape a
// single quote, so embedding raw JSON in a prompt that recommends a
// single-quoted shell template lets that text break out of the quoting and
// run as a shell command. Base64 has no shell metacharacters in its
// alphabet at all, which removes the escaping problem entirely rather than
// trying to sanitise every free-text field that could reach this prompt.
// The script locates ledger-append.mjs itself; H1 (round 2): the search
// order is installed-mirror-first, repo-local-last-and-gated. /review-cycle
// runs against untrusted diffs, and the ledger:write agent call has no
// isolation option, so it executes in the reviewed checkout -- a repo-local
// workflows/lib/ledger-append.mjs planted by the diff under review must
// never be the one that runs, in any repo except this harness's own.
// Pure-JS UTF-8 base64. No Node globals, no btoa: the workflow runtime
// provides neither (measured 2026-08-18: typeof Buffer and typeof btoa are
// both "undefined"). Replaces Buffer.from(...).toString('base64'), whose
// ReferenceError silently stopped all ledger telemetry for six days.
const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
function toBase64(input) {
  const bytes = []
  for (const ch of String(input)) {
    const cp = ch.codePointAt(0)
    if (cp < 0x80) bytes.push(cp)
    else if (cp < 0x800) bytes.push(0xc0 | (cp >> 6), 0x80 | (cp & 63))
    else if (cp < 0x10000) bytes.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63))
    else bytes.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63))
  }
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : undefined
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : undefined
    out += B64_ALPHABET[b0 >> 2]
    out += B64_ALPHABET[((b0 & 3) << 4) | (b1 === undefined ? 0 : b1 >> 4)]
    out += b1 === undefined ? '=' : B64_ALPHABET[((b1 & 15) << 2) | (b2 === undefined ? 0 : b2 >> 6)]
    out += b2 === undefined ? '=' : B64_ALPHABET[b2 & 63]
  }
  return out
}

function ledgerWritePrompt(payload) {
  const payloadBase64 = toBase64(JSON.stringify(payload))
  return (
    `Append one line to the harness run ledger. Never let this step fail the caller's run: catch every error ` +
    `yourself and report it in your structured output instead of throwing or retrying.\n\n` +
    `1. Find this harness's ledger-append.mjs script, in this exact order, and use the FIRST one that exists: ` +
    `(a) ~/.claude/workflows/lib/ledger-append.mjs (the global mirror install); (b) any installed claude-ai-harness ` +
    `plugin directory's workflows/lib/ledger-append.mjs; (c) "$(git rev-parse --show-toplevel)/workflows/lib/ledger-append.mjs" ` +
    `in the current repo, but ONLY if the current repo is claude-ai-harness itself -- check the basename of ` +
    `\`git rev-parse --show-toplevel\` equals "claude-ai-harness", or (if that fails) \`git remote get-url origin\` ` +
    `names claude-ai-harness. NEVER use a repo-local copy in any OTHER repo, even if (a) and (b) are both absent: ` +
    `report write_ok false instead. A repo-local workflows/lib/ledger-append.mjs is exactly what a hostile diff ` +
    `under review could plant, and this step must never execute it as you.\n` +
    `2. The payload below is base64-encoded SPECIFICALLY so its raw text (which may contain quotes or other shell ` +
    `metacharacters authored by a reviewed diff, a lens finding, or task text) never has to be embedded in a shell ` +
    `command. Do not decode it yourself, inspect it, or reconstruct the JSON by hand: pipe the base64 text straight ` +
    `through base64 -d and into the script, exactly like this, substituting only the real path in the last segment:\n` +
    `   \`printf '%s' '${payloadBase64}' | base64 -d | node <path-to-ledger-append.mjs>\`\n` +
    `3. The script always exits 0 and prints one line of JSON: {run_id, ts, write_ok, write_error}. It already ` +
    `handles locating the main checkout, ensuring the ledger stays gitignored, sourcing the timestamp from the ` +
    `system clock, and the single atomic append -- do not attempt any of that yourself, and do not construct the ` +
    `ledger line by hand.\n` +
    `4. If the script could not be found or failed to run at all (rather than reporting write_ok:false itself), ` +
    `treat that the same way: write_ok false, write_error naming what happened.\n\n` +
    `Return only what the script printed: run_id, ts, write_ok, write_error (null when write_ok is true).`
  )
}

// Calls the ledger-write agent step and never throws: a ledger write failure
// must never fail the harness run (AC-QA-7).
async function writeLedger(payload) {
  let response
  try {
    response = await agent(ledgerWritePrompt(payload), {
      label: 'ledger:write',
      phase: 'Ledger',
      effort: 'low',
      schema: {
        type: 'object',
        required: ['run_id', 'ts', 'write_ok', 'write_error'],
        properties: {
          run_id: { type: 'string' },
          ts: { type: 'string' },
          write_ok: { type: 'boolean' },
          write_error: { type: ['string', 'null'] },
          // Review round-2 M-3: ledger-append.mjs's CLI result now carries
          // invalid_ac_ids_dropped when a lens's malformed ac_id was
          // sanitised -- optional, so an agent not carrying this field
          // (an older writer) is unaffected.
          invalid_ac_ids_dropped: { type: ['integer', 'null'] },
        },
      },
    })
  } catch (e) {
    response = null
  }
  if (!response || response.write_ok !== true) {
    const reason = (response && response.write_error) || 'ledger agent failed or returned no result'
    const runId = (response && response.run_id) || payload.run_id || 'unknown'
    log(`Ledger write failed for run ${runId}: ${reason}`)
    return { write_ok: false, write_error: reason, run_id: runId }
  }
  // Review round-2 M-3: a sanitisation (a lens's non-conforming ac_id,
  // nulled and retained in ac_id_raw by the writer) previously left no
  // operator-visible trace at all beyond a counter buried in the ledger
  // file itself. One log line, only when something was actually dropped.
  if (typeof response.invalid_ac_ids_dropped === 'number' && response.invalid_ac_ids_dropped > 0) {
    log(`Run ${response.run_id}: invalid_ac_ids_dropped=${response.invalid_ac_ids_dropped} (a lens supplied a non-conforming ac_id; sanitised, not lost -- see ac_id_raw in the ledger line)`)
  }
  return { write_ok: true, write_error: null, run_id: response.run_id }
}

// Review round-2 L-2: the exception guard below previously logged a thrown
// error's message verbatim. Workflow scripts have no fs/child_process
// access, so they cannot resolve the checkout root the way
// ledger-append.mjs's stripRoot does (see that file) -- a real Node error
// (ENOENT, module resolution, a stack frame) commonly embeds an absolute
// path, and on the machine that ran this, that path discloses the local
// account name. This is a coarser, root-agnostic pattern match instead: it
// will not catch every leak shape, only the common absolute-path one, but
// it is what is available at this boundary. Applies ONLY to this
// operator-visible console log line -- never to what reaches the ledger
// file itself, which has its own, separate, root-aware redaction.
const ABSOLUTE_PATH_LOG_RE = /\/(?:Users|home)\/[^\s'"]+/g
const MAX_LOG_TEXT = 500
function redactLogText(text) {
  return String(text).slice(0, MAX_LOG_TEXT).replace(ABSOLUTE_PATH_LOG_RE, '<redacted-path>')
}

// The entire pre-existing workflow body, unchanged in behaviour, is wrapped
// in run() so every one of its terminating returns funnels through exactly
// ONE ledger write below (AC-ARCH-3), instead of each return needing its own.
async function run() {

// ---- Phase 1 + 2: write the test, verify RED; loop until genuinely red ----
let test = null
let red = null
for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
  rounds.test_attempts = attempt
  phase('Test')
  test = await agent(
    `TDD, step one only. Task: ${opts.task}\n${specNote} ${hintNote}\n` +
    `Write the MINIMAL failing test(s) that pin this behaviour, in the project's existing test style and location. ` +
    `Write NO implementation code, change NO production file, and do NOT commit. ` +
    (red ? `A previous attempt was rejected by the RED verifier: ${red.evidence}\nFix the TEST so it fails for the right reason.\n` : '') +
    `Return: every test file you created or edited, the exact command that runs just those tests, and expected_failure: ` +
    `what the failure output must say for it to be failing for the RIGHT reason (the missing behaviour, not a typo or import error).`,
    {
      agentType: 'implementer',
      label: `write-test#${attempt}`,
      phase: 'Test',
      schema: {
        type: 'object',
        required: ['test_files', 'test_command', 'expected_failure'],
        properties: {
          test_files: { type: 'array', items: { type: 'string' }, minItems: 1 },
          test_command: { type: 'string' },
          expected_failure: { type: 'string' },
        },
      },
    }
  )
  if (!test) return { verdict: 'ABORTED', reason: agentDispatchFailedReason('Test') }

  phase('RED')
  red = await agent(
    `You are the RED gate of a TDD workflow; you did not write this test and owe it no loyalty.\n` +
    `Run exactly: ${test.test_command}\n` +
    `It is supposed to FAIL. Judge whether it fails for the RIGHT reason: the failure output names the missing ` +
    `behaviour (expected: ${test.expected_failure}), not a syntax error, missing import, fixture problem or typo ` +
    `(a clean "module/symbol does not exist yet" counts as right only when the task is to create that module). ` +
    `A test that PASSES already is an automatic rejection. ` +
    `Also compute the sha256 of each of these files: ${test.test_files.join(', ')} (e.g. \`shasum -a 256\`).\n` +
    `Return red (did it fail), right_reason, evidence (quote the decisive failure lines), and the file hashes. Raw data only.`,
    {
      label: `verify-red#${attempt}`,
      phase: 'RED',
      schema: {
        type: 'object',
        required: ['red', 'right_reason', 'evidence', 'test_hashes'],
        properties: {
          red: { type: 'boolean' },
          right_reason: { type: 'boolean' },
          evidence: { type: 'string' },
          test_hashes: { type: 'array', items: { type: 'object', required: ['file', 'sha256'], properties: { file: { type: 'string' }, sha256: { type: 'string' } } } },
        },
      },
    }
  )
  if (!red) return { verdict: 'ABORTED', reason: 'RED verifier failed' }
  if (red.red && red.right_reason) break
  log(`RED gate rejected attempt ${attempt}: ${red.evidence.slice(0, 200)}`)
  if (attempt === MAX_ATTEMPTS) {
    return { verdict: 'BLOCKED', reason: 'Could not produce a test that fails for the right reason after ' + MAX_ATTEMPTS + ' attempts. The task may be untestable as stated; that is a design finding, not a retry candidate.', last_evidence: red.evidence }
  }
}
log(`RED confirmed: ${test.test_files.join(', ')} fail for the right reason.`)

// ---- Phase 3 + 4: implement, verify GREEN against frozen tests; loop on failure ----
let impl = null
let green = null
for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
  rounds.implement_attempts = attempt
  phase('Implement')
  impl = await agent(
    `TDD, step two. Task: ${opts.task}\n${specNote}\n` +
    `A failing test now pins this behaviour: ${test.test_files.join(', ')} (run via: ${test.test_command}).\n` +
    `Write the MINIMUM production code to make it pass, matching the surrounding code's style. ` +
    `The test files above are FROZEN: do not edit them for any reason; if the test is wrong, stop and say so. ` +
    `Do not commit yet.` +
    (green ? `\nYour previous attempt did not go green. Verifier evidence: ${green.evidence}` : ''),
    {
      agentType: 'implementer',
      label: `implement#${attempt}`,
      phase: 'Implement',
      schema: {
        type: 'object',
        required: ['summary', 'files_changed'],
        properties: { summary: { type: 'string' }, files_changed: { type: 'array', items: { type: 'string' } } },
      },
    }
  )
  if (!impl) return { verdict: 'ABORTED', reason: agentDispatchFailedReason('Implement') }

  phase('GREEN')
  const hashList = red.test_hashes.map(h => `${h.file}: ${h.sha256}`).join('\n')
  green = await agent(
    `You are the GREEN gate of a TDD workflow.\n` +
    `1. Run exactly: ${test.test_command} — it must PASS.\n` +
    `2. ${opts.suite_command ? `Run the broader gate: ${opts.suite_command} — it must pass.` : 'No broader suite command was supplied; note that in your evidence.'}\n` +
    `3. Recompute sha256 for each test file and compare against the RED-time hashes (a mismatch means the test was ` +
    `edited to pass, which voids the whole exercise):\n${hashList}\n` +
    `Return green (target tests pass), suite_green (${opts.suite_command ? 'broader gate passed' : 'set true, none supplied'}), ` +
    `hashes_match, and evidence quoting the decisive output. Raw data only.`,
    {
      label: `verify-green#${attempt}`,
      phase: 'GREEN',
      schema: {
        type: 'object',
        required: ['green', 'suite_green', 'hashes_match', 'evidence'],
        properties: {
          green: { type: 'boolean' },
          suite_green: { type: 'boolean' },
          hashes_match: { type: 'boolean' },
          evidence: { type: 'string' },
        },
      },
    }
  )
  if (!green) return { verdict: 'ABORTED', reason: 'GREEN verifier failed' }
  if (green.hashes_match === false) {
    return { verdict: 'BLOCKED', reason: 'Test files changed between RED and GREEN: the test was altered to pass. Nothing is committed; review the working tree by hand.', evidence: green.evidence }
  }
  if (green.green && green.suite_green) break
  log(`GREEN gate rejected attempt ${attempt}: ${green.evidence.slice(0, 200)}`)
  if (attempt === MAX_ATTEMPTS) {
    return { verdict: 'BLOCKED', reason: MAX_ATTEMPTS + ' implementation attempts did not go green. Per the three-failures rule, the frame is suspect: re-open the approach rather than retrying.', last_evidence: green.evidence }
  }
}

// ---- Commit: only reachable with RED proven, GREEN proven, tests untouched ----
const commit = await agent(
  `In the current repo, commit the completed TDD task. Stage the test files (${test.test_files.join(', ')}) and ` +
  `implementation files (${impl.files_changed.join(', ')}) plus any files they require; use a conventional commit ` +
  `message for: ${opts.task}. Follow the project's commit conventions. Commit locally only; NEVER push. ` +
  `Return the commit SHA and the one-line message.`,
  { label: 'commit', phase: 'GREEN', effort: 'low' }
)

return {
  verdict: 'DONE',
  task: opts.task,
  test_files: test.test_files,
  red_evidence: red.evidence,
  green_evidence: green.evidence,
  tests_frozen: green.hashes_match,
  implementation: impl.summary,
  commit: commit,
}

} // end run()

const OUTCOME_BY_VERDICT = { DONE: 'done', BLOCKED: 'blocked', ABORTED: 'aborted' }

// Start/terminal record protocol (AC-DATA-5): an append-only start record
// before any work happens, and a terminal record after, sharing a run_id,
// so a run killed mid-flight is recorded as incomplete rather than absent.
// If the start write itself fails, the terminal write below simply gets its
// own fresh run_id (AC-QA-7: a ledger write failure never blocks the run).
const startWrite = await writeLedger({ kind: 'tdd_task', outcome: 'started', task: opts.task, spec: opts.spec || null })
const startRunId = startWrite.write_ok ? startWrite.run_id : null

// PR 2 (AC-QA-8, AC-ARCH-9): an exception escaping run() must still
// produce exactly one terminal ledger write, carrying the existing
// aborted outcome via the SAME mapping site below -- never a second
// writeLedger( call site (AC-SIMP-7) and never a fabricated 'done'
// (AC-QA-12). The original error is re-thrown after the write so it still
// reaches the caller (AC-OPS-1), never swallowed by a failing terminal
// write (writeLedger itself never throws, see above). Round-1 review M2:
// `threw` tracks whether the catch fired, never the thrown value's
// truthiness -- `throw null`/`throw undefined`/`throw 0`/`throw ''` are
// all falsy, so gating the re-throw on `runError` itself silently resolved
// the workflow instead of propagating, a regression against pre-PR2
// behaviour where every throw reached the caller.
let runError = null
let threw = false
let raw
try {
  raw = await run()
} catch (e) {
  runError = e
  threw = true
  raw = {}
  log(`Run ${startRunId || 'unknown'} threw before producing a result: ${redactLogText(e && e.message ? e.message : String(e))}`)
} // end PR 2 exception guard
const result = raw
const telemetry = {
  outcome: OUTCOME_BY_VERDICT[result.verdict] || 'aborted',
  spec: opts.spec || null,
  budget_spent: readBudgetSpent(),
  rounds: { test_attempts: rounds.test_attempts, implement_attempts: rounds.implement_attempts },
}
const terminalEntry = { kind: 'tdd_task', task: opts.task, ...telemetry }
if (startRunId) terminalEntry.run_id = startRunId
const terminalWrite = await writeLedger(terminalEntry)
// 2026-08-18: give write_ok:false a CONSUMER -- see plan-cycle.js for the
// full rationale. It was computed, logged and returned to nobody, so the
// ledger stopped recording on 2026-08-12 and nothing noticed for six days.
// AC-QA-7 still holds: this reports, it never throws. What AC-QA-7 does not
// say is that the failure may be indistinguishable from success.
const ledgerFailed = !startWrite.write_ok || !terminalWrite.write_ok
if (ledgerFailed) {
  // Assigned onto `result` rather than branching the final return, so the
  // `if (threw) throw runError` / `return { ...result, telemetry }` pair stays
  // byte-identical across all three workflows (AC-ARCH-9).
  result.ledger_write_failed = true
  result.ledger_write_error = startWrite.write_error || terminalWrite.write_error || 'unknown'
  const why = startWrite.write_error || terminalWrite.write_error || 'unknown'
  log(`TELEMETRY NOT RECORDED for this run: ${redactLogText(String(why))}. The run itself is unaffected, but this run leaves no telemetry.`)
}
if (threw) throw runError
return { ...result, telemetry }
