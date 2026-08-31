# Record fixed findings in the run ledger, joined across rounds by a verified id

<!-- no-acceptance-criteria: this file uses its own AC-1..AC-4 numbering (matching what the code and tests already cite by number), not the AC-<LENS>-<n> multi-lens harness convention -- see "Acceptance criteria" below. The AC-ARCH-9/AC-SEC-2/etc mentions elsewhere in this file are prose references to OTHER specs' pre-existing criteria (explaining why a pinned test or a free-text exclusion exists), never definitions of new ones in this file. -->

**Status:** implemented, fix round 2 in progress
**Lenses run:** none at planning (implemented directly against a written brief, not through plan-cycle). This file is written retrospectively (fix round 1, finding 6) to close the gap between the code's own citations and a spec that did not exist.

## Problem

Rework attribution -- "which lens's findings actually get fixed, versus
evaporate" -- is the optimiser's primary input for judging whether a lens is
pulling its weight. Across 34 rework records every lens showed `fixed:0`,
and the raw ledger held only `open`/`rejected`/`spec_bug` values, even though
`'fixed'` was already declared in `workflows/lib/ledger-append.mjs`'s own
`DISPOSITIONS` list. Plan tasks existed whose whole purpose was closing
findings (a 32-finding whole-branch review, 13 remaining round-4 findings),
and none of that work ever reached the ledger as a `fixed` disposition.
Fixed findings were exiting unrecorded, which blinded rework attribution: it
could not distinguish a lens whose findings get fixed from one whose
findings simply evaporate from the report between rounds.

## Approach

`workflows/review-cycle.js` gains an optional `prior_findings` argument:
findings the caller (in practice, `conduct-plan`) reports as open going into
this round, as `{lens, location, claim, severity?, ac_id?}` -- the same raw
descriptor shape `open_findings`/`spec_bugs`/`rejected_findings` already
use. When supplied, the synthesis step is asked which of those it can
confirm resolved in the built change, and returns `fixed_findings`, echoes
of the ones it confirms. Both raw arrays ride through to
`workflows/lib/ledger-append.mjs` as opaque payload data (workflow scripts
have no `node:crypto`, so id hashing happens there, same as every other
disposition).

The id guard: `computeFixedFindings` hashes both `prior_findings` and
`fixed_findings` through the same `findingId(lens, location, claim)`
function `computeFindings` already uses for every other disposition. A
`fixed_findings` entry is only recorded `disposition: 'fixed'` when its hash
matches one already present among `prior_findings`' own hashes. This proves
a specific, narrower thing than it might sound like it proves: **a
confirmation must reference one of the findings supplied in the same
request** -- it cannot invent an id that was never in that list, and a
finding reworded between rounds hashes differently and is never wrongly
cleared. It does **not** prove the confirmation is honest: a synthesis that
echoes the entire supplied list back as "all resolved" passes this guard
with nothing dropped (fix round 1, finding 3 -- see below).

## Acceptance criteria

These three match what the code and tests already cite by number
(`workflows/lib/ledger-append.mjs`, `workflows/review-cycle.js`,
`test/ledger-append.test.js`, `test/review-cycle.test.js`,
`test/ledger-seam.test.js`).

**AC-1** (extended, fix round 2): `review-cycle` accepts an optional
`prior_findings` argument. Absent, every existing behaviour is
byte-for-byte unchanged: no prior-findings block reaches the synthesis
prompt, no `fixed_findings` field is requested, and the terminal ledger
payload's `prior_findings`/`fixed_findings` both stay `null`. Proven by the
existing suite passing untouched, plus dedicated tests asserting the
absence of the prior-findings prompt block and the null payload fields.
**Fix round 2 adds the identity requirement the original AC-1 did not
state**: a finding raised `open` in one round and confirmed `fixed` in a
later one must carry the SAME `id` on both ledger lines, so a reader can
join the two records. Proven end to end in `test/ledger-seam.test.js` by
writing two REAL ledger lines (through the real `ledger-append.mjs`, never
a hand-built payload) and reading both ids back off disk -- see "Fix round
2" below for how.

**AC-2**: When `prior_findings` is supplied, findings the synthesis
confirms resolved (by echoing one of the supplied descriptors verbatim) are
written to the ledger line with `disposition: 'fixed'`. A prior finding not
echoed back is never recorded fixed, even though it is present in
`prior_findings` -- confirmation is required per finding; presence in the
supplied list alone is not enough.

