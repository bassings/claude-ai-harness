# `recurrence` field drift-guard mutation proofs

Context: commit `d447030` added a `Recurrence` field to `AGENT-HARNESS.md`'s
FINDINGS template and instructed all nine `agents/lens-*.md` files to fill it,
with no matching property in either lens-output schema the workflow scripts
declare (`REVIEW_SCHEMA` in `workflows/review-cycle.js`, `PLAN_SCHEMA` in
`workflows/plan-cycle.js`), no mention in the review lens prompt, no carry
into the `openFindingsRaw` ledger projection, and no mention in the synthesis
keep-list. A multi-lens review round on `fix/destructive-git-guard` flagged
this as finding H3: an instruction with no consumer.

Fix chosen: **wire it through** (not revert), since the schema change is
contained to two files plus one prompt and one projection, all named exactly
by the review report:

- `workflows/review-cycle.js:588` (now `~593`) — added `recurrence: { type:
  ['string', 'null'] }` to `REVIEW_SCHEMA`'s findings-item properties.
- `workflows/plan-cycle.js:253` (now `~257`) — same, on `PLAN_SCHEMA`.
- `workflows/review-cycle.js` lens prompt (`~622`) — named `recurrence` in
  the mapping description the lens agent reads.
- `workflows/review-cycle.js`'s `openFindingsRaw` projection (`~638`) —
  carries `f.recurrence || null` through into the ledger-write payload.
- `workflows/review-cycle.js`'s synthesis prompt keep-list (`~670`) —
  instructs the synthesis agent to keep `recurrence` in the rendered report.

Per standard §11 and AC-QA-3: the guard was actually broken (edited in the
working file, not "mentally mutated"), the mutation's application was
confirmed with `git diff` before running tests, the exact failing assertion
was recorded, and the file was then restored from a `cp` snapshot (never
`git checkout --`, which this repo's own guard hook now refuses) and the
suite re-run green before the next mutation. Mutation, diff-confirm, test,
restore, reconfirm clean — one at a time, never stacked.

The guard under test is the new static check in
`test/static-checks.test.js`: **"H3 drift guard -- every colon-labeled field
in AGENT-HARNESS.md's ### FINDINGS template, and every field agents/lens-*.md
instruct filling there, has a like-named property in both review-cycle.js's
REVIEW_SCHEMA and plan-cycle.js's PLAN_SCHEMA findings items -- and vice
versa: every non-structural findings-item property is named in the
template."**

It has two directions, both proven below, plus an end-to-end runtime check
using the repo's own `test/helpers/fake-runtime.js` harness (not part of the
committed suite, a one-off verification script) that drove
`workflows/review-cycle.js` with a scripted lens response carrying a real
`recurrence` value, to confirm the field actually reaches the ledger payload
and the synthesis prompt rather than merely satisfying the static guard.

## 1. Direction 1 (H3's own shape): a field instructed but not declared

**Mutation**: in `workflows/review-cycle.js`'s `REVIEW_SCHEMA`, removed
`recurrence: { type: ['string', 'null'] }` from the findings-item
`properties` object, leaving `AGENT-HARNESS.md` and all nine
`agents/lens-*.md` files instructing it. Confirmed by `git diff` that the
edit landed on the schema's `findings:` line (`~593`), not a comment or an
unrelated occurrence of the word.

**Result**: 1 test failed, for the right reason —

```
✖ static: H3 drift guard -- every colon-labeled field in AGENT-HARNESS.md's
  ### FINDINGS template, and every field agents/lens-*.md instruct filling
  there, has a like-named property in both review-cycle.js's REVIEW_SCHEMA
  and plan-cycle.js's PLAN_SCHEMA findings items...
  AssertionError [ERR_ASSERTION]: "recurrence" is named in AGENT-HARNESS.md's
  FINDINGS template or instructed in agents/lens-*.md, but
  review-cycle.js's REVIEW_SCHEMA does not declare a matching findings-item
  property -- an instructed field with no schema slot is silently dropped
  (H3)
```

37/38 in `test/static-checks.test.js`; every other test unaffected.

