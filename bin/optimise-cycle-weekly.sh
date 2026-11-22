#!/usr/bin/env bash
# Weekly delivery-optimiser run (HARN-OPT-2 T3, reshaped by HARN-RUNNER-2 T3).
#
# For each configured repository this script (1) collects the ledger, git and
# CI data itself, with workflows/lib/optimise-collect.mjs, into a private
# per-run directory; (2) starts ONE headless `claude -p` session that only
# analyses what it is handed; (3) checks what the session returned against the
# files it collected; and (4) writes <repo>/.claude/optimise-cycle-report.md and
# <repo>/.claude/optimise-proposal-targets.json itself. Read-only otherwise: the
# optimiser never applies a change, and neither does this script. See
# skills/optimise-cycle/.
#
# The session's tool set is exactly what the invocation below passes: the
# Workflow tool, and Read of the one per-run directory. Bash, Write, Edit,
# NotebookEdit, WebFetch and WebSearch are denied as whole tools by bare name, so
# an allow rule in the operator's user-level settings cannot hand the session a
# shell, a file write or a network fetch. The session reads digest.json from the
# per-run directory, calls the installed optimise-cycle workflow with the digest
# and a nonce this script minted, and replies with only the object the workflow
# returned. It runs no command and writes no file. The residual risk, stated
# plainly: --setting-sources user loads the operator's own user-level
# permissions, and an allow rule there still applies to any tool that is not
# denied as a whole tool, namely Read, Skill, Agent and Workflow.
#
# The verdict is decided per repository from content, never from what claude
# said. PASS means every one of these held: the collector ran and its digest was
# accepted; claude exited 0; its JSON envelope and the result inside it parsed
# strictly (a report that is a string, starts with a heading, holds no NUL byte,
# is valid UTF-8 and is at most 5,242,880 bytes; a sidecar object; lane
# statuses); every measured figure in the report (ledger records, CI run counts,
# the raw escaped-defect count, the digest's omission counts) equals the figure
# in the lane files this script collected, which is what detects collected data
# changed in transit; the report holds no absolute path under $HOME, the
# repository or the per-run directory; the report and sidecar paths are
# gitignored; and both files were placed. A lane that could not run for a reason
# outside this script's control (gh unauthenticated, for instance) is a FAIL that
# names the lane and the mode, and the report is still written with the other
# lanes' real figures. Nothing is placed when the result is not trusted, so the
# last good report is left as it was. A failed ledger lane is never shown as a
# zero record count. One RESULT line per repository, PASS or FAIL, carries fixed
# tokens and integers only; nothing the session said reaches the log.
#
# Containment: the per-run directory is made mode 700 inside a parent that only
# this runner writes to; every collected file in it is mode 600; it is removed
# after a PASS, after a FAIL and on a signal; a directory left by a killed run is
# swept at the next start, without following links and only inside the runner's
# own parent. The nonce is 32 hex characters from a CSPRNG, minted per
# repository, and never written to the log. Only the programs under
# $CLAUDE_HOME/workflows/lib/ are run, never a copy inside the analysed
# repository, and no collected value is interpolated into a command string or
# evaluated. The hooks stay on: the destructive-command guard and the snapshot
# hook stand between an unattended session and a destroyed working tree.
#
# The optimiser runs as a BACKGROUND workflow inside `claude -p`, so the real
# governing budget is CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS, not the outer
# `timeout`. Both are set explicitly and aligned, and a run that hits the ceiling
# is named as the cause. A trapped signal stops the collector or the session,
# and the EXIT trap then cleans up and reports the outcome, which defaults to
# FAIL so a killed run can never leave the previous PASS standing.
#
# This script lives in version control (bin/) and is covered by
# test/weekly-runner.test.js and test/harn-runner-2-t3.test.js. Keep
# ~/.claude/bin/optimise-cycle-weekly.sh synced from this file -- see README.md's
# "Weekly optimiser run" section for the exact sync step.
#
# Three environment variables exist ONLY as a test seam and are never
# operator-facing configuration: OPTIMISE_WEEKLY_REPOS (newline-separated repo
# list), OPTIMISE_WEEKLY_LOG (log file path) and OPTIMISE_WEEKLY_STALENESS_REMOTE
# (where the staleness check clones from). Unset, each defaults to the real
# weekly configuration below. The delivery repo list itself is operator
# configuration, read from $HOME/.claude/optimise-weekly-repos (one path per
# line, never tracked anywhere), so no private repo name lives in this public repo.
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
SCRIPT_VERSION="2026-11-22.1"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

LOG="${OPTIMISE_WEEKLY_LOG:-$HOME/.claude/logs/optimise-cycle-weekly.log}"
REPORT_REL=".claude/optimise-cycle-report.md"
SIDECAR_REL=".claude/optimise-proposal-targets.json"
# The ledger window the weekly run has always passed to the optimiser.
COLLECT_WINDOW=90

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

