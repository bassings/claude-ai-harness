# HARN-OPT-6: review-cycle ledger payloads carry finding ids, never finding text

> Planning output of the multi-lens harness (`~/.claude/AGENT-HARNESS.md`).
> Acceptance criteria below are the contract the review cycle verifies against.
> A review finding with no AC behind it is a **spec bug**: record it in
> "Spec gaps found at review" so the planning lens improves.

**Status:** draft (planned by plan-cycle `wf_1106254d-49e`; two owner decisions open, see Vetoes and trade-offs)
**Lenses run:** security, qa, simplicity, product, data, architecture, operability · **Skipped:** design, accessibility (no UI or user-facing copy; internal telemetry)

## Problem

Every plan-cycle, review-cycle and tdd-task run appends a started row and a
terminal row to `.claude/harness-ledger.jsonl` by having a workflow agent
write a base64 payload to a temp file (Write tool) and pipe it to
`workflows/lib/ledger-append.mjs` (HARN-OPT-5 T5). HARN-OPT-5 measured that
transport live (its operability criterion 13): of twelve writes across all
three workflows, four were stopped by the runtime's safety classifier before
the writer ran. The four were all in review-cycle runs. At least three were
terminal payloads, which carry `spec_bugs`, `rejected_findings`,
`open_findings`, `prior_findings` and `fixed_findings` as raw `{lens,
location, claim, ...}` descriptors that the writer hashes into finding ids
and discards. One was a START write (HARN-OPT-5 tick 62), which carries no
lens text at all.

So the evidence that free text is what trips the classifier is suggestive,
not proven: a start write with no lens text was also stopped. This spec
removes the descriptors because that is right on its own terms (lens evidence
does not belong inside an agent tool call whose only job is to be hashed
away, and a smaller payload is a smaller target), and it tests the classifier
hypothesis live with a stated failure condition (AC-QA-13). If any of the
first twenty live writes is stopped, the transport itself becomes the next
spec.

Cost today: the bigger loss is not the missing rows but the missing finding
ids. When a terminal review write is stopped, `open_findings` comes back null,
so the next round has no ids to pass as `prior_findings` and no "fixed"
disposition is ever recorded for that task. The conductor has been
hand-writing replacement rows from returned telemetry to paper over this.

Direction, recorded at HARN-OPT-5 tick 55: finding ids are computed inside
review-cycle.js with a pure-JS sha256 (workflow scripts have no
`node:crypto`), so the descriptors never travel. The UTF-8 encoding for that
hash must match Node's for every input, including lone surrogates; it must
NOT copy `toBase64`'s encoder, which differs on lone surrogates (AC-QA-2).

## Not in scope

- Changing the ledger file's location, its gitignore discipline, or the
  started/terminal row pairing.
- Changing what the optimiser reads or reports. Rows keep their current shape
  on disk; only how they get there changes.
- Replacing the agent-mediated write with a different transport (a hook, an
  MCP server). Worth revisiting only if a no-free-text payload is still
  stopped in live runs.
- tdd-task and plan-cycle payload content. They carry no lens text; the
  tdd_task payload's `task` string is caller-authored and stays, an accepted
  exception to "no free text". Their only edits are the shared retry block
  and response schema (AC-ARCH-6, AC-OPS-4); the sha256 lives in
  review-cycle.js alone (AC-SIMP-3).

## What this replaces

| What goes | Owning lens | Removal criterion |
|---|---|---|
| Raw finding descriptors (`lens`, `location`, `claim`) in review-cycle's terminal ledger payload | security | AC-SEC-1 |
| ledger-append.mjs hashing descriptors it receives from a payload, for review_cycle rows | data | AC-DATA-9 |
| The conductor's practice (in HARN-OPT-5's log, not in SKILL.md) of hand-writing replacement review_cycle rows from returned telemetry | operability | AC-OPS-9 |

---

## Acceptance criteria

