export const meta = {
  name: 'plan-cycle',
  description: 'Multi-lens planning cycle: triggered lenses write AC-<LENS>-<n> criteria into the spec, per AGENT-HARNESS.md',
  whenToUse: 'After drafting a spec, before implementation. Args: {spec: string (path to the spec, required), lenses?: string[] (override triggering)}',
  phases: [
    { title: 'Scope', detail: 'read the spec, classify the change surface' },
    { title: 'Lenses', detail: 'triggered lenses draft acceptance criteria in parallel' },
    { title: 'Synthesis', detail: 'merge criteria, apply the simplicity veto, write the AC block into the spec' },
  ],
}

// HARN-FIX-3 install-consistency preflight block (AC-QA-1..5): byte-identical
// across plan-cycle.js and review-cycle.js, mirroring the L5/PR2 triplicated
// -block pattern below (the run-ledger helpers) -- a fix landed in one copy
// and not the other fails silently, exactly the class of bug this whole
// spec exists to catch. See test/static-checks.test.js's pinning test.
//
// AC-QA-2 (AMENDED, round-two review, specs/harn-fix-3.md): REFUSE ONLY ON
// PROOF, WARN ON DOUBT. The prose parse of AGENT-HARNESS.md and
// agents/lens-*.md (install-consistency.mjs's checkConsistency, and the
// doc_fields/agent_fields it reports) is a HEURISTIC -- it has already been
// wrong once in this exact codebase (H1: one ordinary documentation edit
// flipped every install to consistent:false). The IN-PROCESS cross-check
// below (crossCheckAgainstOwnSchema), comparing the model-reported fields
// against the LITERAL PLAN_SCHEMA/REVIEW_SCHEMA object this running script
// holds, is the one RELIABLE half: no fs, no subprocess, no model, nothing
// left to parse. Only that half's PROVEN mismatch, or a self-contradictory
// report (M3: the reported fields disagree with the reported verdict, which
// needs no external parsing to detect), refuses dispatch. Everything else
// -- the consistency field missing entirely, blind, ok:false, or the
// script's own prose-derived verdict alone with no in-process proof -- is
// uncertainty: warn loudly via log() and PROCEED, never halt. See
// evaluateInstallConsistency() below, the single decision point.
const INSTALL_CONSISTENCY_INSTRUCTION =
  `Before anything else, verify the installed harness agrees with itself (specs/harn-fix-3.md AC-QA-1): find this ` +
  `harness's install-consistency.mjs script. If the environment variable CLAUDE_HOME is set (M11: the SAME override ` +
  `the staleness check already honours), use "$CLAUDE_HOME/workflows/lib/install-consistency.mjs" and treat ` +
  `$CLAUDE_HOME itself as the install root directly -- this takes priority and skips the search below entirely. ` +
  `Otherwise, use this exact search order, the FIRST one that exists: (a) ~/.claude/workflows/lib/install-consistency.mjs ` +
  `(the global mirror install); (b) a claude-ai-harness plugin directory installed under $HOME (wherever Claude Code ` +
  `installs plugins for this operator) -- NEVER a path inside the repository currently being planned or reviewed, ` +
  `even one that happens to be named .claude/plugins/ or similar (M2: a repo-local path is exactly what a hostile ` +
  `diff under review could plant, and there is no way to tell a legitimately-installed plugin apart from a planted ` +
  `one once the search is allowed to look inside the checkout under review, so the checkout is never a source for ` +
  `this script, full stop -- there is deliberately no repo-local fallback option at all, even when this repo IS ` +
  `claude-ai-harness itself). If neither CLAUDE_HOME nor (a) nor (b) resolves to a real file, that is not a security ` +
  `concern, only an absent install: return ` +
  `{ok:false, consistent:false, blind:true, checked_dir:"not found", error:"no install-consistency.mjs found outside the working tree", escape_hatch_active:false} ` +
  `as the "consistency" field instead of running anything.\n` +
  `Run it with the install root you found it under as its ONE argument (the parent of the ` +
  `workflows/lib directory it lives in), exactly like: \`node <path-to-install-consistency.mjs> <install-root>\`. ` +
  `It always exits 0 and prints exactly one line of JSON. Return EXACTLY what it printed as the "consistency" ` +
  `field -- do not reinterpret, summarise, or recompute any part of it yourself, and do not skip this step even if ` +
  `you believe you already know the answer: the determination is made by the script, not by you. ` +
  `If the script failed to run at all (rather than printing its own JSON), that is itself a partial or broken ` +
  `install: return {ok:false, consistent:false, blind:true, checked_dir:"not found", error:"<what happened>", escape_hatch_active:false} ` +
  `as the "consistency" field yourself -- NEVER omit the field or fabricate {consistent:true, ...} to skip this step.\n\n`

