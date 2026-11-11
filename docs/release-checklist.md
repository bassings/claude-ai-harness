# Release checklist: real-runtime smoke record

The test suite runs the workflow scripts against a stand-in runtime
(`test/helpers/fake-runtime.js`). This file records what the **real** Claude
Code workflow runtime does, measured by running it, so the stand-in can be held
to the record rather than to memory. Every entry carries its date, the Claude
Code version and the run id. An entry with no run behind it says so.

Re-run the probes and update this file before a release, and whenever a
workflow script's `run()` is restructured (HARN-AUDIT-1 T16 to T18).

## Environment of the recorded run

| Item | Value |
|---|---|
| Date | 2026-11-12 |
| Claude Code | 2.1.322 |
| Model | claude-fable-5-2 (session model; probe agents used `haiku`) |
| OS | macOS 27.2.1 |
| Node | v26.13.0 |
| Python | 3.15.2 |
| git | 2.54.0 |
| Install route | `bin/install.sh` into `~/.claude`; `bin/install.sh --check` matched the checkout |

Installed workflow files (sha256), each byte-identical to `workflows/` at `main` `efe14b5`:

| File | sha256 |
|---|---|
| `~/.claude/workflows/plan-cycle.js` | `227fbfa929e3453c64b0acbf8278dd0075508f8162dad1919d2504f565fbc6c4` |
| `~/.claude/workflows/review-cycle.js` | `f87dfc1c334a3c1d9dd050d478e79e9945bfa2046244ec862b00e8743dbc7633` |
| `~/.claude/workflows/tdd-task.js` | `10b11ff5eb793e51da7bab8635e14f891fbc46bab8ea81a548cf43f69d909eb8` |
| `~/.claude/workflows/optimise-cycle.js` | `1a95e7f9cb94ec5da83a2de050450fbec4ec3a9531cc71e340845e4fc8b5462b` |

## 1. What a workflow script can see

Measured by two probe scripts passed inline to the Workflow tool (runs
`wf_808eaf52-8b2` and `wf_e103d2fd-dc2`). The second used no agents and no
`eval`, and read each name with a literal `typeof`.

### Own property names of `globalThis`, complete

```
AggregateError Array ArrayBuffer AsyncDisposableStack BigInt BigInt64Array
BigUint64Array Boolean DataView Date DisposableStack Error EvalError
Float16Array Float32Array Float64Array Function Infinity Int16Array Int32Array
Int8Array Intl Iterator JSON Map Math NaN Number Object Promise Proxy
RangeError ReferenceError Reflect RegExp Set String SuppressedError Symbol
SyntaxError Temporal TypeError URIError Uint16Array Uint32Array Uint8Array
Uint8ClampedArray WeakMap WeakSet __wRg$resolve agent args budget clearTimeout
console decodeURI decodeURIComponent encodeURI encodeURIComponent escape eval
globalThis isFinite isNaN log parallel parseFloat parseInt phase pipeline
setTimeout then undefined unescape workflow
```

`__wRg$resolve` and `then` are runtime internals, not an interface. The name
of the first looks generated and may differ between versions.

### `typeof` for the names the stand-in must agree on

| Name | `typeof` |
|---|---|
| `agent`, `parallel`, `pipeline`, `phase`, `log`, `workflow` | `function` |
| `budget` | `object` (`total` is `null` with no token target; `spent` and `remaining` are functions) |
| `args` | `undefined` when the Workflow call passes no `args` |
| `console` | `object`, with exactly `debug`, `error`, `info`, `log`, `warn` |
| `setTimeout`, `clearTimeout` | `function` (`setTimeout` returns a number, and its callback fires) |
| `Intl`, `Temporal` | `object` |
| `setInterval`, `setImmediate`, `queueMicrotask` | `undefined` |
| `fetch`, `Buffer`, `structuredClone`, `process`, `globalThis.process`, `require` | `undefined` |
| `TextEncoder`, `TextDecoder`, `URL`, `AbortController`, `crypto`, `performance` | `undefined` |
| `module`, `exports`, `__dirname`, `__filename`, `navigator` | `undefined` |
| `WebAssembly`, `WeakRef`, `Atomics`, `SharedArrayBuffer` | `undefined` |

Two results differ from what AC-QA-4 of `specs/harn-audit-1.md` assumed:
`setTimeout` **is** present in the real runtime, and `workflow` is a global
the criterion's allowlist does not name. T2's allowlist follows this record.

### Behaviour of the restricted features

| Probe | Result |
|---|---|
| Reading an undeclared name as code | `ReferenceError: <name> is not defined` |
| `globalThis['Buf' + 'fer']` | `undefined` (no error) |
| `eval(...)`, direct or indirect | `EvalError: Code generation from strings disallowed for this context` |
| `Function` constructor, including `(function () {}).constructor('...')` | the same `EvalError` |
| Current time, reached by a computed property name at run time | `Error: Date.now() / new Date() are unavailable in workflow scripts (breaks resume). Stamp results after the workflow returns, or pass timestamps via args.` |
| `new Date(0).toISOString()` | works: `1970-01-01T00:00:00.000Z` |
| Random number, reached by a computed property name at run time | `Error: Math.random() is unavailable in workflow scripts (breaks resume). For N independent samples, include the index in the agent label or prompt.` |
| A script whose **text** contains a current-time or random call | refused before it runs: `Workflow scripts must be deterministic: Date.now()/Math.random()/new Date() are unavailable (breaks resume)...` |