Removal criteria for "What this replaces": row 1 (security) is AC-SEC-1; row 2 (data) is AC-DATA-9; row 3 (operability) is AC-OPS-9.

### Security

- **AC-SEC-1:** Removal: review-cycle's terminal ledger payload carries no raw finding descriptors. In a fake-runtime review run, every free-text slot of every descriptor in spec_bugs, rejected_findings, open_findings, prior_findings and fixed_findings carries a unique sentinel: claim, location and evidence (including an absolute home-directory path built at test run time ('<home>/canary-user/secret.txt', with <home> the platform's real home prefix), a single quote, a backtick, '$(id)' and a 2 KB string), the middle segment of a compound lens label, a non-conforming ac_id and a non-enum severity. The base64-decoded payload taken from the ledger:write prompt contains none of the sentinels, the prompt text contains none of them, and no object at any depth has a key named claim, location, evidence, spec_bugs, rejected_findings, open_findings, prior_findings or fixed_findings. Mutation proof: putting the claim back into any finding entry turns the test RED. (Merges AC-QA-5.)
- **AC-SEC-2:** Every string value in both review_cycle payloads (started and terminal), at any depth, matches a closed allowlist: finding ids match ^[0-9a-f]{16}$; lens matches LENS_PATTERN_STR; severity, disposition, verdict, outcome, kind, rule_source and architecture_trigger_source are members of their schema enums; ac_id matches AC_ID_PATTERN_STR; round_key and lens_checkout_drift values match ^[0-9a-f]{7,64}$; the single exception is spec, which is the caller's argument. Shown by walking the decoded payloads of the AC-SEC-1 hostile-fixture run and failing on any string that matches none of these.
- **AC-SEC-4:** The workflow script resolves or nulls lens-authored labels before emitting them: a lens label like 'lens-security; cat <home>/canary-user/.ssh/id_rsa' reaches the payload as a roster lens name or null, and a non-conforming ac_id, severity or verdict reaches it as null, with each neutralisation counted. The decoded payload contains no lens_raw, ac_id_raw, severity_raw or verdict_raw key and none of the rejected label text, so rows written by the new path carry no *_raw sibling fields (see the trade-off recorded under Vetoed at planning).
- **AC-SEC-6:** The transport's injection controls are unchanged in all three workflows: with a payload containing a single quote, a backtick and '$(id)', ledgerWritePrompt places the payload only between the HARNESS-LEDGER-PAYLOAD delimiter lines, no backtick-quoted command in the prompt contains payload text, the writer search order (installed mirror, then plugin, then repo-local only when the repo is claude-ai-harness) and its refusal sentence for other repos are present, and the bodies of toBase64 and ledgerWritePrompt in all three workflow files are byte-identical to main. (Merges AC-SIMP-8.)
- **AC-SEC-7:** End to end, the ledger file never sees the canaries: the AC-SEC-1 hostile-fixture terminal payload run through ledger-append.mjs against a temporary git repository, never the operator's ledger, appends a line containing none of the canary substrings, including inside any *_raw field.

### QA

