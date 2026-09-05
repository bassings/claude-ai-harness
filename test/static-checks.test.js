// Mechanical, diff-level checks for constraints that don't need a live agent
// to verify (the harness's own convention: AC-SIMP-<n> is checked directly
// against the diff, not by an agent lens).
const test = require('node:test')
const assert = require('node:assert/strict')
// This file shells out to git directly and does NOT build temp repos, so it
// never loads test/helpers/temp-repo.js and would not otherwise get that
// module's load-time git-environment scrub. node --test runs each test FILE
// in its own process, so the scrub is per-file, not per-suite. Without this
// import, a suite run from a context that exports GIT_DIR (a git hook
// invoked from a linked worktree) would point the git calls below at a
// different repository and the guards would silently verify the wrong tree
// -- a false green, which is the one outcome these static checks exist to
// prevent. See test/helpers/git-env.js.
require('./helpers/git-env.js').scrubGitEnv()
const { sanitizedGitEnv } = require('./helpers/git-env.js')

const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const crypto = require('node:crypto')

const ROOT = path.join(__dirname, '..')

function readAll(...parts) {
  return fs.readFileSync(path.join(ROOT, ...parts), 'utf8')
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else out.push(full)
  }
  return out
}

// PR2 note: these two checks originally enforced AC-SIMP-7 ("PR 1's diff
// contains no file whose path matches optimise-cycle") by scanning the LIVE
// tree, which was correct only while PR 2 did not exist yet. Now that
// workflows/optimise-cycle.js and skills/optimise-cycle/ are real,
// permanent, in-scope deliverables, a live-tree scan of this kind can never
// pass again -- it would forever fail as written, for a reason with no
// bearing on either PR's correctness. AC-SIMP-7 is a claim about the PR 1
// DIFF specifically: checking it against that commit's own file list, rather
// than the live tree, keeps the guard meaningful and lets it stay true
// forever, exactly like checking any other already-merged commit's shape.
//
// The commit is resolved by its SUBJECT, not by its hash. An earlier revision
// pinned d7eb2cc7e732cbab5c4d31441c04c6c037fa7cb9 and called it "immutable
// historical". It was not: on 2026-08-18 a git filter-branch run (purging a
// credential fingerprint from this public repo's history) renamed every
// commit, and this test began failing with "fatal: Not a valid object name"
// -- but only once the filter-branch backup refs were expired, because until
// then refs/original still made the old object reachable and the suite stayed
// green over a guard that was already broken. A commit hash is immutable only
// as long as nobody rewrites history, which is exactly the circumstance under
// which you most want your guards to still work. The subject survives a
// rewrite; the hash does not. Resolution asserts EXACTLY ONE match, so an
// ambiguous or missing anchor fails by name rather than silently checking
// some other commit. This also incidentally fixes a
// latent path-based bug in the original form: it matched the FULL absolute
// path, so running the suite from a checkout whose own directory name
// happens to contain "optimise-cycle" (e.g. a worktree named
// t2-optimise-cycle, as PR 2's own build happened in) made it fail
// regardless of repo contents -- git's own file list is always
// repo-relative, so that failure mode cannot recur here.
const PR1_SUBJECT_ANCHOR = '(PR 1 of HARN-OPT-1) (#1)'

