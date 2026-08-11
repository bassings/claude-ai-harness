// Hostile-path fixture helper (review round-2, Decision 2): builds a temp
// git repo whose own absolute root path is deliberately hostile to
// regex/character-class-based path handling -- a space, a symlinked
// parent segment, a non-ASCII segment and a bracket/paren character, all
// at once. Three rounds of write-time redaction defects (C1, H1, H2, H3)
// each slipped through because every existing fixture built its temp repo
// under a plain, space-free, symlink-free, ASCII-only TMPDIR path. This
// helper exists so identity/path tests exercise the real boundary, not a
// vanilla one that happens to avoid it. §9/§11: mechanised, not remembered
// -- every identity/path test must run against this, not only a bare
// makeTempRepo().
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { SUITE_TMPDIR, sh, trackTempDir } = require('./temp-repo.js')

function initGitRepo(repo) {
  fs.mkdirSync(repo, { recursive: true })
  sh('git init -q -b main', repo)
  sh('git config user.email test@example.com', repo)
  sh('git config user.name Test', repo)
  fs.writeFileSync(path.join(repo, 'README.md'), 'seed\n')
  sh('git add README.md && git commit -q -m seed', repo)
  return repo
}

// Returns the repo root as the SYMLINKED path (what a real cwd/argv would
// be) -- the real (target) directory is a DIFFERENT, longer path, exactly
// the /var/folders -> /private/var/folders shape macOS gives TMPDIR.
function makeHostileTempRepo() {
  const realParent = fs.mkdtempSync(path.join(SUITE_TMPDIR, 'hostile-real-'))
  const realDir = path.join(realParent, 'docs (v2)', '日本語 space dir')
  fs.mkdirSync(realDir, { recursive: true })
  const linkParent = fs.mkdtempSync(path.join(SUITE_TMPDIR, 'hostile-link-'))
  const symlinkPath = path.join(linkParent, 'via-symlink')
  fs.symlinkSync(realDir, symlinkPath, 'dir')
  trackTempDir(realParent)
  trackTempDir(linkParent)
  return initGitRepo(path.join(symlinkPath, 'repo'))
}

// Same shape, but nested under a literal "home/<real whoami>" segment, for
// tests asserting leak-freedom (a leaked path here would contain BOTH a
// home-like segment and the real account name, not a stand-in for either).
// os.userInfo().username is used, not a shelled-out `whoami` -- this file
// (and its consumers) must stay usable from within read-only aggregation
// tests without a subprocess dependency.
function makeHomeLikeHostileTempRepo() {
  const whoami = os.userInfo().username
  const realParent = fs.mkdtempSync(path.join(SUITE_TMPDIR, 'hostile-home-real-'))
  const realDir = path.join(realParent, 'home', whoami, 'docs (v2)', '日本語 space dir')
  fs.mkdirSync(realDir, { recursive: true })
  const linkParent = fs.mkdtempSync(path.join(SUITE_TMPDIR, 'hostile-home-link-'))
  const symlinkPath = path.join(linkParent, 'via-symlink')
  fs.symlinkSync(realDir, symlinkPath, 'dir')
  trackTempDir(realParent)
  trackTempDir(linkParent)
  const repo = initGitRepo(path.join(symlinkPath, 'repo-' + Math.random().toString(36).slice(2)))
  return { repo, whoami }
}

// A repo root containing ONLY a space (no symlink, no non-ASCII) -- H2's
// exact reproduction ("My Repos"), isolated from the other hostile
// properties so a test can attribute a failure to the space specifically.
function makeSpacyTempRepo() {
  const parent = fs.mkdtempSync(path.join(SUITE_TMPDIR, 'hostile-spacy-'))
  trackTempDir(parent)
  return initGitRepo(path.join(parent, 'My Repos', 'mainrepo'))
}

module.exports = { makeHostileTempRepo, makeHomeLikeHostileTempRepo, makeSpacyTempRepo }
