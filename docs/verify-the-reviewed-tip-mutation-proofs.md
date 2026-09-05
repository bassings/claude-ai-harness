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

---

# Round two: ten more findings, six of them in the round-one fixes

## F3/F4 — the gate could not fail for the case it was built for

The prompt printed the pinned sha in line one and asked for it back five lines
later. A lens that reviewed the WRONG tree and echoed line one passed. So the
check caught only a lens honest enough to report a foreign sha but not diligent
enough to fix its checkout -- the case that was already self-correcting in all
four observed runs -- and could not catch the case that actually loses data.

Redesigned: the gate is now the reviewed commit's TREE hash, obtained with
`git rev-parse <pinned-sha>^{tree}`. Its value appears nowhere in the prompt, so
it cannot be echoed, and the command moves nothing -- which matters, because
these worktrees can be shared and ordering a lens to check out the pinned sha is
the original incident. The lens's own HEAD is still reported but is now RECORDED
rather than gated, which also removes the perverse incentive: the previous
version attached an aborted run to an honest answer.

| Mutation | Result |
|---|---|
| The tree comparison removed | CAUGHT |
| A lens echoing the sha perfectly but reporting another tree | CAUGHT |
| The expected tree present in the prompt (would allow the echo) | asserted absent |
| A lens reporting the correct tree | still completes |

Stated limitation, kept beside the code: this proves the lens had the reviewed
commit's object, not that every finding came from that tree. It closes the echo.
It does not turn a self-report into an observation.

## F1 — a lens could rename itself

`{ lens, ...r }` spread the model's response over the workflow's own label, so a
`lens` key in the response won. Confirmed by execution: attacker-chosen text
reached the thrown error verbatim, dressed as a harness system error, and the
roster check then reported the real lens as vanished.

| Mutation | Result |
|---|---|
| Spread order reverted to `{ lens, ...r }` | CAUGHT |
| `additionalProperties: false` removed | CAUGHT (by its own test; the spread catches it first, so the second layer needed proving separately) |

## F2 — the pin was never checked, only the lens's answer

| Probe | Before | After |
|---|---|---|
| Pin `abc`, lenses on a DIFFERENT tree | completed, `outcome=done`, reported clean | refused as `ScopeHeadShaInvalid` |
| Pin `HEAD`, lenses entirely correct | refused, blaming a parallel session | refused, naming the SCOPE as the fault |

Both directions of the defect this change exists to close, rebuilt on the side I
did not guard. Proven load-bearing at both layers: the schema refuses a
malformed pin, and the workflow refuses it independently when the schema is
bypassed.

## F5 — the sibling drift flag, one screen below the fix

`checkout_moved` still compared two model-transcribed shas with raw `!==`, so
every benign spelling set a false alarm.

| Mutation | Result |
|---|---|
| Reverted to raw `!==` | CAUGHT (3 tests) |
| Alarm disabled entirely | CAUGHT (2 tests) |

## F6 — and this one is about the tests I wrote

Two of my own new assertions passed incidentally.

The normalisation tests varied `head_sha_measured`, which is no longer gated, so
they proved nothing about the gate. Moved onto the tree.

The "too-short prefix is refused" case used a value that was not a prefix of the
pin at all, so it was refused for the wrong reason and the length floor was
unpinned. Changed to `11111`, a genuine prefix of the pinned tree, which
discriminates.

| Mutation | Before the fix | After |
|---|---|---|
| Tree hex floor relaxed 7 -> 1 | MISSED | CAUGHT |
| Tree normalisation removed | MISSED | CAUGHT |

## Round-two follow-ups, closed rather than carried

| Finding | Fix | Proof |
|---|---|---|
| F1 second instance | `plan-cycle.js` carried the identical `{ lens, ...r }` spread. Fixed, with `additionalProperties: false` as the second layer. | Injected lens name no longer reaches the ledger payload; schema guard asserted separately since the spread catches it first |
| F7 | `maxLength` was declared four times and implemented nowhere, AND was redundant beside a pattern that already bounds the value. **Deleted rather than implemented.** A constraint nothing applies is worse than none: it reads as a second line of defence. The test asserting its presence is gone with it. | 4 declarations removed, suite green |
| F8 | The partial/total failure asymmetry is now stated rather than accidental: total failure returns softly because "no review produced" is unmistakable; partial failure throws because a review missing three of nine lenses reads exactly like a review. The remedy now names the `{lenses: [...]}` re-run. | — |
| F9 | The union-item fix had no test of its own and survived on three unrelated ones. The only union-typed items schema in the repo is this workflow's ledger response, so the test lives there. | Reverting the union handling: CAUGHT (2). Switching item checking off entirely: CAUGHT (1) |
| F10 | The forward-compatibility test proved the half never at risk. Title and comment now say what is true: omitting on the null path NARROWS the stale-writer exposure, it does not close it. | — |