- **AC-QA-1:** The pure-JS sha256 in workflows/review-cycle.js, run as extracted from that file and not from a copy, returns the published digests for the empty string, 'abc', the 448-bit two-block message and one million 'a', and matches node:crypto on inputs of 55, 56, 63, 64, 65, 119 and 120 bytes; changing one round constant, or the length-encoding step, turns at least one case RED.
- **AC-QA-2:** For every descriptor in a hostile corpus, the in-script finding id is byte-identical to the node:crypto findingId(lens, location, claim) of ledger-append.mjs as of 06049e4 (held as a test-side reference, see AC-DATA-9): ASCII; 2-, 3- and 4-byte UTF-8 including emoji; a lone high and a lone low surrogate in claim and in location; CRLF and tab in the claim; a location needing trim and lowercase, including 'İ', 'ß' and 'Σ'; undefined, null, 0, false, a number and '' in each of lens, location and claim; hashed messages of 55, 56, 63, 64, 65, 119 and 120 bytes; a claim of at least 100 KB; and a seeded random differential of at least 1,000 triples. Mutation proofs watched failing: dropping .trim() or .toLowerCase() on the location, and encoding a lone surrogate as ED A0 80 the way toBase64's encoder does (measured: 'x\uD800y' gives 72dc505e6285ceea under node:crypto and c219540445e1fb4e under the naive encoder). (Merges AC-DATA-1, AC-ARCH-2 corpus, AC-OPS-1.)
- **AC-QA-3:** Ids are continuous across the cut-over: the already-pinned vectors e74fb146b7ddc6cb and 7c35753185a55bf1 (the latter from findingId('lens-security + lens-architecture','a.js:1','c')) are reproduced by the new path from their existing fixtures; every open finding id in a review_cycle row written by the new path equals a literal captured from main before the change for the same descriptor, not recomputed by the code under test; and an id stored in .claude/conductor-prior-findings.json before the change, passed as prior_findings after it, is accepted rather than counted in invalid_prior_ids_dropped or invalid_fixed_ids_dropped. (Merges AC-PROD-2 and the vector half of AC-ARCH-2.)
- **AC-QA-6:** The prior-id guard survives the move: a prior_findings entry whose supplied id does not match the hash of its own lens, location and claim, or that has no id, produces no fixed entry and increments invalid_prior_ids_dropped; a fixed_findings echo whose claim is reworded from a verified prior produces no fixed entry and increments invalid_fixed_ids_dropped; a fixed claim matching a valid prior id writes exactly one disposition 'fixed' entry carrying that id; a repeated matching claim increments duplicate_fixed_ids_dropped; and a fixed claim whose id is also open, rejected or spec_bug in the same round is dropped and counted. Removing the recomputation, the dedupe or the same-round exclusion each turns a test RED. (Merges AC-SEC-5.)
- **AC-QA-7:** Round-trip identity on a successful write below MAX_FINDINGS: each id in review-cycle's result.open_findings equals the id of the disposition 'open' entry on the written terminal row, matched by position, and feeding that array back unchanged as the next round's prior_findings, with one finding echoed as fixed, writes a 'fixed' entry with the same id; shown by two fake-runtime review-cycle runs against a stand-in agent that pipes to the real writer in a temp repo.
- **AC-QA-8:** The workflow test environment can show a missing-global failure: test/helpers/fake-runtime.js also rejects TextEncoder, TextDecoder, atob, btoa, a bare global crypto and globalThis.crypto, except any that a recorded live-runtime probe shows is present; the AC-QA-1 and AC-QA-2 tests run under that runtime, and rewriting the encoder to use new TextEncoder() makes the fake runtime refuse to load the workflow.
- **AC-QA-9:** The payload size limit is a measured number: the spec records the base64 sizes of the review-cycle payloads that landed and of the four that were stopped, or states that they cannot be recovered, and sets a byte ceiling from that; a test builds the largest payload the writer accepts (MAX_FINDINGS findings across the dispositions, prior and fixed at MAX_FINDINGS, 96 ac_verdicts, seven lenses, a compound lens label on every finding, every claim and location 2000 characters of non-ASCII text) and asserts the base64 payload passed to ledgerWritePrompt stays under the ceiling. (Merges AC-OPS-7; offline reference about 4.9 KB at 15 findings and 9.1 KB at 40, against about 2.1 KB of telemetry alone.)
- **AC-QA-10:** Malformed input is a counted drop, never a throw: a descriptor element that is null, not an object, or missing lens, location or claim is dropped from the payload and counted in an existing counter on the row, a non-array spec_bugs is treated as empty and counted, the run still returns, and it makes exactly one terminal write attempt.
- **AC-QA-12:** plan-cycle.js and tdd-task.js are otherwise unaffected: their ledger payloads, captured through extractLedgerPayload in the fake runtime, deep-equal the payloads captured from main for the same scripted runs, and the L5 block stays byte-identical across all three workflow files after the AC-ARCH-6 removal and contains no sha256 code.
- **AC-QA-13:** Live acceptance, verifiable only after merge: after bin/install.sh and a session restart, the first ten live review-cycle runs are tallied by run_id in the conducting plan's log, counting both start and terminal writes, with write_ok, whether ledger_write_failed was returned, whether both rows exist in .claude/harness-ledger.jsonl without being written by hand, and for any stop the base64 payload byte size; the target is zero stopped writes of twenty, a single stop is recorded as FAIL rather than re-run, and any stop reopens the transport question in Not in scope as the next spec (baseline: 4 of 12 writes stopped on the HARN-OPT-5 transport). (Merges AC-PROD-3, AC-OPS-8.)
- **AC-QA-14:** Removal: test/ledger-append.test.js, test/ledger-seam.test.js and test/review-cycle.test.js contain no test expecting a review_cycle row to be written with findings computed from raw descriptors; exactly one test, named as transition-only, pins the AC-DATA-6 legacy-payload behaviour; and reverting review-cycle.js to send descriptors turns AC-SEC-1 RED.

