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
SCRIPT_VERSION="2026-11-12.2"

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
RUNNER_PARENT=""        # the runner-owned mode-700 directory that holds one run.XXXXXX directory per invocation
RUNNER_TMP=""           # THIS invocation's own directory: every per-run file lives in it, and nothing else does
SWEEP_PENDING=0         # set once at start-up: remove stale run directories left by killed runs
# A run directory older than this is a dead run's. It is 24 hours because one
# invocation lasts at most (configured repos) x (the 21-minute session timeout
# plus its grace), so a live sibling's directory is far younger than this.
STALE_RUN_MINUTES=1440
RUN_COMPLETE=0          # set only when the normal end is reached
SCRATCH_REPORT=""       # where the session writes its report (inside RUNNER_TMP); the runner moves it
SCRATCH_SIDECAR=""      # the same for the proposal-targets sidecar
MOVE_TMP=""             # a temp file beside the final path while a move is in flight
PLAN_MARKER=""          # <repo>/.claude/active-plan, while a run may have it rewritten
PLAN_SNAPSHOT=""        # its bytes from before the run
PLAN_HAD=0              # 1 if the marker existed before the run
PLAN_LABEL=""
SESSION_ID=""           # this run's --session-id, which the plan-guard hook writes into a marker it claims
OUTPUT_PROBLEM=""       # why a scratch output was rejected, for the verdict
EXIT_REASON=""          # why the run ended abnormally, when the runner knows

# The one cleanup function: the exit trap, the signal handlers and the end of
# every repo's iteration all come through here, and it holds every rm in this
# script. The staged copy goes only if it is still byte-identical to its
# source, so a file the repo ships, or one replaced during the run, is kept.
# Every invocation owns one directory of its own (RUNNER_TMP), so no file name
# is shared between runs, and the final call ("final", from the exit path)
# removes it once the outputs have been placed and the plan marker restored.
# The one-off start-up sweep removes only STALE per-run directories: a real
# directory (not a link, which find does not follow), named like the runner's
# own mktemp pattern, owned by this user, older than STALE_RUN_MINUTES, and
# never this run's. A sibling's fresh directory is therefore never touched.
cleanup_run() {
  if [ "$SWEEP_PENDING" = 1 ]; then
    SWEEP_PENDING=0
    while IFS= read -r stale; do
      if [ -n "$stale" ] && [ "$stale" != "$RUNNER_TMP" ]; then
        echo "REMOVED-STALE-RUN-DIR ${stale##*/}" >> "$LOG"
        rm -rf "$stale"
      fi
    done < <(find "$RUNNER_PARENT" -mindepth 1 -maxdepth 1 -type d -name 'run.??????' -user "$(id -u)" -mmin +"$STALE_RUN_MINUTES" 2>/dev/null)
  fi
  # The plan-guard Stop hook may re-claim a dormant plan for the headless
  # session and rewrite .claude/active-plan. The marker is put back only if it
  # now carries THIS run's session id, so a real conductor's concurrent change
  # is never clobbered; a marker that did not exist before, and now carries
  # this session's id, is removed.
  if [ -n "$PLAN_MARKER" ]; then
    if [ ! -L "$PLAN_MARKER" ] && [ -f "$PLAN_MARKER" ] && grep -qxF "conductor: $SESSION_ID" "$PLAN_MARKER" 2>/dev/null; then
      if [ "$PLAN_HAD" = 1 ]; then
        # Never truncate the live marker: the snapshot is copied to a temp file
        # beside it, compared, and renamed over it, so a missing snapshot or a
        # failed write leaves the marker as it was, and says so.
        restore_tmp="$(mktemp "${PLAN_MARKER%/*}/.optimise-active-plan.XXXXXX" 2>/dev/null)"
        if [ -r "$PLAN_SNAPSHOT" ] && [ -n "$restore_tmp" ] && cat "$PLAN_SNAPSHOT" > "$restore_tmp" && cmp -s "$PLAN_SNAPSHOT" "$restore_tmp" && mv -f "$restore_tmp" "$PLAN_MARKER"; then
          echo "RESTORED-ACTIVE-PLAN $PLAN_LABEL" >> "$LOG"
        else
          if [ -n "$restore_tmp" ]; then
            rm -f "$restore_tmp"
          fi
          echo "RESTORE-FAILED-ACTIVE-PLAN $PLAN_LABEL" >> "$LOG"
          note_fail "$PLAN_LABEL" "could not restore .claude/active-plan"
        fi
      else
        rm -f "$PLAN_MARKER"
        echo "RESTORED-ACTIVE-PLAN $PLAN_LABEL" >> "$LOG"
      fi
    fi
    rm -f "$PLAN_SNAPSHOT"
  fi
  if [ -n "$MOVE_TMP" ]; then
    rm -f "$MOVE_TMP"
  fi
  if [ -n "$SCRATCH_REPORT" ]; then
    rm -rf "$SCRATCH_REPORT"
  fi
  if [ -n "$SCRATCH_SIDECAR" ]; then
    rm -rf "$SCRATCH_SIDECAR"
  fi
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
  PLAN_MARKER=""
  PLAN_SNAPSHOT=""
  MOVE_TMP=""
  SCRATCH_REPORT=""
  SCRATCH_SIDECAR=""
  TRANSCRIPT_FILE=""
  STALE_TMPDIR=""
  STAGED_WORKFLOW=""
  STAGED_MARKER=""
  STAGED_SOURCE=""
  STAGED_WORKFLOW_DIR=""
  if [ "${1:-}" = final ] && [ -n "$RUNNER_PARENT" ] && [ "${RUNNER_TMP%/*}" = "$RUNNER_PARENT" ]; then
    case "${RUNNER_TMP##*/}" in
      run.??????) rm -rf "$RUNNER_TMP" ;;
    esac
    RUNNER_TMP=""
  fi
  return 0
}

