export const meta = {
  name: 'review-cycle',
  description: 'Multi-lens review of the branch diff per AGENT-HARNESS.md: single-focus lenses in parallel, one synthesised report',
  whenToUse: 'Before raising a PR, or as the local review gate on a branch. Args: {base?: string (default: the default branch), spec?: string, lenses?: string[] (override triggering), adversarial?: boolean (adds reviewer-verification)}',
  phases: [
    { title: 'Scope', detail: 'diff the branch, classify the change surface' },
    { title: 'Lenses', detail: 'triggered lenses review in parallel, isolated worktrees' },
    { title: 'Synthesis', detail: 'dedup, arbitrate by precedence, one report' },
  ],
}

// ---- default trigger globs; a repo overrides them with .claude/harness-triggers.json ----
// Shape of the override file: {"ui": [globs], "data": [globs], "architecture": [globs], "operability": [globs]}
const DEFAULT_RULES = {
  ui: ['**/*.html', '**/*.css', '**/*.scss', '**/*.vue', '**/*.svelte', '**/*.jsx', '**/*.tsx', '**/templates/**', '**/static/**', '**/ui/**', '**/components/**', '**/e2e/**'],
  data: ['**/migrations/**', '**/*schema*', '**/db/**', '**/models/**', '**/*.sql'],
  architecture: ['package.json', 'requirements*.txt', 'pyproject.toml', 'go.mod', 'Cargo.toml', 'Gemfile', 'composer.json', '**/settings.gradle*'],
  operability: ['Dockerfile*', 'docker-*.yml', 'compose*.yml', '.github/workflows/**', 'scripts/**', 'Procfile', 'helm/**', 'terraform/**', '**/*logging*', '**/*logger*'],
}

function globToRe(g) {
  let s = g.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  s = s.replace(/\*\*/g, '\u0001').replace(/\*/g, '[^/]*').replace(/\u0001/g, '.*')
  return new RegExp('^' + s + '$')
}
function matches(paths, globs) {
  const res = (globs || []).map(globToRe)
  return paths.filter(p => res.some(r => r.test(p)))
}

// args can arrive as a JSON-encoded string depending on the caller; normalise before use
let opts = args
if (typeof opts === 'string') { try { opts = JSON.parse(opts) } catch (e) { opts = null } }
opts = opts || {}

const specPath = opts.spec || null

