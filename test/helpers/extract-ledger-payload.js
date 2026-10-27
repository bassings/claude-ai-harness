// Extracts the JSON payload a workflow's ledger-write prompt embeds, so a
// seam contract test (test/ledger-seam.test.js) can feed the EXACT payload
// a workflow actually emitted into a real workflows/lib/ledger-append.mjs
// run, rather than a hand-written stand-in that only proves the two sides
// agree by coincidence (this is the gap H3 exists to close).
//
// HARN-OPT-5 T5 (AC-QA-15): the payload now sits in the prompt between a
// pair of fixed delimiter lines, base64-encoded, and is fed to the writer
// from a private file rather than a shell string. This helper reads ONLY
// what is between those lines. The earlier "first { in the prompt" and
// "first long base64 run" heuristics are gone on purpose: a payload (or the
// prompt's own prose, e.g. the literal {run_id, ts, write_ok, write_error})
// can contain braces, and a heuristic that guesses the boundary round-trips
// by coincidence rather than by contract.
const START_DELIMITER = '<<<HARNESS-LEDGER-PAYLOAD>>>'
const END_DELIMITER = '<<<END-HARNESS-LEDGER-PAYLOAD>>>'

function extractEncodedPayload(promptText) {
  const lines = String(promptText).split('\n')
  const starts = lines.flatMap((l, i) => (l === START_DELIMITER ? [i] : []))
  const ends = lines.flatMap((l, i) => (l === END_DELIMITER ? [i] : []))
  if (starts.length !== 1 || ends.length !== 1 || ends[0] <= starts[0]) {
    throw new Error(
      `extractEncodedPayload: expected exactly one ${START_DELIMITER} line followed by exactly one ${END_DELIMITER} line ` +
        `in the prompt text (found ${starts.length} start, ${ends.length} end)`
    )
  }
  return lines.slice(starts[0] + 1, ends[0]).join('\n').trim()
}

function extractLedgerPayload(promptText) {
  const encoded = extractEncodedPayload(promptText)
  return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'))
}

module.exports = { extractLedgerPayload, extractEncodedPayload, START_DELIMITER, END_DELIMITER }
