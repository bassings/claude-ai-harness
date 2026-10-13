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
// Exits non-zero only when the root is not a git checkout.
//
// Fix round 3 (conductor measurement at verification: 6638 hashed files, 1.2 MB of JSON; AC-SEC-12 as amended,
// AC-QA-27): an agent cannot relay 1.2 MB faithfully, so the bulk moves off the agent into two modes.
//   node stray-snapshot.mjs snapshot <repo-root>
//     computes the same snapshot, WRITES it (0600) to a file made with mkdtemp under os.tmpdir(), and prints ONE
//     small object { file, status_count, files_count, rollup }; rollup is the sha256 of the file's bytes.
//   node stray-snapshot.mjs diff <repo-root> <before-file>
//     takes a fresh snapshot, compares it with the before-file, and prints ONE compact object
//     { changes: [{path, change, shadows_installed_workflow}], retained_worktrees, dropped,
//       before_rollup, after_rollup, hashed: { repo, home, git } }. An unreadable or malformed before-file exits
//     non-zero with a one-line reason on stderr and nothing on stdout.
// The library never writes into a repo or a home directory. Its only write is the file snapshot mode creates, and its
// only removal is that same file (and its harn-snap-* parent) once a successful diff has read it (fix round 4, L3).
//
// Fix round 4 (conductor fix pass after review round 3; AC-SEC-12 as amended). M1: the SHARED git directory was not
// watched, and it is the cheapest persistence route open to a prompt-injected lens: `git config core.hooksPath` or
// `core.fsmonitor` run inside a lens worktree writes the common .git/config, which decides whether the hashed
// .githooks/ files run at all. The common git dir's config, hooks/ and info/ (resolved with
// `git rev-parse --git-common-dir`, never a caller-supplied path) are hashed under the label '.git/...'. Never the
// index, objects, refs or logs: `git status` itself refreshes the index, so hashing it would report the library's own run.
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

// The repo-local workflow directory (anchored, direct children only): a copy there shadows the installed workflow.
const isRepoWorkflow = (p) => /^\.claude\/workflows\/[^/]+$/.test(p)
// A newly appearing status entry's change comes from its XY code, so a tracked file a lens deleted or edited is
// never labelled 'added' (round 2 M3).
const changeOfXy = (xy) => (/D/.test(xy) ? 'removed' : /[MT]/.test(xy) ? 'changed' : 'added')

const byPath = (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
const plainSort = (xs) => [...xs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))

// The common git directory (shared by every worktree of the checkout), absolute. Null when the root is not a checkout.
function gitCommonDir(root) {
  const res = spawnSync('git', ['-C', root, 'rev-parse', '--git-common-dir'], { encoding: 'utf8' })
  if (res.error || res.status !== 0) return null
  const d = res.stdout.trim()
  return d ? path.resolve(root, d) : null
}
const GIT_DIR_LOCATIONS = ['config', 'hooks', 'info']

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

function hashFiles(root, home, gitDir) {
  const out = []
  for (const loc of REPO_LOCATIONS) walk(path.join(root, loc), loc, new Set(['node_modules']), out, new Set())
  // Fix round 4 M1: the common git dir, labelled '.git/...' whatever its real location (a worktree's common dir is the
  // main checkout's), so the label never carries an absolute path.
  if (gitDir) for (const loc of GIT_DIR_LOCATIONS) walk(path.join(gitDir, loc), `.git/${loc}`, new Set(), out, new Set())
  for (const loc of HOME_LOCATIONS) {
    const skip = new Set(loc === 'plugins' ? ['node_modules', 'cache'] : ['node_modules'])
    walk(path.join(home, '.claude', loc), `~/.claude/${loc}`, skip, out, new Set())
  }
  return out.sort(byPath)
}

const sha256Of = (x) => createHash('sha256').update(x).digest('hex')

// The snapshot of a checkout, or null when it is not one.
function takeSnapshot(rootDir) {
  const raw = gitStatus(rootDir)
  if (raw === null) return null
  const { status, retained, dropped } = classify(parseStatus(raw))
  return { status, files: hashFiles(rootDir, os.homedir(), gitCommonDir(rootDir)), retained_worktrees: retained, dropped }
}

const fail = (msg, code = 1) => {
  process.stderr.write(`stray-snapshot: ${msg}\n`)
  process.exit(code)
}