const INSTALL_CONSISTENCY_SCHEMA = {
  type: 'object',
  required: ['ok', 'consistent', 'blind', 'checked_dir', 'doc_fields', 'agent_fields', 'escape_hatch_active'],
  properties: {
    ok: { type: 'boolean' },
    consistent: { type: 'boolean' },
    blind: { type: 'boolean' },
    checked_dir: { type: 'string' },
    lens_files_checked: { type: ['integer', 'null'] },
    // MED-2 (round-one review): required, not merely reported, because the
    // in-process cross-check below (crossCheckAgainstOwnSchema) needs these
    // as its OWN input -- the fields the model claims AGENT-HARNESS.md and
    // agents/lens-*.md instruct, re-verified here against the literal
    // schema object this process holds, rather than trusted at face value.
    doc_fields: { type: 'array', items: { type: 'string' } },
    agent_fields: { type: 'array', items: { type: 'string' } },
    missing_in_review_schema: { type: 'array', items: { type: 'string' } },
    missing_in_plan_schema: { type: 'array', items: { type: 'string' } },
    review_only_props: { type: 'array', items: { type: 'string' } },
    plan_only_props: { type: 'array', items: { type: 'string' } },
    error: { type: ['string', 'null'] },
    // M9 (round-two review): HARNESS_ALLOW_INCONSISTENT_INSTALL=1, read from
    // THIS PROCESS's own environment by install-consistency.mjs's main() (a
    // real Node script, unlike this workflow script, which has no
    // process.env access at all) and relayed here -- matching
    // hooks/destructive-git-guard.py's HARNESS_ALLOW_DESTRUCTIVE_GIT in
    // naming and shape. See evaluateInstallConsistency() below for what it
    // does and does not override.
    escape_hatch_active: { type: 'boolean' },
  },
}

function installConsistencyError(reason) {
  return new Error(
    `InstallInconsistent (AC-QA-2, PROVEN by the in-process cross-check -- not a heuristic, not a false positive): ` +
    `${reason} Refusing to dispatch any lens: an instructed field with no schema slot is silently dropped (H3's own ` +
    `shape). Re-sync the installed copy from the published repo, then re-run. To override in a genuine emergency ` +
    `(NOT recommended; logged loudly when used, never silent): set HARNESS_ALLOW_INCONSISTENT_INSTALL=1 in the ` +
    `environment the scope agent's Bash tool runs in, then re-run.`
  )
}

// MED-2 (round-one review): the refusal must not be decided SOLELY by the
// "consistent" boolean the scope agent reports -- that is model output, and
// a fabricated {consistent:true} satisfies the schema undetectably. This
// recomputes the comparison IN-PROCESS, against the LITERAL schema object
// this running script already holds (needs no fs, no subprocess, no model),
// using only the model-reported doc_fields/agent_fields as input. It can
// only verify the schema THIS FILE declares (PLAN_SCHEMA here, REVIEW_SCHEMA
// in review-cycle.js): each workflow checks its own running schema, never
// the other file's -- but that is exactly the schema that matters most for
// THIS session, and it needs no disk read of plan-cycle.js/review-cycle.js
// at all, which also closes MED-3 for the schema half of the preflight (the
// running object IS "the copy that actually executes"; a stale ~/.claude
// snapshot loaded at session start cannot diverge from itself).
//
// AC-QA-2 amendment: returns `certain` alongside `ok`, splitting "nothing
// was reported to check" (uncertain -- doc_fields/agent_fields both empty,
// H2's own bucket) from "a reported field is genuinely absent from the
// running schema" (certain -- the one case that may still refuse).
function crossCheckAgainstOwnSchema(consistency, ownSchema, ownSchemaName) {
  const c = consistency || {}
  const docFields = Array.isArray(c.doc_fields) ? c.doc_fields : []
  const agentFields = Array.isArray(c.agent_fields) ? c.agent_fields : []
  const reported = [...new Set([...docFields, ...agentFields])]
  if (reported.length === 0) {
    return {
      ok: false,
      certain: false,
      reason: 'doc_fields and agent_fields were both empty (or absent) in the reported consistency object -- nothing to cross-check against the running schema, treated as uncertainty, never as proof of a mismatch',
    }
  }
  const ownProps = new Set(Object.keys(ownSchema.properties.findings.items.properties))
  const missingFromOwnSchema = reported.filter((f) => !ownProps.has(f))
  if (missingFromOwnSchema.length) {
    return {
      ok: false,
      certain: true,
      reason: `field(s) reported as instructed (${JSON.stringify(missingFromOwnSchema)}) are absent from the RUNNING ${ownSchemaName} object in THIS process -- a fabricated or stale "consistent:true" cannot hide this, because it is recomputed here, never trusted from the report`,
    }
  }
  return { ok: true, certain: true, reason: null }
}

