// HARN-RUNNER-2 T4 (AC-ARCH-2): the workflow no longer has an attended path of its own (no scope agent, no lane agent):
// every call carries the collector's digest and the nonce. The older workflow tests were written as scripted lane-agent
// answers (scope, ledger, ci, git), so this wrapper turns those same answers into the digest the collector would have
// written for them and runs the REAL workflow on it. Nothing here reimplements the workflow; a test that needs a shape
// the digest cannot hold (two repositories, an unresolved one) was removed, not bent to fit.
require('./temp-repo.js') // loads the git-environment scrub at require time (the lane key below is named git)
const { runWorkflow: runRaw } = require('./fake-runtime.js')

const DROPPED_ZERO = { wallClockByPlan: 0, proposalOutcomes: 0, planLabels: 0, ciByJob: 0, ciFailedRunIds: 0, ciCitationPool: 0, ledgerCitationPool: 0, neverFailingAcs: 0, planLabelsUnmatched: 0, trimmedForSize: false }
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const failedLane = (name) => ({ status: 'failed', mode: 'other', reason: `the ${name} lane returned no result` })

// The digest refuses a ledger whose figures disagree (n plus the window's dropped records must be the records held), as a
// real collection never produces one; a scripted answer that sets n alone gets its first repository's count made to agree.
function agreeing(ledger) {
  if (!Array.isArray(ledger.perRepo) || !ledger.perRepo.length || !Number.isInteger(ledger.n)) return ledger
  const held = ledger.perRepo.reduce((sum, e) => sum + e.recordCount, 0)
  const want = ledger.n + (ledger.windowDroppedCount || 0)
  return held === want ? ledger : { ...ledger, perRepo: [{ ...ledger.perRepo[0], recordCount: ledger.perRepo[0].recordCount + want - held }, ...ledger.perRepo.slice(1)] }
}

// The digest for scripted lane answers: a lane whose answer is not an object is a lane that did not run.
function digestFromAnswers(agent) {
  const scope = agent['scope:repos']
  const ledger = agent['lane:ledger']
  const ci = agent['lane:ci']
  const git = agent['lane:git']
  const gitEntry = isObject(git) && Array.isArray(git.repos) ? git.repos[0] : null
  const lanes = {
    ledger: isObject(ledger) ? { status: 'ran' } : failedLane('ledger'),
    ci: isObject(ci) ? { status: 'ran' } : failedLane('ci'),
    git: isObject(gitEntry) ? { status: 'ran' } : failedLane('git'),
  }
  return {
    lanes,
    ...(isObject(ledger) ? { ledger: { neverFailingInsufficientCount: 0, ...agreeing(ledger) } } : {}),
    ...(isObject(ci) ? { ci } : {}),
    ...(isObject(gitEntry) ? { git: gitEntry } : {}),
    dropped: { ...DROPPED_ZERO },
    plan_labels: scope.plan_labels || [],
    plan_labels_note: null,
  }
}

// Same signature as runWorkflow. A call that already carries a digest, or scripts no scope answer, is passed through.
function runWorkflow(file, options = {}) {
  const { args = {}, agent = {} } = options
  if (!isObject(agent['scope:repos']) || (isObject(args) && args.digest !== undefined)) return runRaw(file, options)
  const { 'scope:repos': scope, ...rest } = agent
  return runRaw(file, { ...options, args: { ...args, digest: digestFromAnswers(agent), nonce: scope.nonce }, agent: rest })
}

module.exports = { runWorkflow, digestFromAnswers }
