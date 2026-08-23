// Unit + CLI tests for workflows/lib/install-consistency.mjs
// (specs/harn-fix-3.md AC-QA-1..5).
//
// Two layers, deliberately: the parse*/checkConsistency functions are
// tested directly (real Node, no fixture directory needed) so a broken
// regex fails here with a precise message; main()/the CLI is ALSO tested
// against real fixture DIRECTORIES on disk (never ~/.claude -- AC-QA-4), so
// the file-reading, directory-resolution and "reads what it's given, not a
// hardcoded path" behaviour is proven by execution, not inferred from the
// unit tests alone.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { pathToFileURL } = require('node:url')
const { spawnSync } = require('node:child_process')

const SCRIPT = path.join(__dirname, '..', 'workflows', 'lib', 'install-consistency.mjs')
const MODULE_URL = pathToFileURL(SCRIPT).href

function loadModule() {
  return import(MODULE_URL)
}

// ---- fixture-directory builder: a plain directory tree, no git involved ----
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'install-consistency-suite-'))
process.on('exit', () => {
  try {
    fs.rmSync(TMP_ROOT, { recursive: true, force: true })
  } catch (e) {
    // best-effort
  }
})

function writeFixture(spec) {
  // spec: { agentHarnessMd, lensFiles: {name: text}, planCycleSource, reviewCycleSource, skipAgentHarness, skipPlan, skipReview }
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'fixture-'))
  if (!spec.skipAgentHarness) fs.writeFileSync(path.join(dir, 'AGENT-HARNESS.md'), spec.agentHarnessMd)
  fs.mkdirSync(path.join(dir, 'agents'), { recursive: true })
  for (const [name, text] of Object.entries(spec.lensFiles || {})) {
    fs.writeFileSync(path.join(dir, 'agents', name), text)
  }
  fs.mkdirSync(path.join(dir, 'workflows'), { recursive: true })
  if (!spec.skipPlan) fs.writeFileSync(path.join(dir, 'workflows', 'plan-cycle.js'), spec.planCycleSource)
  if (!spec.skipReview) fs.writeFileSync(path.join(dir, 'workflows', 'review-cycle.js'), spec.reviewCycleSource)
  return dir
}

// A minimal but REALISTIC set of fixture file bodies: the FINDINGS template
// shape, an agents/lens-*.md instruction line, and a workflow schema const,
// each written in the same syntactic shape the real repo files use, so the
// regexes under test are exercised against realistic input, not a stripped-
// down toy that would pass by accident.
// Deliberately ONE labeled row (Recurrence), not the full real template's
// four: these tests isolate a single field's consistency across doc/agent/
// schema, and a template carrying extra rows the fixtures below never
// mention in a schema would itself report inconsistent, for a reason
// unrelated to what each test is proving.
const AGENT_HARNESS_MD_RECURRENCE_ONLY = `# Harness

### FINDINGS
[SEVERITY] <claim>: <file:line>
  Recurrence:  <do you expect more?>
\`\`\`

more prose after the fence, never scanned
`

const LENS_MD_INSTRUCTS_RECURRENCE = 'For every finding, fill AGENT-HARNESS.md\'s `Recurrence` field: say whether you expect more.\n'

function schemaSource(constName, props) {
  const propsText = props.map((p) => `${p}: { type: 'string' }`).join(', ')
  return (
    `export const meta = { name: 'x' }\n` +
    `const ${constName} = {\n` +
    `  type: 'object',\n` +
    `  properties: {\n` +
    `    findings: { type: 'array', items: { type: 'object', properties: { severity: { type: 'string' }, claim: { type: 'string' }, location: { type: 'string' }, ${propsText} } } },\n` +
    `  },\n` +
    `}\n`
  )
}

test('install-consistency: parseFindingsTemplateFields extracts the colon-labeled rows inside the ### FINDINGS fenced block, lowercased', async () => {
  const { parseFindingsTemplateFields } = await loadModule()
  const fields = parseFindingsTemplateFields(AGENT_HARNESS_MD_RECURRENCE_ONLY)
  assert.deepEqual([...fields].sort(), ['recurrence'])
})

test('install-consistency: parseFindingsTemplateFields returns null (not an empty set) when there is no ### FINDINGS heading at all -- absence is distinguishable from "found zero"', async () => {
  const { parseFindingsTemplateFields } = await loadModule()
  assert.equal(parseFindingsTemplateFields('# Just a title\n\nsome prose\n'), null)
})

test('install-consistency: parseInstructedFields extracts every "fill AGENT-HARNESS.md\'s `X` field" instruction across multiple lens texts, lowercased and deduplicated', async () => {
  const { parseInstructedFields } = await loadModule()
  const fields = parseInstructedFields([LENS_MD_INSTRUCTS_RECURRENCE, LENS_MD_INSTRUCTS_RECURRENCE, 'no instruction here\n'])
  assert.deepEqual([...fields], ['recurrence'])
})

test('install-consistency: parseInstructedFields returns an empty set (never throws) when no lens file instructs anything', async () => {
  const { parseInstructedFields } = await loadModule()
  const fields = parseInstructedFields(['nothing to see here\n'])
  assert.deepEqual([...fields], [])
})

test('install-consistency: parseSchemaFindingsProps extracts findings-item property names from a workflow source\'s named schema const', async () => {
  const { parseSchemaFindingsProps } = await loadModule()
  const src = schemaSource('REVIEW_SCHEMA', ['recurrence', 'ac_id'])
  const props = parseSchemaFindingsProps(src, 'REVIEW_SCHEMA')
  assert.deepEqual([...props].sort(), ['ac_id', 'claim', 'location', 'recurrence', 'severity'])
})

test('install-consistency: parseSchemaFindingsProps returns null when the named const does not exist in the source', async () => {
  const { parseSchemaFindingsProps } = await loadModule()
  const src = schemaSource('REVIEW_SCHEMA', ['recurrence'])
  assert.equal(parseSchemaFindingsProps(src, 'PLAN_SCHEMA'), null)
})

// ---- checkConsistency: both directions, mirroring test/static-checks.test.js's H3 guard ----