// AC-QA-2 (amended): the single decision point for refuse/warn/proceed.
// Returns { action, message }: 'refuse' (halt -- PROVEN, certain), 'warn'
// (proceed, log loudly -- uncertainty in either direction, or a DELIBERATE
// escape-hatch override of a proven mismatch), or 'proceed' (silent,
// AC-QA-3, the pinned call sequence -- no field of this decision may add an
// agent() dispatch).
function evaluateInstallConsistency(consistency, ownSchema, ownSchemaName) {
  if (!consistency) {
    return { action: 'warn', message: 'the scope agent returned no "consistency" field at all -- proceeding without verification (uncertain, not halted; AC-QA-2 amendment)' }
  }
  const c = consistency
  // M3: a self-contradictory report (claims BOTH clean and broken) needs no
  // external parsing to detect -- it is a fact about the report's OWN
  // structure, so (unlike blind/ok:false) it is treated as PROVEN, not
  // merely uncertain, and refuses like a genuine cross-check failure.
  const contradictionFields = [
    ...(Array.isArray(c.missing_in_review_schema) ? c.missing_in_review_schema : []),
    ...(Array.isArray(c.missing_in_plan_schema) ? c.missing_in_plan_schema : []),
    ...(Array.isArray(c.review_only_props) ? c.review_only_props : []),
    ...(Array.isArray(c.plan_only_props) ? c.plan_only_props : []),
  ]
  const contradictory = c.consistent === true && (c.blind === true || contradictionFields.length > 0)
  if (contradictory) {
    const reason = `the consistency report is self-contradictory (consistent:true alongside blind:${c.blind === true} and mismatch field(s) ${JSON.stringify(contradictionFields)}) -- a report that disagrees with itself cannot be trusted either way`
    if (c.escape_hatch_active === true) {
      return { action: 'warn', message: `PROVEN self-contradiction (${reason}), but HARNESS_ALLOW_INCONSISTENT_INSTALL=1 is set -- proceeding anyway. This is a deliberate override; lens output this session may be built against a broken or misreported schema.` }
    }
    return { action: 'refuse', message: reason }
  }
  if (c.blind === true) {
    return { action: 'warn', message: `install-consistency reported blind (nothing could be compared): ${c.error || 'no reason given'} -- proceeding (uncertain, not halted; AC-QA-2 amendment)` }
  }
  if (c.ok === false) {
    return { action: 'warn', message: `install-consistency could not run: ${c.error || 'no reason given'} -- proceeding (uncertain, not halted; AC-QA-2 amendment)` }
  }
  const crossCheck = crossCheckAgainstOwnSchema(c, ownSchema, ownSchemaName)
  if (!crossCheck.ok && crossCheck.certain) {
    if (c.escape_hatch_active === true) {
      return { action: 'warn', message: `PROVEN mismatch (${crossCheck.reason}), but HARNESS_ALLOW_INCONSISTENT_INSTALL=1 is set -- proceeding anyway. This is a deliberate override; lens output this session may be built against a broken schema.` }
    }
    return { action: 'refuse', message: crossCheck.reason }
  }
  if (!crossCheck.ok && !crossCheck.certain) {
    return { action: 'warn', message: `${crossCheck.reason} -- proceeding (uncertain, not halted; AC-QA-2 amendment)` }
  }
  if (c.consistent !== true) {
    return {
      action: 'warn',
      message:
        `install-consistency's own (prose-derived) verdict reported a possible mismatch, but the in-process ` +
        `cross-check against the running ${ownSchemaName} found no proof of one -- proceeding (uncertain, not ` +
        `halted; AC-QA-2 amendment). Reported: missing_in_review_schema=${JSON.stringify(c.missing_in_review_schema || [])}, ` +
        `missing_in_plan_schema=${JSON.stringify(c.missing_in_plan_schema || [])}, review_only_props=${JSON.stringify(c.review_only_props || [])}, ` +
        `plan_only_props=${JSON.stringify(c.plan_only_props || [])}`,
    }
  }
  return { action: 'proceed', message: null }
}
// ---- end HARN-FIX-3 install-consistency preflight block ----

