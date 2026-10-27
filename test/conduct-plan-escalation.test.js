// Static pins for the conductor's escalation round (specs/harn-opt-5.md T2:
// AC-QA-25, AC-PROD-1 to 4, AC-SEC-16, AC-OPS-16). Same shape as
// test/conduct-plan-prior-findings-protection.test.js: read
// skills/conduct-plan/SKILL.md and pin sentences by regex.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8')
const skill = () => read('skills', 'conduct-plan', 'SKILL.md')

function breaker() {
  const s = skill()
  const start = s.indexOf('**Rework circuit-breaker')
  const end = s.indexOf('- Do not fan out')
  assert.ok(start !== -1 && end > start, 'could not locate the Rework circuit-breaker bullet')
  return s.slice(start, end)
}

function step5() {
  const s = skill()
  const start = s.indexOf('5. **Blocked on the human?**')
  const end = s.indexOf('6. **Done?**')
  assert.ok(start !== -1 && end > start, 'could not locate step 5')
  return s.slice(start, end)
}

const flat = (t) => t.replace(/\s+/g, ' ')

test('breaker: one escalation round via /tdd-task with model, in a fresh implementer, precedes any block note', () => {
  const b = flat(breaker())
  const esc = b.search(/escalation round/i)
  assert.ok(esc !== -1, 'breaker must describe an escalation round')
  assert.match(b, /\/tdd-task[^.]*`model`|`model`[^.]*\/tdd-task/, 'escalation must go through /tdd-task with `model`')
  assert.match(b, /fresh implementer/i)
  assert.match(b, /never a direct implementer dispatch/i)
  assert.match(b, /one review-cycle round/i)
  const block = b.search(/block note/i)
  assert.ok(block !== -1 && esc < block, 'escalation sentence must precede the first mention of the block note')
})

test('breaker: per-trigger rule (three fix rounds escalate; first self-inflicted regression goes straight to the block note)', () => {
  const b = flat(breaker())
  assert.match(b, /three fix rounds[^]*?escalation round/i)
  assert.match(b, /first self-inflicted regression[^.]*straight to the block note[^.]*frame question|first time a review round finds[^]*?straight to the block note[^]*?frame question/i)
  assert.match(b, /value call the owner must make/i)
})

test('breaker: an escalation round that is not clean, or a task already escalated, goes straight to the block; never a second escalation', () => {
  const b = flat(breaker())
  assert.match(b, /escalation round whose own build or review is not clean goes straight to the block/i)
  assert.match(b, /already run[^.]*straight to the block note[^.]*never a second escalation/i)
  assert.doesNotMatch(b, /second escalation (is|may be) (allowed|permitted)|up to two escalation/i)
})

test('escalation model token: stated in exactly one place, both defaults, differs from the repo pin, skipped case worded', () => {
  const s = flat(skill())
  const stmts = s.match(/escalation model token/gi) || []
  assert.equal(stmts.length, 1, 'the escalation model token must be stated in exactly one place')
  const repoPin = read('agents', 'implementer.md').match(/^model:\s*(\S+)/m)[1]
  const toRepo = s.match(new RegExp('default `' + repoPin + '`[^.]*?escalates to `([a-z0-9.-]+)`', 'i'))
  assert.ok(toRepo, 'must state the token the repo default (' + repoPin + ') escalates to')
  assert.notEqual(toRepo[1], repoPin, 'escalation token must differ from the repo implementer pin')
  assert.match(s, /default `sonnet`[^.]*?escalates to `opus`/i)
  assert.match(s, /escalation skipped: no stronger tier/)
})

test('breaker: the old direct-to-block wording is gone for three fix rounds and kept for the regression trigger', () => {
  const b = flat(breaker())
  const intro = b.slice(0, b.search(/three fix rounds/i))
  assert.doesNotMatch(intro, /Stop and record the block \(step 5\)/, 'no direct stop-and-block as the first action at three fix rounds')
  // Conductor (implementer's own caveat): a reworded direct-to-block phrase INSIDE the three-rounds bullet survived
  // the two pins above, so the bullet's order is pinned: its first mention of the escalation round comes before its
  // first mention of the block note, which is what AC-OPS-16 means by "the escalation round precedes any block".
  const threeStart = b.search(/three fix rounds on one task/i)
  const threeEnd = b.search(/the first time a review round finds/i)
  assert.ok(threeStart >= 0 && threeEnd > threeStart, 'sanity: the three-rounds bullet is located')
  const bullet = b.slice(threeStart, threeEnd)
  const esc = bullet.search(/escalation round/i)
  const block = bullet.search(/block( note)?|stop and record/i)
  assert.ok(esc >= 0, 'the three-rounds bullet names the escalation round')
  assert.ok(block < 0 || esc < block, 'in the three-rounds bullet the escalation round is named before any block')
  assert.doesNotMatch(b, /Stop and record the block \(step 5\) with the frame question, rather than iterating, at whichever/)
  const reg = b.slice(b.search(/first (self-inflicted regression|time a review round)/i))
  assert.match(reg, /record the block \(step 5\)|straight to the block note/i)
})

test('block-note template: escalation fields, failed/ABORTED wording, and the AC-SEC-16 restriction', () => {
  const t = flat(step5())
  assert.match(t, /model token[^.]*escalat[^.]*default[^.]*escalated from|escalated from[^.]*model token/i)
  assert.match(t, /tdd-task verdict[^.]*blocked_reason/i)
  assert.match(t, /review verdict[^.]*finding counts by severity/i)
  assert.match(t, /frame question/i)
  assert.match(t, /failed to dispatch or ABORTED[^.]*says so|escalation (round )?(itself )?(failed to dispatch|ABORTED)/)
  assert.match(t, /outcome codes, round counts and blocked_reason only/i)
  assert.match(t, /never verbatim verifier evidence or (a )?test_defect/i)
})

test('step 5: human_wait_started and human_wait_ended are numbered (lettered) sub-steps tied to writing and deleting the note', () => {
  const t = step5()
  assert.match(t, /^\s+[a-z]\.\s[^]*?human_wait_started[^]*?(block note|blocked-on-human)/m)
  const sub = t.split(/^\s+(?=[a-z]\.\s)/m)
  assert.ok(sub.some((x) => /human_wait_started/.test(x) && /written|write/.test(x)), 'human_wait_started must sit in a sub-step about writing the note')
  assert.ok(sub.some((x) => /human_wait_ended/.test(x) && /delet/.test(x)), 'human_wait_ended must sit in a sub-step about deleting the note')
})

test('docs/claude-md-section-2-replacement.md exists with the escalation row, no "4 to 5" row, and says the owner applies it by hand', () => {
  const p = path.join(ROOT, 'docs', 'claude-md-section-2-replacement.md')
  assert.ok(fs.existsSync(p), 'docs/claude-md-section-2-replacement.md must exist')
  const d = fs.readFileSync(p, 'utf8')
  assert.match(d, /escalation round/i)
  assert.match(d, /\/tdd-task/)
  assert.match(d, /by hand/i)
  assert.doesNotMatch(d, /\|\s*4 to 5\s*\|/)
  assert.match(d, /\|\s*1 to 3\s*\|/)
})
