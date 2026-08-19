// Neutralises git's environment-variable context for this test process.
//
// git resolves its repository from the environment BEFORE it considers the
// working directory: GIT_DIR wins over cwd, always. So a test that runs
// `git init` in a fresh temp directory with an inherited environment does
// not create a repo there at all when GIT_DIR is set -- it silently
// re-initialises the repo GIT_DIR names ("warning: re-init") and every
// subsequent fixture command lands in that real repository.
//
// The environment gets set behind your back: git exports GIT_DIR into hook
// subprocesses, and only when the invoking command came from a linked
// worktree. So the standalone verdict and the hook verdict disagree --
// `make verify` passes because nothing set GIT_DIR, and the same suite run
// through a pre-push hook from a worktree corrupts a checkout. Reported by
// the CouchPotatoServer session on 2026-08-18 after it landed there twice.
//
// Two layers, because one is forgettable:
//
//   scrubGitEnv()      removes the variables from this process's own env at
//                      module load, so every inherited child spawn and every
//                      direct git call IN THIS PROCESS is clean by default.
//
//                      Read that boundary literally. node --test runs each
//                      test FILE in its own process, so the scrub is
//                      per-file, NOT suite-wide. A file that never imports
//                      this module (directly, or via temp-repo.js /
//                      hostile-repo.js, which import it) is alone and
//                      unprotected -- another file having scrubbed buys it
//                      nothing. Any NEW test file that shells out to git and
//                      forgets the import is unprotected from the moment it
//                      is created. The only thing standing between that and
//                      a corrupted checkout is the enforcement guard in
//                      test/static-checks.test.js, which fails the suite
//                      when a git-invoking file does not load this one.
//
//                      This paragraph exists because the first version of
//                      this comment said "every direct git call in the
//                      suite", which reads as a suite-wide guarantee and is
//                      not one.
//   sanitizedGitEnv()  builds an explicit clean env for a call site that
//                      constructs its own (`{ ...process.env, FOO: 'bar' }`
//                      copied before the scrub, or an env assembled from
//                      somewhere else).
//
// A test that deliberately exercises leaked-GIT_DIR behaviour passes the
// variable explicitly to its own child process, which the scrub does not
// undo -- see test/temp-repo.test.js.
//
// This must cover scripts that shell out to git internally, not only direct
// `git` invocations. workflows/lib/ledger-append.mjs runs `git check-ignore`
// and, via ensureGitignored(), WRITES .git/info/exclude -- so a leaked
// GIT_DIR sends that write into the wrong repository. Fixing only the
// visible `git` spawns and missing the script spawns is the exact omission
// the CouchPotatoServer session made first time through; the post-init
// assertion in makeTempRepo() is what catches that class.
// An ALLOWLIST, not a denylist, and the difference is not stylistic.
//
// The first version named six variables. Review raised that it had never been
// enumerated against git's real export set; measuring afterwards found two
// escapes, one of them severe:
//
//   GIT_CONFIG_COUNT / GIT_CONFIG_KEY_n / GIT_CONFIG_VALUE_n inject arbitrary
//   config into every git command (proven: an injected user.email came back
//   from `git config --get user.email`).
//
//   GIT_TEMPLATE_DIR makes `git init` copy that directory's hooks into every
//   new repository, and they RUN (proven: a planted pre-commit hook executed
//   during a fixture's own seed commit). Arbitrary code execution in every
//   throwaway repo the suite creates, from an environment variable.
//
// A denylist cannot be completed: it is wrong again the next time git adds a
// variable, and nothing tells you. Stripping everything in git's own GIT_*
// namespace inverts that -- a new variable is excluded the day it ships,
// without anyone noticing it exists.
//
// What survives is only what cannot redirect git to a different repository,
// object store, config or template: the author and committer identity, which
// affects what a commit RECORDS rather than where it LANDS. A fixture that
// wants deterministic commit metadata can still set them. If something later
// needs another variable kept, add it here deliberately, with the reason --
// which is the point of an allowlist: additions are decisions, not omissions.
const GIT_ENV_ALLOWLIST = new Set([
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_AUTHOR_DATE',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
  'GIT_COMMITTER_DATE',
])

// Every GIT_* key present in `env` that is not allowlisted.
function gitEnvKeysToStrip(env) {
  return Object.keys(env).filter((key) => key.startsWith('GIT_') && !GIT_ENV_ALLOWLIST.has(key))
}

function scrubGitEnv() {
  for (const key of gitEnvKeysToStrip(process.env)) delete process.env[key]
}

function sanitizedGitEnv(extra = {}) {
  const env = { ...process.env, ...extra }
  for (const key of gitEnvKeysToStrip(env)) delete env[key]
  return env
}

module.exports = { GIT_ENV_ALLOWLIST, gitEnvKeysToStrip, scrubGitEnv, sanitizedGitEnv }
