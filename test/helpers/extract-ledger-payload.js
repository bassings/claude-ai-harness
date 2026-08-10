// Extracts the JSON payload a workflow's ledger-write prompt embeds, so a
// seam contract test (test/ledger-seam.test.js) can feed the EXACT payload
// a workflow actually emitted into a real workflows/lib/ledger-append.mjs
// run, rather than a hand-written stand-in that only proves the two sides
// agree by coincidence (this is the gap H3 exists to close).
//
// Two embedding shapes are supported so this helper keeps working across
// the H1 fix (raw JSON in the prompt -> base64 in the prompt): a raw `{...}`
// JSON object found by brace-matching (tolerant of nested braces/strings),
// or, if none parses, the first long base64-alphabet run, decoded then
// parsed. Whichever the current prompt text actually uses is picked up
// automatically; nothing here should need to change again when the prompt
// wording changes, only if the embedding mechanism itself changes again.

function findJsonObject(text) {
  const start = text.indexOf('{')
  if (start === -1) return null
  let depth = 0
  let inString = false
  let escape = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escape) escape = false
      else if (ch === '\\') escape = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') { inString = true; continue }
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return null
}

function extractLedgerPayload(promptText) {
  const jsonBlob = findJsonObject(promptText)
  if (jsonBlob) {
    try {
      return JSON.parse(jsonBlob)
    } catch (e) {
      // fall through to the base64 route
    }
  }
  const b64Match = promptText.match(/[A-Za-z0-9+/]{40,}={0,2}/)
  if (b64Match) {
    try {
      return JSON.parse(Buffer.from(b64Match[0], 'base64').toString('utf8'))
    } catch (e) {
      // fall through to the error below
    }
  }
  throw new Error('extractLedgerPayload: could not find a JSON payload (raw or base64) in the prompt text')
}

module.exports = { extractLedgerPayload }
