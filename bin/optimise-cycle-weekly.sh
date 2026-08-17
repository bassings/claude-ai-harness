#!/usr/bin/env bash
# Weekly delivery-optimiser run (HARN-OPT-2 T3).
#
# Runs /optimise-cycle against the delivery repos and leaves a report per
# repo at <repo>/.claude/optimise-cycle-report.md (gitignored by the
# optimiser itself). Read-only: the optimiser never applies a change, and
# neither does this script. See skills/optimise-cycle/.
#
# D1 fix: PASS/FAIL is decided per repo from facts this script observes for
# itself -- the report file exists, its mtime is at or after this run's own
# start time (so a leftover report from a previous week reads as FAIL, not
# as a silent pass), and it is non-empty and structurally plausible as a
# report -- never from what claude's reply says. The model's reply is still
# appended to the log as diagnostic context, but it is not consulted by
# verdict_repo below.
#
# D2 fix: this script now lives in version control (bin/) instead of only
# at ~/.claude/bin/, and is covered by test/weekly-runner.test.js. Keep
# ~/.claude/bin/optimise-cycle-weekly.sh AND ~/.claude/bin/redact-transcript.mjs
# synced from this file -- see README.md's "Weekly optimiser run" section
# for the exact sync step.
#
# Round-2 fixes (T3 review round 1, three lenses, all reproduced by the
# conductor -- specs/harn-opt-2.md conductor log ticks 40-43):
#   Group 2 -- a vanished repo path and a linked git worktree used to hit
#   the same "not a git repo" branch. `git -C "$repo" rev-parse --git-dir`
#   distinguishes them: a missing path is a configuration FAIL, a worktree
#   (whose .git is a FILE) is processed normally, and only a path that
#   exists and genuinely isn't a repo is SKIPped.
#   Group 3 -- the model's own stdout and this script's verdict lines used
#   to share one file and one format, so a stub/model printing its own
#   "RESULT PASS ..." landed indistinguishable from a real verdict. Every
#   line this script itself writes now carries a per-run nonce (NONCE,
#   below) that is never passed into the model's prompt, so a forged line
#   can never carry it.
#   Group 4 -- the unattended `claude -p` invocation had no permission
#   constraint at all. --disallowedTools below denies the destructive and
#   outward-facing operations the read-only optimiser never needs;
#   --permission-mode plan was considered and rejected, since plan mode
#   would prevent the optimiser writing the very report this script's
#   verdict depends on. Verified empirically end to end against a throwaway
#   repo (not a delivery repo) with both flags applied: a well-formed report
#   was still produced, exit 0, and no file outside .claude/optimise-cycle-
#   report.md was created or modified.
#   Group 5 -- the run must be read-only w.r.t. the repo it analyses.
#   Measured: the conductor plan-guard Stop hook (installed globally, not
#   by this script) touched .claude/active-plan on both real repos during
#   the 2026-08-16 run. --settings '{"disableAllHooks": true}' stops the
#   hook firing for this invocation (verified empirically: active-plan's
#   mtime was unchanged after a real run against a repo with the identical
#   hook wired and an open-task plan active). verdict_repo also asserts
#   this as a postcondition, independent of whether the flag holds: nothing
#   under $repo/.claude/ other than the report itself may have a newer
#   mtime than this run's own start.
#   Group 6 -- the optimiser runs as a BACKGROUND workflow inside
#   `claude -p`, so the real governing budget is
#   CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS (~600s unstated default), not the
#   outer `timeout` (previously 3600s, wildly looser than the real budget).
#   Both are now set explicitly and aligned, and a run that hits the
#   ceiling is named as the cause rather than only read as a stale/missing
#   report.
#   Group 7 -- the transcript is redacted (bin/redact-transcript.mjs, reusing
#   workflows/lib/ledger-append.mjs's redactPaths) before it reaches the
#   log, and every repo reference this script itself writes uses the repo's
#   basename rather than its absolute path, matching the account-name/path
#   leak the ledger and report already refuse (AC-SEC-3 in
#   specs/optimise-cycle.md).
#   Group 8 -- small fail-open fixes: an invalid start_epoch now FAILS
#   rather than silently skipping the staleness check; an empty REPOS array
#   no longer crashes bash 3.2's `set -u`; a whitespace-only
#   OPTIMISE_WEEKLY_REPOS line is trimmed away rather than becoming a bogus
#   repo path; a leading UTF-8 BOM on an otherwise well-formed report no
#   longer reads as "no heading".
#
# Two environment variables exist ONLY as a test seam, read by
# test/weekly-runner.test.js, and are never operator-facing configuration:
# OPTIMISE_WEEKLY_REPOS (newline-separated repo list) and
# OPTIMISE_WEEKLY_LOG (log file path). Unset, both default to the real
# weekly configuration below.
set -u

