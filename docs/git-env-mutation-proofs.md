# GIT_* environment hardening: mutation proofs

Per §11 and AC-QA-2: every guard below was broken in the working file, the
suite run, the exact failure recorded, and the file restored from a `cp`
snapshot. Never `git checkout --`, which reverts to the last commit and
destroys uncommitted work.

That warning is not theoretical here. It is stated in
`docs/harn-opt-2-mutation-proofs.md`, it was written by me, and I still ran
`git checkout --` on uncommitted work three times during this branch,
destroying a guard rewrite twice and the pre-push hook once. Prose I had
authored myself did not stop me. Recorded because it is evidence for §9
rather than an anecdote: the rule wants a mechanism, not a firmer memory.

Full suite: `node --test test/*.test.js`.

## PR #7 (merged, squash b379d17)

Recorded here retrospectively; the branch shipped without this file, which
review correctly failed as AC-QA-2.

| Guard | Mutation | Result |
|---|---|---|
| Recency window (`sortRecordsByTime`) | remove the sort at the concatenation site | 1 fail: kept `B-old-5..B-old-2` |
| Same | reverse the comparison | 1 fail: kept `B-old-1..B-old-4` — a **different** survivor set, so the test pins direction, not merely "a sort happened" |
| Unusable-`ts` rule | treat unparseable `ts` as newest (`+Infinity`) | 1 fail |
| Same | invert the index tiebreak | 1 fail |
| Same | mutate the caller's array in place (`records.reverse()`) | 1 fail |
| Scrub (load-time) | delete `scrubGitEnv()` call | 1 fail (only after layer-isolating tests were added; **before** them, 0 fail — the two end-to-end tests passed if *either* layer worked, so neither was proven) |
| Scrub (per-call, `sh`) | drop `env: sanitizedGitEnv()` | 1 fail |
| Scrub (per-call, `runAppend`) | drop `env: sanitizedGitEnv()` | 1 fail |
| `assertGitContextWithin` | disable both scrub layers | fires, naming the escape |
| Enforcement guard | backtick idiom, absolute path, `git-env` without the call, own call removed | 1 fail each |
| Same | wrapped destructure; `git-env` + the call; comments only | 0 fail (no false positive) |

Two guards were **not** load-bearing and the claims were corrected rather
than the code kept: the sort's explicit index tiebreak (`return 0` left the
suite green — `Array.prototype.sort` is stable by specification since ES2019),
and the equality branch avoiding a NaN comparator (V8 treats NaN as 0, so
125/125 green without it; retained as defence, documented as unproven).

## This branch (`fix/git-env-allowlist`)

### The allowlist, first cut — three mutations that all passed

Recorded because they are the finding. Review ran these against the first
version and the suite stayed 689/689 green for all three:

