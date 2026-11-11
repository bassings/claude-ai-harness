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
#   Group 4 -- the unattended `claude -p` invocation had no permission
#   constraint at all. --disallowedTools below denies the destructive and
#   outward-facing operations the read-only optimiser never needs;
#   --permission-mode plan was considered and rejected, since plan mode
#   would prevent the optimiser writing the very report this script's
#   verdict depends on. Verified empirically end to end against a throwaway
#   repo (not a delivery repo) with both flags applied: a well-formed report
#   was still produced, exit 0, and no file outside .claude/optimise-cycle-
#   report.md was created or modified.
#   Group 5 -- the run should be read-only w.r.t. the repo it analyses.
#   Measured: the conductor plan-guard Stop hook (installed globally, not
#   by this script) touched .claude/active-plan on both real repos during
#   the 2026-08-16 run. This group used to switch every hook off to stop
#   that; T11 (specs/harn-audit-1.md) reversed it, because the same switch
#   also removed the destructive-command guard and the snapshot hook from
#   an unattended session. Hooks now stay on; see the invocation below.
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
# SUBTRACTION ROUND (T3 review round 2, circuit-breaker escalated and
# ruled -- specs/harn-opt-2.md conductor log ticks 46-48): review round 2
# proved two of round 1's own guards cannot fail in the way they claimed to,
# which is worse than no guard -- both are REMOVED here rather than patched
# a third time:
#   - The per-run verdict nonce (former Group 3) is GONE. It was meant to
#     stop the model forging this script's own RESULT lines, but the header
#     carrying `run=$NONCE` was written to a fixed, world-readable log path
#     BEFORE `claude -p` ran, so a forger only had to `grep` its own log for
#     the genuine nonce and echo it back -- proven live. A hardcoded guessed
#     nonce also shipped the suite green, so the guard was not load-bearing
#     against a guesser either. No replacement guard: the real containment
#     for a compromised/malicious model reply is that verdict_repo below
#     never trusts the model's stdout at all (D1), which the nonce was never
#     actually adding to.
#   - The `<repo>/.claude/` postcondition walk (former part of Group 5) is
#     GONE. It was defeated by back-dating a written file's mtime with
#     `touch`, missed any write outside `.claude/` entirely (a stub writing
#     `.git/hooks/post-checkout` passed clean), and missed every deletion
#     (no forward mtime to see). Measured against a real delivery repo whose
#     `.claude/` held 50,120 orphaned-worktree files (778 MB): the per-file
#     walk cost ~94s and its reason-string join was QUADRATIC, extrapolating
#     to ~44 minutes and a ~3.6 MB single log line -- it would have wedged
#     this job long after `claude` returned, for a check that a `touch -d`
#     already defeated.
#
# Round-2 fixes to what SURVIVED review round 2 (same conductor log ticks):
#   - `--disallowedTools` is KEPT: it genuinely blocks its literal targets
#     (proven by real `claude -p` runs), which is real defence in depth.
#     What was false was the CLAIM that a denylist bounds the job: under
#     that flag set alone a real run against a throwaway repo showed
#     `Write`, `Edit`, `mv` and `python3 -c` all succeed. T11 adds the
#     allowlist below, so a tool that is not listed is refused rather than
#     reachable -- test/static-checks.test.js pins the deny tokens.
#   - The background-wait ceiling detector no longer greps for the bare
#     `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS` variable NAME, which false-
#     positived on any transcript merely mentioning it (this repo's own
#     README now does). It anchors to the CLI's real message and captures
#     the observed wait into the FAIL reason.
#   - The ceiling is lowered from 1,800,000ms to 1,200,000ms (20 minutes):
#     now that hitting it produces a self-diagnosing FAIL naming the cause,
#     binding low costs one lost weekly report while binding high costs up
#     to 31 minutes of unattended execution producing nothing. 1200s is
#     2.3x the worst measured real run (515s).
#   - A FAIL now prints one line to stderr before exiting, so the plist's
#     already-wired StandardErrorPath channel (0 bytes since 11 Aug) turns
#     non-empty exactly when there is something to see.
#   - The default repo list no longer hardcodes this operator's private
#     repo names and volume layout in a public repo. It is read from
#     $HOME/.claude/optimise-weekly-repos (one path per line, never tracked
#     anywhere), promoting the existing test-seam env var to real operator
#     configuration.
#   - The internal start_epoch validity check inside verdict_repo (former
#     Group 8) is gone: it duplicated the caller's own check below, which
#     already `continue`s past a repo before verdict_repo is ever called
#     for it, so the internal branch could never fire.
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

