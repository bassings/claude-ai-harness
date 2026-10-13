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
  if (deletesOnOutcome(prompt, result)) runSh(rmCommand, { cwd, env })
  return { file, writerCommand: writerEnvPrefix + writerCommand, result, commands: cmds }
}

// Reads step 5 of the prompt the way a compliant agent would: delete on this outcome only if the step says the delete
// applies on every exit path, or names this outcome without carving it out.
function deletesOnOutcome(prompt, result) {
  const text = String(prompt)
  const start = text.indexOf('\n5. ')
  if (start < 0) return false
  const rest = text.slice(start + 1)
  const next = rest.search(/\n(\d\. |If the script)/)
  const step5 = next >= 0 ? rest.slice(0, next) : rest
  if (/on every exit path/i.test(step5) && !/only after|keep (it|the file)|do not delete|leave (it|the file)|except/i.test(step5)) return true
  const ok = result && result.write_ok === true
  if (ok) return /successful write|write_ok:?\s*true|success/i.test(step5)
  return /write_ok:?\s*false/i.test(step5) && !/keep (it|the file)[^.]*write_ok:?\s*false|only after a successful/i.test(step5)
}

module.exports = { backtickSpans, instructedCommands, runSh, actAsCompliantAgent, deletesOnOutcome }