# The collector's own worst case for ONE repository, in seconds: ledger 122 s +
# git 244 s + ci 1444 s (1200 s lane budget, then one 122 s call and one 122 s
# reader) = 1810 s, 30 minutes 10 seconds, as perRepositoryWorstCaseMs() in
# workflows/lib/optimise-collect.mjs states it. It is copied here as a literal because bash cannot import it;
# test/harn-runner-2-t3.test.js fails when the two drift apart. The collector is
# run under a hard bound of that plus a 30 s grace, with -k 30 forcing the kill.
COLLECT_WORST_CASE_S=1810
COLLECT_GRACE_S=30
COLLECT_TIMEOUT_S=$(( COLLECT_WORST_CASE_S + COLLECT_GRACE_S ))

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
STAGED_WORKFLOW=""      # the staged copy of optimise-cycle.js
STAGED_MARKER=""        # byte copy of what was staged, left so a SIGKILL leftover is recognisable
STAGED_SOURCE=""        # what the staged copy must still equal for it to be deleted
STAGED_WORKFLOW_DIR=""  # set only when this run created .claude/workflows
STALE_TMPDIR=""
CLAUDE_PID=""           # the collector or the session while it runs (a trapped signal stops it)
RUNNER_PARENT=""        # the runner-owned mode-700 directory that holds one run.XXXXXX directory at a time
RUNNER_TMP=""           # the CURRENT directory: the collected files, the session's output and the checked result live in it, and nothing else does
RUN_REAL=""             # RUNNER_TMP as a physical path, the one the session's Read rule names
SWEEP_PENDING=0         # set once at start-up: remove stale run directories left by killed runs
# A run directory older than this is a dead run's. One repository takes at most
# 3130 s: the collector's worst case COLLECT_WORST_CASE_S = 1810 s plus the
# session's CEILING_S = 1200 s, its 60 s timeout grace and its 60 s kill grace.
# The owner's three repositories are 3 x 3130 s = 9390 s, 157 minutes, so a live
# sibling's directory is far younger than the threshold. Each repository has a
# directory of its own and removes it before the next, so the threshold only has
# to outlast one repository; 1410 minutes covers 27 of them and stays under the
# day between two weekly runs. test/harn-runner-2-t3.test.js holds this to the
# collector's own figure and to 1440.
STALE_RUN_MINUTES=1410
RUN_COMPLETE=0          # set only when the normal end is reached
MOVE_TMP=""             # a temp file beside the final path while a move is in flight
PLAN_MARKER=""          # <repo>/.claude/active-plan, while a run may have it rewritten
PLAN_SNAPSHOT=""        # its bytes from before the run
PLAN_HAD=0              # 1 if the marker existed before the run
PLAN_LABEL=""
SESSION_ID=""           # this run's --session-id, which the plan-guard hook writes into a marker it claims
OUTPUT_PROBLEM=""       # why a result file could not be placed, for the verdict
EXIT_REASON=""          # why the run ended abnormally, when the runner knows

# The one cleanup function: the exit trap, the signal handlers and the end of
# every repo's iteration all come through here, and it holds every rm in this
# script. The staged copy goes only if it is still byte-identical to its
# source, so a file the repo ships, or one replaced during the run, is kept.
# Every repository owns one directory of its own (RUNNER_TMP), so no file name
# is shared between runs or between repositories, and the final call ("final",
# from the end of each repository's iteration and from the exit path) removes it
# once the outputs have been placed and the plan marker restored.
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
    RUN_REAL=""
  fi
  return 0
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

# An empty file of mode 600, made before anything is redirected into it, so a
# file this script fills (the collector's output, the session's output) is
# private from its first byte whatever the caller's umask.
make_private_file() {
  ( umask 077; : > "$1" )
}

# Starts this repository's own directory: a fresh mktemp -d inside the runner
# parent (mode 700, which mktemp gives), and RUN_REAL, its physical path, which
# is the one the session's Read rule names. Returns 1 when either cannot be had.
new_run_dir() {
  RUNNER_TMP="$(mktemp -d "$RUNNER_PARENT/run.XXXXXX" 2>/dev/null)"
  if [ -z "$RUNNER_TMP" ]; then
    return 1
  fi
  RUN_REAL="$(cd -P "$RUNNER_TMP" 2>/dev/null && pwd -P)"
  [ -n "$RUN_REAL" ]
}

