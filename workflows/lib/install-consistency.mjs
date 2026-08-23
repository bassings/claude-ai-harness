#!/usr/bin/env node
// The findings-schema consistency check: a standalone, ordinary Node
// script, NOT a dynamic-workflow script (see ledger-append.mjs's header for
// why that distinction matters -- workflow scripts cannot import this file,
// have no fs, and cannot run the comparison themselves).
//
// specs/harn-fix-3.md, AC-QA-1..5: a partial install update is the likely
// failure mode (the Recurrence rollout spans AGENT-HARNESS.md's FINDINGS
// template, all nine agents/lens-*.md files, AND the findings schema in
// BOTH workflows/plan-cycle.js and workflows/review-cycle.js -- three
// layers that must move together, see test/static-checks.test.js's H3
// guard). That guard protects the REPO's own tree; nothing protects an
// INSTALLED ~/.claude copy that got layers 1-2 without layer 3. This module
// is that protection, run at the start of every plan-cycle/review-cycle
// invocation before any lens is dispatched (AC-QA-1, AC-QA-2).
//
// AC-SIMP-2 note: the spec's Affected Files table lists ONE new file under
// workflows/lib/ ("the shared subset definition and both checks") for the
// whole spec (both the consistency check here and the staleness check a
// separate task owns). This file is named install-consistency.mjs, not
// findings-consistency.mjs, specifically so the staleness check's consumer-
// subset list (AC-OPS-5: "exactly one definition in the codebase") can be
// added here as a sibling export rather than forcing a second new lib file
// that would push the spec over AC-SIMP-2's two-new-file ceiling. See this
// repo's docs/ for the coordination note left for that task.
//
// PARSING NOTE (read before touching the two parse* functions below): this
// exact regex pair (the FINDINGS-template scan and the "fill AGENT-
// HARNESS.md's `X` field" scan) already exists in test/static-checks.test.js
// as the H3 drift guard, which has a documented history of being wrong THREE
// times in three different directions on a closely related pattern (the
// AC-<LENS>-<n> uniqueness scan, same file) -- matching bare ids counted
// prose mentions; requiring bold found zero definitions in the two largest
// specs while reporting no duplicates; the "fix" for that moved the
// blindness rather than removing it. This module is now the SINGLE
// definition site for the field-extraction logic (AC-SIMP: reuse, not
// reinvent): test/static-checks.test.js's H3 test imports parse*/check*
// from here instead of re-declaring its own copy, so the repo-tree check
// (review time) and the installed-tree check (runtime, this file's CLI) can
// never independently drift into two different, individually-wrong
// parsers.
//
// ANTI-VACUITY (the failure mode the comment above exists to prevent): a
// parse that finds ZERO fields is not evidence of a consistent install, it
// is evidence the parser cannot see this install's content at all --
// exactly the "guard that reports CLEAN because it never looked" shape
// AGENT-HARNESS.md's own output contract names as the harness's central
// failure mode. checkConsistency() below refuses to report consistent:true
// on an empty parse from either side: it reports blind:true instead, with
// blind_reasons naming which side came back empty, and the workflow-level
// gate (workflows/plan-cycle.js, workflows/review-cycle.js) treats blind
// exactly like inconsistent (refuses to dispatch).
//
// Usage: node install-consistency.mjs [install-dir]
// Prints exactly one line of JSON to stdout. Always exits 0 (mirrors
// ledger-append.mjs: the caller -- an agent step -- reads the JSON, not the
// exit code; `ok:false` and `consistent:false` are both loud in the JSON
// itself, and nothing about "always exit 0" hides either).
//
// Every export below is also unit-testable directly (see
// test/install-consistency.test.js): importing this module for its exports
// does NOT run main() as a side effect -- only a direct
// `node install-consistency.mjs` invocation does (guarded below, same
// isMain pattern as ledger-append.mjs).

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