**Reverted**: restored `workflows/review-cycle.js` from a `cp` snapshot taken
before the edit, confirmed byte-identical with `diff` (no output), suite
back to 38/38 in `test/static-checks.test.js`.

## 2. Direction 1, repeated on `plan-cycle.js`

**Mutation**: same removal, this time on `workflows/plan-cycle.js`'s
`PLAN_SCHEMA` findings-item properties (`~257`), leaving `REVIEW_SCHEMA`
untouched. Confirmed by `git diff` the edit landed on the intended line.

**Result**: the same test failed, this time on the `PLAN_SCHEMA` assertion --
confirming the guard checks both schemas independently rather than only ever
exercising `REVIEW_SCHEMA`'s branch.

**Reverted**: restored from a `cp` snapshot, confirmed byte-identical, suite
back to 38/38.

## 3. Direction 2 (the "vice versa"): a schema field nothing documents

**Mutation**: in `workflows/review-cycle.js`'s `REVIEW_SCHEMA`, added a new,
undocumented findings-item property, `undocumented_field: { type: 'string'
}`, appended after `recurrence` on the same line. Confirmed by `git diff`
the addition landed inside the `findings:` property list, not elsewhere.

**Result**: 1 test failed, for the right reason —

```
AssertionError [ERR_ASSERTION]: REVIEW_SCHEMA's findings items declare
"undocumented_field", but AGENT-HARNESS.md's FINDINGS template does not name
it -- a schema field nothing instructs a lens to fill
```

**Reverted**: restored from a `cp` snapshot, confirmed byte-identical, suite
back to 38/38.

## 4. Runtime verification (not a committed test): does the field actually flow?

A static guard proves the schema and the doc agree; it does not prove the
value survives the actual data path from a lens response to the ledger
payload and the human-readable report. Using
`test/helpers/fake-runtime.js`'s `runWorkflow`, `workflows/review-cycle.js`
was driven with a scripted `lens-security` response whose one finding
carried `recurrence: 'EXPECT 3 MORE INSTANCES'`.

**Against the pre-fix code** (`git show 6fac36a:workflows/review-cycle.js`,
the commit this fix branches from):

- `open_findings` in the captured terminal ledger payload: the finding
  object had no `recurrence` key at all (silently dropped by the
  `openFindingsRaw` projection's explicit field list).
- The `lens-security` prompt did not mention `recurrence` (the lens was
  never told the schema had a slot for it, because it didn't).
- The synthesis prompt's raw `JSON.stringify(lensReports, ...)` dump *did*
  still contain the scripted `recurrence` value -- confirming the finding
  was never rejected or stripped by the harness's own structured-output
  validation layer (no schema here sets `additionalProperties: false`); it
  was dropped by review-cycle.js's own field-by-field projections and never
  named in the "keep this" instruction, exactly as the review report
  diagnosed.

**Against the fixed code** (current working tree):

- `open_findings` carries `"recurrence": "EXPECT 3 MORE INSTANCES"` on the
  finding object.
- The `lens-security` prompt now names `recurrence` in the schema-field
  mapping.
- The synthesis prompt both contains the literal word `recurrence` (the
  keep-list instruction) and the scripted value (via the raw JSON dump, as
  before).

This closes the loop the static guard alone cannot: the field is not only
declared in the schema but actually reaches the ledger-write payload and the
synthesis agent's rendering instructions.

## Known residual gap (not fixed by this change, flagged rather than hidden)

`workflows/lib/ledger-append.mjs`'s `computeFindings()` -- which turns the
`open_findings` descriptors above into the entries actually persisted to the
ledger line -- keeps only `{id, lens, severity, ac_id, disposition}` per
finding; `location`, `claim`, `evidence`, `fix` and now `recurrence` are used
only to compute the hashed `id`, never stored. This is pre-existing
behaviour, not a regression from this change (`location` and `claim` were
already dropped at that same stage before `recurrence` existed), but it does
mean `/optimise-cycle` cannot yet read a persisted `recurrence` signal off
the ledger -- only a human reading the synthesised review report can. If
that cross-run signal is wanted later, it is separate work in
`ledger-append.mjs`, out of scope for this fix.
