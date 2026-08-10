// Minimal fixture workflow used only to prove the fake-runtime test helper
// itself works. Not part of the shipped harness.
export const meta = {
  name: 'sample-workflow',
  description: 'fixture for fake-runtime tests',
  whenToUse: 'test only',
}

let opts = args
if (typeof opts === 'string') { try { opts = JSON.parse(opts) } catch (e) { opts = null } }
opts = opts || {}

log(`starting with ${JSON.stringify(opts)}`)
phase('One')
const a = await agent('first prompt', { label: 'first' })
if (!a) return { verdict: 'ABORTED' }

phase('Two')
const b = await agent('second prompt', { label: 'second' })
if (!b) return { verdict: 'ABORTED' }

return { verdict: 'DONE', a, b, spent: budget ? budget.spent() : null }