# The tools the unattended optimiser may use, and nothing else (the run passes
# --permission-mode dontAsk). Every entry is here because workflows/
# optimise-cycle.js instructs it:
#   - Edit, on the two scratch files the session writes its report and
#     sidecar to, and nothing else (the entries are added once the runner
#     directory exists, below). Measured for real: in dontAsk mode every
#     write into .claude/ is refused whatever the rule, so the session never
#     writes there; the runner moves the files into place afterwards. There
#     is no Write entry, because the CLI matches only Edit rules to file
#     writes (Edit rules cover every file-editing tool).
#   - node: only the two helper scripts the workflow runs (optimise-read.mjs
#     and optimise-report-ignore.mjs), by absolute path under $CLAUDE_HOME. A
#     bare node entry would allow `node -e <anything>`, which is arbitrary
#     code with network and write access, so it is never listed. The
#     workflow also permits a repo-local copy when the repo is the harness
#     itself; that is deliberately NOT allowed here, since a repo's own
#     script is code the run did not install. A plugin-only install (no
#     $CLAUDE_HOME mirror) therefore FAILS loudly, and is notified.
#     optimise-read.mjs only reads files (it imports fs, path, crypto and url,
#     and never writes or spawns), so it reaches nothing Read cannot, and its
#     arguments stay free. optimise-report-ignore.mjs writes
#     <root>/.git/info/exclude and runs git with its cwd at <root>, so it is
#     allowed only with <root> naming the analysed repo (rooted_rules, below).
#   - git log and git rev-parse: the plain forms run in the analysed repo
#     (the session's cwd). The -C forms the git lane uses name the analysed
#     repo's own root, never a wildcard path, because git run in a directory
#     an attacker planted (a committed bare-repo layout) reads that
#     directory's config, which can name a program git executes. They are
#     spelled `git -C <root> log *`, because the CLI never matches a * mixed
#     with the trailing :* syntax. A wildcard after the subcommand also
#     approves inserted options, so -c, --output and --ext-diff are denied
#     (see the invocation). cat, head, ls, wc and date were dropped
#     because Read, Grep and Glob cover reading, and each of those commands
#     takes any path. status, show, diff, ls-files and check-ignore were
#     dropped as unused by the agent (the helper runs check-ignore itself);
#     remote was dropped because `git remote set-url` writes config.
#   - gh run list and gh run view, from the analysed repo's own directory.
#     gh repo view is not listed: the workflow never runs it, and with a
#     HOST/OWNER/REPO argument it sends a request to any host. -R, --repo and
#     --hostname, which do the same on any gh command, are denied (see the
#     invocation), as are the GH_HOST and GH_REPO environment prefixes.
#   - openssl rand -hex 16, exactly: the per-run containment nonce. Any other
#     openssl rand would allow `-out <file>`.
# What this list does NOT prevent, stated plainly: Read, Grep and Glob can
# read any file this user can read, so the boundary against exfiltration is
# that no allowed command can send data to a host of the session's choosing:
# WebFetch, curl and wget are refused, and gh may reach only the host the
# analysed repo's own remote names. That boundary rests on the deny entries
# below matching every spelling of -R, --repo and --hostname; a prefix rule
# cannot see inside the arguments, so the deny entries are best effort and
# not a guarantee. Shell chaining and command substitution inside an allowed
# command are judged by the CLI's own parser, not by this script. Agent and
# Workflow start further sessions whose permissions are the CLI's to
# inherit; this script has not verified how. The list was written from the
# workflow's text and has not been exercised by a real headless run in this
# repository's tests.
ALLOWED_TOOLS=(
  "Skill" "Workflow" "Agent" "Read" "Grep" "Glob"
  "Bash(git log:*)" "Bash(git rev-parse:*)"
  "Bash(gh run list:*)" "Bash(gh run view:*)"
  "Bash(node $CLAUDE_HOME/workflows/lib/optimise-read.mjs:*)"
  "Bash(openssl rand -hex 16)"
)
IGNORE_HELPERS=("$CLAUDE_HOME/workflows/lib/optimise-report-ignore.mjs")
# The workflow tells the agent the global mirror is ~/.claude/workflows/lib;
# when that is where CLAUDE_HOME points, the tilde spelling is allowed too.
if [ "$CLAUDE_HOME" = "$HOME/.claude" ]; then
  ALLOWED_TOOLS+=("Bash(node ~/.claude/workflows/lib/optimise-read.mjs:*)")
  IGNORE_HELPERS+=("~/.claude/workflows/lib/optimise-report-ignore.mjs")