test('install-consistency: checkConsistency reports consistent:true when the doc/agent fields and both schemas agree exactly', async () => {
  const { checkConsistency } = await loadModule()
  const result = checkConsistency({
    agentHarnessMd: AGENT_HARNESS_MD_RECURRENCE_ONLY,
    lensFileTexts: [LENS_MD_INSTRUCTS_RECURRENCE],
    reviewCycleSource: schemaSource('REVIEW_SCHEMA', ['recurrence']),
    planCycleSource: schemaSource('PLAN_SCHEMA', ['recurrence']),
  })
  assert.equal(result.consistent, true)
  assert.equal(result.blind, false)
  assert.deepEqual(result.missing_in_review_schema, [])
  assert.deepEqual(result.missing_in_plan_schema, [])
  assert.deepEqual(result.review_only_props, [])
  assert.deepEqual(result.plan_only_props, [])
})

test('install-consistency: checkConsistency (direction 1, H3\'s own shape) reports the field missing from REVIEW_SCHEMA when instructed but undeclared there', async () => {
  const { checkConsistency } = await loadModule()
  const result = checkConsistency({
    agentHarnessMd: AGENT_HARNESS_MD_RECURRENCE_ONLY,
    lensFileTexts: [LENS_MD_INSTRUCTS_RECURRENCE],
    reviewCycleSource: schemaSource('REVIEW_SCHEMA', []), // recurrence NOT declared
    planCycleSource: schemaSource('PLAN_SCHEMA', ['recurrence']),
  })
  assert.equal(result.consistent, false)
  assert.deepEqual(result.missing_in_review_schema, ['recurrence'])
  assert.deepEqual(result.missing_in_plan_schema, [])
})

test('install-consistency: checkConsistency (direction 1, repeated on PLAN_SCHEMA) reports the field missing from PLAN_SCHEMA independently of REVIEW_SCHEMA', async () => {
  const { checkConsistency } = await loadModule()
  const result = checkConsistency({
    agentHarnessMd: AGENT_HARNESS_MD_RECURRENCE_ONLY,
    lensFileTexts: [LENS_MD_INSTRUCTS_RECURRENCE],
    reviewCycleSource: schemaSource('REVIEW_SCHEMA', ['recurrence']),
    planCycleSource: schemaSource('PLAN_SCHEMA', []), // recurrence NOT declared
  })
  assert.equal(result.consistent, false)
  assert.deepEqual(result.missing_in_review_schema, [])
  assert.deepEqual(result.missing_in_plan_schema, ['recurrence'])
})

test('install-consistency: checkConsistency (direction 2, the "vice versa") reports a schema property nothing documents or instructs', async () => {
  const { checkConsistency } = await loadModule()
  const result = checkConsistency({
    agentHarnessMd: AGENT_HARNESS_MD_RECURRENCE_ONLY,
    lensFileTexts: [LENS_MD_INSTRUCTS_RECURRENCE],
    reviewCycleSource: schemaSource('REVIEW_SCHEMA', ['recurrence', 'undocumented_field']),
    planCycleSource: schemaSource('PLAN_SCHEMA', ['recurrence']),
  })
  assert.equal(result.consistent, false)
  assert.deepEqual(result.review_only_props, ['undocumented_field'])
  assert.deepEqual(result.plan_only_props, [])
})

test('install-consistency: checkConsistency never flags the STRUCTURAL findings properties (severity/claim/location/ac_id) as undocumented -- they come from the one-line header/AC attribution, not a template row', async () => {
  const { checkConsistency } = await loadModule()
  const result = checkConsistency({
    agentHarnessMd: AGENT_HARNESS_MD_RECURRENCE_ONLY,
    lensFileTexts: [LENS_MD_INSTRUCTS_RECURRENCE],
    reviewCycleSource: schemaSource('REVIEW_SCHEMA', ['recurrence', 'ac_id']),
    planCycleSource: schemaSource('PLAN_SCHEMA', ['recurrence']),
  })
  assert.equal(result.consistent, true, `ac_id must not be flagged as an undocumented review_only_props entry: got ${JSON.stringify(result.review_only_props)}`)
})

// ---- ANTI-VACUITY (the failure class this whole module's header warns
// about): a parse that finds ZERO fields on either side must never be read
// as "nothing wrong", because it is indistinguishable from "the regex
// cannot see this install's content at all". Prove the floor actually
// fires, not just that it exists in prose. ----

test('install-consistency: ANTI-VACUITY -- an AGENT-HARNESS.md with no ### FINDINGS heading at all is reported blind:true and consistent:false, even when both schemas happen to declare nothing extra (the "zero equals zero" false-clean trap)', async () => {
  const { checkConsistency } = await loadModule()
  const result = checkConsistency({
    agentHarnessMd: '# Just a title, no FINDINGS section\n',
    lensFileTexts: ['no instruction here either\n'],
    reviewCycleSource: schemaSource('REVIEW_SCHEMA', []),
    planCycleSource: schemaSource('PLAN_SCHEMA', []),
  })
  assert.equal(result.blind, true, 'a zero-field parse on the doc side must be reported blind, not silently folded into consistent:true')
  assert.equal(result.consistent, false, 'blind must never be reported as consistent -- that is exactly the "guard that finds nothing and reports CLEAN" failure this repo has hit three times on a closely related regex')
  assert.equal(result.blind_reasons.doc_fields_empty, true)
})

test('install-consistency: ANTI-VACUITY -- a workflow source where the named schema const does not exist (e.g. renamed) is reported blind:true, not silently treated as "declares nothing extra"', async () => {
  const { checkConsistency } = await loadModule()
  const result = checkConsistency({
    agentHarnessMd: AGENT_HARNESS_MD_RECURRENCE_ONLY,
    lensFileTexts: [LENS_MD_INSTRUCTS_RECURRENCE],
    reviewCycleSource: 'export const meta = {}\nconst SOME_OTHER_NAME = {}\n', // no REVIEW_SCHEMA at all
    planCycleSource: schemaSource('PLAN_SCHEMA', ['recurrence']),
  })
  assert.equal(result.blind, true)
  assert.equal(result.blind_reasons.review_schema_empty, true)
  assert.equal(result.consistent, false)
})

