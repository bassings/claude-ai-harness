// workflows/lib/ledger-schema-fields.json is a JSON export of
// LEDGER_ENTRY_SCHEMA's top-level property names and their JSON types
// (AC-ARCH-11), vendored into codex-ai-harness so its ledger rows write only
// fields the Claude schema actually declares. This test is the drift guard:
// it recomputes the same mapping from the LIVE schema object and fails the
// moment the export goes stale -- a field added, removed or retyped in
// ledger-append.mjs with no matching update to the JSON file.
//
// Read-only: this file imports LEDGER_ENTRY_SCHEMA from ledger-append.mjs
// and never edits it (AC-SIMP-8 -- ledger-append.mjs is byte-unchanged by
// this task and every other K1-K4 PR).
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const APPEND_SCRIPT = path.join(__dirname, '..', 'workflows', 'lib', 'ledger-append.mjs')
const APPEND_MODULE_URL = pathToFileURL(APPEND_SCRIPT).href
const EXPORT_PATH = path.join(__dirname, '..', 'workflows', 'lib', 'ledger-schema-fields.json')

// The same {name: type} projection used to generate the committed file --
// duplicated here (not imported from a shared helper) so this test proves
// the COMMITTED FILE matches the schema, rather than proving two copies of
// the same generation code agree with each other.
function fieldTypesFromSchema(schema) {
  const out = {}
  for (const [name, def] of Object.entries(schema.properties)) {
    out[name] = def.type
  }
  return out
}

test('ledger-schema-fields.json exists and is valid JSON', () => {
  assert.ok(fs.existsSync(EXPORT_PATH), `expected ${EXPORT_PATH} to exist`)
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(EXPORT_PATH, 'utf8')))
})

test('ledger-schema-fields.json matches LEDGER_ENTRY_SCHEMA\'s live property names and types exactly', async () => {
  const { LEDGER_ENTRY_SCHEMA } = await import(APPEND_MODULE_URL)
  const live = fieldTypesFromSchema(LEDGER_ENTRY_SCHEMA)
  const exported = JSON.parse(fs.readFileSync(EXPORT_PATH, 'utf8'))
  assert.deepEqual(
    exported, live,
    'workflows/lib/ledger-schema-fields.json has drifted from LEDGER_ENTRY_SCHEMA -- ' +
    'regenerate it from the live schema object (top-level property name -> its declared "type")'
  )
})

test('the export holds every field the schema requires unconditionally', async () => {
  const { LEDGER_ENTRY_SCHEMA } = await import(APPEND_MODULE_URL)
  const exported = JSON.parse(fs.readFileSync(EXPORT_PATH, 'utf8'))
  for (const required of LEDGER_ENTRY_SCHEMA.required) {
    assert.ok(Object.prototype.hasOwnProperty.call(exported, required),
      `exported field list is missing required schema field ${required}`)
  }
})

test('mutation guard: a field added to the live schema but not to the export is caught', async () => {
  const { LEDGER_ENTRY_SCHEMA } = await import(APPEND_MODULE_URL)
  const live = fieldTypesFromSchema(LEDGER_ENTRY_SCHEMA)
  live.a_field_the_export_does_not_have = 'string'
  const exported = JSON.parse(fs.readFileSync(EXPORT_PATH, 'utf8'))
  assert.notDeepEqual(exported, live, 'sanity: a deliberately drifted comparison must not read as equal')
})
