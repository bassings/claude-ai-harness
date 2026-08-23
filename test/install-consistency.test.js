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

// ---- parseSourceCommitStamp (AC-ARCH-1..3) ----

test('install-consistency: parseSourceCommitStamp reads the JS const form', async () => {
  const { parseSourceCommitStamp } = await loadModule()
  const sha = parseSourceCommitStamp("const SOURCE_COMMIT = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'\n")
  assert.equal(sha, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
})

test('install-consistency: parseSourceCommitStamp reads the AGENT-HARNESS.md HTML-comment form', async () => {
  const { parseSourceCommitStamp } = await loadModule()
  const sha = parseSourceCommitStamp('<!-- SOURCE_COMMIT: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb -->\n')
  assert.equal(sha, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')
})

test('install-consistency: parseSourceCommitStamp returns null when no stamp is present, rather than matching something unrelated', async () => {
  const { parseSourceCommitStamp } = await loadModule()
  assert.equal(parseSourceCommitStamp('no stamp anywhere in this text\n'), null)
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

test('install-consistency: main() surfaces the SOURCE_COMMIT stamp from all three files it already reads, as source_commits', async () => {
  const { main } = await loadModule()
  const shaA = 'a'.repeat(40)
  const shaP = 'b'.repeat(40)
  const shaR = 'c'.repeat(40)
  const dir = writeFixture({
    agentHarnessMd: `<!-- SOURCE_COMMIT: ${shaA} -->\n` + AGENT_HARNESS_MD_RECURRENCE_ONLY,
    lensFiles: {},
    planCycleSource: `const SOURCE_COMMIT = '${shaP}'\n` + schemaSource('PLAN_SCHEMA', []),
    reviewCycleSource: `const SOURCE_COMMIT = '${shaR}'\n` + schemaSource('REVIEW_SCHEMA', []),
  })
  const out = main(dir)
  assert.deepEqual(out.source_commits, { agent_harness: shaA, plan_cycle: shaP, review_cycle: shaR })
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
