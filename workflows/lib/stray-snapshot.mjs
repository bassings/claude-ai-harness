#!/usr/bin/env node
// The review cycle's stray-write snapshot, COMPUTED here rather than transcribed by an agent.
//
// HARN-OPT-5 T4 fix round 2 (re-frame; AC-SEC-12, AC-QA-27). Round 1 narrowed the agent's own
// `git status` listing to cut transcription volume, and that blinded it (round 2 M1: a modified
// .githooks/pre-push was invisible; M4: an extension allowlist). Completeness and transcription
// volume no longer compete: this is an ordinary Node script, run by an agent that relays its stdout
// verbatim, so the whole checkout can be listed. Workflow scripts have no filesystem access, which is
// why this lives in workflows/lib/ beside ledger-append.mjs.
//
// Usage: node stray-snapshot.mjs <repo-root>
// Prints ONE compact JSON object:
//   { status: [{path, xy}], files: [{path, sha256}], retained_worktrees: [path], dropped: [path] }
// Exits non-zero only when the root is not a git checkout. Read-only: it never writes to disk.
//
// status  every entry of `git status --porcelain=v1 -z --untracked-files=all --ignored` (-z means no
//         C-quoting; a rename is one entry at its target path), minus bulk ignored directories, chosen
//         in code and never by an extension allowlist (M4).
// files   sha256 of every file under the harness-loaded locations of both scopes (M1, M2). Paths under
//         the home directory are written '~/.claude/...' so no username reaches a report.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'

const BULK_DIRS = new Set(['node_modules', 'coverage', '__pycache__', '.venv', 'venv'])
const WORKTREES_PREFIX = '.claude/worktrees/'
const DROPPED = new Set(['.claude/scheduled_tasks.lock', '.claude/scheduled_tasks.json'])

const REPO_LOCATIONS = [
  '.claude/settings.json', '.claude/settings.local.json', '.claude/hooks', '.claude/agents', '.claude/skills',
  '.claude/workflows', '.claude/commands', '.githooks', 'bin', '.github/workflows',
]
const HOME_LOCATIONS = [
  'CLAUDE.md', 'settings.json', 'settings.local.json', 'AGENT-HARNESS.md', 'agents', 'skills', 'hooks',
  'workflows', 'commands', 'bin', 'plugins',
]

const byPath = (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
const plainSort = (xs) => [...xs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))

function gitStatus(root) {
  const res = spawnSync('git', ['-C', root, 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored'],
    { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  if (res.error || res.status !== 0) return null
  return res.stdout
}

// -z entries are "XY path\0"; a rename or copy is "XY target\0origin\0" (target first), so the origin is skipped.
function parseStatus(raw) {
  const toks = raw.split('\0')
  const out = []
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]
    if (t.length < 4) continue
    const xy = t.slice(0, 2)
    out.push({ path: t.slice(3), xy })
    if (/[RC]/.test(xy)) i++
  }
  return out
}

function classify(entries) {
  const status = []
  const retained = new Set()
  const dropped = new Set()
  for (const e of entries) {
    const p = e.path.replace(/\/+$/, '')
    if (p.startsWith(WORKTREES_PREFIX) || p === WORKTREES_PREFIX.slice(0, -1)) {
      retained.add(p.split('/').slice(0, 3).join('/'))
      continue
    }
    if (DROPPED.has(p)) { dropped.add(p); continue }
    if (p.split('/').some((seg) => BULK_DIRS.has(seg))) continue
    status.push(e)
  }
  return { status: status.sort(byPath), retained: plainSort(retained), dropped: plainSort(dropped) }
}

const sha256 = (file) => {
  try { return createHash('sha256').update(fs.readFileSync(file)).digest('hex') } catch { return 'unreadable' }
}

// Walks a location (file or directory), hashing files. A missing location is simply absent. Symlinked
// directories are followed once each (visited real paths), so a loop cannot hang the walk.
function walk(abs, label, skipDirs, out, seen) {
  let st
  try { st = fs.statSync(abs) } catch { return }
  if (st.isFile()) { out.push({ path: label, sha256: sha256(abs) }); return }
  if (!st.isDirectory()) return
  let real
  try { real = fs.realpathSync(abs) } catch { return }
  if (seen.has(real)) return
  seen.add(real)
  let names
  try { names = fs.readdirSync(abs) } catch { return }
  for (const name of names) {
    if (skipDirs.has(name)) continue
    walk(path.join(abs, name), `${label}/${name}`, skipDirs, out, seen)
  }
}

function hashFiles(root, home) {
  const out = []
  for (const loc of REPO_LOCATIONS) walk(path.join(root, loc), loc, new Set(['node_modules']), out, new Set())
  for (const loc of HOME_LOCATIONS) {
    const skip = new Set(loc === 'plugins' ? ['node_modules', 'cache'] : ['node_modules'])
    walk(path.join(home, '.claude', loc), `~/.claude/${loc}`, skip, out, new Set())
  }
  return out.sort(byPath)
}

const root = process.argv[2]
if (!root) {
  process.stderr.write('usage: node stray-snapshot.mjs <repo-root>\n')
  process.exit(2)
}
const raw = gitStatus(root)
if (raw === null) {
  process.stderr.write(`stray-snapshot: ${root} is not a git checkout\n`)
  process.exit(1)
}
const { status, retained, dropped } = classify(parseStatus(raw))
process.stdout.write(JSON.stringify({ status, files: hashFiles(root, os.homedir()), retained_worktrees: retained, dropped }) + '\n')
