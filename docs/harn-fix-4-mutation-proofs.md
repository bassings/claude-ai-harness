# HARN-FIX-4: shipping `agents/implementer.md` -- mutation proofs

Scope: closing the defect where `workflows/tdd-task.js` and
`skills/conduct-plan/SKILL.md` dispatched/delegated to an `implementer`
agent that had never existed in this repo (`git log --all -- agents/implementer.md`
returned zero commits). Four pieces of work: (1) `agents/implementer.md`
itself, (2) legible abort messages in `workflows/tdd-task.js` when an
`agentType: 'implementer'` call returns no result, (3) a new static check
(`test/static-checks.test.js`, "HARN-FIX-4") pinning that every `agentType`
referenced in `workflows/` or `skills/` has a matching `agents/<name>.md`
definition, and (4) a decision, not an accident, that `agents/implementer.md`
is excluded from the install drift comparison in
`workflows/lib/install-consistency.mjs`.

Per standard §11: every mutation below was actually applied to the working
file (never "mentally mutated"), confirmed landed on the intended construct
by `diff` against a `cp` snapshot taken before the edit (never
`git checkout --`), run against the suite, the exact failing set recorded,
then restored from the snapshot and reconfirmed byte-identical and green
before the next mutation. Mutations were applied one at a time, never
stacked.

## 1. `workflows/tdd-task.js`'s abort messages (TDD RED/GREEN, not a mutation proof)

**Guarded by**: two new tests in `test/tdd-task.test.js` (`harn-fix-4`),
asserting the `ABORTED` reason names `agentType: 'implementer'`, names
`agents/implementer.md`, and states plainly that the workflow cannot check
the install from where it runs.

**RED**, against the pre-fix code (`reason: 'test-writer agent failed'` /
`reason: 'implementer agent failed'`):

```
AssertionError [ERR_ASSERTION]: must name the agentType that was dispatched
    actual: 'test-writer agent failed'
    expected: /agentType: 'implementer'/
...
AssertionError [ERR_ASSERTION]: must name the agentType that was dispatched
    actual: 'implementer agent failed'
    expected: /agentType: 'implementer'/
```

Both failed for the intended reason: the assertion named exactly what the
old string was missing, not a typo or a harness error.

**GREEN**, after adding `agentDispatchFailedReason(phaseLabel)` and wiring
both `ABORTED` returns to it: `node --test test/tdd-task.test.js` -- 34/34
passing, including the two new tests.

## 2. HARN-FIX-4 static check: every `agentType` has a matching `agents/*.md`

**Guarded by**: `test/static-checks.test.js`'s
`'static: HARN-FIX-4 -- every agentType referenced anywhere in workflows/ or
skills/ has a matching definition file in agents/...'` test, which extracts
three shapes of reference (a literal `agentType: 'name'`, every element of a
`const ALL = [...]` roster array, and every string passed to
`lenses.push(...)`) from `workflows/*.js` and `skills/**/*.md`, and diffs the
union against `agents/*.md`'s filenames.

### Mutation A -- delete `agents/implementer.md`

Snapshot taken first (`cp agents/implementer.md <scratch>/implementer.md`).

```
rm agents/implementer.md
```

**Result**: 1 failure, exactly the new test, naming the gap by name:

```
AssertionError [ERR_ASSERTION]: agentType(s) referenced in workflows/ or
skills/ with no matching agents/<name>.md definition: implementer
+ [ 'implementer' ]
- []
```

Restored via `cp <scratch>/implementer.md agents/implementer.md`; `diff`
against the snapshot confirmed clean; `node --test test/static-checks.test.js`
back to 49/49 green.

### Mutation B -- a literal reference to a nonexistent agent type

Snapshot taken first (`cp workflows/tdd-task.js <scratch>/tdd-task.js`).

Inserted, immediately after the Test-phase `ABORTED` return in
`workflows/tdd-task.js`:

```js
const __probe = { agentType: 'nonexistent-agent-xyz' }
```

**Result**: 1 failure, naming the injected value:

```
AssertionError [ERR_ASSERTION]: agentType(s) referenced in workflows/ or
skills/ with no matching agents/<name>.md definition: nonexistent-agent-xyz
```

