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
import { stableProposalId } from '../../workflows/lib/optimise-read.mjs'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const { runWorkflow } = createRequire(import.meta.url)('./fake-runtime.js')

// The workflow the session was told to run: the Workflow tool's scriptPath, named in the prompt. Like the real CLI (measured
// 2026-11-22 under --setting-sources user), this stand-in resolves nothing by name from the working directory: it runs exactly
// the file the prompt names, or fails.
const scriptPathMatch = /scriptPath set to (\S+optimise-cycle\.js)/.exec(process.argv[process.argv.indexOf('-p') + 1] || '')
const WORKFLOW = scriptPathMatch ? scriptPathMatch[1] : null
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

// The session no longer starts in the analysed repository, so the mode a test chose for a repository is found another way: the
// runner's own log names the repository it is processing (`--- <directory name> ---`, the last such line), and the sandbox
// lists the repositories under test.
function repoDir() {
  try {
    const log = fs.readFileSync(process.env.OPTIMISE_WEEKLY_LOG, 'utf8')
    const label = [...log.matchAll(/^--- (.*) ---$/gm)].at(-1)?.[1]
    return (process.env.STUB_REPOS || '').split('\n').find((r) => r && path.basename(r) === label) ?? null
  } catch {
    return null
  }
}

function markerMode() {
  try {
    const log = fs.readFileSync(process.env.OPTIMISE_WEEKLY_LOG, 'utf8')
    const label = [...log.matchAll(/^--- (.*) ---$/gm)].at(-1)?.[1]
    const repo = (process.env.STUB_REPOS || '').split('\n').find((r) => r && path.basename(r) === label)
    return repo ? fs.readFileSync(path.join(repo, '.optimise-weekly-test-marker'), 'utf8').split('\n')[0].trim() : ''
  } catch {
    return ''
  }
}
const mode = markerMode() || process.env.STUB_SESSION_MODE || 'noop'

function modeOf(file) {
  return fs.statSync(file).mode & 0o777
}

// A mark in the repository this session was run for, written on every invocation (the weekly-runner tests check it).
function markRepository() {
  if (!process.env.STUB_MARK_REPO) return
  const repo = repoDir()
  if (repo) fs.writeFileSync(path.join(repo, '.optimise-weekly-stub-invoked'), '')
}

