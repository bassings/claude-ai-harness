// Drives the optimise workflow's REAL report render for a table of never-failing
// criteria rows, so a test can compare what the render shows with what the collector's
// digest keeps (HARN-RUNNER-2 T1b, F4). The fixtures are the smallest set of lane
// responses the workflow accepts; only the ledger lane's neverFailingAcs matters here.
const path = require('node:path')
const { runWorkflow } = require('./digest-run.js')

const WORKFLOW = path.join(__dirname, '..', '..', 'workflows', 'optimise-cycle.js')
const NONCE = 'deadbeefcafef00d0123456789abcdef'

const SOURCES = { ci_wait: 'ledger:conduct_plan_event', human_wait: 'ledger:conduct_plan_event', agent_compute: 'ledger:tdd_task|review_cycle|plan_cycle start/terminal pair' }
const TOTALS = { ciWaitSeconds: 0, humanWaitSeconds: 0, agentComputeSeconds: 0, unterminatedWaits: 0, agentComputeStartOnlyRuns: 0, agentComputeTerminalOnlyRuns: 0, agentComputeStartOnlyByKind: {}, agentComputeTerminalOnlyByKind: {}, agentComputeAbortedPairs: 0 }
const REWORK = { n: 6, lensDispositionCounts: {}, acVerdicts: [], invalidAcIdsDropped: 0, invalidRecordValuesDropped: 0, invalidFixedIdsDropped: 0, duplicateFixedIdsDropped: 0, duplicateFixedAcrossRounds: 0, invalidPriorIdsDropped: 0, findingsTruncated: 0, acVerdictsTruncated: 0, unattributedFindings: 0, noSpecReviewRuns: 0, noSpecFindingsReclassified: 0 }

const ledgerLane = (neverFailingAcs) => ({
  n: 6,
  windowTruncated: false,
  windowDroppedCount: 0,
  perRepo: [{ root: 'demo', rootIndex: 0, uninstrumented: false, recordCount: 6, skippedCount: 0, schemaVersionsSeen: { 1: 6 }, truncatedFinalLine: false }],
  skipped: [],
  rework: REWORK,
  neverFailingAcs,
  wallClock: { byPlan: {}, totals: TOTALS, source: SOURCES },
  triggerAccuracy: { byLens: {} },
  proposalOutcomes: {},
  citationPool: ['run-1'],
})

const ciLane = { byJob: {}, citationPool: [], failures: [] }
const gitLane = { repos: [{ root_index: 0, repo: 'demo', count: 0, n_commits_examined: 0, method: 'm', window_note: 'w', scoped_count: 0, scoped_excluded_count: 0, scoped_unavailable_count: 0, scoped_config_source: 'default', scoped_exclude_globs: [], scoped_method: 's' }] }

const responses = (neverFailingAcs) => ({
  'scope:repos': { resolved: [{ requested: '.', root: '/repo', label: 'demo' }], unresolved: [], plan_labels: [], nonce: NONCE },
  'lane:ledger': ledgerLane(neverFailingAcs),
  'lane:ci': ciLane,
  'lane:git': gitLane,
  'synthesis:proposals': { proposals: [] },
})

// The report's line for each row, in row order (a row's repo/spec/criterion must be unique in the table), or null for a row the
// report does not list: the digest path leaves a plain insufficient-data row out and counts it (HARN-RUNNER-2 T1b, T4).
// `leftOut` is that count as the report states it.
async function renderNeverFailing(rows) {
  const { result } = await runWorkflow(WORKFLOW, { args: {}, agent: responses(rows) })
  const lines = result.report.split('\n')
  const found = rows.map((row) => {
    const own = lines.filter((line) => line.startsWith(`- ${row.repo}/${row.spec} ${row.ac_id}:`))
    if (own.length > 1) throw new Error(`expected at most one report line for ${row.ac_id}, found ${own.length}`)
    return own[0] ?? null
  })
  const stated = /(\d+) criteria rows left out as insufficient data/.exec(result.report)
  return Object.assign(found, { leftOut: stated ? Number(stated[1]) : 0 })
}

module.exports = { renderNeverFailing }
