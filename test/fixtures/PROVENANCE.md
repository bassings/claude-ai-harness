# Fixture provenance

Fixtures in this directory exist so the test suite never reads repository history or the operator's live run ledger
(HARN-AUDIT-1 T4). The suite must pass in a `git clone --depth 1` with no `.claude/` directory.

Each historical file is kept byte-for-byte pristine, with no header comment added, because these are executable
workflow scripts and a header would change what the tests compare against. Provenance lives here instead. The sha256 of
each vendored file is recorded below and is checked by the test "T4: vendored 06049e4 fixtures match the sha256 values
recorded in test/fixtures/PROVENANCE.md" in `test/harn-opt-6-gap.test.js`.

## writer-06049e4/

The harness workflows and the ledger reader and writer as they stood at commit `06049e4`
(`06049e42958d733a45493a131e34ceb3141f7e33`, the last revision before the finding-id change), used by the golden-row,
rollback and mixed-version tests. Obtained once with `git show 06049e4:<path>`. The git blob ids are identical to the
vendored files' (`git hash-object` agrees), so the bytes match the original blobs exactly. The commit id will change if
public history is rewritten; the content recorded here does not.

```
550fae294acde13a534f7533a61536edc07e60d9eb835e7c1059e9cb14a0893b  writer-06049e4/lib/ledger-append.mjs   (from workflows/lib/ledger-append.mjs)
cdea4e11c225669d2f2c9468e377d1ee4df6fe39aa01516e99d392181b0b5bbc  writer-06049e4/lib/optimise-read.mjs   (from workflows/lib/optimise-read.mjs)
fed512bf2213c015b196826279be2cbd6812110c8b83756f009372791d0fb365  writer-06049e4/review-cycle.js         (from workflows/review-cycle.js)
257fa9f7aa03a6db8d53dd8cd1613aaa55e3eb1125e3d5745e95a9594308bc17  writer-06049e4/plan-cycle.js           (from workflows/plan-cycle.js)
b95bdbbcbad0fbcc9de0e0fddaa3ba04ade8866591bdf895de9eb5abdbee17d0  writer-06049e4/tdd-task.js             (from workflows/tdd-task.js)
```

## pr1-changed-files.txt

The changed-file list of the PR 1 merge commit (subject ends "(PR 1 of HARN-OPT-1) (#1)", `c33bd76` when recorded),
from `git show --name-only --format=<commit>`. Used by the AC-SIMP-7 test in `test/static-checks.test.js`. This is a
frozen record of a past fact.

```
8f0ff1c7a41a269c16c8737cd8d2837f56fe317f515d8ea0aea213dd86d6937e  pr1-changed-files.txt
```

## synthetic-ledger.jsonl

A hand-built, synthetic run ledger of 15 rows (plan_cycle, review_cycle across several rounds with open, fixed,
spec_bug and rejected findings, tdd_task, conduct_plan_event). Every value is invented: the repo label is
`example/sample-repo`, run ids are sequential placeholder UUIDs, round keys are repeated hex characters, and spec paths
are `specs/example-*.md`. Nothing was copied from a real `.claude/harness-ledger.jsonl`. It replaces the test's former
read of the live ledger, so the optimise-read comparison runs everywhere.
