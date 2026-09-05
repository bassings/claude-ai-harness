# Mutation proofs: verify the reviewed tip, and make the reversal condition computable

Round-one review returned one High, five Medium and four Low across two changes
of mine. Every fix below was broken deliberately from a confirmed-green baseline
and watched to fail, then restored.

Two mutations initially reported CAUGHT against an already-red suite and one
reported MISSED because the mutation itself was ineffective (`### MEASURED AT`
replaced with `### MEASURED ATX`, which the regex still matches). All three were
re-run. A mutation result read against the wrong baseline, or produced by a
mutation that did not change behaviour, is worth nothing.

## A [High] Format brittleness in the gate I had just built

Four spellings of the CORRECT commit each aborted a run after the full
multi-lens budget was spent: the short sha `git log --oneline` prints, an
uppercase sha, a trailing newline (the literal output of a shell-captured `git
rev-parse HEAD`), and a leading space.

| Mutation | Result |
|---|---|
| Normalisation reverted to strict equality | CAUGHT |
| `trim().toLowerCase()` removed | CAUGHT |
| Positive: a genuinely different tree | still refused |
| Positive: a 5-character prefix, too short to identify a commit | still refused |

## B [Medium] Unbounded model string interpolated into a thrown error

Fixed at the schema, not at the interpolation site: hex-only and bounded leaves
nothing to neutralise.

| Mutation | Result |
|---|---|
| The pattern and maxLength removed | CAUGHT |
| Positive: backticks, `$(...)`, an absolute path, 200 chars, non-hex, empty | all rejected by the pattern |
| Positive: a real sha, and one padded by a shell capture | both accepted |

## C [Medium] My abort destroyed every other lens's findings

The throw sat between `lensesRunRaw` and the findings accumulators, so one lens
misreporting its sha erased a Critical security finding from another lens and
left a ledger line reading "these lenses ran and found nothing". The
absence-reads-as-success shape, rebuilt inside the fix for it. The file's own
rule already said to set accumulators as soon as `lensReports` exists; it was a
comment, so it did not hold.

| Mutation | Result |
|---|---|
| Accumulators moved back below the throw | CAUGHT |

## D [Medium] Two halves of one validator bug

The gate read `propSchema.type === 'array'`, false for `['array','null']`, so
union-typed arrays skipped item validation entirely. Fixing it immediately
exposed the second half: the item check compared `typeof item` against an array
when the item type was itself a union, so every legitimate `open_finding_ids`
value suddenly failed. Fixing one without the other turns a silent hole into a
loud false alarm.

| Mutation | Result |
|---|---|
| Gate reverted to strict `=== 'array'` | CAUGHT |
| Item type check reverted to `typeof item !== itemsSchema.type` | CAUGHT |
| Positive: `['ui-glob']` and `null` | both still accepted |
| Positive: `['bogus']`, `[42]`, `[{evil:1}]`, `[['nested']]` | all rejected |

Not specific to the field that exposed it: `['x','null']` is that file's house
style for "not measured", so every future nullable array inherited both halves.

## F [Medium] One error name for two different causes

A transiently failing lens was told to "let a parallel session settle", which is
the wrong action for the actual cause.

| Mutation | Result |
|---|---|
| The two causes collapsed back into one error | CAUGHT |
| Assertion on the remedy clause, which was previously uninverted | added |

## H, I, J

| Mutation | Result |
|---|---|
| The `MEASURED AT` contract heading altered | CAUGHT |
| The ledger key written as `null` again instead of omitted | CAUGHT |
| The `new-dependency` label removed | CAUGHT |
| The `new-module` label removed | CAUGHT |

## E, and one thing that is deliberately NOT a guard

E is an over-claim, not a mechanism: `AGENT-HARNESS.md` asserted the reversal
condition "is computable" when nothing reads the field, the condition asked for
a finding category the ledger deliberately does not record, and no line predates
the field. Restated in terms of `severity` and `outcome`, which ARE recorded,
with the earliest possible window stated and the missing reader named as the
remaining step.

There is no test for "the claim is true", because that is a judgement about the
world rather than about the code. What IS pinned is the contract heading and the
residual declaration, which are the parts that decay when someone tidies.
