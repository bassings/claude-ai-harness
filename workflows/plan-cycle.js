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

// args can arrive as a JSON-encoded string depending on the caller; normalise before use
let opts = args
if (typeof opts === 'string') { try { opts = JSON.parse(opts) } catch (e) { opts = null } }
opts = opts || {}
if (typeof opts !== 'object' || !opts.spec) throw new Error('plan-cycle requires args.spec: the path to the spec file to plan against')
const specPath = opts.spec

// ---- Run-ledger helpers, inlined (workflow scripts cannot import: see
// tdd-task.js for the identical pattern and its rationale). ----

function readBudgetSpent() {
  if (!budget || typeof budget.spent !== 'function') return null
  try {
    const v = budget.spent()
    return typeof v === 'number' && Number.isFinite(v) ? v : null
  } catch (e) {
    return null
  }
}

function ledgerWritePrompt(payload) {
  const payloadJson = JSON.stringify(payload)
  return (
    `Append one line to the harness run ledger. Never let this step fail the caller's run: catch every error ` +
    `yourself and report it in your structured output instead of throwing or retrying.\n\n` +
    `1. Find this harness's ledger-append.mjs script: check "$(git rev-parse --show-toplevel)/workflows/lib/ledger-append.mjs" ` +
    `in the current repo, then ~/.claude/workflows/lib/ledger-append.mjs (the global mirror install), then any ` +
    `installed claude-ai-harness plugin directory.\n` +
    `2. Run it with Node, piping exactly this JSON payload to its stdin (treat the payload as opaque data; do not ` +
    `parse, edit or re-derive any field from it yourself): ${payloadJson}\n` +
    `   e.g. \`printf '%s' '<the JSON above>' | node <path-to-ledger-append.mjs>\`\n` +
    `3. The script always exits 0 and prints one line of JSON: {run_id, ts, write_ok, write_error}. It already ` +
    `handles locating the main checkout, ensuring the ledger stays gitignored, sourcing the timestamp from the ` +
    `system clock, and the single atomic append -- do not attempt any of that yourself, and do not construct the ` +
    `ledger line by hand.\n` +
    `4. If the script could not be found or failed to run at all (rather than reporting write_ok:false itself), ` +
    `treat that the same way: write_ok false, write_error naming what happened.\n\n` +
    `Return only what the script printed: run_id, ts, write_ok, write_error (null when write_ok is true).`
  )
}

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
        },
      },
    })
  } catch (e) {
    response = null
  }
  if (!response || response.write_ok !== true) {
    const reason = (response && response.write_error) || 'ledger agent failed or returned no result'
    const runId = (response && response.run_id) || 'unknown'
    log(`Ledger write failed for run ${runId}: ${reason}`)
    return { write_ok: false, write_error: reason, run_id: runId }
  }
  return { write_ok: true, write_error: null, run_id: response.run_id }
}

// The entire pre-existing workflow body, unchanged in behaviour, is wrapped
// in run() so every one of its terminating returns funnels through exactly
// ONE ledger write below (AC-ARCH-3), instead of each return needing its own.
async function run() {

// ---- Phase 1: scope ----
phase('Scope')
const scope = await agent(
  `Read the spec at ${specPath} and skim the repo areas it names. Classify the change surface, returning raw booleans:\n` +
  `- ui: does it touch UI, templates, styles, components or user-facing copy?\n` +
  `- data: does it touch schema, migrations, destructive file or database operations, or personal data?\n` +
  `- architecture: does it add a module, package, dependency, service boundary, or touch the app's core wiring (event bus, plugin loader, API layer, dependency manifests)?\n` +
  `- operability: does it change production behaviour, logging, containers, CI or operational scripts?\n` +
  `- user_facing: will a user see or feel this change?\n` +
  `Also return a two-sentence summary of what the spec asks for, and the list of repo paths it will most likely touch.`,
  {
    label: 'scope:spec',
    phase: 'Scope',
    effort: 'low',
    schema: {
      type: 'object',
      required: ['summary', 'ui', 'data', 'architecture', 'operability', 'user_facing', 'likely_paths'],
      properties: {
        summary: { type: 'string' },
        ui: { type: 'boolean' },
        data: { type: 'boolean' },
        architecture: { type: 'boolean' },
        operability: { type: 'boolean' },
        user_facing: { type: 'boolean' },
        likely_paths: { type: 'array', items: { type: 'string' } },
      },
    },
  }
)
if (!scope) return { report: 'Scope agent failed; no plan produced.', __outcome: 'aborted' }

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
    findings: { type: 'array', items: { type: 'object', required: ['severity', 'claim', 'evidence', 'consequence', 'fix'], properties: { severity: { type: 'string', enum: ['Critical', 'High', 'Medium', 'Low'] }, claim: { type: 'string' }, location: { type: 'string' }, evidence: { type: 'string' }, consequence: { type: 'string' }, fix: { type: 'string' } } } },
  },
}

const lensPrompt = (lens) =>
  `PLANNING mode. The spec is at ${specPath}. Likely touched paths: ${scope.likely_paths.join(', ') || 'unknown'}.\n` +
  `Read the spec and the relevant code, then produce your lens's numbered acceptance criteria as AC-<LENS>-<n> ` +
  `(e.g. AC-SEC-1, AC-QA-1, AC-SIMP-1: use your lens's short code). Each statement must be testable: a thing that can be ` +
  `shown true or false against the built change. Do not write criteria for another lens's concern.\n` +
  `Do NOT modify any file, including the spec: the synthesis step writes the criteria in. Return them via the structured ` +
  `output schema, with your coverage statement (could_not_check is mandatory and must be honest). Findings here are ` +
  `problems with the SPEC itself (missing decisions, untestable asks, scope risks).`

const reports = await parallel(lenses.map(lens => () =>
  agent(lensPrompt(lens), { agentType: lens, label: lens, phase: 'Lenses', schema: PLAN_SCHEMA })
    .then(r => (r ? { lens, ...r } : null))
))
const lensReports = reports.filter(Boolean)
if (!lensReports.length) return { report: 'Every lens agent failed or was stopped; no plan produced.', __outcome: 'aborted' }

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
  `4. Return a markdown summary: a per-lens table (verdict, criteria count, could_not_check), the veto list, any lens ` +
  `findings about the spec itself (BLOCKED lenses prominently), and the final AC count.\n` +
  `Return only the markdown summary.`,
  { label: 'synthesis:write-back', phase: 'Synthesis' }
)

return {
  spec: specPath,
  lenses,
  skipped,
  verdicts: Object.fromEntries(lensReports.map(r => [r.lens, r.verdict])),
  report: synthesis,
  __outcome: lensReports.some(r => r.verdict === 'BLOCKED') ? 'blocked' : 'done',
}

} // end run()

// Start/terminal record protocol (AC-DATA-5): see tdd-task.js for the same
// pattern and its rationale.
const startWrite = await writeLedger({ kind: 'plan_cycle', outcome: 'started', spec: specPath })
const startRunId = startWrite.write_ok ? startWrite.run_id : null

const raw = await run()
const { __outcome, ...result } = raw
const telemetry = {
  outcome: __outcome || 'aborted',
  spec: specPath,
  lenses_run: result.lenses || [],
  lenses_skipped: result.skipped || [],
  verdicts: result.verdicts || {},
  budget_spent: readBudgetSpent(),
}
const terminalEntry = { kind: 'plan_cycle', ...telemetry }
if (startRunId) terminalEntry.run_id = startRunId
await writeLedger(terminalEntry)
return { ...result, telemetry }