**AC-3** (extended, fix round 2 -- the criterion this round cares about
most). Two distinct guards, both fail-closed, both counted, both proven by
mutation:
- The ORIGINAL id guard: a claimed-fixed entry whose `findingId` hash does
  not match one already present among `prior_findings`' hashes is dropped,
  counted under `invalid_fixed_ids_dropped`, and the record is still
  written.
- **The NEW trust boundary fix round 2 introduces**: `prior_findings` now
  carries an `id` field, supplied by the conductor (sourced from a
  previous round's own ledger write, never re-typed). A supplied id that
  does NOT match `findingId` recomputed from that SAME entry's own
  `lens`/`location`/`claim` -- mistyped, stale, hand-edited or fabricated
  -- is dropped, counted under `invalid_prior_ids_dropped`, and never
  becomes part of the joinable set for that write. This is what makes
  AC-1's identity claim trustworthy rather than merely convenient: a
  supplied id is only ever honoured after it has been independently
  re-derived from its own content.
Both counters follow the same fail-closed sanitiser shape as
`invalid_ac_ids_dropped` elsewhere in this file: the offending value is
dropped, the drop is counted, never the whole line.

**AC-4** (delivery discipline, not a runtime behaviour): every guard above
is mutation-proven in both directions -- the id guard removed, `fixed`
never written, and every prior finding recorded fixed regardless of
confirmation -- each mutation observed to fail a real test, then reverted
and confirmed green again. Fix round 2 adds: the prior-id verification
guard removed (a mismatched or missing supplied id trusted anyway), and
`findingId` recomputation broken so round one and round two ids diverge
again -- both observed to fail a real test, then reverted.

## Fix round 1 (2026-08-31)

A coordinator review reproduced a false claim in the original
implementation's own documentation ("this measure can undercount a genuine
fix, never overcount one") and found nine further defects, from a
duplicate-counting bug that directly contradicted the claim to a spec file
(this one) that did not exist. Ten findings, most severe first, each now
closed except finding 9 (judgement call, no code change) and finding 10
(a static test, not a runtime guard).

**Finding 1 (HIGH) -- duplicate confirmations counted separately.**
`computeFixedFindings` pushed one entry per `fixed_findings` candidate with
no dedupe by id: a synthesis listing the same finding once per affected
lens section (or repeating it for emphasis) inflated the recorded count.
Reproduced directly: one real finding, three identical `fixed_findings`
entries, produced three `'fixed'` ledger entries with
`invalid_fixed_ids_dropped: 0` -- nothing was invalid, the repeats were
genuine matches, just never deduplicated. Fixed by deduplicating within
`computeFixedFindings` by matched id (first occurrence wins), with the
repeats counted under a new field, `duplicate_fixed_ids_dropped` (same
null-vs-zero convention as `invalid_fixed_ids_dropped`), surfaced through
`optimise-read.mjs` and rendered in `optimise-cycle.js`'s report (closing
finding 5 for this new field too, rather than reintroducing it).

**Finding 2 (HIGH) -- the same finding confirmed in successive rounds
counted once per round.** The ledger writer has no memory across lines,
and `optimise-read.mjs`'s `aggregateRework` sums every matching record in
the analysis window. `skills/conduct-plan/SKILL.md` told the conductor to
pass "the findings this task's previous review round reported open" --
worded ambiguously enough that a conductor reading it as the accumulated
open list, rather than only the immediately preceding round's list, would
re-supply an already-confirmed finding every round, and each round's
confirmation would be written and counted again. This cannot be fixed at
the writer: each `ledger-append.mjs` invocation sees exactly one line, with
no visibility into any other. Fixed read-side, in `aggregateRework`: a
`'fixed'` disposition finding whose id (scoped per repo, since ids are not
guaranteed globally unique) has already been counted once in the analysis
window is skipped rather than counted again, with the skip counted under
`duplicateFixedAcrossRounds` so it stays visible rather than silently
changing the reported number. `SKILL.md`'s wording was also tightened to
say explicitly not to accumulate, though prose cannot make this
structurally impossible the way the read-side dedupe does -- see finding
10.