The last two rows are separate mechanisms: a textual check when the script is
submitted, and a throwing stub at run time. The textual check also fires on
those calls inside a string literal passed to a probe, which is how it was
found.

Not measured: a static `import` declaration and a dynamic `import()`. The
only attempt went through `eval` and was stopped by the `EvalError` before
reaching the import, so it says nothing about imports.

## 2. What `agent()` does when things go wrong

Run `wf_808eaf52-8b2`. Each case was a single `agent()` call wrapped in
`try`/`catch`; the table records whether it returned or threw.

| Case | Outcome |
|---|---|
| Valid schema, compliant agent (control) | returns the validated object |
| No schema | returns the agent's final text as a string |
| **Unknown `agentType`**, with or without a schema | **throws** `Error`: `agent({agentType}): agent type '<name>' not found. Available agents: ...` followed by the full list of registered agent types |
| **Agent never produces schema-valid output** (told to send a forbidden value every time) | **throws** `Error`: `agent({schema}): subagent completed without calling StructuredOutput (after in-conversation nudge)` |
| Agent told in its prompt not to call the output tool at all | returned a schema-valid object anyway: the runtime's instruction to produce structured output won over the prompt |
| Schema whose root is not an object | **throws** `TelemetrySafeError` before the agent starts: `agent({schema}) received an unusable JSON Schema ... the root schema must declare type: 'object' ...` |
| Schema whose `required` names a property missing from `properties` | **accepted**: the agent returned an object containing the undeclared property |
| **Unknown `model` token** | **returns `null`**, no throw. The run's failure list carries `There's an issue with the selected model (<token>). It may not exist or you may not have access to it.`, but the script itself sees only `null` |

What this means for the workflow scripts:

- A missing lens agent is loud. `agent()` throws, so a `parallel()` thunk
  resolves to `null` and a `pipeline()` item drops to `null`. A script that
  filters nulls and carries on reports a run in which the lens never looked.
  T8 and T10 must treat a `null` from an always-on lens as a refusal.
- A mistyped model token is quiet. It is a `null` with no exception, the same
  shape as a skipped agent. `tdd-task`'s `model` argument must be checked for
  a `null` result rather than relying on a throw.
- The runtime does not reject a schema whose `required` list is wider than
  its `properties`, so the scripts' own schemas need a test for that.

## 3. One real run of each workflow

The workflows act on the repository the session was started in. Only
`optimise-cycle` takes a repository path as an argument. A run "against a
scratch repo" therefore needs a Claude Code session started inside that
scratch repository, which the session that wrote this record could not do
for itself.

| Workflow | Real-runtime run by `scriptPath` | Result | Against a scratch repo |
|---|---|---|---|
| `plan-cycle.js` | 2026-11-11, `wf_bdca0d8e-962`, on `specs/harn-audit-1.md` in this repository | completed: seven lenses, 118 acceptance criteria written, both ledger rows landed | **not yet run** |
| `review-cycle.js` | 2026-11-11 and 2026-11-12, `wf_6036490c-ca6`, `wf_705f656e-8f6`, `wf_028b929c-54b`, on PR #26 in this repository | completed each time: 4, 4 and 3 lenses, a synthesised report, `open_findings` with ids, ledger rows written. Every lens reported its worktree at `main`, not the reviewed tip, and worked from a `git archive` extract | **not yet run** |
| `tdd-task.js` | **not run** | none. It writes tests, code and a commit, so it must not be pointed at this repository for a smoke run | **not yet run** |
| `optimise-cycle.js` | **not run** | none | **not yet run** |

## 4. Install routes

| Route | Verified by installing | Record |
|---|---|---|
| `bin/install.sh` over an existing `~/.claude` | yes, 2026-11-11, Claude Code 2.1.322 | `bin/install.sh --check` reports the install consistent with the checkout; the four workflow files hash as above |
| `bin/install.sh` into an empty home (first install) | **no** | the audit found the first install refused (`bin/install.sh:187-195`); T14 owns the fix, and this row is filled when T14 lands |
| Plugin install (`/claude-ai-harness:plan-cycle` resolving, `workflows/` discovered) | **no** | not attempted |

Under AC-PROD-3 the README may present only the routes marked "yes" here as
verified.

## 5. Still to record

- One run of each workflow by `scriptPath` from a session started in a scratch
  repository (section 3), including `/plan-cycle` against a copy of the
  starter spec (AC-PROD-4, after T14).
- One headless run under the weekly runner's exact flags in a scratch
  repository with the hooks installed (AC-SEC-9, T11).
- A static `import` and a dynamic `import()` in a workflow script (section 1).
- The plugin and first-install routes (section 4).
