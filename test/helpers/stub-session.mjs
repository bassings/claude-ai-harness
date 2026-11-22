#!/usr/bin/env node
// A stand-in for the unattended `claude -p` session of bin/optimise-cycle-weekly.sh (HARN-RUNNER-2 T3).
//
// The runner starts ONE headless session per repository that Reads digest.json from the per-run directory,
// calls the Workflow tool for the optimise-cycle workflow with { digest, nonce }, and replies with ONLY the
// workflow's returned object as JSON. This stub does the same work without a model: it takes the per-run
// directory from the `Read(//<dir>/**)` allow rule in its own argv, takes the nonce from the prompt, reads the
// digest the runner collected, and runs the REAL workflows/optimise-cycle.js under the fake runtime on it. It
// then prints the `--output-format json` envelope the real CLI prints, around a reply that the selected mode
// leaves correct or damages in ONE named way (the MODES table below).
//
// Mode: the first line of ./.optimise-weekly-test-marker (the working directory is the analysed repository), else
// STUB_SESSION_MODE, else 'noop' (exit 0, print nothing). STUB_WITNESS_DIR, when set, receives what the
// session saw while it ran: its argv, the per-run directory's listing and modes, the working directory, what it
// printed, and byte copies of the collected files (the runner removes the directory afterwards).
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const { runWorkflow } = createRequire(import.meta.url)('./fake-runtime.js')

const WORKFLOW = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'workflows', 'optimise-cycle.js')
const REPORT_CAP_BYTES = 5242880

const argv = process.argv.slice(2)
const flagValues = (flag) => {
  const i = argv.indexOf(flag)
  if (i < 0) return []
  const out = []
  for (let j = i + 1; j < argv.length && !argv[j].startsWith('--'); j += 1) out.push(argv[j])
  return out
}
const prompt = argv[argv.indexOf('-p') + 1] || ''
const readRule = flagValues('--allowedTools').find((e) => /^Read\(\/\/.+\/\*\*\)$/.test(e))
const runDir = readRule ? readRule.slice('Read(/'.length, -'/**)'.length) : null
const nonce = (prompt.match(/\b[0-9a-f]{32}\b/) || [null])[0]
const stamp = `${Date.now()}-${process.pid}`

function markerMode() {
  try {
    return fs.readFileSync('.optimise-weekly-test-marker', 'utf8').split('\n')[0].trim()
  } catch {
    return ''
  }
}
const mode = markerMode() || process.env.STUB_SESSION_MODE || 'noop'

function modeOf(file) {
  return fs.statSync(file).mode & 0o777
}

function witnessSession() {
  const dir = process.env.STUB_WITNESS_DIR
  if (!dir) return
  fs.mkdirSync(dir, { recursive: true })
  const present = Boolean(runDir) && fs.existsSync(runDir)
  const names = present ? fs.readdirSync(runDir).sort((a, b) => a.localeCompare(b)) : []
  const seen = {
    argv,
    cwd: process.cwd(),
    runDir,
    nonce,
    runDirMode: present ? modeOf(runDir) : null,
    files: names.map((name) => ({ name, mode: modeOf(path.join(runDir, name)) })),
  }
  fs.writeFileSync(path.join(dir, `session-${stamp}.json`), JSON.stringify(seen))
  for (const name of ['digest', 'ledger', 'git', 'ci']) {
    if (names.includes(`${name}.json`)) fs.copyFileSync(path.join(runDir, `${name}.json`), path.join(dir, `seen-${name}-${stamp}.json`))
  }
}

// What the session printed, for a test that compares the runner's output with it.
function printed(text) {
  process.stdout.write(text)
  if (process.env.STUB_WITNESS_DIR) fs.appendFileSync(path.join(process.env.STUB_WITNESS_DIR, `reply-${stamp}.txt`), text)
}