// Ledger telemetry accumulators, populated inside run() as each value
// becomes available, read after run() resolves. Never part of the
// pre-existing, publicly-documented return shape (AC-ARCH-10).
const triggerCounts = {}
let headSha = null
// Raw finding descriptors ({lens, location, claim, severity?, ac_id?}), or
// null when the synthesis response was malformed. Passed to
// ledger-append.mjs as opaque data: workflow scripts have no node:crypto,
// so finding-id hashing (AC-QA-11) happens there, not here.
let specBugsRaw = null
let rejectedFindingsRaw = null
let specBugCount = null
let rejectedFindingCount = null

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
// The script locates ledger-append.mjs itself (repo checkout first, then
// the global mirror) and owns everything about the schema, path
// resolution and the atomic append.
function ledgerWritePrompt(payload) {
  const payloadBase64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')
  return (
    `Append one line to the harness run ledger. Never let this step fail the caller's run: catch every error ` +
    `yourself and report it in your structured output instead of throwing or retrying.\n\n` +
    `1. Find this harness's ledger-append.mjs script: check "$(git rev-parse --show-toplevel)/workflows/lib/ledger-append.mjs" ` +
    `in the current repo, then ~/.claude/workflows/lib/ledger-append.mjs (the global mirror install), then any ` +
    `installed claude-ai-harness plugin directory.\n` +
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
  `In the repo at the current working directory:\n` +
  `1. Determine the base ref: ${opts.base ? `use "${opts.base}".` : 'the repository default branch (usually main or master; check `git remote show origin` or local branch names).'}\n` +
  `2. Run \`git diff --name-status <base>...HEAD\` and return every changed file path with its status letter, plus the base ref you used and the exact output of \`git rev-parse HEAD\` as head_sha.\n` +
  `3. Report whether any dependency manifest (package.json, requirements*.txt, pyproject.toml, go.mod, Cargo.toml, Gemfile, or equivalent) gained a NEW entry (a new package, not a version bump), and whether the diff ADDS a new module or package (a new source file outside tests, or a new package directory).\n` +
  `4. If a file .claude/harness-triggers.json exists at the repo root, return its parsed JSON as custom_rules; otherwise null.\n` +
  `Raw data only.`,
  {
    label: 'scope:diff',
    phase: 'Scope',
    effort: 'low',
    schema: {
      type: 'object',
      required: ['base', 'head_sha', 'files', 'new_dependency_entries', 'new_modules'],
      properties: {
        base: { type: 'string' },
        head_sha: { type: 'string' },
        files: { type: 'array', items: { type: 'object', required: ['path', 'status'], properties: { path: { type: 'string' }, status: { type: 'string' } } } },
        new_dependency_entries: { type: 'boolean' },
        new_modules: { type: 'boolean' },
        custom_rules: { type: ['object', 'null'] },
      },
    },
  }
)
if (!scope || !scope.files.length) return { report: 'No changes found between the base ref and HEAD. Nothing to review.', __outcome: 'no-op' }

headSha = scope.head_sha

const base = scope.base
const rules = Object.assign({}, DEFAULT_RULES, scope.custom_rules || {})
const paths = scope.files.map(f => f.path)

// ---- deterministic lens triggering (AGENT-HARNESS.md roster) ----
let lenses = ['lens-security', 'lens-qa'] // always on at review
const uiHit = matches(paths, rules.ui)
// Deletions included deliberately: removing a schema, adapter or migration is
// at least as destructive as modifying one.
const dataHit = matches(paths, rules.data)
const archHit = matches(paths, rules.architecture)
const opsHit = matches(paths, rules.operability)
const specHit = matches(paths, ['specs/**'])
triggerCounts.ui = uiHit.length
triggerCounts.data = dataHit.length
triggerCounts.architecture = archHit.length
triggerCounts.operability = opsHit.length
triggerCounts.product = specHit.length

if (uiHit.length) lenses.push('lens-design', 'lens-accessibility')
if (dataHit.length) lenses.push('lens-data')
if (archHit.length || scope.new_modules || scope.new_dependency_entries) lenses.push('lens-architecture')
if (opsHit.length) lenses.push('lens-operability')
// specPath too: a caller can supply an existing, unchanged spec for a
// user-facing backend change that touches neither a spec file nor a UI glob.
if (specHit.length || uiHit.length || specPath) lenses.push('lens-product')

// An override ADDS to the mandatory roster, it does not replace it: the
// always-on lenses cannot be silently dropped by {lenses: [...]}.
const MANDATORY = ['lens-security', 'lens-qa']
if (Array.isArray(opts.lenses) && opts.lenses.length) {
  lenses = [...new Set([...MANDATORY, ...opts.lenses])]
}
if (opts.adversarial) lenses.push('reviewer-verification')

const ALL = ['lens-security', 'lens-qa', 'lens-design', 'lens-accessibility', 'lens-data', 'lens-architecture', 'lens-operability', 'lens-product']
const skipped = ALL.filter(l => !lenses.includes(l))
log(`Reviewing ${paths.length} changed files against ${base} at ${scope.head_sha.slice(0, 8)}. Lenses: ${lenses.join(', ')}. Skipped (not triggered): ${skipped.join(', ') || 'none'}.`)

// ---- Phase 2: lenses in parallel, each in its own worktree ----
const REVIEW_SCHEMA = {
  type: 'object',
  required: ['verdict', 'coverage', 'findings'],
  properties: {
    verdict: { type: 'string', enum: ['CLEAN', 'FINDINGS', 'BLOCKED'] },
    coverage: {
      type: 'object',
      required: ['examined', 'verified_by', 'could_not_check'],
      properties: { examined: { type: 'string' }, verified_by: { type: 'string' }, could_not_check: { type: 'string' } },
    },
    ac_verdicts: { type: 'array', items: { type: 'object', required: ['id', 'verdict', 'evidence'], properties: { id: { type: 'string' }, verdict: { type: 'string', enum: ['PASS', 'FAIL', 'UNVERIFIABLE'] }, evidence: { type: 'string' } } } },
    findings: { type: 'array', items: { type: 'object', required: ['severity', 'claim', 'location', 'evidence', 'consequence', 'fix'], properties: { severity: { type: 'string', enum: ['Critical', 'High', 'Medium', 'Low'] }, claim: { type: 'string' }, location: { type: 'string' }, evidence: { type: 'string' }, consequence: { type: 'string' }, fix: { type: 'string' } } } },
  },
}

const fileList = paths.slice(0, 120).join('\n')
const specClause = specPath
  ? `The spec for this change is at ${specPath}. Verify each of YOUR lens's AC-<LENS>-<n> criteria against the built change and return ac_verdicts for them. Also report anything you find outside them.`
  : `No spec path was supplied. Check specs/ (including specs files inside this diff) for a spec covering this change; ` +
    `if one exists, verify YOUR lens's AC-<LENS>-<n> criteria from it and return ac_verdicts. Only if none exists, review ` +
    `against your lens rubric alone, return an empty ac_verdicts array, and record the absent spec in could_not_check.`

const qaBudget =
  `Bound your mutation experiments: run at most 8, chosen for the highest-risk guards in the diff (destructive paths, ` +
  `security gates, concurrency locks first). List every guard you deliberately did not mutate in could_not_check; ` +
  `an honest skip list beats an unbounded run.\n`

const lensPrompt = (lens) =>
  `REVIEW mode. The reviewed tip is commit ${scope.head_sha}. First run \`git rev-parse HEAD\` in your worktree; if it ` +
  `differs, your checkout has drifted from the reviewed tip (a parallel session may have advanced the branch): diff ` +
  `against the pinned SHA explicitly and record the drift in could_not_check. Review \`git diff ${base}...${scope.head_sha}\`.\n` +
  `Changed files (${paths.length} total):\n${fileList}\n\n` +
  `${specClause}\n\n` +
  (lens === 'lens-qa' ? qaBudget : '') +
  `You are in an isolated git worktree: mutation experiments (break the guard, watch the test fail, restore) are safe here. ` +
  `The worktree will not contain uncommitted tooling from the main checkout (virtualenvs, node_modules); if you need the ` +
  `project's interpreter or test runner, invoke the main checkout's copy by absolute path (locate the main checkout ` +
  `with \`cd "$(git rev-parse --git-common-dir)/.." && pwd\`), and never modify anything under the main checkout.\n\n` +
  `Your final structured output maps the AGENT-HARNESS.md output contract onto the schema fields: verdict, coverage ` +
  `(could_not_check is mandatory and must be honest, not "nothing"), ac_verdicts, findings (each with file:line in location). ` +
  `You are licensed to return CLEAN with empty findings.`

const reports = await parallel(lenses.map(lens => () =>
  agent(lensPrompt(lens), { agentType: lens, label: lens, phase: 'Lenses', schema: REVIEW_SCHEMA, isolation: 'worktree' })
    .then(r => (r ? { lens, ...r } : null))
))
const lensReports = reports.filter(Boolean)
if (!lensReports.length) return { report: 'Every lens agent failed or was stopped; no review produced.', __outcome: 'aborted' }

// AC-SIMP constraints are mechanical: checked directly against the diff, not by an agent lens (harness rule)
let simpCheck = null
if (specPath) {
  simpCheck = await agent(
    `Read ${specPath}. If it contains AC-SIMP-<n> acceptance criteria, check each one mechanically against ` +
    `\`git diff ${base}...${scope.head_sha}\` (they are constraints like "no new dependency", "no new setting", "no abstraction for a single call site"). ` +
    `Return one verdict per AC-SIMP with the diff evidence. If the spec has none, say so. Raw data only.`,
    { label: 'ac-simp:mechanical', phase: 'Lenses', effort: 'low' }
  )
}

// ---- Phase 3: synthesis ----
phase('Synthesis')
const synthesis = await agent(
  `You are the orchestrator of the multi-lens review harness defined in AGENT-HARNESS.md (find and read it: check ` +
  `~/.claude/AGENT-HARNESS.md, the repo root, and any installed claude-ai-harness plugin directory). ` +
  `Below are the structured reports from each lens for the branch diff against ${base}.\n\n` +
  `LENS REPORTS (JSON):\n${JSON.stringify(lensReports, null, 1)}\n\n` +
  (simpCheck ? `AC-SIMP MECHANICAL CHECK:\n${simpCheck}\n\n` : '') +
  `Produce the single synthesised review report, in markdown:\n` +
  `1. A verdict table: one row per lens with its verdict and its "could not check" statement.\n` +
  `2. Findings merged and deduplicated (same defect from two lenses is one finding credited to both), ordered by severity ` +
  `(Critical, High, Medium, Low). Keep each finding's location, evidence, consequence and fix.\n` +
  `3. Conflicts between lenses arbitrated by the precedence order: irrecoverable data loss, security, accessibility floor, ` +
  `operability, product and design intent, performance. A tie ABOVE the accessibility line is marked ESCALATE for the human, ` +
  `never resolved silently.\n` +
  `4. ${specPath ? 'AC verdict summary, and any finding with no AC behind it flagged as a SPEC BUG.' : 'AC verdict summary if the lenses found a spec; otherwise note that no spec existed, so every finding is unanchored to an AC.'}\n` +
  `5. A closing line: overall CLEAN / FINDINGS / BLOCKED and what must happen before push.\n` +
  `Do not soften findings and do not invent any. If a lens returned BLOCKED, say so prominently. ` +
  `Also return spec_bugs (findings with no AC behind them) and rejected_findings (findings investigated and shown to be ` +
  `false alarms) as structured arrays, each item carrying lens, location and claim, so capture is mechanical rather than ` +
  `left in the prose. Return only the markdown report as "report".`,
  {
    label: 'synthesis',
    phase: 'Synthesis',
    schema: {
      type: 'object',
      required: ['report', 'spec_bugs', 'rejected_findings'],
      properties: {
        report: { type: 'string' },
        spec_bugs: { type: 'array', items: { type: 'object', required: ['lens', 'location', 'claim'], properties: { lens: { type: 'string' }, location: { type: 'string' }, claim: { type: 'string' }, ac_id: { type: ['string', 'null'] } } } },
        rejected_findings: { type: 'array', items: { type: 'object', required: ['lens', 'location', 'claim'], properties: { lens: { type: 'string' }, location: { type: 'string' }, claim: { type: 'string' }, ac_id: { type: ['string', 'null'] } } } },
      },
    },
  }
)

// A synthesis response missing the required structured fields (e.g. an
// older or misbehaving agent that only returned prose) must not silently
// masquerade as "zero spec bugs, zero rejected findings": null means
// unmeasured, distinguishable from a genuine zero (AC-QA-13, AC-OPS-3).
// The raw descriptor arrays (not finding ids: no node:crypto here) are
// carried through to the ledger payload, where ledger-append.mjs computes
// ids and dispositions (AC-QA-11 -- mechanical, just in real-Node script
// code instead of a sandboxed one).
specBugsRaw = synthesis && Array.isArray(synthesis.spec_bugs) ? synthesis.spec_bugs : null
rejectedFindingsRaw = synthesis && Array.isArray(synthesis.rejected_findings) ? synthesis.rejected_findings : null
specBugCount = specBugsRaw ? specBugsRaw.length : null
rejectedFindingCount = rejectedFindingsRaw ? rejectedFindingsRaw.length : null

const outcome = lensReports.some(r => r.verdict === 'BLOCKED') ? 'blocked' : 'done'

return {
  base,
  head: scope.head_sha,
  lenses,
  skipped,
  verdicts: Object.fromEntries(lensReports.map(r => [r.lens, r.verdict])),
  report: synthesis && typeof synthesis.report === 'string' ? synthesis.report : '',
  __outcome: outcome,
}

} // end run()

// Start/terminal record protocol (AC-DATA-5): see tdd-task.js for the same
// pattern and its rationale.
const startWrite = await writeLedger({ kind: 'review_cycle', outcome: 'started', spec: specPath })
const startRunId = startWrite.write_ok ? startWrite.run_id : null

const raw = await run()
const { __outcome, ...result } = raw
const telemetry = {
  outcome: __outcome || 'aborted',
  spec: specPath,
  round_key: headSha,
  lenses_run: result.lenses || [],
  lenses_skipped: result.skipped || [],
  trigger_counts: triggerCounts,
  verdicts: result.verdicts || {},
  spec_bug_count: specBugCount,
  rejected_finding_count: rejectedFindingCount,
  budget_spent: readBudgetSpent(),
}
// spec_bugs/rejected_findings ride along as raw descriptors for
// ledger-append.mjs to hash into finding ids; they are NOT part of the
// workflow's own public telemetry (which only carries the counts above).
const terminalEntry = { kind: 'review_cycle', spec_bugs: specBugsRaw, rejected_findings: rejectedFindingsRaw, ...telemetry }
if (startRunId) terminalEntry.run_id = startRunId
await writeLedger(terminalEntry)
return { ...result, telemetry }