### Simplicity

- **AC-SIMP-1:** Outside test/ and specs/, the change edits only workflows/review-cycle.js, workflows/lib/ledger-append.mjs, workflows/plan-cycle.js, workflows/tdd-task.js, skills/conduct-plan/SKILL.md and README.md; the plan-cycle.js and tdd-task.js diffs consist solely of the AC-ARCH-6 removal and the AC-OPS-4 protected-key change to the pinned retry block; workflows/optimise-cycle.js and the ledger reader are untouched; checked by git diff --stat against main.
- **AC-SIMP-2:** No new dependency, vendored file or fetch: no package.json or lockfile changes, no new file appears under workflows/, no import, require or network fetch is added to any workflow script, and the pure-JS sha256 is a single function defined exactly once across workflows/, in workflows/review-cycle.js. (Merges AC-SEC-8.)
- **AC-SIMP-3:** The sha256 and finding-id code lives only in workflows/review-cycle.js, outside every block that test/static-checks.test.js pins as byte-identical; grep finds no sha256 implementation and no finding-id function in plan-cycle.js or tdd-task.js, and the pinning tests pass apart from the AC-ARCH-6 and AC-OPS-4 edits. (Merges AC-ARCH-3.)
- **AC-SIMP-4:** No new argument, configuration key, environment variable or harness-triggers setting: meta.whenToUse in review-cycle.js names the same parameters as on main, the prior_findings element shape the conductor passes is unchanged, and skills/conduct-plan/SKILL.md gains no new numbered step.
- **AC-SIMP-7:** No new generalisation of the writer: the set of export function names in workflows/lib/ledger-append.mjs is a subset of main's, and no runtime free-text scanner is added for plan_cycle, tdd_task or conduct_plan_event payloads.

### Product

- **AC-PROD-1:** When either review-cycle ledger write fails or is stopped (write_ok false, or no result), result.ledger_write_failed is true and result.open_findings is still an array, not null, whose every element carries a non-null id equal to the in-script id for its lens, location and claim; passing those elements unchanged as the next round's prior_findings records disposition 'fixed' for any a lens confirms resolved. (Merges AC-ARCH-7, AC-OPS-5 and the failed-write test of AC-SIMP-6; supersedes AC-DATA-7.)

### Data