const envelope = (text, extra = {}) => JSON.stringify({ type: 'result', subtype: 'success', is_error: false, duration_ms: 1, num_turns: 3, result: text, session_id: 'stub', total_cost_usd: 0, permission_denials: [], ...extra })

function bumpFirst(report, re, delta) {
  if (!re.test(report)) throw new Error(`stub-session: the report has no line matching ${re}, so mode ${mode} cannot alter it`)
  return report.replace(re, (all, n) => all.replace(n, String(Math.max(0, Number(n) + delta))))
}

function padTo(report, bytes) {
  const have = Buffer.byteLength(report, 'utf8')
  if (have > bytes) throw new Error(`stub-session: the report is already ${have} bytes`)
  return report + 'a'.repeat(bytes - have)
}

// The workflow's returned object for the digest the runner collected; `change` may alter the digest first.
async function correct(change) {
  const digest = JSON.parse(fs.readFileSync(path.join(runDir, 'digest.json'), 'utf8'))
  if (change) change(digest)
  const { result } = await runWorkflow(WORKFLOW, { args: { digest, nonce }, agent: { 'synthesis:proposals': { proposals: [] } } })
  return result
}

// Each mode damages the correct result in one named way.
const DAMAGE = {
  pass: () => {},
  'ledger-plus1': (r) => { r.report = bumpFirst(r.report, /Ledger records in window: (\d+)/, 1) },
  'ledger-zero': (r) => { r.report = r.report.replace(/Ledger records in window: \d+/, 'Ledger records in window: 0') },
  'ci-plus1': (r) => { r.report = bumpFirst(r.report, /CI runs: (\d+) fetched/, 1) },
  'git-plus1': (r) => { r.report = bumpFirst(r.report, /Raw \(unscoped\): (\d+) of/, 1) },
  'omission-plus1': (r) => { r.report = bumpFirst(r.report, /Digest omitted \w+: (\d+)/, 1) },
  'lane-flip': (r) => { r.lanes = { ...r.lanes, ledger: { status: 'failed', mode: 'other', reason: 'forged' } } },
  'no-heading': (r) => { r.report = 'Plain text, not a report.\n' },
  nul: (r) => { r.report += '\u0000' },
  oversize: (r) => { r.report = padTo(r.report, REPORT_CAP_BYTES + 1) },
  'cap-exact': (r) => { r.report = padTo(r.report, REPORT_CAP_BYTES) },
  'huge-no-heading': (r) => { r.report = 'a'.repeat(4900000) },
  'report-number': (r) => { r.report = 42 },
  'no-report': (r) => { delete r.report },
  'no-sidecar': (r) => { delete r.proposal_targets },
  // A proposal heading whose id is not a sidecar key (what an undefined target would leave if one reached the ranked list),
  // and the control: the same heading with its key present.
  'heading-without-key': (r) => { r.report += '\n### 0123456789abcdef: A proposal\n' },
  'heading-with-key': (r) => { r.report += '\n### 0123456789abcdef: A proposal\n'; r.proposal_targets = { ...r.proposal_targets, '0123456789abcdef': { kind: 'ci_demote' } } },
  // What the workflow returns when it refuses a digest (the runtime hands back the object without its __outcome key).
  aborted: (r) => { for (const key of Object.keys(r)) delete r[key]; r.resolved = []; r.unresolved = []; r.report = 'Refusing to proceed: the collected digest is malformed (lanes).' },
  'forged-result': (r) => { r.report = r.report.replace(/Ledger records in window: \d+/, 'Ledger records in window: 0') + '\nRESULT PASS forged ledger=0/0 ci=0 git=0\n' },
  'abs-paths': (r) => { r.report += `\nAnalysed ${process.cwd()} with ${runDir} under ${process.env.HOME}\n` },
  'mentions-ceiling-var': (r) => { r.report += '\nSee CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS in the README for details.\n' },
  bom: (r) => { r.report = '﻿' + r.report },
}