Restored via `cp <scratch>/tdd-task.js workflows/tdd-task.js`; `diff`
confirmed clean; `node --test test/static-checks.test.js test/tdd-task.test.js`
back to 83/83 green.

### Mutation C -- a nonexistent lens name added to `review-cycle.js`'s `ALL` array

Snapshot taken first (`cp workflows/review-cycle.js <scratch>/review-cycle.js`).

```js
const ALL = ['lens-security', 'lens-qa', 'lens-design', 'lens-accessibility',
  'lens-data', 'lens-architecture', 'lens-operability', 'lens-product', 'lens-nonexistent-mutant']
```

**Result**: 1 failure, naming the injected value:

```
AssertionError [ERR_ASSERTION]: agentType(s) referenced in workflows/ or
skills/ with no matching agents/<name>.md definition: lens-nonexistent-mutant
```

Restored via `cp`; `diff` confirmed clean; `node --test
test/static-checks.test.js` back to 49/49 green. This mutation specifically
proves the `const ALL = [...]` extraction path, distinct from mutation B's
literal-string path.

## 3. The drift-exclusion decision: `agents/implementer.md` stays out of `CONSUMER_SUBSET_PATTERNS`/`CONSUMER_OPTIONAL_PATTERNS`

**Guarded by**: `test/install-consistency.test.js`'s exact-array pins for
`CONSUMER_SUBSET_PATTERNS` and `CONSUMER_OPTIONAL_PATTERNS`, its
`isConsumerSubsetPath('agents/implementer.md') === false` assertion, and
every downstream test that composes those (`listConsumerSubsetFiles`,
`checkStaleness`).

Snapshot taken first (`cp workflows/lib/install-consistency.mjs
<scratch>/install-consistency.mjs`).

**Mutation**: added `agents/implementer.md` to `CONSUMER_OPTIONAL_PATTERNS`:

```js
export const CONSUMER_OPTIONAL_PATTERNS = ['bin/optimise-cycle-weekly.sh',
  'bin/redact-transcript.mjs', 'hooks/hooks.json', 'agents/implementer.md']
```

**Result**: 6 failures in `test/install-consistency.test.js` --

```
✖ CONSUMER_OPTIONAL_PATTERNS (HIGH-2, L-4) is exported and names exactly ...
✖ isConsumerSubsetPath matches every pattern shape ... and rejects a
  user-owned or deliberately-excluded file
✖ listConsumerSubsetFiles walks a real tree and returns exactly the subset
  paths (required AND optional), sorted, excluding everything else
✖ MED-8 -- listConsumerSubsetFiles and isConsumerSubsetPath can never
  disagree (single authority, not two independent matchers)
✖ checkStaleness reports no drift when the install matches the published
  subset exactly, and status:"ok" (LOW-2)
✖ checkStaleness never reports a file the install has that is outside the
  consumer subset -- whether it is genuinely never shipped (CLAUDE.md) or
  shipped but deliberately excluded (agents/implementer.md, harn-fix-4)
```

Six independent tests fail, at four different layers (the exact-array pin,
the single-path matcher, the tree walker, and the end-to-end staleness
comparison) -- confirming the exclusion is enforced redundantly, not by one
fragile assertion.

Restored via `cp <scratch>/install-consistency.mjs
workflows/lib/install-consistency.mjs`; `diff` confirmed clean; `node --test
test/install-consistency.test.js` back to 61/61 green.

**Note on the fix during this round**: the first draft of the decision
comment above `CONSUMER_SUBSET_PATTERNS` spelled out the withdrawn
version-stamp mechanism's constant name in full, which tripped
`test/static-checks.test.js`'s pre-existing `AC-ARCH-4` guard (it bans that
exact string from reappearing in any shipped file, comments included). Caught
by running the full suite before treating this task as done, not by reading
the comment back -- fixed by describing the mechanism without naming its
constant, matching this same file's own existing convention for the
`CLAUDE_HOME`-relayed override name a few paragraphs above.

## Full-suite result after all restores

`node --test test/*.test.js`: 992/992 passing (989 baseline on `main` at
`cfe2a61`, plus 3 new tests: two in `test/tdd-task.test.js`, one in
`test/static-checks.test.js`). Run twice; both runs green, no flake observed.