# Places a file this script itself wrote (inside the per-run directory, from a
# result it has already checked) into the repo. It is never a file the session
# wrote: the session has no file write. The file is accepted only if it is a
# regular file (not a symlink), non-empty and no larger than $3 bytes, and it
# lands through a fresh exclusive temp file beside the destination and a rename,
# which replaces a symlink at the destination instead of following it, so a
# reader never sees half a report. A file that is simply absent is left to the
# caller; one that is present and refused is recorded in OUTPUT_PROBLEM, which
# names it with $4.
place_output() {
  local src="$1" dest="$2" cap="$3" what="$4" size destdir problem=""
  if [ ! -e "$src" ] && [ ! -L "$src" ]; then
    return 0
  fi
  if [ -L "$src" ]; then
    problem="$what rejected: the result file is a symlink"
  elif [ ! -f "$src" ]; then
    problem="$what rejected: the result path is not a regular file"
  else
    size=$(wc -c < "$src" | tr -d ' ')
    if [ "$size" -eq 0 ]; then
      problem="$what rejected: the result file is empty"
    elif [ "$size" -gt "$cap" ]; then
      problem="$what rejected: the result file is larger than $cap bytes"
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

# Makes the report and sidecar paths gitignored (the report-ignore helper, once
# per path, before either file is written), then confirms both with git itself
# rather than taking the helper's word: a negation in a tracked .gitignore beats
# .git/info/exclude. $1 is the repo and $2 the root whose .git/info/exclude the
# helper edits, which is the main checkout (the one shared exclude file) for a
# linked worktree. Returns 0 only when both paths are confirmed ignored.
ensure_ignored() {
  local repo="$1" root="$2"
  node "$IGNORE_SCRIPT" "$root" "$REPORT_REL" >/dev/null 2>&1
  node "$IGNORE_SCRIPT" "$root" "$SIDECAR_REL" >/dev/null 2>&1
  git -c safe.bareRepository=explicit -C "$repo" check-ignore -q -- "$REPORT_REL" 2>/dev/null \
    && git -c safe.bareRepository=explicit -C "$root" check-ignore -q -- "$SIDECAR_REL" 2>/dev/null
}

# Checks what the session returned, against the files this script collected, and
# prints fixed-vocabulary lines only: TOKENS (the figures for the RESULT line),
# DENIED (the CLI's own count of refused tool calls), one REASON per problem and
# PLACE yes|no. Arguments: the per-run directory, the session's output file or -
# (no session ran), the collector's digest token (ran, or failed:<mode>), the
# repository path, the physical per-run directory, and the per-run directory as
# first made. The program is read
# from stdin, so no collected value is ever spliced into a command string; it
# imports only node built-ins. When the result is trusted (or the only problem
# is a lane that could not run) it writes the report and the sidecar into the
# per-run directory, ready to be placed. It never prints a word the session
# said, or a path.
verify_run() {
  node - "$@" <<'VERIFY_JS'
'use strict'
const fs = require('node:fs')

const [dir, sessionPath, digestToken, repo, runDir, runTmp] = process.argv.slice(2)
const REPORT_CAP = 5242880
const SIDECAR_CAP = 1048576
const FILE_CAP = 67108864
const LANES = ['ledger', 'git', 'ci']
const reasons = []
let denied = 'unknown'
let reportedLedger = null

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const isCount = (v) => Number.isSafeInteger(v) && v >= 0
const modeToken = (m) => (typeof m === 'string' && /^[a-z_]{1,32}$/.test(m) ? m : 'other')
const fail = (reason) => {
  reasons.push(reason)
  return null
}

function readText(file) {
  try {
    const st = fs.lstatSync(file)
    return st.isFile() && st.size <= FILE_CAP ? fs.readFileSync(file, 'utf8') : null
  } catch {
    return null
  }
}

function readJson(file) {
  const text = readText(file)
  if (text === null) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

const lane = { ledger: readJson(`${dir}/ledger.json`), git: readJson(`${dir}/git.json`), ci: readJson(`${dir}/ci.json`) }
const digest = readJson(`${dir}/digest.json`)
const state = (name) => (isObject(lane[name]) && (lane[name].status === 'ran' || lane[name].status === 'failed') ? lane[name].status : 'unreadable')
const resultOf = (name) => (isObject(lane[name]) && isObject(lane[name].result) ? lane[name].result : {})
const collectedLedger = () => (state('ledger') === 'ran' && isCount(resultOf('ledger').n) ? resultOf('ledger').n : null)

// ---- the figures for the RESULT line: collected values only, fixed tokens and integers ----

function laneToken(name, figure) {
  if (state(name) === 'failed') return `${name}=failed:${modeToken(lane[name].mode)}`
  return `${name}=${state(name) === 'ran' && figure !== null ? figure : 'unreadable'}`
}

function ciFigure() {
  if (state('ci') !== 'ran') return null
  if (isCount(lane.ci.runCount)) return String(lane.ci.runCount)
  return typeof lane.ci.mode === 'string' ? modeToken(lane.ci.mode) : 'unmeasured'
}

function digestFields() {
  if (digestToken !== 'ran') return `digest=${/^failed:[a-z_]{1,32}(:[A-Za-z0-9_]{1,40})?$/.test(digestToken) ? digestToken : 'failed:other'}`
  if (!isObject(digest) || !isObject(digest.dropped)) return 'digest=failed:unreadable'
  const omitted = Object.values(digest.dropped).filter((v) => Number.isInteger(v)).reduce((a, b) => a + b, 0)
  return `digest=ran omitted=${omitted} trimmed=${digest.dropped.trimmedForSize === true ? 'yes' : 'no'}`
}

function tokens() {
  const n = collectedLedger()
  const ledger = n === null ? null : `${n}/${reportedLedger === null ? '-' : reportedLedger}`
  const count = resultOf('git').count
  return [laneToken('ledger', ledger), laneToken('ci', ciFigure()), laneToken('git', isCount(count) ? count : null), digestFields()].join(' ')
}

// ---- the session's output: the JSON envelope, then the result inside it ----

function parseSession(text) {
  if (text.trim() === '') return fail('session output: empty')
  let envelope
  try {
    envelope = JSON.parse(text)
  } catch {
    return fail('session output: not a JSON envelope')
  }
  if (!isObject(envelope)) return fail('session output: not a JSON envelope')
  if (Array.isArray(envelope.permission_denials)) denied = String(envelope.permission_denials.length)
  if (envelope.is_error === true || typeof envelope.result !== 'string' || envelope.result === '') return fail('session output: envelope has no result')
  let result
  try {
    result = JSON.parse(envelope.result)
  } catch {
    return fail('session output: result is not a JSON object')
  }
  return isObject(result) ? result : fail('session output: result is not a JSON object')
}

function startsWithHeading(report) {
  const first = report.replace(/^﻿/, '').slice(0, 4096).split('\n').find((l) => l.trim() !== '')
  return typeof first === 'string' && first.startsWith('# ')
}

const needles = []
for (const value of [process.env.HOME, repo, runDir, runTmp]) {
  if (typeof value !== 'string' || value.length < 2) continue
  needles.push(value.replace(/\/+$/, ''))
  try {
    needles.push(fs.realpathSync(value))
  } catch {
    // a path that does not resolve has no second spelling
  }
}

function holdsPath(text) {
  return needles.some((needle) => {
    let at = text.indexOf(needle)
    while (at !== -1) {
      if (!/[A-Za-z0-9_.-]/.test(text.charAt(at + needle.length))) return true
      at = text.indexOf(needle, at + 1)
    }
    return false
  })
}

// ---- the figure checks: what the report says against what the collector wrote ----

const numbersIn = (report, re) => [...report.matchAll(re)].map((m) => m.slice(1).map(Number))

function firstDifference(names, want, got) {
  const i = want.findIndex((w, k) => w !== got[k])
  return i < 0 ? null : { name: names[i], want: want[i], got: got[i] }
}

function checkLanes(said) {
  for (const name of LANES) {
    const st = state(name)
    if (st === 'unreadable') {
      reasons.push(`collected data unreadable: ${name}`)
    } else if (!isObject(said[name]) || said[name].status !== st) {
      const was = isObject(said[name]) && (said[name].status === 'ran' || said[name].status === 'failed') ? said[name].status : 'invalid'
      reasons.push(`figure mismatch ${name}: lane reported ${was}, collected ${st}`)
    } else if (st === 'failed' && modeToken(said[name].mode) !== modeToken(lane[name].mode)) {
      reasons.push(`figure mismatch ${name}: lane mode reported ${modeToken(said[name].mode)}, collected ${modeToken(lane[name].mode)}`)
    }
  }
}

function checkLedger(report) {
  const want = collectedLedger()
  if (want === null) return
  const found = numbersIn(report, /Ledger records in window: (\d{1,15})/g).map(([n]) => n)
  if (found.length === 0) {
    reasons.push(`figure mismatch ledger: collected ${want}, reported none`)
    return
  }
  const wrong = found.find((n) => n !== want)
  reportedLedger = wrong === undefined ? want : wrong
  if (wrong !== undefined) reasons.push(`figure mismatch ledger: collected ${want}, reported ${wrong}`)
}

// A lane with a figure the report must show: every line of that shape in the report equals it. A lane with none:
// the report shows no such line.
function checkLine(name, report, re, names, want) {
  const found = numbersIn(report, re)
  if (want === null) {
    if (found.length > 0) reasons.push(`figure mismatch ${name}: collected none, reported ${found[0][0]}`)
    return
  }
  if (found.length === 0) {
    reasons.push(`figure mismatch ${name}: ${names[0]} collected ${want[0]}, reported none`)
    return
  }
  for (const got of found) {
    const diff = firstDifference(names, want, got)
    if (diff) {
      reasons.push(`figure mismatch ${name}: ${diff.name} collected ${diff.want}, reported ${diff.got}`)
      return
    }
  }
}

function checkCi(report) {
  const c = lane.ci
  const measured = state('ci') === 'ran' && isCount(c.runCount) && isCount(c.fetchFailedCount) && isCount(c.timeoutCount)
  const want = measured ? [c.runCount, c.fetchFailedCount, c.timeoutCount] : null
  checkLine('ci', report, /CI runs: (\d{1,15}) fetched, (\d{1,15}) not fetched, (\d{1,15}) timed out/g, ['runs', 'not fetched', 'timed out'], want)
}

function checkGit(report) {
  const g = resultOf('git')
  const measured = state('git') === 'ran' && isCount(g.count) && isCount(g.n_commits_examined)
  checkLine('git', report, /Raw \(unscoped\): (\d{1,15}) of (\d{1,15}) examined commits/g, ['count', 'examined'], measured ? [g.count, g.n_commits_examined] : null)
}

function checkDigest(report) {
  if (!isObject(digest) || !isObject(digest.dropped)) {
    reasons.push('collected data unreadable: digest')
    return
  }
  const dropped = digest.dropped
  const seen = new Set()
  for (const [, key, n] of report.matchAll(/Digest omitted ([A-Za-z]{1,40}): (\d{1,15})/g)) {
    if (!Object.hasOwn(dropped, key) || !isCount(dropped[key])) {
      reasons.push(`figure mismatch digest: an omission line the digest does not hold, reported ${n}`)
      return
    }
    seen.add(key)
    if (Number(n) !== dropped[key]) {
      reasons.push(`figure mismatch digest: omitted ${key} collected ${dropped[key]}, reported ${n}`)
      return
    }
  }
  for (const [key, value] of Object.entries(dropped)) {
    if (isCount(value) && value > 0 && !seen.has(key)) {
      reasons.push(`figure mismatch digest: omitted ${key} collected ${value}, reported none`)
      return
    }
  }
  if ((dropped.trimmedForSize === true) !== report.includes('Digest trimmed for size: yes')) reasons.push('figure mismatch digest: trimmed flag')
}

// ---- the result object ----

function checkResult(result) {
  if (Object.hasOwn(result, 'failed_step')) {
    const step = typeof result.failed_step === 'string' && /^[a-z_]{1,32}$/.test(result.failed_step) ? ` (${result.failed_step})` : ''
    return fail(`session returned failed_step${step}`)
  }
  if (!isObject(result.lanes)) return fail('session output: result has no lanes')
  if (!Object.hasOwn(result, 'report')) return fail('session output: result has no report')
  const report = result.report
  if (typeof report !== 'string') return fail('session output: report is not a string')
  if (!startsWithHeading(report)) return fail('report does not start with a markdown heading')
  if (report.includes('\u0000')) return fail('report contains a NUL byte')
  if (Buffer.from(report, 'utf8').toString('utf8') !== report) return fail('report is not valid UTF-8')
  const bytes = Buffer.byteLength(report, 'utf8')
  if (bytes > REPORT_CAP) return fail(`report is ${bytes} bytes, over the ${REPORT_CAP} cap`)
  if (!Object.hasOwn(result, 'proposal_targets')) return fail('sidecar missing')
  if (!isObject(result.proposal_targets)) return fail('sidecar is not a JSON object')
  const sidecar = JSON.stringify(result.proposal_targets, null, 2) + '\n'
  if (Buffer.byteLength(sidecar, 'utf8') > SIDECAR_CAP) return fail('sidecar is over the size cap')
  const ids = [...report.matchAll(/^### ([0-9a-f]{16}):/gm)].map((m) => m[1])
  if (ids.some((id) => !Object.hasOwn(result.proposal_targets, id))) return fail('sidecar is missing a proposal id the report names')
  if (holdsPath(report) || holdsPath(sidecar)) return fail('report holds an absolute path (the home directory, the repository or the per-run directory)')
  return { report, sidecar }
}

function checkFigures(result, report) {
  checkLanes(result.lanes)
  checkLedger(report)
  checkCi(report)
  checkGit(report)
  checkDigest(report)
}

function main() {
  let place = 'no'
  if (sessionPath !== '-') {
    const st = fs.lstatSync(sessionPath)
    const text = st.isFile() && st.size <= FILE_CAP ? fs.readFileSync(sessionPath, 'utf8') : null
    const result = text === null ? fail('session output: not a JSON envelope') : parseSession(text)
    const checked = result === null ? null : checkResult(result)
    if (checked !== null) {
      checkFigures(result, checked.report)
      if (reasons.length === 0) {
        for (const name of LANES) if (state(name) === 'failed') reasons.push(`${name} lane could not run: ${modeToken(lane[name].mode)}`)
        fs.writeFileSync(`${dir}/result-report.md`, checked.report, { mode: 0o600 })
        fs.writeFileSync(`${dir}/result-sidecar.json`, checked.sidecar, { mode: 0o600 })
        place = 'yes'
      }
    }
  }
  const lines = [`TOKENS ${tokens()}`, `DENIED ${denied}`, ...reasons.map((r) => `REASON ${r}`), `PLACE ${place}`]
  process.stdout.write(`${lines.join('\n')}\n`)
}

main()
VERIFY_JS
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

# The session is given a Read rule naming one per-run directory, so that path
# must be a plain absolute path with no `.claude` segment. The physical path is
# used, so a symlinked TMPDIR (macOS /var) cannot make the permission rule and
# the path the session reads disagree. Every per-run directory is a run.XXXXXX
# inside this parent, so checking the parent's directory once covers them all.
RUNNER_REAL="$(cd -P "$RUNNER_TMP" 2>/dev/null && pwd -P)"
if ! printf '%s' "$RUNNER_REAL" | grep -Eq '^/[A-Za-z0-9_/.-]+$' || printf '%s' "$RUNNER_REAL" | grep -Eq '(^|/)(\.claude|\.\.|\.)(/|$)'; then
  EXIT_REASON="runner temp directory path cannot be given to the optimiser (plain characters only, no .claude segment)"
  exit 1
fi

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

# The staleness check borrowed the first per-run directory (its clone lives in
# it) and the start-up sweep ran with it. Each repository now gets a directory
# of its own, so that one is removed before any repository starts.
cleanup_run final

# T11: an empty repo list used to end the run with exit 0 and no RESULT line,
# which reads as "nothing to do" when the real state is "nothing is being
# checked". It is a FAIL, so it is logged, notified and non-zero like any other.
if [ ${#REPOS[@]} -eq 0 ]; then
  echo 'RESULT FAIL - reason="no repos configured"' >> "$LOG"
  note_fail "-" "no repos configured"
fi

# The workflow takes the digest and the nonce as arguments and RETURNS its report
# and sidecar (contract 2). An installed optimise-cycle.js from before that
# neither accepts what this runner hands it nor returns what it checks, so every
# repo would FAIL with a symptom and not the cause. Such a run stops here, before
# any collector, staging or session. A plugin-only install has no global copy and
# is not checked. The check reads the workflow's explicit WEEKLY_RUNNER_CONTRACT
# constant, not a word in it, which an older file could already contain.
REQUIRED_WORKFLOW_CONTRACT=2
installed_contract="$(sed -n 's/^const WEEKLY_RUNNER_CONTRACT = \([0-9][0-9]*\)$/\1/p' "$CLAUDE_HOME/workflows/optimise-cycle.js" 2>/dev/null | head -n1)"
if [ -f "$CLAUDE_HOME/workflows/optimise-cycle.js" ] && { [ -z "$installed_contract" ] || [ "$installed_contract" -lt "$REQUIRED_WORKFLOW_CONTRACT" ]; }; then
  echo 'RESULT FAIL - reason="installed optimise-cycle.js is older than this runner requires; run bin/install.sh"' >> "$LOG"
  note_fail "-" "installed optimise-cycle.js is older than this runner requires; run bin/install.sh"
  REPOS=()
fi

# The programs this runner runs, resolved from the install and never from the
# analysed repository, and the shapes of the collector's one log line. Each is
# checked per repository, before anything is staged or collected.
COLLECT_SCRIPT="$CLAUDE_HOME/workflows/lib/optimise-collect.mjs"
IGNORE_SCRIPT="$CLAUDE_HOME/workflows/lib/optimise-report-ignore.mjs"
COLLECT_LINE_RE='^COLLECT [A-Za-z0-9_:=,. -]+$'
DIGEST_RAN_RE=' digest=ran:bytes:[0-9]+,dropped:[0-9]+,trimmed:(yes|no)$'
DIGEST_FAILED_RE=' digest=failed:([a-z_]+)(:[A-Za-z0-9_]+)?$'
CEILING_RE='Background tasks still running after [0-9]+s; terminating'

# One FAIL line for a repository that stopped before it had anything to count.
fail_repo() {
  echo "RESULT FAIL $1 reason=\"$2\"" >> "$LOG"
  note_fail "$1" "$2"
}

# One RESULT line for the repository: PASS when no reason was recorded, else FAIL
# with the reasons (the global array `reasons`). $2 is the figures verify_run
# built from the collected files: fixed tokens and integers, so no field
# identifies a person or carries a word the session said, and the line is the
# only RESULT line the repository gets.
record_result() {
  local label="$1" figures="$2" joined="" r
  if [ ${#reasons[@]} -eq 0 ]; then
    echo "RESULT PASS $label${figures:+ $figures}" >> "$LOG"
    PASS_LABELS="${PASS_LABELS:+$PASS_LABELS, }$label"
    return 0
  fi
  for r in "${reasons[@]}"; do
    if [ -z "$joined" ]; then joined="$r"; else joined="$joined; $r"; fi
  done
  echo "RESULT FAIL $label${figures:+ $figures} reason=\"$joined\"" >> "$LOG"
  note_fail "$label" "${reasons[0]}" "$joined"
}

# Reads verify_run's lines (its stdout in $1, its exit status in $2) into the
# figures, the denied-tool count, whether to place the files, and the reasons.
read_verify() {
  local vline
  VERIFY_FIGURES=""
  VERIFY_DENIED="unknown"
  VERIFY_PLACE="no"
  while IFS= read -r vline; do
    case "$vline" in
      "TOKENS "*) VERIFY_FIGURES="${vline#TOKENS }" ;;
      "DENIED "*) VERIFY_DENIED="${vline#DENIED }" ;;
      "PLACE "*) VERIFY_PLACE="${vline#PLACE }" ;;
      "REASON "*) reasons+=("${vline#REASON }") ;;
    esac
  done <<< "$1"
  case "$VERIFY_FIGURES" in
    *[!A-Za-z0-9_:=/\ -]*) VERIFY_FIGURES="" ;;
  esac
  case "$VERIFY_DENIED" in
    ''|*[!0-9]*) VERIFY_DENIED="unknown" ;;
  esac
  if [ "$2" -ne 0 ] || [ -z "$VERIFY_FIGURES" ]; then
    VERIFY_PLACE="no"
    reasons+=("the result check could not run")
  fi
}

# One repository: collect, run the session, check, place, record. Every way out
# is a `return`, and the loop below calls cleanup_run final after each, so the
# per-run directory, the staged workflow and the plan marker are always dealt
# with.
process_repo() {
  local repo="$1" repo_label
  local global_workflow repo_workflow staged_marker linked
  repo_label="$(basename "$repo")"

  # Group 2: a configured path that no longer exists is a configuration
  # FAIL, not a silent skip -- distinct from a path that exists and is
  # deliberately not a repo (SKIP, below).
  if [ ! -e "$repo" ]; then
    echo "RESULT FAIL $repo_label reason=\"configured repo path does not exist\"" >> "$LOG"
    note_fail "$repo_label" "configured repo path does not exist"
    return 0
  fi

  # Group 2: `git -C rev-parse --git-dir` resolves a linked worktree (whose
  # own .git is a FILE, not a directory) the same as an ordinary checkout,
  # so a worktree is processed normally rather than skipped.
  if ! git -C "$repo" rev-parse --git-dir >/dev/null 2>&1; then
    echo "SKIP $repo_label (not a git repo)" >> "$LOG"
    return 0
  fi

  echo "--- $repo_label ---" >> "$LOG"
  if ! cd "$repo"; then
    echo "RESULT FAIL $repo_label reason=\"cd into repo failed\"" >> "$LOG"
    note_fail "$repo_label" "cd into repo failed"
    return 0
  fi

  # AC-OPS-12: every program the runner calls is resolved from the install. A
  # missing one stops this repository with a reason naming the file, before
  # anything is staged or any session starts.
  for needed in "$COLLECT_SCRIPT" "$IGNORE_SCRIPT"; do
    if [ ! -f "$needed" ]; then
      fail_repo "$repo_label" "workflows/lib/${needed##*/} is missing from the install; run bin/install.sh"
      return 0
    fi
  done

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
      return 0
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
    fail_repo "$repo_label" "could not capture a valid run start time (start_epoch)"
    return 0
  fi

  SESSION_ID="$( (uuidgen 2>/dev/null || cat /proc/sys/kernel/random/uuid 2>/dev/null) | tr 'A-Z' 'a-z')"
  if ! [[ "$SESSION_ID" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]; then
    fail_repo "$repo_label" "could not mint a session id"
    return 0
  fi

  # This repository's own directory, so no other repository's session can read
  # its data.
  if ! new_run_dir; then
    fail_repo "$repo_label" "could not create this run's temp directory"
    return 0
  fi

  # The plan-guard Stop hook can re-claim a dormant plan for this headless
  # session and rewrite .claude/active-plan (measured: it writes
  # `conductor: <session id>`). The marker's bytes are saved here, and
  # cleanup_run puts them back if the marker carries this run's session id.
  PLAN_LABEL="$repo_label"
  PLAN_HAD=0
  PLAN_SNAPSHOT="$RUNNER_TMP/active-plan.snapshot"
  if [ -f "$repo/.claude/active-plan" ] && [ ! -L "$repo/.claude/active-plan" ]; then
    if cp "$repo/.claude/active-plan" "$PLAN_SNAPSHOT" && chmod 600 "$PLAN_SNAPSHOT"; then
      PLAN_HAD=1
      PLAN_MARKER="$repo/.claude/active-plan"
    else
      echo "could not snapshot .claude/active-plan; it will not be restored" >> "$LOG"
    fi
  elif [ ! -e "$repo/.claude/active-plan" ] && [ ! -L "$repo/.claude/active-plan" ]; then
    PLAN_MARKER="$repo/.claude/active-plan"
  fi
  OUTPUT_PROBLEM=""
  reasons=()

  # ---- collect: the runner gathers the ledger, git and CI data itself, into the
  # per-run directory, before any session starts. The collector is run from the
  # install under a hard bound of its own worst case plus a grace; it is backgrounded
  # and waited on so a trapped signal stops it at once (its own handler then ends
  # the git and gh calls it started).
  local collect_out="$RUNNER_TMP/collect.out" collect_err="$RUNNER_TMP/collect.err"
  local collect_exit collect_reason="" collect_line="" collect_note digest_token="" collect_s verify_out verify_status
  make_private_file "$collect_out"
  make_private_file "$collect_err"
  SECONDS=0
  timeout -k "$COLLECT_GRACE_S" "$COLLECT_TIMEOUT_S" node "$COLLECT_SCRIPT" "$repo" "$RUN_REAL" "$COLLECT_WINDOW" > "$collect_out" 2> "$collect_err" &
  CLAUDE_PID=$!
  wait "$CLAUDE_PID"
  collect_exit=$?
  CLAUDE_PID=""
  collect_s=$SECONDS
  case "$collect_exit" in
    0) ;;
    124|137) collect_reason="collector timed out after ${COLLECT_TIMEOUT_S}s" ;;
    *) collect_reason="collector failed (exit $collect_exit)" ;;
  esac
  if [ -z "$collect_reason" ]; then
    collect_line="$(grep -m1 '^COLLECT ' "$collect_out" 2>/dev/null | head -c 600)"
    if ! [[ "$collect_line" =~ $COLLECT_LINE_RE ]]; then
      collect_reason="collector failed (no result line)"
    elif [[ "$collect_line" =~ $DIGEST_RAN_RE ]]; then
      digest_token="ran"
    elif [[ "$collect_line" =~ $DIGEST_FAILED_RE ]]; then
      digest_token="failed:${BASH_REMATCH[1]}${BASH_REMATCH[2]}"
    else
      collect_reason="collector failed (no digest field)"
    fi
  else
    # The collector's own stderr line is a fixed vocabulary (its failure class,
    # never a message), and is logged only if it has that shape.
    collect_note="$(grep -m1 '^COLLECT ' "$collect_err" 2>/dev/null | head -c 200)"
    if [[ "$collect_note" =~ $COLLECT_LINE_RE ]]; then
      echo "$collect_note" >> "$LOG"
    fi
  fi
  if [ -n "$collect_reason" ]; then
    echo "TIMING $repo_label start_epoch=$start_epoch collect_s=$collect_s" >> "$LOG"
    reasons+=("$collect_reason")
    record_result "$repo_label" ""
    return 0
  fi
  echo "$collect_line" >> "$LOG"
  # A digest the collector refused, or one that is not on disk, is a FAIL with a
  # fixed reason, and no session is launched for this repository.
  if [ "${digest_token%%:*}" = ran ] && { [ -L "$RUN_REAL/digest.json" ] || [ ! -f "$RUN_REAL/digest.json" ]; }; then
    digest_token="failed:missing"
  fi
  if [ "${digest_token%%:*}" != ran ]; then
    echo "TIMING $repo_label start_epoch=$start_epoch collect_s=$collect_s" >> "$LOG"
    reasons+=("digest refused: ${digest_token#failed:}")
    verify_out="$(verify_run "$RUN_REAL" - "$digest_token" "$repo" "$RUN_REAL" "$RUNNER_TMP" 2>/dev/null)"
    verify_status=$?
    read_verify "$verify_out" "$verify_status"
    record_result "$repo_label" "$VERIFY_FIGURES"
    return 0
  fi

  # ---- the session: one headless run per repository, with the Workflow tool
  # and a Read rule for this one directory, and no shell and no file write. It
  # Reads digest.json, calls the installed optimise-cycle workflow with it and a
  # fresh nonce, and replies with only what the workflow returned. The nonce is
  # 32 hex characters from a CSPRNG, one per repository, and is never logged.
  local nonce session_prompt session_out="$RUNNER_TMP/session.out" session_err="$RUNNER_TMP/session.err"
  local claude_exit ceiling_hit=0 ceiling_message="" session_s
  nonce="$(node -e "process.stdout.write(require('node:crypto').randomBytes(16).toString('hex'))" 2>/dev/null)"
  if ! [[ "$nonce" =~ ^[0-9a-f]{32}$ ]]; then
    reasons+=("could not mint a containment nonce")
    record_result "$repo_label" ""
    return 0
  fi
  session_prompt="Use the Read tool to read $RUN_REAL/digest.json. Then call the Workflow tool to run the installed optimise-cycle workflow, passing it one argument object with two keys: digest, the parsed content of that file exactly as read, and nonce, the string $nonce. When the workflow returns, reply with ONLY the object it returned, written as JSON, with no other text and no code fence. If you cannot do that, reply with ONLY this JSON object instead: {\"failed_step\": \"read or workflow\", \"reason\": \"one short sentence\"}. Do not run any command, write any file or apply any proposal; the optimiser is read-only."
  make_private_file "$session_out"
  make_private_file "$session_err"
  # The hooks stay ON: the destructive-command guard and the snapshot hook are
  # what stand between an unattended session and a destroyed working tree, so
  # nothing here switches them off. --permission-mode dontAsk refuses everything
  # not listed instead of prompting (nobody is there) or auto-approving it. The
  # six whole tools are denied by bare name so a user-level allow rule cannot
  # hand the session one. --setting-sources user loads only the user's own
  # settings, so an analysed repo's committed or local settings can neither widen
  # the allowlist nor add hooks. --session-id gives this run an id the plan-guard
  # hook writes into a marker it claims, which is how cleanup_run knows to put the
  # saved bytes back. The Read rule's doubled slash is how the CLI spells an
  # absolute path.
  SECONDS=0
  timeout -k 60 "$TIMEOUT_S" claude -p "$session_prompt" \
    --allowedTools "Workflow" "Read(/$RUN_REAL/**)" \
    --permission-mode dontAsk \
    --setting-sources user \
    --session-id "$SESSION_ID" \
    --disallowedTools Bash Write Edit NotebookEdit WebFetch WebSearch \
    --output-format json \
    > "$session_out" 2> "$session_err" &
  # Backgrounded and waited on, so a SIGTERM or SIGINT to this script is
  # handled at once (on_signal) rather than after claude finishes.
  CLAUDE_PID=$!
  wait "$CLAUDE_PID"
  claude_exit=$?
  CLAUDE_PID=""
  session_s=$SECONDS
  nonce=""
  session_prompt=""
  # The session is over: the plan marker is restored and the staged copy removed
  # now, before the result is checked, and the per-run directory stays until the
  # repository is done.
  cleanup_run
  echo "TIMING $repo_label start_epoch=$start_epoch collect_s=$collect_s session_s=$session_s" >> "$LOG"

  # 124 and 137 are what `timeout` itself exits with when it stops claude: 124
  # after the polite signal, 137 after the -k grace period's hard kill.
  case "$claude_exit" in
    0) ;;
    124) reasons+=("timed out after ${TIMEOUT_S}s") ;;
    137) reasons+=("killed after timeout grace") ;;
    *) reasons+=("claude exited $claude_exit") ;;
  esac
  # Anchored to the CLI's OWN message rather than a bare grep for the ceiling
  # variable's name (which false-positived on any text merely mentioning it), and
  # captures the observed wait so the FAIL reason states what actually happened.
  if ceiling_message=$(grep -h -Eo "$CEILING_RE" "$session_out" "$session_err" 2>/dev/null | head -n1) && [ -n "$ceiling_message" ]; then
    ceiling_hit=1
    reasons+=("background wait ceiling reached before completion ($ceiling_message)")
  fi

  # ---- check: the session's reply is parsed strictly, never scanned, and every
  # figure in it is compared with the lane files collected above. A session that
  # did not exit 0 is not parsed at all.
  if [ "$claude_exit" -eq 0 ]; then
    verify_out="$(verify_run "$RUN_REAL" "$session_out" "$digest_token" "$repo" "$RUN_REAL" "$RUNNER_TMP" 2>/dev/null)"
  else
    verify_out="$(verify_run "$RUN_REAL" - "$digest_token" "$repo" "$RUN_REAL" "$RUNNER_TMP" 2>/dev/null)"
  fi
  verify_status=$?
  read_verify "$verify_out" "$verify_status"
  echo "DENIED-TOOLS $repo_label $VERIFY_DENIED" >> "$LOG"

  # ---- place: only a result that passed every check, or whose one problem is a
  # lane that could not run, is written; anything else leaves the last good
  # report and sidecar as they were. The report and sidecar paths are made
  # ignored, and confirmed so, before either is written.
  if [ "$VERIFY_PLACE" = yes ] && [ "$claude_exit" -eq 0 ] && [ "$ceiling_hit" = 0 ]; then
    local sidecar_root
    sidecar_root="$(git -C "$repo" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)"
    sidecar_root="${sidecar_root%/*}"
    if [ -z "$sidecar_root" ] || [ ! -d "$sidecar_root" ]; then
      sidecar_root="$repo"
    fi
    if [ ! -f "$RUN_REAL/result-report.md" ] || [ ! -f "$RUN_REAL/result-sidecar.json" ]; then
      reasons+=("the result check wrote no output")
    elif ! ensure_ignored "$repo" "$sidecar_root"; then
      reasons+=("report path is not gitignored")
    elif ! { place_output "$RUN_REAL/result-report.md" "$repo/$REPORT_REL" 5242880 report \
      && place_output "$RUN_REAL/result-sidecar.json" "$sidecar_root/$SIDECAR_REL" 1048576 sidecar; }; then
      reasons+=("$OUTPUT_PROBLEM")
    fi
  fi
  record_result "$repo_label" "$VERIFY_FIGURES"
}

# Group 8: bash 3.2's `set -u` treats "${REPOS[@]}" on a genuinely empty
# array as an unbound-variable error; the ${arr[@]+"${arr[@]}"} idiom below
# expands to nothing (not an error) when REPOS is empty.
for repo in "${REPOS[@]+"${REPOS[@]}"}"; do
  process_repo "$repo"
  cleanup_run final
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
