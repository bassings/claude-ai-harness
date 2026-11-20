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
const REQUEST_TIMEOUT_MS = 8000
const RULE_KEY_RE = /^[A-Za-z0-9_.:-]{1,64}$/
const PLACEHOLDER = 'Rule name unavailable from the analyser; see the rule key'
const DAY_MS = 86_400_000

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

// Every issue query asks for unresolved issues only (AC-QA-2). One facet per
// query, ps=1: the request count never depends on the number of issues.
const issueFacet = (cfg, extra) => get(cfg, '/api/issues/search', { componentKeys: cfg.project, resolved: 'false', facets: 'rules', ps: '1', ...extra })

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
function facetCounts(body) {
  const out = new Map()
  const values = body?.facets?.find((f) => f.property === 'rules')?.values
  for (const v of Array.isArray(values) ? values : []) {
    if (typeof v?.val === 'string' && RULE_KEY_RE.test(v.val) && Number.isInteger(v.count) && v.count >= 0) out.set(v.val, v.count)
  }
  return out
}

// One physical line of inert text: no controls, escapes, bidi or zero-width
// characters, backticks or column separators, and never over GUIDANCE_CAP.
function sanitise(text) {
  const s = String(text)
    .replace(/\u001b\[[0-9;?]*[ -\/]*[@-~]/g, '')
    .replace(/[\u2028\u2029\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/[​-‏‪-‮⁠-⁩﻿`]/g, '')
    .replace(/\|/g, '/')
    .replace(/\s+/g, ' ')
    .trim()
  return Array.from(s).slice(0, GUIDANCE_CAP).join('').trim()
}

function readPrevious(file) {
  const prev = new Map()
  let st
  try {
    st = fs.lstatSync(file)
  } catch {
    return prev
  }
  if (!st.isFile() || st.size > BYTE_CAP) return prev
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.startsWith('|')) continue
    const c = line.split('|').slice(1, -1).map((x) => x.trim())
    if (c.length === 4 && RULE_KEY_RE.test(c[0])) prev.set(c[0], sanitise(c[1]))
  }
  return prev
}

function render(stamp, rows) {
  const body = rows.map((r) => `| ${r.key} | ${r.guidance} | ${r.open} | ${r.recent} |`)
  return ['# Analyser rules table', stamp, '', '| rule | guidance | open | recent-new |', '|---|---|---|---|', ...body].join('\n') + '\n'
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

function writeAtomically(dir, file, text) {
  fs.mkdirSync(dir, { recursive: true })
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

async function main() {
  const cfg = configure()
  if (cfg.warning) console.error(cfg.warning)
  const root = fs.realpathSync(process.cwd())
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
  const rev = analyses?.analyses?.[0]?.revision
  const revision = typeof rev === 'string' && /^[0-9a-f]{40}$/.test(rev) ? rev : 'unknown'

  const recentBody = await issueFacet(cfg, { createdAfter: since })
  const openBody = await issueFacet(cfg, {})
  const recent = facetCounts(recentBody)
  const open = facetCounts(openBody)
  const newIssues = Number.isInteger(recentBody.total) ? recentBody.total : 0
  const openTotal = Number.isInteger(openBody.total) ? openBody.total : 0

  const previous = readPrevious(file)
  let onListed = 0
  for (const [k, n] of recent) if (previous.has(k)) onListed += n

  // Recent-new first, then open count, then key: a rule new code just tripped
  // is never pushed out by an old backlog (AC-QA-9, AC-PROD-4).
  const all = [...new Set([...recent.keys(), ...open.keys()])]
    .map((key) => ({ key, recent: recent.get(key) || 0, open: open.get(key) || 0 }))
    .sort((a, b) => b.recent - a.recent || b.open - a.open || (a.key < b.key ? -1 : 1))
  let rows = all.slice(0, ROW_CAP)

  const notes = []
  for (const r of rows) {
    const kept = previous.get(r.key)
    if (kept) {
      r.guidance = kept
      continue
    }
    const found = await lookupRuleName(cfg, r.key)
    if (found.mismatch) notes.push(`rule name lookup mismatch for ${r.key}; using the rule key as guidance`)
    r.guidance = sanitise(found.mismatch ? r.key : found.name || '') || PLACEHOLDER
  }

  const stampFor = (n) => `derived: ${cfg.now.toISOString().replace(/\.\d{3}Z$/, 'Z')} revision: ${revision} analyser: SonarQube window: ${since}..${end} new-issues: ${newIssues} on-listed: ${onListed} open-total: ${openTotal} rules: ${n} of ${all.length}` + (newIssues === 0 ? ' note: zero rules were tripped in the window' : '')
  let text = render(stampFor(rows.length), rows)
  while (Buffer.byteLength(text) > BYTE_CAP && rows.length > 0) {
    rows = rows.slice(0, -1)
    text = render(stampFor(rows.length), rows)
  }

  writeAtomically(dir, file, text)

  const head = localHead(root)
  console.log(stampFor(rows.length))
  console.log(`wrote ${TABLE_REL}: ${rows.length} rules (window ${since}..${end}, analysed revision ${revision})`)
  if (revisionDenied) console.log('note: the token is not permitted to read the analysed revision; the revision is recorded as unknown')
  for (const n of notes) console.log(n)
  if (head && revision !== head) console.log(`note: the server has not yet analysed the current head (server revision ${revision}, local head ${head})`)
}

main().catch((e) => {
  console.error(e instanceof Fail ? `sonar-rules-table: ${e.message}` : `sonar-rules-table: unexpected ${e?.name || 'error'}`)
  process.exitCode = 1
})