# Drift marker: bumped whenever this script's behaviour changes materially.
# Printed on the run's own header line (below) so the log shows which copy
# of the script actually ran -- the installed mirror at ~/.claude/bin/ can
# otherwise drift silently out of sync with this repo (the same class
# AC-OPS-4 already covers for workflows/).
# HIGH-2 (round-one review): bumped from 2026-08-17.2, which was still the
# stamped value after this script grew ~140 lines for the staleness check
# itself (HARN-FIX-3 T2) -- an installed runner missing that whole feature
# was indistinguishable in the log from one that had it. Bump this whenever
# this script's behaviour changes materially; test/static-checks.test.js
# pins that it has moved past the pre-staleness-check value.
SCRIPT_VERSION="2026-11-12.1"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REDACT_SCRIPT="$SCRIPT_DIR/redact-transcript.mjs"

LOG="${OPTIMISE_WEEKLY_LOG:-$HOME/.claude/logs/optimise-cycle-weekly.log}"
REPORT_REL=".claude/optimise-cycle-report.md"

# Subtraction round: the real budget is stated explicitly and lowered to
# 1200s (20 minutes) -- 2.3x the worst measured real run (515s,
# 2026-08-16), now that a ceiling hit produces a self-diagnosing FAIL
# naming the cause instead of an unexplained stale/missing report. The
# outer `timeout` is aligned to it (ceiling + a 60s grace period for
# claude's own shutdown), with -k 60 forcing a hard kill if it ignores the
# polite one.
CEILING_MS=1200000
export CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS="$CEILING_MS"
CEILING_S=$(( CEILING_MS / 1000 ))
TIMEOUT_S=$(( CEILING_S + 60 ))