| Mutation | Before | After |
|---|---|---|
| replace the namespace filter with a denylist of exactly the names the tests exercise | 0 fail | **2 fail** |
| add `GIT_CONFIG_PARAMETERS` to the allowlist (a fixture's `user.email` then returned the injected value) | 0 fail | **2 fail** |
| empty the allowlist entirely (over-strip invisible) | 0 fail | **1 fail** |

The tests named `GIT_TEMPLATE_DIR` and `GIT_CONFIG_COUNT`, so they pinned two
escapes; a comment claimed they pinned the namespace property. A property
test cannot use a real variable name, because any list can be extended to
cover it. It now uses `GIT_NOT_A_REAL_VARIABLE_47B3F9`, which only a rule
over the whole namespace can satisfy.

### The measured escapes themselves

Both executed before any code was written, not inferred from documentation:

- `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=user.email GIT_CONFIG_VALUE_0=injected@evil.test git config --get user.email` → `injected@evil.test`.
- A `pre-commit` hook planted in a `GIT_TEMPLATE_DIR` was copied into a fresh repo by `git init` **and executed** during that fixture's own seed commit. Arbitrary code execution in every throwaway repo the suite creates, from an environment variable.

### Pre-push hook

| Guard | Mutation / probe | Result |
|---|---|---|
| Glob floor | run the hook where `test/*.test.js` matches nothing | exit 1, names the count |
| Same, control | the unguarded one-liner in the same directory | **exit 0** — the shape the guard exists for |
| Env strip | run with `GIT_DIR`, `GIT_TEMPLATE_DIR`, `GIT_AUTHOR_NAME` set | first two unset, `GIT_AUTHOR_NAME` preserved |
| Static pin | remove the glob guard from the hook | 1 fail |
| Real trigger | push from a linked worktree to a local bare remote | `GIT_DIR=<repo>/.git/worktrees/wt` **is** exported; suite 689/689; push exit 0. Main checkout: `GIT_DIR` unset |

Noted while proving it: `core.hooksPath` resolves relative to each worktree,
so a linked worktree runs its **own** checked-out copy of the hook.

### AC-identifier uniqueness

| Mutation | Result |
|---|---|
| duplicate id, colon-inside spelling (`**AC-X-1:**`) | 1 fail, names file and id |
| duplicate id, colon-outside spelling (`**AC-X-1**:`) | 1 fail |
| pattern matched nothing (under-detection) | 1 fail, via the definitions-found floor |

This guard was itself wrong twice while being written, in both directions,
and both are recorded because the second is the dangerous one:

1. Matching the bare id counted prose **mentions** as definitions. Specs
   discuss criteria they have vetoed or amended, so it reported five false
   duplicates — and a mechanical rename on the back of that renamed
   references inside a changelog, leaving the text citing ids that no longer
   existed. Reverted.
2. Tightening to one of the two definition spellings found **zero**
   definitions in a file full of them, and a scan that matches nothing
   reports no duplicates forever. Hence the floor assertion.

Two genuine duplicates were found: `AC-OPS-10` and `AC-OPS-11`, both from the
cross-session provenance block added 2026-08-18, colliding with criteria
already defined above. Renumbered to `AC-OPS-14..17`.

## Review round 2 (5 lenses + adversarial, `main...93a776a`)

Two High, ten Medium, nine Low. The through-line, stated because it is the
finding rather than a footnote: **every guard this branch added matched TEXT,
and the review defeated them by EXECUTION.** Each fix below replaces a string
match with a behavioural one.

### H2 — the hook's guards were both defeatable

| Mutation (review's, re-run here) | Old guard | New guard |
|---|---|---|
| insert `GIT_*) ;;` before the unset arm, so nothing is stripped | 32/32 green; `GIT_TEMPLATE_DIR` reached the suite, which is arbitrary code execution | 1 fail |
| change the empty-glob `exit 1` to `exit 0` | 32/32 green | 1 fail |
| delete the identity arm (over-strip) | not covered | 2 fail |

The hook is now executed in a temp directory with a stub `node` on PATH that
prints the `GIT_*` environment it was handed, so the assertion is about what
survived rather than about the source that produces it.

### H1 — the gate existed on one machine

`core.hooksPath` is local config no repository can set, and an unset value is
ignored **silently**. Proven end to end in a scratch repo with a local bare
remote: hook present, executable, unconditionally `exit 1` — push returns 0
and the hook never prints; after `bin/setup-hooks.sh`, the identical push is
blocked. Both directions are now a test.

| Mutation | Result |
|---|---|
| setup script sets an ABSOLUTE hooksPath (a linked worktree would then run the main checkout's copy) | 1 fail |
| setup script no longer sets hooksPath at all | 1 fail |
| README stops naming the setup script | 1 fail |

Recorded because it nearly passed for the wrong reason: the first attempt at
both mutations edited the **first** occurrence of the string, which is inside
a comment on line 9, not the command on line 18. The suite stayed green and
the guards looked non-load-bearing. §11's "check the mutation actually
applied" caught it; both were re-run by line number.

### M2 — four CI regressions survived a presence-anywhere match

| Mutation | Old | New |
|---|---|---|
| delete the gitleaks step, leave a comment containing the word | green | 1 fail |
| delete `timeout-minutes` from 2 of 3 jobs | green | 1 fail |
| delete `GIT_DIR` from the hostile step | green | 1 fail |
| delete `fetch-depth: 0` from the test job only | green | 1 fail |
| remove the scheduled trigger | n/a | 1 fail |

Assertions are now counts (`timeout-minutes` count equals `runs-on` count;
`fetch-depth: 0` appears exactly twice) or anchored `uses:` lines.

### M3 — the AC guard was blind to two of four specs

Covered 81 of 245 definitions; the two largest specs contributed **zero**, and
the global floor of `> 50` was satisfied by one file alone, so it could never
fire for them. A duplicate planted in `harn-opt-2.md`'s own spelling stayed
green.

Now proven per file: a planted duplicate is caught in **all four** specs, and
blinding the pattern fires a per-file floor rather than a global one.

The pattern has now been wrong three times, in three directions, and the third
is the instructive one: **the fix review proposed would have moved the
blindness rather than removed it.** It required the colon after the closing
bold, which finds 103 and 61 in the previously-blind files and 0 in the file
that had been working. Taking a reviewer's suggested regex literally is not
verification.

### M1 — the secret scan never walked history

`gitleaks-action@v2` passes `--log-opts` for `push` and `pull_request`, so on
those triggers it scans a commit range and never all refs; only an event with
no log-opts reaches gitleaks' `--full-history --all`. With no scheduled
trigger the history sweep did not exist, beneath a comment claiming full
history was the point. Added `schedule` and `workflow_dispatch`; the comment
now says which trigger does which.
