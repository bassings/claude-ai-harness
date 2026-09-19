# The ledger's validators discard valid data, and the analysis then reports zero

Status: draft, 2026-09-14. Source: the weekly optimiser reports for all three
instrumented repos, 2026-09-14. Five of the fifteen ranked proposals across
those reports are instances of this one defect.

## The problem

The run ledger sanitises values it cannot parse, then the optimiser aggregates
what survived. Where sanitisation is wrong, the aggregate reports **zero**, and
zero is indistinguishable from "this genuinely did not happen". Every finding
below was verified by executing against this repo, not read from a report.

**D1 -- the accessibility lens's entire record has never been kept.**
`workflows/lib/ledger-append.mjs:104` sets
`AC_ID_PATTERN_STR = '^AC-[A-Z]+-[0-9]+$'`. `agents/lens-accessibility.md`
instructs that lens to emit `AC-A11Y-<n>`. The digits inside `A11Y` fail
`[A-Z]+`, so every accessibility criterion and every accessibility verdict ever
written has been nulled into `ac_id_raw`. Measured: `AC-A11Y-1` REJECT,
`AC-QA-1` ACCEPT. This is the harness's own contract disagreeing with the
harness's own validator, and the eight other lenses pass only because their
prefixes happen to contain no digit.

**D2 -- a review spanning several specs loses every verdict.** When a branch
covers more than one spec, lenses disambiguate by prefixing
(`FEAT-011 AC-QA-1`, `FEAT-010/AC-QA-3`). Both forms fail the pattern.
Measured in a real delivery repo's ledger: 203 verdicts nulled in a single
review run, leaving `ac_verdicts=[]` and `neverFailingAcs=[]` for the whole
90-day window despite seven review records. There is no structured field for
which spec a criterion belongs to, so the prefix is the only place that
information can go, and it is the reason the value is rejected.

**D3 -- per-lens tallies are computed after truncation.**
`workflows/lib/optimise-read.mjs:362` builds `lensDispositionCounts` by
iterating the ledger's `findings` array. That array is capped at
`MAX_FINDINGS = 15` (`ledger-append.mjs:78`). `findings_truncated` records how
many were dropped, but nothing compensates the per-lens counts, so any round
finding more than fifteen things silently undercounts the rework attribution
that is the optimiser's headline output. The round-robin fix already in
`budgetFindings` changed WHICH entries survive, not how many.

**D4 -- "there is no spec" is recorded as "the spec has a bug".**
`workflows/review-cycle.js:1330` asks synthesis for "spec_bugs (findings with
no AC behind them)". On a review run with no spec at all, every finding has no
AC behind it, so all of them are classified `spec_bug`. Measured in a delivery
repo: 28 of 45 findings (62%) classified `spec_bug`, on runs where `spec` is
null. A missing spec is a process signal; a spec bug is a quality signal about
a spec that exists. Conflating them makes the second unusable.

## Why this is one change, not five

All four are the same shape: **a check that cannot represent a legitimate
value, discards it, and reports the absence as a measurement.** That is the
failure this harness exists to catch, running inside the harness's own
instrumentation, and it is why three weeks of optimiser reports have been
reporting confident zeroes.

## Out of scope, recorded deliberately

- Re-deriving lost history. Past ledger lines keep their nulled ids in
  `ac_id_raw`; whether the reader should fall back to it for old lines is a
  separate decision with its own risk (a hostile `ac_id_raw` ending in a real
  AC id could redirect attribution -- `optimise-read.mjs` already reasons about
  exactly this).
- The duplicate adversarial reviewer at `workflows/review-cycle.js:1088`
  (`lenses.push('reviewer-verification')` with no Set), which dispatches two
  identical agents when a caller both names it and passes `adversarial: true`.
  Verified, real, and unrelated to validation. Track separately.
- Emitting `ci_wait`/`human_wait` events at all, which the CouchPotato report
  raises and which is a conduct-plan change, not a validator one.

## Affected files

- `workflows/lib/ledger-append.mjs` (the pattern, the schema, the sanitiser)
- `workflows/lib/optimise-read.mjs` (the tally source)
- `workflows/review-cycle.js` (the spec_bug prompt and the no-spec case)
- `agents/lens-*.md` only if the contract, not the validator, turns out to be
  the thing that should change

## Acceptance criteria

Written by `/plan-cycle` 2026-09-14 at `d05d10b`. Six lenses ran:
`lens-security`, `lens-qa`, `lens-simplicity` (always on), plus
`lens-product`, `lens-data` and `lens-operability` (triggered: a spec exists,
the change alters a stored schema and a sanitiser, and it reaches production
behaviour). `lens-design`, `lens-accessibility` and `lens-architecture` were
skipped: no UI surface, no new module, no new dependency.

### Decisions settled at planning

Five of the six lenses raised the same finding: the problem statement names
four defects and decides none of the fixes, so review could not fail the wrong
implementation. These are the decisions the criteria below are written against.

1. **D1 is fixed in the validator, not in the contract.** `AC_ID_PATTERN_STR`
   widens to accept a prefix segment whose first character is a letter and
   whose remainder may contain digits (so `AC-A11Y-<n>` validates). No file
   under `agents/` changes. Renaming the lens's prefix instead would invalidate
   every `AC-A11Y-<n>` id already written into adopters' specs, which is this
   spec's own defect class recurring inside its own fix.
2. **D2 keeps the spec prefix inside `ac_id`, tightly bounded, and adds no
   structured per-criterion spec field.** Stripping the prefix would merge two
   different specs' `AC-QA-1` into one aggregation bucket and could report a
   criterion that failed as `never_failed`, which is an inverted conclusion
   rather than a lost measurement. The accepted prefix is bounded inside the
   regex itself (the reference shape is
   `^[A-Za-z0-9_.-]{1,40}[ /]?AC-[A-Z][A-Z0-9]*-[0-9]+$` with the bare
   `AC-...` form also accepted); no accepted value may contain a newline,
   carriage return, backtick, `<`, `>`, `|`, `$`, more than one separator
   character, or a leading path separator or drive prefix.