// Fix round 3: a before-file is validated before anything is compared. One line on stderr, nothing on stdout.
function readBefore(file) {
  let bytes
  try { bytes = fs.readFileSync(file) } catch { return fail(`cannot read before-file ${file}`) }
  let body
  try { body = JSON.parse(bytes.toString('utf8')) } catch { return fail(`before-file ${file} is not JSON`) }
  const ok = body && typeof body === 'object' && !Array.isArray(body) && Array.isArray(body.status) && Array.isArray(body.files)
  if (!ok) return fail(`before-file ${file} is not a snapshot (status and files arrays required)`)
  return { body, rollup: sha256Of(bytes) }
}

// Fix round 4 (L3): a successful diff reaps the before-file it read, but ONLY a file snapshot mode made: named
// before.json inside a harn-snap-* directory. The directory goes with it when empty. Anything else is left alone, and
// a refused before-file is left for forensics. Failure to remove is not an error: the diff on stdout is the result.
function reapBefore(file) {
  const dir = path.dirname(path.resolve(file))
  if (path.basename(file) !== 'before.json' || !path.basename(dir).startsWith('harn-snap-')) return
  try { fs.unlinkSync(file); fs.rmdirSync(dir) } catch { /* left in place; stdout already carries the result */ }
}

// Deterministic comparison (moved here from review-cycle.js in fix round 3). Status entries by path, the XY code
// deciding a newly appearing entry's change; hashed files by sha256; a hashed file already reported via status is not repeated.
function compare(before, after) {
  const changes = []
  const add = (p, change) => changes.push({ path: p, change, shadows_installed_workflow: change !== 'removed' && isRepoWorkflow(p) })
  const bStatus = new Map(before.status.map((e) => [e.path, e.xy]))
  const aStatus = new Map(after.status.map((e) => [e.path, e.xy]))
  for (const [p, xy] of aStatus) {
    if (!bStatus.has(p)) add(p, changeOfXy(xy))
    else if (bStatus.get(p) !== xy) add(p, 'changed')
  }
  for (const p of bStatus.keys()) if (!aStatus.has(p)) add(p, 'removed')
  const bFiles = new Map(before.files.map((f) => [f.path, f.sha256]))
  const aFiles = new Map(after.files.map((f) => [f.path, f.sha256]))
  const seen = (p) => changes.some((c) => c.path === p)
  for (const [p, h] of aFiles) {
    if (seen(p)) continue
    if (!bFiles.has(p)) add(p, 'added')
    else if (bFiles.get(p) !== h) add(p, 'changed')
  }
  for (const p of bFiles.keys()) if (!aFiles.has(p) && !seen(p)) add(p, 'removed')
  return changes.sort(byPath)
}

const args = process.argv.slice(2)
const mode = args[0] === 'snapshot' || args[0] === 'diff' ? args[0] : null
const root = mode ? args[1] : args[0]
if (!root || (mode === 'diff' && !args[2])) {
  process.stderr.write('usage: node stray-snapshot.mjs [snapshot] <repo-root> | diff <repo-root> <before-file>\n')
  process.exit(2)
}
const before = mode === 'diff' ? readBefore(args[2]) : null
const snap = takeSnapshot(root)
if (snap === null) fail(`${root} is not a git checkout`)

if (mode === 'snapshot') {
  const bytes = JSON.stringify(snap) + '\n'
  // mkdtemp makes a fresh 0700 directory; 'wx' with mode 0600 means the file is new and private.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harn-snap-'))
  const file = path.join(dir, 'before.json')
  fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 })
  process.stdout.write(JSON.stringify({ file, status_count: snap.status.length, files_count: snap.files.length, rollup: sha256Of(bytes) }) + '\n')
} else if (mode === 'diff') {
  const home = snap.files.filter((f) => f.path.startsWith('~/.claude/')).length
  const git = snap.files.filter((f) => f.path.startsWith('.git/')).length  // round 4 M1: counted on its own
  process.stdout.write(JSON.stringify({
    changes: compare(before.body, snap),
    retained_worktrees: snap.retained_worktrees,
    dropped: snap.dropped,
    before_rollup: before.rollup,
    after_rollup: sha256Of(JSON.stringify(snap) + '\n'),
    hashed: { repo: snap.files.length - home - git, home, git },
  }) + '\n')
  reapBefore(args[2])
} else {
  process.stdout.write(JSON.stringify(snap) + '\n')
}