// ---- resolveInstallDir (AC-QA-4) ----

test('install-consistency: resolveInstallDir prefers an explicit argument over CLAUDE_HOME and the ~/.claude default', async () => {
  const { resolveInstallDir } = await loadModule()
  const prevEnv = process.env.CLAUDE_HOME
  process.env.CLAUDE_HOME = '/should/not/win'
  try {
    assert.equal(resolveInstallDir('/explicit/dir'), path.resolve('/explicit/dir'))
  } finally {
    if (prevEnv === undefined) delete process.env.CLAUDE_HOME
    else process.env.CLAUDE_HOME = prevEnv
  }
})

test('install-consistency: resolveInstallDir falls back to CLAUDE_HOME when no argument is given', async () => {
  const { resolveInstallDir } = await loadModule()
  const prevEnv = process.env.CLAUDE_HOME
  process.env.CLAUDE_HOME = '/from/env'
  try {
    assert.equal(resolveInstallDir(undefined), path.resolve('/from/env'))
  } finally {
    if (prevEnv === undefined) delete process.env.CLAUDE_HOME
    else process.env.CLAUDE_HOME = prevEnv
  }
})

test('install-consistency: resolveInstallDir falls back to ~/.claude when neither an argument nor CLAUDE_HOME is given -- never a different hardcoded path', async () => {
  const { resolveInstallDir } = await loadModule()
  const prevEnv = process.env.CLAUDE_HOME
  delete process.env.CLAUDE_HOME
  try {
    assert.equal(resolveInstallDir(undefined), path.join(os.homedir(), '.claude'))
  } finally {
    if (prevEnv !== undefined) process.env.CLAUDE_HOME = prevEnv
  }
})

// ---- main()/CLI against real fixture directories (AC-QA-2, AC-QA-4) ----
// Never touches the live ~/.claude: every directory here is a throwaway
// under TMP_ROOT.

function consistentFixtureDir() {
  return writeFixture({
    agentHarnessMd: AGENT_HARNESS_MD_RECURRENCE_ONLY,
    lensFiles: { 'lens-security.md': LENS_MD_INSTRUCTS_RECURRENCE, 'lens-qa.md': 'no instruction\n' },
    planCycleSource: schemaSource('PLAN_SCHEMA', ['recurrence']),
    reviewCycleSource: schemaSource('REVIEW_SCHEMA', ['recurrence']),
  })
}

test('install-consistency: main() reports consistent:true for a consistent fixture directory, and never writes anything into it (AC-QA-2/AC-SIMP-3)', async () => {
  const { main } = await loadModule()
  const dir = consistentFixtureDir()
  const before = fs.readdirSync(dir, { recursive: true }).sort()
  const before_hashes = before.map((f) => {
    const p = path.join(dir, f)
    return fs.statSync(p).isFile() ? fs.readFileSync(p, 'utf8') : null
  })
  const out = main(dir)
  assert.equal(out.ok, true)
  assert.equal(out.consistent, true)
  assert.equal(out.blind, false)
  assert.equal(out.checked_dir, path.resolve(dir))
  const after = fs.readdirSync(dir, { recursive: true }).sort()
  assert.deepEqual(after, before, 'main() must never create, rename or delete a file in the install (AC-SIMP-3)')
  const after_hashes = after.map((f) => {
    const p = path.join(dir, f)
    return fs.statSync(p).isFile() ? fs.readFileSync(p, 'utf8') : null
  })
  assert.deepEqual(after_hashes, before_hashes, 'main() must never modify a file\'s content in the install (AC-SIMP-3)')
})

test('install-consistency: main() reports consistent:false and names the field when the installed schema is missing an instructed field (the H3 shape, in an INSTALLED tree)', async () => {
  const { main } = await loadModule()
  const dir = writeFixture({
    agentHarnessMd: AGENT_HARNESS_MD_RECURRENCE_ONLY,
    lensFiles: { 'lens-security.md': LENS_MD_INSTRUCTS_RECURRENCE },
    planCycleSource: schemaSource('PLAN_SCHEMA', ['recurrence']),
    reviewCycleSource: schemaSource('REVIEW_SCHEMA', []), // partial install: layer 3 missing on the review side
  })
  const out = main(dir)
  assert.equal(out.consistent, false)
  assert.deepEqual(out.missing_in_review_schema, ['recurrence'])
})

test('install-consistency: main() fails closed (ok:false, consistent:false, blind:true) and names the missing file when AGENT-HARNESS.md is absent from the install entirely', async () => {
  const { main } = await loadModule()
  const dir = writeFixture({
    skipAgentHarness: true,
    lensFiles: {},
    planCycleSource: schemaSource('PLAN_SCHEMA', []),
    reviewCycleSource: schemaSource('REVIEW_SCHEMA', []),
  })
  const out = main(dir)
  assert.equal(out.ok, false)
  assert.equal(out.consistent, false)
  assert.equal(out.blind, true)
  assert.match(out.error, /AGENT-HARNESS\.md/)
})

test('install-consistency: main() counts lens_files_checked from the actual agents/lens-*.md files present, not a hardcoded 9', async () => {
  const { main } = await loadModule()
  const dir = writeFixture({
    agentHarnessMd: AGENT_HARNESS_MD_RECURRENCE_ONLY,
    lensFiles: { 'lens-a.md': 'x', 'lens-b.md': 'x', 'lens-c.md': 'x', 'reviewer-verification.md': 'not a lens file, must not be counted' },
    planCycleSource: schemaSource('PLAN_SCHEMA', []),
    reviewCycleSource: schemaSource('REVIEW_SCHEMA', []),
  })
  const out = main(dir)
  assert.equal(out.lens_files_checked, 3)
})