- **AC-DATA-2:** Golden row equivalence: fixture synthesis outputs run through the new review-cycle.js and writer path, and the same descriptors piped as the old-style payload to the writer pinned at 06049e4, give review_cycle ledger lines that are deep-equal on every field except run_id, ts and the *_raw siblings removed by AC-SEC-4, including findings[] id, lens, severity, ac_id, disposition and order, findings_truncated, spec_bug_count, rejected_finding_count, every invalid and duplicate drop counter, and schema_version; fixtures cover zero findings, one of each disposition, compound lens labels, 70 open findings, duplicate fixed confirmations, a fixed claim also open in the same round, and the no-spec reclassification of spec_bugs into open; tdd_task and plan_cycle rows are unchanged against the same baseline, and SCHEMA_VERSION stays 6 only because this holds. (Merges AC-QA-4, AC-PROD-4.)
- **AC-DATA-3:** Key-collision pairs: two open findings sharing lens and location whose claims differ by one character get two distinct ids, and when both are passed as prior_findings and only the first is confirmed fixed, exactly one 'fixed' entry carrying the first id is written; a pair differing only in location case and surrounding whitespace gets one id; a pair differing only in lens gets two ids.
- **AC-DATA-4:** Three faulty prior_findings entries passed end to end through review-cycle.js and the writer, one with a single hex character changed, one correct for an earlier wording of its claim, and one carrying the id of a different finding in the same prior list, produce no fixed entry, and invalid_prior_ids_dropped equals exactly the number of such entries, while a correctly-id'd sibling the synthesis confirms is still recorded fixed; the borrowed-id case has been watched failing against a membership-only check.
- **AC-DATA-5:** The writer accepts a finding id only when it matches ^[0-9a-f]{16}$: ids of 15 or 17 characters, uppercase hex, 16 characters with one non-hex character, a 16-character absolute-path fragment, or '<home>/canary-user/secret claim' are never written as findings[].id and never take part in the fixed-against-prior join; the entry is dropped and counted in an existing counter and the row still lands with write_ok true; run against a temporary git repository only. (Merges AC-SEC-3; measured before the change, validateEntry returns no errors for a free-text id.)
- **AC-DATA-6:** Mixed-version installs never land a row that silently loses or merges findings: (a) the new review-cycle.js with the writer at 06049e4, given two open findings from one lens, never lands a write_ok true row carrying two findings under one shared id or carrying no findings because the retry stripped the findings key, and instead reaches ledger_write_failed and the log; (b) review-cycle.js at 06049e4 with the new writer sends legacy descriptor keys, which the writer neither hashes nor silently discards: the row lands with kind, outcome and run_id, the dropped count is a non-null integer on the line, and the writer's write_error or result text names the legacy descriptor shape and says the workflow script predates HARN-OPT-6. (Merges AC-OPS-2, AC-OPS-3, AC-ARCH-5, AC-QA-11.)
- **AC-DATA-8:** Cross-version join in the reader: a fixture ledger with an open row from the 06049e4 writer, a fixed row from the new path for the same finding and a second fixed row in a later round is attributed by optimise-read to one id under one lens, with the repeat counted in duplicateFixedAcrossRounds; optimise-read output over a copy of the live ledger is identical before and after the change, no existing line is rewritten, and the live ledger file's size and sha256 are unchanged by the whole test run.
- **AC-DATA-9:** Removal: ledger-append.mjs no longer hashes finding text: it defines, exports and calls no findingId, contains no createHash call, and its node:crypto import no longer names createHash, so no path reachable from main() hashes lens, location or claim for any kind and there is no dual path accepting both descriptors and precomputed ids; a review_cycle payload whose entries carry lens, location and claim yields no findings[].id equal to findingId(lens, location, claim) for any of them, and the AC-QA-2 oracle lives in the tests. (Merges AC-SIMP-5, AC-ARCH-1.)

### Architecture