# launchd's environment PATH is minimal (typically /usr/bin:/bin:/usr/sbin:
# /sbin) and has no Homebrew prefix, so append the directories that hold
# claude/timeout/git/node rather than prepending them: appending lets a
# caller's own PATH (a test harness's stub directory, for instance) win,
# while still guaranteeing these tools resolve under launchd's sparse
# default.
export PATH="$PATH:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REDACT_SCRIPT="$SCRIPT_DIR/redact-transcript.mjs"

LOG="${OPTIMISE_WEEKLY_LOG:-$HOME/.claude/logs/optimise-cycle-weekly.log}"
REPORT_REL=".claude/optimise-cycle-report.md"

# Group 6: state the real budget explicitly rather than inheriting whatever
# the CLI's own unstated default happens to be (measured: SaidOfYou used
# 85.8% of that unstated ~600s default on 2026-08-16; the 11 Aug run
# actually hit it). 30 minutes gives real headroom over both measured real
# runs (515s, 311s). The outer `timeout` is aligned to it (ceiling + a 60s
# grace period for claude's own shutdown), with -k 60 forcing a hard kill
# if it ignores the polite one.
CEILING_MS=1800000
export CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS="$CEILING_MS"
CEILING_S=$(( CEILING_MS / 1000 ))
TIMEOUT_S=$(( CEILING_S + 60 ))

# Group 3: a per-run nonce, generated here and NEVER embedded in the claude
# prompt below, so a verdict line this script itself writes is
# distinguishable from anything the model's own stdout could print into the
# same log (the transcript and the verdicts share one file). The pattern
# mirrors optimise-cycle.js's own per-run <UNTRUSTED-DATA-<nonce>> nonce.
nonce_source() {
  od -An -N8 -tx1 /dev/urandom 2>/dev/null | tr -d ' \n'
}
NONCE="$(nonce_source)"
if [ -z "$NONCE" ]; then
  NONCE="fallback${RANDOM}${RANDOM}$$"
fi

