// H1: untrusted lens-authored text (a finding's `claim`/`location`, or a
// task string) reaches the ledger-write prompt, which recommends a
// single-quoted shell template. JSON.stringify does not escape a single
// quote, so a claim like `';touch /tmp/PWNED;'` breaks out of the quoted
// string and runs as a shell command when an agent follows the prompt's own
// example literally. This is executed end to end, not reasoned about: the
// exact backtick-quoted example command each workflow's real prompt embeds
// is extracted and run via /bin/sh -c in a temp repo, and a marker file's
// existence is the proof, the same way lens-security demonstrated it.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { runWorkflow } = require('./helpers/fake-runtime.js')
const { extractLedgerPayload } = require('./helpers/extract-ledger-payload.js')
const { makeTempRepo, cleanupTempRepos, APPEND_SCRIPT, SUITE_TMPDIR } = require('./helpers/temp-repo.js')

test.after(cleanupTempRepos)

const HOSTILE_CLAIM = "';touch $MARKER;'"

// The prompt's example command may be fully literal already (the real
// payload, or its base64 encoding, interpolated directly into the shown
// command) or schematic (a placeholder like "<the JSON above>" standing in
// for content shown elsewhere, which a compliant agent is expected to
// substitute before running). Handle both, so this test keeps proving the
// same thing across the H1 fix (raw JSON -> base64) without needing to
// change shape assumptions each time the prompt wording changes.
function buildCommandAsACompliantAgentWould(promptText) {
  const match = promptText.match(/`(printf[^`]*)`/)
  assert.ok(match, 'expected the prompt to contain a backtick-quoted printf example command')
  let template = match[1].replace('<path-to-ledger-append.mjs>', APPEND_SCRIPT)
  if (!/<[^>]*>/.test(template)) return template // already fully literal
  const payload = extractLedgerPayload(promptText)
  if (template.includes('<the JSON above>')) {
    return template.replace('<the JSON above>', JSON.stringify(payload))
  }
  const b64Placeholder = template.match(/<[^>]*base64[^>]*>/i)
  if (b64Placeholder) {
    const b64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')
    return template.replace(b64Placeholder[0], b64)
  }
  throw new Error('buildCommandAsACompliantAgentWould: unrecognised placeholder shape in: ' + template)
}

function runReviewCycleAndGetTerminalPrompt(hostileClaim) {
  return runWorkflow(path.join(__dirname, '..', 'workflows', 'review-cycle.js'), {
    args: {},
    agent: {
      'scope:diff': {
        base: 'main',
        head_sha: 'abcdef1234567890',
        files: [{ path: 'src/foo.js', status: 'M' }],
        new_dependency_entries: false,
        new_modules: false,
        custom_rules: null,
        harness_triggers_file_exists: false,
        consistency: { ok: true, consistent: true, blind: false, checked_dir: '/fake/install', lens_files_checked: 9, missing_in_review_schema: [], missing_in_plan_schema: [], review_only_props: [], plan_only_props: [], error: null },
      },
      'lens-security': { verdict: 'CLEAN', coverage: { examined: 'x', verified_by: 'y', could_not_check: 'z' }, findings: [] },
      'lens-qa': { verdict: 'CLEAN', coverage: { examined: 'x', verified_by: 'y', could_not_check: 'z' }, findings: [] },
      synthesis: {
        report: '### VERDICT\nCLEAN',
        spec_bugs: [{ lens: 'lens-qa', location: 'foo.js:1', claim: hostileClaim }],
        rejected_findings: [],
      },
      'ledger:write': { run_id: 'r1', ts: 'x', write_ok: true, write_error: null },
    },
  }).then(({ calls }) => {
    const terminal = calls.filter((c) => c.opts.label === 'ledger:write').pop()
    return terminal.prompt
  })
}

// Round 3 item 4: these marker files previously lived directly in the
// shared os.tmpdir(), the same class of leak M4 fixed for temp-repo.js's
// repos, and cleanup only ran via fs.rmSync calls reached on the happy
// path -- if an assertion above them threw (exactly what happens when the
// injection genuinely succeeds, the very case this file exists to guard
// against), the rmSync line was never reached and the marker leaked.
// Reusing temp-repo.js's SUITE_TMPDIR (isolated root, removed
// unconditionally on process exit) closes it the same way M4 did, without
// duplicating a second isolated-root mechanism in this file.
test('shell-injection: a hostile claim containing a shell metacharacter breakout does NOT execute when the prompt\'s own example command is run verbatim (H1)', async () => {
  const marker = path.join(SUITE_TMPDIR, 'PWNED_LEDGER_' + process.pid + '_' + Date.now())
  assert.equal(path.dirname(marker), SUITE_TMPDIR, 'the marker must live under the isolated suite root, not the bare shared TMPDIR (round 3 item 4)')
  fs.rmSync(marker, { force: true })
  const claim = HOSTILE_CLAIM.replace('$MARKER', marker)
  const prompt = await runReviewCycleAndGetTerminalPrompt(claim)
  const command = buildCommandAsACompliantAgentWould(prompt).replace(/\$MARKER/g, marker)
  const repo = makeTempRepo()
  try {
    execFileSync('/bin/sh', ['-c', command], { cwd: repo, stdio: 'pipe' })
  } catch (e) {
    // ledger-append.mjs never throws, but a shell syntax error from a
    // malformed injected command could non-zero-exit the pipeline; either
    // way the marker-file check below is the real assertion.
  }
  assert.equal(fs.existsSync(marker), false, `the example command executed the injected payload and created ${marker}`)
  fs.rmSync(marker, { force: true })
})

test('shell-injection: the same hostile claim still lands intact as DATA in the ledger line once piped through the fixed example command (H1: safety, not silent data loss)', async () => {
  const marker = path.join(SUITE_TMPDIR, 'PWNED_LEDGER_' + process.pid + '_' + Date.now() + '_b')
  const claim = HOSTILE_CLAIM.replace('$MARKER', marker)
  const prompt = await runReviewCycleAndGetTerminalPrompt(claim)
  const command = buildCommandAsACompliantAgentWould(prompt).replace(/\$MARKER/g, marker)
  const repo = makeTempRepo()
  execFileSync('/bin/sh', ['-c', command], { cwd: repo, stdio: 'pipe' })
  const ledgerPath = path.join(repo, '.claude', 'harness-ledger.jsonl')
  assert.ok(fs.existsSync(ledgerPath), 'expected the ledger line to be written')
  const entry = JSON.parse(fs.readFileSync(ledgerPath, 'utf8').trim().split('\n')[0])
  assert.equal(entry.findings.some((f) => f.disposition === 'spec_bug'), true, 'the hostile claim was still recorded as a spec-bug finding, just safely')
  fs.rmSync(marker, { force: true })
})
