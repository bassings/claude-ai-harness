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

// Ledger telemetry accumulators, populated inside run() as each value
// becomes available, read after run() resolves. Never part of the
// pre-existing, publicly-documented return shape (AC-ARCH-10).
const triggerCounts = {}
let headSha = null
// 2026-08-18: the sha git reports at SYNTHESIS time, so a checkout that moved
// mid-run is detectable. Several agent sessions share these checkouts; a
// planning lens once reported confidently on repo-local forks that had been
// merged away hours earlier, because it read a tree another session had
// switched to its own branch. Null means "not reported", never "did not move".
let synthesisHeadSha = null
// Raw finding descriptors ({lens, location, claim, severity?, ac_id?}), or
// null when the synthesis response was malformed. Passed to
// ledger-append.mjs as opaque data: workflow scripts have no node:crypto,
// so finding-id hashing (AC-QA-11) happens there, not here.
let specBugsRaw = null
let rejectedFindingsRaw = null
let specBugCount = null
let rejectedFindingCount = null
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
  `In the repo at the current working directory:\n` +
  `1. Determine the base ref: ${opts.base ? `use "${opts.base}".` : 'the repository default branch (usually main or master; check `git remote show origin` or local branch names).'}\n` +
  `2. Run \`git diff --name-status <base>...HEAD\` and return every changed file path with its status letter, plus the base ref you used and the exact output of \`git rev-parse HEAD\` as head_sha.\n` +
  `3. Report whether any dependency manifest (package.json, requirements*.txt, pyproject.toml, go.mod, Cargo.toml, Gemfile, or equivalent) gained a NEW entry (a new package, not a version bump), and whether the diff ADDS a new module or package (a new source file outside tests, or a new package directory).\n` +
  `4. Check whether a file .claude/harness-triggers.json exists at the repo root and report that as ` +
  `harness_triggers_file_exists (true/false). If it exists, return its parsed JSON as custom_rules; if it does not ` +
  `exist, custom_rules must be null.\n` +
  `Raw data only.`,
  {
    label: 'scope:diff',
    phase: 'Scope',
    effort: 'low',
    schema: {
      type: 'object',
      required: ['base', 'head_sha', 'files', 'new_dependency_entries', 'new_modules', 'custom_rules', 'harness_triggers_file_exists'],
      properties: {
        base: { type: 'string' },
        head_sha: { type: 'string' },
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
      },
    },
  }
)
if (!scope || !scope.files.length) return { report: 'No changes found between the base ref and HEAD. Nothing to review.', __outcome: 'no-op' }

headSha = scope.head_sha