# Trims leading/trailing whitespace from $1 and appends it to the REPOS
# array unless the trimmed result is empty. Shared by both REPOS sources
# below so a blank line means the same thing in either one.
add_repo_line() {
  local line="$1" trimmed
  trimmed="${line#"${line%%[![:space:]]*}"}"
  trimmed="${trimmed%"${trimmed##*[![:space:]]}"}"
  [ -n "$trimmed" ] && REPOS+=("$trimmed")
}

REPOS=()
if [ -n "${OPTIMISE_WEEKLY_REPOS:-}" ]; then
  while IFS= read -r line; do
    add_repo_line "$line"
  done <<< "$OPTIMISE_WEEKLY_REPOS"
else
  # Subtraction round: the delivery repo list is operator configuration,
  # never this public repo's own hardcoded content. One path per line,
  # blank lines ignored. This file is never tracked anywhere -- it lives
  # purely under the operator's own $HOME.
  REPOS_CONFIG="$HOME/.claude/optimise-weekly-repos"
  if [ -f "$REPOS_CONFIG" ]; then
    while IFS= read -r line; do
      add_repo_line "$line"
    done < "$REPOS_CONFIG"
  fi
fi

mkdir -p "$(dirname "$LOG")"

# T11: where this run's temporary files go. $TMPDIR is per-user on macOS and
# is what launchd supplies; without it the harness's own directory is used,
# never a fixed name in a shared /tmp.
CLAUDE_HOME="${CLAUDE_HOME:-$HOME/.claude}"
WORK_DIR="${TMPDIR:-$CLAUDE_HOME}"
mkdir -p "$WORK_DIR"
LAST_RESULT="$HOME/.claude/logs/optimise-cycle-weekly.last-result"

# Everything this run creates that must not outlive it. Each variable is empty
# until the run creates the thing it names, and cleanup_run deletes only what
# is named, so with every variable empty it deletes nothing.
TRANSCRIPT_FILE=""
STAGED_WORKFLOW=""      # the staged copy of optimise-cycle.js
STAGED_MARKER=""        # byte copy of what was staged, left so a SIGKILL leftover is recognisable
STAGED_SOURCE=""        # what the staged copy must still equal for it to be deleted
STAGED_WORKFLOW_DIR=""  # set only when this run created .claude/workflows
STALE_TMPDIR=""
CLAUDE_PID=""

# The one cleanup function: the exit trap, the signal handlers and the end of
# every repo's iteration all come through here, and it holds every rm in this
# script. The staged copy goes only if it is still byte-identical to its
# source, so a file the repo ships, or one replaced during the run, is kept.
cleanup_run() {
  if [ -n "$TRANSCRIPT_FILE" ]; then
    rm -f "$TRANSCRIPT_FILE"
  fi
  if [ -n "$STALE_TMPDIR" ]; then
    rm -rf "$STALE_TMPDIR"
  fi
  if [ -n "$STAGED_WORKFLOW" ] && [ -f "$STAGED_WORKFLOW" ] && cmp -s "$STAGED_WORKFLOW" "$STAGED_SOURCE"; then
    rm -f "$STAGED_WORKFLOW"
  fi
  if [ -n "$STAGED_MARKER" ]; then
    rm -f "$STAGED_MARKER"
  fi
  if [ -n "$STAGED_WORKFLOW_DIR" ]; then
    rmdir "$STAGED_WORKFLOW_DIR" 2>/dev/null
  fi
  TRANSCRIPT_FILE=""
  STALE_TMPDIR=""
  STAGED_WORKFLOW=""
  STAGED_MARKER=""
  STAGED_SOURCE=""
  STAGED_WORKFLOW_DIR=""
  return 0
}

# A trapped signal is only acted on once a foreground child returns, so
# claude runs in the background and is waited on; this stops it and exits,
# and the EXIT trap then runs the cleanup.
on_signal() {
  if [ -n "$CLAUDE_PID" ]; then
    kill "$CLAUDE_PID" 2>/dev/null
    wait "$CLAUDE_PID" 2>/dev/null
  fi
  exit "$1"
}
trap cleanup_run EXIT
trap 'on_signal 143' TERM
trap 'on_signal 130' INT

# The tools the unattended optimiser may use, and nothing else (the run passes
# --permission-mode dontAsk). Writes are scoped to the one report file. Bash is
# limited to read-only git and gh queries, the node helpers the workflow
# invokes, and the plain read-only commands around them.
ALLOWED_TOOLS=(
  "Skill" "Workflow" "Agent" "Read" "Grep" "Glob"
  "Write($REPORT_REL)" "Edit($REPORT_REL)"
  "Bash(git log:*)" "Bash(git status:*)" "Bash(git rev-parse:*)" "Bash(git remote:*)"
  "Bash(git show:*)" "Bash(git diff:*)" "Bash(git ls-files:*)" "Bash(git check-ignore:*)"
  "Bash(gh run list:*)" "Bash(gh run view:*)" "Bash(gh repo view:*)"
  "Bash(node:*)" "Bash(openssl rand:*)"
  "Bash(ls:*)" "Bash(cat:*)" "Bash(head:*)" "Bash(wc:*)" "Bash(date:*)"
)

# What the run reports about its own outcome. note_fail is the only place a
# failure is recorded, so the exit status, the notification and the
# last-result file cannot disagree. Labels and reasons are flattened to one
# line: a repo label is a directory name and may hold anything.
overall_fail=0
PASS_LABELS=""
FAIL_LABELS=""
FAIL_DETAIL=""
FIRST_FAIL_REASON=""
VERDICT_FIRST=""
VERDICT_ALL=""
note_fail() {
  local label="${1//[$'\n\r']/ }" first="${2//[$'\n\r']/ }" all="${3:-$2}"
  all="${all//[$'\n\r']/ }"
  overall_fail=1
  FAIL_LABELS="${FAIL_LABELS:+$FAIL_LABELS, }$label"
  FAIL_DETAIL="${FAIL_DETAIL:+$FAIL_DETAIL | }$label: $all"
  if [ -z "$FIRST_FAIL_REASON" ]; then
    FIRST_FAIL_REASON="$first"
  fi
}

# One line, overwritten each run: UTC timestamp, verdict, labels, reasons.
write_last_result() {
  mkdir -p "$(dirname "$LAST_RESULT")"
  printf '%s %s labels="%s" reasons="%s"\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "$2" "$3" > "$LAST_RESULT"
}

# Raises one operating-system notification for the whole run. The text goes to
# osascript as an argument to the script's run handler, never spliced into the
# AppleScript source, because a repo label is a directory name and a quote in
# it would otherwise end the string. It names repo labels and the first reason
# only, never a path or any transcript text. A notifier that fails is logged
# and never changes the run's own result.
notify_fail() {
  local rc
  timeout 30 osascript \
    -e 'on run argv' \
    -e 'display notification (item 1 of argv) with title (item 2 of argv)' \
    -e 'end run' \
    "$FAIL_LABELS: $FIRST_FAIL_REASON" "Weekly optimise-cycle FAILED" >/dev/null 2>&1
  rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "NOTIFY-FAILED $rc" >> "$LOG"
  fi
}

# Per-repo verdict, decided entirely from the report artefact, claude's exit
# code, and this script's own observations of the repo -- never from what
# claude said. Echoes one RESULT line and returns 0 for PASS, 1 for FAIL.
verdict_repo() {
  local repo="$1"
  local repo_label="$2"
  local claude_exit="$3"
  local start_epoch="$4"
  local ceiling_hit="$5"
  local ceiling_message="$6"
  local report_path="$repo/$REPORT_REL"
  local reasons=()
  local mtime first_line

  if [ "$claude_exit" -ne 0 ]; then
    reasons+=("claude exited $claude_exit")
  fi

  # Subtraction round: anchored to the CLI's own message (captured below,
  # at the call site) rather than a bare grep for the ceiling variable's
  # NAME, which false-positived on any transcript merely mentioning it --
  # this repo's own README does. The captured message states the observed
  # wait in seconds, which also reveals whether the configured ceiling was
  # actually honoured.
  if [ "$ceiling_hit" = "1" ]; then
    reasons+=("background wait ceiling reached before completion ($ceiling_message)")
  fi

  if [ ! -f "$report_path" ]; then
    reasons+=("report file missing at $REPORT_REL")
  else
    # GNU first, then BSD, and VALIDATE rather than trusting exit status.
    #
    # The previous form was `stat -f %m ... || stat -c %Y ...`, which is
    # macOS-correct and silently wrong on Linux: GNU stat's -f means "file
    # system status", not "format", so it SUCCEEDS and prints a block of
    # filesystem information. Exit 0 meant the `||` fallback never ran and
    # `[ "$mtime" -lt ... ]` then failed with "integer expression expected",
    # printing that block to stderr on every clean pass. Found by this repo's
    # first ever CI run, on both node versions; it had never been executed
    # anywhere but macOS.
    #
    # A fallback chained on exit status cannot protect against a command that
    # succeeds with the wrong output, so the result is checked for shape.
    mtime=$(stat -c %Y "$report_path" 2>/dev/null || true)
    case "$mtime" in
      ''|*[!0-9]*) mtime=$(stat -f %m "$report_path" 2>/dev/null || true) ;;
    esac
    case "$mtime" in
      ''|*[!0-9]*) mtime="" ;;
    esac
    if [ -z "$mtime" ]; then
      reasons+=("could not read the report file's mtime")
    elif [ "$mtime" -lt "$start_epoch" ]; then
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

  if [ ${#reasons[@]} -eq 0 ]; then
    echo "RESULT PASS $repo_label report=$REPORT_REL mtime=$mtime"
    return 0
  fi

  local joined="" r
  for r in "${reasons[@]}"; do
    if [ -z "$joined" ]; then joined="$r"; else joined="$joined; $r"; fi
  done
  VERDICT_FIRST="${reasons[0]}"
  VERDICT_ALL="$joined"
  echo "RESULT FAIL $repo_label reason=\"$joined\""
  return 1
}

# ---- AC-OPS-1..5: consumer-install staleness check -
# specs/harn-fix-3.md, task 2 of 2. Warn-only, per the spec's own mechanism
# table: a stale install is not necessarily broken, so this section never
# sets overall_fail and never blocks the REPOS loop below. Distinct from,
# and independent of, workflows/lib/install-consistency.mjs's OWN preflight
# inside plan-cycle.js/review-cycle.js (AC-QA-1/2), which refuses on an
# INTERNALLY inconsistent install regardless of what published main says.
#
# CLAUDE_HOME is the SAME override install-consistency.mjs's own
# resolveInstallDir() reads (see that file's header comment) -- one
# variable, one meaning, shared by both mechanisms.
LIB_SCRIPT="$SCRIPT_DIR/../workflows/lib/install-consistency.mjs"

echo "=== $(date -u +%Y-%m-%dT%H:%M:%SZ) weekly optimise-cycle starting version=$SCRIPT_VERSION ===" >> "$LOG"

log_staleness() {
  echo "STALENESS $1 $2" >> "$LOG"
}

# AC-OPS-2/AC-OPS-3 (spec risk table: "a cache clone accumulates on a
# volume twice at 99% full"): a fresh --depth 1 clone into its OWN
# mktemp -d directory every run, removed unconditionally on exit via the
# trap below -- never a persistent cache refreshed in place. Chosen over a
# bare-mirror-refreshed-in-place or a shallow-clone-refreshed-via-fetch
# design specifically because of that risk: nothing here ever survives
# past this one run, so there is nothing to accumulate and no cache-
# staleness of its own to track, and two overlapping runs (each gets a
# unique mktemp name from the OS) can never collide or corrupt a shared
# clone. The cost -- a fresh shallow clone every run -- is negligible
# against this repo's size at this script's weekly cadence, and this
# clone is the ONLY thing this section ever writes to: $CLAUDE_HOME itself
# is read-only throughout (AC-OPS-2), proven by test/weekly-runner.test.js
# hashing every file under a fixture install before and after a run that
# reports drift.
# OPTIMISE_WEEKLY_STALENESS_REMOTE is a test seam, exactly like
# OPTIMISE_WEEKLY_REPOS/OPTIMISE_WEEKLY_LOG above -- never operator-facing
# configuration. Unset, it defaults to this repo's real published home.
STALENESS_REMOTE="${OPTIMISE_WEEKLY_STALENESS_REMOTE:-https://github.com/bassings/claude-ai-harness}"

# AC-OPS-1: this whole section runs EXACTLY ONCE per invocation of this
# script, here, before the REPOS loop below -- $CLAUDE_HOME is the
# harness's own consumer install, which has nothing to do with which (or
# how many) delivery repos REPOS holds, so it must never run once per repo.
if [ ! -f "$LIB_SCRIPT" ]; then
  log_staleness could-not-check '{"error":"install-consistency.mjs not found"}'
elif ! command -v node >/dev/null 2>&1; then
  log_staleness could-not-check '{"error":"node not found on PATH"}'
elif ! command -v git >/dev/null 2>&1; then
  log_staleness could-not-check '{"error":"git not found on PATH"}'
else
  STALE_TMPDIR=$(mktemp -d "$WORK_DIR/optimise-weekly-staleness.XXXXXX")
  if git clone --depth 1 --quiet "$STALENESS_REMOTE" "$STALE_TMPDIR/src" >/dev/null 2>&1; then
    result_json=$(node "$LIB_SCRIPT" --check-staleness "$STALE_TMPDIR/src" "$CLAUDE_HOME" 2>/dev/null)
    node_status=$?
    if [ "$node_status" -eq 0 ] && [ -n "$result_json" ]; then
      # LOW-2 (round-one review): this used to be TWO independent JSON
      # decoders in this file -- a glob-substring `case` guessing "ok" vs
      # "drift" from the RAW field shapes, plus a whole second `node -e`
      # subprocess re-parsing the same blob just to count two array
      # lengths. Both are gone: install-consistency.mjs's checkStaleness()
      # now computes the three-way verdict itself (`status`) and the two
      # counts (`drifted_count`, `missing_count`) it already has in hand,
      # so this file's ONLY job is to read three already-decided scalar
      # fields out of one line of JSON, with ONE extraction style (grep),
      # never re-deciding what they mean. That also closes MED-8's
      # follow-through: `status` is "could-not-check" whenever
      # unmatched_patterns is non-empty (a subset pattern matched zero
      # published files -- the module's own call, not bash's), so an
      # install with a blind spot is never reported "ok" here just because
      # bash never learned to ask.
      status=$(printf '%s' "$result_json" | grep -oE '"status":"[a-z-]+"' | head -n1 | sed -E 's/.*"([a-z-]+)"$/\1/')
      case "$status" in
        ok) log_staleness ok "$result_json" ;;
        drift)
          log_staleness drift "$result_json"
          # Drift recorded but invisible was the exact defect: the spec's
          # own risk table names "The drift report is noisy and gets
          # ignored, becoming decoration" -- invisible is worse. One line to
          # stderr, mirroring the existing FAIL-summary line at the bottom
          # of this script (same StandardErrorPath channel), naming the log
          # path and a COUNT, never the file list -- the log line just
          # written already carries that. Never sets overall_fail: this is
          # about visibility, not about failing the run (AC-OPS-3's warn-
          # only mechanism is deliberate and unchanged).
          drifted_count=$(printf '%s' "$result_json" | grep -oE '"drifted_count":[0-9]+' | grep -oE '[0-9]+')
          missing_count=$(printf '%s' "$result_json" | grep -oE '"missing_count":[0-9]+' | grep -oE '[0-9]+')
          [ -z "$drifted_count" ] && drifted_count="?"
          [ -z "$missing_count" ] && missing_count="?"
          echo "weekly optimise-cycle: consumer install drift ($drifted_count drifted, $missing_count missing) -- see $LOG" >&2
          ;;
        # could-not-check, an unrecognised/absent status (a shape this
        # runner does not know), or anything else -- fail closed to
        # could-not-check, never silently "ok".
        *) log_staleness could-not-check "$result_json" ;;
      esac
    else
      # AC-OPS-3: a git failure (clone succeeded but the comparison itself
      # failed for some other reason) never fails the weekly run.
      log_staleness could-not-check '{"error":"install-consistency.mjs --check-staleness failed"}'
    fi
  else
    # AC-OPS-3: no network, an unreachable remote, or any other git clone
    # failure all land here -- this section never touches overall_fail, so
    # a staleness check that could not run never fails the weekly run.
    log_staleness could-not-check '{"error":"git clone of the staleness remote failed"}'
  fi
  cleanup_run