// AC-QA-4, proven by REAL subprocess execution (not just calling main() in-process):
// the CLI reads the fixture directory it is given, not any hardcoded ~/.claude.
test('install-consistency: the CLI (spawned as a real subprocess) reads the fixture directory passed as argv[2], not a hardcoded ~/.claude -- and two different fixtures produce two different, correct answers', () => {
  const consistentDir = consistentFixtureDir()
  const inconsistentDir = writeFixture({
    agentHarnessMd: AGENT_HARNESS_MD_RECURRENCE_ONLY,
    lensFiles: { 'lens-security.md': LENS_MD_INSTRUCTS_RECURRENCE },
    planCycleSource: schemaSource('PLAN_SCHEMA', []),
    reviewCycleSource: schemaSource('REVIEW_SCHEMA', ['recurrence']),
  })

  const res1 = spawnSync('node', [SCRIPT, consistentDir], { encoding: 'utf8' })
  assert.equal(res1.status, 0, res1.stderr)
  const out1 = JSON.parse(res1.stdout.trim())
  assert.equal(out1.checked_dir, path.resolve(consistentDir))
  assert.equal(out1.consistent, true)

  const res2 = spawnSync('node', [SCRIPT, inconsistentDir], { encoding: 'utf8' })
  assert.equal(res2.status, 0, res2.stderr)
  const out2 = JSON.parse(res2.stdout.trim())
  assert.equal(out2.checked_dir, path.resolve(inconsistentDir))
  assert.equal(out2.consistent, false)
  assert.deepEqual(out2.missing_in_plan_schema, ['recurrence'])

  assert.notDeepEqual(out1, out2, 'sanity: two different fixture directories must not produce byte-identical output')
})

test('install-consistency: the CLI never touches the fixture directory it reads (AC-SIMP-3), proven against a real subprocess run', () => {
  const dir = consistentFixtureDir()
  const before = fs.readdirSync(dir, { recursive: true }).sort()
  const res = spawnSync('node', [SCRIPT, dir], { encoding: 'utf8' })
  assert.equal(res.status, 0, res.stderr)
  const after = fs.readdirSync(dir, { recursive: true }).sort()
  assert.deepEqual(after, before)
})

// ============================================================================
// HARN-FIX-3 task 2 of 2: the staleness check (AC-OPS-1..5, AC-ARCH-2), a
// sibling export in this SAME file per the task 1 handover note at the top
// of this module -- AC-SIMP-2 caps the whole spec at two new non-test files
// and task 1 (the version stamp + consistency check) already spent both.
//
// bin/optimise-cycle-weekly.sh (bash, no import capability, no fs module)
// drives this via the CLI's --check-staleness mode; the comparison logic
// itself is tested here directly, at the function level, the same
// two-layer discipline the consistency-check tests above already use for
// exactly the same reason (a broken regex/glob fails here with a precise
// message, not only via an opaque subprocess run).
// ============================================================================

// A plain directory tree builder, deliberately more general than
// writeFixture() above (which is shaped for the four consistency-check
// inputs specifically): the staleness check compares two arbitrary trees
// of relative paths, so this takes a flat {relPath: content} map instead.
function writeTree(files) {
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'tree-'))
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, content)
  }
  return dir
}

// A minimal but representative "published" tree: one file from each
// pattern shape in CONSUMER_SUBSET_PATTERNS/CONSUMER_OPTIONAL_PATTERNS (a
// literal name, two single-segment globs, a top-level glob, three
// directory prefixes, and the two HIGH-2 optional bin/ files), plus files
// a real published repo also ships that are NOT in the subset (test/,
// docs/, the templated plist), so a test asserting "never reported" has
// something real to assert against rather than an absence that could just
// as easily be an incomplete fixture.
//
// HIGH-2 (round-one review): skills/optimise-cycle/ broadened to skills/
// (README.md's manual install copies the WHOLE directory), so
// skills/conduct-plan/ is now genuinely in scope and skills/other-skill/
// is no longer a valid negative control for "not in the subset" --
// bin/setup-hooks.sh takes over that role (bin/ is NOT fully covered,
// unlike skills/: only the two literal optional patterns are).
function publishedSubsetTree(overrides = {}) {
  const files = {
    'AGENT-HARNESS.md': 'harness contract\n',
    'agents/lens-security.md': 'lens security\n',
    'agents/lens-qa.md': 'lens qa\n',
    'agents/reviewer-verification.md': 'reviewer verification\n',
    'agents/implementer.md': 'NOT in the subset -- agents/*.md only matches lens-*/reviewer-*\n',
    'workflows/plan-cycle.js': 'plan cycle\n',
    'workflows/review-cycle.js': 'review cycle\n',
    'workflows/lib/install-consistency.mjs': 'the lib file itself\n',
    'workflows/lib/ledger-append.mjs': 'ledger append\n',
    'hooks/hooks.json': '{}\n',
    'skills/optimise-cycle/SKILL.md': 'optimise-cycle skill\n',
    'skills/conduct-plan/SKILL.md': 'conduct-plan skill\n',
    'bin/optimise-cycle-weekly.sh': 'weekly runner\n',
    'bin/redact-transcript.mjs': 'redact transcript\n',
    'bin/com.local.optimise-cycle-weekly.plist': 'NOT in the subset -- a per-operator TEMPLATE, deliberately excluded\n',
    'bin/setup-hooks.sh': 'NOT in the subset -- bin/ is not a directory-prefix pattern, only two literal files in it are\n',
    'test/some.test.js': 'NOT in the subset\n',
    'docs/some-note.md': 'NOT in the subset\n',
    'README.md': 'NOT in the subset\n',
    ...overrides,
  }
  return writeTree(files)
}

test('install-consistency: CONSUMER_SUBSET_PATTERNS is exported and matches the exact AC-OPS-4 list (HIGH-2: skills/optimise-cycle/ broadened to skills/)', async () => {
  const { CONSUMER_SUBSET_PATTERNS } = await loadModule()
  assert.deepEqual(
    [...CONSUMER_SUBSET_PATTERNS].sort(),
    ['AGENT-HARNESS.md', 'agents/lens-*.md', 'agents/reviewer-*.md', 'hooks/', 'skills/', 'workflows/*.js', 'workflows/lib/'].sort()
  )
})