// Moved to module scope (from its previous position inside run(), just
// before Phase 2) so the MED-2 cross-check above can read it before the
// AC-QA-1/AC-QA-2 gate runs, without needing a disk read of this file's own
// text (MED-3) -- the literal object IS what this session executes.
const PLAN_SCHEMA = {
  type: 'object',
  required: ['verdict', 'coverage', 'acceptance_criteria'],
  properties: {
    verdict: { type: 'string', enum: ['CLEAN', 'FINDINGS', 'BLOCKED'] },
    coverage: {
      type: 'object',
      required: ['examined', 'verified_by', 'could_not_check'],
      properties: { examined: { type: 'string' }, verified_by: { type: 'string' }, could_not_check: { type: 'string' } },
    },
    acceptance_criteria: { type: 'array', items: { type: 'object', required: ['id', 'statement'], properties: { id: { type: 'string' }, statement: { type: 'string' }, proof_level: { type: 'string' } } } },
    // H3: recurrence was instructed in AGENT-HARNESS.md's FINDINGS template
    // and in all nine agents/lens-*.md files (including lens-simplicity's
    // veto write-up, planning-only) with no matching property here -- see
    // the identical comment and the drift guard test in review-cycle.js.
    findings: { type: 'array', items: { type: 'object', required: ['severity', 'claim', 'evidence', 'consequence', 'fix'], properties: { severity: { type: 'string', enum: ['Critical', 'High', 'Medium', 'Low'] }, claim: { type: 'string' }, location: { type: 'string' }, evidence: { type: 'string' }, consequence: { type: 'string' }, fix: { type: 'string' }, recurrence: { type: ['string', 'null'] } } } },
  },
}

// args can arrive as a JSON-encoded string depending on the caller; normalise before use
let opts = args
if (typeof opts === 'string') { try { opts = JSON.parse(opts) } catch (e) { opts = null } }
opts = opts || {}
if (typeof opts !== 'object' || !opts.spec) throw new Error('plan-cycle requires args.spec: the path to the spec file to plan against')
const specPath = opts.spec

// Review round-2 L-1: `lenses` (the triggered roster) is local to run(), so
// on a throw AFTER the lenses already ran (e.g. synthesis:write-back
// crashing), the outer telemetry code falls back to result.lenses --
// undefined, because run() never reached its return -- and reported an
// empty lenses_run even though every lens genuinely ran and reported back.
// Set as soon as lensReports exists, so a late throw still leaves an
// accurate trail (see review-cycle.js for the identical pattern).
let lensesRunRaw = []
// 2026-08-18 (H1): plan-cycle is where the shared-checkout mis-review actually
// happened, and it is the MORE exposed of the two cycles -- its lenses run
// WITHOUT worktree isolation, directly in the shared main checkout, whereas
// review-cycle's have been isolated since 2026-08-07. The drift guard was
// added to review-cycle first, which was already the better-protected one.
// Same asymmetric comparison here: only a REPORTED sha that DIFFERS counts;
// a missing one means "not reported", never "did not move".
let planHeadSha = null
let synthesisHeadSha = null

// ---- Run-ledger helpers, inlined (workflow scripts cannot import: see
// tdd-task.js for the identical pattern and its rationale). ----

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

