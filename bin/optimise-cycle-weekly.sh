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
# ~/.claude/bin/optimise-cycle-weekly.sh synced from this file -- see
# README.md's "Weekly optimiser run" section for the exact sync step.
#
# Two environment variables exist ONLY as a test seam, read by
# test/weekly-runner.test.js, and are never operator-facing configuration:
# OPTIMISE_WEEKLY_REPOS (newline-separated repo list) and
# OPTIMISE_WEEKLY_LOG (log file path). Unset, both default to the real
# weekly configuration below.
set -u

# launchd's environment PATH is minimal (typically /usr/bin:/bin:/usr/sbin:
# /sbin) and has no Homebrew prefix, so append the directories that hold
# claude/timeout/git rather than prepending them: appending lets a caller's
# own PATH (a test harness's stub directory, for instance) win, while still
# guaranteeing these tools resolve under launchd's sparse default.
export PATH="$PATH:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"

LOG="${OPTIMISE_WEEKLY_LOG:-$HOME/.claude/logs/optimise-cycle-weekly.log}"
REPORT_REL=".claude/optimise-cycle-report.md"

REPOS=()
if [ -n "${OPTIMISE_WEEKLY_REPOS:-}" ]; then
  while IFS= read -r line; do
    [ -n "$line" ] && REPOS+=("$line")
  done <<< "$OPTIMISE_WEEKLY_REPOS"
else
  REPOS=(
    /Volumes/Storage/home/scott.b/repos/SaidOfYou
    /Volumes/Storage/home/scott.b/repos/CouchPotatoServer
  )
fi

mkdir -p "$(dirname "$LOG")"

# Per-repo verdict, decided entirely from the report artefact and claude's
# exit code -- never from what claude said. Echoes one RESULT line and
# returns 0 for PASS, 1 for FAIL.
verdict_repo() {
  local repo="$1"
  local claude_exit="$2"
  local start_epoch="$3"
  local report_path="$repo/$REPORT_REL"
  local reasons=()
  local mtime first_line

  if [ "$claude_exit" -ne 0 ]; then
    reasons+=("claude exited $claude_exit")
  fi

  if [ ! -f "$report_path" ]; then
    reasons+=("report file missing at $report_path")
  else
    mtime=$(stat -f %m "$report_path" 2>/dev/null || stat -c %Y "$report_path" 2>/dev/null || echo "")
    if [ -z "$mtime" ]; then
      reasons+=("could not read the report file's mtime")
    elif [ "$mtime" -lt "$start_epoch" ]; then
      reasons+=("stale report: mtime=$mtime predates this run's start=$start_epoch (not rewritten this run)")
    fi

    if [ ! -s "$report_path" ]; then
      reasons+=("report file is empty")
    else
      first_line=$(grep -m1 -v '^[[:space:]]*$' "$report_path" 2>/dev/null || true)
      if [[ "$first_line" != '# '* ]]; then
        reasons+=("report does not start with a markdown heading")
      fi
      if ! grep -q '^## ' "$report_path"; then
        reasons+=("report has no section headings")
      fi
    fi
  fi

  if [ ${#reasons[@]} -eq 0 ]; then
    echo "RESULT PASS $repo report=$report_path mtime=$mtime"
    return 0
  fi

  local joined="" r
  for r in "${reasons[@]}"; do
    if [ -z "$joined" ]; then joined="$r"; else joined="$joined; $r"; fi
  done
  echo "RESULT FAIL $repo reason=\"$joined\""
  return 1
}

echo "=== $(date -u +%Y-%m-%dT%H:%M:%SZ) weekly optimise-cycle starting ===" >> "$LOG"
overall_fail=0
for repo in "${REPOS[@]}"; do
  if [ ! -d "$repo/.git" ]; then
    echo "SKIP $repo (not a git repo)" >> "$LOG"
    continue
  fi
  echo "--- $repo ---" >> "$LOG"
  if ! cd "$repo"; then
    echo "RESULT FAIL $repo reason=\"cd into repo failed\"" >> "$LOG"
    overall_fail=1
    continue
  fi

  start_epoch=$(date +%s)
  # Headless, read-only run. The optimiser writes its own report file; we
  # capture the transcript as diagnostic context only -- verdict_repo above
  # is what actually decides PASS/FAIL.
  timeout 3600 claude -p "Run /optimise-cycle against this repo (arguments: {\"repos\": [\"$repo\"], \"window\": 90}). Do not apply any proposal; the optimiser is read-only. When it finishes, reply with only the report file path and the count of ranked proposals." \
    >> "$LOG" 2>&1
  claude_exit=$?
  echo "exit=$claude_exit $(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$LOG"

  if ! verdict_repo "$repo" "$claude_exit" "$start_epoch" >> "$LOG"; then
    overall_fail=1
  fi
done
echo "=== done $(date -u +%Y-%m-%dT%H:%M:%SZ) ===" >> "$LOG"

exit "$overall_fail"
