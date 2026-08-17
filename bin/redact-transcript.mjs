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
// Reads the whole transcript from stdin and writes the redacted text to
// stdout. Never throws on ordinary input; a stdin read error propagates as
// a non-zero exit so the caller's own fallback (bin/optimise-cycle-weekly.sh)
// can react rather than silently emitting unredacted content.
import { redactPaths } from '../workflows/lib/ledger-append.mjs'

const root = process.argv[2] || null

let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  input += chunk
})
process.stdin.on('end', () => {
  process.stdout.write(redactPaths(input, root))
})
process.stdin.on('error', (err) => {
  process.stderr.write(`redact-transcript.mjs: stdin read failed: ${err.message}\n`)
  process.exit(1)
})