fi

# The rules that name one analysed repo's own root, rebuilt for each repo into
# REPO_ALLOWED. The roots are the two the workflow resolves (the toplevel, and
# for a linked worktree the main checkout), each in its plain and its
# double-quoted spelling, since which one the CLI compares is not known here.
# A root that a rule cannot name exactly (anything but plain path characters)
# gets no rule at all, never a wildcard: that repo's git lane and report-ignore
# step are then refused, and the log says so.
REPO_ALLOWED=()
rooted_rules() {
  local repo="$1" label="$2" root helper accepted=0 skipped=0 seen=""
  REPO_ALLOWED=()
  for root in "$(git -C "$repo" rev-parse --show-toplevel 2>/dev/null)" \
    "$(dirname "$(git -C "$repo" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)")"; do
    if [ -z "$root" ] || [ "$root" = "." ] || [ "$root" = "$seen" ]; then
      continue
    fi
    seen="$root"
    if ! printf '%s' "$root" | grep -Eq '^/[A-Za-z0-9_/.-]+$'; then
      skipped=1
      continue
    fi
    accepted=1
    REPO_ALLOWED+=("Bash(git -C $root log *)" "Bash(git -C \"$root\" log *)" "Bash(git -C $root rev-parse *)" "Bash(git -C \"$root\" rev-parse *)")
    for helper in "${IGNORE_HELPERS[@]}"; do
      REPO_ALLOWED+=("Bash(node $helper $root *)" "Bash(node $helper \"$root\" *)")
    done
  done
  if [ "$accepted" = 1 ]; then
    # The spelling the workflow gives for the report root; it resolves in the
    # session's cwd, which is the analysed repo.
    for helper in "${IGNORE_HELPERS[@]}"; do
      REPO_ALLOWED+=("Bash(node $helper \"\$(git rev-parse --show-toplevel)\" *)")
    done
  fi
  if [ "$skipped" = 1 ]; then
    echo "NO-ROOTED-RULES $label (the repo path holds characters a permission rule cannot name)" >> "$LOG"
  fi
}

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

