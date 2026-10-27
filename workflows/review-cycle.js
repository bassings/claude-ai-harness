export const meta = {
  name: 'review-cycle',
  description: 'Multi-lens review of the branch diff per AGENT-HARNESS.md: single-focus lenses in parallel, one synthesised report',
  whenToUse: 'Before raising a PR, or as the local review gate on a branch. Args: {base?: string (default: the default branch), spec?: string, lenses?: string[] (override triggering), adversarial?: boolean (adds reviewer-verification), allow_inconsistent_install?: boolean (one-run override of a PROVEN install-consistency refusal; named in the log and the report whenever it suppresses one), round?: integer (the review round for this task as counted by the conductor, 1 for the first; recorded on the ledger rows; absent for a direct review), prior_findings?: array (round two onward: findings reported open going into this round, as {id, lens, location, claim, severity?, ac_id?} -- id is REQUIRED and must be the exact value THIS workflow returned as open_findings[].id in an earlier round (verified by recomputing the hash from lens/location/claim; a mismatched or missing id is dropped, counted, and produces no fixed entry) -- a synthesis confirmation matching one gets recorded disposition "fixed" in the ledger, guarded so an unmatched claim is dropped, never recorded; absent, behaviour is unchanged)}',
  phases: [
    { title: 'Scope', detail: 'diff the branch, classify the change surface' },
    { title: 'Lenses', detail: 'triggered lenses review in parallel, isolated worktrees' },
    { title: 'Synthesis', detail: 'dedup, arbitrate by precedence, one report' },
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
//
// ROUND THREE (the override): the escape hatch is an explicit flag on THIS
// invocation's own args -- `allow_inconsistent_install: true` -- read by this
// workflow script directly, never from the environment, never persisted, and
// never relayed through a model.
//
// Round two put it in an environment variable and, because a workflow script
// has no environment access, relayed it here as an escape_hatch_active field on
// the reported consistency object -- through the scope agent, the model whose
// report this gate is checking. A gate whose override is asserted by the thing
// being policed is circular: a fabricating scope agent could claim the hatch
// was active. That is the same bypass class as MED-2, reintroduced by the fix
// for M9, so escape_hatch_active is now ignored wherever it appears and is no
// longer part of the reported schema at all.
//
// It may override a PROVEN mismatch, deliberately. "Proven" here means the
// model's reported field list disagrees with the schema object held in this
// process. If the model OVER-reports a field that is not really instructed, the
// cross-check proves a mismatch that does not exist, and with no override that
// is H1's total lockout returning through a different door. Using it is
// impossible to miss: every suppression is named in the log AND in the returned
// report, and says what was suppressed.
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
  `{ok:false, consistent:false, blind:true, checked_dir:"not found", error:"no install-consistency.mjs found outside the working tree"} ` +
  `as the "consistency" field instead of running anything.\n` +
  `Run it with the install root you found it under as its ONE argument (the parent of the ` +
  `workflows/lib directory it lives in), exactly like: \`node <path-to-install-consistency.mjs> <install-root>\`. ` +
  `It always exits 0 and prints exactly one line of JSON. Return EXACTLY what it printed as the "consistency" ` +
  `field -- do not reinterpret, summarise, or recompute any part of it yourself, and do not skip this step even if ` +
  `you believe you already know the answer: the determination is made by the script, not by you. ` +
  `If the script failed to run at all (rather than printing its own JSON), that is itself a partial or broken ` +
  `install: return {ok:false, consistent:false, blind:true, checked_dir:"not found", error:"<what happened>"} ` +
  `as the "consistency" field yourself -- NEVER omit the field or fabricate {consistent:true, ...} to skip this step.\n\n`

const INSTALL_CONSISTENCY_SCHEMA = {
  type: 'object',
  required: ['ok', 'consistent', 'blind', 'checked_dir', 'doc_fields', 'agent_fields'],
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
    // M1 (round three): a schema that has LOST one of the structural findings
    // properties (severity/claim/location, plus ac_id on the review side).
    // NOT in `required` above, deliberately: an install carrying a
    // pre-round-three install-consistency.mjs cannot emit these, and rejecting
    // its report outright would turn a stale install into a hard stop, which is
    // the H1 lockout shape AC-QA-2 exists to prevent. Absent reads as [].
    missing_structural_in_review_schema: { type: 'array', items: { type: 'string' } },
    missing_structural_in_plan_schema: { type: 'array', items: { type: 'string' } },
    error: { type: ['string', 'null'] },
  },
}

function installConsistencyError(reason) {
  return new Error(
    `InstallInconsistent (AC-QA-2, PROVEN by the in-process cross-check -- not a heuristic, not a false positive): ` +
    `${reason} Refusing to dispatch any lens: an instructed field with no schema slot is silently dropped (H3's own ` +
    `shape). Re-sync the installed copy from the published repo, then re-run. To override in a genuine emergency ` +
    `(NOT recommended; named in the log AND in the run's own report when used, never silent): re-run this cycle with ` +
    `"allow_inconsistent_install": true in its args. It applies to that ONE invocation, is never persisted, and cannot ` +
    `be set by the scope agent -- an escape_hatch_active field in the reported consistency object is ignored.`
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

// The one place the override's wording is built, so the log line and the
// report banner can never say two different things about the same suppression.
// It NAMES the flag and states WHAT was suppressed: an override whose output
// only says "an override was used" leaves the next reader unable to tell
// whether the run's findings are trustworthy.
function overrideMessage(suppressed) {
  return (
    `INSTALL-CONSISTENCY OVERRIDE IN USE: args.allow_inconsistent_install=true SUPPRESSED a refusal that would ` +
    `otherwise have halted this run before dispatching any lens. SUPPRESSED REFUSAL: ${suppressed}. Lens output from ` +
    `this run may have been built against a broken or misreported findings schema, and should be read with that in mind.`
  )
}

// AC-QA-2 (amended): the single decision point for refuse/warn/proceed.
// Returns { action, message, override_used }: 'refuse' (halt -- PROVEN,
// certain), 'warn' (proceed, log loudly -- uncertainty in either direction, or
// a DELIBERATE override of a proven mismatch), or 'proceed' (silent, AC-QA-3,
// the pinned call sequence -- no field of this decision may add an agent()
// dispatch).
//
// `allowInconsistentInstall` is the caller's own args flag, passed in as a
// plain boolean by the ONE call site below. It is never read from the
// environment and never taken from `consistency` (which is model output).
// `override_used` is true only when the flag actually turned a refusal into a
// warning, so the caller can surface that fact in the run's report rather than
// in a log line that scrolls away.
function evaluateInstallConsistency(consistency, ownSchema, ownSchemaName, allowInconsistentInstall) {
  if (!consistency) {
    return { action: 'warn', message: 'the scope agent returned no "consistency" field at all -- proceeding without verification (uncertain, not halted; AC-QA-2 amendment)' }
  }
  const c = consistency
  // M3: a self-contradictory report (claims BOTH clean and broken) needs no
  // external parsing to detect -- it is a fact about the report's OWN
  // structure, so (unlike blind/ok:false) it is treated as PROVEN, not
  // merely uncertain, and refuses like a genuine cross-check failure.
  // M1 (round three): the two structural-loss arrays belong here too. They are
  // the new signal, and without them a fabricated consistent:true paired with a
  // reported lost property would sail through the one check that needs no
  // parsing to catch it.
  const contradictionFields = [
    ...(Array.isArray(c.missing_in_review_schema) ? c.missing_in_review_schema : []),
    ...(Array.isArray(c.missing_in_plan_schema) ? c.missing_in_plan_schema : []),
    ...(Array.isArray(c.review_only_props) ? c.review_only_props : []),
    ...(Array.isArray(c.plan_only_props) ? c.plan_only_props : []),
    ...(Array.isArray(c.missing_structural_in_review_schema) ? c.missing_structural_in_review_schema : []),
    ...(Array.isArray(c.missing_structural_in_plan_schema) ? c.missing_structural_in_plan_schema : []),
  ]
  const contradictory = c.consistent === true && (c.blind === true || contradictionFields.length > 0)
  if (contradictory) {
    const reason = `the consistency report is self-contradictory (consistent:true alongside blind:${c.blind === true} and mismatch field(s) ${JSON.stringify(contradictionFields)}) -- a report that disagrees with itself cannot be trusted either way`
    if (allowInconsistentInstall === true) {
      return { action: 'warn', override_used: true, message: overrideMessage(`PROVEN self-contradiction -- ${reason}`) }
    }
    return { action: 'refuse', message: reason }
  }
  // ROUND FOUR (the ordering bug): the in-process cross-check runs HERE, BEFORE
  // the blind and ok:false branches below, and a `certain` failure refuses
  // first. The previous order returned `warn` for blind at this point, so a
  // failure of the HEURISTIC half switched off the RELIABLE half -- precisely
  // backwards from "certainty refuses, uncertainty warns", and the mechanism
  // ended up holding the proof and declining to use it.
  //
  // Reproduced end to end before the reorder, with the exact partial install
  // this spec exists for: AGENT-HARNESS.md updated to instruct a new `Effort:`
  // field while workflows/review-cycle.js stayed stale enough that its schema
  // const no longer parses. The real CLI printed blind:true with
  // doc_fields:["consequence","effort","evidence","fix","recurrence"], and the
  // gate dispatched every lens against a schema that has no `effort` slot. One
  // unparseable file bought silence for every other field.
  //
  // This is sound because the cross-check needs NOTHING but the reported field
  // list and the literal schema object this process already holds: no
  // filesystem, no subprocess, no parse of anything. Blindness in the script's
  // OTHER half therefore says nothing about this half's certainty. When there
  // is genuinely nothing to cross-check (reported fields empty -- the shape a
  // blind run usually has), crossCheckAgainstOwnSchema returns certain:false
  // and control falls through to the same blind/ok:false warnings as before,
  // unchanged.
  const crossCheck = crossCheckAgainstOwnSchema(c, ownSchema, ownSchemaName)
  if (!crossCheck.ok && crossCheck.certain) {
    if (allowInconsistentInstall === true) {
      return { action: 'warn', override_used: true, message: overrideMessage(`PROVEN mismatch -- ${crossCheck.reason}`) }
    }
    return { action: 'refuse', message: crossCheck.reason }
  }
  if (c.blind === true) {
    return { action: 'warn', message: `install-consistency reported blind (nothing could be compared): ${c.error || 'no reason given'} -- proceeding (uncertain, not halted; AC-QA-2 amendment)` }
  }
  if (c.ok === false) {
    return { action: 'warn', message: `install-consistency could not run: ${c.error || 'no reason given'} -- proceeding (uncertain, not halted; AC-QA-2 amendment)` }
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
        `plan_only_props=${JSON.stringify(c.plan_only_props || [])}, ` +
        `missing_structural_in_review_schema=${JSON.stringify(c.missing_structural_in_review_schema || [])}, ` +
        `missing_structural_in_plan_schema=${JSON.stringify(c.missing_structural_in_plan_schema || [])}`,
    }
  }
  return { action: 'proceed', message: null }
}
// ---- end HARN-FIX-3 install-consistency preflight block ----

// Moved to module scope (from its previous position inside run(), just
// before Phase 2) so the MED-2 cross-check above can read it before the
// AC-QA-1/AC-QA-2 gate runs, without needing a disk read of this file's own
// text (MED-3) -- the literal object IS what this session executes.
const REVIEW_SCHEMA = {
  type: 'object',
  // Unknown keys rejected outright: the spread above is the first layer, this
  // is the second. A response carrying a `lens` key is a response trying to be
  // something other than an answer (review F1).
  additionalProperties: false,
  required: ['verdict', 'coverage', 'findings', 'head_sha_measured', 'head_tree_measured'],
  properties: {
    verdict: { type: 'string', enum: ['CLEAN', 'FINDINGS', 'BLOCKED'] },
    // The sha the lens ACTUALLY read, checked by the orchestrator against the
    // reviewed tip below. Added 2026-09-05: worktrees were observed starting on
    // a different commit in all three runs of 2026-09-04/05, and the only
    // defence was a prompt paragraph asking the model to notice and say so.
    // Three for three self-corrected, which is what made it dangerous.
    // Constrained, for two reasons. It is compared to the pinned tip, and an
    // unconstrained string made four benign formats of the CORRECT sha abort
    // the run (review A). And it is interpolated into a thrown error that
    // escapes the workflow, so an unbounded model-authored string was a free
    // text channel out of a reviewed diff (review B). Hex-only and bounded
    // closes both: there is nothing left to neutralise.
    head_sha_measured: { type: 'string', pattern: '^\\s*[0-9a-fA-F]{7,40}\\s*$' },
    // The witness the prompt does not contain (review F3). head_sha_measured
    // alone could not fail for the case this gate exists for: the pinned sha is
    // printed in line one of the prompt, so a lens that reviewed the wrong tree
    // and echoed it passed. A tree hash cannot be echoed from the prompt.
    head_tree_measured: { type: 'string', pattern: '^\\s*[0-9a-fA-F]{7,40}\\s*$' },
    coverage: {
      type: 'object',
      required: ['examined', 'verified_by', 'could_not_check'],
      properties: { examined: { type: 'string' }, verified_by: { type: 'string' }, could_not_check: { type: 'string' } },
    },
    ac_verdicts: { type: 'array', items: { type: 'object', required: ['id', 'verdict', 'evidence'], properties: { id: { type: 'string' }, verdict: { type: 'string', enum: ['PASS', 'FAIL', 'UNVERIFIABLE'] }, evidence: { type: 'string' } } } },
    // H4: ac_id was previously undeclared here, so a schema-following agent
    // had no field inviting it to attribute an individual finding to an AC
    // -- finding-to-AC attribution was always null downstream, not because
    // the aggregation code couldn't carry a value through, but because no
    // lens was ever told this field existed to fill in.
    // H3: recurrence was instructed in AGENT-HARNESS.md's FINDINGS template
    // and in all nine agents/lens-*.md files ("fill AGENT-HARNESS.md's
    // `Recurrence` field") with no matching property here -- a lens-output
    // schema that silently dropped a mandatory-by-instruction field. See
    // test/static-checks.test.js's AGENT-HARNESS.md-field-vs-schema guard.
    findings: { type: 'array', items: { type: 'object', required: ['severity', 'claim', 'location', 'evidence', 'consequence', 'fix'], properties: { severity: { type: 'string', enum: ['Critical', 'High', 'Medium', 'Low'] }, claim: { type: 'string' }, location: { type: 'string' }, evidence: { type: 'string' }, consequence: { type: 'string' }, fix: { type: 'string' }, ac_id: { type: ['string', 'null'] }, recurrence: { type: ['string', 'null'] } } } },
  },
}

// ---- default trigger globs; a repo overrides them with .claude/harness-triggers.json ----
// Shape of the override file: {"ui": [globs], "data": [globs], "architecture": [globs], "operability": [globs]}
const DEFAULT_RULES = {
  ui: ['**/*.html', '**/*.css', '**/*.scss', '**/*.vue', '**/*.svelte', '**/*.jsx', '**/*.tsx', '**/templates/**', '**/static/**', '**/ui/**', '**/components/**', '**/e2e/**'],
  data: ['**/migrations/**', '**/*schema*', '**/db/**', '**/models/**', '**/*.sql'],
  architecture: ['package.json', 'requirements*.txt', 'pyproject.toml', 'go.mod', 'Cargo.toml', 'Gemfile', 'composer.json', '**/settings.gradle*'],
  operability: ['Dockerfile*', 'docker-*.yml', 'compose*.yml', '.github/workflows/**', 'scripts/**', 'Procfile', 'helm/**', 'terraform/**', '**/*logging*', '**/*logger*'],
}

// Security review round 2 of specs/custom-rules-fail-closed.md, item 1
// [HIGH]: globToRe expands every "**" to ".*", producing an unanchored
// alternation with no backtracking bound. Both the override file's globs and
// the changed filenames they are matched against are attacker-controlled on
// a public repo (the override file and the filename both live in a
// contributor's own branch). Measured against this exact compiler, with one
// changed filename 61 chars long: "**a**a**a**a**b" (5 occurrences of "**",
// 15 chars) took 58ms; "**a**a**a**a**a**a**b" (7 occurrences, 21 chars) took
// 5060ms -- roughly 9x per added "**a". A ~30-char glob does not return, and
// the workflow wedges with no error, no verdict, and no terminal ledger line.
//
// Do NOT try to make globToRe itself backtracking-proof -- rewriting glob
// compilation is a much larger change with its own risk. Bound the input
// instead, in the validation loop that already walks every custom_rules
// value, before any regex is ever compiled: glob length, "**" occurrences per
// glob, and glob count per key.
const MAX_GLOB_LENGTH = 200
// Measured, not guessed. Cost of one glob against a 200-char non-matching
// path, by TOTAL wildcard count: 6 -> 8ms, 7 -> 445ms, 9 -> 17,375ms. Real
// globs in use here need at most 4 ("**/templates/**"); DEFAULT_RULES needs
// at most 3. So 6 is safely under the cliff and generous against real use.
//
// Counting "**" alone was NOT enough, and this is a hole the first cut of
// this fix shipped: "*?*?*?*?*?*?b" is 13 chars, contains ZERO "**", passed
// every bound, and took 676ms -- growing about 10x per "*?" pair. The
// blowup comes from adjacent variable-length quantifiers, which "*" and "?"
// produce just as readily as "**". Count every wildcard.
const MAX_GLOB_WILDCARDS = 6
// Kept as a separate, tighter statement of intent: 3 "**" is already 6 "*"
// characters, so this can never be the looser of the two bounds.
const MAX_GLOB_DOUBLESTAR = 3
const MAX_GLOBS_PER_KEY = 50 // this repo's own real DEFAULT_RULES entries use at most ~11; generous headroom

// Item 3 [MEDIUM]: an attacker-authored custom_rules key or glob string was
// previously interpolated verbatim into a thrown Error's message, and from
// there into the operator-visible log line (redactLogText only truncates at
// 500 chars and redacts absolute paths, not general injection -- and the
// re-thrown error itself is neither truncated nor redacted at all). Before
// this change no custom_rules string was rendered anywhere; this change
// creates that channel, so every message built from untrusted custom_rules
// content goes through this first: collapsing whitespace strips a crafted
// newline from faking a second log line or a second sentence, truncating to
// ~60 chars bounds how much attacker text ever reaches an operator, and
// JSON.stringify quotes and escapes the result so a literal double-quote in
// the input cannot break out of the surrounding sentence.
function neutralise(text) {
  const collapsed = String(text).replace(/\s+/g, ' ').trim()
  const truncated = collapsed.length > 60 ? collapsed.slice(0, 60) + '…' : collapsed
  return JSON.stringify(truncated)
}

function globToRe(g) {
  let s = g.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  s = s.replace(/\*\*/g, '\u0001').replace(/\*/g, '[^/]*').replace(/\u0001/g, '.*')
  // Item 2 [MEDIUM]: "?" was previously left unescaped by the class above, so
  // it either threw ("Nothing to repeat" for a bare "?", an error naming
  // neither the file nor the key) or, for globs that did compile, survived as
  // a regex quantifier -- the inverse of glob semantics: src/v?/** matched
  // src/v/x but NOT src/v1/x. Map it to "exactly one non-separator character"
  // instead, which is what a glob author expects. No other step in this
  // function touches "?", so it is safe to apply last.
  s = s.replace(/\?/g, '[^/]')
  return new RegExp('^' + s + '$')
}
function matches(paths, globs) {
  const res = (globs || []).map(g => {
    try {
      return globToRe(g)
    } catch (e) {
      // Defence in depth: after the length/"**"-count bounds above and the
      // "?" fix, no shape-valid custom_rules glob is known to reach this
      // catch (every remaining regex metacharacter is escaped before this
      // point) -- but a construction failure here must still name the
      // offending glob and abort, rather than surfacing as an unrelated
      // SyntaxError deep in glob compilation.
      throw new Error(
        `HarnessTriggersShapeInvalid: .claude/harness-triggers.json has a glob that failed to compile as a regex: ` +
        `${neutralise(g)} (${e && e.message ? e.message : String(e)}). Aborting the review rather than proceeding ` +
        `with an unvalidated override.`
      )
    }
  })
  return paths.filter(p => res.some(r => r.test(p)))
}

// args can arrive as a JSON-encoded string depending on the caller; normalise before use
let opts = args
if (typeof opts === 'string') { try { opts = JSON.parse(opts) } catch (e) { opts = null } }
opts = opts || {}

const specPath = opts.spec || null
// HARN-OPT-4 T4 (AC-QA-13, AC-SIMP-11): passed through RAW. ledger-append.mjs owns
// validation (integer >= 1 or null) and counts what it neutralises, so this file
// never decides what a valid round is. Round 2 L1 (spec bug S5): spread onto
// the payloads ONLY when supplied. A stale installed writer that predates the
// field rejects an unknown key structurally (the whole line is refused), so a
// direct review must not send `round: null`; the writer normalises absent to
// null itself, which is why absent reads as null on the line, never 0.
const roundField = opts.round === undefined ? {} : { round: opts.round }
// specs/record-fixed-findings.md (AC-1/AC-3): the caller's own findings,
// reported open going into this round -- {id, lens, location, claim,
// severity?, ac_id?}. Fix round 3, finding 3: `id` is REQUIRED, not
// optional -- it must be the exact value THIS workflow returned as
// open_findings[].id in an earlier round (see result.open_findings,
// below). This script recomputes findingId(lens, location, claim) from
// each entry's own content and refuses one whose supplied id does not
// match: a caller that builds this shape without a genuine, sourced id
// gets every entry dropped (invalid_prior_ids_dropped), zero fixed
// entries, and no error -- only a counter and a log line as the trace.
// Absent on round one, and on every caller that predates this argument,
// in which case every other line touched by this change stays exactly as
// it ran before: no prior-findings block reaches the synthesis prompt, no
// fixed_findings field is requested, and the terminal payload carries no
// prior ids, no invalid_prior_ids_dropped and no fixed baselines
// (ledger-append.mjs then records nothing 'fixed' and leaves
// invalid_fixed_ids_dropped absent).
const priorFindings = Array.isArray(opts.prior_findings) ? opts.prior_findings : null

// Ledger telemetry accumulators, populated inside run() as each value
// becomes available, read after run() resolves. Never part of the
// pre-existing, publicly-documented return shape (AC-ARCH-10).
const triggerCounts = {}
// null, not [], when lens-architecture never ran: an empty list would say
// "triggered by nothing", which is a different and false claim.
let architectureTriggerSource = null
// Per-lens checkout drift, recorded not gated (MED-2). Empty means every lens
// was already on the reviewed tip, which has not happened in five observed runs.
let lensCheckoutDrift = {}
let headSha = null
// 2026-08-18: the sha git reports at SYNTHESIS time, so a checkout that moved
// mid-run is detectable. Several agent sessions share these checkouts; a
// planning lens once reported confidently on repo-local forks that had been
// merged away hours earlier, because it read a tree another session had
// switched to its own branch. Null means "not reported", never "did not move".
let synthesisHeadSha = null
// Raw finding descriptors ({lens, location, claim, severity?, ac_id?}), or
// null when the synthesis response was malformed. They stay in this script:
// the ledger payload carries only the finding ids computed from them below
// (HARN-OPT-6), never the descriptor text.
let specBugsRaw = null
let rejectedFindingsRaw = null
let specBugCount = null
let rejectedFindingCount = null
// specs/record-fixed-findings.md (AC-2): the synthesis's own claimed-
// resolved echoes of some of priorFindings, same raw shape -- null when
// priorFindings was never supplied, or the synthesis response carried no
// such array. The payload carries their ids, and ledger-append.mjs checks
// those against the verified prior ids and turns them into 'fixed' entries
// (AC-3); the check that a prior entry's supplied id is authentic runs here.
let fixedFindingsRaw = null
// H5: every finding each lens actually reported, not just the two synthesis
// dispositions (spec_bug/rejected) -- without this, an accepted finding
// that gets fixed leaves no trace on any ledger line, so "which lenses
// produce findings that get fixed" (the spec's own first stated question)
// is uncomputable no matter how the ledger is later read.
let openFindingsRaw = []
// H4: {ac_id, verdict} pairs aggregated from every lens's ac_verdicts --
// previously collected here and then simply never reaching the ledger
// payload, so "which ACs never fail" had no data source at all.
let acVerdicts = []
// Review round-2 L-1: `lenses` (the triggered roster) is local to run(), so
// on a throw AFTER the lenses already ran (e.g. synthesis crashing), the
// outer telemetry code falls back to result.lenses -- undefined, because
// run() never reached its return -- and reported an empty lenses_run even
// though every lens genuinely ran and reported back. Mirrors
// openFindingsRaw/acVerdicts: set as soon as lensReports exists, so a late
// throw still leaves an accurate trail.
let lensesRunRaw = []
// specs/custom-rules-fail-closed.md AC-OPS-1/2: which rule source actually
// governed lens triggering ('repo-tuned' or 'harness defaults'), and -- when
// repo-tuned -- how many keys the override changed. Set once scope.custom_rules
// has been validated (below), read after run() resolves, same accumulator
// pattern as triggerCounts/lensesRunRaw above.
let ruleSource = null
let ruleSourceOverriddenKeys = null

// ---- Run-ledger helpers, inlined (workflow scripts cannot import: see
// tdd-task.js for the identical pattern and its rationale). ----

// HARN-OPT-5 T4 fix round 3 (conductor measurement: 6638 hashed files, 1.2 MB; AC-SEC-12 as amended, AC-QA-27):
// module-level so run() gains no `return` statements (AC-QA-9 pins that count). The agents relay only SMALL objects, as
// JSON text: the before object { file, status_count, files_count, rollup } from `stray-snapshot.mjs snapshot`, and the
// diff object { changes, retained_worktrees, dropped, before_rollup, after_rollup, hashed } from `stray-snapshot.mjs diff`
// (hashed is { repo, home } and, from fix round 4 M1, git: the shared git directory's config, hooks and info).
// The comparison is the library's measurement; the script validates both shapes and renders. Anything that is not
// that shape is null ("could not be made").
const parseObj = (x) => {
  let v = x
  if (typeof x === 'string') { try { v = JSON.parse(x) } catch { return null } }
  return v && typeof v === 'object' && !Array.isArray(v) ? v : null
}
// The before-file must sit under a temp prefix (never a repo or a .claude/ directory). Characters are restricted
// to a plain set (underscore included: macOS temp directories contain one) so the path is safe inside a prompt.
const parseBeforeObj = (x, tempPrefixes) => {
  const v = parseObj(x)
  const f = v && v.file
  const fileOk = typeof f === 'string' && /^\/[\w.+@/-]+$/.test(f) && !f.split('/').includes('..') && !f.split('/').includes('.claude') &&
    tempPrefixes.some((pre) => f.startsWith(pre))
  return fileOk && typeof v.rollup === 'string' && /^[0-9a-f]{64}$/.test(v.rollup) ? v : null
}
const CHANGE_KINDS = ['added', 'changed', 'removed']
const parseDiffObj = (x) => {
  const v = parseObj(x)
  const ok = v && Array.isArray(v.changes) && typeof v.before_rollup === 'string' &&
    v.changes.every((c) => c && typeof c === 'object' && typeof c.path === 'string' && CHANGE_KINDS.includes(c.change) && typeof c.shadows_installed_workflow === 'boolean')
  return ok ? v : null
}
// Reads budget.spent() defensively: null (never 0) when budget is absent or
// throws, so "unmeasured" stays distinguishable from "measured zero"
// (AC-QA-15, AC-OPS-3).
function readBudgetSpent() {
  if (!budget || typeof budget.spent !== 'function') return null
  try {
    const v = budget.spent()
    return typeof v === 'number' && Number.isFinite(v) ? v : null
  } catch {
    // Deliberately swallowed, and SonarQube S2486 is right to ask why rather
    // than accept silence. budget.spent() is TELEMETRY: it exists so a run's
    // cost can be recorded, and it must never be able to fail the run it is
    // measuring. A caller that cannot read the budget records null -- "not
    // measured" -- which the ledger schema models explicitly and keeps distinct
    // from zero.
    //
    // The information is not lost: null reaches budget_spent in the run ledger,
    // so an operator sees that this run's cost was unmeasured rather than being
    // told it was free.
    return null
  }
}

// Builds the prompt for the ledger-write agent step. `payload` is passed as
// opaque base64-encoded data, placed between a pair of fixed delimiter lines
// and written by the agent into a private mktemp file with its file-writing
// tool, then fed to the writer on stdin (HARN-OPT-5 T5: AC-SEC-1, AC-SEC-3,
// AC-SEC-4, AC-SEC-6). The payload may contain arbitrary lens-authored or
// task text (a finding's claim, a task string) with no sanitisation, and
// JSON.stringify does not escape a single quote, so no shell command in the
// prompt carries any payload text at all. The earlier inline
// printf-into-base64-decode form was refused by the tool-permission
// classifier on 9 of about 24 runs, each leaving no terminal ledger row.
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
    `2. Create the payload file by exclusive create, with exactly this command and nothing else: ` +
    `\`mktemp "\${TMPDIR:-/tmp}/harn-ledger-XXXXXX"\`. It prints the path of a new, empty file in a directory outside ` +
    `every git working tree; call that path "the file". Never put the file inside the checkout (never under ` +
    `\`git rev-parse --show-toplevel\`, never in a worktree), never use a fixed name or path, and never derive a name ` +
    `from the run_id. If mktemp fails or prints nothing, or the path somehow already holds content (a collision: ` +
    `read it and check it is empty), report write_ok false with write_error naming that, do not run the writer at ` +
    `all and do not pipe anything to it, and go straight to step 5.\n` +
    `3. The payload below is base64-encoded SPECIFICALLY so its raw text (which may contain quotes or other shell ` +
    `metacharacters authored by a reviewed diff, a lens finding, or task text) never reaches a shell command. Do not ` +
    `decode it, inspect it, or reconstruct the JSON by hand. Put exactly the text between the two delimiter lines ` +
    `(the delimiter lines themselves excluded, nothing added) into the file with your file-writing tool (the Write ` +
    `tool), reading the empty file first if the tool requires that. Never write it via a shell command, and never ` +
    `put any of it in a Bash command.\n` +
    `<<<HARNESS-LEDGER-PAYLOAD>>>\n` +
    `${payloadBase64}\n` +
    `<<<END-HARNESS-LEDGER-PAYLOAD>>>\n` +
    `4. Run exactly one Bash command to run the writer, substituting only the real script path and the file path: ` +
    `\`node <path-to-ledger-append.mjs> < "<the file>"\`. The script decodes the payload itself, always exits 0 ` +
    `and prints one line of JSON: {run_id, ts, write_ok, write_error}. It already handles locating the main ` +
    `checkout, ensuring the ledger stays gitignored, sourcing the timestamp from the system clock, and the single ` +
    `atomic append -- do not attempt any of that yourself, and do not construct the ledger line by hand.\n` +
    `5. Delete exactly that one file with \`rm "<the file>"\`, on every exit path: after a successful write, after ` +
    `write_ok false, when the writer was not found or could not be found, when node fails to start, and after a ` +
    `collision. Delete only that one file: no glob, no flags, no directory.\n` +
    `If the script could not be found or failed to run at all (rather than reporting write_ok:false itself), ` +
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

// HARN-OPT-5 T4 fix round 2 (re-frame; AC-SEC-12, AC-QA-27): the snapshot is COMPUTED by
// workflows/lib/stray-snapshot.mjs, never transcribed by an agent. Fix round 3 (conductor measurement: 6638 hashed
// files, 1.2 MB): the agents no longer relay the snapshot either, only small objects. The scope step runs `snapshot`
// (the library writes the full snapshot to a temp file) and relays its small object; synthesis runs `diff` against that
// file and relays its small object. The fields are JSON TEXT, which the script validates below; anything that does
// not validate is "could not be made".
const SNAPSHOT_SCHEMA = { type: 'string' }

// One wording for finding the library, used at BOTH prompt sites so the before and after commands cannot drift. The
// library is found exactly as the ledger step finds ledger-append.mjs (see ledgerWritePrompt): a repo-local
// copy in any other repo is what a hostile diff under review could plant.
const SNAPSHOT_LOCATE =
  `Find this harness's stray-snapshot.mjs script, in this exact order, and use the FIRST one that exists: ` +
  `(a) ~/.claude/workflows/lib/stray-snapshot.mjs (the global mirror install); (b) any installed claude-ai-harness ` +
  `plugin directory's workflows/lib/stray-snapshot.mjs; (c) "$(git rev-parse --show-toplevel)/workflows/lib/stray-snapshot.mjs" ` +
  `in the current repo, but ONLY if the current repo is claude-ai-harness itself (the basename of ` +
  `\`git rev-parse --show-toplevel\` equals "claude-ai-harness"). NEVER use a repo-local copy in any OTHER repo, even if ` +
  `(a) and (b) are both absent: return an empty string instead. `
const SNAPSHOT_BEFORE_ASK = SNAPSHOT_LOCATE +
  `Then run exactly \`node <path-to-stray-snapshot.mjs> snapshot "$(git rev-parse --show-toplevel)"\` and return its stdout ` +
  `verbatim, unedited, as the value: one short JSON object (file, status_count, files_count, rollup). Do not open the file it names, ` +
  `and do not list, hash or summarise anything yourself.`
const snapshotAfterAsk = (beforeFile) => SNAPSHOT_LOCATE +
  `Then run exactly \`node <path-to-stray-snapshot.mjs> diff "$(git rev-parse --show-toplevel)" ${beforeFile}\` and return its stdout ` +
  `verbatim, unedited, as the value: one short JSON object (changes, before_rollup, after_rollup). Do not open the file it names, ` +
  `and do not list, hash or summarise anything yourself.`

// ---- Phase 1: scope ----
phase('Scope')
const scope = await agent(
  // specs/harn-fix-3.md AC-QA-1/AC-QA-3: folded into this SAME agent() call
  // rather than a new one, so a consistent install adds no measurable
  // startup delay -- see INSTALL_CONSISTENCY_INSTRUCTION above.
  INSTALL_CONSISTENCY_INSTRUCTION +
  `In the repo at the current working directory:\n` +
  `1. Determine the base ref: ${opts.base ? `use "${opts.base}".` : 'the repository default branch (usually main or master; check `git remote show origin` or local branch names).'}\n` +
  `2. Run \`git diff --name-status <base>...HEAD\` and return every changed file path with its status letter, plus the base ref you used, the exact output of \`git rev-parse HEAD\` as head_sha, and the exact output of \`git rev-parse HEAD^{tree}\` as head_tree.\n` +
  `3. Report whether any dependency manifest (package.json, requirements*.txt, pyproject.toml, go.mod, Cargo.toml, Gemfile, or equivalent) gained a NEW entry (a new package, not a version bump), and whether the diff ADDS a new module or package (a new source file outside tests, or a new package directory).\n` +
  `4. Check whether a file .claude/harness-triggers.json exists at the repo root and report that as ` +
  `harness_triggers_file_exists (true/false). If it exists, return its parsed JSON as custom_rules; if it does not ` +
  `exist, custom_rules must be null.\n` +
  // HARN-OPT-5 T4 (AC-SEC-11, AC-SEC-12, AC-QA-26, AC-QA-27): folded into this
  // SAME agent() call (AC-SIMP-9), never a new one.
  `5. Create a private scratch root for this run with \`mktemp -d "\${TMPDIR:-/tmp}/harn-review-XXXXXX"\` and return the exact ` +
  `absolute path it printed as scratch_root. It must be OUTSIDE every git working tree: the OS temp directory, never the repo, ` +
  `never a worktree, never any .claude/ directory. Create nothing else in it. If TMPDIR is set, also return its exact value as tmpdir.\n` +
  `6. Return snapshot_before. ${SNAPSHOT_BEFORE_ASK} Change nothing.\n` +
  `Raw data only.`,
  {
    label: 'scope:diff',
    phase: 'Scope',
    effort: 'low',
    schema: {
      type: 'object',
      required: ['base', 'head_sha', 'head_tree', 'files', 'new_dependency_entries', 'new_modules', 'custom_rules', 'harness_triggers_file_exists', 'consistency'],
      properties: {
        base: { type: 'string', pattern: '^[A-Za-z0-9._/@^~-]{1,120}$' },
        head_sha: { type: 'string', pattern: '^\\s*[0-9a-fA-F]{7,40}\\s*$' },
        // The WITNESS (round-two review F3). The reviewed tip's tree hash is not
        // derivable from its commit sha without reading the object, so a lens
        // can only answer it by running git in the tree it actually read. It is
        // deliberately never placed in a lens prompt.
        head_tree: { type: 'string', pattern: '^\\s*[0-9a-fA-F]{7,40}\\s*$' },
        files: { type: 'array', items: { type: 'object', required: ['path', 'status'], properties: { path: { type: 'string' }, status: { type: 'string' } } } },
        new_dependency_entries: { type: 'boolean' },
        new_modules: { type: 'boolean' },
        // AC-SEC-1: type stays loose (contents are shape-validated in the
        // workflow itself, below, not by this schema) -- but `required` now
        // catches an OMITTED field, which the runtime's structured-output
        // enforcement rejects before the workflow ever sees it.
        custom_rules: { type: ['object', 'null'] },
        // AC-SEC-1/AC-SEC-2: a second, independent answer that can
        // CONTRADICT custom_rules -- true + custom_rules:null is exactly the
        // transcription failure this whole spec exists to catch (a
        // single-field report has no way to be self-inconsistent).
        harness_triggers_file_exists: { type: 'boolean' },
        consistency: INSTALL_CONSISTENCY_SCHEMA,
        // HARN-OPT-5 T4: both optional so an older agent response validates.
        scratch_root: { type: 'string' },
        // Round 1 L2: the TMPDIR the scope step saw, optional, widens the allowed temp prefixes by exactly that directory.
        tmpdir: { type: 'string' },
        snapshot_before: SNAPSHOT_SCHEMA,
      },
    },
  }
)

// AC-QA-1/AC-QA-2 (amended, round-two review): refuse ONLY on a PROVEN
// mismatch (evaluateInstallConsistency's 'refuse' action) -- checked even
// on a would-be no-op review (placed BEFORE the no-changes short-circuit
// below), and guarded on `scope` truthy so a totally failed scope agent
// still falls through to the existing aborted/no-op handling unchanged.
// Everything uncertain warns and proceeds. See the install-consistency
// preflight block above for the reasoning and evaluateInstallConsistency().
// Round three: the override is THIS invocation's own args flag, read here
// directly, never from the environment and never from scope.consistency (model
// output). Strict === true, so a mistyped "true" or 1 fails CLOSED.
let installOverrideNotice = null
if (scope) {
  const reviewEval = evaluateInstallConsistency(scope.consistency, REVIEW_SCHEMA, 'REVIEW_SCHEMA', opts.allow_inconsistent_install === true)
  if (reviewEval.action === 'refuse') {
    throw installConsistencyError(reviewEval.message)
  }
  if (reviewEval.action === 'warn') {
    log(`WARNING (install-consistency preflight, AC-QA-2 amendment): ${redactLogText(reviewEval.message)}`)
  }
  // A log line scrolls away; the report is what gets read and pasted. An
  // override that suppressed a refusal has to appear in both.
  if (reviewEval.override_used) installOverrideNotice = reviewEval.message
}

// AC-1 (the no-op that read as success): a scope step that returned
// NOTHING failed entirely -- there is no base ref, no head sha and no file
// list, so this is a broken run, not an empty diff, and must never share
// an exit with the genuinely-empty case below. This follows the shape of
// the install-consistency refusal immediately above it in this file
// (throw, with a clear reason and a next step): the run then goes through
// the SAME exception path every other broken-run case in this file already
// uses, so it lands as one terminal ledger write with outcome aborted, and
// the original error still reaches the caller instead of looking like a
// completed review that found nothing.
if (!scope) {
  throw new Error(
    'ScopeStepFailed: the scope agent returned no result, so the base ref, head sha and changed-file list are ' +
    'all unknown. This is a broken run, not an empty diff, and must not be reported as "no changes found" -- ' +
    'that would read as a completed review with nothing to flag. Re-run the review cycle.'
  )
}

// AC-2: a genuinely empty diff is the other, legitimate case -- the scope
// step succeeded and correctly found nothing to review. __outcome keeps
// the pre-existing 'no-op' value, which the run ledger's OUTCOMES enum
// (workflows/lib/ledger-append.mjs) already keeps distinct from 'done', so
// a ledger reader cannot count this as a clean pass. The report text says
// plainly that no review happened, not that one ran and found nothing
// wrong, and is logged too so it is not only visible to a reader who opens
// the returned report.
if (!scope.files.length) {
  log('No review performed: the diff between the base ref and HEAD is empty. Reporting outcome no-op, not a clean pass.')
  return {
    report: 'NO REVIEW WAS PERFORMED -- the diff between the base ref and HEAD is empty (no changed files). ' +
      'This is not a clean review outcome: no lens ran and nothing was checked. If a change was expected, ' +
      'check the base ref and the branch.',
    __outcome: 'no-op',
  }
}


// ---- validate EVERY model-authored scope value, here, once, before use ----
// Round-three review HIGH-1, and this is a structural change rather than a
// patch. Each of these values had been validated somewhere: base nowhere at
// all, head_sha and head_tree about ninety lines below, after the lenses they
// protect had already been dispatched. Validating a value at the point where
// somebody noticed it mattered is how base ended up interpolated, unchecked,
// into a shell command inside nine tool-capable sub-agent prompts, next to the
// sentence "Run both commands exactly as written and report exactly what they
// print". A branch name may legally contain a semicolon.
//
// Everything the scope step returns is model-authored. So the boundary is here,
// where it arrives, and nothing downstream re-derives its own opinion.
const SHA_RE = /^[0-9a-f]{7,40}$/
// Deliberately narrower than git's ref rules: this value is interpolated into a
// command, so it is an allowlist of what a ref may contain, not a denylist of
// what a shell treats specially. No spaces, no semicolons, no substitution, no
// newlines, nothing to quote around.
const REF_RE = /^[A-Za-z0-9._/@^~-]{1,120}$/
const scopeBase = typeof scope.base === 'string' ? scope.base.trim() : ''
if (!REF_RE.test(scopeBase)) {
  throw new Error(
    `ScopeBaseInvalid: the scope step reported the base ref as ${neutralise(scope.base)}, which is not a plain ref ` +
    `name. That value is interpolated into a git command inside every lens prompt, so it is refused here, BEFORE any ` +
    `lens is dispatched, rather than being passed to nine tool-capable agents and checked afterwards. Re-run the ` +
    `review cycle; if the branch name genuinely contains unusual characters, rename it or pass base explicitly.`
  )
}
const scopeSha = typeof scope.head_sha === 'string' ? scope.head_sha.trim().toLowerCase() : ''
if (!SHA_RE.test(scopeSha)) {
  throw new Error(
    `ScopeHeadShaInvalid: the scope step reported the pinned tip as ${neutralise(scope.head_sha)}, which is not a ` +
    `valid commit sha. Every comparison in this run is made against that value, and it is interpolated into a git ` +
    `command in every lens prompt, so a malformed pin either disables the reviewed-tip check or fails correct ` +
    `lenses. This is a SCOPE failure, not a checkout problem and not a lens problem: re-run the review cycle.`
  )
}
const scopeTree = typeof scope.head_tree === 'string' ? scope.head_tree.trim().toLowerCase() : ''
if (!SHA_RE.test(scopeTree)) {
  throw new Error(
    `ScopeHeadTreeInvalid: the scope step reported the reviewed tip's tree hash as ${neutralise(scope.head_tree)}, ` +
    `which is not a valid object id. That value is the ONLY thing a lens cannot echo from its prompt, so without it ` +
    `the reviewed-tip check degrades to a self-report. This is a SCOPE failure: re-run the review cycle.`
  )
}

// Telemetry takes the VALIDATED sha too, and is assigned only after the three
// checks above have passed. Previously set from scope.head_sha before any of
// them ran, so a rejected run still recorded the raw value.
headSha = scopeSha

// scopeBase, NOT scope.base (round-four adversarial pass, HIGH 3). The
// validated values were computed at the boundary and then discarded here, so
// the raw model-authored string is what reached every lens prompt -- and the
// comment at the boundary claimed the opposite. A trailing newline alone breaks
// the backticked command a lens is told to run verbatim, turning a review of
// the branch into a review of the working tree with no sign anything is wrong.
const base = scopeBase

// specs/custom-rules-fail-closed.md AC-SEC-2: the contradiction that catches
// a transcription failure. The scope step has no filesystem access of its
// own to double-check itself, so this compares its two independent answers:
// if the file was reported to exist but its parsed contents did not arrive,
// that is a transcription failure in the scope step, not evidence the file
// has no overrides. Proceeding on defaults here would silently review with
// the wrong lens roster and no sign of it (the measured blast radius this
// spec exists to close) -- fail closed instead.
if (scope.harness_triggers_file_exists === true && scope.custom_rules === null) {
  throw new Error(
    'HarnessTriggersTranscriptionFailed: .claude/harness-triggers.json exists at the repo root ' +
    '(harness_triggers_file_exists is true) but custom_rules did not arrive (it is null) -- a transcription ' +
    'failure in the scope step, not evidence the override file is empty. Aborting the review rather than ' +
    'silently falling back to harness defaults, which would review with the wrong lens roster and no sign of ' +
    'it. Re-run the review; if this recurs, the override file is not being read.'
  )
}

// Item 4, from the security review: the contradiction check was one-directional.
// The design's whole insight is that two independent answers can contradict, so
// treating only one direction as a failure leaves the other silent. A scope step
// that reports no override file while delivering custom_rules has misread
// something, and applying those rules would narrow the lens roster on the word
// of an answer the other field contradicts -- while the log cheerfully reports
// "repo-tuned" for a repo with no tuning.
if (scope.harness_triggers_file_exists === false && scope.custom_rules !== null) {
  throw new Error(
    'HarnessTriggersContradiction: the scope step reported no .claude/harness-triggers.json at the repo root ' +
    '(harness_triggers_file_exists is false) yet delivered custom_rules anyway -- the two answers contradict, so ' +
    'one of them is wrong and there is no way to tell which. Aborting rather than narrowing the lens roster on the ' +
    'strength of an override the same step says does not exist. Re-run the review; if this recurs, the scope step ' +
    'is misreading the repo root.'
  )
}

// AC-SEC-3: shape-validate custom_rules before it is merged into the trigger
// rules and reaches matches()/glob compilation. Unvalidated, a non-array
// value throws an unrelated error deep in glob compilation and a stray key
// is silently ignored -- neither of which names what is actually wrong with
// the repo's override file.
//
// 'escapedDefectExcludePaths' is a SECOND consumer of this same file, not a
// review-cycle trigger: workflows/lib/optimise-read.mjs reads it (in a
// wholly separate, per-PR-uninvoked delivery-metrics script -- see that
// file's DEFAULT_PRODUCT_SOURCE_EXCLUDE_GLOBS) to scope a git-history
// counter-metric to product source. It has to be accepted here too, or a
// repo that sets it would fail every review-cycle run with "unrecognised
// key" the moment it also configures a trigger override -- this loop
// otherwise still validates its shape (array-of-bounded-globs) exactly
// like the four review-cycle keys; it is simply never read into
// `rules` below, since no lens triggers on it.
const CUSTOM_RULE_KEYS = ['ui', 'data', 'architecture', 'operability', 'escapedDefectExcludePaths']
if (scope.custom_rules !== null) {
  for (const key of Object.keys(scope.custom_rules)) {
    if (!CUSTOM_RULE_KEYS.includes(key)) {
      throw new Error(
        `HarnessTriggersShapeInvalid: .claude/harness-triggers.json has an unrecognised key ${neutralise(key)} -- only ` +
        `${CUSTOM_RULE_KEYS.join(', ')} are accepted. Aborting the review rather than proceeding with an ` +
        `unvalidated override.`
      )
    }
    const value = scope.custom_rules[key]
    if (!Array.isArray(value)) {
      throw new Error(
        `HarnessTriggersShapeInvalid: .claude/harness-triggers.json's "${key}" must be an array of glob strings, ` +
        `got ${typeof value}. Aborting the review rather than proceeding with an unvalidated override.`
      )
    }
    if (value.some(v => typeof v !== 'string')) {
      throw new Error(
        `HarnessTriggersShapeInvalid: .claude/harness-triggers.json's "${key}" array contains a non-string glob. ` +
        `Aborting the review rather than proceeding with an unvalidated override.`
      )
    }
    // An EMPTY array is the silent-lens-loss case in a different costume, and
    // it survived the first cut of this validation. Measured: an override of
    // {"data": []} REPLACES the default data globs rather than extending them,
    // so a changed .sql migration triggers ['lens-security','lens-qa'] where
    // the defaults give ['lens-security','lens-qa','lens-data'] -- the lens is
    // gone and the log still says "repo-tuned". That is exactly what this
    // whole mechanism exists to prevent.
    //
    // It is rejected rather than merely logged because an empty array is
    // indistinguishable from a transcription failure (an agent returning
    // {"data": []} instead of the real list), and there is no documented way
    // to disable a lens deliberately -- omitting the key inherits the
    // defaults, so an empty array is not the supported spelling of anything.
    if (value.length === 0) {
      throw new Error(
        `HarnessTriggersShapeInvalid: .claude/harness-triggers.json's "${key}" is an empty array, which would ` +
        `REPLACE the harness defaults for that key and silently stop the corresponding lens triggering on any ` +
        `path. Omit the key entirely to inherit the defaults. Aborting rather than reviewing with a lens ` +
        `disabled by what may be a transcription failure.`
      )
    }
    // Item 1 [HIGH], from the security review of this PR. globToRe expands
    // every "**" to ".*", producing an unanchored alternation with no
    // backtracking bound, so a crafted glob makes matches() run effectively
    // forever. Measured against the real compiler with a 61-char filename:
    // 12 chars 4.7ms, 15 chars 58ms, 18 chars 586ms, 21 chars 5060ms -- about
    // 9x per added "**a", and a 30-char glob does not return. Both halves are
    // attacker-controlled on a public repo (the override file and the filename
    // both live in a contributor's branch), and the workflow wedges inside the
    // sandbox with no error, no verdict and no terminal ledger line, leaving
    // the run's started record a permanent orphan. That is strictly worse than
    // an abort, which at least says what happened.
    //
    // The input is bounded rather than globToRe made backtracking-proof:
    // rewriting glob compilation is a much larger change carrying its own
    // risk, and these bounds are far above anything a real override needs
    // (the harness's own DEFAULT_RULES use at most one "**" per glob).
    if (value.length > MAX_GLOBS_PER_KEY) {
      throw new Error(
        `HarnessTriggersShapeInvalid: .claude/harness-triggers.json's "${key}" has too many globs: ${value.length}, ` +
        `more than the limit of ${MAX_GLOBS_PER_KEY}. Each glob is compiled to a regex and matched against every changed path, so ` +
        `an unbounded list is a denial-of-service surface. Aborting the review.`
      )
    }
    for (const g of value) {
      if (g.length > MAX_GLOB_LENGTH) {
        throw new Error(
          `HarnessTriggersShapeInvalid: .claude/harness-triggers.json's "${key}" contains a glob that is too long: ` +
          `${g.length} characters, over the limit of ${MAX_GLOB_LENGTH}: ${neutralise(g)}. Long globs compile to regexes whose ` +
          `backtracking cost grows exponentially. Aborting the review.`
        )
      }
      const wildcards = (g.match(/[*?]/g) || []).length
      if (wildcards > MAX_GLOB_WILDCARDS) {
        throw new Error(
          `HarnessTriggersShapeInvalid: .claude/harness-triggers.json's "${key}" contains a glob with too many ` +
          `wildcards: ${wildcards} ("*" and "?" combined), more than the limit of ${MAX_GLOB_WILDCARDS}: ` +
          `${neutralise(g)}. Adjacent variable-length wildcards make regex matching cost grow about 10x each; ` +
          `measured, 7 wildcards costs 445ms per path and 9 costs 17 seconds. Aborting the review.`
        )
      }
      const doubleStars = g.split('**').length - 1
      if (doubleStars > MAX_GLOB_DOUBLESTAR) {
        throw new Error(
          `HarnessTriggersShapeInvalid: .claude/harness-triggers.json's "${key}" contains a glob with too many "**" ` +
          `segments: ${doubleStars}, over the limit of ${MAX_GLOB_DOUBLESTAR}: ${neutralise(g)}. Each "**" becomes ".*", and ` +
          `stacking them makes matching cost grow about 9x per segment. Aborting the review.`
        )
      }
    }
    if (value.some(v => v.trim() === '')) {
      throw new Error(
        `HarnessTriggersShapeInvalid: .claude/harness-triggers.json's "${key}" array contains an empty glob ` +
        `string, which matches nothing and is almost certainly not what was meant. Aborting rather than ` +
        `proceeding with an override that silently covers less than it appears to.`
      )
    }
  }
}

// AC-OPS-1/AC-OPS-2: which rule source governed lens triggering, for the log
// line below and the run ledger.
ruleSource = scope.custom_rules ? 'repo-tuned' : 'harness defaults'
ruleSourceOverriddenKeys = scope.custom_rules ? Object.keys(scope.custom_rules).length : null

// `|| {}` dropped (S7744): object spread of null or undefined is a no-op, so
// the empty object was doing nothing. Behaviour identical.
const rules = { ...DEFAULT_RULES, ...scope.custom_rules }
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

// M1: keyed BY LENS NAME (matching entries in `lenses` below), not by rule
// group -- a lens's count must reflect the files that actually triggered
// IT, so it can be looked up directly rather than requiring the reader to
// know the rule-group mapping. Always-on lenses get the total changed-file
// count (they are never "triggered by" a subset), so an absent key always
// means "not triggered", never "triggered with 0 files".
triggerCounts['lens-security'] = paths.length
triggerCounts['lens-qa'] = paths.length

if (uiHit.length) {
  lenses.push('lens-design', 'lens-accessibility')
  triggerCounts['lens-design'] = uiHit.length
  triggerCounts['lens-accessibility'] = uiHit.length
}
if (dataHit.length) {
  lenses.push('lens-data')
  triggerCounts['lens-data'] = dataHit.length
}
// uiHit too, added 2026-09-04 after a design-system change in a
// delivery repo added a new UI and left old buttons on screen wired to nothing. This lens's review
// mode holds the only "dead code this change created and did not remove" duty
// in the roster, and architecture's globs are dependency manifests and core
// wiring -- which a components-and-CSS diff never touches. The lens carrying
// the duty was structurally absent from the change class that creates the
// debris. Deliberately review-side only: at planning the removal question
// belongs to the lens owning the area (AGENT-HARNESS.md, "What a change
// replaces"), and architecture's removal duty lives in its review text.
if (archHit.length || uiHit.length || scope.new_modules || scope.new_dependency_entries) {
  lenses.push('lens-architecture')
  // WHICH rule group woke it, recorded because trigger_counts cannot answer it:
  // that number is the deduplicated union of both surfaces, so a ledger line
  // could not be classified as ui-triggered-alone versus anything else.
  // AGENT-HARNESS.md's eight-week reversal condition counts exactly the
  // ui-alone population, and without this it had to be reconstructed from the
  // diffs by hand, which is another way of saying it would not have been.
  architectureTriggerSource = [
    ...(archHit.length ? ['arch-glob'] : []),
    ...(uiHit.length ? ['ui-glob'] : []),
    ...(scope.new_modules ? ['new-module'] : []),
    // Distinct from new-module (review J): a diff that only adds a package was
    // being labelled "new-module" in the durable record, which is simply not
    // what happened, and the enum offered no other value.
    ...(scope.new_dependency_entries ? ['new-dependency'] : []),
  ]
  // Credits whichever surface actually triggered it, deduplicated: a file
  // matching both globs is one file, not two. Still honestly 0 when triggered
  // purely by new_modules/new_dependency_entries with nothing matching either
  // glob -- a real, measured zero, not a stand-in borrowed from an unrelated
  // rule group.
  triggerCounts['lens-architecture'] = new Set([...archHit, ...uiHit]).size
}
if (opsHit.length) {
  lenses.push('lens-operability')
  triggerCounts['lens-operability'] = opsHit.length
}
// specPath too: a caller can supply an existing, unchanged spec for a
// user-facing backend change that touches neither a spec file nor a UI glob.
if (specHit.length || uiHit.length || specPath) {
  lenses.push('lens-product')
  // Credits whichever files actually caused the trigger (specs/** and/or
  // the ui surface), deduplicated -- not just specHit.length, which was
  // always 0 for the common case of a UI-only diff triggering this lens.
  triggerCounts['lens-product'] = new Set([...specHit, ...uiHit]).size
}

// An override ADDS to the mandatory roster, it does not replace it: the
// always-on lenses cannot be silently dropped by {lenses: [...]}.
const MANDATORY = ['lens-security', 'lens-qa']
if (Array.isArray(opts.lenses) && opts.lenses.length) {
  lenses = [...new Set([...MANDATORY, ...opts.lenses])]
}
if (opts.adversarial) lenses.push('reviewer-verification')

const ALL = ['lens-security', 'lens-qa', 'lens-design', 'lens-accessibility', 'lens-data', 'lens-architecture', 'lens-operability', 'lens-product']
const skipped = ALL.filter(l => !lenses.includes(l))
// AC-OPS-1/AC-QA-4: names which rule source governed the trigger match above
// (repo-tuned, with the count of overridden keys, or harness defaults) so an
// operator reading the run output can tell which applied without inspecting
// the repo.
const ruleSourceText = ruleSource === 'repo-tuned' ? `repo-tuned (${ruleSourceOverriddenKeys} overridden keys)` : 'harness defaults'
log(`Reviewing ${paths.length} changed files against ${base} at ${scopeSha.slice(0, 8)}. Lenses: ${lenses.join(', ')}. Skipped (not triggered): ${skipped.join(', ') || 'none'}. Rule source: ${ruleSourceText}.`)

// ---- Phase 2: lenses in parallel, each in its own worktree ----

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

// HARN-OPT-5 T4 (AC-SEC-11, AC-QA-26): a usable root is absolute, plain
// characters only, and not under any .claude/ directory. Anything else falls
// back to the lens making its own with mktemp -d, so the root never depends on
// startRunId (null when the start write failed) or on a shared fixed name.
const scratchBase = scope && typeof scope.scratch_root === 'string' ? scope.scratch_root.replace(/\/+$/, '') : ''
// Round 1 L2 (AC-SEC-11, AC-QA-26): an absolute plain path is not enough, a working tree
// qualifies. The base must also sit under a known temp prefix, or under the TMPDIR the
// scope step passed through (a bare "/" or a relative value never widens the list).
const plainAbsolute = (x) => /^\/[A-Za-z0-9._+@\/-]+$/.test(x) && !x.split('/').includes('..') && !x.split('/').includes('.claude')
const scopeTmpdir = scope && typeof scope.tmpdir === 'string' ? scope.tmpdir.replace(/\/+$/, '') : ''
const tempPrefixes = ['/tmp/', '/private/tmp/', '/var/folders/', '/private/var/folders/'].concat(scopeTmpdir && plainAbsolute(scopeTmpdir) ? [`${scopeTmpdir}/`] : [])
const scratchUsable = plainAbsolute(scratchBase) && tempPrefixes.some((pre) => scratchBase.startsWith(pre))
// Fix round 3 (AC-SEC-12): the before object is validated here, before the synthesis prompt needs its file path.
const snapBefore = parseBeforeObj(scope && scope.snapshot_before, tempPrefixes)
const scratchClause = (lens) =>
  (scratchUsable
    ? `Your private scratch root is ${scratchBase}/${lens} (create it with mkdir -p). `
    : `Create your private scratch root first with \`mktemp -d "\${TMPDIR:-/tmp}/harn-${lens}-XXXXXX"\` and use only the path it prints. `) +
    `Put every extraction, copy and scratch file for this review inside that root and nowhere else; no other lens or run shares it. ` +
    `You must not write to the main checkout, to any worktree other than your own, to any .claude/ directory inside a repo, or to ~/.claude/. ` +
    `When you finish you may delete only your own root, with: ${scratchUsable ? `rm -rf ${scratchBase}/${lens}` : 'rm -rf on the exact path mktemp printed'} (nothing else).\n\n`

const lensPrompt = (lens) =>
  `REVIEW mode. The reviewed tip is commit ${scopeSha}. FIRST, before anything else, run \`git rev-parse HEAD\` ` +
  `in your worktree. If it differs, your checkout has drifted from the reviewed tip (a parallel session may have ` +
  `advanced the branch): check out or diff against the pinned SHA explicitly, and record the drift in could_not_check. ` +
  `Review \`git diff ${base}...${scopeSha}\`.\n` +
  `Then report two values. Run both commands exactly as written and report exactly what they print. NEITHER command ` +
  `moves your checkout, and you must not move it: these worktrees can be shared, and checking out a different commit ` +
  `underneath another session is the incident this whole check exists to prevent.\n` +
  `  head_tree_measured: \`git rev-parse ${scopeSha}^{tree}\`   <- the reviewed tip's tree. This is the one ` +
  `that is checked. Its value appears NOWHERE in this prompt, deliberately: the sha does appear above, so reporting ` +
  `that back proves nothing. There is exactly one legal answer and only running the command produces it.\n` +
  `  head_sha_measured:  \`git rev-parse HEAD\`   <- wherever your worktree happens to be. This is RECORDED, not ` +
  `checked, so report it honestly even if it differs from the reviewed tip. Drift is expected and is measured here; ` +
  `it is not held against you and does not fail the run.\n` +
  `Changed files (${paths.length} total):\n${fileList}\n\n` +
  `${specClause}\n\n` +
  (lens === 'lens-qa' ? qaBudget : '') +
  scratchClause(lens) +
  `You are in an isolated git worktree: mutation experiments (break the guard, watch the test fail, restore) are safe here. ` +
  `The worktree will not contain uncommitted tooling from the main checkout (virtualenvs, node_modules); if you need the ` +
  `project's interpreter or test runner, invoke the main checkout's copy by absolute path (locate the main checkout ` +
  `with \`cd "$(git rev-parse --git-common-dir)/.." && pwd\`), and never modify anything under the main checkout.\n\n` +
  `Before you run or invoke workflows/lib/ledger-append.mjs for ANY reason (a mutation experiment, a manual probe, ` +
  `reading its behaviour), prefix the variable onto that same command line: ` +
  `\`HARNESS_LEDGER_READONLY=1 node <path-to>/ledger-append.mjs ...\`. It MUST be on the one command line that runs ` +
  `node. Do NOT set it with a separate \`export\` in an earlier command: this runtime does not persist shell state ` +
  `between tool calls, so an export dies with the call that made it and the guard would never be armed. That script ` +
  `resolves the operator's real, main-checkout ledger regardless of which worktree invokes it (AC-DATA-1), so without ` +
  `this it is not a test double, it is the live ledger. You are read-only: never write to the harness's own ledger.\n\n` +
  `Your final structured output maps the AGENT-HARNESS.md output contract onto the schema fields: verdict, coverage ` +
  `(could_not_check is mandatory and must be honest, not "nothing"), ac_verdicts, findings (each with file:line in location, ` +
  `and recurrence naming whether you expect more instances of the same class elsewhere in the diff or codebase). ` +
  `You are licensed to return CLEAN with empty findings.`

const reports = await parallel(lenses.map(lens => () =>
  agent(lensPrompt(lens), { agentType: lens, label: lens, phase: 'Lenses', schema: REVIEW_SCHEMA, isolation: 'worktree' })
    // `lens` LAST, deliberately (round-two review F1). Spreading the model's
    // response over the workflow's own label let a lens rename itself: a `lens`
    // key in the response won, attacker-chosen text reached the thrown error
    // verbatim dressed as a harness system error, and the roster check then
    // reported the real lens as vanished. The orchestrator must never take an
    // identity it assigned from the party it assigned it to.
    .then(r => (r ? { ...r, lens } : null))
))
const lensReports = reports.filter(Boolean)
// TOTAL failure returns softly; PARTIAL failure throws (round-two review F8).
// That asymmetry is deliberate, not accidental, and the reason is which outcome
// can be mistaken for a completed review. "No review produced" is unmistakable:
// there are no verdicts to read and nothing to act on. A review missing three of
// nine lenses reads exactly like a review, and its verdicts look like coverage
// they do not have. The mistakable one is the one that must stop the run.
if (!lensReports.length) return { report: 'Every lens agent failed or was stopped; no review produced.', __outcome: 'aborted' }
lensesRunRaw = lensReports.map(r => r.lens)

// These two are set HERE, immediately after lensReports exists and ABOVE every
// check that can throw. Review round one, finding C: the reviewed-tip check was
// inserted between lensesRunRaw and these assignments, so one lens misreporting
// its sha destroyed every OTHER lens's findings for the round -- and the ledger
// line then read "these lenses ran and found nothing". A probe with a Critical
// security finding and one foreign sha produced lenses_run of both lenses and
// open_findings of []. That is the absence-reads-as-success shape this whole
// change exists to close, rebuilt inside the fix for it, and the file's own
// rule at the accumulator declarations already said not to do it. The rule was
// a comment; it is now a test.
// H5: capture every finding each lens reported, as-is, before synthesis
// dedupes/arbitrates them -- this is the "open" (accepted) side that was
// previously never recorded at all.
openFindingsRaw = lensReports.flatMap(r =>
  (r.findings || []).map(f => ({ lens: r.lens, location: f.location, claim: f.claim, severity: f.severity, ac_id: f.ac_id || null, recurrence: f.recurrence || null }))
)

// H4: {ac_id, verdict} ONLY -- evidence text is dropped here, before the
// payload is ever built, preserving the same AC-SEC-2 exclusion the
// findings pipeline already holds to.
acVerdicts = lensReports.flatMap(r =>
  (r.ac_verdicts || []).map(v => ({ ac_id: v.id, verdict: v.verdict }))
)

// specs/harn-ledger-validators.md D4/M1 (fix round 3): computed here, before
// the synthesis prompt is built, so BOTH halves of the fix can use it -- the
// prompt-shaping half just below, and the post-processing half further down
// (which used to declare this same boolean a second time). "No spec was in
// play" means specPath is null AND no lens returned any ac_verdicts
// (review-cycle.js's own no-spec branch of specClause tells a lens with none
// to go and find one, so a run invoked without one may still legitimately
// have verified criteria).
//
// This is a workflow script: it cannot import ledger-append.mjs's own
// wasNoSpecInPlay (this file's own header records that the sandboxed
// runtime rejects any import before a workflow script even starts), so this
// is a necessary, documented duplicate of that exported predicate. It now
// only shapes what is ASKED of synthesis (the prompt clause and required
// schema entry just below); the actual data guarantee -- spec_bugs and
// spec_bug_count read null, never a measured zero, on a no-spec run -- is
// enforced unconditionally further down, regardless of what synthesis
// actually returned.
const noSpecWasInPlay = !specPath && acVerdicts.length === 0
const NO_SPEC_SENTENCE = 'No spec was supplied, so findings are not anchored to any acceptance criterion.'

// ---- the reviewed-tip check: mechanical, fail-closed ----
// Every lens must state the sha its findings came from, and it must be the tip
// this run pinned. An ABSENT value is treated as a mismatch, never as
// agreement: "no sha reported" and "the right sha" are different claims, and
// collapsing them is the absence-reads-as-success shape this check exists to
// stop, reappearing inside the check itself.
//
// Fails the whole run rather than dropping one lens, matching ScopeStepFailed
// and the install-consistency refusal. A review of the wrong tree is not a
// partial review, it is a confident wrong answer, and the operator needs to
// know before they act on it rather than find a caveat in a coverage line.
//
// Two failure shapes, one check, because they are the same defect wearing
// different clothes. A lens can measure the WRONG tree, or it can vanish
// entirely -- a response that fails schema validation is dropped to null by the
// runtime and filtered out above, so a lens that was dispatched and produced
// nothing usable leaves a review that simply has one fewer opinion in it, with
// no sign anything is missing. Found while testing the sha check: the fixture
// that omitted the field did not trip the mismatch branch, because the lens
// never made it into lensReports at all.
const reported = new Set(lensReports.map(r => r.lens))
const vanished = lenses.filter(l => !reported.has(l))

// Both sides are model-transcribed from `git rev-parse HEAD`, so compare them
// as shas rather than as strings (review A). Raw !== rejected the short sha git
// log prints, an uppercase sha, a trailing newline (the literal output of a
// shell capture) and a leading space -- four spellings of the CORRECT commit,
// each aborting a run after the whole multi-lens budget was already spent.
// That is the flaky shape from CLAUDE.md section 11, inside a guard written to
// fix a different one.
//
// A prefix of at least 7 hex characters is git's own abbreviation floor, so
// this accepts what git prints and nothing looser: 'abcde' is still refused,
// and a genuinely different tree is still refused.
const normaliseSha = (v) => (typeof v === 'string' ? v.trim().toLowerCase() : null)
const pinnedSha = scopeSha  // the value validated at the boundary, not a second derivation of the raw one
// The PIN is model-transcribed too, and round-two review F2 found both failure
// modes rebuilt on this unguarded side. Measured: a 3-character pin let lenses
// on a DIFFERENT tree through with outcome=done, because the hex floor was
// applied only to the lens's value and the pin was then used as a bare prefix.
// And a pin of 'HEAD' -- a plausible answer to "return the output of git
// rev-parse HEAD" -- refused a run whose lenses were entirely correct, blaming
// a parallel session that did not exist. Checked here, before either
// comparison, and named as what it is: a scope failure, not a drift signal.
// Written as a single expression deliberately: `return` inside a helper here is
// indistinguishable, to the AC-QA-9 static guard, from a new exit path out of
// run() itself. That guard is a change detector for unpaired exits and is worth
// more than the readability of an early return.

// Split by CAUSE, because the two shapes need different remedies (review F).
// Telling an operator whose lens merely crashed to "let a parallel session
// settle" sends them after a cause that does not exist.
const pinnedTree = scopeTree  // likewise
const treeAgrees = (v) => ((got) => Boolean(got) && /^[0-9a-f]{7,40}$/.test(got)
  && (got.length <= pinnedTree.length ? pinnedTree.startsWith(got) : got.startsWith(pinnedTree)))(normaliseSha(v))

// THE GATE is the tree hash only (round-two review F3 and F4, arbitrated).
//
// F3: gating on head_sha_measured could not fail for the case it was built for.
// The pinned sha is printed in line one of the prompt, so a lens that reviewed
// the wrong tree and echoed it passed. The tree hash of the pinned commit is
// not in the prompt and cannot be reconstructed without the object.
//
// F4: and the sha must NOT be gated, because the prompt legitimately allows a
// lens to diff against the pinned sha without moving its checkout. Gating on
// "git rev-parse HEAD in the tree you read" would abort correct runs on exactly
// the drift path this change exists to handle. Mandating a checkout instead is
// worse: these worktrees can be shared, and moving one under another session is
// the original incident.
//
// So head_sha_measured is RECORDED and never gated. That also fixes the
// incentive the previous version created: it attached an aborted run to an
// honest answer, which is the wrong thing to attach to a self-report.
//
// Honest limitation, stated because the comment above could read as stronger
// than it is: this proves the lens had the reviewed commit's object available,
// not that every finding was derived from that tree. It closes the echo, which
// was the hole; it does not make a self-report into an observation.
// MED-2: the prompt promises head_sha_measured is RECORDED. It was demanded from
// every lens on every run and recorded nowhere, which made the sentence beside
// it false and wasted the only honest drift signal the harness has. Recorded
// here, per lens, for the lenses whose checkout differed from the reviewed tip.
// Drift is counted rather than pressured out: it never fails a run.
lensCheckoutDrift = Object.fromEntries(
  lensReports
    .filter(r => normaliseSha(r.head_sha_measured) && normaliseSha(r.head_sha_measured) !== pinnedSha)
    .map(r => [r.lens, normaliseSha(r.head_sha_measured)])
)

const wrongTree = lensReports.filter(r => !treeAgrees(r.head_tree_measured))
if (wrongTree.length) {
  throw new Error(
    `ReviewedTipMismatch: this run pinned ${pinnedSha}, but ` +
    wrongTree.map(r => `${r.lens} reported the reviewed tip's tree as ` +
      `${normaliseSha(r.head_tree_measured) || 'nothing'}, not ${pinnedTree}`).join('; ') +
    `. A review of a different tree reads exactly like a review of the reviewed one, so the run is refused rather ` +
    `than reported with a caveat. If a parallel session is advancing this branch, let it settle and re-run.`
  )
}
if (vanished.length) {
  throw new Error(
    `LensProducedNoReport: ${vanished.join(', ')} ${vanished.length === 1 ? 'was' : 'were'} dispatched but returned ` +
    `no usable report, so ${vanished.length === 1 ? 'its' : 'their'} share of this review did not happen and the ` +
    `remaining verdicts cover less than they appear to. This is a lens failure, NOT a checkout problem. Re-run the ` +
    `review cycle, or re-run just the missing work with {lenses: ["${vanished.join('", "')}"]}. The findings the ` +
    `other lenses did report are already recorded in this round's ledger line.`
  )
}

// AC-SIMP constraints are mechanical: checked directly against the diff, not by an agent lens (harness rule)
let simpCheck = null
if (specPath) {
  simpCheck = await agent(
    `Read ${specPath}. If it contains AC-SIMP-<n> acceptance criteria, check each one mechanically against ` +
    `\`git diff ${base}...${scopeSha}\` (they are constraints like "no new dependency", "no new setting", "no abstraction for a single call site"). ` +
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
  (priorFindings ? `PRIOR-ROUND FINDINGS (JSON), reported open going into this round:\n${JSON.stringify(priorFindings, null, 1)}\n\n` : '') +
  (simpCheck ? `AC-SIMP MECHANICAL CHECK:\n${simpCheck}\n\n` : '') +
  `Produce the single synthesised review report, in markdown:\n` +
  `1. A verdict table: one row per lens with its verdict and its "could not check" statement.\n` +
  `2. Findings merged and deduplicated (same defect from two lenses is one finding credited to both), ordered by severity ` +
  `(Critical, High, Medium, Low). Keep each finding's location, evidence, consequence, fix and recurrence (whether more ` +
  `instances of the same class are expected elsewhere).\n` +
  `3. Conflicts between lenses arbitrated by the precedence order: irrecoverable data loss, security, accessibility floor, ` +
  `operability, product and design intent, performance. A tie ABOVE the accessibility line is marked ESCALATE for the human, ` +
  `never resolved silently.\n` +
  `4. ${specPath ? 'AC verdict summary, and any finding with no AC behind it flagged as a SPEC BUG.' : 'AC verdict summary if the lenses found a spec; otherwise state this sentence verbatim: "' + NO_SPEC_SENTENCE + '"'}\n` +
  `5. A closing line: overall CLEAN / FINDINGS / BLOCKED and what must happen before push.\n` +
  `Do not soften findings and do not invent any. If a lens returned BLOCKED, say so prominently. ` +
  // M1 (fix round 3, D4): asking for spec_bugs at all only makes sense when a
  // spec was actually in play -- with none, EVERY finding has no AC behind
  // it, so asking synthesis to classify spec bugs here would just re-invite
  // the exact conflation decision 4 exists to remove, one field upstream of
  // where it used to be caught.
  (noSpecWasInPlay
    ? `Also return rejected_findings (findings investigated and shown to be false alarms) as a structured array, each ` +
      `item carrying lens, location and claim, so capture is mechanical rather than left in the prose. There is no spec ` +
      `in play for this run, so do not classify any finding as a spec bug -- report every other finding as an ordinary ` +
      `open finding instead. `
    : `Also return spec_bugs (findings with no AC behind them) and rejected_findings (findings investigated and shown to ` +
      `be false alarms) as structured arrays, each item carrying lens, location and claim, so capture is mechanical ` +
      `rather than left in the prose. `
  ) +
  (priorFindings
    ? `Also return fixed_findings: for each PRIOR-ROUND FINDING above that this built change genuinely resolves, echo its ` +
      `lens, location and claim EXACTLY as given above -- copy them, do not paraphrase. Only ever echo an entry that ` +
      `appears above: a fixed_findings entry that does not match one of the prior findings verbatim is dropped and ` +
      `counted, never recorded as fixed. This records a lens CONFIRMING a previously reported finding is resolved in the ` +
      `built change, not proof of repair -- when in doubt, leave it out of fixed_findings; a finding that stays open is ` +
      `the safe direction, a false confirmation is not. `
    : '') +
  (snapBefore ? `Also return snapshot_after. ${snapshotAfterAsk(snapBefore.file)} Read-only: change nothing. ` : '') +
  `Also run \`git rev-parse HEAD\` in the repo NOW, at synthesis time, and return its exact output as ` +
  `head_sha_at_synthesis. This is not the sha you were told about: several agent sessions share these checkouts, and if ` +
  `another one switches branches mid-run the review would silently be about a different tree than it reports on. Report ` +
  `what git says now, even if it differs from anything above. Return only the markdown report as "report".`,
  {
    label: 'synthesis',
    phase: 'Synthesis',
    schema: {
      type: 'object',
      // M1 (fix round 3): spec_bugs is required only when a spec was in
      // play; the prompt clause above does not even ask for it otherwise, so
      // requiring it unconditionally would enforce a field this run's own
      // instructions never mentioned.
      required: noSpecWasInPlay ? ['report', 'rejected_findings'] : ['report', 'spec_bugs', 'rejected_findings'],
        // Optional: absent means "not reported", which must never be read as
        // "did not move" -- absent evidence is not evidence (see the guard below).

      properties: {
        report: { type: 'string' },
        head_sha_at_synthesis: { type: ['string', 'null'] },
        spec_bugs: { type: 'array', items: { type: 'object', required: ['lens', 'location', 'claim'], properties: { lens: { type: 'string' }, location: { type: 'string' }, claim: { type: 'string' }, ac_id: { type: ['string', 'null'] } } } },
        rejected_findings: { type: 'array', items: { type: 'object', required: ['lens', 'location', 'claim'], properties: { lens: { type: 'string' }, location: { type: 'string' }, claim: { type: 'string' }, ac_id: { type: ['string', 'null'] } } } },
        // specs/record-fixed-findings.md (AC-2): optional, never required --
        // a caller that never supplied prior_findings is unaffected, and an
        // older synthesis response with no such field is read as null below,
        // never as "confirmed nothing" (which would be indistinguishable
        // from a genuine empty confirmation).
        fixed_findings: { type: 'array', items: { type: 'object', required: ['lens', 'location', 'claim'], properties: { lens: { type: 'string' }, location: { type: 'string' }, claim: { type: 'string' }, ac_id: { type: ['string', 'null'] } } } },
        // HARN-OPT-5 T4 (AC-SEC-12): optional, so an older response validates.
        snapshot_after: SNAPSHOT_SCHEMA,
      },
    },
  }
)

// HARN-OPT-5 T4 (AC-SEC-12, AC-QA-27): never by lens self-report. Reports only; nothing is deleted, moved or overwritten.
// Fix round 3 (conductor measurement: 6638 files, 1.2 MB): the comparison is now the LIBRARY's measurement
// (`stray-snapshot.mjs diff`, with the bidirectional, hash-aware and XY-decided rules of rounds 1 and 2), and this
// script's role is validation and rendering. It checks both shapes and that the diff was made against the before
// file it asked about (the rollups agree); a mismatch is could-not-be-made, never a rendered comparison.
// 'unchecked' (null) stays distinct from 'checked clean' ([]).
const strayWrites = []
let retainedWorktrees = []
let hashedCounts = null
let strayNote = null
let strayChecked = false
const snapDiff = parseDiffObj(synthesis && synthesis.snapshot_after)
// 'a snapshot was missing' is the round 1 wording, kept verbatim because an existing test pins it exactly.
const couldNot = (why) => `The before/after comparison of the main checkout and ~/.claude/workflows/ could not be made (${why}), so stray writes by lenses are unchecked.`
if (!snapBefore) {
  strayNote = couldNot('a snapshot was missing')
} else if (!snapDiff) {
  strayNote = couldNot('a snapshot was missing')
} else if (snapDiff.before_rollup !== snapBefore.rollup) {
  strayNote = couldNot('its before_rollup did not match the rollup of the before-snapshot, so it was made against a different file')
} else {
  strayChecked = true
  for (const c of snapDiff.changes) strayWrites.push({ path: c.path, change: c.change, shadows_installed_workflow: c.shadows_installed_workflow })
  if (Array.isArray(snapDiff.retained_worktrees)) retainedWorktrees = snapDiff.retained_worktrees.filter(p => typeof p === 'string')
  const h = snapDiff.hashed
  if (h && Number.isInteger(h.repo) && Number.isInteger(h.home)) hashedCounts = h
}
// The header says what was compared and by whom, that the review itself removed or restored nothing, and how
// many files were hashed. A change inside a file that git already lists as dirty, outside the hashed set, shows only
// if its XY code moves.
// Fix round 4 (review round 3 L2): a path is whatever a lens planted, and the renderer is the one place it reaches
// markdown. Control characters (a newline would start a new report line, a heading, a verdict) are rendered as their
// \uXXXX escape; the structured stray_writes field carries the path verbatim.
const showPath = (p) => p.replace(/[\u0000-\u001f\u007f]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))
const strayReport = (strayNote
  ? `\n\n### STRAY WRITES\n${strayNote}`
  : strayWrites.length
    ? `\n\n### STRAY WRITES\nMeasured by the stray-snapshot library, not by an agent: these paths differ between the start and the end of the lens phase, by every git status entry of the main checkout and by the hash (sha256) of the files in the harness-loaded locations (the repo .claude/ settings, hooks, agents, skills, workflows and commands, .githooks/, bin/, .github/workflows/, the shared .git/ config, hooks and info, and ~/.claude/ settings, CLAUDE.md, agents, skills, hooks, workflows, commands, bin and plugins)` +
      (hashedCounts ? `; ${hashedCounts.repo} repo files${Number.isInteger(hashedCounts.git) ? `, ${hashedCounts.git} git-directory files` : ''} and ${hashedCounts.home} home files were hashed` : '') +
      `. The review itself removed or restored nothing; review each by hand.\n` +
      strayWrites.map(w => `- ${showPath(w.path)} (${w.change})${w.shadows_installed_workflow ? ' (a repo-local workflow copy: it will shadow the installed workflow of the same name)' : ''}`).join('\n')
    : '') +
  (retainedWorktrees.length ? `\n\nLens worktree retained: ${retainedWorktrees.map(showPath).join(', ')} (harness-owned, not a stray write).` : '')

// A synthesis response missing the required structured fields (e.g. an
// older or misbehaving agent that only returned prose) must not silently
// masquerade as "zero spec bugs, zero rejected findings": null means
// unmeasured, distinguishable from a genuine zero (AC-QA-13, AC-OPS-3).
// The raw descriptor arrays are kept here and turned into finding ids when the
// terminal payload is built (HARN-OPT-6); only the ids reach the ledger.
synthesisHeadSha = synthesis && typeof synthesis.head_sha_at_synthesis === 'string' ? synthesis.head_sha_at_synthesis : null
specBugsRaw = synthesis && Array.isArray(synthesis.spec_bugs) ? synthesis.spec_bugs : null
rejectedFindingsRaw = synthesis && Array.isArray(synthesis.rejected_findings) ? synthesis.rejected_findings : null
specBugCount = specBugsRaw ? specBugsRaw.length : null

// specs/harn-ledger-validators.md D4. The synthesis prompt asks for
// "spec_bugs (findings with no AC behind them)". On a review where no spec was
// in play, EVERY finding has no AC behind it, so every one comes back
// classified spec_bug. Measured in a delivery repo: 28 of 45 findings (62%)
// filed that way on runs whose spec is null. A missing spec is a PROCESS
// signal; a spec bug is a QUALITY signal about a spec that exists. Merged, the
// second is unusable, and the delivery report's "spec bugs by lens" table has
// been dominated by runs that never had a spec to have a bug in.
//
// The trigger is computed HERE, from observable state, rather than from the
// invocation argument: the no-spec branch of specClause tells a lens to go and
// FIND a spec under specs/, so a run invoked without one may still legitimately
// have verified criteria. "No spec was in play" therefore means BOTH that no
// spec path was supplied AND that no lens returned any ac_verdicts.
//
// The findings are real; only the classification was wrong. They move to
// open_findings rather than being dropped -- dropping what cannot be
// classified, and reporting the remainder as the whole, is the defect this
// entire spec exists to fix.
//
// specBugCount goes to null, not 0: null is "not measured", 0 is "measured as
// none", and this codebase distinguishes those everywhere else.
//
// M1 (fix round 3): this used to be gated on `specBugsRaw.length > 0`, so an
// EMPTY spec_bugs array on a no-spec run -- the most common no-spec outcome,
// since there is no spec to have found a bug in -- never reached the null-out
// below and stayed at the 0 already computed above, reading identically to a
// run that HAD a spec and found zero bugs in it. Unconditional on
// noSpecWasInPlay now: an empty array and a populated one are the SAME "not
// measured" case, so both null out the same way. Only the merge into
// openFindingsRaw stays conditional on there being anything to merge.
if (noSpecWasInPlay) {
  if (specBugsRaw && specBugsRaw.length > 0) {
    openFindingsRaw = openFindingsRaw.concat(specBugsRaw)
  }
  // null, not []: ledger-append recomputes spec_bug_count from the array it
  // receives, so an empty array makes the LEDGER say 0 ("we looked, there were
  // none") while this file's own telemetry says null ("not measurable"). With
  // no spec in play the honest answer is the second, in both places.
  specBugsRaw = null
  specBugCount = null
}
rejectedFindingCount = rejectedFindingsRaw ? rejectedFindingsRaw.length : null
// specs/record-fixed-findings.md (AC-2): same null-vs-absent handling as
// spec_bugs/rejected_findings above. The id guard itself (AC-3) runs in
// ledger-append.mjs, against priorFindings' own ids -- this file only
// carries both raw arrays through unmapped.
fixedFindingsRaw = synthesis && Array.isArray(synthesis.fixed_findings) ? synthesis.fixed_findings : null

// M1: outcome was computed purely from lens verdicts, so a run whose
// synthesis agent failed or returned nothing usable (undefined, or a
// non-string/empty "report") was still recorded as "done" -- with an empty
// report, inflating the denominator of "rounds to clean" (the spec's
// headline measure) and giving the operator no visible sign the run
// actually produced nothing.
const reportOk = synthesis && typeof synthesis.report === 'string' && synthesis.report.length > 0
const outcome = !reportOk ? 'aborted' : lensReports.some(r => r.verdict === 'BLOCKED') ? 'blocked' : 'done'

return {
  base,
  head: scopeSha,
  lenses,
  skipped,
  verdicts: Object.fromEntries(lensReports.map(r => [r.lens, r.verdict])),
  // HARN-OPT-4 T4 (AC-QA-12, AC-OPS-4): appended in code so the guarantee does
  // not rest on synthesis obeying its prompt. Only when the run produced a report.
  report: reportOk ? ((installOverrideNotice ? `> ${installOverrideNotice}\n\n${synthesis.report}` : synthesis.report) + (noSpecWasInPlay && !String(synthesis.report).includes(NO_SPEC_SENTENCE) ? `\n\n${NO_SPEC_SENTENCE}` : '') + strayReport) : (snapBefore && (strayNote || strayWrites.length) ? strayReport.trim() : ''),  // fix round 4 (L1): a measured stray survives an aborted run
  stray_writes: strayChecked ? strayWrites : null,
  __outcome: outcome,
}

} // end run()

// HARN-OPT-6 (AC-SEC-1, AC-ARCH-9): finding ids are computed HERE, so the
// ledger payload carries ids and never finding text. Workflow scripts have no
// node:crypto, TextEncoder, atob or btoa (measured in the fake runtime, AC-QA-8),
// so this is a pure-JS SHA-256. It lives outside every block the static checks
// pin byte-identical across the three workflows, because only review-cycle
// produces findings (AC-SIMP-3).
const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]
// UTF-8 exactly as Node's Buffer.from(str, 'utf8') produces it. Differs from
// toBase64's encoder on one input: an unpaired surrogate is U+FFFD (EF BF BD)
// here, as Node encodes it, where toBase64 emits the invalid ED A0 80. The ids
// already in the ledger were hashed by Node, so this must agree with Node.
function utf8Bytes(input) {
  const bytes = []
  for (const ch of String(input)) {
    let cp = ch.codePointAt(0)
    if (cp >= 0xd800 && cp <= 0xdfff) cp = 0xfffd
    if (cp < 0x80) bytes.push(cp)
    else if (cp < 0x800) bytes.push(0xc0 | (cp >> 6), 0x80 | (cp & 63))
    else if (cp < 0x10000) bytes.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63))
    else bytes.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63))
  }
  return bytes
}
function sha256Hex(input) {
  const bytes = utf8Bytes(input)
  const byteLength = bytes.length
  bytes.push(0x80)
  while (bytes.length % 64 !== 56) bytes.push(0)
  const bitsHigh = Math.floor(byteLength / 0x20000000)
  const bitsLow = (byteLength * 8) >>> 0
  bytes.push(bitsHigh >>> 24, (bitsHigh >>> 16) & 255, (bitsHigh >>> 8) & 255, bitsHigh & 255, bitsLow >>> 24, (bitsLow >>> 16) & 255, (bitsLow >>> 8) & 255, bitsLow & 255)
  const h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]
  const w = new Array(64)
  const rotr = (x, n) => (x >>> n) | (x << (32 - n))
  for (let offset = 0; offset < bytes.length; offset += 64) {
    for (let i = 0; i < 16; i++) {
      const j = offset + i * 4
      w[i] = ((bytes[j] << 24) | (bytes[j + 1] << 16) | (bytes[j + 2] << 8) | bytes[j + 3]) | 0
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3)
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10)
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0
    }
    let [a, b, c, d, e, f, g, hh] = h
    for (let i = 0; i < 64; i++) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + SHA256_K[i] + w[i]) | 0
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0
      hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0
    }
    h[0] = (h[0] + a) | 0; h[1] = (h[1] + b) | 0; h[2] = (h[2] + c) | 0; h[3] = (h[3] + d) | 0
    h[4] = (h[4] + e) | 0; h[5] = (h[5] + f) | 0; h[6] = (h[6] + g) | 0; h[7] = (h[7] + hh) | 0
  }
  return h.map(x => (x >>> 0).toString(16).padStart(8, '0')).join('')
}
// The id every finding has carried since ledger-append.mjs first wrote one:
// sha256 over lens, normalised location and claim, first 16 hex characters.
// Hashed from the ORIGINAL lens label, so compound-labelled ids do not change.
function findingId(lens, location, claim) {
  return sha256Hex(String(lens || '') + ' ' + String(location || '').trim().toLowerCase() + ' ' + String(claim || '')).slice(0, 16)
}