// ---- side A: AGENT-HARNESS.md's ### FINDINGS template ----
// Identical extraction to test/static-checks.test.js's pre-existing H3
// guard (now delegated here, not duplicated -- see the module header).
//
// H1 (round-two review): the whole output contract lives in ONE fenced
// block, and "### FINDINGS" is a section HEADING inside that fence, not a
// fence-opener of its own. The original cut of this function bounded the
// slice at the fence's CLOSE, which only ever worked because FINDINGS
// happened to be the last section before the fence closed. Appending an
// ordinary, legitimate section AFTER FINDINGS but still inside the same
// fence (e.g. "### NOTES [optional]" with an "Effort:" row) made that
// trailing section's colon-labeled row misread as a FINDINGS field --
// flipping consistent:false for every install carrying the edit, on an
// ordinary documentation change with no warning anywhere in the repo.
// Fixed by bounding the slice at whichever comes FIRST: the fence close,
// or the next "### " heading. Proven by test/install-consistency.test.js's
// H1 fixture (a trailing ### NOTES section, still inside the fence).
export function parseFindingsTemplateFields(agentHarnessMdText) {
  const findingsHeadingIdx = agentHarnessMdText.indexOf('### FINDINGS')
  if (findingsHeadingIdx === -1) return null
  const searchFrom = findingsHeadingIdx + '### FINDINGS'.length
  const fenceEnd = agentHarnessMdText.indexOf('```', findingsHeadingIdx)
  if (fenceEnd === -1) return null
  const nextHeadingMatch = /^###\s/m.exec(agentHarnessMdText.slice(searchFrom))
  const nextHeadingIdx = nextHeadingMatch ? searchFrom + nextHeadingMatch.index : Infinity
  const blockEnd = Math.min(fenceEnd, nextHeadingIdx)
  const templateBlock = agentHarnessMdText.slice(findingsHeadingIdx, blockEnd)
  const fields = new Set()
  for (const m of templateBlock.matchAll(/^\s{2}([A-Z][A-Za-z]+):\s/gm)) fields.add(m[1].toLowerCase())
  return fields
}