- **AC-ARCH-4:** The review_cycle terminal payload carries all id-bearing finding entries (open, rejected, spec_bug, fixed and verified prior ids) under one new top-level key that a pre-change writer does not accept, and none of the legacy descriptor keys appear on it; fed to the 06049e4 writer, that writer refuses the key by name and recomputes no id from a descriptor missing location or claim, and the outcome after that is governed by AC-OPS-4.
- **AC-ARCH-6:** Removal: the open_finding_ids round trip is gone: ledger-append.mjs's CLI result no longer emits it, the writeLedger response schema and return value in review-cycle.js, plan-cycle.js and tdd-task.js no longer declare or return it, the three copies stay byte-identical, grep -rn open_finding_ids workflows/ returns nothing, and review-cycle.js builds result.open_findings from its own in-script ids. (Merges AC-SIMP-6.)
- **AC-ARCH-8:** Each rule in the fixed-findings guard has exactly one implementation site: the check that a supplied prior id equals the id recomputed from that entry's own lens, location and claim, with its drop counter, runs in review-cycle.js before the payload is built and the payload carries only verified prior ids and the counter; set reconciliation (membership against prior ids, exclusion of ids given another disposition this round, duplicate drop and their counters) runs only in ledger-append.mjs on ids alone; no rule or counter is computed in both files.
- **AC-ARCH-9:** The finding id is hashed in review-cycle.js from the original, unresolved lens label, so compound-labelled ids stay equal to the pre-change writer's, while the label emitted on the payload is the resolved one required by AC-SEC-4; findings truncation (MAX_FINDINGS and the byte rescue) remains solely in ledger-append.mjs and is not reimplemented in review-cycle.js.
- **AC-ARCH-10:** Removal: no comment or doc still claims the workflow cannot compute finding ids: the review-cycle.js comments saying finding-id hashing happens in ledger-append.mjs or that this file never computes a finding id, and the matching test headers in review-cycle.test.js and ledger-append.test.js, are rewritten, and grep for 'never computes a finding id' and 'no node:crypto to compute finding ids' under workflows/ and test/ returns nothing.
- **AC-ARCH-11:** Removal: skills/conduct-plan/SKILL.md step 3 no longer says review-cycle's open_findings is null when the ledger write failed or when an older ledger-append.mjs did not return ids; the only null cases it still names are a run that produced no findings data, such as a BLOCKED run, and an older installed review-cycle.js that returns none, with the tick-log anomaly line for the latter kept; review-cycle.js meta.whenToUse describes prior ids as computed by this workflow, not by the ledger writer; grep for the old sentences returns nothing. (Merges AC-PROD-5, AC-OPS-10.)

### Operability

- **AC-OPS-4:** The generic refused-key retry, byte-identical in all three workflow files, never strips the AC-ARCH-4 findings key: if an installed writer refuses that key, the terminal write ends write_ok false, result.ledger_write_failed is true and the TELEMETRY NOT RECORDED log line appears, never a successful row with no findings; tested with a stub writer and with the 06049e4 writer.
- **AC-OPS-6:** When the prior-id guard or the fixed-claim matching drops entries, review-cycle emits one log line with each count and its reason, such as invalid_prior_ids_dropped=2, the same way invalid_ac_ids_dropped is logged today; a test asserts the line appears when a count is above zero and is absent when all are zero.
- **AC-OPS-9:** Removal: the existing ledger write-failure step in skills/conduct-plan/SKILL.md tells the conductor, when review-cycle returns ledger_write_failed true, to record 'review ledger not written: <ledger_write_error>' in the tick log and not to write a replacement review_cycle row by hand; grep finds that sentence inside the existing step and finds no instruction to build a review_cycle row from returned telemetry.
- **AC-OPS-11:** README.md's Run ledger section names each new failure signal from AC-DATA-6 and AC-OPS-4 with its exact write_error or log text and pairs each with its remedy: run bin/install.sh and its --check, then restart the session or dispatch by scriptPath, because named workflows are cached per session.
- **AC-OPS-12:** Rollback is shown to work: a ledger with rows written by the new version is read by optimise-read.mjs from 06049e4 with no error and the same rework counts as rows written by the old version for the same fixture, and a .claude/conductor-prior-findings.json written after the change is accepted by the pre-change review-cycle id guard with invalid_prior_ids_dropped equal to 0.

### Vetoed at planning