# Creates $2 as a copy of $1 only if nothing exists at $2: noclobber makes the
# redirection an exclusive create, so it fails rather than overwrite.
copy_new() {
  ( set -o noclobber; cat "$1" > "$2" ) 2>/dev/null
}

# One line, overwritten each run: UTC timestamp, verdict, labels, reasons.
write_last_result() {
  if ! { mkdir -p "$(dirname "$LAST_RESULT")" && printf '%s %s labels="%s" reasons="%s"\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "$2" "$3" > "$LAST_RESULT"; } 2>/dev/null; then
    echo "LAST-RESULT-WRITE-FAILED" >> "$LOG"
  fi
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

# A trapped signal is only acted on once a foreground child returns, so
# claude runs in the background and is waited on; this stops it and exits,
# and the EXIT trap (on_exit) then cleans up and reports the outcome.
on_signal() {
  EXIT_REASON="killed by signal $1"
  if [ -n "$CLAUDE_PID" ]; then
    kill "$CLAUDE_PID" 2>/dev/null
    wait "$CLAUDE_PID" 2>/dev/null
  fi
  exit "$2"
}

# Every way out of the script comes through here. The outcome defaults to
# FAIL: only a run that reached its normal end (RUN_COMPLETE) reports what its
# repos decided, so a signal, a `set -u` abort or any other early exit cannot
# leave the previous run's PASS standing. Order, per the T11 review ruling:
# cleanup first (the unredacted transcript is the privacy concern), then the
# fast file writes, and the notification, which can take up to 30 seconds,
# last.
on_exit() {
  local status=$?
  cleanup_run final
  if [ "$RUN_COMPLETE" -eq 0 ]; then
    local reason="${EXIT_REASON:-aborted before completion (exit status $status)}"
    echo "RESULT FAIL - reason=\"$reason\"" >> "$LOG"
    note_fail "-" "$reason"
    if [ "$status" -eq 0 ]; then
      status=1
    fi
  fi
  if [ "$overall_fail" -ne 0 ]; then
    write_last_result FAIL "$FAIL_LABELS" "$FAIL_DETAIL"
    # One line on stderr when anything failed, so the plist's already-wired
    # StandardErrorPath channel (0 bytes since 11 Aug) turns non-empty exactly
    # when there is something an operator needs to see.
    echo "weekly optimise-cycle FAILED -- see $LOG" >&2
    notify_fail
  else
    write_last_result PASS "$PASS_LABELS" ""
  fi
  exit "$status"
}
trap on_exit EXIT
trap 'on_signal 15 143' TERM
trap 'on_signal 2 130' INT

# The CLI spells an absolute path in a permission rule with a doubled leading
# slash (a single slash means relative to the project root), so the rule for
# /a/b is Edit(//a/b). Kept in one place so a real probe can change it once.
edit_rule() {
  printf 'Edit(/%s)' "$1"
}

# Moves a file the session wrote to a scratch path into the repo, after the
# session has ended. The session is not trusted: the file is accepted only if
# it is a regular file (not a symlink), non-empty and no larger than $3 bytes,
# and it lands through a fresh exclusive temp file beside the destination and a
# rename, which replaces a symlink at the destination instead of following it.
# A file that is simply absent is left for the verdict to report; one that is
# present and refused is recorded in OUTPUT_PROBLEM. $4 names it in the reason.
place_output() {
  local src="$1" dest="$2" cap="$3" what="$4" size destdir problem=""
  if [ ! -e "$src" ] && [ ! -L "$src" ]; then
    return 0
  fi
  if [ -L "$src" ]; then
    problem="$what rejected: the scratch file is a symlink"
  elif [ ! -f "$src" ]; then
    problem="$what rejected: the scratch path is not a regular file"
  else
    size=$(wc -c < "$src" | tr -d ' ')
    if [ "$size" -eq 0 ]; then
      problem="$what rejected: the scratch file is empty"
    elif [ "$size" -gt "$cap" ]; then
      problem="$what rejected: the scratch file is larger than $cap bytes"
    fi
  fi
  destdir="$(dirname "$dest")"
  if [ -z "$problem" ]; then
    if [ -L "$destdir" ] || [ -d "$dest" ]; then
      problem="$what rejected: the destination is a symlinked directory or a directory"
    elif ! mkdir -p "$destdir" 2>/dev/null; then
      problem="$what rejected: could not create the destination directory"
    fi
  fi
  if [ -z "$problem" ]; then
    MOVE_TMP="$(mktemp "$destdir/.optimise-output.XXXXXX" 2>/dev/null)"
    if [ -n "$MOVE_TMP" ] && cat "$src" > "$MOVE_TMP" && mv -f "$MOVE_TMP" "$dest"; then
      MOVE_TMP=""
      return 0
    fi
    problem="$what rejected: could not move it into place"
  fi
  OUTPUT_PROBLEM="${OUTPUT_PROBLEM:+$OUTPUT_PROBLEM; }$problem"
  return 1
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

  # 124 and 137 are what `timeout` itself exits with when it stops claude:
  # 124 after the polite signal, 137 after the -k grace period's hard kill.
  case "$claude_exit" in
    0) ;;
    124) reasons+=("timed out after ${TIMEOUT_S}s") ;;
    137) reasons+=("killed after timeout grace") ;;
    *) reasons+=("claude exited $claude_exit") ;;
  esac

  if [ -n "$OUTPUT_PROBLEM" ]; then
    reasons+=("$OUTPUT_PROBLEM")
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
      # Only the first 4 KiB is looked at: bash 3.2 pattern matching on a
      # multi-megabyte line is quadratic, and a report may be one.
      first_line=$(grep -m1 -v '^[[:space:]]*$' "$report_path" 2>/dev/null | head -c 4096)
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