// ---- side B: agents/lens-*.md's own "fill AGENT-HARNESS.md's `X` field" instructions ----
export function parseInstructedFields(lensFileTexts) {
  const fields = new Set()
  for (const text of lensFileTexts) {
    for (const m of text.matchAll(/fill AGENT-HARNESS\.md's `([A-Za-z]+)` field/g)) fields.add(m[1].toLowerCase())
  }
  return fields
}

// ---- side C: the findings-item properties a workflow's schema const declares ----
export function extractBalancedObject(text, openBraceIdx) {
  let depth = 0
  for (let i = openBraceIdx; i < text.length; i++) {
    if (text[i] === '{') depth++
    else if (text[i] === '}') {
      depth--
      if (depth === 0) return text.slice(openBraceIdx, i + 1)
    }
  }
  return null // unbalanced braces: reported as a parse failure by the caller, never thrown into a partial result
}

export function parseSchemaFindingsProps(workflowSource, constName) {
  const constIdx = workflowSource.indexOf(`const ${constName}`)
  if (constIdx === -1) return null
  const findingsMatch = /\bfindings:\s*{/.exec(workflowSource.slice(constIdx))
  if (!findingsMatch) return null
  const findingsIdxAbs = constIdx + findingsMatch.index
  const propsMatch = /properties:\s*{/.exec(workflowSource.slice(findingsIdxAbs))
  if (!propsMatch) return null
  const propsBraceIdx = findingsIdxAbs + propsMatch.index + propsMatch[0].length - 1
  const obj = extractBalancedObject(workflowSource, propsBraceIdx)
  if (obj === null) return null
  const names = new Set()
  for (const m of obj.matchAll(/(?:^|[{,])\s*([A-Za-z_]\w*)\s*:\s*{\s*type:/g)) names.add(m[1])
  return names
}

// severity/claim/location come from the one-line "[SEVERITY] <claim>:
// <file:line>" header, not a colon-labeled template row; ac_id is
// review-mode AC attribution, a separate mechanism from the FINDINGS
// template. Neither needs a matching template row.
export const STRUCTURAL_FINDINGS_PROPS = new Set(['severity', 'claim', 'location', 'ac_id'])

// The comparison itself, both directions, mirroring test/static-checks.test.js's
// pre-existing H3 test exactly (that test now calls this function rather than
// re-implementing it).
export function checkConsistency({ agentHarnessMd, lensFileTexts, planCycleSource, reviewCycleSource }) {
  const docFields = parseFindingsTemplateFields(agentHarnessMd)
  const agentFields = parseInstructedFields(lensFileTexts)
  const reviewProps = reviewCycleSource != null ? parseSchemaFindingsProps(reviewCycleSource, 'REVIEW_SCHEMA') : null
  const planProps = planCycleSource != null ? parseSchemaFindingsProps(planCycleSource, 'PLAN_SCHEMA') : null

  const blindReasons = {
    doc_fields_empty: docFields === null || docFields.size === 0,
    agent_fields_empty: agentFields === null || agentFields.size === 0,
    review_schema_empty: reviewProps === null || reviewProps.size === 0,
    plan_schema_empty: planProps === null || planProps.size === 0,
  }
  const blind = Object.values(blindReasons).some(Boolean)

  const missingInReviewSchema = []
  const missingInPlanSchema = []
  const reviewOnlyProps = []
  const planOnlyProps = []

  if (!blind) {
    for (const field of new Set([...docFields, ...agentFields])) {
      if (!reviewProps.has(field)) missingInReviewSchema.push(field)
      if (!planProps.has(field)) missingInPlanSchema.push(field)
    }
    for (const p of reviewProps) {
      if (!STRUCTURAL_FINDINGS_PROPS.has(p) && !docFields.has(p)) reviewOnlyProps.push(p)
    }
    for (const p of planProps) {
      if (!STRUCTURAL_FINDINGS_PROPS.has(p) && !docFields.has(p)) planOnlyProps.push(p)
    }
  }

  const consistent =
    !blind && missingInReviewSchema.length === 0 && missingInPlanSchema.length === 0 && reviewOnlyProps.length === 0 && planOnlyProps.length === 0

  return {
    consistent,
    blind,
    blind_reasons: blindReasons,
    doc_fields: docFields ? [...docFields].sort() : [],
    agent_fields: agentFields ? [...agentFields].sort() : [],
    missing_in_review_schema: missingInReviewSchema.sort(),
    missing_in_plan_schema: missingInPlanSchema.sort(),
    review_only_props: reviewOnlyProps.sort(),
    plan_only_props: planOnlyProps.sort(),
  }
}

// ---- AC-OPS-4/AC-OPS-5: the consumer subset (staleness check) ------------
// specs/harn-fix-3.md, task 2 of 2 (the task 1 handover note at this file's
// header explains why this lives here rather than a second new lib file).
// bin/optimise-cycle-weekly.sh is BASH (no import, no fs) so it cannot read
// this array directly; it never needs to -- the whole comparison, glob
// matching included, runs in this module via the --check-staleness CLI
// mode below, and bash only ever sees that mode's JSON output. This array
// therefore has exactly one definition in the codebase (AC-OPS-5), and
// test/static-checks.test.js pins that.
export const CONSUMER_SUBSET_PATTERNS = [
  'AGENT-HARNESS.md',
  'agents/lens-*.md',
  'agents/reviewer-*.md',
  'workflows/*.js',
  'workflows/lib/',
  'hooks/',
  // HIGH-2 (round-one review): broadened from 'skills/optimise-cycle/' to
  // the whole directory. README.md's manual-copy install instructs
  // `cp -r claude-ai-harness/skills/. ~/.claude/skills/` -- ALL skills,
  // not one -- so the old pattern left skills/conduct-plan/ (which drives
  // every multi-PR plan) unwatched: a stale or half-copied
  // skills/conduct-plan/SKILL.md is exactly the partial-update failure
  // this module's header warns about, and the check reported clean over
  // it regardless.
  'skills/',
]

// HIGH-2 (round-one review): bin/optimise-cycle-weekly.sh and
// bin/redact-transcript.mjs are genuinely consumer-relevant and were
// omitted from CONSUMER_SUBSET_PATTERNS entirely -- the launchd job runs
// the INSTALLED ~/.claude/bin/optimise-cycle-weekly.sh, not this repo's
// checkout (README.md's "Weekly scheduled run" section documents copying
// both, with its own `diff -q` verification commands), so the detector
// THIS SPEC SHIPS could itself be arbitrarily stale in an install and this
// check would report clean -- the same defect class the whole spec exists
// to close, sitting inside its own fix.
//
// Listed separately, and OPTIONAL, not required like every pattern above:
// the weekly job is opt-in (a plugin install, or a manual-copy install
// that never set up the launchd job, legitimately has no bin/ directory at
// all), so their ABSENCE from an install is never reported as drift -- only
// their PRESENCE-with-different-content is (checkStaleness below, and
// isOptionalConsumerSubsetPath).
//
// bin/com.local.optimise-cycle-weekly.plist is deliberately EXCLUDED from
// both lists: README.md and the plist's own header comment both document
// it as a TEMPLATE the operator edits before installing (substituting
// their real $HOME for the literal placeholder path the plist ships with), so a
// byte comparison against the published template would report every
// genuinely working install as permanently drifted forever -- the exact
// "the drift report is noisy and gets ignored, becoming decoration"
// failure the spec's own risk table names, and the same false-drift shape
// round-one review's MED-4 found in the (now withdrawn) version stamp.
export const CONSUMER_OPTIONAL_PATTERNS = ['bin/optimise-cycle-weekly.sh', 'bin/redact-transcript.mjs']

function escapeRegExpLiteral(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Three pattern shapes, matched against a POSIX-relative path (forward
// slashes, no leading './'): a directory prefix (trailing '/', matches any
// file at any depth under it -- 'workflows/lib/' must match
// 'workflows/lib/install-consistency.mjs', not just the bare directory
// name itself, and must NOT match a differently-named sibling like
// 'workflows/lib_notreally/x.js' by bare string-prefix accident, hence the
// explicit '===' / startsWith(pattern) pair rather than a single
// startsWith(pattern.slice(0,-1)) check); a single-segment glob ('*' never
// crosses a '/', so 'agents/lens-*.md' cannot accidentally match something
// nested a directory deeper); or a plain literal path.
function matchesPattern(relPath, pattern) {
  if (pattern.endsWith('/')) return relPath === pattern.slice(0, -1) || relPath.startsWith(pattern)
  if (pattern.includes('*')) {
    const re = new RegExp('^' + pattern.split('*').map(escapeRegExpLiteral).join('[^/]*') + '$')
    return re.test(relPath)
  }
  return relPath === pattern
}

export function isConsumerSubsetPath(relPath) {
  return CONSUMER_SUBSET_PATTERNS.some((pattern) => matchesPattern(relPath, pattern)) || isOptionalConsumerSubsetPath(relPath)
}

// HIGH-2: separated from isConsumerSubsetPath so checkStaleness can ask
// "is this specific match one whose ABSENCE from the install is tolerated"
// -- isConsumerSubsetPath alone only answers "is this path in scope at
// all", which is not enough to decide missing-vs-not-reported.
export function isOptionalConsumerSubsetPath(relPath) {
  return CONSUMER_OPTIONAL_PATTERNS.some((pattern) => matchesPattern(relPath, pattern))
}

function walkDirRecursive(rootDir, relDir, out) {
  const absDir = path.join(rootDir, relDir)
  let entries
  try {
    entries = fs.readdirSync(absDir, { withFileTypes: true })
  } catch (e) {
    return // absent directory: this pattern simply contributes nothing, never thrown
  }
  for (const entry of entries) {
    const rel = relDir ? `${relDir}/${entry.name}` : entry.name
    if (entry.isDirectory()) walkDirRecursive(rootDir, rel, out)
    else if (entry.isFile()) out.add(rel)
  }
}

// MED-8 (round-one review): this used to rebuild its own inline glob-
// matching logic in parallel with matchesPattern()/isConsumerSubsetPath()
// above -- two independent matchers deciding the same question, with
// nothing keeping them in agreement. Proven divergent on a scratch copy of
// this module with a pattern substituted: isConsumerSubsetPath() said yes
// while this function's own inline regex said no for the identical path.
// Fixed by collapsing to ONE authority: this function now only decides
// WHICH DIRECTORIES TO WALK (a performance optimisation -- so a real
// clone's .git/ internals, test/, docs/, specs/ and every other unrelated
// top-level directory are never traversed), and isConsumerSubsetPath()
// (via matchesPattern()) is the SOLE decision for what counts as a match,
// applied as a filter over every candidate the walk finds.
export function listConsumerSubsetFiles(dir) {
  const topLevelDirs = new Set()
  let needsRoot = false
  // HIGH-2: walks directories for BOTH the required and optional pattern
  // lists -- bin/optimise-cycle-weekly.sh and bin/redact-transcript.mjs are
  // literal patterns with a slash ('bin/...'), so this loop needs to see
  // them too or the walk never visits bin/ at all and they can never be
  // found even when present.
  for (const pattern of [...CONSUMER_SUBSET_PATTERNS, ...CONSUMER_OPTIONAL_PATTERNS]) {
    const bare = pattern.endsWith('/') ? pattern.slice(0, -1) : pattern
    const slashIdx = bare.indexOf('/')
    if (slashIdx === -1) {
      if (pattern.endsWith('/')) {
        // A directory-prefix pattern living directly at the repo root
        // (e.g. 'hooks/') -- no FURTHER slash in `bare`, but it is still a
        // directory to walk, not a root-level literal. Bug caught by
        // test/install-consistency.test.js: the original cut of this fix
        // read the absence of a second slash as "root-level", which
        // silently dropped hooks/hooks.json from every result.
        topLevelDirs.add(bare)
      } else {
        // A genuine root-level literal (AGENT-HARNESS.md) or root-level
        // glob: only the repo root itself needs walking for these, not a
        // whole subdirectory -- and NOT recursively (walkDirRecursive from
        // '' would also descend into every OTHER top-level directory,
        // exactly the unwanted full-tree walk this function exists to
        // avoid).
        needsRoot = true
      }
    } else {
      topLevelDirs.add(bare.slice(0, slashIdx))
    }
  }

  const candidates = new Set()
  if (needsRoot) {
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch (e) {
      entries = []
    }
    for (const entry of entries) {
      if (entry.isFile()) candidates.add(entry.name)
    }
  }
  for (const topDir of topLevelDirs) walkDirRecursive(dir, topDir, candidates)

  return [...candidates].filter((rel) => isConsumerSubsetPath(rel)).sort()
}

// AC-OPS-2/AC-OPS-4: compares the published tree's consumer subset against
// an install directory. Reads both, writes neither -- every access below is
// fs.readFileSync/readdirSync/statSync, never a write call. `drifted` is a
// published file present in the install with DIFFERENT content; `missing`
// is present in published, absent from the install entirely (AC-OPS-4's
// explicit "reports a published file absent from the install as drift").
// An install-only file the repo does not ship (CLAUDE.md,
// agents/implementer.md) is structurally invisible here: this function
// only ever iterates the PUBLISHED subset and looks each one up in the
// install, so a file that exists only on the install side is never
// examined at all, let alone reported (AC-OPS-4's other explicit case).
//
// ANTI-VACUITY (mirrors checkConsistency()'s blind/blind_reasons above,
// same failure shape, same fix): zero published files found is not
// evidence of "no drift", it is evidence nothing could be compared -- an
// empty or wrongly-pointed clone would otherwise report a spotless "clean"
// verdict on a check that never actually looked. `blind:true` makes that a
// distinct, louder signal than drift:[], and the CLI below refuses to
// report ok:true on it.
// MED-8/LOW-2 (round-one review): the three-way human verdict is now
// computed HERE, once, by the module that holds every input it needs --
// not re-derived by three different ad hoc parsers in
// bin/optimise-cycle-weekly.sh (LOW-2's own finding). `blind` and a
// non-empty `unmatchedPatterns` both collapse to "could-not-check": a
// pattern matching nothing means this run did not actually look at
// everything the subset claims to cover, which is the exact "guard that
// finds nothing and calls it clean" shape this whole spec exists to
// close (the same shape HIGH-2 itself was), so ANY verdict this run would
// otherwise report (including "ok") is untrustworthy, not only "drift".
function computeStalenessStatus({ blind, unmatchedPatterns, drift }) {
  if (blind || unmatchedPatterns.length > 0) return 'could-not-check'
  return drift.length === 0 ? 'ok' : 'drift'
}

export function checkStaleness(publishedDir, installDir) {
  const publishedFiles = listConsumerSubsetFiles(publishedDir)
  const blind = publishedFiles.length === 0
  // MED-8(b): per-PATTERN blindness, independent of the aggregate `blind`
  // above. The aggregate check alone cannot see a renamed or moved subset
  // directory: other patterns still matching something keeps
  // publishedFiles non-empty while one whole pattern silently stops
  // matching anything at all, which is the "found something, therefore
  // looked at everything" gap MED-8 names -- the same shape as
  // checkConsistency()'s per-side (not per-file) blind_reasons above.
  // Computed over BOTH pattern lists (HIGH-2 added a second list).
  const ALL_PATTERNS = [...CONSUMER_SUBSET_PATTERNS, ...CONSUMER_OPTIONAL_PATTERNS]
  const unmatchedPatterns = ALL_PATTERNS.filter((pattern) => !publishedFiles.some((rel) => matchesPattern(rel, pattern))).sort()
  const drifted = []
  const missing = []
  if (!blind) {
    for (const rel of publishedFiles) {
      const installPath = path.join(installDir, rel)
      let installContent
      try {
        installContent = fs.readFileSync(installPath)
      } catch (e) {
        // HIGH-2: an OPTIONAL file (bin/optimise-cycle-weekly.sh,
        // bin/redact-transcript.mjs) absent from the install is a
        // legitimate configuration (the weekly job is opt-in), never
        // drift -- only a REQUIRED file's absence is "missing".
        if (!isOptionalConsumerSubsetPath(rel)) missing.push(rel)
        continue
      }
      // LOW-1 (round-one review): this used to be a bare, unguarded read.
      // listConsumerSubsetFiles's walk and this read are two separate
      // filesystem passes (not atomic), so a file present at listing time
      // can vanish, become unreadable (permissions), or be replaced by a
      // directory before this line runs -- proven by a chmod-000 fixture
      // in test/install-consistency.test.js. Uncaught, this crashed
      // --check-staleness with exit 1 and no JSON, breaking its own
      // documented "always exits 0, always one line of JSON" contract.
      // Caught and skipped here, the same tolerance walkDirRecursive
      // already applies to a directory that vanishes mid-walk: this ONE
      // file is silently excluded from both `drifted` and `missing` for
      // this run (its status is genuinely unknown, not "clean"), rather
      // than the entire check aborting over one unreadable file.
      let publishedContent
      try {
        publishedContent = fs.readFileSync(path.join(publishedDir, rel))
      } catch (e) {
        continue
      }
      if (!installContent.equals(publishedContent)) drifted.push(rel)
    }
  }
  drifted.sort()
  missing.sort()
  const drift = [...drifted, ...missing].sort()
  const status = computeStalenessStatus({ blind, unmatchedPatterns, drift })
  return {
    published_files_checked: publishedFiles.length,
    blind,
    unmatched_patterns: unmatchedPatterns,
    drifted,
    drifted_count: drifted.length,
    missing,
    missing_count: missing.length,
    drift,
    // LOW-2: the derived human verdict, computed once here rather than
    // re-derived by bin/optimise-cycle-weekly.sh's own case-statement
    // pattern matching on the OTHER fields (its previous design).
    status,
  }
}

// ---- CLI: resolves an install directory, reads the files, runs the check ----

// AC-QA-4: never hardcoded to ~/.claude. An explicit argument always wins;
// CLAUDE_HOME is the documented override (shared with the staleness check,
// see the AC-SIMP-2 note above); ~/.claude is the last-resort default for a
// bare invocation with neither.
export function resolveInstallDir(argDir) {
  if (argDir) return path.resolve(argDir)
  if (process.env.CLAUDE_HOME) return path.resolve(process.env.CLAUDE_HOME)
  return path.join(os.homedir(), '.claude')
}

function readIfExists(p) {
  try {
    return fs.readFileSync(p, 'utf8')
  } catch (e) {
    return null
  }
}

function listLensFiles(agentsDir) {
  let names
  try {
    names = fs.readdirSync(agentsDir)
  } catch (e) {
    return []
  }
  return names.filter((f) => f.startsWith('lens-') && f.endsWith('.md')).sort()
}

// M9 (round-two review): the escape hatch, matching
// hooks/destructive-git-guard.py's HARNESS_ALLOW_DESTRUCTIVE_GIT in naming
// and shape (an env-var read once, real Node, no shell parsing needed since
// this is not a Bash command guard). Read HERE, in this real Node process
// (which has process.env), not in the dynamic-workflow script that consumes
// this field -- that runtime has no process.env access at all (see this
// file's own header on why workflow scripts cannot do any of this
// themselves). The WORKFLOW decides what to do with it
// (evaluateInstallConsistency in plan-cycle.js/review-cycle.js); this
// script only reports the fact.
const ESCAPE_VAR = 'HARNESS_ALLOW_INCONSISTENT_INSTALL'
function isEscapeHatchActive() {
  return process.env[ESCAPE_VAR] === '1'
}

export function main(argDir) {
  const dir = resolveInstallDir(argDir)
  const escapeHatchActive = isEscapeHatchActive()
  const agentHarnessPath = path.join(dir, 'AGENT-HARNESS.md')
  const agentsDir = path.join(dir, 'agents')
  const planPath = path.join(dir, 'workflows', 'plan-cycle.js')
  const reviewPath = path.join(dir, 'workflows', 'review-cycle.js')

  const agentHarnessMd = readIfExists(agentHarnessPath)
  const planCycleSource = readIfExists(planPath)
  const reviewCycleSource = readIfExists(reviewPath)
  const lensFiles = listLensFiles(agentsDir)
  const lensFileTexts = lensFiles.map((f) => readIfExists(path.join(agentsDir, f))).filter((t) => t !== null)

  const missingRequired = [
    agentHarnessMd === null ? 'AGENT-HARNESS.md' : null,
    planCycleSource === null ? 'workflows/plan-cycle.js' : null,
    reviewCycleSource === null ? 'workflows/review-cycle.js' : null,
  ].filter(Boolean)

  // Shape is IDENTICAL on every return path (defaults, never omitted keys):
  // the schema the workflow scripts declare for this field has to describe
  // one shape, not two, and an omitted-vs-null distinction here would be a
  // second, unnecessary thing for that schema (and every caller) to handle.
  const EMPTY_CHECK = {
    consistent: false,
    blind: true,
    blind_reasons: { doc_fields_empty: true, agent_fields_empty: true, review_schema_empty: true, plan_schema_empty: true },
    doc_fields: [],
    agent_fields: [],
    missing_in_review_schema: [],
    missing_in_plan_schema: [],
    review_only_props: [],
    plan_only_props: [],
  }

  if (missingRequired.length) {
    // Fail CLOSED: an install missing a required file is exactly the
    // "partial update" shape this whole check exists to catch, so it is
    // never reported as consistent, even though checkConsistency() itself
    // never ran.
    return {
      ok: false,
      checked_dir: dir,
      lens_files_checked: lensFiles.length,
      error: `required file(s) missing under ${dir}: ${missingRequired.join(', ')}`,
      escape_hatch_active: escapeHatchActive,
      ...EMPTY_CHECK,
    }
  }

  const check = checkConsistency({ agentHarnessMd, lensFileTexts, planCycleSource, reviewCycleSource })

  return {
    ok: true,
    checked_dir: dir,
    lens_files_checked: lensFiles.length,
    error: null,
    escape_hatch_active: escapeHatchActive,
    ...check,
  }
}

// Same symlink-safe argv[1]-vs-import.meta.url comparison ledger-append.mjs
// uses, and the same reason (macOS's /tmp -> /private/tmp and friends can
// otherwise make a real `node install-consistency.mjs` invocation fail this
// check and silently skip the CLI branch). Duplicated rather than imported:
// this file stays self-contained, matching ledger-append.mjs's own
// no-local-imports convention, so either can be copied to an install on its
// own.
function resolveArgvPathForIsMain(argPath) {
  const lexical = path.resolve(argPath)
  try {
    return fs.realpathSync.native(lexical)
  } catch (e) {
    return lexical
  }
}
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolveArgvPathForIsMain(process.argv[1])
if (isMain) {
  // AC-OPS-1..4: `node install-consistency.mjs --check-staleness <published-dir> <install-dir>`
  // -- bin/optimise-cycle-weekly.sh's only entry point into this module's
  // staleness logic. Same contract as the default CLI mode below: exactly
  // one line of JSON, always exit 0, never throw. `ok:false` covers both a
  // usage error (missing arguments) and a blind result (AC-OPS's own
  // anti-vacuity rule) -- bash treats either the same way, "could not
  // check", never as a clean pass.
  if (process.argv[2] === '--check-staleness') {
    const publishedDir = process.argv[3]
    const installDir = process.argv[4]
    if (!publishedDir || !installDir) {
      // LOW-2: `status` is present on EVERY exit path of this mode, usage
      // error included, so a caller (bash) can always dispatch on one
      // field without checking `ok` first as a precondition.
      process.stdout.write(JSON.stringify({ ok: false, status: 'could-not-check', error: 'usage: install-consistency.mjs --check-staleness <published-dir> <install-dir>' }) + '\n')
      process.exit(0)
    }
    const result = checkStaleness(path.resolve(publishedDir), path.resolve(installDir))
    process.stdout.write(JSON.stringify({ ok: !result.blind, error: null, ...result }) + '\n')
    process.exit(0)
  }
  const out = main(process.argv[2])
  process.stdout.write(JSON.stringify(out) + '\n')
  process.exit(0)
}
