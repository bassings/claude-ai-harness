#!/usr/bin/env node
// Ensures a given repo-relative path is gitignored via .git/info/exclude,
// then verifies it with `git check-ignore -q` -- mirroring
// workflows/lib/ledger-append.mjs's ensureGitignored + the check-ignore
// verification it performs before every write (see that file's own L1
// comment: writing WITHOUT verifying risks the path actually being
// committed if a tracked .gitignore re-includes it with a negation
// pattern).
//
// Review round-1 M1: the optimiser's report artefact
// (.claude/optimise-cycle-report.md) had no such protection at all, while
// both SKILL.md and optimise-cycle.js claimed "same convention as the
// ledger" -- a false parity claim, since the ledger's whole discipline
// IS this ignore-ensure step. This file makes that claim true, without
// touching ledger-append.mjs (a PR1 file): it is a deliberately SEPARATE,
// small, single-purpose script, parameterised by path and root rather than
// hardcoded to the ledger's own constant, invoked by the report:write
// agent step (via Bash) before any content is written.
//
// Kept OUT of workflows/lib/optimise-read.mjs on purpose: that file is
// read-only by construction and mutation-proven never to invoke git or
// write to disk (test/optimise-static.test.js, docs/pr2-mutation-proofs.md
// proofs 15-16) -- a property worth keeping absolute and un-asterisked
// rather than carving an exception into it for this one write.
//
// Like ledger-append.mjs, this is ordinary unsandboxed Node, not a
// dynamic-workflow script: it needs node:child_process (git) and real fs
// writes, both of which the sandboxed runtime statically rejects.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export function ensureIgnored(root, relativePath) {
  const gitDir = path.join(root, '.git')
  const infoDir = path.join(gitDir, 'info')
  const excludePath = path.join(infoDir, 'exclude')
  try {
    fs.mkdirSync(infoDir, { recursive: true })
    let contents = ''
    if (fs.existsSync(excludePath)) contents = fs.readFileSync(excludePath, 'utf8')
    const lines = contents.split('\n')
    if (!lines.some((l) => l.trim() === relativePath)) {
      const sep = contents.length && !contents.endsWith('\n') ? '\n' : ''
      fs.writeFileSync(excludePath, contents + sep + relativePath + '\n')
    }
  } catch (e) {
    return { ignored: false, error: 'could not update .git/info/exclude: ' + e.message }
  }
  try {
    execFileSync('git', ['check-ignore', '-q', relativePath], { cwd: root })
  } catch (e) {
    return { ignored: false, error: 'the path is not actually gitignored (a tracked .gitignore may re-include it with a negation pattern) -- refusing to write' }
  }
  return { ignored: true, error: null }
}

function main() {
  const [root, relativePath] = process.argv.slice(2)
  if (!root || !relativePath) return { ignored: false, error: 'usage: optimise-report-ignore.mjs <root> <relativePath>' }
  return ensureIgnored(root, relativePath)
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
if (isMain) {
  const out = main()
  process.stdout.write(JSON.stringify(out) + '\n')
  process.exit(0)
}