test('install-consistency: CONSUMER_OPTIONAL_PATTERNS (HIGH-2) is exported and names exactly the two bin/ files README.md documents as separately synced, excluding the templated plist', async () => {
  const { CONSUMER_OPTIONAL_PATTERNS } = await loadModule()
  assert.deepEqual([...CONSUMER_OPTIONAL_PATTERNS].sort(), ['bin/optimise-cycle-weekly.sh', 'bin/redact-transcript.mjs'].sort())
})

test('install-consistency: isConsumerSubsetPath matches every pattern shape (literal, single-segment glob, directory prefix at any depth, and the HIGH-2 optional bin/ literals) and rejects a user-owned or deliberately-excluded file', async () => {
  const { isConsumerSubsetPath } = await loadModule()
  assert.equal(isConsumerSubsetPath('AGENT-HARNESS.md'), true)
  assert.equal(isConsumerSubsetPath('agents/lens-security.md'), true)
  assert.equal(isConsumerSubsetPath('agents/reviewer-verification.md'), true)
  assert.equal(isConsumerSubsetPath('workflows/plan-cycle.js'), true)
  assert.equal(isConsumerSubsetPath('workflows/lib/install-consistency.mjs'), true, 'a file nested under workflows/lib/ must match the directory-prefix pattern, not just workflows/lib/ itself')
  assert.equal(isConsumerSubsetPath('hooks/hooks.json'), true)
  assert.equal(isConsumerSubsetPath('skills/optimise-cycle/SKILL.md'), true)
  assert.equal(isConsumerSubsetPath('skills/conduct-plan/SKILL.md'), true, 'HIGH-2: skills/ covers the whole directory, not just optimise-cycle/')
  assert.equal(isConsumerSubsetPath('bin/optimise-cycle-weekly.sh'), true, 'HIGH-2: an optional pattern is still "in the subset", just not required to be present')
  assert.equal(isConsumerSubsetPath('bin/redact-transcript.mjs'), true)
  assert.equal(isConsumerSubsetPath('agents/implementer.md'), false, 'implementer.md is user-owned, not published under agents/lens-*.md or agents/reviewer-*.md')
  assert.equal(isConsumerSubsetPath('CLAUDE.md'), false, 'CLAUDE.md is user-owned, never published')
  assert.equal(isConsumerSubsetPath('bin/com.local.optimise-cycle-weekly.plist'), false, 'the plist is deliberately excluded -- it is a per-operator TEMPLATE, never byte-identical to the published copy by design')
  assert.equal(isConsumerSubsetPath('bin/setup-hooks.sh'), false, 'bin/ is not a directory-prefix pattern -- only the two literal optional files are in scope')
  assert.equal(isConsumerSubsetPath('workflows/lib_notreally/x.js'), false, '"workflows/lib/" must not match a differently-named sibling directory by prefix-string accident')
  assert.equal(isConsumerSubsetPath('test/some.test.js'), false)
})

test('install-consistency: isOptionalConsumerSubsetPath (HIGH-2) is true only for the two bin/ literals, false for everything else in the subset', async () => {
  const { isOptionalConsumerSubsetPath } = await loadModule()
  assert.equal(isOptionalConsumerSubsetPath('bin/optimise-cycle-weekly.sh'), true)
  assert.equal(isOptionalConsumerSubsetPath('bin/redact-transcript.mjs'), true)
  assert.equal(isOptionalConsumerSubsetPath('AGENT-HARNESS.md'), false, 'a REQUIRED pattern must never read as optional')
  assert.equal(isOptionalConsumerSubsetPath('hooks/hooks.json'), false)
  assert.equal(isOptionalConsumerSubsetPath('bin/com.local.optimise-cycle-weekly.plist'), false, 'the plist is excluded entirely, not merely optional')
})

test('install-consistency: listConsumerSubsetFiles walks a real tree and returns exactly the subset paths (required AND optional), sorted, excluding everything else', async () => {
  const { listConsumerSubsetFiles } = await loadModule()
  const dir = publishedSubsetTree()
  const files = listConsumerSubsetFiles(dir)
  assert.deepEqual(
    files,
    [
      'AGENT-HARNESS.md',
      'agents/lens-qa.md',
      'agents/lens-security.md',
      'agents/reviewer-verification.md',
      'bin/optimise-cycle-weekly.sh',
      'bin/redact-transcript.mjs',
      'hooks/hooks.json',
      'skills/optimise-cycle/SKILL.md',
      'skills/conduct-plan/SKILL.md',
      'workflows/lib/install-consistency.mjs',
      'workflows/lib/ledger-append.mjs',
      'workflows/plan-cycle.js',
      'workflows/review-cycle.js',
    ].sort()
  )
})

test('install-consistency: listConsumerSubsetFiles never throws when a pattern directory is absent from the tree entirely', async () => {
  const { listConsumerSubsetFiles } = await loadModule()
  const dir = writeTree({ 'AGENT-HARNESS.md': 'x\n' }) // no agents/, workflows/, hooks/, skills/ at all
  assert.deepEqual(listConsumerSubsetFiles(dir), ['AGENT-HARNESS.md'])
})

// round-one review MED-8: isConsumerSubsetPath (via matchesPattern) and
// listConsumerSubsetFiles used to be two INDEPENDENT matchers over the
// same CONSUMER_SUBSET_PATTERNS -- proven divergent on a scratch copy of
// the module with a pattern substituted. This is the round-trip proof that
// the fix (listConsumerSubsetFiles now filters every candidate through
// isConsumerSubsetPath, never a second inline matcher) holds: every path
// the walk returns satisfies the standalone predicate, AND every file
// actually on disk that the predicate accepts is reachable by the walk --
// so a mutation to matchesPattern (see docs/install-consistency-mutation-proofs.md)
// changes BOTH functions' behaviour together, never just one.
test('install-consistency: MED-8 -- listConsumerSubsetFiles and isConsumerSubsetPath can never disagree (single authority, not two independent matchers)', async () => {
  const { listConsumerSubsetFiles, isConsumerSubsetPath } = await loadModule()
  const dir = publishedSubsetTree()
  const files = listConsumerSubsetFiles(dir)
  assert.ok(files.length > 5, 'sanity: expected several subset files')
  for (const rel of files) {
    assert.ok(isConsumerSubsetPath(rel), `listConsumerSubsetFiles returned "${rel}" but isConsumerSubsetPath rejects it -- the two matchers have diverged`)
  }
  // The negative controls the fixture deliberately plants (agents/implementer.md,
  // the templated plist, bin/setup-hooks.sh, test/, docs/, README.md) must
  // be excluded by BOTH functions identically, not just one.
  for (const rel of ['agents/implementer.md', 'bin/com.local.optimise-cycle-weekly.plist', 'bin/setup-hooks.sh', 'test/some.test.js', 'docs/some-note.md', 'README.md']) {
    assert.ok(!files.includes(rel), `listConsumerSubsetFiles must not include "${rel}"`)
    assert.ok(!isConsumerSubsetPath(rel), `isConsumerSubsetPath must not accept "${rel}"`)
  }
})

