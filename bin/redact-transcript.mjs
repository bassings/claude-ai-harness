#!/usr/bin/env node
// Redacts absolute filesystem paths out of the weekly optimiser runner's
// captured `claude -p` transcript before it is appended to the log
// (HARN-OPT-2 T3, Group 7 log hygiene). Measured: the real 2026-08-16 log
// contained the operator's absolute repo path (including the account name)
// both in the model's own free-text reply and in the script's own
// `--- $repo ---` framing lines -- the same class of leak AC-SEC-3
// forbids for the ledger and the report.
//
// Reuses the SAME redaction the ledger writer and the optimiser report
// already apply -- workflows/lib/ledger-append.mjs's redactPaths -- rather
// than a second implementation living only in this script. `root` (argv[2],
// the repo bin/optimise-cycle-weekly.sh just ran against) is passed through
// unchanged: a path under that repo becomes repo-relative (still legible --
// this is a diagnostic log, not the ledger), and any other absolute path
// becomes the fixed redaction marker.
//
// T3 subtraction round (specs/harn-opt-2.md conductor log tick 46): a real
// leaked line survived redactPaths unchanged, because it was wrapped in
// backticks -- ABSOLUTE_PATH_RE's prefix class did not recognise one.
// ledger-append.mjs's regex is now widened to close that specific gap, but
// a regex over free-text prose can always miss some FORM (a bare
// `$(whoami)` leak, proven separately, has no path shape for any regex to
// anchor on at all). So this script adds a second, belt-and-braces pass
// AFTER redactPaths: a plain literal-substring replacement of this
// process's own home directory and OS username, which catches every form
// regardless of how it is punctuated or quoted, because it does not use a
// pattern at all. Applied last so it also mops up anything the regex pass
// left through.
//
// Reads the whole transcript from stdin and writes the redacted text to
// stdout. Never throws on ordinary input; a stdin read error propagates as
// a non-zero exit so the caller's own fallback (bin/optimise-cycle-weekly.sh)
// can react rather than silently emitting unredacted content.
import os from 'node:os'
import { redactPaths, REDACTED_PATH_MARKER } from '../workflows/lib/ledger-append.mjs'

const REDACTED_USER_MARKER = '<redacted-user>'
// A username short enough to be a common English substring (e.g. "sam",
// "al") would over-redact ordinary prose ("sample" -> "<redacted-user>ple")
// -- a real cost, but a strictly smaller one than a leaked account name in
// a log, so this is a floor against the worst false-positive cases, not a
// promise of zero false positives.
const MIN_LITERAL_LEN = 3

function redactLiteral(text, literal, marker) {
  if (!literal || literal.length < MIN_LITERAL_LEN) return text
  return text.split(literal).join(marker)
}

const root = process.argv[2] || null

let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  input += chunk
})
process.stdin.on('end', () => {
  let output = redactPaths(input, root)
  output = redactLiteral(output, os.homedir(), REDACTED_PATH_MARKER)
  output = redactLiteral(output, os.userInfo().username, REDACTED_USER_MARKER)
  process.stdout.write(output)
})
process.stdin.on('error', (err) => {
  process.stderr.write(`redact-transcript.mjs: stdin read failed: ${err.message}\n`)
  process.exit(1)
})
