#!/usr/bin/env node
// Standalone append script for the harness run ledger. This is deliberately
// NOT part of a workflow script's sandboxed execution (workflow scripts have
// no filesystem access and cannot call Date.now()/new Date()); it is an
// ordinary Node script that a workflow's final agent() step is instructed to
// run via Bash, with the kind-specific payload piped to it on stdin. Putting
// the security/data-integrity-sensitive parts (path resolution, gitignore,
// atomic single-line append, injection safety) here rather than in agent
// prose means they are deterministic and directly testable (see
// test/ledger-append.test.js) instead of resting on an agent improvising
// shell commands correctly every time.
//
// Usage: node ledger-append.js < payload.json
// Prints exactly one line of JSON to stdout: {run_id, ts, write_ok, write_error}
// Always exits 0: a ledger write failure must never fail the caller's run.

import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { LEDGER_RELATIVE_PATH, LEDGER_ENTRY_SCHEMA, MAX_LINE_BYTES, validateEntry, truncate } from './ledger.mjs'

const TRUNCATABLE_FIELDS = ['task', 'spec', 'round_key', 'event', 'event_key']

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8')
  } catch (e) {
    return ''
  }
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function resolveMainCheckoutRoot(cwd) {
  const commonDir = git(['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd)
  return path.dirname(commonDir)
}

function resolveRepoIdentity(cwd) {
  try {
    const url = git(['remote', 'get-url', 'origin'], cwd)
    const m = url.match(/[/:]([^/:]+\/[^/]+?)(\.git)?$/)
    if (m) return m[1]
  } catch (e) {
    // no remote; fall through
  }
  try {
    return path.basename(git(['rev-parse', '--show-toplevel'], cwd))
  } catch (e) {
    return 'unknown'
  }
}

function ensureGitignored(root) {
  const gitignorePath = path.join(root, '.gitignore')
  let contents = ''
  if (fs.existsSync(gitignorePath)) contents = fs.readFileSync(gitignorePath, 'utf8')
  const lines = contents.split('\n')
  if (!lines.some((l) => l.trim() === LEDGER_RELATIVE_PATH)) {
    const sep = contents.length && !contents.endsWith('\n') ? '\n' : ''
    fs.writeFileSync(gitignorePath, contents + sep + LEDGER_RELATIVE_PATH + '\n')
  }
}

function result(run_id, ts, write_ok, write_error) {
  return { run_id, ts, write_ok, write_error: write_error || null }
}

function main() {
  const cwd = process.cwd()
  const run_id = randomUUID()
  const ts = new Date().toISOString()
  let payload
  try {
    const raw = readStdin()
    payload = raw.trim() ? JSON.parse(raw) : {}
  } catch (e) {
    return result(run_id, ts, false, 'payload was not valid JSON: ' + e.message)
  }

  // Truncate free-text fields BEFORE validation/serialisation so an
  // oversized field cannot push the line over the single-write() bound.
  for (const field of TRUNCATABLE_FIELDS) {
    if (field in payload) payload[field] = truncate(payload[field], 500)
  }

  let repo
  let root
  try {
    root = resolveMainCheckoutRoot(cwd)
    repo = resolveRepoIdentity(cwd)
  } catch (e) {
    return result(run_id, ts, false, 'could not resolve the main checkout via git rev-parse: ' + e.message)
  }

  const entry = {
    ...payload,
    schema_version: LEDGER_ENTRY_SCHEMA.properties.schema_version.const,
    run_id,
    ts,
    repo,
    write_ok: true,
    write_error: null,
  }

  const errors = validateEntry(entry)
  if (errors.length) {
    return result(run_id, ts, false, 'payload failed ledger schema validation: ' + errors.join('; '))
  }

  const line = JSON.stringify(entry)
  if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) {
    return result(run_id, ts, false, `line exceeded MAX_LINE_BYTES (${MAX_LINE_BYTES}) even after truncation`)
  }

  try {
    ensureGitignored(root)
    const ledgerPath = path.join(root, LEDGER_RELATIVE_PATH)
    fs.mkdirSync(path.dirname(ledgerPath), { recursive: true })
    // A single write() call, in append mode, of a line under MAX_LINE_BYTES:
    // POSIX guarantees this is atomic against other O_APPEND writers
    // (AC-DATA-3). Never read-modify-write.
    const fd = fs.openSync(ledgerPath, 'a')
    try {
      fs.writeSync(fd, line + '\n')
    } finally {
      fs.closeSync(fd)
    }
  } catch (e) {
    return result(run_id, ts, false, 'append failed: ' + e.message)
  }

  return result(run_id, ts, true, null)
}

const out = main()
process.stdout.write(JSON.stringify(out) + '\n')
process.exit(0)