// ---- checkStaleness: the drift comparison itself (AC-OPS-4) ----

test('install-consistency: checkStaleness reports no drift when the install matches the published subset exactly, and status:"ok" (LOW-2)', async () => {
  const { checkStaleness } = await loadModule()
  const published = publishedSubsetTree()
  const install = publishedSubsetTree() // byte-identical content, independent directory
  const result = checkStaleness(published, install)
  assert.equal(result.blind, false)
  assert.deepEqual(result.drifted, [])
  assert.equal(result.drifted_count, 0)
  assert.deepEqual(result.missing, [])
  assert.equal(result.missing_count, 0)
  assert.deepEqual(result.drift, [])
  assert.equal(result.published_files_checked, 13)
  assert.deepEqual(result.unmatched_patterns, [])
  assert.equal(result.status, 'ok')
})

test('install-consistency: checkStaleness reports a published file with DIFFERENT content in the install as drifted, naming it, with status:"drift" and drifted_count:1 (LOW-2)', async () => {
  const { checkStaleness } = await loadModule()
  const published = publishedSubsetTree()
  const install = publishedSubsetTree({ 'agents/lens-security.md': 'a stale, different copy\n' })
  const result = checkStaleness(published, install)
  assert.deepEqual(result.drifted, ['agents/lens-security.md'])
  assert.equal(result.drifted_count, 1)
  assert.deepEqual(result.missing, [])
  assert.equal(result.missing_count, 0)
  assert.deepEqual(result.drift, ['agents/lens-security.md'])
  assert.equal(result.status, 'drift')
})

test('install-consistency: checkStaleness reports a published REQUIRED file ABSENT from the install as drift, under "missing" (AC-OPS-4\'s explicit case)', async () => {
  const { checkStaleness } = await loadModule()
  const published = publishedSubsetTree()
  const installDir = fs.mkdtempSync(path.join(TMP_ROOT, 'tree-'))
  // Copy every published file except one required file (agents/lens-security.md).
  for (const rel of [
    'AGENT-HARNESS.md',
    'agents/lens-qa.md',
    'agents/reviewer-verification.md',
    'workflows/plan-cycle.js',
    'workflows/review-cycle.js',
    'workflows/lib/install-consistency.mjs',
    'workflows/lib/ledger-append.mjs',
    'hooks/hooks.json',
    'skills/optimise-cycle/SKILL.md',
    'skills/conduct-plan/SKILL.md',
    'bin/optimise-cycle-weekly.sh',
    'bin/redact-transcript.mjs',
  ]) {
    const dest = path.join(installDir, rel)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.copyFileSync(path.join(published, rel), dest)
  }
  const result = checkStaleness(published, installDir)
  assert.deepEqual(result.missing, ['agents/lens-security.md'])
  assert.equal(result.missing_count, 1)
  assert.deepEqual(result.drift, ['agents/lens-security.md'])
  assert.equal(result.status, 'drift')
})

// HIGH-2: the two literal bin/ patterns are OPTIONAL -- their absence from
// an install is a legitimate configuration (the weekly job is opt-in for
// a plugin install or a manual install that never set up launchd), never
// drift.
test('install-consistency: checkStaleness (HIGH-2) -- a published install with NEITHER optional bin/ file present reports no drift over their absence', async () => {
  const { checkStaleness } = await loadModule()
  const published = publishedSubsetTree()
  const installDir = fs.mkdtempSync(path.join(TMP_ROOT, 'tree-'))
  for (const rel of [
    'AGENT-HARNESS.md',
    'agents/lens-security.md',
    'agents/lens-qa.md',
    'agents/reviewer-verification.md',
    'workflows/plan-cycle.js',
    'workflows/review-cycle.js',
    'workflows/lib/install-consistency.mjs',
    'workflows/lib/ledger-append.mjs',
    'hooks/hooks.json',
    'skills/optimise-cycle/SKILL.md',
    'skills/conduct-plan/SKILL.md',
    // deliberately NO bin/optimise-cycle-weekly.sh, NO bin/redact-transcript.mjs
  ]) {
    const dest = path.join(installDir, rel)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.copyFileSync(path.join(published, rel), dest)
  }
  const result = checkStaleness(published, installDir)
  assert.deepEqual(result.missing, [], 'an optional file missing from the install must never be reported as missing')
  assert.deepEqual(result.drift, [])
  assert.equal(result.status, 'ok')
})

test('install-consistency: checkStaleness (HIGH-2) -- an optional bin/ file that IS present but has different content IS reported as drifted, unlike a merely absent one', async () => {
  const { checkStaleness } = await loadModule()
  const published = publishedSubsetTree()
  const install = publishedSubsetTree({ 'bin/optimise-cycle-weekly.sh': 'a stale, locally-edited copy\n' })
  const result = checkStaleness(published, install)
  assert.deepEqual(result.drifted, ['bin/optimise-cycle-weekly.sh'])
  assert.deepEqual(result.missing, [], 'presence-with-different-content is drift, but it is never ALSO counted as missing')
  assert.equal(result.status, 'drift')
})