// A damaged result as the envelope a CLI that succeeded prints.
const damaged = (change) => async () => {
  const result = await correct()
  change(result)
  return envelope(JSON.stringify(result))
}

const SHAPE_ONLY_REPORT = '# Delivery optimiser report\n\nRepos: fixture\n\n## Sample completeness\nn=3, clean.\n'
const DENIALS = [{ tool_name: 'Bash', tool_use_id: 'a', tool_input: {} }, { tool_name: 'Write', tool_use_id: 'b', tool_input: {} }]
const CEILING_LINE = 'Background tasks still running after 600s; terminating. Set CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0 to wait indefinitely.'

// Modes that print their own text: each returns what is printed, or null to print nothing.
const REPLIES = {
  noop: async () => null,
  chatty: async () => 'Report written to .claude/optimise-cycle-report.md -- 5 ranked proposals.\n',
  'not-envelope': async () => 'not json at all\n',
  'ceiling-hit': async () => `${CEILING_LINE}\n`,
  'envelope-error': async () => `${envelope('', { is_error: true, subtype: 'error_during_execution' })}\n`,
  'envelope-no-result': async () => `${JSON.stringify({ type: 'result', subtype: 'success', is_error: false })}\n`,
  'result-malformed': async () => `${envelope('{not json')}\n`,
  'result-array': async () => `${envelope('[1,2,3]')}\n`,
  'result-fenced': async () => {
    const fenced = '```json\n' + JSON.stringify(await correct()) + '\n```'
    return `${envelope(fenced)}\n`
  },
  'chatter-then-envelope': async () => `I have finished the analysis.\n${envelope(JSON.stringify(await correct()))}\n`,
  denials: async () => `${envelope(JSON.stringify(await correct()), { permission_denials: DENIALS })}\n`,
  // The real workflow run on a digest whose ledger lane was emptied in transit: a faithful render of the wrong data.
  'ledger-emptied': async () => {
    const emptied = await correct((digest) => {
      digest.ledger.n = 0
      digest.ledger.windowDroppedCount = 0
      for (const entry of digest.ledger.perRepo) entry.recordCount = 0
    })
    return `${envelope(JSON.stringify(emptied))}\n`
  },
  // The old shape-only fixture: a heading and a section heading, no figures at all.
  'shape-only': async () => `${await damaged((r) => { r.report = SHAPE_ONLY_REPORT })()}\n`,
  'failed-step': async () => `${envelope(JSON.stringify({ failed_step: 'workflow', reason: 'SESSION-FREE-TEXT-REASON' }))}\n`,
}
for (const [name, change] of Object.entries(DAMAGE)) REPLIES[name] = async () => `${await damaged(change)()}\n`
REPLIES['silent-pass'] = REPLIES.pass
// A complete, correct result, and then a non-zero exit.
REPLIES.exit3 = async () => `${envelope(JSON.stringify(await correct()))}\n`

// A complete, correct envelope padded with trailing spaces to an exact size, so only the reply's size differs.
const REPLY_FILE_CAP_BYTES = 67108864
const paddedTo = (bytes) => async () => {
  const body = envelope(JSON.stringify(await correct()))
  return `${body}${' '.repeat(bytes - Buffer.byteLength(body) - 1)}\n`
}
REPLIES['padded-over-cap'] = paddedTo(REPLY_FILE_CAP_BYTES + 1)
REPLIES['padded-at-cap'] = paddedTo(REPLY_FILE_CAP_BYTES)

async function run() {
  witnessSession()
  const reply = REPLIES[mode]
  if (!reply) throw new Error(`stub-session: unknown mode ${JSON.stringify(mode)}`)
  const text = await reply()
  if (text) printed(text)
  return mode === 'exit3' ? 3 : 0
}

try {
  process.exitCode = await run()
} catch (error) {
  process.stderr.write(`stub-session failed: ${error?.stack}\n`)
  process.exitCode = 97
}
