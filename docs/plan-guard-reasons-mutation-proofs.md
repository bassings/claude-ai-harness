# plan-guard-stop.py reason narration: mutation proofs

Per standard §11: for each guard below, the guarded behaviour was actually
broken in the working file (edited directly, not "mentally mutated"), the
diff was read back to confirm the edit landed on the intended line (not a
comment, not the wrong occurrence when a string appeared more than once),
the test file was run and the exact failing test(s) recorded, then the file
was restored via `cp` from a pre-mutation snapshot -- never `git checkout
--` -- confirmed via `diff` against the snapshot returning nothing before
the next mutation.

This document covers two build rounds on the same branch
(`feat/plan-guard-states-its-reason`):

- **Round 1**: `plan_guard_decision()`'s eleven `return None` sites (all
  producing identical silence on `main`) became a `GuardResult(decision,
  message)` where ten of eleven allow paths narrate which condition applied,
  the block path is unchanged, and the one no-marker path stays silent by
  design.
- **Round 2**: prose and robustness fixes from an independent adversarial
  review of round 1 -- a status-line length limit, a `session_id` type
  coercion, and two wording corrections. No decision logic changed.

**Test count.** `python3 -m unittest discover -s hooks -p 'test_*.py'`:
14/14 on `main` before this branch; 23/23 after round 1; 26/26 after round 2
(3 new: the truncation limit in both directions, the non-string
`session_id` coercion). Run repeatedly in this session with no flakes
observed. `node --test test/*.test.js`: 999/999 both before and after this
branch, untouched by either round -- no JS test references
`plan-guard-stop.py` (`grep -rl "plan-guard-stop\|plan_guard_decision"
test/*.test.js` returns nothing). The brief that opened round 1 stated a
999-test Node baseline of 1049/1049; this session measured 999/999 on the
worktree's actual pre-change `main`-derived commit and could not reconcile
the difference. Recorded as unverified against the brief's number, not as a
regression this branch caused: `git diff --stat` against every commit in
this branch touches only `hooks/plan-guard-stop.py`,
`hooks/test_plan_guard_stop.py`, `skills/conduct-plan/SKILL.md` and
`README.md`.

## Round 1: the eleven return sites

Driven directly against `plan_guard_decision()` (`hooks/test_plan_guard_stop.py`,
class `TestPlanGuard`) and, for the JSON envelope main() wraps around it, as
a real subprocess with real stdin/stdout (`class TestMainEndToEnd`).

| # | Guard | Location | Mutation | Diff confirmed on | Result |
|---|---|---|---|---|---|
| 1 | The routine "armed, tasks open" allow names the plan path and the open-task count in the right slots | `plan_guard_decision()`, final `_allow(...)` before the block, `% (plan_path, open_tasks)` | swapped to `% (open_tasks, plan_path)` | single-line diff | `test_allows_when_a_wake_source_was_armed` errored (format string now expects an int where a string landed) and `test_allow_path_prints_exactly_the_systemMessage_envelope` failed |
| 2 | The bystander message names the CALLING session as the bystander and the MARKER's conductor as the claim-holder, not swapped | bystander `_allow(...)`, `% (session_id, plan_path, conductor)` | swapped to `% (conductor, plan_path, session_id)` | single-line diff | `test_a_bystander_session_is_not_enforced` failed -- it pins both ids' exact placement in the sentence, not just membership |
| 3 | The "enforcing NOTHING" wording on the unreadable-plan-file message is exact, and distinct from the zero-open-tasks message that shares the same phrase | first of two occurrences of `'The guard is enforcing NOTHING on this '` (the OSError-on-read message) | weakened to `'The guard is enforcing something on this '` | single-line diff, confirmed it landed on the FIRST occurrence only (the string appears twice in the file) | `test_unreadable_plan_file_allows_and_says_nothing_is_enforced` failed; `test_allows_when_every_task_is_ticked` (the zero-tasks message, second occurrence, untouched) stayed green -- proving the two messages are pinned independently, not by a shared loose fragment |
| 4 | The open-tasks block path is a BLOCK, not an allow -- the exact incident shape this branch exists to prevent | final `return _block(...)` | changed to `return _allow(...)` (same wording, wrong decision) | single-line diff | 7 tests failed: `test_blocks_when_tasks_open_and_nothing_armed`, three of the blocked-on-human-is-history tests (`test_historical_block_...`, `test_unbolded_historical_block_...`, `test_a_differently_cased_conductor_log_heading_...`, `test_marker_mentioned_in_prose_...`), and `test_block_path_prints_exactly_the_decision_envelope` at the byte level |
| 5 | The one deliberately silent path (no marker) never emits a message | `_silent()` on the no-marker branch | replaced with `_allow('Plan guard: allowed. No plan is being conducted here.')` | single-line diff | `test_allows_when_no_marker_file` failed (decision no longer `'silent'`) and `test_silent_path_prints_nothing_at_all` failed (stdout no longer empty) |