3. ~~**D3 is fixed by raising `MAX_FINDINGS` (to 60, above the worst round
   recorded in any local ledger, which is 50), not by adding a ledger field.**~~
   **REVERSED AT IMPLEMENTATION, 2026-09-14, on measurement. Recorded here
   rather than rewritten, because a spec that quietly matches whatever was
   built verifies nothing.**

   Both figures behind this decision were taken from THIS repo's ledger alone
   (lens-simplicity's own coverage statement says so). Across all three real
   ledgers the worst round is 84 findings, not 50, and the largest line ever
   written is 15,920 bytes against a 16,384 cap, not 5,103. Sixty findings plus
   200 verdicts needs about 22,980 bytes, which pushes the busiest records into
   the envelope-only degrade path that discards verdicts and trigger_counts as
   well -- turning a 51% undercount into total loss for exactly the runs that
   matter most. AC-DATA-13 made the raise conditional on that byte proof, and
   the proof fails.

   **What was built instead:** the tally is computed by the WRITER, before any
   truncation, and stored as `findings_by_lens` (~500 bytes, correct at any
   volume). This is not the "new payload property" this decision rejected: the
   caller supplies nothing, a caller-supplied tally is refused explicitly, and
   schema and writer ship in the same file so no version can have one without
   the other. `MAX_FINDINGS` stays at 15.

   Review round one then found the other half was missing: the reader was never
   taught to use the field, so the number an operator reads was still the
   truncated one. Fixed, with the per-finding loop kept as the fallback for
   lines written before the field existed.
4. **D4's trigger is computed in script code, from observable state, not from
   the invocation argument and not from the model's classification.** "No spec
   was in play" means `specPath` is null AND no lens returned any `ac_verdicts`,
   because `review-cycle.js:1103-1106` tells a lens with no spec passed to go
   and find one. Fix round 3 (L6): stated explicitly, because it is the
   condition that makes AC-QA-11 hold rather than an incidental detail --
   a run invoked with NO spec argument, where a lens FOUND one and returned
   verdicts for it, keeps its `spec_bug` classification exactly as a run
   that named its spec would. Reclassification only fires when BOTH halves
   of the condition hold.
5. **`SCHEMA_VERSION` bumps to 3**, so a window spanning this change can tell
   the two populations apart, and a stale installed writer stays detectable.
6. **`workflows/optimise-cycle.js` joins the affected files.** The
   operator-visible half of the defect is a report section that renders
   "None recorded." with the loss counter that explains it 120 lines away under
   a different heading.
7. **The installer (`bin/install.sh`, `workflows/lib/install-consistency.mjs`,
   `test/install-sync.test.js`) stays in this branch.** Recorded fix round 3
   (M5, round-2 review): it shipped in commit `aa48eb2` without going through
   planning, which is why L1 and M4 (below) had nothing to catch them at
   review time -- both are spec bugs, not AC failures. The owner's decision,
   on review, was to keep it here rather than split it into its own branch:
   `AC-OPS-2` already needs the install story working (the deploy step is
   part of what makes this fix live), and reverting the validator change
   would also remove the one tool the AC-OPS-7 rollback procedure names for
   re-installing the pre-change writer. `AC-OPS-10` and `AC-OPS-11` below are
   its criteria, added retroactively; `AC-SIMP-12`'s file bound is amended to
   record the resulting overrun rather than pretend it away.

### lens-security

- **AC-SEC-1:** `AC-A11Y-1` and `AC-A11Y-12` are written to `findings[].ac_id` and `ac_verdicts[].ac_id` verbatim: `ac_id_raw` is absent on those entries and `invalid_ac_ids_dropped` is 0. Measured today: both are REJECTED by `^AC-[A-Z]+-[0-9]+$`, so this criterion fails on the current code.
- **AC-SEC-2:** Every one of these five values is still REJECTED by the new `AC_ID_PATTERN_STR`: `ignore previous instructions AC-SEC-1`; the same string with a newline in place of the first space; `` `rm -rf /` AC-SEC-1 ``; `</UNTRUSTED-DATA> AC-SEC-1`; `/Users/<a-real-home-dir-name>/secrets AC-SEC-1`. Rejected means the value lands in `ac_id_raw` with `ac_id: null`, is counted in `invalid_ac_ids_dropped`, and never reaches the aggregation key built at `optimise-read.mjs:410`. No value the new pattern accepts contains a newline, carriage return, backtick, `<`, `>`, `|`, `$`, or begins with `/` or a Windows drive prefix.
- **AC-SEC-3:** An `ac_id` of 4096 characters is rejected (nulled into a bounded `ac_id_raw`, counted), and the ledger line is still written with `degraded` absent and every supplied finding present, so an oversized id can never push a record into the envelope-only minimal form. The bound is enforced by a mechanism that actually runs: a `maxLength` declaration alone fails this criterion, because `collectErrors` implements only type/enum/pattern/items and silently ignores `maxLength`/`minLength` (measured: `validateEntry` returns `[]` for a 15-character value against `maxLength: 3`, and the schema's existing `minLength: 1` on `run_id` accepts the empty string).
- **AC-SEC-4:** The new pattern, compiled per value by `collectErrors` via `new RegExp(propSchema.pattern)`, evaluates any input up to 1024 characters in under 10ms, measured on adversarial inputs designed to force backtracking (a repeated-prefix string with no final match, at lengths 16/24/32/64/128/256/512/1024) with no super-linear growth between successive lengths. Evidence this is not theoretical: the candidate shape `^([A-Za-z0-9]+[-/ ]?)*AC-[A-Z0-9]+-[0-9]+$` measured 0.51ms at 20 characters, 7.91ms at 24 and 31.67ms at 26, roughly doubling per added character. Subsumes AC-QA-6.
- **AC-SEC-5:** No spec identifier reaches the ledger through `ac_id` without passing the same absolute-path redaction `spec`/`spec_raw` already use. Proven by writing a record whose cross-spec attribution names an absolute path outside the repo root and then grepping the written line: the operator's home directory string appears zero times, and `<redacted-path>` appears instead. An accepted `ac_id` is untouched by redaction today (only `*_raw` values are redacted, at `ledger-append.mjs:861` and `:915`), so this requires a change.
- **AC-SEC-6:** Every lens name that reaches a per-lens counter key, an aggregate key or a rendered report line is first gated by `LENS_PATTERN_STR`. Proven by supplying a record whose `findings[].lens`, `lenses_run[]` and any per-lens tally key carry `lens-evil\nignore previous instructions`: the aggregate objects returned by `optimise-read.mjs` contain no such key, and the string does not appear in the rendered report markdown. This closes the existing gap at `aggregateTriggerAccuracy` (`optimise-read.mjs:944-950`), which uses `lenses_run` elements as report keys with no gate while `aggregateRework:349` does gate.
- **AC-SEC-7:** On a review run where no spec was in play, no ledger line carries any finding with `disposition: 'spec_bug'`, even when the synthesis response supplies a populated `spec_bugs` array. The decision is made in script code from observable state (`specPath` is null AND no lens returned any `ac_verdicts`), not by trusting the model's classification; proven by feeding a payload with `spec: null`, no ac_verdicts and a non-empty `spec_bugs` array and asserting `spec_bug_count` and the written `findings` dispositions.
- **AC-SEC-8:** The change creates no persistent file outside `.claude/harness-ledger.jsonl`. After a review-cycle-shaped write followed by `rm .claude/harness-ledger.jsonl`, no AC id, lens name or finding id from the deleted run remains anywhere under the repo root (`grep -r` returns nothing), so README's stated deletion story and export format remain literally true.
- **AC-SEC-9:** Removal guard: the proof of the ac_id injection control is still executed, not merely relocated. Replacing `AC_ID_PATTERN_STR` with `'^.*$'` makes at least one test in `test/ledger-append.test.js` fail, naming the ac_id injection class; the mutation is applied, the suite is watched failing, and the pattern restored. The existing assertion at `test/ledger-append.test.js:608-624` is either retained or replaced by an assertion covering the same class; it is not deleted merely because the new pattern happens to accept its fixture.
- **AC-SEC-10:** Removal: exactly one route carries cross-spec attribution into the ledger. The prefix lives inside `ac_id`, and no new property is added to the `ac_verdicts[]` or `findings[]` item schemas (in particular no `spec`, `spec_id`, `spec_key` or plan-key field inside a verdict or a finding), so the ledger never carries the same attribution in two shapes that aggregate as two different criteria. Subsumes AC-SIMP-5.
- **AC-SEC-11:** Nothing else in my area is removed, stated as a claim: the ac_id quarantine survives this change. After the change, `ac_id_raw` is still written for the AC-SEC-2 corpus, and `ac_id_raw` is still read by nothing (grep of `optimise-read.mjs` and `optimise-cycle.js` returns only comments, as it does today). No other security or privacy control is superseded; retention, deletion and export of the ledger are unchanged.

### lens-qa

- **AC-QA-1:** A review line carrying `ac_verdicts` `[{ac_id:'AC-A11Y-1',verdict:'PASS'},{ac_id:'AC-A11Y-12',verdict:'FAIL'}]` and a finding with `ac_id: 'AC-A11Y-3'` is written with every ac_id retained verbatim, no `ac_id_raw` sibling created, and `invalid_ac_ids_dropped` equal to 0. Measured today: all three are rejected and nulled, `invalid_ac_ids_dropped=1` per verdict.
- **AC-QA-2:** The set of AC prefixes the writer accepts is proven against the prefixes the shipped lens agents actually emit: a test derives the prefix list by scanning `agents/lens-*.md` and `specs/*.md` for `AC-<PREFIX>-<n>` and asserts every one is accepted by the writer's pattern. Adding a future lens whose prefix contains a digit, or narrowing the pattern again, fails this test rather than silently nulling that lens's record. Subsumes AC-DATA-2.
- **AC-QA-3:** A multi-spec review line whose verdicts cite `FEAT-011 AC-QA-1` and `FEAT-010/AC-QA-3` is written with those verdicts attributable (not nulled into `ac_id_raw`), and `aggregateRework` over that line returns a non-empty acVerdicts map. Measured today: both forms reject, and a real delivery repo shows 203 verdicts nulled in one run leaving `ac_verdicts=[]` and `neverFailingAcs=[]` for a whole 90-day window.
- **AC-QA-4:** Identity rule, same-spec half: two citation forms of the same criterion in the same plan (`AC-QA-1` and `FEAT-011 AC-QA-1`, where FEAT-011 is that record's own spec) resolve to exactly one bucket in `aggregateRework`, and a FAIL recorded under either form prevents `never_failed: true` for that criterion. A test that records PASS under one form and FAIL under the other must fail if the two forms split into separate buckets. Read with AC-DATA-4, which is the different-spec half of the same rule.
- **AC-QA-5:** The sanitiser can still fire after the widening: each of `none`, `` (empty), `AC--1`, `ac-qa-1`, a 4096-character string, a value containing an absolute path such as `/etc/shadow`, and a value containing a newline is still nulled into a bounded `ac_id_raw` (at most `AC_ID_RAW_MAX_BYTES` = 32 bytes, path-redacted), counted in `invalid_ac_ids_dropped`, and the line is still written with `write_ok` true. Deleting the pattern from the schema must make this test fail.
- **AC-QA-7:** A worst-case realistic review line (8 lenses in `lenses_run` and `verdicts`, `MAX_FINDINGS` findings, `ac_verdicts` filled to `MAX_AC_VERDICTS` with prefixed ids of the widest accepted form) is written in full: `degraded` is absent, `findings` has `MAX_FINDINGS` entries and `ac_verdicts` has `MAX_AC_VERDICTS` entries in the stored line. Measured for the current shape: 15,600 bytes nulled and 12,200 bytes with ids retained, against `MAX_LINE_BYTES` = 16,384; measured separately, 200 verdicts carrying 25-character prefixed ids alone serialise to 11,835 bytes. This guards the collapse path at `ledger-append.mjs:1955-1985`, which drops every finding and then the whole payload to an envelope-only record. Subsumes AC-OPS-6.
- **AC-QA-8:** A review round with 25 findings across 3 lenses produces per-lens disposition totals in the optimiser that equal the true pre-truncation counts, or the rendered rework section names the number of findings not represented. A test that asserts the reported total equals 25 (or that the caveat text is present and names the shortfall) must fail against today's behaviour. Measured today: 20 open findings from one lens are reported as `open=15` with no caveat, and `findings_truncated` appears 0 times in `optimise-read.mjs` and `optimise-cycle.js`. Subsumes AC-PROD-4.
- **AC-QA-9:** Truncation is never reported as a measurement in the other place it can happen: for any record in the window with `ac_verdicts_truncated` greater than 0, no `never_failed: true` is emitted for that record's (repo, plan) buckets, and the rendered never-failing section names truncation as the reason, distinctly from `insufficient_data`. Measured today: `ac_verdicts_truncated` appears 0 times in `optimise-read.mjs` and `optimise-cycle.js`, and D2's own case is 203 verdicts against `MAX_AC_VERDICTS` = 200, so 3 are dropped on exactly the runs the fix makes readable.
- **AC-QA-10:** On a review run where no spec was in play, the ledger payload contains no finding with disposition `spec_bug`, and `spec_bug_count` on that line is distinguishable from a measured zero on a run that had a spec and found no spec bugs (the two lines differ in that field). Driven through the workflow with the fake runtime and read with `test/helpers/extract-ledger-payload.js`, not by asserting the synthesis prompt text.
- **AC-QA-11:** The no-spec reclassification keys off whether a spec was actually in play, not off the workflow's spec argument alone: a run invoked with no spec argument, whose lenses return non-empty `ac_verdicts` (they found a spec themselves, which `review-cycle.js:1103-1106` explicitly tells them to do), classifies findings exactly as a run that named its spec would, and its findings can still be recorded `spec_bug`. A test must fail if the classification is driven by `spec === null` alone.
- **AC-QA-12:** A window mixing pre-change lines (`ac_id` null with the real id retained in `ac_id_raw`, from the A11Y and cross-spec cases) with post-change lines aggregates without throwing, produces no bucket keyed on the literal `null`, and does not read `ac_id_raw` back into attribution (re-deriving lost history stays out of scope). The pre-change verdicts still count toward `unattributableCount` and still taint `never_failed` exactly as they do today.
- **AC-QA-13:** The second copy of the same blind pattern is closed in lockstep: the spec duplicate-id guard at `test/static-checks.test.js:1208` and `:1220` recognises `AC-A11Y-<n>` as a definition, proven by a fixture spec defining `AC-A11Y-3` twice being reported as a duplicate. Today that regex is `AC-[A-Z]+-\d+`, so an entire lens's criteria are invisible to the guard and a duplicated accessibility id can never be detected.
- **AC-QA-14:** Every guard added or changed by this work was broken deliberately, watched to fail, and restored, recorded in `docs/harn-ledger-validators-mutation-proofs.md` in the same form as the existing `docs/*-mutation-proofs.md` files: for each mutation, the construct mutated, the exact failing assertion text, and confirmation the file was restored byte-identical and green. A guard with no recorded failure in that document does not count as proven.
- **AC-QA-15:** The full suite (`node --test test/*.test.js`) is green at the end of the change, including the static AC-definition check that is red at baseline because this spec carried AC ids with no definitions. Baseline at `d05d10b`: 1197 tests, 1196 pass, 1 fail, 44.8s wall on this machine. Total runtime after the change stays within 60s on the same machine, which is a regression guard with a measured baseline, not a target.
- **AC-QA-16:** Removal: the fixture `optimise-cycle:AC-SEC-1` is gone from `test/ledger-append.test.js:614` as an example of a non-conforming ac_id, because the widening makes it valid. The test at that location asserts on a value that is still rejected after the widening, and fails when the pattern is deleted from the schema. Equivalently, `grep -rn "optimise-cycle:AC-SEC-1" test/` returns nothing, and no test anywhere asserts that a well-formed A11Y or cross-spec id is nulled.
- **AC-QA-17:** Removal, stated as a negative claim rather than left unconsidered: nothing else in the test estate is retired by this change. The `ac_id_raw` retention path, `invalid_ac_ids_dropped`, the `degradeEntry` general mechanism and the byte-rescue loop all stay live and stay proven by tests that still fire (AC-QA-5 and AC-QA-7 are those tests). A review that finds a test deleted beyond the fixture named in AC-QA-16 fails this criterion.

### lens-simplicity

- **AC-SIMP-1:** No new dependency: the diff adds no `package.json` or lockfile, and adds no import/require whose specifier is neither `node:`-prefixed nor a repo-relative path.
- **AC-SIMP-2:** No new configuration knob: the diff adds no new `process.env.<NAME>` read and no new key to the harness trigger defaults or to any `.claude/harness-triggers.json`.
- **AC-SIMP-3:** No new module: the diff creates no new file under `workflows/` or `agents/`. Production changes are confined to `workflows/lib/ledger-append.mjs`, `workflows/lib/optimise-read.mjs`, `workflows/optimise-cycle.js` and `workflows/review-cycle.js` (test, spec, docs and README files excluded from this count).
- **AC-SIMP-4:** `LEDGER_ENTRY_SCHEMA.properties` gains at most one new top-level property across the whole change. (The original clause freezing `SCHEMA_VERSION` was overruled at planning; see the veto list.)
- **AC-SIMP-6:** D1 is fixed in the validator, not in the contract: the diff modifies no file under `agents/`, and no lens's AC prefix (including `AC-A11Y` in `agents/lens-accessibility.md`) changes.
- **AC-SIMP-7:** `AC_ID_PATTERN_STR` remains the single definition site of the ac_id shape: the diff adds no second AC-id regular expression literal to `workflows/lib/ledger-append.mjs`, `workflows/lib/optimise-read.mjs`, `workflows/optimise-cycle.js` or `workflows/review-cycle.js`. The separate copy in `test/static-checks.test.js` (AC-QA-13) is a test-side guard and is out of this count.
- ~~**AC-SIMP-8:** D3 is fixed by changing the existing bound, not by adding a mechanism: `optimise-read.mjs`'s `lensDispositionCounts` is still derived from each record's `findings` array, and the diff adds no writer-supplied per-lens counts field and no branch that selects between two sources for the same tally.~~
  **AMENDED AT FIX ROUND 3, on round 2's own review arbitration, kept struck through rather than deleted, per this spec's own standard for a decision recorded and then reversed (the same standard decision 3, above, already uses).** `AC-DATA-13`'s conditional raise of `MAX_FINDINGS` was refuted on measurement (decision 3), and the tally-field route this criterion vetoed is what was actually built instead, already in fix round 1: `findings_by_lens`, a writer-supplied per-lens counts field, with the reader selecting between it and the per-finding fallback for exactly the "does this line have the field yet" reason AC-DATA-1 makes normal for a new field on old data. The spec text was never corrected to match what shipped, which is the round-2 review's own H2 finding: "a branch that selects between two sources for the same tally" is precisely the shape that let the tally path skip the per-finding path's cross-round `fixed` dedupe. Overruled the same way decision 3's simplicity clause was: this sits on the irrecoverable-data-loss line (a truncated `findings` array silently undercounts the busiest rounds by up to 82%, measured), which the simplicity veto cannot override. `AC-QA-8`, `AC-DATA-7` and H2's fix (fix round 3: the tally path now routes `fixed` through the same dedupe-aware per-finding logic) are what actually govern this mechanism now.
- **AC-SIMP-9:** No new disposition value: the `DISPOSITIONS` array in `workflows/lib/ledger-append.mjs` is exactly `['open', 'rejected', 'spec_bug', 'fixed']` after the change.
- **AC-SIMP-10:** Removal, D4: the unconditional `spec_bugs` request is gone from the no-spec path. In `workflows/review-cycle.js` the synthesis prompt asks for `spec_bugs` only inside a branch conditional on a spec being in play, so a prompt built for a spec-less run contains the string `spec_bugs` nowhere.
- **AC-SIMP-11:** The spec's three deliberately-excluded items are absent from the diff: no dedupe (Set or otherwise) at `review-cycle.js`'s `lenses.push('reviewer-verification')`, no new `ci_wait`/`human_wait` event emission, and no `ac_id_raw` fallback or re-attribution logic in `optimise-read.mjs`.
- ~~**AC-SIMP-12:** The whole change touches no more than 10 files: `git diff --name-only <base>...<sha> | wc -l` is 10 or fewer.~~ (Raised from the lens's original 8 to cover `workflows/optimise-cycle.js`, `test/static-checks.test.js` and the mutation-proofs document that AC-PROD-7, AC-QA-13 and AC-QA-14 add.)
  **AMENDED, fix round 3 (M5), overrun recorded rather than pretended away.** Round-2 review measured 13 against this bound (11 with the installer removed), and it was never brought back under 10 -- the installer commit was scope drift the lens veto had no chance to see, because it landed without going through planning at all (decision 7). Fix round 3 adds `bin/install.sh` and `workflows/lib/install-consistency.mjs` return to the diff (they were already present from the installer commit), plus `docs/harn-ledger-validators-mutation-proofs.md` (AC-QA-14) and further test-file edits across the H1-through-M4 fixes: `git diff --name-only main...HEAD | wc -l` is 18 at the close of this fix round. The bound is not re-raised to match: doing so would make it a number that trails whatever was built rather than a constraint that ever said no. Recorded as an accepted overrun instead, on the same reasoning decision 7 gives for keeping the installer here at all -- splitting it out now would not bring this branch under 10 either, since the validator fix alone (ledger-append.mjs, optimise-read.mjs, optimise-cycle.js, review-cycle.js, README.md, specs/harn-ledger-validators.md, and their five-plus test files) already exceeds it.

### lens-product

- **AC-PROD-1:** A spec already written by an adopter against the `AC-A11Y-<n>` form keeps working across this upgrade: a review run whose lens reports cite `AC-A11Y-1` records `ac_id: "AC-A11Y-1"` in that ledger line's `ac_verdicts`, and the shipped instruction in `agents/lens-accessibility.md` is unchanged, so no adopter has to edit a spec to regain attribution.
- **AC-PROD-2:** For a review run in which every lens in the shipped roster records at least one finding and one AC verdict, the optimiser report's "Rework attribution" section prints a row for every one of those lenses, `lens-accessibility` included. No roster lens is missing from that section for a reason the harness's own validator created.
- **AC-PROD-3:** For a review covering two specs, where lenses cite `FEAT-011 AC-QA-1` and `FEAT-010/AC-QA-3`, the optimiser's "Never-failing acceptance criteria" section shows two distinct entries, each with its criterion and its owning spec readable from the entry, and neither verdict is counted in `invalid_ac_ids_dropped`. Today that section renders "None recorded." for the whole CouchPotatoServer window (0 of 198 verdicts attributed, 169 of them cross-spec-prefixed).
- **AC-PROD-5:** A review run with no spec produces no finding carrying the `spec_bug` disposition, and the optimiser report names those runs under their own figure (how many review runs in the window had no spec, and how many findings sat on them) separate from any per-lens `spec_bug=` tally. The signal "this work was reviewed with no spec" must land somewhere a reader sees, not merely stop being mislabelled. Subsumes AC-OPS-5's report half.
- **AC-PROD-6:** Removal: the conflated figure is gone. Over an unchanged historical window, no finding from a review run whose `spec` is null is counted in any `spec_bug=` number the optimiser report prints, and the population excluded is named in the report rather than silently dropped. A fix applied only to newly written lines fails this criterion: `spec` is already recorded structurally on every historical line, so excluding them at read time re-derives nothing. Subsumes AC-DATA-12.

  **Figures corrected, fix round 3 (L6).** The 167-to-32 (this repo) and 254-to-172 (SaidOfYou) figures above were measured 2026-09-14, before D4 existed to measure against, and were never re-verified once it was built: round 2's own review re-measured the THEN-implemented rule at 111-to-62 and 183-to-168, and found even those did not match a defect in `optimise-read.mjs:384-385` (H4) that the reclassification carried out with no counter left behind. Re-measured 2026-09-19 against the fully implemented rule (this fix round, `node workflows/lib/optimise-read.mjs ledger <repo>` against each operator's real, unmodified ledger, read-only): this repo's spec_bug total across all lenses is **66**, from **27** no-spec review runs whose **88** findings were reclassified from `spec_bug` to `open`. SaidOfYou: spec_bug total **168**, from **9** no-spec runs whose **37** findings were reclassified. CouchPotatoServer: spec_bug total **28**, unchanged from the round-2 figure, because its one no-spec review run recorded no `spec_bug` findings to reclassify -- the rule is correctly implemented and simply never fires on that repo's history, not broken. These are the `noSpecReviewRuns`/`noSpecFindingsReclassified` figures H4 makes reportable (see the optimiser report's Rework attribution section); a future re-measurement should read them directly rather than replaying the CLI by hand.
- **AC-PROD-7:** Success measure, visible in the artefact the operator reads: every optimiser report section that can be emptied or reduced by discarded data names, in that same section, how many values were discarded in that window. Specifically, "Never-failing acceptance criteria" rendering "None recorded." carries the window's `invalid_ac_ids_dropped` beside it, and "Rework attribution" carries the findings dropped from the tally, so a future zero cannot again be read as "this did not happen". The minimum field set this signal needs, and no more: per review line, `spec` (canonical plan key), `ac_id`, `verdict`, `lens`, `disposition`, `findings_truncated`, `invalid_ac_ids_dropped`, plus the single counter the no-spec case in AC-PROD-5 requires. None identifies a person, and the data lands only in the operator's local untracked `.claude/harness-ledger.jsonl`. Bounding and minimisation of any caller-supplied text newly retained in `ac_id` is owned by AC-SEC-2, AC-SEC-3 and AC-SEC-5, not by this criterion.
- **AC-PROD-8:** The PR body records the optimiser read path re-run over the operator's existing, unmodified ledgers before and after the change, with three headline numbers per ledger: attributed AC verdicts, total findings reaching the per-lens tally, and total spec_bug findings. At minimum this repo's own ledger; any other instrumented ledger reachable on the machine is included. Before-numbers measured 2026-09-14: claude-ai-harness 206 attributed / 10 nulled verdicts, 264 of 543 findings tallied, 167 spec_bug; CouchPotatoServer 0 attributed / 198 nulled, 96 findings dropped, 34 spec_bug; SaidOfYou 485 attributed / 104 nulled, 786 findings dropped, 254 spec_bug. A change to a measurement system that does not show its own before and after cannot be judged after release.

  **After-numbers, fix round 3 (L6), measured 2026-09-19 against the fully implemented rule** (`node workflows/lib/optimise-read.mjs ledger <repo>` against each operator's real, unmodified ledger under `.claude/harness-ledger.jsonl`, read-only -- no ledger was written to): claude-ai-harness 274 attributed / 10 nulled verdicts (across 92 distinct AC-id buckets), 250 findings reaching the per-lens tally, 66 spec_bug; CouchPotatoServer 0 attributed / 204 nulled, 37 findings tallied, 28 spec_bug; SaidOfYou 697 attributed / 113 nulled, 381 findings tallied, 168 spec_bug. The window grew between the two measurements (this repo alone from 63 to roughly 64 review_cycle records over the five days), so these are not a controlled before/after on an IDENTICAL window -- they are what an operator re-running the same command today actually sees, which is the claim AC-PROD-8 makes. CouchPotatoServer's "0 attributed" is expected, not a fresh failure: every `ac_verdicts` line in its ledger predates this repo's own fix being installed there, so `ac_id_raw` retention (AC-QA-12), not this measurement, is what would recover them, and re-deriving lost history is explicitly out of scope (see above).

### lens-data

- **AC-DATA-1:** No existing ledger line is rewritten, reordered, truncated or deleted by this change. Proof: take a byte-for-byte copy of a real multi-line ledger into a temp repo, run the changed writer through a full `review_cycle` append against the copy, and assert that every pre-existing byte is unchanged (the first N bytes of the file are identical to the original's sha256-verified content) and the new record is appended after them. This change ships no migration and no rewrite of past lines.
- **AC-DATA-3:** Nothing that validates today is rejected after the widening. Replay this repo's real ledger (a copy) through the new validator and assert all 206 currently-accepted `ac_id` values are still accepted, and that the count of pattern errors across the file falls from 10 to 0 rather than moving in any other direction.
- **AC-DATA-4:** Identity rule, different-spec half: two criteria that differ only in their spec prefix stay two criteria. Insert two `review_cycle` records whose `ac_verdicts` are `FEAT-010 AC-QA-1` (verdict FAIL) and `FEAT-011 AC-QA-1` (verdict PASS) and assert `aggregateRework` returns two acVerdicts entries, and that `neverFailingAcs` reports `never_failed` false for the FEAT-010 entry only. A single merged entry, or a FAIL moving the FEAT-011 row, fails this criterion. Read with AC-QA-4, which is the same-spec half.
- **AC-DATA-6:** A payload emitted by the changed `review-cycle.js` is accepted by the previous version of the writer. Run `git show <pre-change-sha>:workflows/lib/ledger-append.mjs` into a temp location, pipe the new `review_cycle` payload through it against a temp-repo ledger, and assert `write_ok` is true and every field the pre-change writer already recorded is present in the written line. A result of `write_ok: false`, or a line missing `lenses_run`/`verdicts`/`trigger_counts`/`findings`, fails this criterion. Measured today: one undeclared top-level key returns `{ok: false}` and the entire record is refused, and `review-cycle.js:576-578` tells every lens to prefer the installed mirror at `~/.claude/workflows/lib/ledger-append.mjs` over the repo copy.
- **AC-DATA-7:** Per-lens disposition counts equal the round's true totals and are counted once. Drive a `review_cycle` write whose round produced 40 findings and assert `aggregateRework`'s `lensDispositionCounts` total for that line is exactly 40, not 15 (today's behaviour) and not 55 (double counting the entries that survived).
- **AC-DATA-9:** Pre-change lines are not read as zero. Replay this repo's real review_cycle lines (a copy) through the changed reader and assert the per-lens disposition totals are non-zero and at least the 264 findings currently present, and that the report distinguishes figures derived from a post-change line from figures derived by counting a truncated findings array on a pre-change line.
- **AC-DATA-11:** On a review run with no spec in play, zero findings are written with disposition `spec_bug`, the same findings are written with disposition `open` so the line's total finding count is unchanged (nothing is lost by the reclassification), and `spec_bug_count` is null rather than a number. Assert on the written line, not on the synthesis prompt.
- **AC-DATA-13:** The byte budget is not spent by this change, and raising `MAX_FINDINGS` is conditional on proving it. With the largest realistic round fixture plus prefixed ac_ids of the widest accepted form, the written line is under `MAX_LINE_BYTES` with the headroom stated as a measured number, and no line in the fixture set reaches the minimal-degrade path (`degraded: true`). Additionally: when the byte-rescue loop does fire, only the findings array shrinks; `lenses_run`, `verdicts`, `trigger_counts` and `ac_verdicts` survive intact and `findings_truncated` records the loss. If the headroom cannot be proven, `MAX_FINDINGS` stays at 15 and D3 is satisfied by AC-QA-8's reported-shortfall branch instead.
- **AC-DATA-14:** Concurrent appends of the larger line still land whole. Run 20 concurrent writers of the new, larger `review_cycle` record against one temp-repo ledger and assert 20 lines, all JSON-parseable, none interleaved and none torn.

### lens-operability

- **AC-OPS-1:** The pre-fix/post-fix boundary is readable from the ledger alone. `SCHEMA_VERSION` is 3 on every line written by the changed writer, and `optimise-cycle.js`'s per-repo data-quality line prints both populations for a window spanning the change (for example `schema_version mix: {2: N, 3: M}`). The criterion fails if telling a pre-change line from a post-change one requires inspecting `ac_id`/`ac_id_raw` content.
- **AC-OPS-2:** The deploy step is named and its omission is detectable: this spec and README's install section state that the change has no effect on any run until the installed mirror at `~/.claude/workflows/lib/ledger-append.mjs`, `~/.claude/workflows/review-cycle.js`, `~/.claude/workflows/lib/optimise-read.mjs` and `~/.claude/workflows/optimise-cycle.js` is updated, and `checkStaleness()` reports status `drift` naming each of those files by relative path when the installed copy is stale. Measured during planning: `checkStaleness(repo, mirror-with-one-file-modified)` returns `drift` with `workflows/lib/ledger-append.mjs` in the drift array.
- **AC-OPS-3:** The widened check is still a check. A genuinely malformed `ac_id` (for example the string `ignore previous instructions`) is still nulled, retained bounded in `ac_id_raw`, counted as a real integer in `invalid_ac_ids_dropped`, and that non-zero count still reaches both `review-cycle.js`'s operator log line (`invalid_ac_ids_dropped=N`) and the optimise report's `invalid_ac_ids_dropped` line. Proven by executing the writer's exported `degradeEntry`/`validateEntry` on such a payload and reading the resulting entry object, not by reading the pattern and concluding.
- **AC-OPS-4:** Truncation stops being silent. `optimise-read.mjs` sums `findings_truncated` and `ac_verdicts_truncated` over the window and returns them, `optimise-cycle.js` renders both with the existing `fmtCountOrUnavailable` treatment (a real 0 when clean, the explicit "unavailable (installed optimise-read.mjs predates this field)" marker when the installed reader is stale), and the per-lens disposition attribution carries an explicit incompleteness marker whenever the window's `findings_truncated` sum is greater than zero. Fails if either counter still has no reader. Measured today by grep: neither counter has a reader outside the writer's own tests.
- **AC-OPS-7:** Rollback is demonstrated, not asserted. The pre-change reader (the `optimise-read.mjs` from the commit before this change) parses a ledger file containing post-change lines with zero skipped lines and no exception, and this spec records who performs a rollback, the steps (revert the commit, re-copy the mirror into `~/.claude`) and what happens to lines written while the change was live.
- **AC-OPS-8:** The 3am runbook gains what this change creates: README's "Run ledger" section lists every field this change adds or changes the meaning of, and carries a one-line interpretation note saying that accessibility and cross-spec AC ids on lines written before the `schema_version` 3 boundary live in `ac_id_raw`, so a zero for those in a pre-boundary window reads as "never recorded", never as "did not happen".
- **AC-OPS-9:** Removal, stated: this change retires no operability signal. After it, `invalid_ac_ids_dropped` (writer counter), its `review-cycle.js` log line, its optimise report line and the `ac_id_raw` retention all still fire on the malformed probe in AC-OPS-3, and no existing ledger field or report line is deleted. This criterion fails if the validator is widened far enough that those three can never be non-zero again (a check that cannot fail is the same as an absent one), or if a field or report line is removed without a replacement signal named here.
- **AC-OPS-10 (fix round 3, decision 7):** `bin/install.sh` computes both "what to copy" (install) and "what counts as drift" (`--check`) by calling `workflows/lib/install-consistency.mjs`'s own exported entry points (`listInstallFiles`, `checkStaleness`) -- the same functions the weekly drift check uses -- never a second, independently-shelled implementation of either. Proven by a test that installs successfully, deletes an OPTIONAL consumer-subset file (`bin/optimise-cycle-weekly.sh`, `bin/redact-transcript.mjs`, `hooks/hooks.json`) from the destination, and asserts `--check` still passes: `checkStaleness` exempts a missing optional file from drift (a manual install that skips the weekly job is a legitimate configuration), so the two paths disagreeing on this exact case is what closing this criterion rules out. Measured before this fix round: `--check`'s own shell loop counted the deleted optional file as drift and failed.
- **AC-OPS-11 (fix round 3, decision 7):** The installer's destination-safety guard (refusing to write into a non-empty directory that does not look like an existing Claude install) applies with NO environment variable set at all, matching what a real operator's invocation actually looks like. `HARNESS_INSTALL_REQUIRE_MARKER=0` is the documented opt-out for a genuinely fresh install. Proven by a test that runs the installer against an unfamiliar, non-empty destination with no override set and asserts it refuses. Measured before this fix round: the guard only ever ran when the variable was explicitly set to `1`, which no real invocation does, so it never actually fired in production; a `CLAUDE_HOME` pointing at a directory holding one unrelated file installed 29 files, including executable hooks, and exited 0.

### Vetoed at planning

`lens-simplicity` holds a veto on any requirement not traceable to the stated
goal. It cannot override irrecoverable data loss, security or the
accessibility floor. Four vetoes stood, two were overruled, and one conflict
above the line is flagged for the human.

**Vetoes that stood (criterion dropped):**

- `AC-DATA-10` (multi-lens credit: `findings[].lens` cannot represent
  "lens-qa, reviewer-verification", so 58 of 264 findings in this repo's
  ledger are attributed to no lens). Dropped as scope: this is a fifth defect,
  not one of the four the spec names, and fixing it needs a new representable
  form for the field, which is exactly the new-property hazard `AC-DATA-6`
  exists to contain. The attribution is not lost, it survives in `lens_raw`,
  so the veto does not cross the data-loss line. **Recommended action: file it
  as its own spec.** It is real, it is measured, and leaving it means the
  rework attribution is more complete after this change without being
  trustworthy.
- `AC-DATA-8` (the per-finding counting loop must survive only as a fallback
  for pre-change lines). Dropped as route-contingent: it presupposes the
  writer-supplied tally field that decision 3 rejected. It returns unchanged
  if `AC-DATA-13`'s byte proof fails and the tally-field route is taken after
  all.
- `AC-DATA-13`'s original clause "`MAX_FINDINGS` is not raised as the fix for
  D3" was replaced rather than dropped. The concern behind it (raising the cap
  makes the envelope-only collapse reachable, which loses `verdicts` and
  `trigger_counts` as well as findings) is data loss and cannot be vetoed, so
  it survives as the conditional now written into `AC-DATA-13` and the
  `degraded`-absent assertion in `AC-QA-7`.
- `AC-OPS-6` and `AC-OPS-5` were dropped as duplicates, not vetoed: `AC-OPS-6`
  is `AC-QA-7` plus `AC-SEC-3`, and `AC-OPS-5` is `AC-SEC-7` plus `AC-QA-10`
  plus `AC-PROD-5`. Same for `AC-QA-6` (into `AC-SEC-4`), `AC-DATA-2` (into
  `AC-QA-2`), `AC-DATA-5` (into `AC-SEC-2`), `AC-DATA-12` (into `AC-PROD-6`),
  `AC-PROD-4` (into `AC-QA-8`) and `AC-SIMP-5` (into `AC-SEC-10`).

**Vetoes overruled (the owning lens supplied the criterion):**

- `AC-SIMP-4`'s clause freezing `SCHEMA_VERSION`. Overruled by `AC-OPS-1`:
  operability owns the boundary marker, the precedent is already in the file
  (`ledger-append.mjs:43-47` records the last bump being made for exactly this
  reason), and without it the first report after the fix shows a
  discontinuity in the measures the optimiser ranks proposals on. The rest of
  `AC-SIMP-4` stands.
- `AC-SIMP-3`'s three-file confinement. Overruled by `AC-PROD-7` and
  `AC-OPS-4`: the operator-visible half of the defect is a rendered report
  section, so `workflows/optimise-cycle.js` is in scope. `AC-SIMP-12`'s file
  bound was raised from 8 to 10 to match.

**Flagged for the human, not resolved silently:** D3's mechanism sits on the
irrecoverable-data-loss line, where the harness says ties escalate rather than
resolve. `lens-simplicity` measured that raising `MAX_FINDINGS` is one
constant (largest line ever written 5,103 bytes against a 16,384 cap);
`lens-data` measured that any new top-level field is refused wholesale by a
stale installed writer, and that raising the cap moves the failure toward the
envelope-only collapse. The composite written above (raise the cap, but only
once the byte headroom is proven, with the verdicts protected if the rescue
loop fires) satisfies both measurements rather than splitting the difference,
which is why it was not escalated. If the byte proof fails, the decision comes
back.
