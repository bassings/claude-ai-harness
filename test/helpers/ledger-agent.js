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
  // The real paths reach the shell as environment variables, never spliced into the command text (CodeQL
  // js/shell-command-injection-from-environment). Each placeholder is swapped for a bare variable reference and the
  // prompt's own quoting is left exactly as written: the script path is unquoted in the prompt, so it is unquoted here
  // too, and a path with a space breaks this stand-in the same way it would break a real agent following the prompt.
  const runEnv = { ...env, HARN_APPEND_SCRIPT: APPEND_SCRIPT, HARN_PAYLOAD_FILE: file }
  const writerCommand = cmds.node[0].replace('<path-to-ledger-append.mjs>', '$HARN_APPEND_SCRIPT').replace('<the file>', '$HARN_PAYLOAD_FILE')
  if (/<[^>]*>/.test(writerCommand)) throw new Error('unsubstituted placeholder in the instructed writer command: ' + writerCommand)
  const wrote = runSh(writerEnvPrefix + writerCommand, { cwd, env: runEnv })
  const result = JSON.parse(wrote.stdout.trim().split('\n').pop())
  // Review round 2 F2 (AC-SEC-4): the deletion decision comes from the prompt, as a real agent's would, so a step 5
  // weakened to keep the file on a failure path leaves the file behind here too and the end-to-end test goes RED.
  const rmCommand = cmds.rm[0].replace('<the file>', '$HARN_PAYLOAD_FILE')
  if (deletesOnOutcome(prompt)) runSh(rmCommand, { cwd, env: runEnv })
  return { file, writerCommand: writerEnvPrefix + writerCommand, result, commands: cmds }
}

// Review round 3 F1 (AC-SEC-4): the agreed step texts, pinned VERBATIM. Round 2 read step 5 through a denylist of
// carve-out phrasings and round 3 showed a rephrased carve-out ("skip this delete and keep the payload") sailing past
// it. Enumerating wordings never closes; an exact pin does, and the L5 block is byte-identical across the three
// workflows so one string covers all of them. Any change to a step must change the pin here on purpose.
const EXPECTED_STEP_2 = "2. Create the payload file by exclusive create, with exactly this command and nothing else: `mktemp \"${TMPDIR:-/tmp}/harn-ledger-XXXXXX\"`. It prints the path of a new, empty file in a directory outside every git working tree; call that path \"the file\". Never put the file inside the checkout (never under `git rev-parse --show-toplevel`, never in a worktree), never use a fixed name or path, and never derive a name from the run_id. If mktemp fails or prints nothing, or the path somehow already holds content (a collision: read it and check it is empty), report write_ok false with write_error naming that, do not run the writer at all and do not pipe anything to it, and go straight to step 5."
const EXPECTED_STEP_3 = "3. The payload below is base64-encoded SPECIFICALLY so its raw text (which may contain quotes or other shell metacharacters authored by a reviewed diff, a lens finding, or task text) never reaches a shell command. Do not decode it, inspect it, or reconstruct the JSON by hand. Put exactly the text between the two delimiter lines (the delimiter lines themselves excluded, nothing added) into the file with your file-writing tool (the Write tool), reading the empty file first if the tool requires that. Never write it via a shell command, and never put any of it in a Bash command."
const EXPECTED_STEP_5 = "5. Delete exactly that one file with `rm \"<the file>\"`, on every exit path: after a successful write, after write_ok false, when the writer was not found or could not be found, when node fails to start, and after a collision. Delete only that one file: no glob, no flags, no directory."