// ---- Phase 1: scope ----
phase('Scope')
const scope = await agent(
  // specs/harn-fix-3.md AC-QA-1/AC-QA-3: folded into this SAME agent() call
  // rather than a new one, so a consistent install adds no measurable
  // startup delay -- see INSTALL_CONSISTENCY_INSTRUCTION below.
  INSTALL_CONSISTENCY_INSTRUCTION +
  `Read the spec at ${specPath} and skim the repo areas it names. Classify the change surface, returning raw booleans:\n` +
  `- ui: does it touch UI, templates, styles, components or user-facing copy?\n` +
  `- data: does it touch schema, migrations, destructive file or database operations, or personal data?\n` +
  `- architecture: does it add a module, package, dependency, service boundary, or touch the app's core wiring (event bus, plugin loader, API layer, dependency manifests)?\n` +
  `- operability: does it change production behaviour, logging, containers, CI or operational scripts?\n` +
  `- user_facing: will a user see or feel this change?\n` +
  `Also return a two-sentence summary of what the spec asks for, and the list of repo paths it will most likely touch.\n` +
  `Finally, run \`git rev-parse HEAD\` and return its exact output as head_sha.`,
  {
    label: 'scope:spec',
    phase: 'Scope',
    effort: 'low',
    schema: {
      type: 'object',
      required: ['summary', 'ui', 'data', 'architecture', 'operability', 'user_facing', 'likely_paths', 'head_sha', 'consistency'],
      properties: {
        head_sha: { type: 'string' },
        summary: { type: 'string' },
        ui: { type: 'boolean' },
        data: { type: 'boolean' },
        architecture: { type: 'boolean' },
        operability: { type: 'boolean' },
        user_facing: { type: 'boolean' },
        likely_paths: { type: 'array', items: { type: 'string' } },
        consistency: INSTALL_CONSISTENCY_SCHEMA,
      },
    },
  }
)
if (!scope) return { report: 'Scope agent failed; no plan produced.', __outcome: 'aborted' }
planHeadSha = typeof scope.head_sha === 'string' ? scope.head_sha : null

// AC-QA-1/AC-QA-2 (amended, round-two review): refuse ONLY on a PROVEN
// mismatch (evaluateInstallConsistency's 'refuse' action); everything
// uncertain warns and proceeds. See the install-consistency preflight
// block above for the reasoning and evaluateInstallConsistency() itself.
const planEval = evaluateInstallConsistency(scope.consistency, PLAN_SCHEMA, 'PLAN_SCHEMA')
if (planEval.action === 'refuse') {
  throw installConsistencyError(planEval.message)
}
if (planEval.action === 'warn') {
  log(`WARNING (install-consistency preflight, AC-QA-2 amendment): ${redactLogText(planEval.message)}`)
}

// ---- deterministic lens triggering (AGENT-HARNESS.md roster; simplicity is planning-only and always on) ----
let lenses = ['lens-security', 'lens-qa', 'lens-simplicity', 'lens-product']
if (scope.ui) lenses.push('lens-design', 'lens-accessibility')
if (scope.data) lenses.push('lens-data')
if (scope.architecture) lenses.push('lens-architecture')
if (scope.operability) lenses.push('lens-operability')
// An override ADDS to the mandatory roster, it does not replace it. At
// planning the always-on set includes lens-simplicity, which holds the veto:
// the only counterweight to specialists adding requirements none remove.
const MANDATORY = ['lens-security', 'lens-qa', 'lens-simplicity']
if (Array.isArray(opts.lenses) && opts.lenses.length) {
  lenses = [...new Set([...MANDATORY, ...opts.lenses])]
}

const ALL = ['lens-security', 'lens-qa', 'lens-simplicity', 'lens-product', 'lens-design', 'lens-accessibility', 'lens-data', 'lens-architecture', 'lens-operability']
const skipped = ALL.filter(l => !lenses.includes(l))
log(`Planning ${specPath}: ${scope.summary} Lenses: ${lenses.join(', ')}. Skipped (not triggered): ${skipped.join(', ') || 'none'}.`)

// ---- Phase 2: lenses in parallel (planning is read-only, no isolation needed) ----

