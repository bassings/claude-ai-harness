# Replacement for the "fix loop" table in the operator's CLAUDE.md section 2

You apply this by hand. The file it changes, `~/.claude/CLAUDE.md`, lives
outside this repository, so no task here can edit it; copy the text below over
the existing "The fix loop is bounded, and it escalates" table and the sentence
that follows it. Rows 1 to 3 are unchanged. The two rows after them (the fresh
implementer on a more capable model, and the adjudication at five) are replaced
by a single escalation round, matching what `skills/conduct-plan/SKILL.md` now
does.

---

| Round | What changes |
|---|---|
| 1 to 3 | Resume the **same** implementer. It holds the context; re-explaining costs more than it buys. |
| After 3 | One **escalation round**: a **fresh** implementer on a stronger tier, dispatched through `/tdd-task` with its `model` argument (never a direct implementer dispatch), on its own branch or worktree with the PR tip unmoved until its review is clean, followed by one full review round with the security lens included; the branch and worktree are disposed of once merged or abandoned. The default `sonnet` escalates to `opus`, and the default `opus` escalates to `fable`. If the default is already the strongest tier, the round is skipped and the note says "escalation skipped: no stronger tier"; a token the runtime refuses is a failed dispatch and the note names the token. |
| After the escalation round | Stop fixing. **Adjudicate** each open finding: which are load-bearing, which are parked with a recorded reason. A clean escalation round merges as usual; one whose own build or review is not clean goes straight to the block note. There is never a second escalation round on one task. |

The trigger matters. The escalation round runs on the three-fix-rounds trigger
only, and there is never a second escalation round on one task. The first time a review round finds a defect the previous round's fix
introduced, the conductor goes straight to the block note with the frame
question and no escalation round, because that trigger exists for a value call
the owner must make. Rounds count per task, not per branch.