// Review round 4 F1 (AC-SEC-4, AC-SEC-1, AC-SEC-3): round 3 pinned three steps and left step 4 and the closing
// paragraph open, and a carve-out there passed every test. The WHOLE prompt is now pinned: everything before the
// payload's start delimiter (the intro and steps 1 to 3) and everything after its end delimiter (steps 4 and 5 and the
// closing paragraph). Only the base64 line between the delimiters varies per run.
const EXPECTED_HEAD = "Append one line to the harness run ledger. Never let this step fail the caller's run: catch every error yourself and report it in your structured output instead of throwing or retrying.\n\n1. Find this harness's ledger-append.mjs script, in this exact order, and use the FIRST one that exists: (a) ~/.claude/workflows/lib/ledger-append.mjs (the global mirror install); (b) any installed claude-ai-harness plugin directory's workflows/lib/ledger-append.mjs; (c) \"$(git rev-parse --show-toplevel)/workflows/lib/ledger-append.mjs\" in the current repo, but ONLY if the current repo is claude-ai-harness itself -- check the basename of `git rev-parse --show-toplevel` equals \"claude-ai-harness\", or (if that fails) `git remote get-url origin` names claude-ai-harness. NEVER use a repo-local copy in any OTHER repo, even if (a) and (b) are both absent: report write_ok false instead. A repo-local workflows/lib/ledger-append.mjs is exactly what a hostile diff under review could plant, and this step must never execute it as you.\n2. Create the payload file by exclusive create, with exactly this command and nothing else: `mktemp \"${TMPDIR:-/tmp}/harn-ledger-XXXXXX\"`. It prints the path of a new, empty file in a directory outside every git working tree; call that path \"the file\". Never put the file inside the checkout (never under `git rev-parse --show-toplevel`, never in a worktree), never use a fixed name or path, and never derive a name from the run_id. If mktemp fails or prints nothing, or the path somehow already holds content (a collision: read it and check it is empty), report write_ok false with write_error naming that, do not run the writer at all and do not pipe anything to it, and go straight to step 5.\n3. The payload below is base64-encoded SPECIFICALLY so its raw text (which may contain quotes or other shell metacharacters authored by a reviewed diff, a lens finding, or task text) never reaches a shell command. Do not decode it, inspect it, or reconstruct the JSON by hand. Put exactly the text between the two delimiter lines (the delimiter lines themselves excluded, nothing added) into the file with your file-writing tool (the Write tool), reading the empty file first if the tool requires that. Never write it via a shell command, and never put any of it in a Bash command.\n"
const EXPECTED_TAIL = "4. Run exactly one Bash command to run the writer, substituting only the real script path and the file path: `node <path-to-ledger-append.mjs> < \"<the file>\"`. The script decodes the payload itself, always exits 0 and prints one line of JSON: {run_id, ts, write_ok, write_error}. It already handles locating the main checkout, ensuring the ledger stays gitignored, sourcing the timestamp from the system clock, and the single atomic append -- do not attempt any of that yourself, and do not construct the ledger line by hand.\n5. Delete exactly that one file with `rm \"<the file>\"`, on every exit path: after a successful write, after write_ok false, when the writer was not found or could not be found, when node fails to start, and after a collision. Delete only that one file: no glob, no flags, no directory.\nIf the script could not be found or failed to run at all (rather than reporting write_ok:false itself), treat that the same way: write_ok false, write_error naming what happened.\n\nReturn only what the script printed: run_id, ts, write_ok, write_error (null when write_ok is true)."
const START_DELIMITER_LINE = '<<<HARNESS-LEDGER-PAYLOAD>>>\n'
const END_DELIMITER_LINE = '<<<END-HARNESS-LEDGER-PAYLOAD>>>\n'

// The prompt split into its fixed head, the encoded payload line and its fixed tail; null when the delimiters are not
// exactly where the contract puts them.
function splitPrompt(prompt) {
  const text = String(prompt)
  const a = text.indexOf(START_DELIMITER_LINE)
  const b = text.indexOf(END_DELIMITER_LINE)
  if (a < 0 || b < 0 || b < a) return null
  return { head: text.slice(0, a), encoded: text.slice(a + START_DELIMITER_LINE.length, b), tail: text.slice(b + END_DELIMITER_LINE.length) }
}

// One numbered step of the prompt: from "\nN. " to the next numbered step or the closing paragraph.
function stepOf(prompt, n) {
  const text = String(prompt)
  const start = text.indexOf(`\n${n}. `)
  if (start < 0) return null
  const rest = text.slice(start + 1)
  const next = rest.search(/\n(\d\. |If the script)/)
  return next >= 0 ? rest.slice(0, next) : rest
}

// The stand-in agent deletes on every outcome ONLY when the whole tail of the prompt (steps 4 and 5 and the closing
// paragraph) is exactly the agreed text; any other wording anywhere in the tail fails closed (the file is kept), so a
// weakened, rephrased or relocated carve-out leaves the file behind in the end-to-end test (round 4 F1: round 3 read
// step 5 alone and a carve-out in the closing paragraph passed).
function deletesOnOutcome(prompt) {
  const parts = splitPrompt(prompt)
  return parts !== null && parts.tail === EXPECTED_TAIL
}

module.exports = { backtickSpans, instructedCommands, runSh, actAsCompliantAgent, deletesOnOutcome, stepOf, splitPrompt, EXPECTED_STEP_2, EXPECTED_STEP_3, EXPECTED_STEP_5, EXPECTED_HEAD, EXPECTED_TAIL }
