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
//                      direct git call in the suite is clean by default,
//                      including call sites that never heard of this module.
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
const GIT_ENV_VARS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_COMMON_DIR',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
]

function scrubGitEnv() {
  for (const key of GIT_ENV_VARS) delete process.env[key]
}

function sanitizedGitEnv(extra = {}) {
  const env = { ...process.env, ...extra }
  for (const key of GIT_ENV_VARS) delete env[key]
  return env
}

module.exports = { GIT_ENV_VARS, scrubGitEnv, sanitizedGitEnv }