REPOS=()
if [ -n "${OPTIMISE_WEEKLY_REPOS:-}" ]; then
  while IFS= read -r line; do
    # Group 8: trim surrounding whitespace before deciding whether a line
    # names a real repo -- a whitespace-only line must never become a
    # "repo" path consisting only of spaces.
    trimmed="${line#"${line%%[![:space:]]*}"}"
    trimmed="${trimmed%"${trimmed##*[![:space:]]}"}"
    [ -n "$trimmed" ] && REPOS+=("$trimmed")
  done <<< "$OPTIMISE_WEEKLY_REPOS"
else
  REPOS=(
    /Volumes/Storage/home/scott.b/repos/SaidOfYou
    /Volumes/Storage/home/scott.b/repos/CouchPotatoServer
  )
fi

mkdir -p "$(dirname "$LOG")"

# Per-repo verdict, decided entirely from the report artefact, claude's exit
# code, and this script's own observations of the repo -- never from what
# claude said. Echoes one RESULT line (carrying $NONCE, Group 3) and
# returns 0 for PASS, 1 for FAIL.
verdict_repo() {
  local repo="$1"
  local repo_label="$2"
  local claude_exit="$3"
  local start_epoch="$4"
  local ceiling_hit="$5"
  local report_path="$repo/$REPORT_REL"
  local reasons=()
  local mtime first_line
  local start_epoch_valid=0
  [[ "$start_epoch" =~ ^[0-9]+$ ]] && start_epoch_valid=1

  # Group 8: a malformed start_epoch must never leave the staleness check
  # silently skipped -- `[ "$mtime" -lt "" ]` errors and reads as false in
  # an elif, i.e. fails OPEN. Refuse explicitly instead.
  if [ "$start_epoch_valid" -eq 0 ]; then
    reasons+=("invalid start_epoch \"$start_epoch\" -- the staleness check cannot run")
  fi

  if [ "$claude_exit" -ne 0 ]; then
    reasons+=("claude exited $claude_exit")
  fi

  # Group 6: name the real cause when the background-wait ceiling was hit,
  # rather than leaving an operator to infer it from a stale/missing report.
  if [ "$ceiling_hit" = "1" ]; then
    reasons+=("background wait ceiling reached before completion (CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS -- see transcript above)")
  fi

  if [ ! -f "$report_path" ]; then
    reasons+=("report file missing at $REPORT_REL")
  else
    mtime=$(stat -f %m "$report_path" 2>/dev/null || stat -c %Y "$report_path" 2>/dev/null || echo "")
    if [ -z "$mtime" ]; then
      reasons+=("could not read the report file's mtime")
    elif [ "$start_epoch_valid" -eq 1 ] && [ "$mtime" -lt "$start_epoch" ]; then
      reasons+=("stale report: mtime=$mtime predates this run's start=$start_epoch (not rewritten this run)")
    fi

    if [ ! -s "$report_path" ]; then
      reasons+=("report file is empty")
    else
      first_line=$(grep -m1 -v '^[[:space:]]*$' "$report_path" 2>/dev/null || true)
      # Group 8: strip a leading UTF-8 BOM before checking for a heading --
      # a BOM-prefixed "# Heading" is still a heading.
      first_line="${first_line#$'\xef\xbb\xbf'}"
      if [[ "$first_line" != '# '* ]]; then
        reasons+=("report does not start with a markdown heading")
      fi
      if ! grep -q '^## ' "$report_path"; then
        reasons+=("report has no section headings")
      fi
    fi
  fi

  # Group 5: the optimiser is read-only w.r.t. the repo it analyses; nothing
  # under $repo/.claude/ other than the report itself may have been touched
  # during this run (measured: the conductor plan-guard hook wrote
  # .claude/active-plan during two real runs, 2026-08-16).
  if [ "$start_epoch_valid" -eq 1 ] && [ -d "$repo/.claude" ]; then
    local stray=() f fmtime
    while IFS= read -r f; do
      [ "$f" = "$report_path" ] && continue
      fmtime=$(stat -f %m "$f" 2>/dev/null || stat -c %Y "$f" 2>/dev/null || echo "")
      if [ -n "$fmtime" ] && [ "$fmtime" -ge "$start_epoch" ]; then
        stray+=("${f#"$repo"/}")
      fi
    done < <(find "$repo/.claude" -type f 2>/dev/null)
    if [ ${#stray[@]} -gt 0 ]; then
      local joined_stray="" sf
      for sf in "${stray[@]}"; do
        if [ -z "$joined_stray" ]; then joined_stray="$sf"; else joined_stray="$joined_stray, $sf"; fi
      done
      reasons+=("repo mutated during this run under .claude/: $joined_stray")
    fi
  fi

  if [ ${#reasons[@]} -eq 0 ]; then
    echo "RESULT PASS run=$NONCE $repo_label report=$REPORT_REL mtime=$mtime"
    return 0
  fi

  local joined="" r
  for r in "${reasons[@]}"; do
    if [ -z "$joined" ]; then joined="$r"; else joined="$joined; $r"; fi
  done
  echo "RESULT FAIL run=$NONCE $repo_label reason=\"$joined\""
  return 1
}

echo "=== $(date -u +%Y-%m-%dT%H:%M:%SZ) weekly optimise-cycle starting run=$NONCE ===" >> "$LOG"
overall_fail=0
# Group 8: bash 3.2's `set -u` treats "${REPOS[@]}" on a genuinely empty
# array as an unbound-variable error; the ${arr[@]+"${arr[@]}"} idiom below
# expands to nothing (not an error) when REPOS is empty.
for repo in "${REPOS[@]+"${REPOS[@]}"}"; do
  repo_label="$(basename "$repo")"

  # Group 2: a configured path that no longer exists is a configuration
  # FAIL, not a silent skip -- distinct from a path that exists and is
  # deliberately not a repo (SKIP, below).
  if [ ! -e "$repo" ]; then
    echo "RESULT FAIL run=$NONCE $repo_label reason=\"configured repo path does not exist\"" >> "$LOG"
    overall_fail=1
    continue
  fi

  # Group 2: `git -C rev-parse --git-dir` resolves a linked worktree (whose
  # own .git is a FILE, not a directory) the same as an ordinary checkout,
  # so a worktree is processed normally rather than skipped.
  if ! git -C "$repo" rev-parse --git-dir >/dev/null 2>&1; then
    echo "SKIP $repo_label (not a git repo) run=$NONCE" >> "$LOG"
    continue
  fi

  echo "--- $repo_label ---" >> "$LOG"
  if ! cd "$repo"; then
    echo "RESULT FAIL run=$NONCE $repo_label reason=\"cd into repo failed\"" >> "$LOG"
    overall_fail=1
    continue
  fi

  start_epoch=$(date +%s)
  if ! [[ "$start_epoch" =~ ^[0-9]+$ ]]; then
    echo "RESULT FAIL run=$NONCE $repo_label reason=\"could not capture a valid run start time (start_epoch)\"" >> "$LOG"
    overall_fail=1
    continue
  fi

  # Headless, read-only run. The optimiser writes its own report file; we
  # capture the transcript as diagnostic context only -- verdict_repo above
  # is what actually decides PASS/FAIL.
  #
  # Group 4: --disallowedTools denies the destructive and outward-facing
  # operations this read-only job never needs (rm, sudo, git push/commit/
  # reset, gh pr/issue/release/workflow write commands, curl/wget --
  # verified empirically that a real run still produces a report with these
  # denied). --permission-mode plan was considered and rejected: it would
  # block the optimiser from writing the very report this script's verdict
  # depends on.
  #
  # Group 5: --settings disables all hooks for this one invocation, so the
  # globally-installed conductor plan-guard Stop hook cannot touch this
  # repo's .claude/active-plan as a side effect of the background workflow
  # this prompt launches (verified empirically). The postcondition check
  # inside verdict_repo above still runs regardless, in case a future hook
  # or plugin is not stoppable this way.
  transcript_file="$(mktemp "${TMPDIR:-/tmp}/optimise-weekly-transcript.XXXXXX")"
  timeout -k 60 "$TIMEOUT_S" claude -p "Run /optimise-cycle against this repo (arguments: {\"repos\": [\"$repo\"], \"window\": 90}). Do not apply any proposal; the optimiser is read-only. When it finishes, reply with only the report file path and the count of ranked proposals." \
    --disallowedTools "Bash(rm:*)" "Bash(sudo:*)" "Bash(git push:*)" "Bash(git commit:*)" "Bash(git reset:*)" "Bash(gh pr merge:*)" "Bash(gh pr create:*)" "Bash(gh issue create:*)" "Bash(gh release create:*)" "Bash(gh workflow run:*)" "Bash(curl:*)" "Bash(wget:*)" \
    --settings '{"disableAllHooks": true}' \
    > "$transcript_file" 2>&1
  claude_exit=$?

  ceiling_hit=0
  if grep -q "CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS" "$transcript_file" 2>/dev/null; then
    ceiling_hit=1
  fi

  # Group 7: redact the model's free-text transcript before it lands in the
  # log -- it can and does echo the repo's absolute filesystem path back
  # (measured, 2026-08-16 log). If redaction itself fails for any reason,
  # never fall back to appending the raw transcript: log a labelled
  # placeholder instead, so a redaction failure is visible, not a silent
  # privacy leak.
  if [ -f "$REDACT_SCRIPT" ] && node "$REDACT_SCRIPT" "$repo" < "$transcript_file" >> "$LOG" 2>/dev/null; then
    :
  else
    echo "[transcript omitted: redaction step failed or is unavailable -- see $REDACT_SCRIPT]" >> "$LOG"
  fi
  rm -f "$transcript_file"

  echo "exit=$claude_exit run=$NONCE $(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$LOG"

  if ! verdict_repo "$repo" "$repo_label" "$claude_exit" "$start_epoch" "$ceiling_hit" >> "$LOG"; then
    overall_fail=1
  fi
done
echo "=== done run=$NONCE $(date -u +%Y-%m-%dT%H:%M:%SZ) ===" >> "$LOG"

exit "$overall_fail"
