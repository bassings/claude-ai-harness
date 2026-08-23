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
export function parseFindingsTemplateFields(agentHarnessMdText) {
  const findingsHeadingIdx = agentHarnessMdText.indexOf('### FINDINGS')
  if (findingsHeadingIdx === -1) return null
  const fenceEnd = agentHarnessMdText.indexOf('```', findingsHeadingIdx)
  if (fenceEnd === -1) return null
  const templateBlock = agentHarnessMdText.slice(findingsHeadingIdx, fenceEnd)
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
  'skills/optimise-cycle/',
]

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
  return CONSUMER_SUBSET_PATTERNS.some((pattern) => matchesPattern(relPath, pattern))
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
  for (const pattern of CONSUMER_SUBSET_PATTERNS) {
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
  // Reported here, not acted on: this module never decides how the CALLER
  // (bin/optimise-cycle-weekly.sh) should log it.
  const unmatchedPatterns = CONSUMER_SUBSET_PATTERNS.filter((pattern) => !publishedFiles.some((rel) => matchesPattern(rel, pattern))).sort()
  const drifted = []
  const missing = []
  if (!blind) {
    for (const rel of publishedFiles) {
      const installPath = path.join(installDir, rel)
      let installContent
      try {
        installContent = fs.readFileSync(installPath)
      } catch (e) {
        missing.push(rel)
        continue
      }
      const publishedContent = fs.readFileSync(path.join(publishedDir, rel))
      if (!installContent.equals(publishedContent)) drifted.push(rel)
    }
  }
  drifted.sort()
  missing.sort()
  return {
    published_files_checked: publishedFiles.length,
    blind,
    unmatched_patterns: unmatchedPatterns,
    drifted,
    missing,
    drift: [...drifted, ...missing].sort(),
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

export function main(argDir) {
  const dir = resolveInstallDir(argDir)
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
      ...EMPTY_CHECK,
    }
  }

  const check = checkConsistency({ agentHarnessMd, lensFileTexts, planCycleSource, reviewCycleSource })

  return {
    ok: true,
    checked_dir: dir,
    lens_files_checked: lensFiles.length,
    error: null,
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
      process.stdout.write(JSON.stringify({ ok: false, error: 'usage: install-consistency.mjs --check-staleness <published-dir> <install-dir>' }) + '\n')
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