const lensPrompt = (lens) =>
  `PLANNING mode. The spec is at ${specPath}. Likely touched paths: ${scope.likely_paths.join(', ') || 'unknown'}.\n` +
  `Read the spec and the relevant code, then produce your lens's numbered acceptance criteria as AC-<LENS>-<n> ` +
  `(e.g. AC-SEC-1, AC-QA-1, AC-SIMP-1: use your lens's short code). Each statement must be testable: a thing that can be ` +
  `shown true or false against the built change. Do not write criteria for another lens's concern.\n` +
  `Do NOT modify any file, including the spec: the synthesis step writes the criteria in. Return them via the structured ` +
  `output schema, with your coverage statement (could_not_check is mandatory and must be honest). Findings here are ` +
  `problems with the SPEC itself (missing decisions, untestable asks, scope risks).\n\n` +
  `Before you run or invoke workflows/lib/ledger-append.mjs for ANY reason (a mutation experiment, a manual probe, ` +
  `reading its behaviour), prefix the variable onto that same command line: ` +
  `\`HARNESS_LEDGER_READONLY=1 node <path-to>/ledger-append.mjs ...\`. It MUST be on the one command line that runs ` +
  `node. Do NOT set it with a separate \`export\` in an earlier command: this runtime does not persist shell state ` +
  `between tool calls, so an export dies with the call that made it and the guard would never be armed. That script ` +
  `resolves the operator's real, main-checkout ledger regardless of which worktree invokes it (AC-DATA-1), so without ` +
  `this it is not a test double, it is the live ledger. You are read-only: never write to the harness's own ledger.`

const reports = await parallel(lenses.map(lens => () =>
  agent(lensPrompt(lens), { agentType: lens, label: lens, phase: 'Lenses', schema: PLAN_SCHEMA })
    .then(r => (r ? { lens, ...r } : null))
))
const lensReports = reports.filter(Boolean)
if (!lensReports.length) return { report: 'Every lens agent failed or was stopped; no plan produced.', __outcome: 'aborted' }
lensesRunRaw = lensReports.map(r => r.lens)

// ---- Phase 3: synthesis, simplicity veto, write-back ----
phase('Synthesis')
const synthesis = await agent(
  `You are the orchestrator of the multi-lens planning harness defined in AGENT-HARNESS.md (find and read it: check ` +
  `~/.claude/AGENT-HARNESS.md, the repo root, and any installed claude-ai-harness plugin directory). ` +
  `Below are the structured planning reports for the spec at ${specPath}.\n\n` +
  `LENS REPORTS (JSON):\n${JSON.stringify(lensReports, null, 1)}\n\n` +
  `Do the following, in order:\n` +
  `1. Apply the simplicity veto: lens-simplicity may reject any criterion or requirement not traceable to the spec's ` +
  `stated goal. A vetoed criterion is DROPPED and recorded, unless it belongs to security, data-loss or the accessibility ` +
  `floor, which simplicity cannot override. Record every veto with its reason.\n` +
  `2. Merge the surviving criteria, deduplicating overlaps (keep the more testable wording; keep both IDs in a note).\n` +
  `3. Edit the spec file at ${specPath}: add or replace a section titled "## Acceptance criteria" containing the surviving ` +
  `AC-<LENS>-<n> lines grouped by lens, each on one line, exactly as the review cycle will verify them. Preserve the rest ` +
  `of the file byte-for-byte. Also add a "### Vetoed at planning" subsection listing the drops and reasons, if any.\n` +
  `FORMAT, NOT A SUGGESTION: write each criterion as \`- **AC-<LENS>-<n>:** <criterion>\` -- list marker, bolded id, ` +
  `COLON INSIDE the bold, one space, then the text. test/static-checks.test.js scans specs for exactly this shape (and ` +
  `two older spellings) to enforce id uniqueness, and a spec written in a fourth spelling fails the pre-push gate as ` +
  `unreadable rather than passing silently. Do not invent a variant such as \`**AC-X-1** -- text\`.\n` +
  `4. Return a markdown summary: a per-lens table (verdict, criteria count, could_not_check), the veto list, any lens ` +
  `findings about the spec itself (BLOCKED lenses prominently), and the final AC count.\n` +
  `Return only the markdown summary as "summary".\n` +
  `Also run \`git rev-parse HEAD\` in the repo NOW, at write-back time, and return its exact output as ` +
  `head_sha_at_synthesis. Several agent sessions share these checkouts: planning lenses here run WITHOUT worktree ` +
  `isolation, directly in the shared main checkout, so if another session switches branches mid-run these criteria ` +
  `would be written about a different tree than the spec names. Report what git says now, even if it differs.`,
  { label: 'synthesis:write-back', phase: 'Synthesis',
    schema: { type: 'object', required: ['summary'], properties: {
      summary: { type: 'string' },
      head_sha_at_synthesis: { type: ['string', 'null'] },
    } } }
)

