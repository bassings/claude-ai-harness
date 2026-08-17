# Repo trigger overrides must fail closed, not silently fall back

## Problem

`workflows/review-cycle.js` lets a repo tune which lenses fire on which paths
via `.claude/harness-triggers.json`. That override reaches the workflow as
`custom_rules`, a field an LLM step is asked to read from disk and re-emit.

Three defects, all in the same few lines:

1. **`custom_rules` is absent from the scope schema's `required` list**
   (`review-cycle.js:210`). The runtime enforces `required`, so an omitted
   field is only caught when it is listed there. It is not.
2. **The merge is unconditional and silent**: `Object.assign({}, DEFAULT_RULES,
   scope.custom_rules || {})` (`:227`). Undelivered, unparseable or omitted,
   the run proceeds on harness defaults with no error.
3. **Nothing in the output says which rule source was used.** The log line
   reports lens names and file counts only, so the artefact cannot distinguish
   a repo-tuned run from a defaulted one.

**The workflow cannot verify this itself.** Dynamic-workflow scripts have no
filesystem access, so the script cannot check whether
`.claude/harness-triggers.json` exists. Whatever the agent reports is all it
has. The fix must therefore make a transcription failure *detectable*, not
merely hope it does not happen.

### Measured blast radius

Against CouchPotatoServer, over its 731 tracked paths, if `custom_rules` fails
to arrive for one run:

- **21 data paths stop triggering `lens-data`**, including
  `couchpotato/core/plugins/renamer/mover.py`, the file that repo's `AGENTS.md`
  names as its highest-risk surface, and the lens that owns its number-one
  precedence item (irrecoverable loss of the user's media files).
- **4 operability paths stop triggering `lens-operability`**, including
  `couchpotato/core/_base/scheduler.py` and `couchpotato/core/plugins/manage.py`
   -- verbatim the regression that repo already recorded as having cost a cycle
  to find.

It fails green: the run completes, prints a normal lens roster, and nothing
indicates the tuning was dropped.

Found by two independent lenses (security, qa) reviewing CouchPotatoServer
PR #260, 2026-08-17, each measuring it separately.

## Approach

Fail closed, and make the failure legible. The agent must answer two questions
whose answers can contradict each other, so a transcription failure stops being
invisible.

## Acceptance criteria

### lens-security

**AC-SEC-1**: The scope schema's `required` list includes both `custom_rules`
and a new boolean `harness_triggers_file_exists`. A response omitting either is
rejected by the runtime's structured-output enforcement rather than silently
defaulted.

**AC-SEC-2**: When `harness_triggers_file_exists` is `true` and `custom_rules`
is `null`, the run **aborts with a named error** rather than proceeding on
defaults. This is the contradiction that catches a transcription failure: the
file is there and its contents did not arrive. Aborting a review is the correct
outcome, because the alternative is a review conducted with the wrong lenses
and no sign of it.

**AC-SEC-3**: `custom_rules` is shape-validated before use: only the four known
keys (`ui`, `data`, `architecture`, `operability`) are accepted, each must be an
array of strings, and any other key or value type aborts with a named error.
An unvalidated object reaches `matches()` today, where a non-array value would
throw an unrelated error deep in glob compilation, or a stray key would be
silently ignored.

**Amended during review of this change**, after the first cut of the validation
accepted two inputs it should not have. An **empty array** is the silent
lens-loss case in a different costume: measured, `{"data": []}` REPLACES the
default data globs rather than extending them, so a changed `.sql` migration
triggered `['lens-security','lens-qa']` where the defaults give
`['lens-security','lens-qa','lens-data']` -- the lens was gone and the log
still reported `repo-tuned`. It is rejected rather than logged because an empty
array is indistinguishable from a transcription failure, and there is no
supported way to disable a lens deliberately (omitting the key inherits the
defaults, so an empty array is not the spelling of anything). An **empty-string
glob** is rejected for the same reason in miniature: it matches nothing, so the
override silently covers less than it appears to.

**AC-SEC-4**: No content from `custom_rules` is interpolated into any later
agent prompt. The overrides are matched by regex in the sandbox; a repo's
override file is attacker-influenceable on a public repo, so its strings must
never reach a model through this workflow.

### lens-qa

**AC-QA-1**: A test drives the workflow with `harness_triggers_file_exists:
true, custom_rules: null` and asserts the run aborts naming the dropped
override. Deleting the guard must fail this test.

**AC-QA-2**: A test asserts the *non*-failure cases still work, so the guard is
not over-triggering: file absent + `custom_rules: null` proceeds on defaults;
file present + valid `custom_rules` proceeds on the merged rules.

**AC-QA-3**: Shape validation is tested per rejection class, each asserting the
specific error names the offending key: an unknown key, a non-array value, and
an array containing a non-string.

**AC-QA-4**: A test asserts the emitted log line states which rule source was
used, distinguishing repo-tuned from defaulted, and that it reports the number
of overridden keys. Asserting only that a log line exists would pass with the
source omitted.

**AC-QA-5**: Every guard added here is proven load-bearing: the mutation
applied, the test observed failing, `git diff` confirming the edit landed on
the intended line, and the restored suite green. A guard nobody has watched
fail is not done.

### lens-operability

**AC-OPS-1**: The run's log names the rule source (`repo-tuned` with the count
of overridden keys, or `harness defaults`), so an operator reading the run
output can tell which applied without inspecting the repo.

**AC-OPS-2**: The rule source is recorded in the run ledger, so
`/optimise-cycle` can report how often overrides are in force and detect a repo
whose tuning silently stopped arriving across runs. A single dropped run is a
bug; a pattern is a broken repo, and only the ledger can tell them apart.

**AC-OPS-3**: The abort message states what the operator should do next
(re-run; if it recurs, the override file is not being read), not merely that
something went wrong.

## Out of scope, recorded

- **`plan-cycle.js` never reads `harness-triggers.json` at all** -- it asks an
  agent for booleans instead (`plan-cycle.js:155-161`). So planning-side lens
  triggering is not repo-tunable, and a repo that tunes review triggers gets no
  matching planning behaviour. That asymmetry is undocumented and is a genuine
  design gap, but it is a larger change than this one and is recorded for
  HARN-OPT-3 rather than fixed here.
- Making the harness assert a minimum version against a repo's override file.
  No mechanism exists for it today.
