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

**AC-SEC-4** *(reworded after review round 2 -- the original pinned the
mechanism, not the property)*: No content from `custom_rules` reaches a model
in any form -- not through a later agent prompt, and not through an error
message or log line, both of which are rendered into the invoking session's
context. A repo's override file is attacker-influenceable on a public repo.
Where an offending key or glob must be named for the operator, it is
neutralised first: whitespace collapsed, truncated to ~60 characters, and
JSON-quoted so a crafted value cannot break out of the surrounding sentence or
fake a second log line. The original wording constrained "any later agent
prompt" and passed while the property it existed to protect did not: the
change added an interpolation into exactly the paths it did not cover.

**AC-SEC-5** *(added after review round 2; nothing previously covered glob
*contents*)*: Glob strings are bounded before any regex is compiled from them.
`globToRe` expands every `**` to `.*`, producing an unanchored alternation with
no backtracking bound, and both halves of the input are attacker-controlled on
a public repo. Measured against the real compiler with a 61-character filename:
12 chars 4.7ms, 15 chars 58ms, 18 chars 586ms, 21 chars 5060ms -- about 9x per
added `**a`, and a 30-character glob does not return. The workflow wedges
inside the sandbox with no error, no verdict and no terminal ledger line,
leaving the run's `started` record a permanent orphan, which is strictly worse
than the abort this design deliberately chose. Bound the input (glob length,
`**` count per glob, glob count per key) rather than rewriting glob
compilation, and prove the bound by timing: the measured pathological glob must
be rejected in microseconds rather than compiled.

**AC-SEC-6** *(added after review round 2)*: `?` is handled as a glob
metacharacter, not passed through to the regex engine. Unescaped it either
threw `Nothing to repeat` -- an error naming neither the file nor the key, so
AC-OPS-3's actionability was lost on that path -- or survived as a regex
quantifier, inverting the author's intent: `src/v?/**` matched `src/v/x` but
NOT `src/v1/x`. It maps to `[^/]`, exactly one non-separator character. Any
remaining `RegExp` construction failure is re-thrown naming the offending glob.

**AC-SEC-7** *(added after review round 2)*: The contradiction check is
symmetric. `harness_triggers_file_exists: false` with `custom_rules` delivered
is as much a contradiction as the reverse, and was previously accepted, applied
and logged as `repo-tuned` for a repo with no tuning. It aborts under its own
error name, distinct from the transcription failure, so the two causes stay
distinguishable in the artefact.

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

**AC-QA-6** *(added after review round 2)*: The AC-SEC-4 regression test plants
its marker in a `custom_rules` **key** as well as a glob value. As originally
written it planted the marker only in a value, so it structurally could not
fail on a key -- the repo's own recurring fixture-agrees-with-the-code failure,
inside the test written to prevent exactly this.

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
