# claude-ai-harness

A multi-lens planning and review harness for Claude Code. `README.md` is the
product documentation and `AGENT-HARNESS.md` is the contract the cycles follow;
this file holds only the rules for working in this repository.

## Commands

| What | Command |
|---|---|
| Full gate (what the pre-push hook and CI run) | `node --test test/*.test.js` and `python3 -m unittest discover -s hooks -p 'test_*.py'` |
| Install the pre-push hook | `bin/setup-hooks.sh` |
| Install the harness into `~/.claude` | `bin/install.sh`, then `bin/install.sh --check` |

## Hard rules

### Every decision put to the owner comes with options

Whenever work needs a decision from the owner, present it as labelled options,
never as an open question. This applies to a conversational reply, a
conductor block note, a push notification and a PR comment alike.

Each decision carries:

1. One plain-language sentence saying what is being decided and why it cannot
   proceed without the owner.
2. Two to four labelled options (A, B, C), each with what it costs and what it
   risks. "Do nothing" or "merge as is" is listed when it is a real choice.
3. A recommendation, named as one of the options, with the reason.
4. The short reply that answers it, for example `1B 2A`, when more than one
   decision is waiting.

If only one course is defensible, say so and state it as the option being
taken, with the alternative that was ruled out and why. Do not invent filler
options to satisfy the count.

A status question from the owner ("are you waiting?", "what do you need?") is
answered with the same list of open decisions and their options, not with a
description of the state alone.

## Key locations

- `specs/`: plans and specs; a conducted plan keeps its own task list and log.
- `workflows/`, `agents/`, `skills/`, `hooks/`: what `bin/install.sh` ships.
- `test/`: the Node suite; Python tests sit beside the hooks in `hooks/`.
- `docs/`: mutation proofs and measurements.
