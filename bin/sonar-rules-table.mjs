#!/usr/bin/env node
// Fills the analyser rules table (.claude/analyser-rules.md) from a SonarQube
// server (HARN-RULES-1, specs/harn-rules-1.md). A person runs this after the
// analyser has finished analysing a merge. Nothing automated runs it, it is
// never a gate, and it writes no ledger line.
//
// Configuration is environment only: SONAR_HOST_URL, SONAR_TOKEN and
// SONAR_PROJECT_KEY, plus SONAR_ALLOW_HTTP=1 to permit cleartext http.
// SONAR_RULES_NOW (an ISO instant) is a clock seam for tests. The repository
// root is the working directory. The limits below are constants on purpose:
// nothing in the environment changes them.
//
// Imports are node: built-ins only (AC-SEC-11).
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const TABLE_REL = '.claude/analyser-rules.md'
const ROW_CAP = 20
const WINDOW_DAYS = 30
const GUIDANCE_CAP = 160
const BYTE_CAP = 8192
// A SonarQube rules facet holds at most this many values, so a facet with exactly
// this many may have been cut and the number of rules is then only a lower bound.
const FACET_CAP = 100
const REQUEST_TIMEOUT_MS = 8000
const RULE_KEY_RE = /^[A-Za-z0-9_.:-]{1,64}$/
const PLACEHOLDER = 'Rule name unavailable from the analyser; see the rule key'
const DAY_MS = 86_400_000
const ISSUES_PATH = '/api/issues/search'
const HEADER_ROW = '| rule | guidance | open | recent-new |'

class Fail extends Error {}

function need(name) {
  const v = process.env[name]
  if (!v) throw new Fail(`${name} is not set`)
  return v
}

// Plain string handling, so there is no pattern to backtrack on a long run of slashes.
function trimTrailingSlashes(text) {
  let end = text.length
  while (end > 0 && text[end - 1] === '/') end--
  return text.slice(0, end)
}

function configure() {
  const host = need('SONAR_HOST_URL')
  const token = need('SONAR_TOKEN')
  const project = need('SONAR_PROJECT_KEY')
  let url
  try {
    url = new URL(host)
  } catch {
    throw new Fail('SONAR_HOST_URL is not a valid URL')
  }
  if (url.username || url.password) throw new Fail('SONAR_HOST_URL must not contain a user name or password')
  let warning = null
  if (url.protocol === 'http:') {
    if (process.env.SONAR_ALLOW_HTTP !== '1') throw new Fail('SONAR_HOST_URL is http; set SONAR_ALLOW_HTTP=1 to send the token in cleartext')
    // Written to stderr before the first request, so before the token is sent.
    warning = 'warning: SONAR_ALLOW_HTTP=1, the token is sent in cleartext over http'
  } else if (url.protocol !== 'https:') {
    throw new Fail('SONAR_HOST_URL must be https')
  }
  const now = process.env.SONAR_RULES_NOW ? new Date(process.env.SONAR_RULES_NOW) : new Date()
  if (Number.isNaN(now.getTime())) throw new Fail('SONAR_RULES_NOW is not a valid date')
  return { base: trimTrailingSlashes(url.href), auth: 'Basic ' + Buffer.from(`${token}:`).toString('base64'), project, now, warning }
}