# The outcome file says RUNNING from the first moment, so a run that dies
# without reporting (a SIGKILL, a full disk) leaves RUNNING, not last week's
# result.
write_last_result RUNNING "" ""

# T11: all of a run's temp files live in a directory of its own, made with
# mktemp -d inside one parent that only this runner writes to (mode 700). Two
# invocations, or an invocation and a test, therefore never share a file name.
# The parent is created first and only then checked -- not a link, owned by this
# user, and its physical path exactly the physical WORK_DIR plus the runner
# name -- and only then chmodded, so a link planted in the window is never
# followed. Anything else is refused rather than used.
RUNNER_PARENT="$WORK_DIR/optimise-weekly-runner"
WORK_REAL="$(cd -P "$WORK_DIR" 2>/dev/null && pwd -P)"
mkdir -p "$RUNNER_PARENT" 2>/dev/null
PARENT_REAL="$(cd -P "$RUNNER_PARENT" 2>/dev/null && pwd -P)"
if [ -L "$RUNNER_PARENT" ] || [ ! -d "$RUNNER_PARENT" ] || [ ! -O "$RUNNER_PARENT" ] || [ -z "$WORK_REAL" ] || [ "$PARENT_REAL" != "$WORK_REAL/optimise-weekly-runner" ]; then
  EXIT_REASON="runner temp directory is not a directory this user owns"
  exit 1