All five mutations were restored via `cp` from a pre-mutation backup and
confirmed identical via `diff` before the next mutation and before the
round-1 commit.

**Not individually mutation-tested in round 1**, stated rather than
silently omitted: the remaining six narrated reasons (the `stop_hook_active`
escape hatch, the unreadable/malformed-marker pair, the stale-conductor
re-claim, the first-claim, and the live blocked-on-human quote) are each
covered by a dedicated positive-assertion test pinning discriminating
content (exact session/conductor ids, the exact marker or plan path, the
quoted status line), but this session did not separately break each one and
watch it fail before this document was first written. An independent
adversarial review of round 1 (reported to me, not reproduced in this
document) ran a further 21 mutations covering all fourteen original
properties individually, four reason-swaps across the ten narrated
messages, and a cross-check that no test's assertions pass against a
different path's message, and reported every one caught with the block
path byte-identical to `main`. That round's transcript was not available to
reproduce here; it is recorded as reported, not independently re-verified
in this session.

## Round 2: the review-1 fixes

| # | Guard | Location | Mutation | Diff confirmed on | Result |
|---|---|---|---|---|---|
| 6 | A quoted live blocked-on-human status line longer than `STATUS_QUOTE_LIMIT` (200) characters is truncated with an ellipsis before it reaches the message | `truncate_for_quoting()`, `if len(text) <= limit: return text` / `return text[:limit] + '...'` | replaced the whole function body with `return text` (truncation disabled) | single-line diff | `test_an_oversized_live_block_status_is_truncated_in_the_message` failed (a 200,000-character status line reached the message verbatim); `test_truncate_for_quoting_leaves_a_short_line_untouched` stayed green, since an unconditional no-op also leaves short text untouched -- expected, and the complementary mutation below closes that gap |
| 7 | The same function does NOT truncate text already at or under the limit | `truncate_for_quoting()`, same branch | replaced the whole function body with `return text[:limit] + '...'` (unconditional truncate) | single-line diff | `test_truncate_for_quoting_leaves_a_short_line_untouched` failed (a 43-character status line came back with `...` appended); `test_an_oversized_live_block_status_is_truncated_in_the_message` stayed green, since an unconditional truncate still bounds the oversized case -- the pair together pin both branches of the `if`, one test each |

Both mutations were restored via `cp` from a pre-mutation backup and
confirmed identical via `diff` before the next mutation and before the
round-2 commit. Full suite run again after the final restore: 26/26.

**Not mutation-tested, prose-only per the brief's own instruction**
("prose fixes need no mutation but must be accurate"): the docstring's
terminal-rendering claim, the spec-citation removal, the new marker-deletion
blind-spot paragraph, the README update, and the `session_id` coercion in
`main()`. The `session_id` coercion has a positive end-to-end test
(`test_a_non_string_session_id_does_not_crash_and_is_coerced_to_plain_text`)
proving a non-string payload value does not crash and reaches the message
as plain text, but was not separately mutated (removing the `str()` call
reproduces the pre-existing behaviour on `main`'s equivalent code path
rather than introducing a new guarded property, so there is no meaningful
"wrong" state to distinguish it from beyond what that test already checks).

## Coverage gaps, stated plainly

- Round 1's mutation set covers five of the eleven return sites directly;
  the other six rely on the independent reviewer's reported 21-mutation
  pass, which this document did not reproduce firsthand.
- The truncation limit's exact value (200) is a judgement call from the
  brief ("about 200 characters"), not independently re-derived or load-bearing
  at a specific number -- the tests assert the bound is enforced and its
  exact arithmetic (`STATUS_QUOTE_LIMIT - len(prefix)` characters before the
  ellipsis), not that 200 specifically is the right number.
- Whether a `systemMessage` from a non-blocking, exit-0 Stop hook is
  rendered to a human in an interactive terminal (as opposed to landing in
  the session record, which IS verified) remains unestablished by anything
  run in this repo. See the module docstring in `hooks/plan-guard-stop.py`.