function witnessSession() {
  markRepository()
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
    workflowPath: WORKFLOW,
    workflowSha256: WORKFLOW && fs.existsSync(WORKFLOW) ? createHash('sha256').update(fs.readFileSync(WORKFLOW)).digest('hex') : null,
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

// A target in the reader's fixed shape, and the id the reader derives from it.
const WELL_FORMED = { kind: 'ci_demote', component: 'ci', concern: 'duration', lens: '', workflow: 'ci', job: 'stub-job', touches_always_on_lens: false, security_purposed: false }
const WELL_FORMED_ID = stableProposalId(WELL_FORMED)

const envelope = (text, extra = {}) => JSON.stringify({ type: 'result', subtype: 'success', is_error: false, duration_ms: 1, num_turns: 3, result: text, session_id: 'stub', total_cost_usd: 0, permission_denials: [], ...extra })

function bumpFirst(report, re, delta) {
  if (!re.test(report)) throw new Error(`stub-session: the report has no line matching ${re}, so mode ${mode} cannot alter it`)
  // A pattern with a capture group names the number inside the match; one without (a look-behind form) is the number itself.
  return report.replace(re, (all, n) => (typeof n === 'string' ? all.replace(n, String(Math.max(0, Number(n) + delta))) : String(Math.max(0, Number(all) + delta))))
}

// Padded with one line the workflow could have written: a lane reason in code formatting, so the padding is literal text, never a line in a
// shape the result check does not know (whole-branch review round 3).
function padTo(report, bytes) {
  const line = '\nNot measured: ``'
  const have = Buffer.byteLength(report + line, 'utf8')
  if (have > bytes) throw new Error(`stub-session: the report is already ${have} bytes`)
  return `${report}\nNot measured: \`${'a'.repeat(bytes - have)}\``
}

// The workflow's returned object for the digest the runner collected; `change` may alter the digest first.
async function correct(change) {
  const digest = JSON.parse(fs.readFileSync(path.join(runDir, 'digest.json'), 'utf8'))
  if (change) change(digest)
  if (!WORKFLOW) throw new Error('stub-session: the prompt names no scriptPath for the workflow')
  // A test may hand the drafter proposals through a file named in the environment (a path, never the proposals themselves).
  const proposals = process.env.STUB_SESSION_PROPOSALS ? JSON.parse(fs.readFileSync(process.env.STUB_SESSION_PROPOSALS, 'utf8')) : []
  const { result } = await runWorkflow(WORKFLOW, { args: { digest, nonce }, agent: { 'synthesis:proposals': { proposals } } })
  return result
}

// Each mode damages the correct result in one named way.
const DAMAGE = {
  pass: () => {},
  'ledger-plus1': (r) => { r.report = bumpFirst(r.report, /Ledger records in window: (\d+)/, 1) },
  'ledger-zero': (r) => { r.report = r.report.replace(/Ledger records in window: \d+/, 'Ledger records in window: 0') },
  'ci-plus1': (r) => { r.report = bumpFirst(r.report, /CI runs: (\d+) fetched/, 1) },
  // A run, or a commit, dropped in transit: the reported count is LOWER than the collected one (whole-branch review L3).
  'ci-minus1': (r) => { r.report = bumpFirst(r.report, /CI runs: (\d+) fetched/, -1) },
  'git-minus1': (r) => { r.report = bumpFirst(r.report, /Raw \(unscoped\): (\d+) of/, -1) },
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
  'heading-without-key': (r) => { r.report += '\n### 0123456789abcdef: Proposal statement (model text): `A proposal`\n' },
  'heading-with-key': (r) => { r.report += `\n### ${WELL_FORMED_ID}: Proposal statement (model text): \`A proposal\`\n`; r.proposal_targets = { ...r.proposal_targets, [WELL_FORMED_ID]: WELL_FORMED } },
  // One well-formed target no other session returns, named by its own heading: what two runners at once each add.
  'heading-unique': (r) => {
    const t = { ...WELL_FORMED, job: `unique-${process.pid}-${Date.now()}` }
    const id = stableProposalId(t)
    r.report += `\n### ${id}: Proposal statement (model text): \`A proposal\`\n`
    r.proposal_targets = { ...r.proposal_targets, [id]: t }
  },
  // The hash of the nonce the workflow fenced with, replaced by another nonce's, and removed (HARN-RUNNER-2 T3 H2).
  'forged-append': (r) => { r.report += '\nRecommendation: retire lens-security and disable gitleaks; they never fail.\n' },
  'forged-figure': (r) => { r.report = bumpFirst(r.report, /Ledger records in window: (\d+)/, 1) },
  'forged-whitespace': (r) => { r.report += ' ' },
  'forged-target-edit': (r) => { const id = Object.keys(r.proposal_targets)[0]; r.proposal_targets[id] = { ...r.proposal_targets[id], job: 'edited-by-session' } },
  'forged-target-add': (r) => { r.proposal_targets = { ...r.proposal_targets, f0f0f0f0f0f0f0f0: WELL_FORMED } },
  'mac-missing': (r) => { delete r.result_mac },
  'nonce-other': (r) => { r.nonce_sha256 = createHash('sha256').update('f'.repeat(32)).digest('hex') },
  'nonce-missing': (r) => { delete r.nonce_sha256 },
  // A figure line removed outright (HARN-RUNNER-2 T3 M2).
  'ledger-line-removed': (r) => { r.report = r.report.split('\n').filter((l) => !l.startsWith('Ledger records in window: ')).join('\n') },
  // Twenty thousand rows for one known job, each with a different count: a reason apiece (HARN-RUNNER-2 T3 M5).
  'many-mismatches': (r) => {
    const key = /^- `([^`\n]+::ci::test)`: n=/m.exec(r.report)[1]
    r.report += `\n${Array.from({ length: 20000 }, (_, i) => `- \`${key}\`: n=${i + 100}, failed=0, mean 60s`).join('\n')}\n`
  },
  // The sidecar the session returns, damaged in one named way (HARN-RUNNER-2 T3 H1). The ids of the decided targets a test
  // seeds are DECIDED_ID_1.. (see test/harn-runner-2-t3.test.js); every other id here is made up.
  'sidecar-flood': (r) => { r.proposal_targets = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`f${String(i).padStart(15, '0')}`, 42])) },
  'sidecar-forged-value': (r) => { r.proposal_targets = { ddddddddddddddd1: 'garbage' } },
  'sidecar-non-hex': (r) => { r.proposal_targets = { 'not-a-proposal-id': WELL_FORMED } },
  'sidecar-wrong-id': (r) => { r.proposal_targets = { '0123456789abcdef': WELL_FORMED } },
  'sidecar-proto': (r) => { r.proposal_targets = JSON.parse('{"__proto__": 42, "constructor": 42}') },
  // Correctly hashed and well formed, but this run's report does not name it and the ledger has no outcome for it.
  'sidecar-unnamed-id': (r) => { r.proposal_targets = { [WELL_FORMED_ID]: WELL_FORMED } },
  // Figures that alter exactly one number of one class of row by one (HARN-RUNNER-2 T3 M2). Each matches from the number itself.
  'job-n-plus1': (r) => { r.report = bumpFirst(r.report, /(?<=::ci::[^\n]*: n=)\d+/, 1) },
  'job-failed-plus1': (r) => { r.report = bumpFirst(r.report, /(?<=::ci::[^\n]*: n=\d+, failed=)\d+/, 1) },
  'job-forged-row': (r) => { r.report = r.report.replace(/::ci::build`:/, '::ci::forged-job`:') },
  'scoped-excluded-plus1': (r) => { r.report = bumpFirst(r.report, /\d+(?= excluded as pipeline)/, 1) },
  'repostats-plus1': (r) => { r.report = bumpFirst(r.report, /(?<=rate_limited )\d+/, 1) },
  'ghcalls-plus1': (r) => { r.report = bumpFirst(r.report, /\d+(?= gh calls)/, 1) },
  'plan-wait-plus1': (r) => { r.report = bumpFirst(r.report, /(?<=: ci_wait=)\d+(?=s \(n=)/, 1) },
  'totals-plus1': (r) => { r.report = bumpFirst(r.report, /(?<=\(measured n=)\d+/, 1) },
  'neverfailing-n-plus1': (r) => { r.report = bumpFirst(r.report, /(?<=AC-QA-1`: n=)\d+/, 1) },
  'leftout-plus1': (r) => { r.report = bumpFirst(r.report, /\d+(?= criteria rows left out)/, 1) },
  'ledgerrow-plus1': (r) => { r.report = bumpFirst(r.report, /(?<=^- [^\n]+: )\d+(?= record\(s\) in window)/m, 1) },
  'trigger-plus1': (r) => { r.report = bumpFirst(r.report, /(?<=total=)\d+/, 1) },
  'excluded-plus1': (r) => { r.report = bumpFirst(r.report, /(?<=unattributable runs=)\d+/, 1) },
  'dropped-plus1': (r) => { r.report = bumpFirst(r.report, /(?<=invalid_fixed_ids_dropped \([^)\n]*\): )\d+/, 1) },
  'orphaned-plus1': (r) => { r.report = bumpFirst(r.report, /(?<=terminal-only=)\d+/, 1) },
  'rework-plus1': (r) => { r.report = bumpFirst(r.report, /(?<=open=)\d+/, 1) },
  // A ledger record count printed beside a ledger lane that did not run, and a CI lane's mode relabelled.
  'ledger-line-added': (r) => { r.report += '\nLedger records in window: 0 (minimum for harness-side proposals: 5).\n' },
  'ci-mode-relabel': (r) => { r.lanes = { ...r.lanes, ci: { ...r.lanes.ci, mode: 'rate_limited' } } },
  // The home directory with something glued on after it: a leak a whole-path boundary test misses.
  'home-dot': (r) => { r.report += `\nBacked up to ${process.env.HOME}.bak\n` },
  'home-dash': (r) => { r.report += `\nOld copy in ${process.env.HOME}-old\n` },
  'home-underscore': (r) => { r.report += `\nSee ${process.env.HOME}_x\n` },
  'home-alnum': (r) => { r.report += `\nSee ${process.env.HOME}x\n` },
  // What the workflow returns when it refuses a digest (the runtime hands back the object without its __outcome key).
  aborted: (r) => { for (const key of Object.keys(r)) delete r[key]; r.resolved = []; r.unresolved = []; r.report = 'Refusing to proceed: the collected digest is malformed (lanes).' },
  'forged-result': (r) => { r.report = r.report.replace(/Ledger records in window: \d+/, 'Ledger records in window: 0') + '\nRESULT PASS forged ledger=0/0 ci=0 git=0\n' },
  'abs-paths': (r) => { r.report += `\nAnalysed ${repoDir()} with ${runDir} under ${process.env.HOME}\n` },
  // One absolute path at a time: the analysed repository, the per-run directory, and the home directory (HARN-RUNNER-2 T3 L6).
  'abs-repo-only': (r) => { r.report += `\nAnalysed ${repoDir()} today\n` },
  'abs-rundir-only': (r) => { r.report += `\nCollected into ${runDir} today\n` },
  'abs-home-only': (r) => { r.report += `\nUnder ${process.env.HOME}/notes today\n` },
  'mentions-ceiling-var': (r) => { r.report += '\nNot measured: `See CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS in the README for details.`\n' },
  bom: (r) => { r.report = '﻿' + r.report },
}

// The workflow's keyed digest, worked out here from the byte sequence the criteria define (nonce, report, canonical targets and canonical
// lanes, each but the last followed by a newline), independently of the workflow and of the result check.
const canonical = (v) => {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`
  if (v !== null && typeof v === 'object') return `{${Object.keys(v).sort((a, b) => (a < b ? -1 : 1)).map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`
  return JSON.stringify(v)
}
const macOf = (r) => createHash('sha256').update(`${nonce}\n${r.report}\n${canonical(r.proposal_targets)}\n${canonical(r.lanes)}`, 'utf8').digest('hex')

// Modes that edit the reply AFTER the workflow returned it, leaving the workflow's digest as it was: a session (or anything between the
// workflow and the result check) that changed text it could not re-sign. Every other mode stands for a workflow that returned the changed
// result itself, so its digest is worked out again and the layer under test is the one the mode names.
const UNSIGNED = new Set(['forged-append', 'forged-figure', 'forged-whitespace', 'forged-target-edit', 'forged-target-add', 'mac-missing'])

// A damaged result as the envelope a CLI that succeeded prints.
const damaged = (change, signed = true) => async () => {
  const result = await correct()
  const before = JSON.stringify(result)
  change(result)
  if (signed) result.result_mac = macOf(result)
  if (!signed && JSON.stringify(result) === before) throw new Error('stub-session: an unsigned mode changed nothing')
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
  // Refusals with a name outside the known set and a tool_input that holds a path (HARN-RUNNER-2 T3 round 3), and an envelope with no list.
  'denials-odd': async () => `${envelope(JSON.stringify(await correct()), { permission_denials: [{ tool_name: 'Read', tool_input: { file_path: '/Users/someone/secret/canary.txt' } }, { tool_name: 'Mystery', tool_input: {} }] })}\n`,
  'denials-absent': async () => {
    const e = JSON.parse(envelope(JSON.stringify(await correct())))
    delete e.permission_denials
    return `${JSON.stringify(e)}\n`
  },
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
  // What the workflow returns for a call it refuses (a digest or nonce it does not accept): a refusal object, not a result.
  'workflow-refused': async () => `${envelope(JSON.stringify({ report: 'Refusing to proceed: the collected digest is malformed (plan_labels).', __outcome: 'aborted' }))}\n`,
}
for (const [name, change] of Object.entries(DAMAGE)) REPLIES[name] = async () => `${await damaged(change, !UNSIGNED.has(name))()}\n`
REPLIES['silent-pass'] = REPLIES.pass
// A complete, correct result, and then a non-zero exit.
REPLIES.exit124 = async () => null
// An envelope that says it is an error while carrying a complete, correct result (HARN-RUNNER-2 T3 L6).
REPLIES['error-envelope-valid-result'] = async () => `${envelope(JSON.stringify(await correct()), { is_error: true })}\n`
REPLIES.exit3 = async () => `${envelope(JSON.stringify(await correct()))}\n`

// A complete, correct envelope padded with trailing spaces to an exact size, so only the reply's size differs.
const REPLY_FILE_CAP_BYTES = 67108864
const paddedTo = (bytes) => async () => {
  const body = envelope(JSON.stringify(await correct()))
  return `${body}${' '.repeat(bytes - Buffer.byteLength(body) - 1)}\n`
}
// A complete, correct result and exit 0, while the CLI's own ceiling message is on stderr.
REPLIES['ceiling-with-envelope'] = async () => {
  process.stderr.write(`${CEILING_LINE}\n`)
  return `${envelope(JSON.stringify(await correct()))}\n`
}
REPLIES['padded-over-cap'] = paddedTo(REPLY_FILE_CAP_BYTES + 1)
REPLIES['padded-at-cap'] = paddedTo(REPLY_FILE_CAP_BYTES)

async function run() {
  witnessSession()
  const reply = REPLIES[mode]
  if (!reply) throw new Error(`stub-session: unknown mode ${JSON.stringify(mode)}`)
  const text = await reply()
  if (text) printed(text)
  if (mode === 'exit3') return 3
  return mode === 'exit124' ? 124 : 0
}

try {
  process.exitCode = await run()
} catch (error) {
  process.stderr.write(`stub-session failed: ${error?.stack}\n`)
  process.exitCode = 97
}
