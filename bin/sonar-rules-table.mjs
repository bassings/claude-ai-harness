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
  return { base: url.href.replace(/\/+$/, ''), auth: 'Basic ' + Buffer.from(`${token}:`).toString('base64'), project, now, warning }
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
    .replace(/\u001b\[[0-9;?]*[ -\/]*[@-~]/g, '')
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, ' ')
    .replace(/[\p{Cf}\p{Co}\p{Cn}\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}\u115F\u1160\u3164\uFFA0`]/gu, '')
    .replace(/\|/g, '/')
    .replace(/\s+/g, ' ')
    .trim()
  return Array.from(s).slice(0, GUIDANCE_CAP).join('').trim()
}

// The previous table's rules and guidance, and its derivation instant. The
// instant is the one thing read from the stamp, for the since-previous count
// (AC-PROD-6, AC-SIMP-8); it is null unless it is a real UTC instant.
function readPrevious(file) {
  const rules = new Map()
  let instant = null
  let ignored = null // why the whole table was not read, when it was not
  let unreadable = 0 // rows that could not be read, counted and never quoted
  let st
  try {
    st = fs.lstatSync(file)
  } catch {
    return { rules, instant, ignored, unreadable }
  }
  if (!st.isFile()) return { rules, instant, ignored: 'is not a regular file', unreadable }
  if (st.size > BYTE_CAP) return { rules, instant, ignored: 'is over the size bound', unreadable }
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (instant === null) {
      const m = /^derived: (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)(?: |$)/.exec(line)
      const at = m ? new Date(m[1]) : null
      if (at && !Number.isNaN(at.getTime()) && at.toISOString().replace(/\.000Z$/, 'Z') === m[1]) instant = m[1]
    }
    if (!line.startsWith('|')) continue
    const c = line.split('|').slice(1, -1).map((x) => x.trim())
    if (c.length === 4 && RULE_KEY_RE.test(c[0])) rules.set(c[0], sanitise(c[1]))
    else unreadable++
  }
  return { rules, instant, ignored, unreadable }
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
    if (!name.startsWith(prefix) || !name.endsWith(suffix)) continue
    const middle = name.slice(prefix.length, name.length - suffix.length)
    if (!/^\d+$/.test(middle)) continue
    const pid = Number(middle)
    if (pid === process.pid) continue
    let alive = true
    try {
      process.kill(pid, 0)
    } catch (e) {
      alive = e.code !== 'ESRCH'
    }
    if (alive) continue
    // Another run's sweep may remove the same file first; that is not a failure.
    try {
      const p = path.join(dir, name)
      if (fs.lstatSync(p).isFile()) fs.rmSync(p, { force: true })
    } catch (e) {
      if (e.code !== 'ENOENT') throw e
    }
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
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return null
  }
}

let repoRoot = null

async function main() {
  const cfg = configure()
  if (cfg.warning) console.error(cfg.warning)
  const root = fs.realpathSync(process.cwd())
  repoRoot = root
  const { dir, file } = checkTarget(root)

  const end = cfg.now.toISOString().slice(0, 10)
  const since = new Date(Date.parse(end) - WINDOW_DAYS * DAY_MS).toISOString().slice(0, 10)

  // An issue search answers 200 with total 0 for a project that does not exist,
  // so existence is proved first with a lookup that answers 404 for an unknown
  // key (measured against SonarQube 26.11 on 2026-11-21).
  const notFound = (e) => {
    if (e.status === 404) throw new Fail(`${e.message}: project key "${cfg.project}" was not found`)
    throw e
  }
  await get(cfg, '/api/measures/component', { component: cfg.project, metricKeys: 'ncloc' }).catch(notFound)

  // A token that may not read the analysed revision still gets a table.
  let analyses = null
  let revisionDenied = false
  try {
    analyses = await get(cfg, '/api/project_analyses/search', { project: cfg.project, ps: '1' })
  } catch (e) {
    if (e.status === 401 || e.status === 403) revisionDenied = true
    else notFound(e)
  }
  const latest = analyses?.analyses?.[0]
  const rev = latest?.revision
  const revision = typeof rev === 'string' && /^[0-9a-f]{40}$/.test(rev) ? rev : 'unknown'
  // When the revision is unknown, say which cause applied (AC-OPS-7).
  let unknownCause = null
  if (revision === 'unknown') {
    if (revisionDenied) unknownCause = 'the token is not permitted to read the analysed revision'
    else if (!latest) unknownCause = 'the server returned no analysis for the project'
    else unknownCause = 'the latest analysis carries no usable revision'
  }

  // Every date parameter is an explicit UTC instant: a bare date would be read
  // in the server's own time zone.
  const instantOf = (iso) => iso.replace(/Z$/, '+0000')
  const recentBody = await createdFacet(cfg, instantOf(`${since}T00:00:00Z`))
  const openBody = await openFacet(cfg)
  const tally = { rejected: 0 }
  const { rules: recent, sent: recentSent } = facetCounts(recentBody, tally)
  const { rules: open, sent: openSent } = facetCounts(openBody, tally)
  const newIssues = totalOf(recentBody)
  const openTotal = totalOf(openBody)

  const { rules: previous, instant: previousInstant, ignored: previousIgnored, unreadable: previousUnreadable } = readPrevious(file)
  // Issues created after the previous table: the only ones that can show
  // whether the table was used. n/a, never zero, when there is nothing to compare with.
  let sincePrevious = 'n/a'
  let onListed = 'n/a'
  if (previousInstant) {
    const sinceBody = await createdFacet(cfg, instantOf(previousInstant))
    sincePrevious = totalOf(sinceBody)
    const { rules: sinceRules, sent: sinceSent } = facetCounts(sinceBody, tally)
    let listed = 0
    for (const [k, n] of sinceRules) if (previous.has(k)) listed += n
    // A listed rule outside the facet's first values is not seen, so at the cap the count is a floor.
    onListed = sinceSent >= FACET_CAP ? `at least ${listed}` : listed
  }

  // Recent-new first, then open count, then key: a rule new code just tripped
  // is never pushed out by an old backlog (AC-QA-9, AC-PROD-4).
  const all = [...new Set([...recent.keys(), ...open.keys()])]
    .map((key) => ({ key, recent: recent.get(key) || 0, open: open.get(key) || 0 }))
    .sort((a, b) => b.recent - a.recent || b.open - a.open || (a.key < b.key ? -1 : 1))
  let rows = all.slice(0, ROW_CAP)

  const notes = []
  for (const r of rows) {
    const kept = previous.get(r.key)
    // A placeholder or the bare rule key is what an earlier failed lookup left
    // behind, not hand-written guidance, so the name is looked up again.
    if (kept && kept !== PLACEHOLDER && kept !== r.key) {
      r.guidance = kept
      continue
    }
    const found = await lookupRuleName(cfg, r.key)
    if (found.mismatch) notes.push(`rule name lookup mismatch for ${r.key}; using the rule key as guidance`)
    r.guidance = sanitise(found.mismatch ? r.key : found.name || '') || PLACEHOLDER
  }

  // With either rules facet at its cap the total may be higher than we can see.
  // A rule whose only issue in the window has since been fixed is in the recent
  // facet and not in the open one, so both are checked.
  const capped = openSent >= FACET_CAP || recentSent >= FACET_CAP
  const total = `${capped ? 'at least ' : ''}${all.length}`
  const stampFor = (n) => `derived: ${cfg.now.toISOString().replace(/\.\d{3}Z$/, 'Z')} revision: ${revision} analyser: SonarQube window: ${since}..${end} new-issues: ${newIssues} previous: ${previousInstant || 'n/a'} since-previous: ${sincePrevious} on-listed: ${onListed} open-total: ${openTotal} rules: ${n} of ${total}` + (newIssues === 0 ? ' note: zero rules were tripped in the window' : '')
  let text = render(stampFor(rows.length), rows)
  while (Buffer.byteLength(text) > BYTE_CAP && rows.length > 0) {
    rows = rows.slice(0, -1)
    text = render(stampFor(rows.length), rows)
  }

  writeAtomically(dir, file, text)

  const head = localHead(root)
  console.log(stampFor(rows.length))
  console.log(`wrote ${TABLE_REL}: ${rows.length} rules (window ${since}..${end}, analysed revision ${revision})`)
  if (unknownCause) console.log(`note: ${unknownCause}; the revision is recorded as unknown`)
  for (const n of notes) console.log(n)
  // Counts only: the text of what was rejected is what the checks refuse.
  if (tally.rejected) console.log(`note: ${tally.rejected} rule key(s) or count(s) in the server's answers were rejected as unsafe and left out`)
  if (previousIgnored) console.log(`note: the previous table was ignored because it ${previousIgnored}`)
  if (previousUnreadable) console.log(`note: ${previousUnreadable} row(s) of the previous table could not be read and were left out`)
  if (!head && revision !== 'unknown') console.log('note: git is not available for the head comparison, so the server revision was not compared with the local head')
  if (head && revision !== 'unknown' && revision !== head) console.log(`note: the server has not yet analysed the current head (server revision ${revision}, local head ${head})`)
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

main().catch((e) => {
  console.error(`sonar-rules-table: ${describe(e)}`)
  process.exitCode = 1
})