test('static: PR1\'s merge commit (resolved by subject, not by hash) introduced no file whose path matches "optimise-cycle" (AC-SIMP-7, checked against the historical commit rather than the live tree, which now legitimately contains PR 2\'s optimiser files)', () => {
  const exec = require('node:child_process').execFileSync
  // --branches --remotes, deliberately NOT --all. --all includes
  // refs/original/, so during a filter-branch backup window BOTH the
  // rewritten and the original commit carry this subject and the
  // exactly-one assertion below hard-fails -- in precisely the operation this
  // resolution was written to survive. Note the symmetry: refs/original
  // previously kept a broken hash-pinned guard silently GREEN, and would now
  // keep a correct subject-pinned guard RED.
  const candidates = exec('git', ['log', '--branches', '--remotes', '--format=%H\t%s'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter((l) => l.includes(PR1_SUBJECT_ANCHOR))
  assert.strictEqual(
    candidates.length,
    1,
    `expected exactly one commit whose subject contains ${JSON.stringify(PR1_SUBJECT_ANCHOR)}; found ${candidates.length}. ` +
      'If the count is 0, history was rewritten or the subject changed: re-derive the anchor rather than pinning a hash. ' +
      'If the count is above 1, the likeliest cause is leftover history-rewrite backup refs (refs/original/) or a stale ' +
      'remote branch carrying the pre-rewrite commit; expire those rather than changing the anchor.'
  )
  const sha = candidates[0].split('\t')[0]
  const files = exec('git', ['show', '--name-only', '--format=', sha], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  assert.ok(files.length > 10, 'sanity: expected PR1\'s merge commit to list many changed files')
  assert.ok(!files.some((f) => /optimise-cycle/.test(f)), `PR1's merge commit must not have introduced an optimise-cycle path; found: ${files.filter((f) => /optimise-cycle/.test(f))}`)
})

test('static: none of the three ORIGINAL instrumented workflows (tdd-task.js, review-cycle.js, plan-cycle.js), hooks/, or conduct-plan/SKILL.md reference the optimiser -- the dependency edge points one way (AC-ARCH-8) and no per-PR path invokes it (AC-PROD-10). The optimiser\'s OWN files (workflows/optimise-cycle.js, skills/optimise-cycle/) necessarily mention their own name and are excluded from this scan, same as this test file and workflows/lib/ledger-append.mjs are excluded for citing the spec path as a documentation source.', () => {
  const targets = [
    'workflows/tdd-task.js',
    'workflows/review-cycle.js',
    'workflows/plan-cycle.js',
    'workflows/lib/ledger-append.mjs',
    'skills/conduct-plan/SKILL.md',
    ...(fs.existsSync(path.join(ROOT, 'hooks')) ? walk(path.join(ROOT, 'hooks')).map((f) => path.relative(ROOT, f)) : []),
  ]
  for (const rel of targets) {
    const full = path.join(ROOT, rel)
    if (!fs.existsSync(full)) continue
    const contents = fs.readFileSync(full, 'utf8').replaceAll('specs/optimise-cycle.md', '')
    assert.ok(!/optimise-cycle|optimize-cycle|optimiser|optimizer/i.test(contents), `${rel} must not reference the optimiser: the dependency edge points one way (AC-ARCH-8) and nothing per-PR may invoke it (AC-PROD-10)`)
  }
})

test('static: no dependency manifest exists anywhere in the repo (AC-SIMP-1: no new runtime dependency)', () => {
  const all = walk(ROOT)
  const manifests = all.filter((f) => /package\.json$|requirements.*\.txt$|Cargo\.toml$|Gemfile$/.test(f))
  assert.deepEqual(manifests, [])
})

test('static: the three instrumented workflow scripts contain no EXECUTABLE import, Date.now(), new Date() or Math.random() (the runtime statically rejects all four before execution; mentioning them in a // comment, e.g. explaining why, is fine). workflows/lib/ledger-append.mjs is deliberately EXCLUDED: it is real, unsandboxed Node code and is expected to use all four.', () => {
  for (const f of ['workflows/tdd-task.js', 'workflows/review-cycle.js', 'workflows/plan-cycle.js']) {
    const code = readAll(f)
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, ''))
      .join('\n')
    assert.ok(!/^\s*import\b/m.test(code), `${f} contains an import declaration, which production statically rejects`)
    assert.ok(!/\bimport\s*\(/.test(code), `${f} contains a dynamic import(), which production statically rejects`)
    assert.ok(!/Date\.now\(\)/.test(code), `${f} contains executable Date.now()`)
    assert.ok(!/new Date\(/.test(code), `${f} contains executable new Date(`)
    assert.ok(!/Math\.random\(\)/.test(code), `${f} contains executable Math.random()`)
  }
})

// ---------------------------------------------------------------------------
// Leak guard. Scans EVERY TRACKED FILE, minus the exemption table below.
//
// Round-two review, M1. This guard's file list has now been wrong three times
// running: it shipped covering workflows/skills/docs; agents/ was added when a
// leak was caught by hand; AGENT-HARNESS.md and README.md were added the round
// after; and review round two then found hooks/ still open, along with
// .claude-plugin/, .githooks/ and .github/. That is not three bugs, it is one
// wrong shape, and CLAUDE.md section 12 says to re-open the approach rather
// than spend another round on the next patch.
//
// The wrong shape was an ALLOWLIST of directories to scan, which has to be
// kept in step by hand with the set of files that ship. Every new directory
// was covered only if somebody remembered. Inverted: everything git tracks is
// scanned, and anything not scanned must earn a line in EXEMPTIONS saying
// which patterns it skips and why. A new directory is now covered the day it
// is created, and the failure mode flips from a silent gap to a visible,
// argued exemption. It also ends the second duplication the same review named:
// there is one file set and one pattern list, both consumed by this one test.
//
// Inverting it immediately found a real leak nothing had ever looked at: a
// path-traversal fixture in test/optimise-read.test.js used the operator's
// actual account name instead of a synthetic one, in a public repo. Fixed in
// the same commit.
const LEAK_PATTERNS = [
  { key: 'users', name: 'an absolute /Users/ path', re: /\/Users\/[a-zA-Z0-9_.-]/ },
  { key: 'volumes', name: 'an absolute /Volumes/ path', re: /\/Volumes\/[a-zA-Z0-9_.-]/ },
  { key: 'home', name: 'an absolute /home/<name> path', re: /\/home\/[a-zA-Z0-9_.-]/ },
  // ONE repo-name rule, and it is HYGIENE, not secrecy.
  //
  // Owner ruling, 2026-09-04: neither delivery repo's NAME is confidential.
  // CouchPotatoServer is a public repo (`gh repo view`, verified same day),
  // and Scott ruled that the other name is not confidential either, having
  // been shown that it appears 27 times across three tracked specs published
  // since 2026-08-17. The guard previously asserted the opposite while specs/
  // published the name openly one directory across; that contradiction is now
  // resolved in favour of what the repo actually does.
  //
  // The rule that REMAINS, and why it is not merely decoration: workflows/,
  // skills/, agents/, hooks/ and bin/ are GENERIC and ship to every consumer
  // verbatim. A generic harness file naming one particular delivery repo is a
  // defect regardless of whether that name is secret, because it hardcodes one
  // installation's world into everybody's copy. That is the leak this clause
  // actually caught on 2026-09-04, in a review-cycle.js comment. Documentation
  // that cites a repo as a worked example (AGENT-HARNESS.md, README.md,
  // specs/) is exempt, because naming the case is the point there.
  //
  // NOT ruled on, and deliberately out of this guard's scope: those specs also
  // describe that system's CI, production setup and settings. A name being
  // non-confidential says nothing about the operational detail beside it, and
  // no pattern here would catch that anyway. Raised with the owner separately.
  { key: 'target-repo', name: 'a specific target repo', re: /said.?of.?you|couchpotato/i },
]

// The literal placeholder an install instruction is SUPPOSED to contain.
// Stripped before matching rather than exempting the whole /Users/ clause: a
// file allowed to say "/Users/YOUR_USERNAME" must still be caught if it says
// "/Users/scott.b". An exemption that turns a clause off entirely is the
// difference between a documented placeholder and a real leak going unnoticed.
const PLACEHOLDER_RE = /\/Users\/YOUR_USERNAME/g

// Every gap in the scan, stated. `paths` are repo-relative prefixes; `skip`
// names the pattern keys waived, and `why` has to be a reason, not a shrug.
// Adding a line here is the deliberate act that adding a directory to the old
// allowlist never was.
const EXEMPTIONS = [
  {
    paths: ['AGENT-HARNESS.md', 'README.md'],
    skip: ['target-repo'],
    placeholder: true,
    why: 'Both cite the PUBLIC CouchPotatoServer as a worked example, and both carry the literal /Users/YOUR_USERNAME placeholder in install instructions. Only that exact placeholder is stripped, so a REAL /Users/<operator> path in either file still fails.',
  },
  {
    paths: ['bin/com.local.optimise-cycle-weekly.plist'],
    skip: [],
    placeholder: true,
    why: 'A launchd template that deliberately contains /Users/YOUR_USERNAME, asserted by its own test below.',
  },
  {
    paths: ['test/'],
    skip: ['users', 'volumes', 'home', 'target-repo'],
    placeholder: false,
    // Declared blanket exemption. This directory is scanned for nothing, and
    // saying so out loud is the point: after the two repo-name patterns merged
    // under the 2026-09-04 owner ruling, test/'s four waivers became every
    // pattern there is, and the exemption-table check below caught it rather
    // than letting a whole directory quietly fall out of the scan. Kept as a
    // blanket rather than trimmed, because each waiver is individually
    // justified (see why) and pretending otherwise would be theatre.
    blanket: true,
    why: 'Fixtures deliberately contain hostile-looking absolute paths (path traversal, injection) and repo names, as test DATA. They are never installed anywhere. Still: use a synthetic account name (some-operator, victim) rather than a real one. A fixture using this operator\'s actual username is how the one real leak in this repo was found, on 2026-09-04.',
  },
  {
    paths: ['specs/'],
    skip: ['target-repo'],
    placeholder: true,
    why: 'Specs are written FROM real incidents in real repos, so naming the repo is the point rather than an accident, exactly as it is in AGENT-HARNESS.md and README.md. Owner ruling 2026-09-04: neither delivery repo name is confidential, which resolved a contradiction where this guard treated the string as unshippable while specs/ published it openly. The /Volumes/ and /home/ clauses are NOT waived, and the users waiver only covers the YOUR_USERNAME placeholder convention these docs share. What this exemption does NOT cover, and what no pattern here could: those specs also describe a delivery system\'s CI, production setup and settings allow-list. That is a judgement about operational detail, raised with the owner separately, not something a regex decides.',
  },
]

function exemptionFor(rel) {
  return EXEMPTIONS.find((e) => e.paths.some((p) => (p.endsWith('/') ? rel.startsWith(p) : rel === p)))
}

function trackedFiles() {
  const out = spawnSync('git', ['-C', ROOT, 'ls-files', '-z'], { encoding: 'utf8', env: sanitizedGitEnv() })
  assert.equal(out.status, 0, `git ls-files failed: ${out.stderr}`)
  const files = out.stdout.split('\0').filter(Boolean)
  // A guard that scans nothing passes. This is the "absence reads as success"
  // shape the harness exists to catch, so the floor is asserted explicitly.
  assert.ok(files.length > 50, `expected the repo to track more than 50 files, got ${files.length} -- a scan of nothing passes trivially`)
  return files
}

test('static: NO tracked file leaks an absolute /Users/, /Volumes/ or /home/<name> path or a private target repo name, outside the explicitly recorded EXEMPTIONS (AC-ARCH-9, inverted round-two review M1)', () => {
  let scanned = 0
  for (const rel of trackedFiles()) {
    const abs = path.join(ROOT, rel)
    if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) continue
    const raw = fs.readFileSync(abs)
    // Skip binaries: a NUL byte in the first 4KB is the usual heuristic.
    if (raw.subarray(0, 4096).includes(0)) continue
    const ex = exemptionFor(rel) || { skip: [], placeholder: false }
    const text = ex.placeholder ? raw.toString('utf8').replace(PLACEHOLDER_RE, '/Users/') : raw.toString('utf8')
    scanned += 1
    for (const { key, name, re } of LEAK_PATTERNS) {
      if (ex.skip.includes(key)) continue
      assert.ok(!re.test(text), `${rel} hardcodes ${name}. If that is deliberate, add it to EXEMPTIONS with a reason; do not widen the pattern.`)
    }
  }
  assert.ok(scanned > 50, `only ${scanned} files were actually scanned`)
})

test('static: every EXEMPTIONS entry names a real tracked path, waives only known pattern keys, and gives a reason -- so a stale or blanket exemption cannot quietly hide a whole directory', () => {
  const tracked = trackedFiles()
  const keys = LEAK_PATTERNS.map((p) => p.key)
  for (const e of EXEMPTIONS) {
    for (const p of e.paths) {
      const matches = p.endsWith('/') ? tracked.some((f) => f.startsWith(p)) : tracked.includes(p)
      assert.ok(matches, `EXEMPTIONS names ${p}, which no tracked file matches -- a stale exemption is a gap nobody is watching`)
    }
    for (const k of e.skip) {
      assert.ok(keys.includes(k), `EXEMPTIONS waives unknown pattern key ${k}`)
    }
    // A blanket exemption is allowed, but only when DECLARED. The failure this
    // prevents is an entry that waives everything by accident -- one more key
    // added to skip, or a pattern list that shrinks underneath it -- leaving a
    // directory unscanned with nobody aware. Declaring it costs one field and
    // makes the gap visible in review.
    if (e.skip.length >= keys.length) {
      assert.equal(e.blanket, true, `EXEMPTIONS for ${e.paths.join(', ')} waives every pattern, which is the same as not scanning it at all. If that is intended, set blanket: true so it is a stated decision rather than an accident.`)
    } else {
      assert.ok(e.blanket === undefined, `EXEMPTIONS for ${e.paths.join(', ')} declares blanket: true but does not actually waive every pattern -- a stale declaration hides how much is really covered`)
    }
    assert.ok(typeof e.why === 'string' && e.why.length > 40, `EXEMPTIONS for ${e.paths.join(', ')} needs a real reason, not a shrug`)
  }
})

// The separate bin/ leak guard that used to live here is GONE, subsumed by the
// whole-repo scan above. It was added by subtraction round item 9 after
// bin/optimise-cycle-weekly.sh was found hardcoding two repo names and this
// operator's volume layout in a tracked file in a PUBLIC repo. bin/ is still
// scanned, now by the same single guard as everything else: with nothing
// outside the scan, a second near-duplicate guard is exactly the divergence
// that produced round-two M1.

test('static: the ledger envelope field list appears in exactly one file (AC-ARCH-5). It lives in workflows/lib/ledger-append.mjs, not a separate ledger.mjs: workflow scripts cannot import anything, so the envelope owner must be the real-Node script they invoke via Bash, not a module they pull in.', () => {
  const all = [...walk(path.join(ROOT, 'workflows')), ...walk(path.join(ROOT, 'skills'))]
  const definitionSites = all.filter((f) => {
    const contents = fs.readFileSync(f, 'utf8')
    return contents.includes('LEDGER_ENTRY_SCHEMA') && contents.includes('additionalProperties')
  })
  assert.deepEqual(definitionSites.map((f) => path.relative(ROOT, f)), ['workflows/lib/ledger-append.mjs'])
})

test('static: plan-identity canonicalisation (canonicalPlanKey) has exactly one definition site (AC-ARCH-1), mirroring the LEDGER_ENTRY_SCHEMA single-definition-site test above -- only workflows/lib/ledger-append.mjs defines it; every other caller (workflows/lib/optimise-read.mjs) imports it rather than re-declaring a second normalisation implementation of its own.', () => {
  const all = [...walk(path.join(ROOT, 'workflows')), ...walk(path.join(ROOT, 'skills'))]
  const definitionSites = all.filter((f) => /\bfunction\s+canonicalPlanKey\s*\(/.test(fs.readFileSync(f, 'utf8')))
  assert.deepEqual(definitionSites.map((f) => path.relative(ROOT, f)), ['workflows/lib/ledger-append.mjs'])
})

function allIndicesOf(text, needle) {
  const out = []
  let idx = text.indexOf(needle)
  while (idx !== -1) {
    out.push(idx)
    idx = text.indexOf(needle, idx + 1)
  }
  return out
}

// MED-7 (round-one review): the needle used to be "'agents/lens-*.md'",
// JS-single-quoted -- it could only ever match a JS string literal
// wrapped in single quotes, so a genuine second definition written the
// way bash actually writes one (e.g. a double-quoted shell variable
// assignment: SUBSET_PATTERNS="AGENT-HARNESS.md agents/lens-*.md ...")
// passed this guard clean. Proven by planting exactly that in
// bin/optimise-cycle-weekly.sh: 44/44 static tests stayed green, AC-OPS-5
// included.
//
// The fix is two bare needles (no quote characters of their own, so
// either matches regardless of how the target file quotes or embeds it),
// requiring BOTH to appear within PROXIMITY characters of EACH OTHER
// somewhere in the file -- not merely "the file mentions this glob
// somewhere". A single quote-agnostic needle alone over-matched: this
// module's own H3-guard prose comments and error-message template
// mention "agents/lens-*.md" (workflows/plan-cycle.js, workflows/review-
// cycle.js -- a completely unrelated concern, the findings-schema
// consistency check, not the consumer subset), which is a false positive
// a bare single-needle .includes() cannot distinguish from a genuine
// second pattern-list definition. "agents/reviewer-*.md" never appears
// anywhere near an "agents/lens-*.md" mention in ordinary prose (nothing
// in this repo's prose has reason to name both globs back to back), so
// requiring their PROXIMITY, rather than either alone, is what actually
// characterises "a list like this one", in any quoting style, while still
// excluding the unrelated prose.
test('static: the consumer-subset pattern list (AC-OPS-5, specs/harn-fix-3.md task 2) has exactly one definition site, in ANY quoting style -- only workflows/lib/install-consistency.mjs declares CONSUMER_SUBSET_PATTERNS; bin/optimise-cycle-weekly.sh (bash, cannot import) drives the whole comparison through that module\'s --check-staleness CLI mode instead of hardcoding a second copy of the pattern list.', () => {
  const all = [...walk(path.join(ROOT, 'workflows')), ...walk(path.join(ROOT, 'bin')), ...walk(path.join(ROOT, 'agents')), ...walk(path.join(ROOT, 'hooks')), ...walk(path.join(ROOT, 'skills'))]
  const NEEDLE_A = 'agents/lens-*.md' // no surrounding quote characters -- see the MED-7 comment above
  const NEEDLE_B = 'agents/reviewer-*.md'
  const PROXIMITY = 100
  const definitionSites = all.filter((f) => {
    const text = fs.readFileSync(f, 'utf8')
    const positionsA = allIndicesOf(text, NEEDLE_A)
    const positionsB = allIndicesOf(text, NEEDLE_B)
    return positionsA.some((a) => positionsB.some((b) => Math.abs(a - b) <= PROXIMITY))
  })
  assert.deepEqual(definitionSites.map((f) => path.relative(ROOT, f)), ['workflows/lib/install-consistency.mjs'])
})

test('static: ledger-append.mjs is INVOKED by at least two workflows (AC-SIMP-12, arbitrated: "imported by >=2 files" becomes "invoked by >=2 workflows" for a script workflow scripts can only run via Bash, never import)', () => {
  const invokers = ['workflows/tdd-task.js', 'workflows/review-cycle.js', 'workflows/plan-cycle.js'].filter((f) =>
    readAll(f).includes('ledger-append.mjs')
  )
  assert.ok(invokers.length >= 2, `expected >=2 invokers, got ${invokers.length}`)
})

test('static: no workflow-lib file has lifecycle machinery for the ledger -- no rotation, compaction, pruning, size cap or schema-version migration code (AC-SIMP-4)', () => {
  const contents = readAll('workflows', 'lib', 'ledger-append.mjs')
  assert.ok(!/rotat|compact|prune|migrat/i.test(contents), 'ledger-append.mjs appears to contain lifecycle machinery')
})

test('static: no workflow script directly under workflows/ (not workflows/lib/) contains an import statement, static or dynamic (production statically rejects both before execution -- see specs/optimise-cycle.md "Verified runtime facts" in the main checkout)', () => {
  const directChildren = fs.readdirSync(path.join(ROOT, 'workflows'), { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.js'))
    .map((e) => path.join(ROOT, 'workflows', e.name))
  assert.ok(directChildren.length > 0, 'sanity: expected at least one workflow script')
  for (const f of directChildren) {
    const code = fs.readFileSync(f, 'utf8').split('\n').map((line) => line.replace(/\/\/.*$/, '')).join('\n')
    assert.ok(!/^\s*import\b/m.test(code), `${f} contains a static import declaration`)
    assert.ok(!/\bimport\s*\(/.test(code), `${f} contains a dynamic import() call`)
  }
})

test('static: conduct-plan/SKILL.md instructs logging CI-wait, human-wait, PR-raised and PR-merged events to the ledger, names event_key as required, and documents an occurrence discriminator in the key (AC-QA-9, M3; behavioural correctness of a prose skill is NOT exercised by this test, only its presence in the instructions)', () => {
  const skill = readAll('skills', 'conduct-plan', 'SKILL.md')
  for (const event of ['ci_wait_started', 'ci_wait_ended', 'human_wait_started', 'human_wait_ended', 'pr_raised', 'pr_merged']) {
    assert.ok(skill.includes(event), `SKILL.md must mention the ${event} event`)
  }
  assert.ok(skill.includes('ledger-append.mjs'))
  assert.ok(/event_key/.test(skill), 'SKILL.md must mention event_key')
  assert.ok(/occurrence/i.test(skill), 'M3: the documented key format must include an occurrence discriminator, since the same event can genuinely repeat for one task')
  assert.ok(/idempotent|no-op|duplicate/i.test(skill), 'SKILL.md must state that a replayed event_key does not double-count')
})

// Fix round 1, finding 10: the prior_findings pass-through is the single
// point where specs/record-fixed-findings.md's 'fixed' disposition feature
// is either used or silently never used by a real conductor -- it lives in
// prose a Claude agent reads, not in code a test can execute, and had NO
// test at all naming it. This cannot prove any given conductor run obeys
// the instruction (that is inherent to a prose instruction governing a
// judgement call), but it does prove the instruction itself is not
// silently deleted from the file by a future edit -- the one thing a
// static test on prose CAN prove.
test('static: conduct-plan/SKILL.md instructs passing prior_findings to review-cycle from round two onward, names the ledger disposition it produces, and states plainly what the resulting number does and does not mean (specs/record-fixed-findings.md, fix round 1 finding 10)', () => {
  const skill = readAll('skills', 'conduct-plan', 'SKILL.md')
  assert.ok(skill.includes('prior_findings'), 'SKILL.md must mention prior_findings by name')
  assert.ok(/round two/i.test(skill), 'SKILL.md must say when to start passing it')
  // Fix round 3, finding 4: a bare skill.includes('fixed') is satisfied by ANY
  // mention of the word anywhere in the file (e.g. main's own unrelated "a fixed
  // out-of-repo marker"), so this assertion could never fail even if every real
  // reference to the disposition were deleted. Anchored on the exact phrase the
  // file actually uses to name it.
  assert.ok(/disposition:\s*'fixed'/.test(skill), 'SKILL.md must name the disposition this produces, not merely contain the word "fixed" somewhere')
  assert.ok(/undercount/i.test(skill), 'SKILL.md must state plainly that the resulting number can undercount')
  assert.ok(/accumulate|only the findings/i.test(skill), 'SKILL.md must warn against re-supplying an already-confirmed finding on a later round')
})

// Fix round 2, AC-5 (specs/record-fixed-findings.md; renumbered from AC-7 in fix round 3 -- AC-7 collided with the original brief's own "suite green" AC-7, see the spec's Acceptance criteria intro): the prior_findings
// instruction must be MECHANICAL steps, the same style as the ledger-write
// instruction eight lines below it -- not prose describing intent. Checks
// for the concrete markers a mechanical instruction has that prose does
// not: numbered steps, an exact field name to read the result from
// (open_findings, never the markdown report), and an explicit
// verbatim/byte-for-byte instruction not to retype or recompute the id.
test('static: conduct-plan/SKILL.md\'s prior_findings instruction is MECHANICAL (numbered steps, an exact field name, an explicit verbatim/byte-for-byte requirement), not prose describing intent (specs/record-fixed-findings.md, fix round 2, AC-5)', () => {
  const skill = readAll('skills', 'conduct-plan', 'SKILL.md')
  assert.ok(skill.includes('open_findings'), 'SKILL.md must name the exact field to read the ids from')
  assert.ok(/verbatim|byte-for-byte/i.test(skill), 'SKILL.md must instruct passing the value through unmodified')
  // Fix round 3, finding 4: the `||` fallback reduced to "the file contains the
  // word markdown somewhere", satisfied by an unrelated ```` ```markdown ````
  // fence -- deleting the whole clause this assertion exists to pin left this
  // test, and the suite, green. Dropped; the regex alone is the real check.
  assert.ok(/never\s+the\s+markdown\s+`report`/i.test(skill), 'SKILL.md must distinguish the structured return value from the markdown report')
  // Numbered steps: at least "1." and "2." appearing near the prior_findings instruction.
  // Window widened fix round 4 (6000, was 2500): the fix round 4 ensure-ignored
  // paragraph and its own lettered (a/b/c) sub-steps -- also mechanical, not
  // prose -- now sit between the marker and the "1." numbered list.
  const idx = skill.indexOf('Mechanical steps for `prior_findings`')
  assert.ok(idx !== -1, 'SKILL.md must introduce the mechanical steps explicitly')
  const nearby = skill.slice(idx, idx + 6000)
  assert.ok(nearby.includes('1.') && nearby.includes('2.') && nearby.includes('3.'), 'the instruction must be numbered steps, not a paragraph')
})

// Fix round 3, finding 1 (HIGHEST, privacy regression): the conductor's
// prior_findings state (lens location/claim VERBATIM, potentially a
// secret or a quoted source line) must never reach a TRACKED file. Proven
// two ways: the real .gitignore pattern genuinely matches via a real `git
// check-ignore` (not merely present as text -- a malformed pattern would
// pass a naive .includes() check and still fail to ignore anything), and
// SKILL.md instructs writing to that exact untracked path, never to the
// plan file's own (tracked) Conductor log.
test('static: .claude/conductor-prior-findings.json (the conductor\'s prior_findings state, which carries lens location/claim verbatim) is genuinely gitignored, confirmed by a real git check-ignore, not merely listed as text (specs/record-fixed-findings.md, fix round 3, finding 1)', () => {
  const gitignore = readAll('.gitignore')
  assert.ok(gitignore.includes('.claude/conductor-prior-findings.json'), '.gitignore must list the file')
  const res = spawnSync('git', ['check-ignore', '-q', '.claude/conductor-prior-findings.json'], { cwd: ROOT, env: sanitizedGitEnv() })
  assert.equal(res.status, 0, 'git check-ignore must exit 0 -- the pattern must genuinely match, not just appear as text in the file')
})

// Fix round 4, finding 1: this repo's own .gitignore entry (the test just
// above) is real, but it is a property of claude-ai-harness alone -- it
// never installs into a delivery repo, so a conductor running anywhere
// else previously found this path untracked but NOT ignored. SKILL.md must
// no longer rest on that entry; it must instruct the same per-repo
// ensure-ignored mechanism the run ledger and the optimiser's own report
// already use (workflows/lib/optimise-report-ignore.mjs), and refuse to
// write when that mechanism does not confirm the path is ignored. Presence
// only: the behavioural proof that this mechanism actually works in a
// throwaway repo that is NOT claude-ai-harness, and the mutation-resistant
// checks for fix round 3's own two bypasses, live in
// test/conduct-plan-prior-findings-protection.test.js (deliberately
// separate -- this file never builds temp repos, see its own header).
test('static: conduct-plan/SKILL.md no longer rests its privacy protection on this repo\'s own .gitignore -- it names the real per-repo ensure-ignored mechanism (optimise-report-ignore.mjs + a real git check-ignore) and instructs refusing to write when it fails (specs/record-fixed-findings.md, fix round 4, finding 1)', () => {
  const skill = readAll('skills', 'conduct-plan', 'SKILL.md')
  assert.ok(skill.includes('.claude/conductor-prior-findings.json'), 'SKILL.md must name the untracked state file')
  assert.ok(skill.includes('optimise-report-ignore.mjs'), 'SKILL.md must name the real ensure-ignored mechanism')
  assert.ok(/check-ignore/.test(skill), 'SKILL.md must mention verifying with a real git check-ignore')
  assert.ok(/do not write|refus/i.test(skill), 'SKILL.md must instruct refusing to write when the path is not confirmed ignored')
  assert.ok(/never install|does not install|not.*install.*gitignore|\.gitignore.*never/i.test(skill), 'SKILL.md must state plainly that the harness install does not carry .gitignore into a delivery repo')
})

// Fix round 3, finding 3 (specs/record-fixed-findings.md): review-cycle.js's
// own whenToUse (the sentence a model reads when deciding how to call this
// workflow) and its prior_findings code comment must document `id` as a
// REQUIRED field on each prior_findings entry -- they drifted to the
// pre-AC-3 shape ({lens, location, claim, severity?, ac_id?}, no id) after
// AC-3 made id mandatory, so a caller built exactly to the documented
// contract silently produced zero fixed entries with no error, only two
// counters as the trace.
test('static: review-cycle.js\'s whenToUse documents id as a REQUIRED field on prior_findings entries, not the pre-AC-3 optional shape (specs/record-fixed-findings.md, fix round 3, finding 3)', () => {
  const src = readAll('workflows', 'review-cycle.js')
  const whenToUseMatch = src.match(/whenToUse:\s*'([^']*(?:\'[^']*)*)'/)
  assert.ok(whenToUseMatch, 'expected to find the whenToUse string literal')
  const whenToUse = whenToUseMatch[1]
  const priorIdx = whenToUse.indexOf('prior_findings?:')
  assert.ok(priorIdx !== -1, 'whenToUse must document prior_findings')
  const priorClause = whenToUse.slice(priorIdx, priorIdx + 400)
  assert.ok(/\{id,\s*lens/.test(priorClause), `whenToUse's prior_findings shape must lead with id, got: ${priorClause}`)
  assert.ok(/id is REQUIRED/i.test(priorClause), 'whenToUse must say id is required, not merely list it as one field among optional ones')
})

test('static: AGENT-HARNESS.md\'s ledger paragraph carries the absolute-timestamp justification and the git-history survival clause, not just README.md (L3, AC-SEC-3/AC-SEC-4)', () => {
  const doc = readAll('AGENT-HARNESS.md')
  assert.ok(/timestamp/i.test(doc), 'AGENT-HARNESS.md must justify why an absolute timestamp is retained')
  assert.ok(/git\s+history/i.test(doc), 'AGENT-HARNESS.md must state that a deliberately committed line survives in git history')
})

test('static: README.md\'s "Delete it" instruction also states that the next run recreates the ledger and there is no off switch (L12, AC-PROD-9)', () => {
  const readme = readAll('README.md')
  const deleteIdx = readme.indexOf('Delete it')
  assert.ok(deleteIdx !== -1, 'expected a "Delete it" instruction in README.md')
  const nearby = readme.slice(deleteIdx, deleteIdx + 400)
  assert.ok(/recreates it|recreated/i.test(nearby), 'must state that the next run recreates the deleted ledger, near the delete instruction')
  assert.ok(/no (way to|setting)|no off switch|cannot.*opt/i.test(nearby), 'must state there is no way to turn ledger writes off, near the delete instruction')
})

test('static: README.md\'s Retention note states that git clean -xdf deletes the ledger (it is gitignored) and how to keep it, and records the AC-DATA-4/AC-SEC-1 arbitration explicitly, not just in a test comment (round 3 LOW)', () => {
  const readme = readAll('README.md')
  assert.ok(/git clean -xdf/.test(readme), 'README.md must mention git clean -xdf by name')
  const cleanIdx = readme.indexOf('git clean -xdf')
  const nearby = readme.slice(cleanIdx, cleanIdx + 500)
  assert.ok(/delete|remove/i.test(nearby), 'must state that git clean -xdf deletes/removes the ledger')
  assert.ok(/-e |exclude|move it outside/i.test(nearby), 'must state how to keep the ledger through a git clean -xdf')
  assert.ok(/arbitration/i.test(readme), 'README.md must record the AC-DATA-4/AC-SEC-1 conflict as an explicit arbitration, not just in a test comment')
  assert.ok(/AC-DATA-4/.test(readme) && /AC-SEC-1/.test(readme), 'the arbitration must name both conflicting ACs')
})

test('static: README.md\'s Retention paragraph states the ledger is a single local copy, that nothing backs it up or replicates it, that it is lost with the main checkout, and names the condition under which that would be revisited (round-2 M5, AC-DATA-17)', () => {
  const readme = readAll('README.md')
  assert.ok(/single local copy|only copy/i.test(readme), 'README.md must state the ledger is the single/only local copy')
  assert.ok(/not backed up|no backup|nothing\s+backs it up/i.test(readme), 'README.md must state nothing backs up the ledger')
  assert.ok(/lost\s+(along with|with|if)\s+the\s+main\s+checkout/i.test(readme), 'README.md must state the ledger is lost if the main checkout is lost')
  assert.ok(/cloud-reachable|revisit/i.test(readme), 'README.md must name the condition under which the no-backup decision would be revisited')
})

test('static: README.md does NOT claim the ledger is removed by worktree deletion -- it resolves to the MAIN checkout root via git-common-dir, so removing a linked worktree never removes it (round-2 M5, AC-DATA-17 worktree-deletion clause was factually wrong)', () => {
  const readme = readAll('README.md')
  assert.ok(!/removed by worktree deletion|worktree deletion removes|deleting a worktree removes/i.test(readme), 'README.md must not claim the ledger is removed by worktree deletion -- it lives at the main checkout root and survives it')
  assert.ok(/survives (a |linked )?worktree|worktree removal (does not|never)/i.test(readme), 'README.md must state the ledger SURVIVES worktree removal, since it resolves to the main checkout root')
})

test('static: README.md names the step that refreshes the installed ~/.claude/workflows/lib mirror after a workflows/lib change, and gives an exact command that confirms the installed copy matches the repo (AC-OPS-4)', () => {
  const readme = readAll('README.md')
  assert.ok(/AC-OPS-4/.test(readme), 'README.md must record this under its AC-OPS-4 heading')
  assert.ok(/cp -r claude-ai-harness\/workflows\/lib\/\. ~\/\.claude\/workflows\/lib\//.test(readme), 'README.md must give the exact re-sync command for workflows/lib specifically')
  assert.ok(/diff -rq claude-ai-harness\/workflows\/lib ~\/\.claude\/workflows\/lib/.test(readme), 'README.md must give an exact command that confirms the installed copy matches the repo')
  assert.ok(/schemaVersionsSeen/.test(readme), 'README.md must state that a stale mirror is also detectable from the report\'s per-repo schema_version mix')
})

// Review round-1 H3: PR2's entire fix lives in three TOP-LEVEL workflow
// scripts (tdd-task.js, review-cycle.js, plan-cycle.js), which the
// installed mirror ALSO copies (`~/.claude/workflows/*.js`, not just
// `workflows/lib/`) -- but the AC-OPS-4 section above only ever documented
// re-syncing workflows/lib/. An operator following it exactly would get a
// clean exit 0 while the live top-level copies kept crashing without
// terminal records. Also: PR2 bumps no SCHEMA_VERSION and adds no ledger
// field, so the schemaVersionsSeen-based staleness signal above does NOT
// detect a stale top-level workflow script -- that must be stated
// honestly, not implied to be covered.
test('static: README.md\'s AC-OPS-4 section ALSO covers the whole workflows/ tree (not just workflows/lib/), names the three top-level workflow scripts explicitly, and states that the schema_version staleness signal does not detect a stale top-level script (H3)', () => {
  const readme = readAll('README.md')
  assert.ok(/cp -r claude-ai-harness\/workflows\/\. ~\/\.claude\/workflows\//.test(readme), 'README.md must give a whole-tree re-sync command covering the top-level workflow scripts too')
  assert.ok(/diff -rq claude-ai-harness\/workflows ~\/\.claude\/workflows\b/.test(readme), 'README.md must give a whole-tree verification command')
  for (const f of ['tdd-task.js', 'review-cycle.js', 'plan-cycle.js']) {
    assert.ok(readme.includes(f), `README.md must name ${f} explicitly in the AC-OPS-4 section`)
  }
  const opsIdx = readme.indexOf('AC-OPS-4')
  const section = readme.slice(opsIdx, opsIdx + 3000)
  assert.ok(
    /does not|never|not detect|no signal/i.test(section) && /schema_version|SCHEMA_VERSION/.test(section),
    'README.md must state honestly that the schema_version-based staleness signal does not cover a stale TOP-LEVEL workflow script (PR2 bumped no schema version)'
  )
})

test('static: L5 -- the inlined run-ledger invocation block (readBudgetSpent, ledgerWritePrompt, writeLedger) is byte-identical across all three workflow files. Workflow scripts cannot import, so this trio is necessarily duplicated three times; without a guard pinning them, a fix landed in one or two copies fails silently in the third -- the same failure class as C1.', () => {
  function extractBlock(fileName) {
    const contents = readAll('workflows', fileName)
    const lines = contents.split('\n')
    const start = lines.findIndex((l) => l.startsWith('// Reads budget.spent() defensively'))
    const end = lines.findIndex((l, i) => i > start && l.startsWith('// The entire pre-existing workflow body'))
    assert.ok(start >= 0 && end > start, `${fileName}: could not locate the run-ledger helper block markers`)
    return lines.slice(start, end).join('\n')
  }
  const tdd = extractBlock('tdd-task.js')
  const review = extractBlock('review-cycle.js')
  const plan = extractBlock('plan-cycle.js')
  assert.ok(tdd.length > 500, 'sanity: the extracted block should be substantial, not an empty match')
  assert.equal(review, tdd, 'review-cycle.js\'s run-ledger helper block has drifted from tdd-task.js\'s')
  assert.equal(plan, tdd, 'plan-cycle.js\'s run-ledger helper block has drifted from tdd-task.js\'s')
})

// specs/harn-fix-3.md AC-QA-1..4: the install-consistency preflight block
// (INSTALL_CONSISTENCY_INSTRUCTION, INSTALL_CONSISTENCY_SCHEMA,
// installConsistencyError) is necessarily duplicated between plan-cycle.js
// and review-cycle.js -- workflow scripts cannot import, mirroring the L5
// run-ledger trio above. Without a guard pinning them, a fix (e.g. a wording
// correction, a new schema field) landed in one copy and not the other fails
// silently, exactly the class of bug HARN-FIX-3 itself exists to catch.
test('static: HARN-FIX-3 -- the install-consistency preflight block (INSTALL_CONSISTENCY_INSTRUCTION, INSTALL_CONSISTENCY_SCHEMA, installConsistencyError) is byte-identical between plan-cycle.js and review-cycle.js', () => {
  function extractBlock(fileName) {
    const contents = readAll('workflows', fileName)
    const lines = contents.split('\n')
    const start = lines.findIndex((l) => l.startsWith('// HARN-FIX-3 install-consistency preflight block'))
    const end = lines.findIndex((l, i) => i > start && l.trim() === '// ---- end HARN-FIX-3 install-consistency preflight block ----')
    assert.ok(start >= 0 && end > start, `${fileName}: could not locate the install-consistency preflight block markers`)
    return lines.slice(start, end + 1).join('\n')
  }
  const plan = extractBlock('plan-cycle.js')
  const review = extractBlock('review-cycle.js')
  assert.ok(plan.length > 500, 'sanity: the extracted block should be substantial, not an empty match')
  assert.equal(review, plan, 'review-cycle.js\'s install-consistency preflight block has drifted from plan-cycle.js\'s')
})

// specs/harn-fix-3.md AC-ARCH-4: the version stamp (formerly AC-ARCH-1/2/3)
// was built, reviewed, and withdrawn 2026-08-23 -- not deferred, not
// softened, REPLACED by a rule that no such mechanism may exist at all.
// Round-one review found it generated permanent false drift on every
// commit to main (the hook re-stamped three files unconditionally, so the
// staleness check above could never see past it) and, separately, that
// stamp_md/stamp_js staged the WHOLE working-tree file, sweeping unstaged
// edits into unrelated commits and into this repo's public remote history.
// This guard is the mechanical enforcement of the withdrawal: it fails if
// either half of the mechanism ever reappears, in this repo or a fork of
// it, rather than trusting the withdrawal to stay remembered as prose.
test('static: AC-ARCH-4 -- no shipped (non-test, non-docs, non-spec) tracked file contains a SOURCE_COMMIT stamp, and .githooks/ contains no pre-commit hook -- the version stamp is withdrawn, not merely unused', () => {
  const exec = require('node:child_process').execFileSync
  const tracked = exec('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
  // Excludes test/, docs/, specs/: those are where the WITHDRAWAL itself
  // is documented and narrated (this file's own comment above says
  // "SOURCE_COMMIT" by name, specs/harn-fix-3.md records the withdrawal
  // history, and docs/*-mutation-proofs.md keep a historical record of the
  // mutations that were run against the since-deleted mechanism) -- a scan
  // that also walked those would fail on the very act of documenting the
  // ban. Everything else tracked in the repo is "shipped": the point of
  // AC-ARCH-4 is that a consumer's ~/.claude install, or a fork's main,
  // must never be able to pick this back up.
  const shipped = tracked.filter((f) => !f.startsWith('test/') && !f.startsWith('docs/') && !f.startsWith('specs/'))
  assert.ok(shipped.length > 25, `sanity: expected many tracked shipped files, found ${shipped.length}`)
  const offenders = []
  for (const rel of shipped) {
    const full = path.join(ROOT, rel)
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) continue
    let contents
    try {
      contents = fs.readFileSync(full, 'utf8')
    } catch (e) {
      continue // a binary or unreadable file cannot contain the string meaningfully
    }
    if (contents.includes('SOURCE_COMMIT')) offenders.push(rel)
  }
  assert.deepEqual(offenders, [], `AC-ARCH-4: SOURCE_COMMIT reappeared in shipped file(s): ${offenders.join(', ')} -- the version stamp is withdrawn, not deferred`)

  const hooksDirExists = fs.existsSync(path.join(ROOT, '.githooks'))
  assert.ok(hooksDirExists, 'sanity: .githooks/ must exist (it still hosts pre-push)')
  const hookFiles = fs.readdirSync(path.join(ROOT, '.githooks'))
  assert.ok(!hookFiles.includes('pre-commit'), 'AC-ARCH-4: .githooks/pre-commit must not exist -- no git hook may rewrite tracked content during a commit')
})

// M9/round three: the install-consistency override moved from an environment
// variable (HARNESS_ALLOW_INCONSISTENT_INSTALL, relayed to the workflow
// THROUGH the scope agent whose report the gate is checking -- circular, and
// the same bypass class as MED-2) to an explicit per-invocation flag on the
// cycle's own args, read by the workflow script directly.
//
// Enforced mechanically rather than remembered as prose (§9): a reintroduced
// env var would look entirely plausible in review, and the relay it implies
// is exactly what round three removed. test/ and docs/ are excluded for the
// same reason AC-ARCH-4 excludes them -- the removal tests and the mutation
// proofs must be able to NAME the removed variable.
// Two guards, because the withdrawal has two halves and each can regress
// independently. Scope is SHIPPED CODE: test/, docs/ and specs/ are excluded
// for the same reason AC-ARCH-4 excludes them (the removal tests and the
// mutation proofs must be able to name what was removed), and so is every .md
// file -- README.md deliberately names the withdrawn variable so an operator
// with it in muscle memory finds out it is gone, and banning the string from
// prose would delete that explanation. Prose cannot re-enable a mechanism;
// code can.
function shippedCodeFiles() {
  const exec = require('node:child_process').execFileSync
  const files = exec('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
    .filter((rel) => !rel.startsWith('test/') && !rel.startsWith('docs/') && !rel.startsWith('specs/') && !rel.endsWith('.md'))
  // ANTI-VACUITY: a scan over an empty list reports no offenders forever.
  assert.ok(files.length > 15, `sanity: expected many shipped code files, found ${files.length}`)
  return files
}

test('static: round three -- no shipped code file names HARNESS_ALLOW_INCONSISTENT_INSTALL: the override is an args flag, not an environment variable that silently disables the gate for a whole session', () => {
  const offenders = shippedCodeFiles().filter((rel) => {
    let contents
    try {
      contents = fs.readFileSync(path.join(ROOT, rel), 'utf8')
    } catch (e) {
      return false
    }
    return contents.includes('HARNESS_ALLOW_INCONSISTENT_INSTALL')
  })
  assert.deepEqual(offenders, [], `the override must not be readable from the environment again: ${offenders.join(', ')}`)
})

// The half that actually mattered. A workflow script has no environment
// access, so the env-var design had to RELAY the override through the scope
// agent -- the model whose report the gate is checking. A gate whose override
// is asserted by the thing being policed is circular, and is the same bypass
// class as MED-2. Bans READING it (`.escape_hatch_active`) and DECLARING it
// (`escape_hatch_active:`), not merely mentioning it: the preflight block's own
// comments have to be able to say the field is ignored.
test('static: round three -- no shipped code file reads or declares escape_hatch_active: an override the scope agent can assert is not an override, it is a bypass', () => {
  const offenders = shippedCodeFiles().filter((rel) => {
    let contents
    try {
      contents = fs.readFileSync(path.join(ROOT, rel), 'utf8')
    } catch (e) {
      return false
    }
    return /\.escape_hatch_active|escape_hatch_active\s*:/.test(contents)
  })
  assert.deepEqual(offenders, [], `escape_hatch_active must never be read from, or declared in, a model-supplied report again: ${offenders.join(', ')}`)
})

test('static: round three -- both cycle workflows document the allow_inconsistent_install arg in their meta block, and README documents it as the override without still instructing the withdrawn environment variable', () => {
  for (const f of ['plan-cycle.js', 'review-cycle.js']) {
    const src = readAll('workflows', f)
    assert.match(src, /opts\.allow_inconsistent_install/, `${f} must read the override flag from its own args`)
    const meta = src.slice(0, src.indexOf('\n}'))
    assert.ok(meta.includes('allow_inconsistent_install'), `${f}'s meta block must document the flag in whenToUse -- an override nobody can discover is not an escape hatch`)
  }
  const readme = readAll('README.md')
  assert.match(readme, /allow_inconsistent_install/, 'README.md must document the override flag')
  assert.ok(!/set `?HARNESS_ALLOW_INCONSISTENT_INSTALL/.test(readme), 'README.md must not still INSTRUCT setting the withdrawn environment variable (naming it as withdrawn is the point)')
})

// HARN-OPT-2 PR2 (AC-ARCH-9): the start/terminal exception-guard block PR 2
// added (an exception escaping run() must still reach the single terminal
// writeLedger( call, then re-throw) is a SECOND necessarily-triplicated
// block, mirroring L5 above -- without a guard pinning it, a fix landed in
// one or two copies fails silently in the third, exactly the C1 failure
// class this file already guards against for the run-ledger helper trio.
test('static: PR2 -- the exception-guard block wrapping `await run()` (the try/catch that produces a terminal write even when run() throws, then re-throws the original error) is byte-identical across all three workflow files (AC-ARCH-9)', () => {
  function extractGuardBlock(fileName) {
    const contents = readAll('workflows', fileName)
    const lines = contents.split('\n')
    const start = lines.findIndex((l) => l.startsWith('// PR 2 (AC-QA-8, AC-ARCH-9): an exception escaping run() must still'))
    const end = lines.findIndex((l, i) => i > start && l.trim() === '} // end PR 2 exception guard')
    assert.ok(start >= 0 && end > start, `${fileName}: could not locate the PR2 exception-guard block markers`)
    return lines.slice(start, end + 1).join('\n')
  }
  const tdd = extractGuardBlock('tdd-task.js')
  const review = extractGuardBlock('review-cycle.js')
  const plan = extractGuardBlock('plan-cycle.js')
  assert.ok(tdd.length > 300, 'sanity: the extracted block should be substantial, not an empty match')
  assert.equal(review, tdd, 'review-cycle.js\'s PR2 exception-guard block has drifted from tdd-task.js\'s')
  assert.equal(plan, tdd, 'plan-cycle.js\'s PR2 exception-guard block has drifted from tdd-task.js\'s')
})

// The re-throw itself sits after the (per-file-diverging) telemetry-build
// and terminal writeLedger( call, so it cannot live inside the block above
// -- pinned separately, as its own one-line-plus-return byte-identical pair.
test('static: PR2 -- the re-throw line (`if (threw) throw runError`) immediately preceding the final `return { ...result, telemetry }` is byte-identical across all three workflow files (AC-ARCH-9). Round-1 review M2: gated on `threw` (whether the catch fired), not on `runError`\'s truthiness -- a falsy thrown value must still re-throw.', () => {
  const REQUIRED = 'if (threw) throw runError\nreturn { ...result, telemetry }'
  for (const f of ['workflows/tdd-task.js', 'workflows/review-cycle.js', 'workflows/plan-cycle.js']) {
    const contents = readAll(...f.split('/'))
    assert.ok(contents.includes(REQUIRED), `${f} must contain the exact re-throw-then-return pair:\n${REQUIRED}`)
  }
})

// AC-QA-9: "a static test that fails when a new return is added inside
// run() without a matching pairing test, so the enumeration cannot go
// stale". Every terminating `return` inside each workflow's run() is
// written as `return {` (an object literal), consistently, everywhere in
// this codebase -- confirmed by grep. Pinning the COUNT of that pattern
// inside run()'s own body means adding a new terminating return silently
// changes the count and fails this test, forcing whoever adds it to also
// come here and to tdd-task.test.js/review-cycle.test.js/plan-cycle.test.js
// (each of which has one test per return path, named by case) rather than
// leaving the new path unpaired with a ledger-write assertion.
// Review round-1 L1: the pin only counted the `return {` (object-literal)
// FORM of a terminating return -- a new return written any other way
// (`return EARLY` where EARLY is a variable, an escape-hatch object built
// on an earlier line and returned bare, etc.) changed nothing this test
// could see. CONFIRMED by two independent mutations (both left this test
// green before the fix): a `return escapeHatch` where `escapeHatch` was a
// variable holding an object literal, and a bare `return EARLY` referring
// to a pre-declared local. Fixed by ALSO counting every bare `return\b`
// occurrence in the same body and asserting the two counts are equal -- a
// return written in any form the object-literal regex does not match now
// makes the two counts diverge and fails this test by name, rather than
// silently passing because the narrower pattern happened not to match.
// Strips string/template-literal CONTENT and `//` line comments before
// counting `return` occurrences, so a prompt string that instructs the
// LLM to "return X" (this codebase's agent() prompts do this constantly --
// "Return only what the script printed", "return ac_verdicts", etc.) is
// never mistaken for a real terminating return statement. Trusted-input
// only (this repo's own three workflow files, not arbitrary/hostile
// source), so a lightweight non-nested-template-aware regex is adequate --
// this codebase's template literals never nest backticks.
function stripStringsAndComments(source) {
  // Comments are stripped FIRST, before any string-stripping: an apostrophe
  // inside a `//` comment (this codebase's comments use plenty of them --
  // "it's", "doesn't", "lens's") is an ordinary character until the quote
  // regexes below run, and if a comment survives past that point its
  // apostrophe pairs unpredictably with a REAL quote elsewhere in the file,
  // desynchronising every string match after it and silently swallowing
  // real code (including a real `return`) into what the regex believes is
  // string content. Confirmed no `//` occurs inside genuine string content
  // in any of the three files' run() bodies (checked by grep), so a naive
  // per-line strip is safe here.
  return source
    .split('\n').map((line) => line.replace(/\/\/.*$/, '')).join('\n')
    .replace(/`(?:[^`\\]|\\.)*`/gs, '``')
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
}

test('static: AC-QA-9 -- the number of terminating `return` statements (any form) inside each workflow\'s run() function is pinned, so a new return path added without a matching pairing test fails this check instead of silently going unpaired (L1: widened past the object-literal-only `return {` form)', () => {
  function countReturnsInRun(fileName) {
    const contents = readAll('workflows', fileName)
    const lines = contents.split('\n')
    const start = lines.findIndex((l) => l.trim() === 'async function run() {')
    const end = lines.findIndex((l, i) => i > start && l.trim() === '} // end run()')
    assert.ok(start >= 0 && end > start, `${fileName}: could not locate the run() function markers`)
    const rawBody = lines.slice(start, end + 1).join('\n')
    const codeOnlyBody = stripStringsAndComments(rawBody)
    const anyForm = (codeOnlyBody.match(/\breturn\b/g) || []).length
    const objectLiteralForm = (rawBody.match(/return\s*\{/g) || []).length
    assert.equal(
      anyForm, objectLiteralForm,
      `${fileName}: found ${anyForm} real \`return\` statement(s) (strings/comments excluded) but only ${objectLiteralForm} are the object-literal \`return {\` form -- ` +
      `a return written in some other form (a bare variable, an escape hatch) was added without this guard being able to see it`
    )
    return objectLiteralForm
  }
  // tdd-task.js: 4 ABORTED, 3 BLOCKED (2 max-attempts exhaustions + the
  // hashes-changed short-circuit), 1 DONE -- see the 8-case table in
  // tdd-task.test.js's "every terminating return" test.
  assert.equal(countReturnsInRun('tdd-task.js'), 8, 'tdd-task.js run() must have exactly 8 terminating returns; if you added one, add its pairing test too')
  // review-cycle.js: the no-op (no changes found), the every-lens-failed
  // abort, and the main synthesis return.
  assert.equal(countReturnsInRun('review-cycle.js'), 3, 'review-cycle.js run() must have exactly 3 terminating returns; if you added one, add its pairing test too')
  // plan-cycle.js: the scope-agent-failed abort, the every-lens-failed
  // abort, and the main synthesis return.
  assert.equal(countReturnsInRun('plan-cycle.js'), 3, 'plan-cycle.js run() must have exactly 3 terminating returns; if you added one, add its pairing test too')
})

// HARN-OPT-2 T3 (Group 7 drift marker, mirroring AC-OPS-4's workflows/
// pattern above at the same-file lines 201-232): bin/optimise-cycle-weekly.sh
// and bin/redact-transcript.mjs are ALSO synced to an installed mirror
// (~/.claude/bin/) outside version control, and without a guard pinning the
// exact re-sync commands, a fix landed in the repo can silently never reach
// the copy launchd actually runs.
test('static: README.md names the exact re-sync commands for bin/optimise-cycle-weekly.sh AND bin/redact-transcript.mjs, and gives a diff command that confirms the installed copies match the repo (T3 Group 7, mirrors AC-OPS-4)', () => {
  const readme = readAll('README.md')
  assert.ok(
    /cp claude-ai-harness\/bin\/optimise-cycle-weekly\.sh ~\/\.claude\/bin\/optimise-cycle-weekly\.sh/.test(readme),
    'README.md must give the exact re-sync command for bin/optimise-cycle-weekly.sh'
  )
  assert.ok(
    /cp claude-ai-harness\/bin\/redact-transcript\.mjs ~\/\.claude\/bin\/redact-transcript\.mjs/.test(readme),
    'README.md must give the exact re-sync command for bin/redact-transcript.mjs -- verdict_repo silently falls back to an unredacted transcript if this file is missing from the installed mirror'
  )
  assert.ok(
    /diff -q claude-ai-harness\/bin\/optimise-cycle-weekly\.sh ~\/\.claude\/bin\/optimise-cycle-weekly\.sh/.test(readme),
    'README.md must give an exact command that confirms the installed optimise-cycle-weekly.sh matches the repo'
  )
  assert.ok(
    /diff -q claude-ai-harness\/bin\/redact-transcript\.mjs ~\/\.claude\/bin\/redact-transcript\.mjs/.test(readme),
    'README.md must give an exact command that confirms the installed redact-transcript.mjs matches the repo'
  )
})

test('static: README.md documents the launchd rollback for com.local.optimise-cycle-weekly -- the exact launchctl bootout/bootstrap pair, and states plainly that a code revert alone does not stop the scheduled job (T3 Group 7, mirrors AC-OPS-11\'s slug-only-mode rollback requirement)', () => {
  const readme = readAll('README.md')
  assert.match(readme, /launchctl bootout gui\/\$\(id -u\)\/com\.local\.optimise-cycle-weekly/, 'README.md must give the exact launchctl bootout command')
  assert.match(readme, /launchctl bootstrap gui\/\$\(id -u\)/, 'README.md must give the exact launchctl bootstrap install command')
  assert.match(readme, /does\s*\*{0,2}not\*{0,2}\s*stop.{0,40}(scheduled|launchd)|(scheduled|launchd).{0,60}\*{0,2}not\*{0,2}.{0,20}stop/i, 'README.md must state plainly that a code revert alone does not stop the scheduled launchd job')
})

// Subtraction round item 3 (specs/harn-opt-2.md conductor log tick 46):
// review round 2 proved --disallowedTools and --settings disableAllHooks
// are real defence in depth (they block their literal enumerated targets),
// but PREVIOUSLY had no guard at all pinning them in place -- deleting
// BOTH flag lines from the script left the full weekly-runner suite
// green (50/50), because every test drives a stub `claude`, not the real
// CLI, so nothing in the suite ever observes which flags were actually
// passed. Mirrors the existing README/plist static checks above: this
// closes that coverage gap mechanically, so a future edit cannot silently
// drop either control without a red test naming exactly which token
// vanished.
test('static: the real `claude -p` call site in bin/optimise-cycle-weekly.sh contains every required --disallowedTools deny token and the --settings disableAllHooks blob (subtraction round item 3) -- deleting either previously shipped the suite green, since every test drives a stub `claude`, never the real flags', () => {
  const script = readAll('bin', 'optimise-cycle-weekly.sh')
  const lines = script.split('\n')
  // Scoped to the ACTUAL invocation block, not the whole file: a whole-file
  // .includes() check was tried first and was itself vacuous -- this
  // script's own header comments quote the exact `--settings
  // '{"disableAllHooks": true}'` string while narrating history, so a
  // whole-file check kept passing even after the real call site's flag
  // line was deleted (confirmed by deliberately deleting it and watching
  // this test wrongly stay green, before this fix).
  const start = lines.findIndex((l) => l.includes('claude -p '))
  const end = lines.findIndex((l, i) => i > start && l.includes('2>&1'))
  assert.ok(start >= 0 && end > start, 'could not locate the claude -p invocation block in bin/optimise-cycle-weekly.sh')
  const callSite = lines.slice(start, end + 1).join('\n')
  const requiredDenyTokens = [
    'Bash(rm:*)',
    'Bash(sudo:*)',
    'Bash(git push:*)',
    'Bash(git commit:*)',
    'Bash(git reset:*)',
    'Bash(gh pr merge:*)',
    'Bash(gh pr create:*)',
    'Bash(gh issue create:*)',
    'Bash(gh release create:*)',
    'Bash(gh workflow run:*)',
    'Bash(curl:*)',
    'Bash(wget:*)',
  ]
  assert.ok(callSite.includes('--disallowedTools'), 'the claude -p call site must pass --disallowedTools')
  for (const token of requiredDenyTokens) {
    assert.ok(callSite.includes(token), `the claude -p call site must deny ${token}`)
  }
  assert.ok(
    callSite.includes('--settings \'{"disableAllHooks": true}\''),
    'the claude -p call site must pass --settings \'{"disableAllHooks": true}\''
  )
})

test('static: bin/com.local.optimise-cycle-weekly.plist is tracked in the repo and is a valid plist containing no real account path (it is a template -- every path is a /Users/YOUR_USERNAME placeholder, since this repo is public)', () => {
  const plistPath = path.join(ROOT, 'bin', 'com.local.optimise-cycle-weekly.plist')
  assert.ok(fs.existsSync(plistPath), 'bin/com.local.optimise-cycle-weekly.plist must exist and be tracked -- a code revert cannot stop a scheduled job that only exists outside version control')
  const plist = fs.readFileSync(plistPath, 'utf8')
  assert.ok(!/\/Volumes\/|\/home\/scott\.b|scott\.b/.test(plist), 'the tracked plist must never contain a real, non-placeholder account path')
  assert.match(plist, /YOUR_USERNAME/, 'the tracked plist must use a placeholder path, not a real one, since this repo is public')
})

// §9: the rule "a test file that invokes git must load the git-environment
// scrub" is enforceable, so it is enforced rather than written down.
//
// Two lessons are baked into HOW this scans, both learned the hard way and
// both within an hour of each other:
//
// 1. ALIAS-AGNOSTIC. The ad-hoc scan that first checked this matched the
//    literal identifier `execFileSync('git'` and reported static-checks.js
//    as having zero git calls -- while that very file did
//    `const exec = require('node:child_process').execFileSync` and then
//    `exec('git', ...)`. The file was unprotected and the scan said it was
//    fine. A guard that looks for one spelling of a call reports CLEAN on
//    the code that motivated it. (Independently hit the same day in a
//    sibling repo, where `import subprocess as sp` hid 17 of 20 call sites
//    from an equivalent check.) So: match `<anything>('git',` regardless of
//    what the function is called.
// 2. NO FALSE POSITIVES. Comments and prose mention git commands constantly
//    in this repo, so they are stripped before scanning. A guard that cries
//    wolf on correct code gets deleted by the next person in a hurry, which
//    is a worse outcome than not having the guard.
//
// The scrub is per-PROCESS and node --test runs each test file in its own
// process, so importing it transitively (via helpers/temp-repo.js, which
// scrubs at load) counts -- that is a real code path, not a loophole. That
// per-file boundary is also why this guard matters at all: a new test file
// that shells out to git and forgets the import is unprotected the moment it
// exists, and no other file's scrub helps it.
//
// KNOWN LIMIT, stated rather than implied. This is a text scan, so it cannot
// structurally tell DESCRIBING a require from APPLYING one -- which is
// exactly how its first version exempted its own file by matching its own
// error message. Anchoring to a statement at the start of a line mitigates
// that; it does not eliminate it. A string literal containing a line-start
// require for one of these modules would still read as compliance. Closing
// it properly needs an AST walk, where a string constant simply is not an
// import node and the confusion cannot arise (the point was made by the
// sibling repo whose equivalent guard is AST-based and, tested by planting,
// does not have this defect). Node exposes no parser in its standard library
// and this repo has no dependencies, so that is not a proportionate trade
// here for a contrived residual case. Revisit if this guard is ever wrong
// again, and prove it by planting rather than by reading.
test('static: every test file that invokes git loads the git-environment scrub, so a suite run under an exported GIT_DIR cannot verify or corrupt the wrong repository (alias-agnostic scan)', () => {
  const testDir = path.join(ROOT, 'test')
  const files = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(p)
      else if (entry.name.endsWith('.js')) files.push(p)
    }
  }
  walk(testDir)
  assert.ok(files.length > 10, `sanity: expected to find many test files under ${testDir}, found ${files.length}`)

  // Two source views, deliberately different.
  //
  // DETECTION runs on comment-stripped source and must see every spelling of
  // a git call. Backtick is in the quote classes because sh(`git init`) is
  // this repo's DOMINANT idiom -- 21 such call sites in ledger-append.test.js
  // alone -- and the previous version, written to be alias-agnostic, matched
  // only ' and ". It would have certified a new file using the surrounding
  // idiom as clean. That was the fourth spelling this guard was blind to.
  //
  // COMPLIANCE has two forms, and neither can be satisfied by a mention:
  //
  //   scrubGitEnv CALLED -- checked against source with STRING CONTENTS
  //     removed, so naming the call inside a message cannot count as making
  //     it. Requiring helpers/git-env.js is NOT sufficient on its own: that
  //     module defines scrubGitEnv and never calls it at load, so importing
  //     it protects nothing.
  //   temp-repo.js / hostile-repo.js REQUIRED -- those do scrub at load, so
  //     the import is a real code path. Matched only where no quote character
  //     precedes require on the line, which excludes one named inside a
  //     string while still accepting a destructure wrapped across lines,
  //     where the require sits after a closing brace.
  //
  // Belt and braces: this test's own failure message deliberately does NOT
  // spell the call with its parentheses, so it cannot satisfy the detector
  // even if the string-stripper is imperfect. An earlier version matched its
  // own message and exempted its own file, and relying on one mechanism to
  // prevent that recurring is how it happened the first time.
  const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
  const stripStringContents = (src) => src.replace(/(['"`])(?:\\.|(?!\1)[\s\S])*?\1/g, '$1$1')

  const offenders = []
  for (const file of files) {
    const src = stripComments(fs.readFileSync(file, 'utf8'))
    const invokesGit =
      /[\w.$]+\(\s*['"`][^'"`]*\bgit['"`]\s*[,)]/.test(src) ||
      /['"`]git\s+[a-z][a-z-]*/.test(src)
    if (!invokesGit) continue

    const callsScrub = /\bscrubGitEnv\s*\(/.test(stripStringContents(src))
    const requiresScrubbingHelper = src
      .split('\n')
      .some((line) => /^[^'"`]*\brequire\(\s*['"`][^'"`]*(?:temp-repo|hostile-repo)[^'"`]*['"`]\s*\)/.test(line))
    if (!callsScrub && !requiresScrubbingHelper) offenders.push(path.relative(ROOT, file))
  }

  assert.deepEqual(
    offenders,
    [],
    `these files invoke git but never load the git-environment scrub, so a run under an exported GIT_DIR would resolve to the wrong repository: ${offenders.join(', ')}. ` +
      'Fix: call scrubGitEnv from test/helpers/git-env.js at the top of the file, or require test/helpers/temp-repo.js, which does it at load.'
  )
})

// M9 from review: both artefacts added by the CI commit had no coverage at
// all -- nothing pinned the hook's content, mode or command, and nothing read
// ci.yml. They are the gate; an unguarded gate is the thing this repo exists
// to object to.
test('static: the pre-push hook is executable, strips git\'s GIT_* namespace before running anything, refuses an empty test glob, and runs the suite', () => {
  const hookPath = path.join(ROOT, '.githooks', 'pre-push')
  assert.ok(fs.existsSync(hookPath), '.githooks/pre-push must exist')
  assert.ok(fs.statSync(hookPath).mode & 0o111, 'the hook must be executable, or git silently ignores it and the gate is not a gate')
  const hook = fs.readFileSync(hookPath, 'utf8')

  assert.match(hook, /unset "?\$_var"?/, 'the hook must unset the git environment before running the suite')
  assert.match(hook, /GIT_\[A-Za-z0-9_\]\*/, 'the strip must cover the whole GIT_* namespace, not a list of names')
  assert.match(hook, /GIT_AUTHOR_NAME/, 'commit identity must be preserved, matching helpers/git-env.js')
  assert.match(hook, /node --test test\/\*\.test\.js/, 'the hook must run the suite')

  // An earlier revision deliberately LEFT the hostile variables set, so that
  // a worktree push would exercise the scrub end to end. Review proved by
  // execution that a scrub regression then leaves fixture commits, a dirtied
  // tree, a mutated .git/info/exclude and an executable planted hook in the
  // operator's real repository, all before the hook reports failure. A test
  // whose failure mode is destroying the repository is not a test.
  assert.ok(
    !/DELIBERATELY does not unset/.test(hook),
    'the hook must not reinstate the leave-it-hostile rationale; the disposable place for that run is CI'
  )
})

test('static: the pre-push hook and CI both refuse to report success when the test glob matches nothing', () => {
  // Measured: `sh -c 'set -e; node --test test/*.test.js'` in a directory
  // with no matches exits 0 having run zero assertions, because sh passes an
  // unmatched glob through literally. That command string was the entire
  // body of the hook and of both CI run steps.
  for (const rel of ['.githooks/pre-push', '.github/workflows/ci.yml']) {
    const src = readAll(rel)
    assert.match(src, /ls test\/\*\.test\.js/, `${rel} must count the files the glob matches`)
    assert.match(src, /-lt 10|-ge 10/, `${rel} must assert a floor on that count`)
  }
})

test('static: every CI guarantee is asserted by COUNT or by structure, because presence-anywhere let four separate regressions through', () => {
  const ci = readAll('.github/workflows/ci.yml')
  const count = (re) => (ci.match(re) || []).length

  // Review defeated the previous version of every assertion below by
  // deleting the thing while leaving a comment, or by deleting one of
  // several occurrences. Each is now pinned to a count.

  // (a) Deleting the gitleaks step left the word "gitleaks" in a comment and
  //     the suite stayed green. Pin the `uses:` line, not the word.
  assert.equal(count(/^\s*-?\s*uses:\s*gitleaks\/gitleaks-action@/gm), 1,
    'exactly one gitleaks-action step must exist: this repo is public and has already required a history rewrite')

  // (b) Deleting timeout-minutes from two of three jobs stayed green,
  //     because one occurrence satisfied the regex.
  assert.equal(count(/^\s*timeout-minutes:/gm), count(/^\s*runs-on:/gm),
    'every job must be bounded, or a hang presents as "still running" for six hours')

  // (c) Deleting GIT_DIR from the hostile step stayed green: nothing
  //     asserted it. Without it the escape target is the workspace the suite
  //     already expects, so a scrub regression is masked.
  assert.match(ci, /GIT_DIR=/, 'the hostile step must point GIT_DIR at a scratch repo, not the workspace')
  for (const v of ['GIT_TEMPLATE_DIR', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS']) {
    assert.match(ci, new RegExp(`${v}:`), `the hostile step must set ${v}`)
  }

  // (d) Deleting fetch-depth from the test job stayed green because the
  //     secrets job's copy satisfied a file-level regex. Both need it, for
  //     different reasons.
  assert.equal(count(/^\s*fetch-depth:\s*0\s*$/gm), 2,
    'both the test job (subject-anchored commit resolution) and the secrets job (scheduled history sweep) need full history')

  // M1: on push and pull_request, gitleaks-action supplies its own
  // --log-opts range and never walks all refs. Only a trigger it passes no
  // log-opts for reaches gitleaks' --full-history --all default, so without
  // a scheduled run the history sweep does not exist at all.
  assert.match(ci, /^\s*schedule:/m, 'a scheduled trigger is the only one on which gitleaks walks all history')
  assert.match(ci, /cron:/, 'the scheduled trigger needs a cron expression')

  assert.match(ci, /node --test test\/\*\.test\.js/, 'CI must run the suite')
})

// M7 from review: seven AC identifiers looked duplicated and two genuinely
// were. The id is the join key between the planning cycle, the review cycle
// and the ledger's ac_verdicts, so a duplicate silently merges two unrelated
// criteria and a verdict citing one cannot be resolved.
test('static: no spec defines the same AC-<LENS>-<n> identifier twice -- the id is the join key between planning, review and the ledger', () => {
  const specsDir = path.join(ROOT, 'specs')
  const files = fs.readdirSync(specsDir).filter((f) => f.endsWith('.md'))
  assert.ok(files.length > 0, 'sanity: expected spec files under specs/')

  const problems = []
  let totalDefs = 0
  for (const file of files) {
    const src = fs.readFileSync(path.join(specsDir, file), 'utf8')
    // A DEFINITION is an id at the START OF A LINE, optionally after a list
    // marker, optionally bolded, followed by a colon. THREE spellings are in
    // use across these specs and all three must match, or the guard is blind
    // to whole files:
    //   - **AC-PROD-1:** ...   colon inside the bold   harn-opt-3.md
    //   **AC-SEC-1**: ...      colon outside           custom-rules-fail-closed.md
    //   - AC-SEC-1: ...        unbolded                harn-opt-2.md, optimise-cycle.md
    //
    // This pattern has now been wrong THREE times, in three different
    // directions, and the history is kept because each failure looked
    // correct:
    //   1. Matching the bare id counted prose MENTIONS as definitions. Specs
    //      discuss criteria they have vetoed, so it reported five false
    //      duplicates, and a mechanical rename on the back of that renamed
    //      references inside a changelog.
    //   2. Requiring bold found 81 of 245 definitions -- ZERO in the two
    //      largest specs -- while reporting no duplicates, exactly the
    //      "guard that cannot fire" this file warns about elsewhere.
    //   3. The pattern review proposed to fix (2) was anchored and unbolded
    //      but required the colon AFTER the closing bold, so it found 103 and
    //      61 in the files that had been blind and ZERO in the file that had
    //      been working. Taking a suggested fix literally would have moved
    //      the blindness rather than removed it.
    // Line anchoring is what keeps prose mentions out; the alternation is
    // what keeps every file in.
    const defs = [...src.matchAll(/^(?:[-*]\s+)?(?:\*\*)?(AC-[A-Z]+-\d+)(?::\*\*|\*\*:|:)\s/gm)].map((m) => m[1])
    totalDefs += defs.length
    // PER-FILE anti-vacuity: a global floor is satisfied by one large file
    // while every other spec contributes zero forever. Measured: harn-opt-3
    // alone supplied 70 of the old global 81, so the old `> 50` floor could
    // never fire for the two blind files.
    // A spec with ids in prose but no definitions is EITHER blind to a
    // spelling (the failure this catches) OR legitimately deferring its
    // criteria to /plan-cycle. Those are indistinguishable by inspection, so
    // the file has to say which, and only an explicit declaration exempts it.
    // Silence is read as the failure, not as the exemption.
    const declaresNone = /<!--\s*no-acceptance-criteria\b/.test(src)
    if (/AC-[A-Z]+-\d+/.test(src) && defs.length === 0 && !declaresNone) {
      problems.push(`${file}: contains AC ids but the definition scan found none -- either the pattern is blind to this file's spelling, or the spec defines no criteria and must say so with an HTML comment marker`)
    }
    const counts = new Map()
    for (const id of defs) counts.set(id, (counts.get(id) || 0) + 1)
    for (const [id, n] of counts) if (n > 1) problems.push(`${file}: ${id} defined ${n} times`)
  }
  assert.ok(
    totalDefs > 200,
    `sanity: expected the scan to find many AC definitions across specs/, found ${totalDefs} -- a pattern that matches nothing reports no duplicates forever. The per-file check above is the real anti-vacuity guard; this is a coarse backstop, set just under the 245 currently present.`
  )
  assert.deepEqual(problems, [], `duplicate acceptance-criterion definitions: ${problems.join('; ')}`)
})

// H2 from review round 2: the assertions above match TEXT in the hook, and
// nothing anywhere executed it. Both proven defeatable: inserting one line,
// `GIT_*) ;;` before the unset arm, left every asserted string intact and the
// suite 32/32 green while GIT_TEMPLATE_DIR reached the suite -- which is
// arbitrary code execution, since git init copies that directory's hooks into
// every fixture repo and runs them. Changing the empty-glob `exit 1` to
// `exit 0` was equally invisible, because the assertion only required the
// string `-lt 10` to appear somewhere in the file.
//
// So the hook is executed here, with a stub `node` on PATH standing in for
// the suite, and the assertions are about observed behaviour rather than
// about the source that produces it.

function runPrePushHook({ cwd, env = {}, stubNode = true }) {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'hookrun-'))
  const bin = path.join(dir, 'bin')
  fs.mkdirSync(bin)
  if (stubNode) {
    // Stands in for `node --test ...`: prints the GIT_* environment it was
    // handed, so the test can assert what actually survived the scrub.
    const stub = path.join(bin, 'node')
    fs.writeFileSync(stub, '#!/bin/sh\nenv | grep "^GIT_" | sort\nexit 0\n')
    fs.chmodSync(stub, 0o755)
  }
  const res = spawnSync('sh', [path.join(ROOT, '.githooks', 'pre-push')], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ...env },
  })
  fs.rmSync(dir, { recursive: true, force: true })
  return res
}

test('static: EXECUTING the pre-push hook strips every GIT_* variable except commit identity -- observed from inside the process it launches, not matched in its source', () => {
  const res = runPrePushHook({
    cwd: ROOT,
    env: {
      GIT_TEMPLATE_DIR: '/tmp/evil-template',
      GIT_PAGER: 'cat',
      GIT_NOT_A_REAL_VAR_47B3F9: 'x',
      GIT_CONFIG_COUNT: '1',
      GIT_AUTHOR_NAME: 'keepme',
      GIT_COMMITTER_EMAIL: 'keep@me',
    },
  })
  assert.equal(res.status, 0, `hook exited ${res.status}: ${res.stderr}`)
  const survived = res.stdout.split('\n').map((l) => l.split('=')[0]).filter((k) => k.startsWith('GIT_'))

  for (const gone of ['GIT_TEMPLATE_DIR', 'GIT_PAGER', 'GIT_NOT_A_REAL_VAR_47B3F9', 'GIT_CONFIG_COUNT']) {
    assert.ok(!survived.includes(gone), `${gone} reached the suite; the hook's scrub did not run. Survivors: ${survived.join(', ')}`)
  }
  // Not "strip everything": identity must pass through, or the strip is
  // over-broad and the test would pass for the wrong reason.
  assert.ok(survived.includes('GIT_AUTHOR_NAME'), 'commit identity must survive the strip')
  assert.ok(survived.includes('GIT_COMMITTER_EMAIL'), 'commit identity must survive the strip')
})

test('static: EXECUTING the pre-push hook in a directory where the test glob matches nothing exits non-zero, where the unguarded command exits 0', () => {
  const empty = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'emptyrepo-'))
  try {
    const guarded = runPrePushHook({ cwd: empty, stubNode: false })
    assert.notEqual(guarded.status, 0, 'the hook must refuse to report success when the suite glob matches nothing')
    assert.match(guarded.stderr, /refusing to report success/, 'and must say why')

    // The control is the point: this is what the hook did before the floor,
    // and what it would silently return to if the floor were removed.
    const unguarded = spawnSync('sh', ['-c', 'set -e; node --test test/*.test.js'], { cwd: empty, encoding: 'utf8' })
    assert.equal(unguarded.status, 0, 'sanity: the unguarded form exits 0 on an empty glob -- if this ever fails, the floor is no longer load-bearing and this test is measuring nothing')
  } finally {
    fs.rmSync(empty, { recursive: true, force: true })
  }
})

// H1 from review round 2: a committed hook is inert in every fresh clone,
// because core.hooksPath is LOCAL config that no repository can set. Worse,
// it fails silently -- git ignores an unset hooksPath without a word, so the
// push succeeds and looks gated. The gate existed on exactly one machine.
//
// The previous test asserted the executable bit with the message "or git
// silently ignores it and the gate is not a gate". The condition that
// actually makes git silently ignore it is the unset one, which was
// unguarded. This executes the remedy end to end instead: a scratch repo with
// the hook present but hooksPath unset must NOT be gated, and running
// bin/setup-hooks.sh must gate it.
test('static: bin/setup-hooks.sh is what makes the committed hook fire -- proven by a push that is NOT blocked before running it and IS blocked after', () => {
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'hookssetup-'))
  const repo = path.join(root, 'repo')
  const remote = path.join(root, 'remote.git')
  const git = (args, cwd) => spawnSync('git', args, { cwd, encoding: 'utf8', env: sanitizedGitEnv() })
  try {
    fs.mkdirSync(repo)
    git(['init', '-q', '-b', 'main'], repo)
    git(['init', '-q', '--bare', remote], root)
    git(['config', 'user.email', 't@example.com'], repo)
    git(['config', 'user.name', 'T'], repo)
    git(['remote', 'add', 'origin', remote], repo)

    // The repo's own artefacts, copied in: a hook that always refuses, and
    // the real setup script under test.
    fs.mkdirSync(path.join(repo, '.githooks'))
    const hook = path.join(repo, '.githooks', 'pre-push')
    fs.writeFileSync(hook, '#!/bin/sh\necho GATE_RAN >&2\nexit 1\n')
    fs.chmodSync(hook, 0o755)
    fs.mkdirSync(path.join(repo, 'bin'))
    fs.copyFileSync(path.join(ROOT, 'bin', 'setup-hooks.sh'), path.join(repo, 'bin', 'setup-hooks.sh'))

    fs.writeFileSync(path.join(repo, 'f.txt'), 'x\n')
    git(['add', '-A'], repo)
    git(['commit', '-qm', 'seed'], repo)

    // BEFORE: hooksPath unset. The hook exists, is executable, and refuses --
    // and the push still succeeds, silently.
    const before = git(['push', '-q', 'origin', 'main'], repo)
    assert.equal(before.status, 0, 'sanity: without core.hooksPath the committed hook must be ignored; if this fails the premise has changed')
    assert.ok(!/GATE_RAN/.test(before.stderr), 'the hook must not have run before setup')

    // AFTER: run the real script.
    const setup = spawnSync('sh', ['bin/setup-hooks.sh'], { cwd: repo, encoding: 'utf8', env: sanitizedGitEnv() })
    assert.equal(setup.status, 0, `setup-hooks.sh failed: ${setup.stderr}`)
    assert.equal(git(['config', '--get', 'core.hooksPath'], repo).stdout.trim(), '.githooks',
      'the path must be RELATIVE: an absolute one is resolved against each linked worktree, which would run the main checkout\'s copy')

    fs.writeFileSync(path.join(repo, 'f.txt'), 'y\n')
    git(['commit', '-qam', 'second'], repo)
    const after = git(['push', 'origin', 'main'], repo)
    assert.notEqual(after.status, 0, 'after setup the hook must gate the push')
    assert.match(after.stderr, /GATE_RAN/, 'and it must be this hook that ran')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('static: README documents how to activate the gate, and says plainly that CI is the backstop because no repository can set core.hooksPath for a clone', () => {
  const readme = readAll('README.md')
  assert.match(readme, /bin\/setup-hooks\.sh/, 'README must name the setup script')
  assert.match(readme, /core\.hooksPath/, 'README must name the config that makes the hook fire')
  assert.match(readme, /silent|silently/i, 'README must state that an unset hooksPath fails silently, which is why this is easy to miss')
  assert.match(readme, /backstop|CI is the/i, 'README must state that CI, not the hook, is what actually gates for everyone else')
})

// --- H6 (round-2 destructive-git-guard review): hooks/hooks.json's
// registration is the wiring that makes a hook run AT ALL, and nothing in
// test/destructive-git-guard.test.js can see it -- those tests all invoke
// hooks/destructive-git-guard.py directly by path (runHook() in that file),
// which is structurally incapable of noticing the registration itself is
// missing, malformed, or points at a file that does not exist. Measured:
// deleting the entire PreToolUse block from hooks/hooks.json left all 743
// pre-existing tests green. This is the standard's own "correct in source,
// absent from the artefact that runs" class (§11) applied to the wiring
// rather than the logic, and its failure mode is the exact loss the guard
// exists to prevent: a silently inert PreToolUse hook.
//
// Set-based rather than a fixed list of expected entries, so adding a NEW
// hook script under hooks/ without wiring it into hooks.json fails this
// test by name, instead of the omission being invisible until an operator
// notices the hook never runs.
test('static: every hooks/*.py script is registered in hooks/hooks.json, and every hooks.json entry names a script that actually exists (H6, registration wiring)', () => {
  const hooksDir = path.join(ROOT, 'hooks')
  const pyFiles = new Set(
    fs.readdirSync(hooksDir, { withFileTypes: true })
      // test_*.py files are unittest suites picked up by CI's own
      // `python3 -m unittest discover -s hooks -p 'test_*.py'`, not hook
      // entry points. hooks.json registers scripts Claude Code invokes as
      // hooks, so a test suite living alongside the script it tests must
      // not be required to appear there.
      .filter((e) => e.isFile() && e.name.endsWith('.py') && !e.name.startsWith('test_'))
      .map((e) => e.name)
  )
  assert.ok(pyFiles.size >= 2, `sanity: expected at least the two known hook scripts under hooks/, found ${pyFiles.size}`)

  const raw = readAll('hooks', 'hooks.json')
  let parsed
  assert.doesNotThrow(() => { parsed = JSON.parse(raw) }, 'hooks/hooks.json must be valid JSON')

  const registeredNames = new Set()
  const entries = [] // { event, matcher, scriptPath }
  for (const [event, matcherGroups] of Object.entries(parsed.hooks || {})) {
    assert.ok(Array.isArray(matcherGroups), `hooks.json's "${event}" key must be an array of matcher groups`)
    for (const group of matcherGroups) {
      for (const hook of group.hooks || []) {
        assert.ok(Array.isArray(hook.args) && hook.args.length > 0, `every hook command in hooks.json must have a non-empty args array (event=${event})`)
        const resolved = hook.args[0].replace('${CLAUDE_PLUGIN_ROOT}', ROOT)
        assert.ok(fs.existsSync(resolved), `hooks.json (event=${event}) points args[0] at ${resolved}, which does not exist`)
        assert.ok(fs.statSync(resolved).isFile(), `hooks.json (event=${event}) points args[0] at ${resolved}, which is not a file`)
        entries.push({ event, matcher: group.matcher, scriptPath: resolved })
        registeredNames.add(path.basename(resolved))
      }
    }
  }

  assert.deepEqual(
    [...pyFiles].sort(),
    [...registeredNames].sort(),
    `hooks/*.py and hooks.json's registered scripts must be the SAME set. hooks/ has: ${[...pyFiles].sort()}; hooks.json registers: ${[...registeredNames].sort()}. ` +
      'A hook script that exists but is not registered will never run; a registration pointing at a script that no longer exists is dead configuration.'
  )

  const guardEntry = entries.find((e) => e.scriptPath.endsWith('destructive-git-guard.py'))
  assert.ok(guardEntry, 'destructive-git-guard.py must be registered in hooks.json')
  assert.equal(guardEntry.event, 'PreToolUse', 'destructive-git-guard.py must be registered under PreToolUse')
  assert.equal(guardEntry.matcher, 'Bash', 'destructive-git-guard.py\'s PreToolUse matcher must be "Bash" -- a wrong or missing matcher means it never sees a Bash call at all')
})

// H3 (review round on fix/destructive-git-guard): commit d447030 added a
// `Recurrence` field to AGENT-HARNESS.md's FINDINGS template and instructed
// all nine agents/lens-*.md files to fill it, with no matching property in
// either lens-output schema the workflow scripts declare (REVIEW_SCHEMA in
// review-cycle.js, PLAN_SCHEMA in plan-cycle.js), no mention in the lens
// prompt, no carry into the openFindingsRaw ledger projection, and no
// mention in the synthesis keep-list -- an instruction with no consumer,
// the exact shape this repo exists to stop. Fixed by adding `recurrence` to
// both schemas' findings-item properties and to review-cycle.js's prompt,
// projection and synthesis instructions. This test is the drift guard that
// stops a repeat: it fails if EITHER side ever moves without the other --
// a field documented/instructed with no schema slot (H3's own shape), or a
// schema property nothing documents or instructs a lens to fill.
test('static: H3 drift guard -- every colon-labeled field in AGENT-HARNESS.md\'s ### FINDINGS template, and every field agents/lens-*.md instruct filling there, has a like-named property in both review-cycle.js\'s REVIEW_SCHEMA and plan-cycle.js\'s PLAN_SCHEMA findings items -- and vice versa: every non-structural findings-item property is named in the template', async () => {
  // specs/harn-fix-3.md AC-QA-1 (reuse, not reinvent): the field-extraction
  // regexes below used to be duplicated inline here. They now live ONCE, in
  // workflows/lib/install-consistency.mjs -- the same runtime script
  // plan-cycle.js/review-cycle.js instruct an agent to run against an
  // INSTALLED ~/.claude tree before dispatching any lens (AC-QA-1..4). This
  // test is the identical comparison run against the REPO's own tree
  // instead, at review time. One parser, two call sites, so the two checks
  // can never independently drift into two different, individually-wrong
  // parsers -- see that module's own header for the three-times-wrong
  // history this exact pattern has (matching bare ids counted prose
  // mentions; requiring bold found zero definitions in two files while
  // reporting no duplicates; a "fix" moved the blindness rather than
  // removing it).
  const { pathToFileURL } = require('node:url')
  const modulePath = path.join(ROOT, 'workflows', 'lib', 'install-consistency.mjs')
  const { parseFindingsTemplateFields, parseInstructedFields, parseSchemaFindingsProps, STRUCTURAL_FINDINGS_PROPS, REQUIRED_STRUCTURAL_PROPS, checkConsistency } = await import(pathToFileURL(modulePath).href)

  // M1 (round three): the structural floor, pinned. STRUCTURAL_FINDINGS_PROPS
  // exempts these four names from direction 2 (they come from the one-line
  // "[SEVERITY] <claim>: <file:line>" header and from review-mode AC
  // attribution, not from a colon-labeled template row), and that exemption
  // used to be one-directional: deleting `location` from an installed
  // REVIEW_SCHEMA reported consistent:true with missing_in_review_schema:[].
  // REQUIRED_STRUCTURAL_PROPS is the other direction, and it is per-schema
  // because PLAN_SCHEMA legitimately has no ac_id.
  //
  // Two pins, and both are load-bearing in opposite directions. WIDENING a
  // floor by one word is already loud without this test -- the repo's own
  // schemas would not declare the new word, so checkConsistency below reports
  // consistent:false and this test fails by name. NARROWING one (deleting an
  // entry, silently shrinking what the floor covers) is what this deepEqual
  // catches: it makes the deletion a visible two-place edit rather than a
  // one-line coverage loss nothing observes.
  assert.deepEqual([...REQUIRED_STRUCTURAL_PROPS.REVIEW_SCHEMA].sort(), ['ac_id', 'claim', 'location', 'severity'])
  assert.deepEqual([...REQUIRED_STRUCTURAL_PROPS.PLAN_SCHEMA].sort(), ['claim', 'location', 'severity'])
  assert.deepEqual(
    [...new Set([...REQUIRED_STRUCTURAL_PROPS.REVIEW_SCHEMA, ...REQUIRED_STRUCTURAL_PROPS.PLAN_SCHEMA])].sort(),
    [...STRUCTURAL_FINDINGS_PROPS].sort(),
    'the direction-2 exemption set must be DERIVED from the floors, not a third independent literal that can drift from them'
  )

  const doc = readAll('AGENT-HARNESS.md')
  const docFields = parseFindingsTemplateFields(doc)
  assert.ok(docFields, 'AGENT-HARNESS.md must have a ### FINDINGS heading followed by a fenced example block')
  assert.ok(docFields.size >= 3, `sanity: expected several colon-labeled fields in the FINDINGS template, found ${[...docFields]}`)
  assert.ok(docFields.has('recurrence'), 'sanity: the FINDINGS template must still name Recurrence -- this test exists to protect that specific field')

  const agentFiles = fs.readdirSync(path.join(ROOT, 'agents')).filter((f) => f.startsWith('lens-') && f.endsWith('.md'))
  assert.ok(agentFiles.length >= 9, `sanity: expected at least 9 agents/lens-*.md files, found ${agentFiles.length}`)
  const agentTexts = agentFiles.map((f) => readAll('agents', f))
  const agentFields = parseInstructedFields(agentTexts)
  assert.ok(agentFields.has('recurrence'), 'sanity: expected at least one agents/lens-*.md file to instruct filling the Recurrence field')

  const reviewSource = readAll('workflows', 'review-cycle.js')
  const planSource = readAll('workflows', 'plan-cycle.js')
  const reviewProps = parseSchemaFindingsProps(reviewSource, 'REVIEW_SCHEMA')
  const planProps = parseSchemaFindingsProps(planSource, 'PLAN_SCHEMA')
  assert.ok(reviewProps, 'expected "const REVIEW_SCHEMA" with a findings.items.properties block in workflows/review-cycle.js')
  assert.ok(planProps, 'expected "const PLAN_SCHEMA" with a findings.items.properties block in workflows/plan-cycle.js')
  assert.ok(reviewProps.size >= 3, `sanity: expected several findings properties parsed from review-cycle.js's REVIEW_SCHEMA, found ${[...reviewProps]}`)
  assert.ok(planProps.size >= 3, `sanity: expected several findings properties parsed from plan-cycle.js's PLAN_SCHEMA, found ${[...planProps]}`)

  const result = checkConsistency({ agentHarnessMd: doc, lensFileTexts: agentTexts, planCycleSource: planSource, reviewCycleSource: reviewSource })
  assert.equal(result.blind, false, `the parser must not be blind against the repo's own tree: ${JSON.stringify(result.blind_reasons)}`)

  // Direction 3 (M1, round three): a schema that has LOST a structural
  // property. Direction 1 cannot see this -- nothing on the doc side names
  // these four -- and direction 2 only ever reports EXTRA properties.
  assert.deepEqual(result.missing_structural_in_review_schema, [], 'REVIEW_SCHEMA\'s findings items have lost a structural property (severity/claim/location/ac_id)')
  assert.deepEqual(result.missing_structural_in_plan_schema, [], 'PLAN_SCHEMA\'s findings items have lost a structural property (severity/claim/location)')

  // Direction 1 (H3 itself): a field documented in the template, or one
  // agents/*.md are told to fill, must have a schema slot in BOTH workflows
  // that build a lens-output schema from this contract.
  for (const field of result.missing_in_review_schema) {
    assert.fail(`"${field}" is named in AGENT-HARNESS.md's FINDINGS template or instructed in agents/lens-*.md, but review-cycle.js's REVIEW_SCHEMA does not declare a matching findings-item property -- an instructed field with no schema slot is silently dropped (H3)`)
  }
  for (const field of result.missing_in_plan_schema) {
    assert.fail(`"${field}" is named in AGENT-HARNESS.md's FINDINGS template or instructed in agents/lens-*.md, but plan-cycle.js's PLAN_SCHEMA does not declare a matching findings-item property -- an instructed field with no schema slot is silently dropped (H3)`)
  }

  // Direction 2 (vice versa): a schema property that is NOT one of the
  // structural fields (severity/claim/location come from the one-line
  // "[SEVERITY] <claim>: <file:line>" header, not a colon-labeled template
  // row; ac_id is review-mode AC attribution, a separate mechanism from the
  // FINDINGS template) must be named in the template -- otherwise the
  // schema invites a value nothing ever told a lens to produce.
  for (const prop of result.review_only_props) {
    assert.fail(`REVIEW_SCHEMA's findings items declare "${prop}", but AGENT-HARNESS.md's FINDINGS template does not name it -- a schema field nothing instructs a lens to fill`)
  }
  for (const prop of result.plan_only_props) {
    assert.fail(`PLAN_SCHEMA's findings items declare "${prop}", but AGENT-HARNESS.md's FINDINGS template does not name it -- a schema field nothing instructs a lens to fill`)
  }
  assert.ok(result.consistent, 'sanity: no direction-1 or direction-2 mismatch was reported above, so the overall verdict must be consistent')
})

// --- specs/harn-fix-2.md: AC-OPS-14, AC-PROD-4, AC-SEC-7, AC-QA-19. ---

test('static AC-OPS-14: hooks.json\'s registered PreToolUse/Bash scripts and README\'s manual-install settings.json snippet register the SAME set, so adding one and not the other fails here', () => {
  const hooksJson = JSON.parse(readAll('hooks', 'hooks.json'))
  const registered = new Set()
  for (const group of hooksJson.hooks.PreToolUse || []) {
    for (const hook of group.hooks || []) {
      registered.add(path.basename(hook.args[0]))
    }
  }
  assert.ok(registered.size >= 2, `sanity: expected at least 2 registered PreToolUse scripts, found ${registered.size}`)

  const readme = readAll('README.md')
  const snippetStart = readme.indexOf('### As a plugin')
  const snippetSection = readme.slice(snippetStart, readme.indexOf('## Recovering destroyed work'))
  const named = new Set([...snippetSection.matchAll(/hooks\/([a-z0-9-]+\.py)/g)].map((m) => m[1]))

  for (const script of registered) {
    assert.ok(named.has(script), `${script} is registered in hooks.json but not named in README's install section`)
  }
})

test('static AC-PROD-4: README states what the snapshot mechanism does NOT cover, and what it writes into a reader\'s own repository, before the install snippet', () => {
  const readme = readAll('README.md')
  assert.match(readme, /untracked files.*ignored files/is, 'README must name untracked and ignored files as uncovered loss paths')
  assert.match(readme, /never written to disk/i, 'README must name work never written to disk as an uncovered loss path')
  assert.match(readme, /`cd`s or `git -C`s into/i, 'README must name a cd/-C target repository as an uncovered loss path')
  assert.match(readme, /non-Bash tool call/i, 'README must name non-Bash tool calls (Write, Edit) as an uncovered loss path')
  const guardSectionStart = readme.indexOf('## Destructive git guard')
  const guardSectionEnd = readme.indexOf('## Recovering destroyed work')
  const guardSection = readme.slice(guardSectionStart, guardSectionEnd)
  const installIdx = guardSection.lastIndexOf('Installing as a plugin wires the hook automatically')
  const writesStatementIdx = guardSection.indexOf('this repo writes only')
  assert.ok(installIdx !== -1, 'README\'s guard section must contain its own install snippet intro')
  assert.ok(writesStatementIdx !== -1 && writesStatementIdx < installIdx + 400, 'README must state what the hooks write into the reader\'s own repository, at (or immediately around) the install snippet')
})

test('static AC-SEC-7: README\'s guard section states the detector is a best-effort early catch (no completeness claim) and names the measured-open bypass classes', () => {
  const readme = readAll('README.md')
  assert.match(readme, /best-effort early catch, not a boundary/i)
  for (const bypass of ['env', 'command', '\\$\\(which git\\)', 'eval', 'subshell', 'bash\\s*-c', 'xargs', 'here-document']) {
    assert.match(readme, new RegExp(bypass, 'i'), `README's guard section must name the "${bypass}" bypass class`)
  }
})

// AC-QA-19: table-driven -- every spelling README documents as covered by
// the detector is refused on a genuinely dirty file; every spelling it
// documents as deliberately out of scope is allowed. Fails in BOTH
// directions, so neither a closed hole nor a stopped guard leaves the
// documentation stale.
test('static AC-QA-19: every GUARDED shape is refused and every OUT-OF-SCOPE shape is allowed against a genuinely dirty file', () => {
  const { makeTempRepo, cleanupTempRepos, sh, sanitizedGitEnv: sge } = require('./helpers/temp-repo.js')
  const HOOK_PATH = path.join(ROOT, 'hooks', 'destructive-git-guard.py')
  const fsMod = require('node:fs')

  function runHook(command, dir) {
    return spawnSync('python3', [HOOK_PATH], {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: dir }),
      encoding: 'utf8', env: sge(), timeout: 10000,
    })
  }

  const GUARDED = [
    'git checkout -- README.md',
    'git checkout README.md',
    'git checkout .',
    'git checkout -f',
    'git switch -f other',
    'git restore README.md',
    'git reset --hard',
  ]
  const OUT_OF_SCOPE = [
    'git clean -fd',
    'git stash drop',
    'git branch -D other',
    'git checkout -b newbranch',
  ]

  try {
    for (const command of GUARDED) {
      const dir = makeTempRepo()
      sh('git branch other', dir)
      fsMod.writeFileSync(path.join(dir, 'README.md'), 'dirty\n')
      const res = runHook(command, dir)
      assert.equal(res.status, 2, `GUARDED "${command}" must be refused (exit 2), got ${res.status}; stderr: ${res.stderr}`)
    }
    for (const command of OUT_OF_SCOPE) {
      const dir = makeTempRepo()
      sh('git branch other', dir)
      fsMod.writeFileSync(path.join(dir, 'README.md'), 'dirty\n')
      const res = runHook(command, dir)
      assert.equal(res.status, 0, `OUT-OF-SCOPE "${command}" must be allowed (exit 0), got ${res.status}; stderr: ${res.stderr}`)
    }
  } finally {
    cleanupTempRepos()
  }
})

// harn-fix-4 (the class, not just the instance): agents/implementer.md was
// absent from this repo for its entire history (git log --all -- confirms
// zero commits ever touched it) while workflows/tdd-task.js dispatched
// agentType: 'implementer' at two call sites and AGENT-HARNESS.md's own
// contract line named it as the agent that builds. Nothing in the repo ever
// checked that every agentType a workflow or skill can DISPATCH has a
// matching DEFINITION under agents/ -- install-consistency.mjs (see its own
// header) only ever verifies an INSTALL against this repo, never that this
// repo is internally complete, so a genuinely missing agent definition and a
// byte-perfect install of that same gap both report "consistent". This test
// closes that specific hole: it is deliberately scoped to what this repo's
// three workflow scripts actually do, not a general-purpose JS parser (this
// codebase has no dependencies and no parser, matching every other
// text-scan check in this file), and its coverage is proven by mutation
// below rather than merely argued.
//
// Three shapes of agentType reference exist in this codebase, and each needs
// its own extraction:
//   1. A literal `agentType: 'name'` -- workflows/tdd-task.js's two
//      'implementer' call sites.
//   2. Every element of the `const ALL = [...]` roster array in
//      plan-cycle.js and review-cycle.js -- the complete set of lens names
//      `agentType: lens` can ever be called with at runtime, since `lens` is
//      a loop variable, not a literal, and ALL is each file's own documented
//      superset of everything `lenses` can contain (see the "deterministic
//      lens triggering" block in both files).
//   3. Any string passed to `lenses.push(...)` -- review-cycle.js pushes
//      'reviewer-verification' under opts.adversarial, which is a real
//      dispatchable agentType that ALL deliberately does not enumerate
//      (reviewer-verification is a specialist, not a standing lens; see
//      AGENT-HARNESS.md's roster). Every OTHER push in both files (the
//      trigger-driven `lenses.push('lens-design', 'lens-accessibility')`
//      shapes) is already a subset of that file's own ALL array, so this
//      step only ever adds names ALL would have missed.
function extractAgentTypeReferences(source) {
  const types = new Set()
  for (const m of source.matchAll(/agentType:\s*'([A-Za-z0-9_-]+)'/g)) types.add(m[1])
  const allMatch = /const ALL = \[([^\]]*)\]/.exec(source)
  if (allMatch) {
    for (const m of allMatch[1].matchAll(/'([A-Za-z0-9_-]+)'/g)) types.add(m[1])
  }
  for (const pushCall of source.matchAll(/lenses\.push\(([^)]*)\)/g)) {
    for (const m of pushCall[1].matchAll(/'([A-Za-z0-9_-]+)'/g)) types.add(m[1])
  }
  return types
}

test('static: HARN-FIX-4 -- every agentType referenced anywhere in workflows/ or skills/ has a matching definition file in agents/ (the class of defect that shipped tdd-task.js dispatching agentType: \'implementer\' with no agents/implementer.md in the repo, ever)', () => {
  const targets = [
    ...walk(path.join(ROOT, 'workflows')).filter((f) => f.endsWith('.js')),
    ...walk(path.join(ROOT, 'skills')).filter((f) => f.endsWith('.md')),
  ]
  assert.ok(targets.length > 3, `sanity: expected several workflow/skill files, found ${targets.length}`)

  const referenced = new Set()
  for (const f of targets) {
    for (const t of extractAgentTypeReferences(fs.readFileSync(f, 'utf8'))) referenced.add(t)
  }
  // ANTI-VACUITY: a scan that finds nothing is not evidence nothing is
  // referenced, it is evidence the extraction broke -- mirrors every other
  // blind/anti-vacuity check in this file and in install-consistency.mjs.
  assert.ok(referenced.size >= 10, `sanity: expected at least 10 distinct agentType references across workflows/skills, found ${referenced.size}: ${[...referenced].sort().join(', ')}`)

  const definedAgents = new Set(
    fs.readdirSync(path.join(ROOT, 'agents'))
      .filter((f) => f.endsWith('.md'))
      .map((f) => f.slice(0, -'.md'.length))
  )
  assert.ok(definedAgents.size >= 10, `sanity: expected at least 10 agent definition files, found ${definedAgents.size}`)

  const missing = [...referenced].filter((t) => !definedAgents.has(t)).sort()
  assert.deepEqual(missing, [], `agentType(s) referenced in workflows/ or skills/ with no matching agents/<name>.md definition: ${missing.join(', ')}`)
})

// ---------------------------------------------------------------------------
// Round-two review M3. Four prose duties this change adds, or that its new
// code DEPENDS on, were pinned by nothing: the reviewer deleted all four (53
// lines across four files) and the suite stayed at 1095 pass, 0 fail.
//
// The sharpest of them is agents/lens-architecture.md's dead-code duty.
// workflows/review-cycle.js now wakes that lens on every UI diff, and its
// comment states in so many words that the lens holds the roster's only
// "dead code this change created and did not remove" duty. That claim is true
// today and asserted by nothing: paraphrase the duty away and the harness
// keeps dispatching the lens, the ledger keeps recording it as triggered, and
// the orphaned-control class goes unowned again behind a fully green gate.
// Code depending on prose in another file, with no assertion joining them, is
// the same absence-reads-as-success shape in a new place.
//
// Pins the minimum phrase that would notice deletion, never the paragraph:
// an assertion on prose that fails on every wording improvement trains people
// to loosen it. Same idiom this file already uses for conduct-plan's SKILL.md.
const PROSE_DUTIES = [
  {
    file: 'agents/lens-architecture.md',
    re: /[Dd]ead code this change created and did not remove/,
    why: 'workflows/review-cycle.js wakes this lens on every UI diff BECAUSE of this duty, and says so in its own comment. If the duty goes, the trigger is cost with no owner.',
  },
  {
    file: 'AGENT-HARNESS.md',
    re: /## What a change replaces/,
    why: 'the headline contract of this change: the lens owning the area owns the removal.',
  },
  {
    file: 'AGENT-HARNESS.md',
    re: /removal as its own numbered criterion/,
    why: 'the section can survive as a heading while the load-bearing sentence is paraphrased out. Review verifies criteria, so a removal that is not a criterion is invisible to it.',
  },
  {
    file: 'agents/lens-design.md',
    re: /do something different from its neighbours/,
    why: 'the on-screen control inventory: the duty that would actually have caught the reported defect, which lens-architecture cannot because it reads the call graph, not the screen.',
  },
  {
    file: 'agents/lens-product.md',
    re: /what must exist for it to be observable/,
    why: 'without this the success measure reverts to prose nobody verifies, which is the analytics half of the same defect.',
  },
  {
    file: 'AGENT-HARNESS.md',
    re: /### MEASURED AT/,
    why: 'the published lens output contract must list the field REVIEW_SCHEMA now requires. Review round one, finding H: the schema required head_sha_measured and omitting it aborts the whole run, while the contract adopting users read said "every lens returns exactly this" and never mentioned it. Anyone writing a lens from the published contract produced one that aborts every review it joins.',
  },
  {
    file: 'specs/harn-opt-3.md',
    re: /RESIDUAL EXPOSURE, STATED/,
    why: 'the scrub of 2026-09-05 changed the tip only; the material is still reachable on the public default branch. If this declaration is tidied away the repo silently starts claiming a closed item again, which is what AC-SEC-9 did until this round (review HIGH-2).',
  },
  {
    file: 'agents/lens-product.md',
    re: /owns its minimisation, retention and/,
    why: 'the brake on the clause above. Requiring a measurement criterion makes per-user behavioural data a standing planning deliverable, so the routing of the personal half to lens-security is load-bearing, not decoration (round-one review M3).',
  },
]

// ---------------------------------------------------------------------------
// Owner decision 2026-09-05: repo NAMES may stay, the OPERATIONAL DETAIL beside
// them may not. Names are covered by LEAK_PATTERNS; this covers what a regex on
// a name never could.
//
// What was published in this PUBLIC repo until 2026-09-05: a delivery system's
// live compose project name, every running container name, its production
// database volume, its rollback tags, the fact that its own settings allow-list
// permitted a broadly destructive shell command while it sat first in an
// unsandboxed weekly job's list, and one credential named outright. Together
// that was a working runbook for destroying someone's production, published in
// a document arguing for care.
//
// FIRST ATTEMPT AT THIS GUARD WAS WORSE THAN THE PROBLEM, review round one
// HIGH-1. It listed the banned strings as plain regex literals, and exempted
// its own file so it stayed green. Net effect: the three identifiers were
// removed from three spec files and CONCENTRATED into one file, each beside a
// label saying exactly what it was, in a public repo, with the spec now
// asserting they had been removed so the next reader would not look. A deny-list
// that names what it denies is not a scrub. Proven: planting the literal in
// README, AGENT-HARNESS.md or any workflow was caught every time; planting the
// identical line in this file left the suite 56/56 green.
//
// So the identity-bearing literals are stored as DIGESTS, never as text, and
// this file is no longer exempt from anything.
//
// How it matches without holding the string: each file is reduced to its
// alphanumeric atoms (`some-project-name_pgdata` -> some, project, name,
// pgdata), then every window of 1..MAX_ATOMS consecutive atoms is concatenated
// and hashed. That example is deliberately fictional: the FIRST draft of this
// very comment used the real name to illustrate the point, and this guard
// caught it on the next run, which is the behaviour the round-one finding
// asked for. Separator-insensitive by construction, so it catches
// the hyphenated, underscored and camel-joined forms alike, and it catches the
// literal embedded in a longer token, which is how the production volume name
// was formed in the first place.
//
// Honest about what this buys: SHA-256 of a short known string is brute-forcible
// by anyone who already GUESSES the value. It defeats discovery by reading or
// code-searching the repo, which is the actual exposure here. It is not a
// secret store, and nothing that needs one should ever be put in this list.
//
// To add a literal WITHOUT publishing it:
//   node -e "const c=require('node:crypto');const t=process.argv[1].toLowerCase().match(/[a-z0-9]+/g);console.log(c.createHash('sha256').update(t.join('')).digest('hex'),t.length)" 'the-string'
// `atoms` is documentation of the literal's shape only. Every window size from
// 1 to MAX_ATOMS is tried regardless: see scrubbedHit().
const SCRUBBED_TOKEN_HASHES = [
  { sha256: '2e4702de24a792d564a59fc4663f24c07b5fe615665050c4d5f92f58c6988fb5', atoms: 3, what: "a delivery repo's live compose project name and container prefix" },
  { sha256: '66a9b0d52d8e642154e4182cb446b506e1bf8efca1729ce74d361d8faa789557', atoms: 2, what: "a delivery repo's staging project name" },
  { sha256: '65722b6ab0c761e28847c08c2e8e8ef6fe999bd97d5b6ec5bc56acb8bba2073b', atoms: 3, what: 'a specific credential, named' },
]

// SHAPES, not identities. These reveal nothing about any particular system, so
// they stay as readable patterns: a rollback tag's format is a convention, and
// `rm -rf` is not a secret. What made the original disclosure serious was the
// ASSOCIATION with a named system, and the name is now hashed.
// CO-OCCURRENCE, round-one review MEDIUM-2. The digests above pin the identity
// literals; they did not pin the OTHER four things this scrub removed, which
// were volumetric attributions: a named delivery repo beside a file count or a
// disk size. Proven by mutation: restoring the exact sentence this change
// removed from specs/harn-opt-2.md passed 1098/1098.
//
// A bare-literal rule cannot cover it, because the figures alone are legitimate
// and still present, deliberately unattached, in README.md and the weekly
// script ("a real delivery repo held 50,120 files") -- that is evidence, not a
// disclosure. What made it a disclosure was the ATTRIBUTION. So the rule is
// co-occurrence on one line, in either order, and it leaves the anonymous form
// alone. specs/ waives the repo-name pattern under the owner's naming ruling,
// so nothing else would catch this.
const REPO_NAME_RE = /said.?of.?you|couchpotato/i
const VOLUMETRIC_RE = /\b\d{1,3}(?:,\d{3})+\b|\b\d+(?:\.\d+)?\s?[KMGT]B\b/

const SCRUBBED_SHAPES = [
  { re: /rollback-2026\d{4}-\d{6}/, what: 'a production rollback tag' },
  { re: /Bash\(rm -rf/, what: 'a destructive permission allow-list entry' },
]

const MAX_ATOMS = 4

function scrubbedHit(text) {
  const atoms = text.toLowerCase().match(/[a-z0-9]+/g) || []
  const want = new Map(SCRUBBED_TOKEN_HASHES.map((e) => [e.sha256, e]))
  // EVERY window size 1..MAX_ATOMS, not only the sizes the entries declare.
  // Deriving the sizes from `atoms` missed the camel-joined form: BirthdayFoo
  // lowercases to ONE atom whose join equals the three-atom join, so a literal
  // written without separators slipped straight through a guard that only ever
  // tried three-atom windows. Caught by mutation, not by reading.
  for (let i = 0; i < atoms.length; i += 1) {
    for (let n = 1; n <= MAX_ATOMS; n += 1) {
      if (i + n > atoms.length) continue
      const h = crypto.createHash('sha256').update(atoms.slice(i, i + n).join('')).digest('hex')
      const e = want.get(h)
      if (e) return e.what
    }
  }
  return null
}

test('static: no tracked file republishes the operational detail scrubbed on 2026-09-05 -- production project and container names, the database volume, rollback tags, a named credential, or a destructive allow-list entry (round-one HIGH-1: the literals are stored as digests, and this file is NOT exempt)', () => {
  let scanned = 0
  for (const rel of trackedFiles()) {
    const abs = path.join(ROOT, rel)
    if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) continue
    const raw = fs.readFileSync(abs)
    if (raw.subarray(0, 4096).includes(0)) continue
    const text = raw.toString('utf8')
    scanned += 1
    const hit = scrubbedHit(text)
    assert.equal(hit, null, `${rel} republishes scrubbed operational detail (${hit}). This was removed on the owner's decision; the argument it supported is kept without the identifier. Do NOT add the literal here to silence this -- add its digest, per the one-liner above.`)
    for (const { re, what } of SCRUBBED_SHAPES) {
      assert.ok(!re.test(text), `${rel} republishes a scrubbed shape (${what}).`)
    }
    if (rel !== 'test/static-checks.test.js') {
      for (const [n, line] of text.split('\n').entries()) {
        const bad = REPO_NAME_RE.test(line) && VOLUMETRIC_RE.test(line)
        assert.ok(!bad, `${rel}:${n + 1} names a delivery repo on the same line as a file count or disk size. The figure on its own is fine and is used that way elsewhere; attributing it to a named system is what was scrubbed on 2026-09-05.`)
      }
    }
  }
  assert.ok(scanned > 50, `only ${scanned} files scanned`)
})


// ---------------------------------------------------------------------------
// Round-one review HIGH-2: THE SCRUB ABOVE IS TIP-ONLY, and that is recorded in
// the spec rather than enforced here. The reason is worth writing down.
//
// `trackedFiles()` is `git ls-files`, so every guard in this file measures the
// working tree and nothing else. Measured, not assumed: the runbook identifiers
// are in the CURRENT tree of the public default branch AND in its history, and
// the credential name is in three reachable commits on origin/main, one of
// which names its file -- while AC-SEC-9 asserted this had been purged. That claim is
// corrected in this change. The key VALUE is not published: zero key-shaped
// values were added anywhere in history.
//
// I WROTE A HISTORY-SCANNING TEST HERE AND DELETED IT, because it was vacuous.
// To search history without holding the literal it hashed atom windows out of
// sampled blobs; instrumented, it found ONE of the three digests it was meant
// to detect, and passed. The sampling (400 paths, three commits each) could not
// reach the commits that carry them. A real search needs `git log -S <literal>`,
// which needs the literal in the tree, which is precisely what HIGH-1 says must
// not be here. So the honest options were an expensive test that lies, or no
// test. Recorded rather than quietly dropped, because a deleted guard with no
// explanation is indistinguishable from one nobody thought of.
//
// What IS enforced, below and cheaply: the residual declaration exists in the
// spec. That is the thing that actually decays -- someone tidies the redaction
// note away and the repo silently starts claiming a closed item again. Whether
// to rewrite public history is the owner's decision and was never a test's to
// make.


test('static: the prose duties that this harness\'s own CODE depends on are still present in the agent and contract files (round-two review M3) -- a duty relied on by a trigger, with no assertion joining them, can be paraphrased away behind a green gate', () => {
  for (const { file, re, why } of PROSE_DUTIES) {
    const contents = readAll(file)
    assert.match(contents, re, `${file} no longer carries a load-bearing duty: ${why}`)
  }
})