**Finding 3 (HIGH) -- the documentation claimed a property the code does
not have.** `README.md` said the mechanism "cannot be rubber-stamped". A
synthesis that echoes the entire supplied `prior_findings` list back as
`fixed_findings` records every one as fixed, with `invalid_fixed_ids_dropped:
0` -- every reference genuinely appears in the supplied list, so nothing is
dropped, which is the literal shape of a rubber stamp. `README.md`,
`skills/conduct-plan/SKILL.md`, `workflows/lib/ledger-append.mjs`'s own
comments and one test title were all reworded to state precisely what the
guard proves (a confirmation must reference one of the findings supplied in
the same request -- fabrication is closed) and what it does not (whether
any one confirmation is honest is not verified by this mechanism; see
finding 9 for the trust boundary this leaves, and the judgement on whether
to mitigate it further).

**Finding 4 (MEDIUM) -- the feature switched itself off on exactly the busy
rounds it exists for.** `MAX_FINDINGS` (15) bounded the total `findings`
array via a flat concatenate-then-slice, with `fixed` entries appended
LAST. A round with 15 or more open findings alone reached the cap before a
single fixed entry was ever considered, regardless of how many were validly
confirmed -- `invalid_fixed_ids_dropped` correctly reported 0 in that case,
since nothing was invalid; everything that vanished, vanished to
truncation, a different and previously uncounted-per-category cause. Fixed
by `budgetFindings`: a round-robin allocator that takes one entry at a time
from each still-non-empty disposition category (in priority order
`spec_bugs`, `rejected`, `fixed`, `open` -- `fixed` moved ahead of `open`,
the category that was starving it) until `MAX_FINDINGS` is reached, so no
single category can consume the whole budget while a smaller one behind it
gets nothing. The total truncated count (`findings_truncated`) is
unchanged; only which entries survive changed.