// HARN-OPT-6 (AC-SEC-2, AC-SEC-4): a lens-authored label reaches the ledger
// payload only as a value this script has checked against the same closed
// shapes ledger-append.mjs validates (LENS_PATTERN_STR, AC_ID_PATTERN_STR, the
// severity and verdict enums, ROSTER_LENSES), or as null. Each neutralisation is
// counted in the counter the writer has always used for it; the rejected text
// is not kept anywhere (no *_raw sibling).
const PAYLOAD_LENS_RE = /^(lens|reviewer)-[a-z]+$/
const PAYLOAD_AC_ID_RE = /^(?:(?<prefix>[A-Za-z0-9_.-]{1,40})(?<sep>[ /]))?(?<ac>AC-[A-Z][A-Z0-9]{0,15}-[0-9]{1,6})$/
const PAYLOAD_ROSTER_LENSES = [
  'lens-security', 'lens-qa', 'lens-simplicity', 'lens-product', 'lens-design',
  'lens-accessibility', 'lens-architecture', 'lens-data', 'lens-operability',
  'reviewer-verification', 'reviewer-experience',
]
const PAYLOAD_SEVERITIES = ['Critical', 'High', 'Medium', 'Low']
const PAYLOAD_VERDICTS = ['PASS', 'FAIL', 'UNVERIFIABLE']
const payloadDrops = { ac_ids: 0, finding_fields: 0, record_values: 0 }
// AC-SEC-2: round_key and lens_checkout_drift values are commit hashes. The
// drift values come from lens self-reports, so a non-conforming one is dropped
// (the writer's schema takes strings only) and counted, never emitted.
const PAYLOAD_SHA_RE = /^[0-9a-f]{7,64}$/
function payloadRoundKey(value) {
  if (value === null || value === undefined) return null
  if (typeof value === 'string' && PAYLOAD_SHA_RE.test(value)) return value
  payloadDrops.record_values += 1
  return null
}
function payloadCheckoutDrift(drift) {
  const out = {}
  for (const [lens, sha] of Object.entries(drift || {})) {
    if (PAYLOAD_LENS_RE.test(lens) && typeof sha === 'string' && PAYLOAD_SHA_RE.test(sha)) out[lens] = sha
    else payloadDrops.record_values += 1
  }
  return out
}
function payloadLens(label, count = true) {
  if (typeof label === 'string' && PAYLOAD_LENS_RE.test(label)) return label
  if (typeof label === 'string') {
    const inspected = label.slice(0, 256)
    if (!/[\u0000-\u001f\u007f`|]/.test(inspected)) {
      for (const segment of inspected.split(/\+|,|\s+and\s+/)) {
        const name = segment.trim()
        if (PAYLOAD_ROSTER_LENSES.includes(name)) return name
      }
    }
  }
  if (count) payloadDrops.finding_fields += 1
  return null
}
function payloadSeverity(value, count = true) {
  const severity = value || 'Low'
  if (PAYLOAD_SEVERITIES.includes(severity)) return severity
  if (count) payloadDrops.finding_fields += 1
  return null
}
function payloadAcId(value, count = true) {
  if (value === null || value === undefined || value === '') return null
  if (typeof value === 'string' && PAYLOAD_AC_ID_RE.test(value)) return value
  if (count) payloadDrops.ac_ids += 1
  return null
}
// One descriptor in, one {id, lens, severity, ac_id, disposition} entry out.
// A descriptor that is not an object, or lacks a string lens, location or claim,
// is dropped and counted rather than hashed from empty strings (AC-QA-10).
function findingEntry(descriptor, disposition, count = true) {
  if (!descriptor || typeof descriptor !== 'object' || typeof descriptor.lens !== 'string' || typeof descriptor.location !== 'string' || typeof descriptor.claim !== 'string') {
    if (count) payloadDrops.record_values += 1
    return null
  }
  return {
    id: findingId(descriptor.lens, descriptor.location, descriptor.claim),
    lens: payloadLens(descriptor.lens, count),
    severity: payloadSeverity(descriptor.severity, count),
    ac_id: payloadAcId(descriptor.ac_id, count),
    disposition,
  }
}
// {descriptor, entry} pairs for the descriptors that survive findingEntry.
function findingPairs(descriptors, disposition) {
  if (!Array.isArray(descriptors)) return []
  return descriptors.map(descriptor => ({ descriptor, entry: findingEntry(descriptor, disposition) })).filter(pair => pair.entry)
}
// The prior-id guard (AC-ARCH-8): a supplied id must equal the id recomputed
// from that entry's own lens, location and claim. Only verified ids travel, as
// disposition 'prior' entries the writer reconciles against; the count of the
// rest is the one place invalid_prior_ids_dropped is computed.
function verifiedPriorEntries(prior) {
  const entries = []
  let invalid = 0
  for (const p of prior) {
    const safe = p && typeof p === 'object' ? p : {}
    if (typeof safe.id === 'string' && safe.id === findingId(safe.lens, safe.location, safe.claim)) {
      entries.push({ id: safe.id, lens: payloadLens(safe.lens, false), severity: payloadSeverity(safe.severity, false), ac_id: payloadAcId(safe.ac_id, false), disposition: 'prior' })
    } else {
      invalid += 1
    }
  }
  return { entries, invalid }
}
function payloadAcVerdicts(verdicts) {
  return verdicts.map(v => {
    const acId = payloadAcId(v && v.ac_id)
    // An explicit or implied null ac_id is as suspect as a malformed one: a
    // verdict always concerns a criterion. The writer counts it the same way.
    if (!v || v.ac_id === null || v.ac_id === undefined) payloadDrops.ac_ids += 1
    const verdict = v && PAYLOAD_VERDICTS.includes(v.verdict) ? v.verdict : null
    if (verdict === null) payloadDrops.record_values += 1
    return { ac_id: acId, verdict }
  })
}

// Start/terminal record protocol (AC-DATA-5): see tdd-task.js for the same
// pattern and its rationale.
// HARN-OPT-4 T8 (AC-QA-28, AC-DATA-17): budget.spent() is SESSION-CUMULATIVE
// (probe recorded in the plan's Conductor log, tick 33), so a running total
// written as budget_spent says nothing about this run. Read it once here,
// BEFORE the started write, and once for the terminal row; the row carries end
// minus start. Null (never the end reading, never a negative number) when
// either reading is unmeasured or the counter went backwards (a reset).
const budgetAtStart = readBudgetSpent()
function budgetSpentDelta() {
  const end = readBudgetSpent()
  return budgetAtStart !== null && end !== null && end >= budgetAtStart ? end - budgetAtStart : null
}
const startWrite = await writeLedger({ kind: 'review_cycle', outcome: 'started', spec: specPath, ...roundField })
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
const payloadRoundKeyValue = payloadRoundKey(headSha)
const payloadDriftValue = payloadCheckoutDrift(lensCheckoutDrift)
const telemetry = {
  outcome: __outcome || 'aborted',
  spec: specPath,
  ...roundField,
  round_key: payloadRoundKeyValue,
  lenses_run: result.lenses || lensesRunRaw,
  lenses_skipped: result.skipped || [],
  trigger_counts: triggerCounts,
  lens_checkout_drift: payloadDriftValue,
  // Omitted entirely, not written as null, when lens-architecture did not run
  // (review I). ledger-append.mjs has additionalProperties:false, so a NEW
  // workflow writing to an OLDER installed copy of that library has its whole
  // record rejected, not just this field -- losing 100% of review telemetry,
  // which this repo has been bitten by before. Omitting keeps an old writer
  // accepting the line unchanged, and "key absent" already means "the lens did
  // not run", so nothing is lost.
  ...(architectureTriggerSource ? { architecture_trigger_source: architectureTriggerSource } : {}),
  verdicts: result.verdicts || {},
  spec_bug_count: specBugCount,
  rejected_finding_count: rejectedFindingCount,
  budget_spent: budgetSpentDelta(),
  // H4: already shaped as {ac_id, verdict} pairs (see acVerdicts above) and
  // rides in telemetry proper. The terminal entry below replaces it with the
  // sanitised copy (HARN-OPT-6: ac_id and verdict reach the ledger payload only
  // as values this script has checked, or null).
  ac_verdicts: acVerdicts,
  // AC-OPS-2: which rule source governed lens triggering on this run, so a
  // later reader of this ledger can report how often overrides are in force
  // and detect a repo whose tuning silently stopped arriving across runs.
  // null on a run that never reached the scope validation (e.g. the scope
  // agent itself failed), distinguishable from a genuine "harness defaults"
  // measurement.
  rule_source: ruleSource,
  rule_source_overridden_keys: ruleSourceOverriddenKeys,
}
// HARN-OPT-6 (AC-SEC-1, AC-ARCH-4): the payload carries finding IDS only, in
// one id-bearing key (finding_entries) that a writer predating HARN-OPT-6
// refuses by name, so a mixed-version install fails loudly instead of landing
// a row that silently lost its findings. Descriptor text (lens, location,
// claim, evidence) never leaves this script. Ids are computed here from the
// original descriptors; labels are resolved or nulled here, and every
// neutralisation is counted in the existing counters. ledger-append.mjs
// reconciles the fixed confirmations against the verified prior ids and
// truncates at MAX_FINDINGS; neither is repeated here (AC-ARCH-8, AC-ARCH-9).
const specBugPairs = findingPairs(specBugsRaw, 'spec_bug')
const rejectedPairs = findingPairs(rejectedFindingsRaw, 'rejected')
const openPairs = findingPairs(openFindingsRaw, 'open')
const fixedPairs = findingPairs(fixedFindingsRaw, 'fixed')
const priorVerified = priorFindings ? verifiedPriorEntries(priorFindings) : null
const payloadAcVerdictList = payloadAcVerdicts(acVerdicts)
{
  // AC-OPS-6: one line naming each non-zero count and its reason, only when
  // something was dropped, the way invalid_ac_ids_dropped is logged.
  // invalid_fixed_ids_dropped and duplicate_fixed_ids_dropped are not in this
  // line: the writer computes them while reconciling fixed_findings against the
  // verified prior ids, and the pinned writeLedger response carries only
  // run_id, ts, write_ok, write_error and invalid_ac_ids_dropped, so this script
  // never sees them. They are on the ledger row itself.
  const drops = [
    [priorVerified ? priorVerified.invalid : 0, 'invalid_prior_ids_dropped', 'a prior_findings entry whose id did not match the id recomputed from its own lens, location and claim'],
    [payloadDrops.ac_ids, 'invalid_ac_ids_dropped', 'a non-conforming ac_id was nulled'],
    [payloadDrops.finding_fields, 'invalid_finding_fields_dropped', 'a non-conforming lens or severity was nulled'],
    [payloadDrops.record_values, 'invalid_record_values_dropped', 'a malformed descriptor was dropped or a non-conforming verdict was nulled'],
  ].filter(([n]) => n > 0)
  if (drops.length) log(`Run ${startRunId || 'unknown'}: ${drops.map(([n, name, why]) => `${name}=${n} (${why})`).join('; ')}`)
}
const terminalEntry = {
  kind: 'review_cycle',
  finding_entries: [...specBugPairs, ...rejectedPairs, ...openPairs, ...fixedPairs].map(pair => pair.entry).concat(priorVerified ? priorVerified.entries : []),
  ...telemetry,
  ac_verdicts: payloadAcVerdictList,
  invalid_ac_ids_dropped: payloadDrops.ac_ids,
  invalid_finding_fields_dropped: payloadDrops.finding_fields,
  invalid_record_values_dropped: payloadDrops.record_values,
  // Baselines, not counts: a number here tells the writer that fixed_findings
  // was supplied this round, so it reports its own reconciliation drops
  // against a real 0 rather than null.
  ...(fixedFindingsRaw ? { invalid_fixed_ids_dropped: 0, duplicate_fixed_ids_dropped: 0 } : {}),
  ...(priorVerified ? { invalid_prior_ids_dropped: priorVerified.invalid } : {}),
}
if (startRunId) terminalEntry.run_id = startRunId
// HARN-OPT-4 T8 (T4 round 3 L1, AC-DATA-2): same shape as tdd-task.js's T5
// retry. An installed writer older than this file refuses a key it does not
// know as "not an allowed property", which would cost the whole terminal row.
// Retry ONCE without that key (never kind, outcome or run_id) so the row still
// lands; any other refusal, and a refusal of the retry, is final and reported
// by the write_ok:false consumer below. budget_spent needs no such retry: it
// is an existing field and null is already accepted by every installed writer.
let terminalWrite = await writeLedger(terminalEntry)
const refusedKey = terminalWrite.write_ok ? null : (/(?:^|[^\w.\[\]])([A-Za-z_]\w*): not an allowed property/.exec(String(terminalWrite.write_error)) || [])[1]
if (refusedKey && !['kind', 'outcome', 'run_id', 'finding_entries'].includes(refusedKey) && Object.hasOwn(terminalEntry, refusedKey)) {
  log(`Terminal ledger write refused ${refusedKey} (installed writer predates it); retrying once without it: ${redactLogText(String(terminalWrite.write_error))}`)
  const { [refusedKey]: _refused, ...retryEntry } = terminalEntry
  terminalWrite = await writeLedger(retryEntry)
}
// HARN-OPT-6 (AC-PROD-1, AC-ARCH-6): result.open_findings is built from the
// ids computed in this script, so it is an array whether or not the ledger
// write landed. Each element is the original descriptor plus its id, in the
// same order as the 'open' entries on the payload; a caller passes this exact
// array, untouched, as next round's prior_findings. An empty array means this
// round produced no open findings.
result.open_findings = openPairs.map(pair => ({ ...pair.descriptor, id: pair.entry.id }))
// 2026-08-18: give write_ok:false a CONSUMER -- see plan-cycle.js for the
// full rationale. It was computed, logged and returned to nobody, so the
// ledger stopped recording on 2026-08-12 and nothing noticed for six days.
// AC-QA-7 still holds: this reports, it never throws. What AC-QA-7 does not
// say is that the failure may be indistinguishable from success.
// 2026-08-18: did the tree move under this review? Only a REPORTED sha that
// DIFFERS counts. A missing sha means the synthesis agent did not answer, which
// is not evidence of stability -- reading absence as "unmoved" is exactly the
// shape that has recurred through this repo's history.
// Normalised, not raw !== (round-two review F5). This is the SAME defect the
// reviewed-tip gate fixed one screen above, left in its sibling: both values
// are model-transcribed, so the benign spellings enumerated there (short sha,
// uppercase, trailing newline from a shell capture) each set this flag and told
// the operator their correct review might be about a different tree. A drift
// alarm that fires for reasons unrelated to drift is worse than none.
const sameSha = (a, b) => {
  const x = typeof a === 'string' ? a.trim().toLowerCase() : null
  const y = typeof b === 'string' ? b.trim().toLowerCase() : null
  return Boolean(x) && Boolean(y) && (x.length <= y.length ? y.startsWith(x) : x.startsWith(y))
}
const checkoutMoved = Boolean(headSha && synthesisHeadSha && !sameSha(synthesisHeadSha, headSha))
if (checkoutMoved) {
  result.checkout_moved = true
  result.checkout_moved_detail = `scoped at ${headSha}, synthesis found ${synthesisHeadSha} -- the working tree moved mid-review, so these findings may be about a different tree than they name. Re-run from an isolated worktree.`
  log(`CHECKOUT MOVED MID-REVIEW: scoped ${headSha}, synthesis ${synthesisHeadSha}. Another session may share this checkout. Treat these findings as unverified until re-run.`)
}
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