fi
# ---- end AC-OPS-1..5 staleness check ---------------------------------

# T11: an empty repo list used to end the run with exit 0 and no RESULT line,
# which reads as "nothing to do" when the real state is "nothing is being
# checked". It is a FAIL, so it is logged, notified and non-zero like any other.
if [ ${#REPOS[@]} -eq 0 ]; then
  echo 'RESULT FAIL - reason="no repos configured"' >> "$LOG"
  note_fail "-" "no repos configured"
fi

# Group 8: bash 3.2's `set -u` treats "${REPOS[@]}" on a genuinely empty
# array as an unbound-variable error; the ${arr[@]+"${arr[@]}"} idiom below
# expands to nothing (not an error) when REPOS is empty.
for repo in "${REPOS[@]+"${REPOS[@]}"}"; do
  repo_label="$(basename "$repo")"

  # Group 2: a configured path that no longer exists is a configuration
  # FAIL, not a silent skip -- distinct from a path that exists and is
  # deliberately not a repo (SKIP, below).
  if [ ! -e "$repo" ]; then
    echo "RESULT FAIL $repo_label reason=\"configured repo path does not exist\"" >> "$LOG"
    note_fail "$repo_label" "configured repo path does not exist"
    continue
  fi

  # Group 2: `git -C rev-parse --git-dir` resolves a linked worktree (whose
  # own .git is a FILE, not a directory) the same as an ordinary checkout,
  # so a worktree is processed normally rather than skipped.
  if ! git -C "$repo" rev-parse --git-dir >/dev/null 2>&1; then
    echo "SKIP $repo_label (not a git repo)" >> "$LOG"
    continue
  fi

  echo "--- $repo_label ---" >> "$LOG"
  if ! cd "$repo"; then
    echo "RESULT FAIL $repo_label reason=\"cd into repo failed\"" >> "$LOG"
    note_fail "$repo_label" "cd into repo failed"
    continue
  fi

  # Stage the workflow script into the repo, so the run does not have to.
  #
  # The Workflow tool resolves a workflow by NAME from the repo's own
  # .claude/workflows/, never from the global $CLAUDE_HOME/workflows/ where a
  # manual install puts it. Observed every week from 2026-08-30 to 2026-09-14
  # across all three repos: each run improvised a copy into the repo under an
  # invented name, then could not remove it, because `rm` is in this script's
  # own disallowedTools list and deliberately stays there. The result was
  # three weeks of untracked leftovers and a "delete this when convenient"
  # note in a log nobody reads.
  #
  # Cleanup belongs here, in the runner, which has permission, rather than in
  # the agent, which does not and should not.
  #
  # Two things this must never do: overwrite a repo that deliberately ships
  # its own tuned copy (repo-local wins on name collision, per the harness
  # contract), or delete a file it did not create. Both are pinned by tests.
  global_workflow="$CLAUDE_HOME/workflows/optimise-cycle.js"
  repo_workflow="$repo/.claude/workflows/optimise-cycle.js"
  staged_marker="$repo/.claude/workflows/.optimise-cycle.js.staged"

  # T11: a SIGKILL cannot be trapped, so a run killed that way leaves its
  # staged copy behind. Staging therefore also leaves a marker: a byte copy of
  # what was staged. A copy that still matches its marker is our own
  # leftover, and is deleted here, by the one cleanup function, before this
  # run stages afresh. A file with no marker, or one that no longer matches
  # it, is the repo's own and is never touched.
  if [ -e "$staged_marker" ]; then
    STAGED_MARKER="$staged_marker"
    STAGED_WORKFLOW="$repo_workflow"
    STAGED_SOURCE="$staged_marker"
    STAGED_WORKFLOW_DIR="$repo/.claude/workflows"
    if [ -f "$repo_workflow" ] && cmp -s "$repo_workflow" "$staged_marker"; then
      echo "REMOVED-LEFTOVER-STAGED $repo_label" >> "$LOG"
    fi
    cleanup_run
  fi

  if [ -e "$repo_workflow" ]; then
    echo "repo ships its own optimise-cycle.js; leaving it alone" >> "$LOG"
  elif [ ! -f "$global_workflow" ]; then
    # A plugin install has no global mirror and still resolves the skill.
    # Staging is an aid, not a precondition, so this is a note, not a failure.
    echo "no global optimise-cycle.js to stage ($global_workflow)" >> "$LOG"
  else
    # The state is recorded BEFORE anything is created, so a signal between
    # two of the steps below still reaches the cleanup with the full picture.
    STAGED_SOURCE="$global_workflow"
    STAGED_MARKER="$staged_marker"
    STAGED_WORKFLOW="$repo_workflow"
    if [ ! -d "$repo/.claude/workflows" ]; then
      STAGED_WORKFLOW_DIR="$repo/.claude/workflows"
    fi
    if mkdir -p "$repo/.claude/workflows" && cp "$global_workflow" "$staged_marker" && cp "$global_workflow" "$repo_workflow"; then
      echo "staged .claude/workflows/optimise-cycle.js from $global_workflow" >> "$LOG"
    else
      cleanup_run
      echo "could not stage optimise-cycle.js; the run may copy one itself" >> "$LOG"
    fi
  fi

  start_epoch=$(date +%s)
  if ! [[ "$start_epoch" =~ ^[0-9]+$ ]]; then
    echo "RESULT FAIL $repo_label reason=\"could not capture a valid run start time (start_epoch)\"" >> "$LOG"
    note_fail "$repo_label" "could not capture a valid run start time (start_epoch)"
    cleanup_run
    continue
  fi

  # Headless, read-only run. The optimiser writes its own report file; we
  # capture the transcript as diagnostic context only -- verdict_repo above
  # is what actually decides PASS/FAIL.
  #
  # T11 -- the hooks stay ON. The destructive-command guard and the snapshot
  # hook are what stand between an unattended session and a destroyed
  # working tree, so nothing here switches them off. The permission model is
  # an explicit allowlist: --allowedTools names every tool the optimiser
  # needs, and --permission-mode dontAsk refuses everything else instead of
  # prompting (nobody is there to answer) or auto-approving it. Write and
  # Edit are scoped to the one report file. --disallowedTools stays as a
  # second, explicit refusal of the destructive and outward-facing commands
  # (a deny rule wins over an allow rule); --permission-mode plan was
  # considered and rejected, since plan mode would block the optimiser
  # writing the very report this script's verdict depends on.
  #
  # The plan-guard Stop hook can still rewrite .claude/active-plan in a repo
  # with a conducted plan open (the 2026-08-16 measurement above); that is
  # the cost of leaving the guard on, and docs/release-checklist.md records
  # the real-run check of it.
  TRANSCRIPT_FILE="$(mktemp "$WORK_DIR/optimise-weekly-transcript.XXXXXX")"
  timeout -k 60 "$TIMEOUT_S" claude -p "Run /optimise-cycle against this repo (arguments: {\"repos\": [\"$repo\"], \"window\": 90}). Do not apply any proposal; the optimiser is read-only. When it finishes, reply with only the report file path and the count of ranked proposals." \
    --allowedTools "${ALLOWED_TOOLS[@]}" \
    --permission-mode dontAsk \
    --disallowedTools "Bash(rm:*)" "Bash(sudo:*)" "Bash(git push:*)" "Bash(git commit:*)" "Bash(git reset:*)" "Bash(gh pr merge:*)" "Bash(gh pr create:*)" "Bash(gh issue create:*)" "Bash(gh release create:*)" "Bash(gh workflow run:*)" "Bash(curl:*)" "Bash(wget:*)" \
    > "$TRANSCRIPT_FILE" 2>&1 &
  # Backgrounded and waited on, so a SIGTERM or SIGINT to this script is
  # handled at once (on_signal) rather than after claude finishes.
  CLAUDE_PID=$!
  wait "$CLAUDE_PID"
  claude_exit=$?
  CLAUDE_PID=""

  # Subtraction round: anchored to the CLI's OWN message rather than a bare
  # grep for the ceiling variable's name (which false-positived on any
  # transcript merely mentioning it), and captures the observed wait so the
  # FAIL reason states what actually happened, not just that it happened.
  ceiling_hit=0
  ceiling_message=""
  if ceiling_message=$(grep -Eo 'Background tasks still running after [0-9]+s; terminating' "$TRANSCRIPT_FILE" 2>/dev/null | head -n1) && [ -n "$ceiling_message" ]; then
    ceiling_hit=1
  fi

  # Group 7: redact the model's free-text transcript before it lands in the
  # log -- it can and does echo the repo's absolute filesystem path back
  # (measured, 2026-08-16 log). If redaction itself fails for any reason,
  # never fall back to appending the raw transcript: log a labelled
  # placeholder instead, so a redaction failure is visible, not a silent
  # privacy leak. The relative script name is used in the placeholder, not
  # $REDACT_SCRIPT's absolute path, so the fallback message itself never
  # leaks the account path it exists to protect.
  if [ -f "$REDACT_SCRIPT" ] && node "$REDACT_SCRIPT" "$repo" < "$TRANSCRIPT_FILE" >> "$LOG" 2>/dev/null; then
    :
  else
    echo "[transcript omitted: redaction step failed or is unavailable -- see bin/redact-transcript.mjs]" >> "$LOG"
  fi
  cleanup_run

  echo "exit=$claude_exit $(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$LOG"

  if verdict_repo "$repo" "$repo_label" "$claude_exit" "$start_epoch" "$ceiling_hit" "$ceiling_message" >> "$LOG"; then
    PASS_LABELS="${PASS_LABELS:+$PASS_LABELS, }$repo_label"
  else
    note_fail "$repo_label" "$VERDICT_FIRST" "$VERDICT_ALL"
  fi
done
echo "=== done $(date -u +%Y-%m-%dT%H:%M:%SZ) ===" >> "$LOG"

# T11: the outcome outlives the log. The last-result file holds one line and
# is overwritten by the next run, and a FAIL raises an operating-system
# notification, so a broken weekly run is seen without anyone tailing the log.
if [ "$overall_fail" -ne 0 ]; then
  write_last_result FAIL "$FAIL_LABELS" "$FAIL_DETAIL"
  notify_fail
else
  write_last_result PASS "$PASS_LABELS" ""
fi

# One line on stderr when anything failed, so the plist's already-wired
# StandardErrorPath channel (0 bytes since 11 Aug) turns non-empty exactly
# when there is something an operator needs to see, without them having to
# tail the log speculatively every week.
if [ "$overall_fail" -ne 0 ]; then
  echo "weekly optimise-cycle FAILED -- see $LOG" >&2
fi

exit "$overall_fail"