test('install-consistency: checkStaleness never reports a user-owned file the install has but the repo does not ship (AC-OPS-4\'s other explicit case)', async () => {
  const { checkStaleness } = await loadModule()
  const published = publishedSubsetTree()
  const install = publishedSubsetTree({ 'CLAUDE.md': 'user-owned, never published\n', 'agents/implementer.md': 'user-owned\n' })
  const result = checkStaleness(published, install)
  assert.deepEqual(result.drift, [], 'CLAUDE.md and agents/implementer.md exist only in the install and are not in the consumer subset, so they must never appear in drift')
})

test('install-consistency: checkStaleness is ANTI-VACUOUS -- an empty published tree (zero subset files found) reports blind:true, never "no drift" (the CLAUDE.md-documented failure shape: a guard that finds zero files and calls that clean)', async () => {
  const { checkStaleness } = await loadModule()
  const emptyPublished = writeTree({ 'README.md': 'nothing in the subset here\n' })
  const install = publishedSubsetTree()
  const result = checkStaleness(emptyPublished, install)
  assert.equal(result.published_files_checked, 0)
  assert.equal(result.blind, true)
  assert.deepEqual(result.drift, [], 'blind must not be disguised as drift either -- it is a distinct, louder signal that nothing could be compared at all')
})

// round-one review MED-8(b): per-PATTERN blindness, independent of the
// aggregate blind:true above. A published tree with SOME subset content
// (aggregate blind stays false) but nothing at all under one whole
// pattern's directory must still name that pattern -- the failure the
// aggregate-only check cannot see (a renamed or moved subset directory
// silently stops being compared while everything else still looks fine).
test('install-consistency: checkStaleness (MED-8b) -- a published tree with content for every pattern EXCEPT two reports those two in unmatched_patterns, while the aggregate blind stays false, and status is "could-not-check" even though drift/missing are both empty', async () => {
  const { checkStaleness } = await loadModule()
  const dir = writeTree({
    'AGENT-HARNESS.md': 'harness contract\n',
    'agents/lens-security.md': 'lens security\n',
    'workflows/plan-cycle.js': 'plan cycle\n',
    'workflows/review-cycle.js': 'review cycle\n',
    'workflows/lib/ledger-append.mjs': 'ledger append\n',
    'skills/optimise-cycle/SKILL.md': 'optimise-cycle skill\n',
    'bin/optimise-cycle-weekly.sh': 'weekly runner\n',
    'bin/redact-transcript.mjs': 'redact transcript\n',
    // no agents/reviewer-*.md, no hooks/ at all
  })
  const install = dir
  const result = checkStaleness(dir, install)
  assert.equal(result.blind, false, 'sanity: the aggregate check must NOT be blind -- most patterns matched something')
  assert.ok(result.unmatched_patterns.includes('hooks/'), `expected "hooks/" in unmatched_patterns, got: ${JSON.stringify(result.unmatched_patterns)}`)
  assert.ok(result.unmatched_patterns.includes('agents/reviewer-*.md'), `expected "agents/reviewer-*.md" in unmatched_patterns, got: ${JSON.stringify(result.unmatched_patterns)}`)
  assert.ok(!result.unmatched_patterns.includes('AGENT-HARNESS.md'), 'a pattern that DID match something must not be listed as unmatched')
  assert.ok(!result.unmatched_patterns.includes('workflows/*.js'), 'a pattern that DID match something must not be listed as unmatched')
  assert.ok(!result.unmatched_patterns.includes('bin/optimise-cycle-weekly.sh'), 'an OPTIONAL pattern that DID match something must not be listed as unmatched either')
  assert.deepEqual(result.drifted, [])
  assert.deepEqual(result.missing, [])
  assert.equal(result.status, 'could-not-check', 'MED-8 follow-through: an unmatched pattern makes the WHOLE verdict untrustworthy, not only "ok" -- even with zero drift and zero missing found')
})

test('install-consistency: checkStaleness (MED-8b) -- a published tree with content for every pattern (required AND optional) reports an EMPTY unmatched_patterns list (must not cry wolf)', async () => {
  const { checkStaleness } = await loadModule()
  const dir = publishedSubsetTree()
  const result = checkStaleness(dir, dir)
  assert.deepEqual(result.unmatched_patterns, [])
  assert.equal(result.status, 'ok')
})

test('install-consistency: checkStaleness reads only -- never writes, creates or deletes anything in EITHER directory it is given (AC-OPS-2)', async () => {
  const { checkStaleness } = await loadModule()
  const published = publishedSubsetTree()
  const install = publishedSubsetTree({ 'agents/lens-security.md': 'drifted on purpose, to prove AC-OPS-2 holds even on a run that reports drift\n' })
  const hashTree = (dir) =>
    fs
      .readdirSync(dir, { recursive: true })
      .sort()
      .map((f) => {
        const p = path.join(dir, f)
        return fs.statSync(p).isFile() ? fs.readFileSync(p, 'utf8') : null
      })
  const beforePublished = hashTree(published)
  const beforeInstall = hashTree(install)
  const result = checkStaleness(published, install)
  assert.ok(result.drifted.length > 0, 'sanity: this run must genuinely have found drift')
  assert.deepEqual(hashTree(published), beforePublished)
  assert.deepEqual(hashTree(install), beforeInstall)
})

// ---- LOW-1 (round-one review): --check-staleness must never throw ----
// The original evidence used a dangling symlink under agents/lens-*.md,
// which the MED-8 refactor above closed structurally as a side effect
// (walkDirRecursive/the root-literal branch both classify entries via
// fs.Dirent's isFile()/isDirectory(), which does NOT follow a symlink --
// a dangling or valid symlink is neither, so it is silently excluded from
// candidates before checkStaleness ever tries to read it; verified by a
// direct fixture below). The remaining unguarded read this closes is the
// genuine TOCTOU window: listConsumerSubsetFiles's walk and checkStaleness's
// content read are two separate filesystem passes, so a file present at
// listing time can become unreadable before the second pass reaches it.
// chmod 000 reproduces "unreadable" deterministically, without a real race.
test(
  'install-consistency: checkStaleness (LOW-1) -- a PUBLISHED file that becomes unreadable between listing and reading is skipped, never thrown, and never silently counted as clean or drifted',
  { skip: typeof process.getuid === 'function' && process.getuid() === 0 ? 'running as root: permission checks are bypassed, so this failure mode cannot occur' : false },
  async () => {
    const { checkStaleness } = await loadModule()
    const published = publishedSubsetTree()
    const install = publishedSubsetTree()
    const unreadable = path.join(published, 'agents', 'lens-security.md')
    fs.chmodSync(unreadable, 0o000)
    try {
      assert.doesNotThrow(() => checkStaleness(published, install))
      const result = checkStaleness(published, install)
      assert.ok(!result.drifted.includes('agents/lens-security.md'), 'an unreadable published file must not be reported as drifted -- its content was never actually compared')
      assert.ok(!result.missing.includes('agents/lens-security.md'), 'it was found during listing, so it must not be reported as missing either -- that would misdiagnose an unrelated cause')
    } finally {
      fs.chmodSync(unreadable, 0o644) // restore so cleanup can remove it
    }
  }
)

