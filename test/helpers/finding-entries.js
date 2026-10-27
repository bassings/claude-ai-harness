// The finding-id oracle. HARN-OPT-6: review-cycle.js computes finding ids itself
// and sends the writer ids only, so writer-side tests send finding_entries
// directly, as literals; nothing in the test tree converts descriptors into the
// payload any more (test/static-checks.test.js enforces that, AC-QA-14).
//
// findingId below is a copy of ledger-append.mjs findingId as of commit
// 06049e4, using node:crypto (AC-QA-2, AC-DATA-9). It is what holds the
// in-script sha256 in review-cycle.js to the ids the ledger already holds.
const { createHash } = require('node:crypto')

function findingId(lens, location, claim) {
  return createHash('sha256')
    .update(String(lens || ''))
    .update(' ')
    .update(String(location || '').trim().toLowerCase())
    .update(' ')
    .update(String(claim || ''))
    .digest('hex')
    .slice(0, 16)
}

module.exports = { findingId }