**Finding 5 (MEDIUM) -- `invalid_fixed_ids_dropped` written and read by
nothing.** `optimise-read.mjs` summed `invalid_ac_ids_dropped` and
`invalid_record_values_dropped` across the analysis window and exposed
both; there was no equivalent for `invalid_fixed_ids_dropped`, so the one
signal that a synthesis fabricated a confirmation reached no report --
exactly the "written to every line and read by nothing" defect this repo
had already found and closed once, for a different counter, in its own
words. Fixed: `aggregateRework` now sums `invalid_fixed_ids_dropped` and
`duplicate_fixed_ids_dropped` (finding 1's new counter) the same way, both
returned from `aggregateRework` and threaded through `optimise-read.mjs`'s
CLI `ledger` command output, and `optimise-cycle.js` renders all three
(plus `duplicateFixedAcrossRounds` from finding 2) in the report's Sample
completeness section, matching the existing `invalid_ac_ids_dropped`/
`invalid_record_values_dropped` render pattern exactly (real zero when
clean, the explicit unavailable marker for a stale reader, never omitted).

**Finding 6 (MEDIUM) -- this spec did not exist.** Fifteen references to
`specs/record-fixed-findings.md` and its AC-1..AC-4 existed across
`ledger-append.mjs`, `review-cycle.js` and three test files, with no such
file under `specs/`. This document is that file, with acceptance criteria
numbered to match those citations exactly, and this fix-round section
covering the additional work.

**Finding 7 (LOW) -- `null` meant more than documented.** The schema
comment and README said `invalid_fixed_ids_dropped` is `null` when
`fixed_findings` "was not supplied at all" -- true, but incomplete: a
malformed `fixed_findings` (an object rather than an array) also yields
`null`, since `computeFixedFindings` only checks `Array.isArray()`. Comments
reworded to say both cases explicitly; a dedicated test
(`fixed_findings: {not: 'an array'}`) now pins that a malformed value reads
the same as absent, not as a crash or a confident zero.

**Finding 8 (LOW) -- a finding could be `open` and `fixed` on the same
line.** Nothing cross-checked `open_findings` against a confirmed
`fixed_findings` entry, so `prior_findings: [P], open_findings: [P],
fixed_findings: [P]` wrote the same id twice, once per disposition, on one
line -- a contradiction (a lens still reporting P open this round, while
synthesis simultaneously confirms it resolved). Reconciled rather than
merely documented: `computeFixedFindings` now takes the current round's own
`open` finding ids and refuses to record fixed any id that is also still
open this same round, folding the drop into `invalid_fixed_ids_dropped`
(a different reason from an unmatched claim, but the same fail-closed
outcome, and the schema comment now names both reasons).

**Finding 9 (LOW, judgement call -- no code change made).** Lens reports
are embedded verbatim into the synthesis prompt, and derive from the diff
under review; the synthesis is then asked to confirm which prior findings
are resolved. Text in a reviewed repository that reaches a lens's `claim`
and, once echoed into `prior_findings` on a later round, instructs the
synthesis to confirm resolution regardless of merit, would now write a
disposition people trust for rework attribution. The injection *surface*
(lens findings' free text reaching the synthesis prompt) is pre-existing --
`review-cycle.js` has always embedded `LENS REPORTS (JSON)` into the
synthesis prompt and asked it to judge `rejected_findings`/`spec_bugs` from
that same untrusted content. What is new is the specific consequence: a
successful injection could now inflate a `fixed` count that feeds directly
into rework attribution and gets relayed to a human making decisions from
it. Judgement: no new code-level mitigation is proposed for this task.
Content-based filtering of claim text for injection-shaped language is not
recommended -- this repo has consistently preferred structural guards over
content filtering for exactly this reason, and the destructive-git-guard
history (see `~/.claude/CLAUDE.md`'s advisor-stance worked example) shows
why: the set of injection phrasings is unbounded, and each closed instance
invites the next. The mitigation that already exists structurally, at the
point where a fabricated number could cause harm, is that `optimise-cycle.js`
is explicitly forbidden from proposing the removal of `lens-security` or
`lens-qa`, and a HIGH fixed-rate is one signal among several an operator
reads, not a standing instruction to act unilaterally. Finding 5's fix
(surfacing `invalid_fixed_ids_dropped`/`duplicate_fixed_ids_dropped`) is
also a partial detection mechanism for this exact attack class: a
sustained run of dropped, unmatched confirmations is visible in the report
where it previously was not.

**Finding 10 (nit) -- the SKILL.md instruction has no test.** The
`prior_findings` pass-through is the single point where this feature is
either used or silently never used by a real conductor, and it lives in
prose a Claude agent reads, not in code a test can execute. There is no way
to mechanically prove a live conductor follows it -- this is inherent to a
prose instruction governing a judgement call (what to pass into a
sub-workflow argument), not a gap this fix round can close with a runtime
guard. What IS testable, and now is: `test/static-checks.test.js` pins that
`skills/conduct-plan/SKILL.md` continues to name `prior_findings` in its
review-cycle instruction, so a future edit cannot silently delete the
instruction without failing a test. This proves the instruction still
exists in the file; it does not and cannot prove any given conductor run
obeys it.

## Fix round 2 (2026-08-31): cross-round identity

The operator, reading fix round 1's review, chose the thorough option over
the cheap one: a finding raised `open` in round one and confirmed `fixed`
in round two must carry ONE identity across both ledger lines, so a reader
can join them. Demonstrated by execution: the same finding, same location,
across two rounds, wrote `358720dcff1040e7` (open) and `b0dfa52409dd6e97`
(fixed) -- two different hashes for one real finding, with
`invalid_fixed_ids_dropped: 0`, so nothing noticed.

**The cause.** `open_findings` ids are hashed from a lens's own JSON
`claim` string. `prior_findings`, under fix round 1's design, was whatever
the conductor re-typed after reading the SYNTHESISED MARKDOWN report --
prose, not the lens's structured text. `findingId` is a pure function of
its three inputs, so two different strings, however similar, hash to two
different ids. Fix round 1's id guard was self-consistent WITHIN one
request (a claim echoed by synthesis matched a claim the conductor typed
into `prior_findings` in the SAME request) but had no relationship at all
to the id a PREVIOUS request actually wrote to the ledger. It joined
nothing across requests, which was always the point of the feature.

**Two routes, weighed.**

*Route A: the conductor reads the previous round's ledger line*
(`workflows/lib/optimise-read.mjs`'s `ledger` command, the model-mediated
shell-out pattern already established at `workflows/optimise-cycle.js:336`).
Rejected. The ledger deliberately never retains `location`/`claim` free
text (AC-SEC-2, "no free text, ever" -- `findings` items carry only `{id,
lens, severity, ac_id, disposition}`). AC-3's guard requires recomputing
`findingId(lens, location, claim)` from SUPPLIED content and comparing it
to a supplied id; under Route A the conductor would have the TRUE id but
no `location`/`claim` to verify it against, or would have to fall back to
re-typing `location`/`claim` from the markdown report anyway -- reopening
the exact defect this fix round exists to close, since a lossy
transcription would almost never rehash to the id it is supposed to
verify. Route A cannot deliver AC-1 and AC-3 together.

*Route B: the ids travel out in review-cycle's own return value.* Chosen.
`ledger-append.mjs` already computes the real id for every open finding
before it ever writes; it now also RETURNS those ids (`open_finding_ids`,
in the same order `open_findings` was supplied) on the CLI result.
`review-cycle.js`'s `writeLedger` step relays that array back; review-cycle
zips it against `openFindingsRaw` (the full `{lens, location, claim,
severity, ac_id}` descriptors it already held in memory, never stripped)
and returns the result as a new `open_findings` field on its own public
return value. A conductor that stores this EXACT array and passes it
forward, untouched, as next round's `prior_findings` supplies the true id
alongside the true content that hashes to it -- both AC-1 (same id joins)
and AC-3 (a genuine pass-through always verifies) fall out of one
mechanism, with no extra shell-out per round.

**The ordering constraint, resolved.** review-cycle's own return statement
(`return { ...result, telemetry }`, pinned byte-identical across all three
workflow files per AC-ARCH-9) runs AFTER the terminal `writeLedger` call
completes, not before -- so the real id is available in time to be attached
to `result.open_findings`, assigned onto `result` the same way
`checkout_moved`/`ledger_write_failed` already are, never inline in the
pinned return line itself.

**The pinned exact-return-shape test, deliberately widened, not
removed.** `test/review-cycle.test.js`'s AC-ARCH-10 test (`the result
carries EXACTLY its documented keys plus telemetry`) now expects
`open_findings` as an eighth key. The protection that test exists for -- an
UNDOCUMENTED key silently leaking into the public result (its own original
motivation: the internal `__outcome` sentinel) -- is fully intact: the
assertion still fails the instant any key outside this named, reviewed set
appears. Nothing about the guard's purpose is weakened; its expected value
was widened for one genuine, reviewed, necessary addition.

**What changed, file by file:**
- `workflows/lib/ledger-append.mjs`: `computeFixedFindings` gained the
  prior-id verification guard (AC-3) and now returns `invalidPriorIdsDropped`;
  `main()` computes and returns `open_finding_ids` on the CLI result
  (never persisted as a new field on the ledger LINE itself -- `entry.findings`
  already carries each item's id).
- `workflows/review-cycle.js`, `workflows/tdd-task.js`, `workflows/plan-cycle.js`:
  the pinned L5 `writeLedger` block gained `open_finding_ids` on its response
  schema and return value, mirrored byte-identically across all three (only
  review-cycle.js ever populates it; the other two always see it `null`).
  review-cycle.js assigns `result.open_findings` after the terminal write.
- `workflows/lib/optimise-read.mjs` / `workflows/optimise-cycle.js`:
  `invalid_prior_ids_dropped` summed, returned, and rendered, the same
  discipline finding 5 established for its siblings -- a new counter must
  not become the next "written to every line and read by nothing" field.
- `skills/conduct-plan/SKILL.md`: the `prior_findings` instruction is now
  numbered mechanical steps (read `open_findings` from the STRUCTURED
  return value, store it verbatim in the conductor log tagged by task id,
  retrieve and pass it forward unmodified on the next round), not prose
  describing intent (AC-7).

**Honesty, restated plainly (this repo has had to correct this claim
once already, in fix round 1 -- see finding 3 above).** This joins a
confirmation to a previously recorded finding, by a verified id. It does
**not** prove the confirmation is honest: it is still a lens's judgement
that the thing is resolved, never proof of repair, and nothing in fix
round 2 changes that. A finding reworded between rounds -- different
`claim` text, even if it is "the same bug" to a human reader -- still will
not join: `findingId` recomputes from the exact text, and the safe
direction remains undercounting, never a false join. What fix round 2 adds
is narrower than "the number is now trustworthy": it is "a supplied id is
now verified against its own content before it is trusted," which closes
one specific failure (a mistyped, stale or fabricated id silently
producing a joinable record) without closing, or claiming to close, the
others (a false confirmation, a rubber-stamped list, a reworded finding).
