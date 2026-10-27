// Static pins for the conductor's escalation round (specs/harn-opt-5.md T2:
// AC-QA-25, AC-PROD-1 to 4, AC-SEC-15, AC-SEC-16, AC-OPS-1, AC-OPS-9,
// AC-OPS-16, AC-DATA-20). Same shape as
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
  // Review round 1 L2 (M4, M5): presence plus contradiction. Exactly one round, and the merge waits for the review.
  assert.match(b, /exactly one escalation round/i)
  assert.doesNotMatch(b, /one or more escalation rounds|up to \w+ escalation rounds/i)
  assert.match(b, /one full review-cycle round/i)
  assert.match(b, /clean build and a clean review merge as usual/i)
  assert.doesNotMatch(b, /merge[^.]*without[^.]*review/i, 'a merge never skips the escalation review')
  const block = b.search(/block note/i)
  assert.ok(block !== -1 && esc < block, 'escalation sentence must precede the first mention of the block note')
})

test('breaker: per-trigger rule (three fix rounds escalate; first self-inflicted regression goes straight to the block note)', () => {
  const b = flat(breaker())
  assert.match(b, /three fix rounds[^]*?escalation round/i)
  assert.match(b, /first self-inflicted regression[^.]*straight to the block note[^.]*frame question|first time a review round finds[^]*?straight to the block note[^]*?frame question/i)
  assert.match(b, /value call the owner must make/i)
  // Review round 1 M1 (AC-QA-25): the regression bullet carries NO escalation round. Slice it, require the explicit
  // "with no escalation round", and with that phrase removed require no other mention of an escalation round.
  const regStart = b.search(/the first time a review round finds/i)
  const regEnd = b.search(/The escalation model token/i)
  assert.ok(regStart >= 0 && regEnd > regStart, 'sanity: the regression bullet is located')
  const regBullet = b.slice(regStart, regEnd)
  assert.match(regBullet, /with no escalation round/i)
  assert.doesNotMatch(regBullet.replace(/with no escalation round/i, ''), /escalation round/i, 'the regression trigger never dispatches an escalation round')
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
  // Round 2 L2 (M3, M4): the intro sentence is pinned verbatim, and in the three-rounds bullet nothing before the
  // escalation sentence mentions a note, the owner or stopping.
  assert.match(intro, /count\.\*\* There are two triggers, and they do not behave alike:\s*-?\s*\**\s*$/)
  const bulletStart = b.search(/three fix rounds on one task/i)
  const escAt = b.indexOf('escalation round', bulletStart)
  const preEscalation = b.slice(bulletStart, escAt)
  assert.doesNotMatch(preEscalation, /\bnote\b|\bowner\b|\bstop\b|\bask\b/i, 'nothing before the escalation sentence stops, writes a note or asks the owner')
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

// Review round 1 M2 (AC-OPS-1): the log line for the escalation round carries four items, each pinned on its own.
test('breaker: the Conductor log line for an escalation round records the four AC-OPS-1 items', () => {
  const b = flat(breaker())
  const logStart = b.search(/Conductor log line for the escalation round/i)
  assert.ok(logStart >= 0, 'the breaker names the log line for the escalation round')
  const logSentence = b.slice(logStart, b.indexOf('.', b.indexOf('(or that no review ran)')) + 1)
  assert.match(logSentence, /that it was dispatched/i)
  assert.match(logSentence, /exact `model` token passed to \/tdd-task/)
  assert.match(logSentence, /tdd-task verdict/)
  assert.match(logSentence, /review verdict and round/i)
  // Round 2 M2 and L5: the line is the durable state (branch or worktree, run id) and records the model the runtime
  // reported, so a restarted session reconciles from the log and a same-tier "escalation" is visible.
  assert.match(logSentence, /model the runtime reported for the escalation implementer/i)
  assert.match(logSentence, /escalation branch or worktree path and the tdd-task run id/i)
  assert.match(b, /durable state a later wake reconciles from/i)
})

// Round 2 M2: the clean path is explicit (fast-forward, awaiting-ci, merge only on green), never a bare "merge as usual".
test('breaker: a clean escalation round fast-forwards the PR branch, returns to awaiting-ci and merges only on green CI', () => {
  const b = flat(breaker())
  assert.match(b, /fast-forward the PR branch to the escalation tip \(a plain push, never a force-push\)/i)
  assert.match(b, /return the task to `awaiting-ci`, and merge only on green CI/i)
})

// Round 2 M1: a refused token is a failed dispatch that names the token; "no stronger tier" is only the strongest-default case.
test('escalation token: a refused token is reported as a failed dispatch naming the token, never as no stronger tier', () => {
  const s = flat(skill())
  assert.match(s, /If the runtime refuses the token, that is a failed dispatch, not a missing tier/i)
  assert.match(s, /escalation failed to dispatch: runtime refused model `<token>`/)
  const refusal = s.slice(s.indexOf('If the runtime refuses the token'), s.indexOf("step 5 d's failed-to-dispatch rule applies") + 40)
  assert.doesNotMatch(refusal, /no stronger tier/i, 'the refusal sentence never says no stronger tier')
  assert.doesNotMatch(s, /or the runtime refuses the token, the round is skipped/i)
  // Round 2 L5: "the default" is the model the previous round's transcript reports, never a pin read off a file.
  assert.match(s, /"The default" is the model the previous round's implementer transcript reports/i)
})

// Review round 1 M3 (AC-DATA-20): the escalation keeps the round-3 state, and the block note records the tip.
test('breaker and block note: the escalation commits on its own branch, the PR tip is not moved or force-pushed until the review is clean, and the note records the pre-escalation SHA', () => {
  const b = flat(breaker())
  assert.match(b, /dispatched only after the previous implementer's process has exited/i)
  assert.match(b, /commits on its own branch or worktree/i)
  assert.match(b, /PR branch tip is not moved, and is never force-pushed, until the escalation round's review is clean/i)
  assert.match(b, /pre-escalation SHA/i)
  const t = flat(step5())
  assert.match(t, /pre-escalation PR tip SHA/i)
})

// Review round 1 L1 (AC-SEC-15): the escalation review names lens-security; a non-clean result blocks, never merges.
test('breaker: the escalation review is the full review cycle with lens-security, and a non-clean result writes the block note', () => {
  const b = flat(breaker())
  assert.match(b, /full review-cycle round[^.]*lens-security/i)
  assert.match(b, /not clean goes straight to the block note/i)
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
  // Round 2 M2: the note names the escalation branch beside the pre-escalation SHA.
  assert.match(t, /pre-escalation PR tip SHA[^.]*escalation branch or worktree path/i)
  // Round 2 L2 (M6): no sentence anywhere in step 5 asks for verifier output in any wording, except the ban itself.
  const withoutBan = t.replace(/never verbatim verifier evidence or (a )?test_defect reason/i, '')
  assert.doesNotMatch(withoutBan, /(quote|paste|include|copy)[^.]*(verifier|evidence|output|test_defect)/i, 'step 5 never asks for verifier output')
  // Review round 1 L2 (M7): no sentence anywhere in step 5 asks for verbatim evidence; the only "verbatim" is the ban.
  const mentions = t.match(/verbatim/gi) || []
  assert.equal(mentions.length, 1, 'the word verbatim appears once in step 5, in the ban')
  assert.doesNotMatch(t, /paste[^.]*verbatim|verbatim[^.]*into the (log|note)/i)
})

test('step 5: human_wait_started and human_wait_ended are numbered (lettered) sub-steps tied to writing and deleting the note', () => {
  const t = step5()
  assert.match(t, /^\s+[a-z]\.\s[^]*?human_wait_started[^]*?(block note|blocked-on-human)/m)
  const sub = t.split(/^\s+(?=[a-z]\.\s)/m)
  const started = sub.find((x) => /human_wait_started/.test(x))
  const ended = sub.find((x) => /human_wait_ended/.test(x))
  assert.ok(started && /written|write/.test(started), 'human_wait_started must sit in a sub-step about writing the note')
  assert.ok(ended && /delet/.test(ended), 'human_wait_ended must sit in a sub-step about deleting the note')
  // Review round 1 L2 (M6) and L3 (AC-OPS-9): the start is appended after the note, never before, on both paths
  // (note written, or write refused and the question asked in the reply), and every start has its end, including
  // a leftover note deleted at Done.
  assert.match(flat(started), /after the note, never before it/i)
  assert.doesNotMatch(flat(started), /before the note is written, append/i)
  assert.match(flat(started), /whether the note was written[^.]*or the write was refused/i)
  assert.match(flat(started), /exactly once per block/i)
  assert.match(flat(ended), /exactly once per block/i)
  const s = flat(skill())
  const done = s.slice(s.indexOf('6. **Done?**'))
  assert.match(done, /blocked-on-human[^.]*appending `human_wait_ended`/i, 'step 6 pairs the start of a leftover note it deletes')
  // Round 2 L1 (AC-OPS-9): the end is keyed by the task id of the start it closes, and written at most once per block.
  assert.match(done, /under the task id of the log entry that recorded that block's `human_wait_started`/i)
  assert.match(done, /only if no end was written for it/i)
  assert.match(flat(ended), /task id of the log entry that recorded that block's `human_wait_started`/i)
  assert.match(flat(ended), /only when no end has been written for that block/i)
  // Round 2 L4: a refused or stopped event write is recorded in the tick's log entry.
  assert.match(s, /Check the writer's response every time: on `write_ok: false`, or a call that was stopped before it ran, record `<event> not written: <write_error>`/i)
  const step3 = s.slice(s.indexOf('Also log task-level state transitions'), s.indexOf('`<plan file>` must be repo-relative'))
  assert.match(step3, /block entry and exit \(step 5 e and f, and step 6/i, 'step 3 defers to the numbered sub-steps rather than its own entry/exit wording')
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
  // Round 2 L3: the hand-applied mirror's token pairs equal the skill's, each escalating to a different model, and
  // the mirror states the trigger rule and the single-round rule.
  const pairs = (text) => Object.fromEntries([...flat(text).matchAll(/default `([a-z0-9.-]+)` escalates to `([a-z0-9.-]+)`/gi)].map((m) => [m[1], m[2]]))
  const inSkill = pairs(skill())
  const inDoc = pairs(d)
  assert.deepEqual(inDoc, inSkill, 'the mirror text carries the same escalation pairs as the skill')
  assert.ok(Object.keys(inSkill).length >= 2)
  for (const [from, to] of Object.entries(inSkill)) assert.notEqual(from, to, `${from} must escalate to a different model`)
  assert.match(d, /three-fix-rounds trigger\s+only/i)
  assert.match(d, /never a second escalation round/i)
  assert.match(d, /failed dispatch and the note names the token/i)
})