test('install-consistency: listConsumerSubsetFiles (LOW-1 structural fix, MED-8 refactor) never follows a dangling symlink under a glob directory -- it is silently excluded, not crashed on', async () => {
  const { listConsumerSubsetFiles } = await loadModule()
  const dir = publishedSubsetTree()
  fs.symlinkSync('/nonexistent/target/for/low-1', path.join(dir, 'agents', 'lens-broken.md'))
  assert.doesNotThrow(() => listConsumerSubsetFiles(dir))
  const files = listConsumerSubsetFiles(dir)
  assert.ok(!files.includes('agents/lens-broken.md'), 'a dangling symlink must never appear in the result')
})

test('install-consistency: CLI --check-staleness (LOW-1) exits 0 with one line of valid JSON even when a published file is unreadable -- its OWN documented contract', {
  skip: typeof process.getuid === 'function' && process.getuid() === 0 ? 'running as root: permission checks are bypassed, so this failure mode cannot occur' : false,
}, () => {
  const published = publishedSubsetTree()
  const install = publishedSubsetTree()
  const unreadable = path.join(published, 'agents', 'lens-security.md')
  fs.chmodSync(unreadable, 0o000)
  try {
    const res = spawnSync('node', [SCRIPT, '--check-staleness', published, install], { encoding: 'utf8' })
    assert.equal(res.status, 0, `--check-staleness must always exit 0 per its documented contract; stderr:\n${res.stderr}`)
    assert.doesNotThrow(() => JSON.parse(res.stdout.trim()), `stdout must be exactly one line of valid JSON, got:\n${res.stdout}`)
  } finally {
    fs.chmodSync(unreadable, 0o644)
  }
})

// ---- --check-staleness CLI mode (AC-OPS-1..4, real subprocess) ----

test('install-consistency: CLI --check-staleness prints one line of JSON matching checkStaleness()\'s own result, ok:true, status:"drift" (LOW-2) when files were actually compared', () => {
  const published = publishedSubsetTree()
  const install = publishedSubsetTree({ 'agents/lens-security.md': 'drifted\n' })
  const res = spawnSync('node', [SCRIPT, '--check-staleness', published, install], { encoding: 'utf8' })
  assert.equal(res.status, 0, res.stderr)
  const out = JSON.parse(res.stdout.trim())
  assert.equal(out.ok, true)
  assert.deepEqual(out.drifted, ['agents/lens-security.md'])
  assert.equal(out.drifted_count, 1)
  assert.equal(out.blind, false)
  assert.equal(out.status, 'drift')
})

test('install-consistency: CLI --check-staleness reports status:"ok" for a genuinely clean install (LOW-2), the value bin/optimise-cycle-weekly.sh now reads directly rather than re-deriving from raw field shapes', () => {
  const published = publishedSubsetTree()
  const install = publishedSubsetTree()
  const res = spawnSync('node', [SCRIPT, '--check-staleness', published, install], { encoding: 'utf8' })
  assert.equal(res.status, 0, res.stderr)
  const out = JSON.parse(res.stdout.trim())
  assert.equal(out.status, 'ok')
  assert.equal(out.drifted_count, 0)
  assert.equal(out.missing_count, 0)
})

test('install-consistency: CLI --check-staleness reports ok:false (never ok:true) when it is blind -- the anti-vacuity guard applies through the CLI, not only the direct function call', () => {
  const emptyPublished = fs.mkdtempSync(path.join(TMP_ROOT, 'tree-'))
  const install = publishedSubsetTree()
  const res = spawnSync('node', [SCRIPT, '--check-staleness', emptyPublished, install], { encoding: 'utf8' })
  assert.equal(res.status, 0, res.stderr)
  const out = JSON.parse(res.stdout.trim())
  assert.equal(out.ok, false)
  assert.equal(out.blind, true)
})

test('install-consistency: CLI --check-staleness never touches either directory it is given, proven against a real subprocess run (AC-OPS-2)', () => {
  const published = publishedSubsetTree()
  const install = publishedSubsetTree({ 'agents/lens-security.md': 'drifted\n' })
  const beforePub = fs.readdirSync(published, { recursive: true }).sort()
  const beforeInst = fs.readdirSync(install, { recursive: true }).sort()
  const res = spawnSync('node', [SCRIPT, '--check-staleness', published, install], { encoding: 'utf8' })
  assert.equal(res.status, 0, res.stderr)
  assert.deepEqual(fs.readdirSync(published, { recursive: true }).sort(), beforePub)
  assert.deepEqual(fs.readdirSync(install, { recursive: true }).sort(), beforeInst)
})

test('install-consistency: CLI --check-staleness exits 0 with ok:false, status:"could-not-check" (LOW-2) and an error, never throws, when called with missing arguments', () => {
  const res = spawnSync('node', [SCRIPT, '--check-staleness'], { encoding: 'utf8' })
  assert.equal(res.status, 0, res.stderr)
  const out = JSON.parse(res.stdout.trim())
  assert.equal(out.ok, false)
  assert.equal(out.status, 'could-not-check', 'status must be present on EVERY exit path, including a usage error, so a caller can dispatch on one field unconditionally')
  assert.match(out.error, /usage/i)
})
