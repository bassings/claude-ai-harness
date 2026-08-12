// HARN-OPT-2 PR2 (AC-DATA-9): "A run whose process is killed after the
// start record (SIGKILL between start and terminal) leaves exactly one
// line for that run_id with outcome started, and nothing downstream
// converts it into a measured duration or a completed outcome. Proven by
// killing a real run mid-flight."
//
// This cannot be proven inside the fake-runtime harness (which runs a
// workflow script as an in-process async function, with no real OS process
// to kill): a genuine SIGKILL bypasses every JS-level try/finally entirely,
// which is exactly the scenario the try/catch added to tdd-task.js,
// review-cycle.js and plan-cycle.js for AC-QA-8 CANNOT help with -- the
// process is gone before any of that code runs. What actually protects
// this case is the append-only, one-syscall-per-record shape of
// ledger-append.mjs itself: the terminal write simply never happens, so
// only the start line exists. This test spawns a REAL child process that
// writes a real start record via the real ledger-append.mjs, then would
// (after a long delay, simulating real agent work) write the terminal
// record -- and SIGKILLs it during that delay, before the terminal write
// can ever run.
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { pathToFileURL } = require('node:url')
const { APPEND_SCRIPT, makeTempRepo, readLedgerLines, cleanupTempRepos } = require('./helpers/temp-repo.js')

const OPTIMISE_READ_PATH = path.join(__dirname, '..', 'workflows', 'lib', 'optimise-read.mjs')

test.after(cleanupTempRepos)

test('AC-DATA-9: a process SIGKILLed after writing the start record, before it can write the terminal record, leaves exactly one real ledger line (outcome started) for that run_id -- aggregateWallClock reports it as a start-only orphan, never a measured duration or a completed outcome', async () => {
  const repo = makeTempRepo()
  const runId = 'sigkill-mid-flight-1'
  const startPayload = JSON.stringify({ kind: 'tdd_task', outcome: 'started', spec: 'specs/kill.md', run_id: runId })
  const terminalPayload = JSON.stringify({ kind: 'tdd_task', outcome: 'done', spec: 'specs/kill.md', run_id: runId })
  // The child: write the REAL start record synchronously (so it is
  // guaranteed on disk before we ever send SIGKILL), then wait a long time
  // (standing in for the agent work a real run performs between its start
  // and terminal ledger writes) before attempting the terminal write. We
  // kill the child well before that timer fires.
  const childScript = `
    const { execFileSync } = require('node:child_process');
    execFileSync(process.execPath, [${JSON.stringify(APPEND_SCRIPT)}], { input: ${JSON.stringify(startPayload)} });
    setTimeout(() => {
      execFileSync(process.execPath, [${JSON.stringify(APPEND_SCRIPT)}], { input: ${JSON.stringify(terminalPayload)} });
    }, 60000);
  `
  const child = spawn(process.execPath, ['-e', childScript], { cwd: repo })
  let stderr = ''
  child.stderr.on('data', (d) => { stderr += d })

  // Review round-2 L-5: wait for the actual condition (the start line
  // landing on disk), not a fixed guessed delay -- a fixed sleep either
  // wastes time on a fast machine or flakes on a slow/loaded one (AC-QA-21).
  // Bounded so a genuine failure to write still fails the test instead of
  // hanging forever.
  const POLL_INTERVAL_MS = 15
  const POLL_TIMEOUT_MS = 10000
  const pollDeadline = Date.now() + POLL_TIMEOUT_MS
  let beforeKillLines = readLedgerLines(repo)
  while (beforeKillLines.length < 1 && Date.now() < pollDeadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
    beforeKillLines = readLedgerLines(repo)
  }
  assert.equal(beforeKillLines.length, 1, `sanity: the start record must already be on disk before SIGKILL, got ${beforeKillLines.length} lines after polling for up to ${POLL_TIMEOUT_MS}ms (stderr: ${stderr})`)

  child.kill('SIGKILL')
  await new Promise((resolve) => child.on('close', resolve))

  const lines = readLedgerLines(repo)
  assert.equal(lines.length, 1, `expected exactly one line to survive the kill (the start record only), got ${lines.length}`)
  const record = JSON.parse(lines[0])
  assert.equal(record.run_id, runId)
  assert.equal(record.outcome, 'started', 'the surviving line must be the START record, never a fabricated terminal one')

  const { aggregateWallClock } = await import(pathToFileURL(OPTIMISE_READ_PATH).href)
  const result = aggregateWallClock([record])
  assert.equal(result.totals.agentComputeMeasuredRuns, 0, 'a killed run must never be converted into a measured duration')
  assert.equal(result.totals.agentComputeSeconds, null, 'no fabricated duration')
  assert.equal(result.totals.agentComputeStartOnlyRuns, 1, 'a killed run is exactly the start-only orphan shape (AC-OPS-2)')
  assert.equal(result.totals.agentComputeTerminalOnlyRuns, 0)
})
