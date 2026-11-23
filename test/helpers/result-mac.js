// The workflow's keyed digest (result_mac), worked out from the byte sequence the criteria define, independently of the workflow and of the
// result check: SHA-256 of  nonce "\n" report "\n" canonicalJson(proposal_targets) "\n" canonicalJson(lanes)  (UTF-8, keys sorted at every depth).
// A test that edits a returned result and means the edit to be the layer under test, not a forgery, signs it again with this.
const crypto = require('node:crypto')

const canonical = (v) => {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`
  if (v !== null && typeof v === 'object') return `{${Object.keys(v).sort((a, b) => (a < b ? -1 : 1)).map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`
  return JSON.stringify(v)
}
const macOf = (result, nonce) => crypto.createHash('sha256').update(`${nonce}\n${result.report}\n${canonical(result.proposal_targets)}\n${canonical(result.lanes)}`, 'utf8').digest('hex')
const resign = (result, nonce) => {
  result.result_mac = macOf(result, nonce)
  return result
}

module.exports = { macOf, resign }
