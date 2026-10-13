// HARN-OPT-5 T5: acts out the ledger:write prompt the way a compliant agent
// would, so a test proves the INSTRUCTED steps (mktemp, write the encoded
// payload to the file, run the writer with the file on stdin, rm the file)
// rather than a hand-typed stand-in. Commands are recovered from the
// backtick-quoted spans in the prompt, never re-typed here, so a prompt that
// drifts from the contract fails these tests instead of passing them.
const fs = require('node:fs')
const { spawnSync } = require('node:child_process')
const { extractEncodedPayload } = require('./extract-ledger-payload.js')
const { APPEND_SCRIPT, sanitizedGitEnv } = require('./temp-repo.js')

function backtickSpans(prompt) {
  return [...String(prompt).matchAll(/`([^`\n]+)`/g)].map((m) => m[1])
}

// Review round 1 F2 (AC-QA-14): a backtick inside interpolated payload text would close a command span early and hide
// the rest of the line from the stand-in agent, while a real agent substitutes the whole instruction. A command span
// is only accepted when the character after its closing backtick is one that can follow a command in prose
// (whitespace, punctuation or the end of the text); anything else means the span was cut mid-payload.
function commandSpans(prompt) {
  const text = String(prompt)
  const out = []
  for (const m of text.matchAll(/`([^`\n]+)`/g)) {
    const span = m[1]
    if (!/^(mktemp|node|rm) /.test(span)) continue
    const after = text.charAt(m.index + m[0].length)
    if (after !== '' && !/[\s.,;:)\]]/.test(after)) {
      throw new Error(`instructed command span ends mid-text (payload interpolated into a command?): \`${span}\` followed by ${JSON.stringify(after)}`)
    }
    out.push(span)
  }
  return out
}

// The three shell commands the prompt instructs, by leading word.
function instructedCommands(prompt) {
  const spans = commandSpans(prompt)
  return {
    mktemp: spans.filter((s) => s.startsWith('mktemp ')),
    node: spans.filter((s) => s.startsWith('node ')),
    rm: spans.filter((s) => s.startsWith('rm ')),
  }
}

function runSh(command, { cwd, env }) {
  return spawnSync('/bin/sh', ['-c', command], { cwd, env, encoding: 'utf8' })
}

// scratchDir plays the part of TMPDIR (outside every git working tree).
// writerEnvPrefix, e.g. 'HARNESS_LEDGER_READONLY=1 ', goes on the writer's
// command line. Returns what happened at each step.
function actAsCompliantAgent(prompt, { cwd, scratchDir, writerEnvPrefix = '' }) {
  const cmds = instructedCommands(prompt)
  if (cmds.mktemp.length !== 1 || cmds.node.length !== 1 || cmds.rm.length !== 1) {
    throw new Error(`actAsCompliantAgent: expected one mktemp, one node and one rm command in the prompt, got ${JSON.stringify(cmds)}`)
  }
  const env = sanitizedGitEnv({ TMPDIR: scratchDir })
  const made = runSh(cmds.mktemp[0], { cwd, env })
  const file = made.stdout.trim()
  if (made.status !== 0 || !file) throw new Error(`mktemp failed: ${made.stderr}`)
  fs.writeFileSync(file, extractEncodedPayload(prompt))
  const writerCommand = cmds.node[0].replace('<path-to-ledger-append.mjs>', APPEND_SCRIPT).replace('<the file>', file)
  if (/<[^>]*>/.test(writerCommand)) throw new Error('unsubstituted placeholder in the instructed writer command: ' + writerCommand)
  const wrote = runSh(writerEnvPrefix + writerCommand, { cwd, env })
  const result = JSON.parse(wrote.stdout.trim().split('\n').pop())
  // Review round 2 F2 (AC-SEC-4): the deletion decision comes from the prompt, as a real agent's would, so a step 5
  // weakened to keep the file on a failure path leaves the file behind here too and the end-to-end test goes RED.
  const rmCommand = cmds.rm[0].replace('<the file>', file)
  if (deletesOnOutcome(prompt)) runSh(rmCommand, { cwd, env })
  return { file, writerCommand: writerEnvPrefix + writerCommand, result, commands: cmds }
}

// Review round 3 F1 (AC-SEC-4): the agreed step texts, pinned VERBATIM. Round 2 read step 5 through a denylist of
// carve-out phrasings and round 3 showed a rephrased carve-out ("skip this delete and keep the payload") sailing past
// it. Enumerating wordings never closes; an exact pin does, and the L5 block is byte-identical across the three
// workflows so one string covers all of them. Any change to a step must change the pin here on purpose.
const EXPECTED_STEP_2 = "2. Create the payload file by exclusive create, with exactly this command and nothing else: `mktemp \"${TMPDIR:-/tmp}/harn-ledger-XXXXXX\"`. It prints the path of a new, empty file in a directory outside every git working tree; call that path \"the file\". Never put the file inside the checkout (never under `git rev-parse --show-toplevel`, never in a worktree), never use a fixed name or path, and never derive a name from the run_id. If mktemp fails or prints nothing, or the path somehow already holds content (a collision: read it and check it is empty), report write_ok false with write_error naming that, do not run the writer at all and do not pipe anything to it, and go straight to step 5."
const EXPECTED_STEP_3 = "3. The payload below is base64-encoded SPECIFICALLY so its raw text (which may contain quotes or other shell metacharacters authored by a reviewed diff, a lens finding, or task text) never reaches a shell command. Do not decode it, inspect it, or reconstruct the JSON by hand. Put exactly the text between the two delimiter lines (the delimiter lines themselves excluded, nothing added) into the file with your file-writing tool (the Write tool), reading the empty file first if the tool requires that. Never write it via a shell command, and never put any of it in a Bash command."
const EXPECTED_STEP_5 = "5. Delete exactly that one file with `rm \"<the file>\"`, on every exit path: after a successful write, after write_ok false, when the writer was not found or could not be found, when node fails to start, and after a collision. Delete only that one file: no glob, no flags, no directory."

// One numbered step of the prompt: from "\nN. " to the next numbered step or the closing paragraph.
function stepOf(prompt, n) {
  const text = String(prompt)
  const start = text.indexOf(`\n${n}. `)
  if (start < 0) return null
  const rest = text.slice(start + 1)
  const next = rest.search(/\n(\d\. |If the script)/)
  return next >= 0 ? rest.slice(0, next) : rest
}

// The stand-in agent deletes on every outcome ONLY when step 5 is exactly the agreed text; any other wording fails
// closed (the file is kept), so a weakened or rephrased step 5 leaves the file behind in the end-to-end test.
function deletesOnOutcome(prompt) {
  return stepOf(prompt, 5) === EXPECTED_STEP_5
}

module.exports = { backtickSpans, instructedCommands, runSh, actAsCompliantAgent, deletesOnOutcome, stepOf, EXPECTED_STEP_2, EXPECTED_STEP_3, EXPECTED_STEP_5 }