fi
chmod 700 "$RUNNER_PARENT"
RUNNER_TMP="$(mktemp -d "$RUNNER_PARENT/run.XXXXXX" 2>/dev/null)"
if [ -z "$RUNNER_TMP" ]; then
  EXIT_REASON="could not create this run's temp directory"
  exit 1
fi
SWEEP_PENDING=1
cleanup_run

# The session writes its report and sidecar here, and the optimiser takes the
# paths as arguments, so they must be plain absolute paths with no `.claude`
# segment. The physical path is used, so a symlinked TMPDIR (macOS /var) cannot
# make the permission rule and the path the session uses disagree.
RUNNER_REAL="$(cd -P "$RUNNER_TMP" 2>/dev/null && pwd -P)"
SCRATCH_REPORT_PATH="$RUNNER_REAL/report.md"
SCRATCH_SIDECAR_PATH="$RUNNER_REAL/proposal-targets.json"
if ! printf '%s' "$RUNNER_REAL" | grep -Eq '^/[A-Za-z0-9_/.-]+$' || printf '%s' "$RUNNER_REAL" | grep -Eq '(^|/)(\.claude|\.\.|\.)(/|$)'; then
  EXIT_REASON="runner temp directory path cannot be given to the optimiser (plain characters only, no .claude segment)"
  exit 1
fi
ALLOWED_TOOLS+=("$(edit_rule "$SCRATCH_REPORT_PATH")" "$(edit_rule "$SCRATCH_SIDECAR_PATH")")

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
  STALE_TMPDIR=$(mktemp -d "$RUNNER_TMP/optimise-weekly-staleness.XXXXXX")
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

