# specs/harn-ledger-validators.md -- AC-PROD-8 measurements

AC-PROD-8: *"The PR body records the optimiser read path re-run over the
operator's existing, unmodified ledgers before and after the change, with
three headline numbers per ledger: attributed AC verdicts, total findings
reaching the per-lens tally, and total spec_bug findings. A change to a
measurement system that does not show its own before and after cannot be
judged after release."*

The numbers live here, in the repository, because a PR body is edited by hand
and drifts from the work: round-4's review found the body telling a round-3
story for a round-4 branch with no figures in it at all. This file is the
source the body quotes.

**Every run below was read-only.** Each ledger's sha256 was taken immediately
before and immediately after its runs and was unchanged; the shas are recorded
with the results. No ledger was written to, copied or modified.

---

## 1. What can and cannot be compared, which round 4 got half right

This change has a writer half (the validator accepts `AC-A11Y-<n>` and
cross-spec prefixes instead of nulling them) and a reader half (the tally
source, the no-spec reclassification, the truncation counters).

**Running two READER versions over one ledger measures only the reader half.**
Whether a verdict is attributable was decided when the line was written: an
`ac_id` the old writer nulled is gone from the line, and no reader recovers it
(re-deriving lost history is explicitly out of scope). So the "attributed
verdicts" column is identical under every reader version, and that is the
correct result, not a null one.

Fix round 4 published a reader-over-one-window comparison and read its equal
attribution column as evidence that "the validator fix's own measured gain is
untouched by the removal". The conclusion holds; the reasoning was loose. That
column is equal because no reader can move it, so it would have been equal
whatever the removal did. Corrected here rather than left standing.

**The writer half is therefore measured by date, not by version**: the
2026-09-14 figures were taken when every line in each ledger had been written
by the pre-change writer. Those windows are smaller and older than today's, so
they are a before-and-after of the system, not a controlled A/B.

---

## 2. Before: 2026-09-14, pre-change writer and pre-change reader

As recorded in the spec at planning time. Window as it stood that day.

| Ledger | Attributed verdicts | Nulled `ac_id`s | Findings reaching the per-lens counts | `spec_bug` |
|---|---|---|---|---|
| claude-ai-harness | 206 | 10 | 264 of 543 | 167 |
| CouchPotatoServer | 0 | 198 | 96 dropped | 34 |
| SaidOfYou | 485 | 104 | 786 dropped | 254 |

CouchPotatoServer's 0 is the defect in its purest form: 198 verdicts written,
every one of them nulled by the validator, and the report rendered "None
recorded." for the whole 90-day window.

---

## 3. After: 2026-09-20, at the branch tip, every reader version over one window

Command per row: `node <reader> ledger <repo>`, run minutes apart over the
same unmodified file. "main d05d10b" is the pre-change reader, included to
separate what the reader changed from what the writer changed.

### claude-ai-harness (ledger sha256 `5a118915e9bdb85b…`, unchanged across all four runs)

| Reader | Attributed verdicts | Buckets | Nulled | Findings reaching per-lens counts | `spec_bug` | `findings_truncated` rendered | No-spec runs named |
|---|---|---|---|---|---|---|---|
| main `d05d10b` | 421 | 121 | 11 | 291 | 135 | not read | not reported |
| round 3 `ec94e0a` | 421 | 121 | 11 | 403 | 93 | 396 | 27 |
| round 4 `445d813` | 421 | 121 | 11 | 291 | 86 | 396 | 27 |
| **round 5 (tip)** | **421** | **121** | **11** | **291** | **86** | **396** | **27** |

### SaidOfYou (ledger sha256 `4c59e044e18b9c3b…`, unchanged)

| Reader | Attributed verdicts | Buckets | Nulled | Findings reaching per-lens counts | `spec_bug` | `findings_truncated` rendered | No-spec runs named |
|---|---|---|---|---|---|---|---|
| main `d05d10b` | 697 | 298 | 113 | 305 | 183 | not read | not reported |
| round 3 `ec94e0a` | 697 | 298 | 113 | 381 | 168 | 866 | 9 |
| round 4 `445d813` | 697 | 298 | 113 | 305 | 162 | 866 | 9 |
| **round 5 (tip)** | **697** | **298** | **113** | **305** | **162** | **866** | **9** |

### CouchPotatoServer (ledger sha256 `8805c6666a088546…`, unchanged)

| Reader | Attributed verdicts | Buckets | Nulled | Findings reaching per-lens counts | `spec_bug` | `findings_truncated` rendered | No-spec runs named |
|---|---|---|---|---|---|---|---|
| main `d05d10b` | 0 | 0 | 204 | 37 | 28 | not read | not reported |
| round 3 `ec94e0a` | 0 | 0 | 204 | 37 | 28 | 96 | 1 |
| round 4 `445d813` | 0 | 0 | 204 | 37 | 28 | 96 | 1 |
| **round 5 (tip)** | **0** | **0** | **204** | **37** | **28** | **96** | **1** |

---

## 4. Reading the tables

**Attributed verdicts are decided by the writer, so the columns are flat.**
CouchPotatoServer still reports 0 attributed and 204 nulled because every
`ac_verdicts` line in its window predates the fixed writer being installed
there. `ac_id_raw` retention holds those values; recovering them is out of
scope by decision. This is the strongest single argument for AC-OPS-2: the fix
does nothing for a repo until the installed mirror is updated, which is what
`bin/install.sh` exists for.

**`spec_bug` falls because of D4, and it is the read-side half doing it.**
135 to 86 here, 183 to 162 on SaidOfYou, against unchanged history: those are
findings on runs that had no spec in play, which the old code recorded as
"this spec has a bug" and the new code reclassifies to "open" and counts
separately (27 and 9 no-spec runs). A read-side fix reaches history a
write-side fix never can, which is why D4's trigger was defined as observable
state rather than a stored flag.

**The findings column is where the removed tally shows up.** Round 3 reported
403 here and 381 on SaidOfYou; every other version reports 291 and 305. The
tally was counting findings the line could not hold, and it is gone, so the
number is back on main's own basis. What replaces it is the column beside it:
396 and 866 findings are named as truncated, in the same report section, where
before the change that counter had no reader at all.

**The fix-round-5 M1 fix moves none of these numbers, and that is expected.**
Round 4 and round 5 are identical on every row. The defect it closes needs a
line carrying `ac_verdicts_truncated > 0` with no surviving verdicts, or a
degraded envelope, and no line in any of these three windows is either. It is
a correctness fix against a shape these ledgers do not yet contain, not a
figure-moving one, and saying so is better evidence than a moved number would
have been.

---

## 5. How to re-take these

```sh
node workflows/lib/optimise-read.mjs ledger <repo-root> > /tmp/out.json
```

Read `rework.acVerdicts` (sum of `n` for attributed verdicts, length for
buckets), `rework.invalidAcIdsDropped`, `rework.lensDispositionCounts`
(sum every disposition for the findings figure, `spec_bug` alone for that
column), `rework.findingsTruncated` and `rework.noSpecReviewRuns`.

Take the ledger's sha256 before and after and check it is unchanged: the read
path is documented as read-only and that claim is worth re-proving each time
rather than trusting, because nothing else in the harness would notice if it
stopped being true.