// M1: outcome was computed purely from lens verdicts, so a run whose
// synthesis:write-back agent failed or returned nothing usable (undefined,
// or an empty/non-string summary) was still recorded as "done" -- see
// review-cycle.js for the identical fix and its rationale.
// Adding a schema to synthesis:write-back turned its result from a bare string
// into an object, so consumers read .summary. Deliberately NOT tolerant of both
// shapes: a fallback accepting a bare string would keep working if the schema
// were later dropped, which is exactly how head_sha_at_synthesis would go
// missing with nothing failing.
synthesisHeadSha = synthesis && typeof synthesis.head_sha_at_synthesis === 'string' ? synthesis.head_sha_at_synthesis : null
const reportOk = synthesis && typeof synthesis.summary === 'string' && synthesis.summary.length > 0
const outcome = !reportOk ? 'aborted' : lensReports.some(r => r.verdict === 'BLOCKED') ? 'blocked' : 'done'

return {
  spec: specPath,
  lenses,
  skipped,
  verdicts: Object.fromEntries(lensReports.map(r => [r.lens, r.verdict])),
  report: reportOk ? synthesis.summary : '',
  __outcome: outcome,
}

} // end run()

// Start/terminal record protocol (AC-DATA-5): see tdd-task.js for the same
// pattern and its rationale.
const startWrite = await writeLedger({ kind: 'plan_cycle', outcome: 'started', spec: specPath })
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
const { __outcome, ...result } = raw
const telemetry = {
  outcome: __outcome || 'aborted',
  spec: specPath,
  lenses_run: result.lenses || lensesRunRaw,
  lenses_skipped: result.skipped || [],
  verdicts: result.verdicts || {},
  budget_spent: readBudgetSpent(),
}
const terminalEntry = { kind: 'plan_cycle', ...telemetry }
if (startRunId) terminalEntry.run_id = startRunId
const terminalWrite = await writeLedger(terminalEntry)

// 2026-08-18: give write_ok:false a CONSUMER. It was already computed,
// already logged and already returned -- to nobody. The ledger stopped
// recording on 2026-08-12 (ledgerWritePrompt called Buffer.from, and Buffer
// does not exist in this runtime) and nothing noticed for six days across
// three merged PRs, because a log line in a transcript is not a consumer.
//
// AC-QA-7 says a ledger write failure must never FAIL the run, and that
// stands: this reports, it does not throw. What AC-QA-7 does not say is that
// the failure may be indistinguishable from success. Surfaced on the return
// value so the caller -- a conductor, or a human reading the result -- can
// tell that this run produced no telemetry, on the FIRST run rather than the
// sixth day.
// 2026-08-18 (H1): did the tree move under this PLANNING run? Asymmetric, the
// same way review-cycle's is: only a REPORTED sha that DIFFERS counts. A
// missing sha means the agent did not answer, which is not evidence of
// stability. This matters more here than in review-cycle, because planning
// lenses run WITHOUT worktree isolation in the shared main checkout.
const checkoutMoved = Boolean(planHeadSha && synthesisHeadSha && synthesisHeadSha !== planHeadSha)
if (checkoutMoved) {
  result.checkout_moved = true
  result.checkout_moved_detail = `scoped at ${planHeadSha}, synthesis found ${synthesisHeadSha} -- the working tree moved mid-plan, so these acceptance criteria may describe a different tree than the spec names. Re-run once the checkout is stable.`
  log(`CHECKOUT MOVED MID-PLAN: scoped ${planHeadSha}, synthesis ${synthesisHeadSha}. Another session may share this checkout. Treat these criteria as unverified until re-run.`)
}
const ledgerFailed = !startWrite.write_ok || !terminalWrite.write_ok
if (ledgerFailed) {
  // Assigned onto `result` rather than branching the final return, so the
  // `if (threw) throw runError` / `return { ...result, telemetry }` pair stays
  // byte-identical across all three workflows (AC-ARCH-9).
  result.ledger_write_failed = true
  result.ledger_write_error = startWrite.write_error || terminalWrite.write_error || 'unknown'
  const why = startWrite.write_error || terminalWrite.write_error || 'unknown'
  log(`TELEMETRY NOT RECORDED for this run: ${redactLogText(String(why))}. The run itself is unaffected, but this run leaves no telemetry, and a ledger with gaps reads as "uninstrumented" rather than "broken".`)
}
if (threw) throw runError
return { ...result, telemetry }
