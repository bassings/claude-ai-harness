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

// The three shell commands the prompt instructs, by leading word.
function instructedCommands(prompt) {
  const spans = backtickSpans(prompt)
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
  const rmCommand = cmds.rm[0].replace('<the file>', file)
  runSh(rmCommand, { cwd, env })
  return { file, writerCommand: writerEnvPrefix + writerCommand, result, commands: cmds }
}

module.exports = { backtickSpans, instructedCommands, runSh, actAsCompliantAgent }