const base = scope.base

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
const CUSTOM_RULE_KEYS = ['ui', 'data', 'architecture', 'operability']
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
if (archHit.length || scope.new_modules || scope.new_dependency_entries) {
  lenses.push('lens-architecture')
  // Honestly 0 when triggered purely by new_modules/new_dependency_entries
  // with no file matching the architecture globs: a real, measured zero,
  // not a stand-in borrowed from an unrelated rule group.
  triggerCounts['lens-architecture'] = archHit.length
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
log(`Reviewing ${paths.length} changed files against ${base} at ${scope.head_sha.slice(0, 8)}. Lenses: ${lenses.join(', ')}. Skipped (not triggered): ${skipped.join(', ') || 'none'}. Rule source: ${ruleSourceText}.`)

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
    .then(r => (r ? { lens, ...r } : null))
))
const lensReports = reports.filter(Boolean)
if (!lensReports.length) return { report: 'Every lens agent failed or was stopped; no review produced.', __outcome: 'aborted' }
lensesRunRaw = lensReports.map(r => r.lens)

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
  `(Critical, High, Medium, Low). Keep each finding's location, evidence, consequence, fix and recurrence (whether more ` +
  `instances of the same class are expected elsewhere).\n` +
  `3. Conflicts between lenses arbitrated by the precedence order: irrecoverable data loss, security, accessibility floor, ` +
  `operability, product and design intent, performance. A tie ABOVE the accessibility line is marked ESCALATE for the human, ` +
  `never resolved silently.\n` +
  `4. ${specPath ? 'AC verdict summary, and any finding with no AC behind it flagged as a SPEC BUG.' : 'AC verdict summary if the lenses found a spec; otherwise note that no spec existed, so every finding is unanchored to an AC.'}\n` +
  `5. A closing line: overall CLEAN / FINDINGS / BLOCKED and what must happen before push.\n` +
  `Do not soften findings and do not invent any. If a lens returned BLOCKED, say so prominently. ` +
  `Also return spec_bugs (findings with no AC behind them) and rejected_findings (findings investigated and shown to be ` +
  `false alarms) as structured arrays, each item carrying lens, location and claim, so capture is mechanical rather than ` +
  `left in the prose. Also run \`git rev-parse HEAD\` in the repo NOW, at synthesis time, and return its exact output as ` +
  `head_sha_at_synthesis. This is not the sha you were told about: several agent sessions share these checkouts, and if ` +
  `another one switches branches mid-run the review would silently be about a different tree than it reports on. Report ` +
  `what git says now, even if it differs from anything above. Return only the markdown report as "report".`,
  {
    label: 'synthesis',
    phase: 'Synthesis',
    schema: {
      type: 'object',
      required: ['report', 'spec_bugs', 'rejected_findings'],
        // Optional: absent means "not reported", which must never be read as
        // "did not move" -- absent evidence is not evidence (see the guard below).

      properties: {
        report: { type: 'string' },
        head_sha_at_synthesis: { type: ['string', 'null'] },
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
synthesisHeadSha = synthesis && typeof synthesis.head_sha_at_synthesis === 'string' ? synthesis.head_sha_at_synthesis : null
specBugsRaw = synthesis && Array.isArray(synthesis.spec_bugs) ? synthesis.spec_bugs : null
rejectedFindingsRaw = synthesis && Array.isArray(synthesis.rejected_findings) ? synthesis.rejected_findings : null
specBugCount = specBugsRaw ? specBugsRaw.length : null
rejectedFindingCount = rejectedFindingsRaw ? rejectedFindingsRaw.length : null

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
  head: scope.head_sha,
  lenses,
  skipped,
  verdicts: Object.fromEntries(lensReports.map(r => [r.lens, r.verdict])),
  report: reportOk ? synthesis.report : '',
  __outcome: outcome,
}

} // end run()

// Start/terminal record protocol (AC-DATA-5): see tdd-task.js for the same
// pattern and its rationale.
const startWrite = await writeLedger({ kind: 'review_cycle', outcome: 'started', spec: specPath })
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
  round_key: headSha,
  lenses_run: result.lenses || lensesRunRaw,
  lenses_skipped: result.skipped || [],
  trigger_counts: triggerCounts,
  verdicts: result.verdicts || {},
  spec_bug_count: specBugCount,
  rejected_finding_count: rejectedFindingCount,
  budget_spent: readBudgetSpent(),
  // H4: already shaped as {ac_id, verdict} pairs (see acVerdicts above), so
  // -- unlike spec_bugs/rejected_findings/open_findings -- it needs no
  // further processing by ledger-append.mjs and rides in telemetry proper.
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
// spec_bugs/rejected_findings ride along as raw descriptors for
// ledger-append.mjs to hash into finding ids; they are NOT part of the
// workflow's own public telemetry (which only carries the counts above).
const terminalEntry = { kind: 'review_cycle', spec_bugs: specBugsRaw, rejected_findings: rejectedFindingsRaw, open_findings: openFindingsRaw, ...telemetry }
if (startRunId) terminalEntry.run_id = startRunId
const terminalWrite = await writeLedger(terminalEntry)
// 2026-08-18: give write_ok:false a CONSUMER -- see plan-cycle.js for the
// full rationale. It was computed, logged and returned to nobody, so the
// ledger stopped recording on 2026-08-12 and nothing noticed for six days.
// AC-QA-7 still holds: this reports, it never throws. What AC-QA-7 does not
// say is that the failure may be indistinguishable from success.
// 2026-08-18: did the tree move under this review? Only a REPORTED sha that
// DIFFERS counts. A missing sha means the synthesis agent did not answer, which
// is not evidence of stability -- reading absence as "unmoved" is exactly the
// shape that has recurred through this repo's history.
const checkoutMoved = Boolean(headSha && synthesisHeadSha && synthesisHeadSha !== headSha)
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
