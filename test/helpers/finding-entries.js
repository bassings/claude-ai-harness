// HARN-OPT-6: review-cycle.js now computes finding ids itself and sends the
// writer ids, never descriptors (lens, location, claim). Writer tests that
// still want to describe a round as descriptors build the payload here, the
// way review-cycle.js does, so that what reaches ledger-append.mjs is only the
// id-bearing finding_entries shape. This is a test-side stand-in for the
// script: it passes lens, severity and ac_id through RAW (the real script
// resolves or nulls them first), so the writer's own validation of those fields
// stays exercised by hand-built hostile values.
//
// findingId below is the oracle: a copy of ledger-append.mjs findingId as of
// commit 06049e4, using node:crypto (AC-QA-2, AC-DATA-9).
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

const LEGACY_DESCRIPTOR_KEYS = ['spec_bugs', 'rejected_findings', 'open_findings', 'prior_findings', 'fixed_findings']

function toFindingEntries(payload) {
  if (!payload || typeof payload !== 'object' || !LEGACY_DESCRIPTOR_KEYS.some((k) => k in payload)) return payload
  const { spec_bugs, rejected_findings, open_findings, prior_findings, fixed_findings, ...rest } = payload
  const entries = []
  const add = (list, disposition) => {
    if (!Array.isArray(list)) return
    for (const f of list) {
      if (!f || typeof f !== 'object') continue
      entries.push({ id: findingId(f.lens, f.location, f.claim), lens: f.lens, severity: f.severity || 'Low', ac_id: f.ac_id || null, disposition })
    }
  }
  add(spec_bugs, 'spec_bug')
  add(rejected_findings, 'rejected')
  add(open_findings, 'open')
  add(fixed_findings, 'fixed')
  const out = { ...rest, spec_bug_count: Array.isArray(spec_bugs) ? spec_bugs.length : null, rejected_finding_count: Array.isArray(rejected_findings) ? rejected_findings.length : null }
  if (Array.isArray(fixed_findings)) Object.assign(out, { invalid_fixed_ids_dropped: 0, duplicate_fixed_ids_dropped: 0 })
  if (Array.isArray(prior_findings)) {
    let invalid = 0
    for (const p of prior_findings) {
      const safe = p && typeof p === 'object' ? p : {}
      if (typeof safe.id === 'string' && safe.id === findingId(safe.lens, safe.location, safe.claim)) {
        entries.push({ id: safe.id, lens: safe.lens, severity: safe.severity || 'Low', ac_id: safe.ac_id || null, disposition: 'prior' })
      } else {
        invalid += 1
      }
    }
    out.invalid_prior_ids_dropped = invalid
  }
  out.finding_entries = entries
  return out
}

module.exports = { findingId, toFindingEntries, LEGACY_DESCRIPTOR_KEYS }