| Item | Raised by | Decision | Reason |
|---|---|---|---|
| AC-OPS-13 (sha256 and id helper as one byte-identical block in all three workflow files) | lens-operability | Vetoed by lens-simplicity | Not traceable to any criterion: only review-cycle produces findings, so the copies in plan-cycle.js and tdd-task.js would be dead code held in place by a pin. Contradicts AC-SIMP-3. Operability is not in the top three of the precedence order. |
| Writer dual path accepting and hashing both descriptors and precomputed ids (the "keeps being accepted" branch of AC-OPS-3) | lens-operability | Vetoed by lens-simplicity | Keeps findingId and free-text descriptors alive in the writer, which is what this spec removes. The legacy shape is instead a counted, named drop (AC-DATA-6b), which satisfies the data-loss concern without hashing. |
| AC-ARCH-4's clause that the refused-key retry drops the new key and the row still lands | lens-architecture | Dropped by precedence (data loss over architecture) | That outcome is a write_ok true row with no findings, the silent loss AC-DATA-6a and AC-OPS-4 exist to prevent. The rest of AC-ARCH-4 survives. |
| AC-ARCH-9's original clauses that lens-label resolution and severity and ac_id sanitising stay solely in the writer and that the original label travels with each id | lens-architecture | Dropped by precedence (security over architecture) | The original label is lens-authored free text; AC-SEC-4 and AC-SEC-1 require it resolved or nulled in the script. AC-ARCH-9 is rewritten to keep the parts that survive: hash from the original label, truncation stays in the writer. |
| AC-DATA-7 (result.open_findings null on a failed write; only ids present on the written line returned) | lens-data | Superseded by AC-PROD-1 (with AC-OPS-5, AC-ARCH-7) on precedence | Its harm is join integrity, not irrecoverable data loss, so operability outranks it. Accepted consequence: a later 'fixed' entry may join to no 'open' row on disk when an earlier terminal write was lost or the writer truncated the open entry. Recorded for the human to confirm or reverse. |
| *_raw sibling fields (lens_raw, ac_id_raw, severity_raw, verdict_raw) on new review_cycle rows | lens-security vs lens-data | Resolved for security (AC-SEC-4); flagged for the human | Security above the data line here because losing a 32-byte raw label is not irrecoverable data loss of a finding. AC-DATA-2 equivalence excludes these fields. If the owner holds raw-label recoverability as load-bearing, this is a security-versus-data tie and is the human's call. |
| ledger_row_backfilled conduct_plan_event (lens-product finding, optional route) | lens-product | Not adopted | Lens-product's own AC-PROD-3 took the cheaper plan-log tally route (merged into AC-QA-13); no criterion requires the event. |

---

## Vetoes and trade-offs

See "Vetoed at planning" above for the lens vetoes and precedence drops.
Two items there are the owner's call and are open:

| Item | Raised by | Decision | Rationale |
|---|---|---|---|
| Return finding ids even when the review's ledger write fails (AC-PROD-1 over AC-DATA-7) | product, operability vs data | escalated: owner to confirm | Keeps the fix loop's "fixed" tracking alive through a lost write; cost is a "fixed" row that may join to no "open" row on disk. |
| Drop the `*_raw` label fields from new review rows (AC-SEC-4) | security vs data | escalated: owner to confirm | Keeps lens-authored text out of the ledger; cost is losing the original text of a malformed lens label or AC id. |

## Spec gaps found at review

## Tasks
- [ ] T1: in-script sha256 and finding ids in review-cycle.js; payload carries ids only; writer drops findingId and accepts ids only; open_finding_ids round trip removed; mixed-version failures named (all AC-SEC, AC-QA-1 to 12 and 14, AC-SIMP, AC-PROD-1, AC-DATA, AC-ARCH, AC-OPS-4/6/12) — state: queued
- [ ] T2: conduct-plan SKILL.md and README.md: no hand-written replacement rows, new failure signals and remedies, null cases rewritten (AC-OPS-9, AC-OPS-11, AC-ARCH-11) — state: queued (needs: T1)
- [ ] T3: live acceptance after install and a session restart: twenty writes tallied, zero stopped or FAIL (AC-QA-13) — state: queued (needs: T1, T2)
## Conductor log
