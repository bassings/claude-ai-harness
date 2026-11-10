# Fixture provenance

Fixtures in this directory exist so the test suite never reads repository history or the operator's live run ledger
(HARN-AUDIT-1 T4). The suite must pass in a `git clone --depth 1` with no `.claude/` directory.

Each historical file is kept byte-for-byte pristine, with no header comment added, because these are executable
workflow scripts and a header would change what the tests compare against. Provenance lives here instead. The sha256 of
each fixture is recorded below as a line of `<sha256>  <path relative to this directory>`. The test "T4: every fixture
listed with a sha256 in test/fixtures/PROVENANCE.md matches its recorded value" in `test/harn-opt-6-gap.test.js` checks every such line, so a
fixture listed here cannot drift unnoticed.

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

## synthetic-ledger.jsonl

A hand-built, synthetic run ledger (plan_cycle, review_cycle across several rounds with open, fixed, spec_bug and rejected
findings, tdd_task, conduct_plan_event, and review rows built to drive every counter the 06049e4 reader reports: an
unattributed FAIL at each of its two sites, truncation, dropped-value counters, a non-roster lens, no-spec runs of each
round kind, a degraded row, and two malformed lines). Every value is invented: the repo label is `example/sample-repo`, run
ids are sequential placeholder UUIDs, round keys are repeated hex characters, and spec paths are `specs/example-*.md`.
Nothing was copied from a real `.claude/harness-ledger.jsonl`. It replaces the test's former read of the live ledger, so the
optimise-read comparison runs everywhere.

```
05174fed6ff30b213bbfe8c963d94dbf0e872ffeb34fec30419b70b01a3aed04  synthetic-ledger.jsonl
```
