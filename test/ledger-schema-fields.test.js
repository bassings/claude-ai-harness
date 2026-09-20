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

// K1 review round 5, L5: this used to doctor the LIVE copy and assert it
// differed from the export, which cannot fail -- a field named
// `a_field_the_export_does_not_have` is never in the export, whatever the
// export says, so the assertion held even with the export file emptied.
// It now doctors the REAL EXPORT FILE's contents, three ways, and asserts
// the drift check above rejects each. Measured: removing one field from the
// real export turns that check red and left the old version of this test
// green, which is what a mutation guard exists to notice.
test('mutation guard: the drift check rejects a doctored EXPORT, in each way an export can drift', async () => {
  const { LEDGER_ENTRY_SCHEMA } = await import(APPEND_MODULE_URL)
  const live = fieldTypesFromSchema(LEDGER_ENTRY_SCHEMA)
  const real = JSON.parse(fs.readFileSync(EXPORT_PATH, 'utf8'))
  assert.deepEqual(real, live, 'precondition: the real export is in step with the live schema')

  const field = Object.keys(real).sort()[0]
  assert.ok(field, 'sanity: the export must hold at least one field to doctor')

  const dropped = { ...real }
  delete dropped[field]
  assert.throws(() => assert.deepEqual(dropped, live),
    `a field dropped from the export (${field}) must fail the drift check`)

  const retyped = { ...real, [field]: 'a-type-the-schema-does-not-declare' }
  assert.throws(() => assert.deepEqual(retyped, live),
    `a field retyped in the export (${field}) must fail the drift check`)

  const extra = { ...real, a_field_the_schema_does_not_declare: 'string' }
  assert.throws(() => assert.deepEqual(extra, live),
    'a field present only in the export must fail the drift check')
})