// ------------------------------------------------------------------ transport
// Messages name the status and the API path only, never a response body.
async function get(cfg, apiPath, params) {
  let res
  try {
    res = await fetch(`${cfg.base}${apiPath}?${new URLSearchParams(params)}`, {
      headers: { authorization: cfg.auth, accept: 'application/json' },
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (e) {
    if (e?.name === 'TimeoutError') throw new Fail(`request timed out on ${apiPath}`)
    throw new Fail(`cannot connect to the server (${e?.cause?.code || 'network error'}) on ${apiPath}`)
  }
  if (res.status >= 300 && res.status < 400) throw new Fail(`HTTP ${res.status} on ${apiPath}: redirects are not followed`)
  if (!res.ok) {
    const e = new Fail(`HTTP ${res.status} on ${apiPath}`)
    e.status = res.status
    throw e
  }
  try {
    return JSON.parse(await res.text())
  } catch {
    throw new Fail(`response was not valid JSON on ${apiPath}`)
  }
}

// One facet per query, ps=1: the request count never depends on the number of
// issues (AC-ARCH-8). The open query asks for unresolved issues only. The two
// creation-date queries count issues by when they were created whether or not
// since fixed, so a clean-up does not erase the rule it cleaned up, and leave
// out only false positives and accepted issues, by an explicit status list that
// never relies on the server's default (AC-QA-2). Verified against SonarQube
// 26.11 on 2026-11-21: issueStatuses with createdAfter is accepted, and sending
// resolved as well is not needed.
const CREATED_STATUSES = 'OPEN,CONFIRMED,FIXED'
const issueFacet = (cfg, extra) => get(cfg, ISSUES_PATH, { componentKeys: cfg.project, facets: 'rules', ps: '1', ...extra })
const openFacet = (cfg) => issueFacet(cfg, { resolved: 'false' })
const createdFacet = (cfg, instant) => issueFacet(cfg, { issueStatuses: CREATED_STATUSES, createdAfter: instant })

// The one place a rule's own name is looked up. /api/rules/show?key= is the
// single-rule lookup, verified against SonarQube 26.11 on 2026-11-21: it returns
// the rule with its exact key and name, and 404 for an unknown key. The caller
// still trusts a name only when the returned key equals the one asked.
async function lookupRuleName(cfg, key) {
  let body
  try {
    body = await get(cfg, '/api/rules/show', { key })
  } catch (e) {
    if (e.status === 404) return { name: null }
    throw e
  }
  const rule = body?.rule
  if (rule?.key !== key) return { mismatch: true }
  return { name: typeof rule.name === 'string' ? rule.name : null }
}

// ------------------------------------------------------------------ data
// The top-level total, or paging.total when it is absent (the server returns
// both; the top-level one is deprecated).
function totalOf(body) {
  const total = body?.total !== undefined ? body.total : body?.paging?.total
  if (!Number.isInteger(total) || total < 0) throw new Fail(`the response has no usable total on ${ISSUES_PATH}`)
  return total
}

// A changed response shape is a failure that names the API path, never a
// silent zero: a run that would have written an empty table for that reason
// writes nothing.
function facetCounts(body, tally) {
  const out = new Map()
  const facet = Array.isArray(body?.facets) ? body.facets.find((f) => f?.property === 'rules') : undefined
  if (!facet || !Array.isArray(facet.values)) throw new Fail(`the response has no rules facet on ${ISSUES_PATH}`)
  for (const v of facet.values) {
    if (typeof v?.val === 'string' && RULE_KEY_RE.test(v.val) && Number.isInteger(v.count) && v.count >= 0) out.set(v.val, v.count)
    else tally.rejected++ // counted, never quoted: the rejected text is what the checks refuse
  }
  // `sent` is how many values the server sent, rejected ones included: the cap
  // is the server's, so it is tested against this and not against the rules kept.
  return { rules: out, sent: facet.values.length }
}

// One physical line of inert text, by allowlist (AC-SEC-5). After NFKC
// normalisation every control, format, private-use, unassigned and line or
// paragraph separator code point goes, with variation selectors, the Hangul
// fillers, ANSI escapes, backticks and the column separator; whitespace is
// collapsed and the length is capped. Format characters include the tag
// characters that can spell a hidden sentence, so an enumerated list is not used.
function sanitise(text) {
  const s = String(text)
    .normalize('NFKC')
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, ' ')
    .replace(/[\p{Cf}\p{Co}\p{Cn}\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}\u115F\u1160\u3164\uFFA0`]/gu, '')
    .replaceAll('|', '/')
    .replace(/\s+/g, ' ')
    .trim()
  return Array.from(s).slice(0, GUIDANCE_CAP).join('').trim()
}

// The previous table's rules and guidance, and its derivation instant. The
// instant is the one thing read from the stamp, for the since-previous count
// (AC-PROD-6, AC-SIMP-8); it is null unless it is a real UTC instant.
function derivedInstant(line) {
  const m = /^derived: (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)(?: |$)/.exec(line)
  if (!m) return null
  const at = new Date(m[1])
  if (Number.isNaN(at.getTime()) || at.toISOString().replace(/\.000Z$/, 'Z') !== m[1]) return null
  return m[1]
}

// Whether the previous table is read at all: not when it is absent (said
// nothing about) or refused (with the reason, which is quoted from this file).
function previousGate(file) {
  let st
  try {
    st = fs.lstatSync(file)
  } catch {
    return { skip: true, ignored: null }
  }
  if (!st.isFile()) return { skip: true, ignored: 'is not a regular file' }
  if (st.size > BYTE_CAP) return { skip: true, ignored: 'is over the size bound' }
  return { skip: false, ignored: null }
}

function readPreviousRow(line, previous) {
  const c = line.split('|').slice(1, -1).map((x) => x.trim())
  if (c.length === 4 && RULE_KEY_RE.test(c[0])) previous.rules.set(c[0], sanitise(c[1]))
  else previous.unreadable++ // counted, never quoted
}

function readPrevious(file) {
  const gate = previousGate(file)
  // ignored: why the whole table was not read, when it was not. unreadable:
  // rows that could not be read, counted and never quoted.
  const previous = { rules: new Map(), instant: null, ignored: gate.ignored, unreadable: 0 }
  if (gate.skip) return previous
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (previous.instant === null) previous.instant = derivedInstant(line)
    if (line.startsWith('|')) readPreviousRow(line, previous)
  }
  return previous
}

function render(stamp, rows) {
  const body = rows.map((r) => `| ${r.key} | ${r.guidance} | ${r.open} | ${r.recent} |`)
  return ['# Analyser rules table', stamp, '', HEADER_ROW, '|---|---|---|---|', ...body].join('\n') + '\n'
}

// ------------------------------------------------------------------ output
function checkTarget(root) {
  const dir = path.join(root, path.dirname(TABLE_REL))
  const file = path.join(root, TABLE_REL)
  for (const [p, want] of [[dir, 'directory'], [file, 'file']]) {
    let st
    try {
      st = fs.lstatSync(p)
    } catch {
      continue
    }
    if (st.isSymbolicLink() || (want === 'directory' ? !st.isDirectory() : !st.isFile())) throw new Fail(`${path.relative(root, p)} is a symlink or not a regular ${want}; refusing to write`)
  }
  return { dir, file }
}

// A run killed between writing its temporary file and renaming it leaves that
// file behind. Sweep those of this naming pattern whose process is gone; one
// whose process is alive is another run still writing, and is left alone.
function removeDeadTemporaries(dir, file) {
  // No regular expression is built from the file name: the name is compared as
  // text, and only the part between prefix and suffix is read, as digits. (The
  // name is the constant TABLE_REL's, but nothing here depends on that.)
  const prefix = `.${path.basename(file)}.`
  const suffix = '.tmp'
  for (const name of fs.readdirSync(dir)) {
    const middle = between(name, prefix, suffix)
    if (!/^\d+$/.test(middle)) continue
    const pid = Number(middle)
    if (pid === process.pid || processIsAlive(pid)) continue
    removeTemporary(path.join(dir, name))
  }
}

// The part of a name between a prefix and a suffix, or '' when it has either missing.
function between(name, prefix, suffix) {
  if (!name.startsWith(prefix) || !name.endsWith(suffix)) return ''
  return name.slice(prefix.length, name.length - suffix.length)
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0)
  } catch (e) {
    return e.code !== 'ESRCH'
  }
  return true
}

function removeTemporary(p) {
  // Another run's sweep may remove the same file first; that is not a failure.
  try {
    if (fs.lstatSync(p).isFile()) fs.rmSync(p, { force: true })
  } catch (e) {
    if (e.code !== 'ENOENT') throw e
  }
}

function writeAtomically(dir, file, text) {
  fs.mkdirSync(dir, { recursive: true })
  removeDeadTemporaries(dir, file)
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.tmp`)
  try {
    fs.writeFileSync(tmp, text, { flag: 'wx' })
    fs.renameSync(tmp, file)
  } catch (e) {
    fs.rmSync(tmp, { force: true })
    throw e
  }
}

function localHead(root) {
  try {
    // git is found through PATH on purpose: the program cannot know an absolute path to git on the operator's machine.
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return null
  }
}

let repoRoot = null

// Every date parameter is an explicit UTC instant: a bare date would be read
// in the server's own time zone.
const instantOf = (iso) => iso.replace(/Z$/, '+0000')

function windowOf(now) {
  const end = now.toISOString().slice(0, 10)
  const since = new Date(Date.parse(end) - WINDOW_DAYS * DAY_MS).toISOString().slice(0, 10)
  return { end, since }
}

function rethrowNotFound(cfg, e) {
  if (e.status === 404) throw new Fail(`${e.message}: project key "${cfg.project}" was not found`)
  throw e
}

// An issue search answers 200 with total 0 for a project that does not exist,
// so existence is proved first with a lookup that answers 404 for an unknown
// key (measured against SonarQube 26.11 on 2026-11-21).
async function confirmProject(cfg) {
  try {
    await get(cfg, '/api/measures/component', { component: cfg.project, metricKeys: 'ncloc' })
  } catch (e) {
    rethrowNotFound(cfg, e)
  }
}

// A token that may not read the analysed revision still gets a table.
async function readAnalyses(cfg) {
  try {
    return { body: await get(cfg, '/api/project_analyses/search', { project: cfg.project, ps: '1' }), denied: false }
  } catch (e) {
    if (e.status === 401 || e.status === 403) return { body: null, denied: true }
    return rethrowNotFound(cfg, e)
  }
}

// When the revision is unknown, say which cause applied (AC-OPS-7).
function unknownCauseOf(denied, latest) {
  if (denied) return 'the token is not permitted to read the analysed revision'
  if (!latest) return 'the server returned no analysis for the project'
  return 'the latest analysis carries no usable revision'
}

async function analysedRevision(cfg) {
  const { body, denied } = await readAnalyses(cfg)
  const latest = body?.analyses?.[0]
  const rev = latest?.revision
  const revision = typeof rev === 'string' && /^[0-9a-f]{40}$/.test(rev) ? rev : 'unknown'
  return { revision, unknownCause: revision === 'unknown' ? unknownCauseOf(denied, latest) : null }
}

async function readFacets(cfg, since) {
  const recentBody = await createdFacet(cfg, instantOf(`${since}T00:00:00Z`))
  const openBody = await openFacet(cfg)
  const tally = { rejected: 0 }
  const recent = facetCounts(recentBody, tally)
  const open = facetCounts(openBody, tally)
  return { recent, open, newIssues: totalOf(recentBody), openTotal: totalOf(openBody), tally }
}

// Issues created after the previous table: the only ones that can show
// whether the table was used. n/a, never zero, when there is nothing to compare with.
async function sincePreviousCounts(cfg, previous, tally) {
  if (!previous.instant) return { sincePrevious: 'n/a', onListed: 'n/a' }
  const sinceBody = await createdFacet(cfg, instantOf(previous.instant))
  const sincePrevious = totalOf(sinceBody)
  const { rules: sinceRules, sent: sinceSent } = facetCounts(sinceBody, tally)
  let listed = 0
  for (const [k, n] of sinceRules) if (previous.rules.has(k)) listed += n
  // A listed rule outside the facet's first values is not seen, so at the cap the count is a floor.
  return { sincePrevious, onListed: sinceSent >= FACET_CAP ? `at least ${listed}` : listed }
}

// Recent-new first, then open count, then key: a rule new code just tripped
// is never pushed out by an old backlog (AC-QA-9, AC-PROD-4).
function rankRules(recent, open) {
  return [...new Set([...recent.keys(), ...open.keys()])]
    .map((key) => ({ key, recent: recent.get(key) || 0, open: open.get(key) || 0 }))
    .sort((a, b) => b.recent - a.recent || b.open - a.open || (a.key < b.key ? -1 : 1))
}

// A placeholder or the bare rule key is what an earlier failed lookup left
// behind, not hand-written guidance, so the name is looked up again.
const isHandWritten = (kept, key) => Boolean(kept) && kept !== PLACEHOLDER && kept !== key

async function fillGuidance(cfg, rows, previousRules) {
  const notes = []
  for (const r of rows) {
    const kept = previousRules.get(r.key)
    if (isHandWritten(kept, r.key)) {
      r.guidance = kept
      continue
    }
    // Sequential on purpose: a small server is not hit with 20 parallel requests and the request order stays deterministic for the tests.
    const found = await lookupRuleName(cfg, r.key)
    if (found.mismatch) notes.push(`rule name lookup mismatch for ${r.key}; using the rule key as guidance`)
    r.guidance = sanitise(found.mismatch ? r.key : found.name || '') || PLACEHOLDER
  }
  return notes
}

// With either rules facet at its cap the total may be higher than we can see.
// A rule whose only issue in the window has since been fixed is in the recent
// facet and not in the open one, so both are checked.
function totalLabel(count, openSent, recentSent) {
  const capped = openSent >= FACET_CAP || recentSent >= FACET_CAP
  return `${capped ? 'at least ' : ''}${count}`
}

function stampFor(f, n) {
  return `derived: ${f.now.toISOString().replace(/\.\d{3}Z$/, 'Z')} revision: ${f.revision} analyser: SonarQube window: ${f.since}..${f.end} new-issues: ${f.newIssues} previous: ${f.previousInstant || 'n/a'} since-previous: ${f.sincePrevious} on-listed: ${f.onListed} open-total: ${f.openTotal} rules: ${n} of ${f.total}` + (f.newIssues === 0 ? ' note: zero rules were tripped in the window' : '')
}

// Drop the lowest-ranked rows until the table fits the byte cap.
function fitToByteCap(stampFacts, allRows) {
  let rows = allRows
  let text = render(stampFor(stampFacts, rows.length), rows)
  while (Buffer.byteLength(text) > BYTE_CAP && rows.length > 0) {
    rows = rows.slice(0, -1)
    text = render(stampFor(stampFacts, rows.length), rows)
  }
  return { rows, text }
}

function report(r) {
  console.log(stampFor(r.stampFacts, r.rows.length))
  console.log(`wrote ${TABLE_REL}: ${r.rows.length} rules (window ${r.since}..${r.end}, analysed revision ${r.revision})`)
  if (r.unknownCause) console.log(`note: ${r.unknownCause}; the revision is recorded as unknown`)
  for (const n of r.notes) console.log(n)
  // Counts only: the text of what was rejected is what the checks refuse.
  if (r.tally.rejected) console.log(`note: ${r.tally.rejected} rule key(s) or count(s) in the server's answers were rejected as unsafe and left out`)
  if (r.previous.ignored) console.log(`note: the previous table was ignored because it ${r.previous.ignored}`)
  if (r.previous.unreadable) console.log(`note: ${r.previous.unreadable} row(s) of the previous table could not be read and were left out`)
  if (!r.head && r.revision !== 'unknown') console.log('note: git is not available for the head comparison, so the server revision was not compared with the local head')
  if (r.head && r.revision !== 'unknown' && r.revision !== r.head) console.log(`note: the server has not yet analysed the current head (server revision ${r.revision}, local head ${r.head})`)
}

async function main() {
  const cfg = configure()
  if (cfg.warning) console.error(cfg.warning)
  const root = fs.realpathSync(process.cwd())
  repoRoot = root
  const { dir, file } = checkTarget(root)
  const { end, since } = windowOf(cfg.now)

  await confirmProject(cfg)
  const { revision, unknownCause } = await analysedRevision(cfg)
  const { recent, open, newIssues, openTotal, tally } = await readFacets(cfg, since)
  const previous = readPrevious(file)
  const { sincePrevious, onListed } = await sincePreviousCounts(cfg, previous, tally)

  const all = rankRules(recent.rules, open.rules)
  const kept = all.slice(0, ROW_CAP)
  const notes = await fillGuidance(cfg, kept, previous.rules)
  const total = totalLabel(all.length, open.sent, recent.sent)
  const stampFacts = { now: cfg.now, revision, since, end, newIssues, previousInstant: previous.instant, sincePrevious, onListed, openTotal, total }
  const { rows, text } = fitToByteCap(stampFacts, kept)

  writeAtomically(dir, file, text)

  report({ stampFacts, rows, since, end, revision, unknownCause, notes, tally, previous, head: localHead(root) })
}

// What a person sees for a failure that is not the generator's own. A local
// file error names its system call, its code and the path relative to the
// repository root, all fixed-shape fields. The error's free-text message is
// never printed, because nothing guarantees what it holds (AC-SEC-4). An error
// with no code keeps the generic line.
function describe(e) {
  if (e instanceof Fail) return e.message
  const code = typeof e?.code === 'string' && /^[A-Z][A-Z0-9_]{1,31}$/.test(e.code) ? e.code : null
  if (!code) return `unexpected ${e?.name || 'error'}`
  const call = typeof e.syscall === 'string' && /^[a-z_]{2,24}$/.test(e.syscall) ? e.syscall : 'operation'
  let where = ''
  if (typeof e.path === 'string' && repoRoot) {
    const rel = path.relative(repoRoot, e.path)
    where = ` on ${rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : '<outside the repository>'}`
  }
  return `${call} failed (${code})${where}`
}

try {
  await main()
} catch (e) {
  console.error(`sonar-rules-table: ${describe(e)}`)
  process.exitCode = 1
}