# The runner passes report_path and proposal_targets_path, which an installed
# optimise-cycle.js older than this runner does not accept; every repo would
# then FAIL with "report file missing", which names the symptom and not the
# cause. Such a run stops here, before anything is staged or any session runs.
# A plugin-only install has no global copy and is not checked.
if [ -f "$CLAUDE_HOME/workflows/optimise-cycle.js" ] && ! grep -q 'report_path' "$CLAUDE_HOME/workflows/optimise-cycle.js"; then
  echo 'RESULT FAIL - reason="installed optimise-cycle.js predates report_path; run bin/install.sh"' >> "$LOG"
  note_fail "-" "installed optimise-cycle.js predates report_path; run bin/install.sh"
  REPOS=()
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

  # T11: nothing here may write through a symlink. A committer to an analysed
  # repo could otherwise point one of these paths at any file the operator can
  # write, and the run would create it. `[ -e ]` reports a dangling link as
  # absent, so the links are tested for directly, and a repo holding one is
  # refused outright rather than staged into.
  for linked in ".claude" ".claude/workflows" ".claude/workflows/.optimise-cycle.js.staged" ".claude/workflows/optimise-cycle.js"; do
    if [ -L "$repo/$linked" ]; then
      echo "RESULT FAIL $repo_label reason=\"refusing to stage: $linked is a symlink\"" >> "$LOG"
      note_fail "$repo_label" "refusing to stage: $linked is a symlink"
      continue 2
    fi
  done

  # T11: a SIGKILL cannot be trapped, so a run killed that way leaves its
  # staged copy behind. Staging therefore also leaves a marker: a byte copy of
  # what was staged. A copy that still matches its marker, and that git does
  # not track, is our own leftover, and is deleted here, by the one cleanup
  # function, before this run stages afresh. A file with no marker, one that no
  # longer matches it, or one the repo has committed is the repo's own and is
  # never touched.
  if [ -e "$staged_marker" ]; then
    STAGED_MARKER="$staged_marker"
    if ! git -C "$repo" ls-files --error-unmatch -- .claude/workflows/optimise-cycle.js >/dev/null 2>&1; then
      STAGED_WORKFLOW="$repo_workflow"
      STAGED_SOURCE="$staged_marker"
      STAGED_WORKFLOW_DIR="$repo/.claude/workflows"
      if [ -f "$repo_workflow" ] && cmp -s "$repo_workflow" "$staged_marker"; then
        echo "REMOVED-LEFTOVER-STAGED $repo_label" >> "$LOG"
      fi
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
    # Each file is created exclusively (copy_new), so one that appears after
    # the checks above is never overwritten, and each is recorded for cleanup
    # only once this run has really created it, so a file that is not ours is
    # never deleted. The copy is compared at cleanup with the marker, the bytes
    # actually staged, never with the global file, which may change during the
    # run and would then leave our own copy behind as if the repo shipped it.
    STAGED_SOURCE="$staged_marker"
    if [ ! -d "$repo/.claude/workflows" ]; then
      STAGED_WORKFLOW_DIR="$repo/.claude/workflows"
    fi
    if mkdir -p "$repo/.claude/workflows" \
      && copy_new "$global_workflow" "$staged_marker" && STAGED_MARKER="$staged_marker" \
      && copy_new "$global_workflow" "$repo_workflow" && STAGED_WORKFLOW="$repo_workflow"; then
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

  SESSION_ID="$( (uuidgen 2>/dev/null || cat /proc/sys/kernel/random/uuid 2>/dev/null) | tr 'A-Z' 'a-z')"
  if ! [[ "$SESSION_ID" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]; then
    echo "RESULT FAIL $repo_label reason=\"could not mint a session id\"" >> "$LOG"
    note_fail "$repo_label" "could not mint a session id"
    cleanup_run
    continue
  fi

  # The plan-guard Stop hook can re-claim a dormant plan for this headless
  # session and rewrite .claude/active-plan (measured: it writes
  # `conductor: <session id>`). The marker's bytes are saved here, and
  # cleanup_run puts them back if the marker carries this run's session id.
  PLAN_LABEL="$repo_label"
  PLAN_HAD=0
  PLAN_SNAPSHOT="$RUNNER_TMP/active-plan.snapshot"
  if [ -f "$repo/.claude/active-plan" ] && [ ! -L "$repo/.claude/active-plan" ]; then
    if cp "$repo/.claude/active-plan" "$PLAN_SNAPSHOT"; then
      PLAN_HAD=1
      PLAN_MARKER="$repo/.claude/active-plan"
    else
      echo "could not snapshot .claude/active-plan; it will not be restored" >> "$LOG"
    fi
  elif [ ! -e "$repo/.claude/active-plan" ] && [ ! -L "$repo/.claude/active-plan" ]; then
    PLAN_MARKER="$repo/.claude/active-plan"
  fi
  SCRATCH_REPORT="$SCRATCH_REPORT_PATH"
  SCRATCH_SIDECAR="$SCRATCH_SIDECAR_PATH"
  OUTPUT_PROBLEM=""

  # Headless, read-only run. The optimiser writes its report and sidecar to
  # the scratch paths above, never under .claude/ (the session cannot write
  # there); this script moves them into place afterwards. We
  # capture the transcript as diagnostic context only -- verdict_repo above
  # is what actually decides PASS/FAIL.
  #
  # T11 -- the hooks stay ON. The destructive-command guard and the snapshot
  # hook are what stand between an unattended session and a destroyed
  # working tree, so nothing here switches them off. The permission model is
  # an explicit allowlist: --allowedTools names every tool the optimiser
  # needs, and --permission-mode dontAsk refuses everything else instead of
  # prompting (nobody is there to answer) or auto-approving it. Edit is
  # scoped to the two scratch files. --disallowedTools stays as a
  # second, explicit refusal of the destructive and outward-facing commands
  # (a deny rule wins over an allow rule); --permission-mode plan was
  # considered and rejected, since plan mode would block the optimiser
  # writing the very report this script's verdict depends on.
  # --setting-sources user loads only the user's own settings, so an analysed
  # repo's committed or local settings can neither widen the allowlist nor add
  # hooks. The guard, snapshot and plan-guard hooks are registered at user
  # level, so they stay.
  #
  # The plan-guard Stop hook can still rewrite .claude/active-plan in a repo
  # with a dormant plan (the 2026-08-16 measurement above); --session-id
  # gives this run an id the hook then writes into the marker, which is how
  # cleanup_run knows to put the saved bytes back. The snapshot hook still
  # writes refs/harness-snapshots/* in each analysed repo; nothing here
  # prevents that.
  rooted_rules "$repo" "$repo_label"
  TRANSCRIPT_FILE="$(mktemp "$RUNNER_TMP/optimise-weekly-transcript.XXXXXX")"
  timeout -k 60 "$TIMEOUT_S" claude -p "Run /optimise-cycle against this repo (arguments: {\"repos\": [\"$repo\"], \"window\": 90, \"report_path\": \"$SCRATCH_REPORT_PATH\", \"proposal_targets_path\": \"$SCRATCH_SIDECAR_PATH\"}). Do not apply any proposal; the optimiser is read-only. When it finishes, reply with only the report file path and the count of ranked proposals." \
    --allowedTools "${ALLOWED_TOOLS[@]}" ${REPO_ALLOWED[@]+"${REPO_ALLOWED[@]}"} \
    --permission-mode dontAsk \
    --setting-sources user \
    --session-id "$SESSION_ID" \
    --disallowedTools "Bash(rm:*)" "Bash(sudo:*)" "Bash(git push:*)" "Bash(git commit:*)" "Bash(git reset:*)" "Bash(gh pr merge:*)" "Bash(gh pr create:*)" "Bash(gh issue create:*)" "Bash(gh release create:*)" "Bash(gh workflow run:*)" "Bash(curl:*)" "Bash(wget:*)" "Bash(git -c:*)" "Bash(git -C * -c *)" "Bash(git * --output*)" "Bash(git * --ext-diff*)" "Bash(gh * -R*)" "Bash(gh * -*R*)" "Bash(gh * --repo*)" "Bash(gh * --hostname*)" "Bash(gh -R*)" "Bash(gh --repo*)" "Bash(gh --hostname*)" "Bash(GH_HOST=*)" "Bash(GH_REPO=*)" \
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

  # The sidecar belongs under the root the optimiser resolved, which for a
  # linked worktree is the main checkout (the parent of the common git dir).
  sidecar_root="$(dirname "$(git -C "$repo" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)")"
  if [ ! -d "$sidecar_root" ]; then
    sidecar_root="$repo"
  fi
  place_output "$SCRATCH_REPORT" "$repo/$REPORT_REL" 5242880 report
  place_output "$SCRATCH_SIDECAR" "$sidecar_root/.claude/optimise-proposal-targets.json" 1048576 sidecar
  cleanup_run

  echo "exit=$claude_exit $(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$LOG"

  if verdict_repo "$repo" "$repo_label" "$claude_exit" "$start_epoch" "$ceiling_hit" "$ceiling_message" >> "$LOG"; then
    PASS_LABELS="${PASS_LABELS:+$PASS_LABELS, }$repo_label"
  else
    note_fail "$repo_label" "$VERDICT_FIRST" "$VERDICT_ALL"
  fi
done

# A run whose every configured path was skipped checked nothing, which is not a
# PASS: if git stopped resolving under launchd, or refused every repo, the job
# would otherwise be green every week while analysing nothing.
if [ -z "$PASS_LABELS" ] && [ -z "$FAIL_LABELS" ]; then
  echo 'RESULT FAIL - reason="no repos checked (all skipped)"' >> "$LOG"
  note_fail "-" "no repos checked (all skipped)"
fi
echo "=== done $(date -u +%Y-%m-%dT%H:%M:%SZ) ===" >> "$LOG"

# T11: the outcome is reported by on_exit, which runs on every way out of this
# script and defaults to FAIL; reaching this line is what lets a run report what
# its repos decided.
RUN_COMPLETE=1
exit "$overall_fail"
