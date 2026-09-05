# Mutation proofs: scrub of published operational detail (2026-09-05)

Every guard added or changed on `fix/scrub-operational-detail`, broken
deliberately and watched to fail, then restored. Each run started from a
confirmed-green baseline, because a mutation result read against an already-red
suite means nothing: two of these proofs were initially misread that way and had
to be re-run.

## The digest guard (round-one review HIGH-1)

The first version listed the banned strings as plain regexes and exempted its
own file, so the three identifiers were removed from three specs and
concentrated into one file beside labels naming exactly what each was. Caught by
review, not by me.

| Mutation | Result |
|---|---|
| Literal in `README.md`, hyphenated | CAUGHT |
| Literal underscored | CAUGHT |
| Literal camel-joined, no separators | CAUGHT (was MISSED before the window-size fix) |
| Literal fully joined, lowercase | CAUGHT |
| Literal embedded in a longer token, the production-volume shape | CAUGHT |
| Staging project name, hyphenated and camel-joined | CAUGHT (both) |
| Credential name | CAUGHT |
| Literal planted **in the guard's own file** | CAUGHT (the round-one blind spot) |
| Unrelated prose sharing some of the words | correctly NOT caught |
| Same words in the wrong order | correctly NOT caught |

The camel-joined miss is worth recording: window sizes were derived from each
entry's `atoms` count, so a form written without separators collapsed to one
atom and was never tested. Found by mutation, invisible on reading.

## The co-occurrence rule (round-one review MEDIUM-2)

The digests pinned the identity literals and not the volumetric attributions,
so the exact sentence this change removed could be pasted back with the suite
green.

| Mutation | Result |
|---|---|
| Named repo + file count + size on one line, the removed sentence restored verbatim | CAUGHT |
| The same figures in their anonymous form, which is deliberately kept | correctly NOT caught |

One genuine false positive surfaced: a line naming both repos only to say a
test ran against *neither*. The line was rewrapped rather than the rule
weakened.

## The scrubbed shapes

| Mutation | Result |
|---|---|
| Rollback tag format | CAUGHT |
| Destructive allow-list entry | CAUGHT |

## The tightened `specs/` waiver

| Mutation | Result |
|---|---|
| A real `/Users/<operator>` path in `specs/` | CAUGHT (was waived until this change) |
| The literal `YOUR_USERNAME` placeholder | correctly NOT caught |

## The residual declaration pin

| Mutation | Result |
|---|---|
| Residual heading renamed away in the spec | CAUGHT |

## A guard deleted rather than shipped

A history-scanning test was written here and removed. To search history without
holding the literal it hashed atom windows out of sampled blobs; instrumented,
it found **one of the three** digests it existed to detect, and passed. The
sampling could not reach the commits carrying the other two. A real search needs
`git log -S <literal>`, which needs the literal in the tree, which is exactly
what HIGH-1 forbids. The choice was an expensive test that lies or no test.

Recorded here rather than dropped silently: a deleted guard with no explanation
is indistinguishable from one nobody thought of. What replaced it is a pin on
the residual declaration in the spec, which is the thing that actually decays.
