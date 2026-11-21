// HARN-RULES-1 part 2: static checks over the two files that carry the rules
// table to people and to the builder, agents/implementer.md and README.md
// (specs/harn-rules-1.md). Written in the style of test/static-checks.test.js:
// nothing here needs a live agent. Each test names the criteria it pins.
//
// Wording is pinned by keyword, not by whole sentence, so the documentation
// can be written naturally; every pattern below is a claim the spec requires
// the text to make. The table's behaviour under a live builder (AC-OPS-1's
// one run per state, AC-QA-15) is not statically checkable and is not here.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { scrubGitEnv } = require('./helpers/git-env.js')
scrubGitEnv()

const ROOT = path.join(__dirname, '..')
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8')
const IMPLEMENTER = read('agents', 'implementer.md')
const README = read('README.md')
const GENERATOR = read('bin', 'sonar-rules-table.mjs')
const TABLE_REL = '.claude/analyser-rules.md'
const FIXTURE = read('test', 'fixtures', 'sonar-rules', 'expected-table.md')
const ROW_CAP = 20
const BYTE_CAP = 8192

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '__pycache__') continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}
const rel = (f) => path.relative(ROOT, f)
// The README section about the rules table, from its heading to the next
// heading of the same or a higher level. Empty when there is none, which
// fails every test that needs it for the right reason.
function sectionOf(text) {
  const m = text.match(/^(#{2,3}) [^\n]*(rules table|analyser rules)[^\n]*$/im)
  if (!m) return ''
  const start = m.index
  const level = m[1].length
  const rest = text.slice(start + m[0].length)
  // Blank out fenced blocks (same length, so offsets hold) so a "# " line
  // inside an example is not mistaken for a heading.
  const masked = rest.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, (b) => b.replace(/[^\n]/g, ' '))
  const next = masked.search(new RegExp(`^#{1,${level}} `, 'm'))
  return m[0] + (next === -1 ? rest : rest.slice(0, next))
}
function tableSection() {
  return sectionOf(README)
}
const SECTION = tableSection()

test('section helper: a fenced block starting with a hash line stays inside the section, a real heading ends it', () => {
  const doc = '## Analyser rules table\n\nIntro.\n\n```\n# Analyser rules table\n| a | b |\n```\n\nAfter the fence.\n\n## Next section\n\nOther.\n'
  const got = sectionOf(doc)
  assert.ok(got.includes('| a | b |') && got.includes('After the fence.'), 'section was cut at the fenced "# " line')
  assert.ok(!got.includes('Other.') && !got.includes('## Next section'), 'a real heading did not end the section')
})

test('README: has a section for the analyser rules table (AC-PROD-5, AC-PROD-8)', () => {
  assert.ok(SECTION.length > 200, 'README.md has no section headed for the rules table or analyser rules')
})

// ------------------------------------------------------------- the one path
test('the table path is one literal in the generator and any other file that names it names the same path (AC-ARCH-1)', () => {
  const generatorLiterals = GENERATOR.match(/['"`]\.claude\/analyser-rules[^'"`]*['"`]/g) || []
  assert.deepEqual(generatorLiterals, [`'${TABLE_REL}'`], 'the generator holds the path as exactly one literal')
  for (const f of ['agents/implementer.md', 'README.md']) {
    const text = read(f)
    assert.ok(text.includes(TABLE_REL), `${f} does not name ${TABLE_REL}`)
    for (const m of text.match(/\.claude\/analyser[-\w./]*/g) || []) assert.equal(m.replace(/[.]+$/, ''), TABLE_REL, `${f} names a different table path: ${m}`)
  }
})

test('the table path appears in agents/implementer.md and in no other tracked file outside the generator, its tests and the documents about it (AC-SEC-8)', () => {
  const { scannedFiles, readRel } = require('./helpers/tracked-files.js')
  const files = scannedFiles()
  assert.ok(files.length > 100 && files.includes('.githooks/pre-push') && files.includes('agents/implementer.md'), `the scanned set looks wrong: ${files.length} files`)
  const hits = files.filter((f) => readRel(f).includes('analyser-rules'))
  assert.deepEqual(hits, ['agents/implementer.md'])
})

test('the table is not git-ignored, so a linked worktree receives it (AC-QA-14)', () => {
  const { spawnSync } = require('node:child_process')
  const { sanitizedGitEnv } = require('./helpers/git-env.js')
  const r = spawnSync('git', ['check-ignore', '-q', '--no-index', TABLE_REL], { cwd: ROOT, env: sanitizedGitEnv(), encoding: 'utf8' })
  assert.equal(r.status, 1, `git check-ignore exit ${r.status}: the table path is ignored or git failed`)
})

test('a linked worktree made with git worktree add holds the committed table at its fixed path, with the main checkout\'s content, under this repository\'s own ignore rules (AC-QA-14)', () => {
  const { makeTempRepo, sh, SUITE_TMPDIR } = require('./helpers/temp-repo.js')
  const repo = makeTempRepo()
  // This repository's own ignore rules apply, so a rule that began ignoring the table would show here.
  fs.copyFileSync(path.join(ROOT, '.gitignore'), path.join(repo, '.gitignore'))
  fs.mkdirSync(path.join(repo, '.claude'), { recursive: true })
  fs.writeFileSync(path.join(repo, TABLE_REL), FIXTURE)
  sh('git add -A && git commit -q -m "table"', repo)
  const wt = path.join(fs.mkdtempSync(path.join(SUITE_TMPDIR, 'worktree-')), 'tree')
  sh(`git worktree add -q -b table-worktree ${JSON.stringify(wt)}`, repo)
  const there = path.join(wt, TABLE_REL)
  assert.ok(fs.existsSync(there), 'the linked worktree has no file at the table path')
  assert.equal(fs.readFileSync(there, 'utf8'), fs.readFileSync(path.join(repo, TABLE_REL), 'utf8'))
})

// ----------------------------------------------------- SonarQube stays out
test('agents/implementer.md describes the table by its neutral columns only and names no SonarQube API, product or field (AC-ARCH-2)', () => {
  assert.ok(IMPLEMENTER.includes(TABLE_REL), 'the implementer does not name the table')
  assert.ok(!/sonar|\/api\/|componentKeys|metricKeys|createdAfter|creationDate|resolved=|facets?\b/i.test(IMPLEMENTER), 'implementer.md carries SonarQube knowledge')
  for (const col of ['rule', 'guidance', 'open', 'recent-new']) assert.ok(IMPLEMENTER.includes(col), `implementer.md does not name the neutral column "${col}"`)
})

test('README names no SonarQube Web API path or SonarQube-only field name (AC-ARCH-2)', () => {
  assert.ok(!/\/api\/[a-z_]+/.test(README), 'README names an API path')
  assert.ok(!/componentKeys|metricKeys|createdAfter|creationDate|resolved=false/.test(README), 'README names a SonarQube-only field')
})

// ------------------------------------------ the format, written down once
const STAMP_RE = /^derived: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z revision: (?:[0-9a-f]{40}|unknown) analyser: \S+ window: \d{4}-\d{2}-\d{2}\.\.\d{4}-\d{2}-\d{2} new-issues: \d+ previous: (?:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z|n\/a) since-previous: (?:\d+|n\/a) on-listed: (?:\d+|n\/a) open-total: \d+ rules: \d+ of (?:at least )?\d+(?: note: .*)?$/
const fences = (text) => [...text.matchAll(/^```[^\n]*\n([\s\S]*?)^```/gm)].map((m) => m[1])
const exampleBlock = () => fences(SECTION).find((b) => b.startsWith('# Analyser rules table'))

test('README documents the table format once, with a complete copyable example whose stamp and header match the generator\'s output exactly (AC-ARCH-3, AC-PROD-5)', () => {
  const example = exampleBlock()
  assert.ok(example, 'no fenced example beginning "# Analyser rules table" in the rules table section')
  const lines = example.split('\n')
  const want = FIXTURE.split('\n')
  assert.equal(lines[0], want[0])
  assert.match(lines[1], STAMP_RE, 'the example stamp does not match the stamp format')
  assert.match(want[1], STAMP_RE, 'the fixture stamp must match the same documented format')
  const shape = (l) => l.replace(/\d{4}-\d{2}-\d{2}T[\d:]+Z|[0-9a-f]{40}|\d+/g, '#')
  assert.equal(shape(lines[1]).replace(/analyser: \S+/, 'analyser: X'), shape(want[1]).replace(/analyser: \S+/, 'analyser: X'), 'stamp fields differ in name or order from the generator\'s')
  assert.equal(lines[2], '')
  assert.equal(lines[3], want[3], 'column header differs from the generator\'s')
  assert.equal(lines[4], want[4], 'column separator differs from the generator\'s')
  const rows = lines.slice(5).filter(Boolean)
  assert.ok(rows.length >= 2)
  for (const r of rows) assert.match(r, /^\| [A-Za-z0-9_.:-]{1,64} \| [^|]+ \| \d+ \| \d+ \|$/, `example row is not in the documented format: ${r}`)
  assert.ok(rows.some((r) => !/^\| [a-z]+:S\d+ \|/.test(r)), 'the example should show a rule identifier that is not an analyser key, as a hand-written table would')
  assert.ok(rows.length <= ROW_CAP && Buffer.byteLength(example) <= BYTE_CAP)
})

test('README describes the since-previous measure: the previous instant, n/a when there is none, and "at least" at the facet cap (AC-PROD-6, AC-OPS-6)', () => {
  assert.match(SECTION, /previous table's? (?:derivation )?(?:instant|date and time)|instant of the previous table/i, 'the previous instant is not described')
  assert.match(SECTION, /n\/a/, 'n/a is not described')
  assert.match(SECTION, /at least/i, 'the capped total is not described')
  assert.match(SECTION, /on-listed/, 'on-listed is not named')
})

test('README states the table bounds, the generator\'s environment variables and the stamp as the one derivation record (AC-SEC-6, AC-ARCH-3)', () => {
  assert.match(SECTION, new RegExp(`\\b${ROW_CAP}\\b[^\\n]*\\brows?\\b|\\brows?\\b[^\\n]*\\b${ROW_CAP}\\b`, 'i'), 'row cap')
  assert.match(SECTION, /8,?192\s*bytes|8\s?KiB/i, 'byte cap')
  for (const v of ['SONAR_HOST_URL', 'SONAR_TOKEN', 'SONAR_PROJECT_KEY', 'SONAR_ALLOW_HTTP']) assert.ok(SECTION.includes(v), `README does not name ${v}`)
  assert.match(SECTION, /stamp/i)
  assert.match(SECTION, /bin\/sonar-rules-table\.mjs/)
})

// ---------------------------------------------- how it is run, and by whom
test('README says a person runs the generator from the repository root after the analyser has finished, that it is never a gate and nothing automated runs it (AC-PROD-8, AC-QA-18)', () => {
  assert.match(SECTION, /repository root/i)
  assert.match(SECTION, /after the analyser has (finished|completed)/i)
  assert.match(SECTION, /\ba person\b|\bthe person\b|\bhuman\b/i)
  assert.match(SECTION, /never a gate/i)
  assert.match(SECTION, /nothing automated runs it|no automated (step|process|job)|not run by (the )?(conductor|CI|any automated)/i)
})

test('README says the table is tracked in git, hand-written guidance survives a refresh, and how to write the table by hand for another analyser (AC-QA-14, AC-PROD-11, AC-PROD-5)', () => {
  assert.match(SECTION, /tracked in git|committed to git|tracked, not ignored/i)
  assert.match(SECTION, /hand-written guidance[^\n]*(surviv|kept|preserv|unchanged)|(surviv|kept|preserv)[^\n]*hand-written guidance/i)
  assert.match(SECTION, /by hand/i)
  assert.match(SECTION, /another analyser|different analyser|other analyser/i)
})

test('README says each run starts a new measurement interval, so run once per analysed merge and commit the result (AC-PROD-6)', () => {
  assert.match(SECTION, /each run starts a new measurement interval/i)
  assert.match(SECTION, /once per analysed merge/i)
  assert.match(SECTION, /commit the result/i)
})

test('README troubleshooting names a local file failure by system call, code and path, and says zero rules can also mean nothing was created in the window (AC-OPS-12)', () => {
  assert.match(SECTION, /system call, the error code and the path/i)
  assert.match(SECTION, /no issues (?:were )?created in the window/i)
})

test('README says a repository that has replaced its implementer agent gets no benefit, and the replacement must read the table to get it (AC-PROD-5, AC-SIMP-2)', () => {
  assert.match(SECTION, /replaced[^\n]*implementer|implementer[^\n]*replaced|replacement implementer/i)
  assert.match(SECTION, /no benefit|gets nothing|does not benefit|will not (see|read|use)/i)
})

// ------------------------------------------------------- the token's route
test('README tells the person to supply the token on the same command line as node, read from their token file at that moment, and never export, copy or echo it (AC-SEC-12)', () => {
  assert.match(SECTION, /SONAR_TOKEN=[^\n]*node[^\n]*bin\/sonar-rules-table\.mjs|SONAR_TOKEN=[^\n]*\n?[^\n]*\bnode\b/, 'no one-line command carrying SONAR_TOKEN in front of node')
  assert.match(SECTION, /same command line/i)
  assert.match(SECTION, /token file/i)
  assert.match(SECTION, /never[^\n]*export|do not export|not export/i)
  assert.match(SECTION, /never[^\n]*(write|copy|save)[^\n]*(another|other) file|not (write|copy|save)[^\n]*(another|other) file/i)
  assert.match(SECTION, /never[^\n]*echo|do not echo|not echo/i)
})

test('README states the minimum permission, forbids a global admin token and explains the http opt-in (AC-SEC-13)', () => {
  assert.match(SECTION, /\bBrowse\b[^\n]*(one|single|that) project|\bBrowse\b[^\n]*only/i)
  assert.match(SECTION, /global admin(istrator)?\b[^\n]*token|token[^\n]*global admin/i)
  assert.match(SECTION, /SONAR_ALLOW_HTTP=1[^\n]*cleartext|cleartext[^\n]*SONAR_ALLOW_HTTP=1/i)
  assert.match(SECTION, /http[^\n]*SONAR_ALLOW_HTTP=1/i)
})

// ------------------------------------------------------ rollback and support
test('README says deleting the table is the rollback, and that reinstalling and restarting the session roll the implementer change out or back (AC-OPS-9)', () => {
  assert.match(SECTION, /delet(e|ing) the (table|file)[^\n]*rollback|rollback[^\n]*delet(e|ing) the (table|file)/i)
  assert.match(SECTION, /reinstall/i)
  assert.match(SECTION, /restart[^\n]*(Claude Code )?session|session[^\n]*restart/i)
})

test('README has a troubleshooting entry, naming cause and action, for each of four symptoms (AC-OPS-12)', () => {
  const t = SECTION.match(/^#{3,4} [^\n]*troubleshoot[^\n]*\n([\s\S]*?)(?=^#{1,4} |\s*$(?![\s\S]))/im)
  assert.ok(t, 'no troubleshooting heading inside the rules table section')
  const body = t[1]
  assert.match(body, /exits non-zero|non-zero exit/i, 'symptom: the generator exits non-zero')
  assert.match(body, /zero rules/i, 'symptom: the table says zero rules')
  assert.match(body, /absent[^\n]*(although|even though|but|yet)[^\n]*(exists|is there|is present)/i, 'symptom: the builder reports absent although the file exists')
  assert.match(body, /no rules[- ]table line|without a rules[- ]table line|carries no rules[- ]table/i, 'symptom: the report has no rules-table line')
  assert.match(body, /replacement|older than/i, 'cause for the missing line: a replaced or older implementer')
  assert.ok(body.match(/cause/gi)?.length >= 4 && body.match(/action|fix|run |check /gi)?.length >= 4, 'each entry names a cause and an action')
})

// -------------------------------------------------- the builder's instruction
test('agents/implementer.md reads the table when it exists, before writing a test or production code, in every phase (AC-OPS-1, AC-SIMP-2)', () => {
  assert.match(IMPLEMENTER, /\.claude\/analyser-rules\.md/)
  assert.match(IMPLEMENTER, /before (you )?(writ|touch)[^\n]*(test|code)|before writing (a|any) test/i)
  assert.match(IMPLEMENTER, /every phase|both phases|each phase|Test phase[\s\S]*Implement phase/i)
  assert.match(IMPLEMENTER, /only when (it|the file|the table) exists/i, 'the table is read only when it exists')
  assert.match(IMPLEMENTER, /(absent|does not exist|missing)[^\n]*(nothing changes|no change|unchanged|carry on|proceed as before|otherwise as before)/i, 'an absent table must change nothing')
})

test('agents/implementer.md frames the table as reference data about patterns to avoid and never as instructions (AC-SEC-7)', () => {
  assert.match(IMPLEMENTER, /guidance column[^\n]*(coding guidance|reference data|patterns to avoid)|(coding guidance|reference data|patterns to avoid)[^\n]*guidance column/i)
  assert.match(IMPLEMENTER, /never[^\n]*instruction|not (as )?instructions?|nothing in the table[^\n]*instruct/i)
  assert.match(IMPLEMENTER, /(run|running) a command/i)
  assert.match(IMPLEMENTER, /fetch(ing)? a URL/i)
  assert.match(IMPLEMENTER, /(read|write)[^\n]*file[^\n]*outside the task|outside the task[^\n]*file/i)
  assert.match(IMPLEMENTER, /change (the )?scope/i)
  assert.match(IMPLEMENTER, /skip(ping)? a gate/i)
  assert.match(IMPLEMENTER, /(row|line)[^\n]*(reads|read) as an instruction[^\n]*(caveat|report)|(caveat|report)[^\n]*(row|line)[^\n]*instruction/i)
  assert.match(IMPLEMENTER, /not follow|do not follow|never follow|without following|and not followed/i)
  assert.match(IMPLEMENTER, /symlink[^\n]*(not a regular file|regular file)[^\n]*(absent)|symlink[^\n]*absent/i)
  assert.match(IMPLEMENTER, /only where it applies to the language and files in hand|applies to the language and files/i)
})

test('agents/implementer.md states the same bounds as the generator and treats an oversize table as absent, saying so at the top of the report (AC-SEC-6)', () => {
  assert.match(IMPLEMENTER, new RegExp(`\\b${ROW_CAP}\\b[^\\n]*\\brows?\\b|\\brows?\\b[^\\n]*\\b${ROW_CAP}\\b`, 'i'), 'row bound')
  assert.match(IMPLEMENTER, /8,?192\s*bytes/i, 'byte bound')
  assert.match(IMPLEMENTER, /over (either|the) bound[^\n]*absent|treated as absent/i)
  assert.match(IMPLEMENTER, /top of (your|the) report/i)
  for (const [name, re] of [['row cap', /const ROW_CAP = (\d+)/], ['byte cap', /const BYTE_CAP = (\d[\d_]*)/]]) assert.ok(re.test(GENERATOR), `generator lost its ${name} constant`)
})

test('agents/implementer.md requires one rules-table status line in every report, showing exactly one of read, absent, unstamped or unreadable (AC-OPS-1)', () => {
  for (const state of ['read', 'absent', 'unstamped', 'unreadable']) assert.match(IMPLEMENTER, new RegExp(`rules table: ${state}\\b`, 'i'), `no status line form "Rules table: ${state}"`)
  assert.match(IMPLEMENTER, /rules table: read[^\n]*(derive|date)[^\n]*revision|rules table: read[^\n]*revision[^\n]*(derive|date)/i, 'the read form carries the derivation date and revision')
  assert.match(IMPLEMENTER, /rules table: absent[^\n]*path/i, 'the absent form names the path checked')
  assert.match(IMPLEMENTER, /rules table: unreadable[^\n]*reason/i, 'the unreadable form carries a reason')
  assert.match(IMPLEMENTER, /every report|each report|all reports/i)
  assert.match(IMPLEMENTER, /Test phase[\s\S]*Implement phase[\s\S]*(direct|conduct-plan)|conduct-plan[\s\S]*status line/i)
})
