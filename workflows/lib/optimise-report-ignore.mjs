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
// hardcoded to the ledger's own constant. Its callers are the weekly
// runner's prepare_outputs (bin/optimise-cycle-weekly.sh) and step 3 of the
// attended skill (skills/optimise-cycle/SKILL.md), each through its
// `prepare` command, which makes both output paths ignored in the main
// checkout before either file is written; no unattended session is given it.
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
      // Append, never rewrite: two callers at once (two runners against one
      // repository) each add their own line, and a rewrite of the whole file
      // from a stale read erased the other's line, or let a reader see the
      // file half written. One small O_APPEND write cannot lose another
      // writer's line. A leading newline is added only when the file, as this
      // call read it, does not end with one; a stale read can misjudge that,
      // and the cost is one blank line, which an exclude file ignores.
      const sep = contents.length && !contents.endsWith('\n') ? '\n' : ''
      fs.appendFileSync(excludePath, sep + relativePath + '\n')
    }
  } catch (e) {
    return { ignored: false, cause: 'exclude-unwritable', error: 'could not update .git/info/exclude: ' + e.message }
  }
  try {
    execFileSync('git', ['-c', 'safe.bareRepository=explicit', 'check-ignore', '-q', relativePath], { cwd: root })
  } catch (e) {
    return { ignored: false, cause: 'not-ignored', error: 'the path is not actually gitignored (a tracked .gitignore may re-include it with a negation pattern) -- refusing to write' }
  }
  return { ignored: true, error: null }
}

// ---- the one place that decides where the optimiser's two outputs go and whether their paths are ignored (HARN-RUNNER-2 whole-branch M4) ----
//
// Both entry points (the weekly runner and the attended skill) call this and nothing else for the decision, and the result check
// (optimise-verify.mjs, which spawns nothing) places only when it is handed the proof `prepare` writes:
//   root <repository>                 prints the main checkout of the repository (itself, or the main checkout of a linked worktree), or nothing
//   prepare <repository> <per-run dir> resolves that main checkout, makes both output paths ignored there, confirms each with git,
//                                      and writes ignore-proof.json into the per-run directory; prints {"ok":true,"root":...} or {"ok":false,...}
// A failure is named by its token: main-checkout (no main checkout could be found), not-ignored (a tracked rule re-includes a path), exclude-unwritable
// (the repository's exclude file could not be written) or proof-not-written. Both outputs are placed in the main checkout, where the sidecar, the ledger and the lock already live. Accepted risk (owner, 2026-11-23): a
// roster entry that names a linked worktree replaces the main checkout's report with one analysed from that worktree's branch; the runner
// logs one fixed NOTICE (linked-worktree) when that is what it is analysing so it is visible.
export const OUTPUT_RELS = ['.claude/optimise-cycle-report.md', '.claude/optimise-proposal-targets.json']
export const PROOF_NAME = 'ignore-proof.json'

export function resolveMainRoot(repo) {
  try {
    const common = execFileSync('git', ['-c', 'safe.bareRepository=explicit', '-C', repo, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    return path.basename(common) === '.git' ? path.dirname(common) : null
  } catch {
    return null
  }
}

// { ok: true, root } after both paths are confirmed ignored and the proof written, else { ok: false, reason } and no proof.
export function prepareOutputs(repo, dir) {
  const root = resolveMainRoot(repo)
  if (root === null) return { ok: false, reason: 'main-checkout' }
  for (const rel of OUTPUT_RELS) {
    const made = ensureIgnored(root, rel)
    if (!made.ignored) return { ok: false, reason: made.cause ?? 'not-ignored' }
  }
  try {
    const proof = path.join(dir, PROOF_NAME)
    fs.rmSync(proof, { force: true })
    fs.writeFileSync(proof, JSON.stringify({ root: fs.realpathSync(root), report: OUTPUT_RELS[0], sidecar: OUTPUT_RELS[1], at: Date.now() }), { flag: 'wx', mode: 0o600 })
  } catch {
    return { ok: false, reason: 'proof-not-written' }
  }
  return { ok: true, root }
}

function main(argv) {
  if (argv[0] === 'root') {
    process.stdout.write(`${resolveMainRoot(argv[1] ?? '') ?? ''}\n`)
    return null
  }
  if (argv[0] === 'prepare') return prepareOutputs(argv[1] ?? '', argv[2] ?? '')
  const [root, relativePath] = argv
  if (!root || !relativePath) return { ignored: false, error: 'usage: optimise-report-ignore.mjs <root> <relativePath>' }
  return ensureIgnored(root, relativePath)
}

// Compared by real path: import.meta.url is the real file, argv[1] may be reached through a symlink (an install whose
// ~/.claude is a link), and a lexical comparison then silently runs nothing.
function isMainModule() {
  try {
    return Boolean(process.argv[1]) && fileURLToPath(import.meta.url) === fs.realpathSync(path.resolve(process.argv[1]))
  } catch {
    return false
  }
}
const isMain = isMainModule()
if (isMain) {
  const out = main(process.argv.slice(2))
  if (out !== null) process.stdout.write(JSON.stringify(out) + '\n')
  process.exit(0)
}
