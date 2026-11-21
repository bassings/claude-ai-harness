// A static check that every read of the filesystem in a source file happens inside
// a named set of functions (the guarded helpers). It works on the code with
// comments and the contents of string, template-text and regular-expression
// literals blanked (same length, same lines), so a method name in a comment or a
// string is not a read, while an expression inside a template literal's ${} is
// still code. Function bodies are found by matching braces, so a function placed
// anywhere (a top-level arrow function after a helper included) is outside them.
//
// It fails closed on the shapes that hide a read from a method-name search:
// bracket access to fs, any use of `promises`, destructuring from fs or require,
// a named import from fs, an import of fs/promises, and fs used as a value
// (aliased or passed on). The methods it treats as reads are listed in READ_METHODS.

const READ_METHODS = [
  'readFileSync', 'readFile', 'readSync', 'read', 'openSync', 'open', 'existsSync', 'exists',
  'statSync', 'stat', 'lstatSync', 'lstat', 'fstatSync', 'fstat', 'readdirSync', 'readdir',
  'opendirSync', 'opendir', 'createReadStream', 'copyFileSync', 'copyFile', 'readlinkSync', 'readlink',
  'cpSync', 'cp',
]

const blank = (c) => (c === '\n' ? '\n' : ' ')
const REGEX_PRECEDERS = '(,=:[!&|?{};+-*%<>~^'

// Whether a `/` after this code starts a regular expression rather than dividing.
function startsRegex(previous, tail) {
  if (previous === '') return true
  if (REGEX_PRECEDERS.includes(previous)) return true
  return /\b(?:return|typeof|case|in|of)\s*$/.test(tail)
}

function skipBlockComment(src, i, out) {
  let j = i
  while (j < src.length && !(src[j] === '*' && src[j + 1] === '/')) out.push(blank(src[j++]))
  out.push('  ')
  return j + 2
}

function skipQuoted(src, i, out) {
  const quote = src[i]
  out.push(quote)
  let j = i + 1
  while (j < src.length && src[j] !== quote) {
    if (src[j] === '\\') {
      out.push(' ', blank(src[j + 1] ?? ' '))
      j += 2
    } else out.push(blank(src[j++]))
  }
  out.push(quote)
  return j + 1
}

function skipRegex(src, i, out) {
  out.push('/')
  let j = i + 1
  let inClass = false
  while (j < src.length) {
    const c = src[j]
    if (c === '\\') {
      out.push(' ', blank(src[j + 1] ?? ' '))
      j += 2
      continue
    }
    if (c === '/' && !inClass) break
    if (c === '[') inClass = true
    else if (c === ']') inClass = false
    out.push(blank(c))
    j++
  }
  out.push('/')
  return j + 1
}

// Template text: blank it, keep `${ ... }` as code (tracked by brace depth).
function templateStep(src, i, out, modes) {
  const c = src[i]
  if (c === '\\') {
    out.push(' ', blank(src[i + 1] ?? ' '))
    return i + 2
  }
  if (c === '`') {
    modes.pop()
    out.push('`')
    return i + 1
  }
  if (c === '$' && src[i + 1] === '{') {
    modes.push({ kind: 'code', depth: 1 })
    out.push('  ')
    return i + 2
  }
  out.push(blank(c))
  return i + 1
}

function codeOnly(src) {
  const out = []
  const modes = [{ kind: 'code', depth: 0 }]
  let previous = ''
  let i = 0
  while (i < src.length) {
    const mode = modes[modes.length - 1]
    const c = src[i]
    if (mode.kind === 'template') {
      i = templateStep(src, i, out, modes)
      continue
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') {
        out.push(' ')
        i++
      }
      continue
    }
    if (c === '/' && src[i + 1] === '*') {
      i = skipBlockComment(src, i, out)
      continue
    }
    if (c === '"' || c === "'") {
      i = skipQuoted(src, i, out)
      previous = c
      continue
    }
    if (c === '`') {
      modes.push({ kind: 'template' })
      out.push('`')
      i++
      continue
    }
    if (c === '/' && startsRegex(previous, out.slice(-12).join(''))) {
      i = skipRegex(src, i, out)
      previous = '/'
      continue
    }
    if (modes.length > 1 && c === '{') mode.depth++
    if (modes.length > 1 && c === '}' && --mode.depth === 0) {
      modes.pop()
      out.push(' ')
      i++
      continue
    }
    out.push(c)
    if (!/\s/.test(c)) previous = c
    i++
  }
  return out.join('')
}

// The index just past the bracket that closes the one at `open`.
function matchClose(code, open) {
  const pair = { '(': ')', '{': '}' }[code[open]]
  let depth = 0
  for (let i = open; i < code.length; i++) {
    if (code[i] === code[open]) depth++
    else if (code[i] === pair && --depth === 0) return i + 1
  }
  return code.length
}

// [start, end) of each named function declaration's whole text (parameters and body).
function functionRanges(code, names) {
  const ranges = []
  for (const name of names) {
    const declaration = new RegExp(`\\bfunction\\s+${name}\\s*\\(`, 'g')
    for (const found of code.matchAll(declaration)) {
      const paramsOpen = found.index + found[0].length - 1
      const bodyOpen = code.indexOf('{', matchClose(code, paramsOpen))
      ranges.push([found.index, matchClose(code, bodyOpen)])
    }
  }
  return ranges
}

const lineOf = (code, index) => code.slice(0, index).split('\n').length

// Shapes that are findings wherever they appear, helpers included.
const ALWAYS = [
  [/\bfs\s*\[/g, 'bracket access to fs'],
  [/\bpromises\b/g, 'use of promises'],
  [/\{[^}]*\}\s*=\s*(?:fs\b|require\s*\()/g, 'destructuring from fs or require'],
]

function aliasFindings(code, src) {
  const found = []
  for (const match of code.matchAll(/\bfs\b(?!\s*\.)/g)) {
    if (/\bimport\s+$/.test(code.slice(0, match.index))) continue
    found.push({ line: lineOf(code, match.index), why: 'fs used as a value' })
  }
  for (const match of src.matchAll(/^import\s*\{[^}]*\}\s*from\s*['"](?:node:)?fs(?:\/promises)?['"]/gm)) found.push({ line: lineOf(src, match.index), why: 'named import from fs' })
  for (const match of src.matchAll(/^import\s[^;\n]*from\s*['"](?:node:)?fs\/promises['"]/gm)) found.push({ line: lineOf(src, match.index), why: 'import of fs/promises' })
  return found
}

// Findings for every read of the filesystem outside the functions named in `allowed`.
function unguardedReads(src, allowed) {
  const code = codeOnly(src)
  const ranges = functionRanges(code, allowed)
  const inside = (index) => ranges.some(([start, end]) => index >= start && index < end)
  const findings = aliasFindings(code, src)
  for (const [pattern, why] of ALWAYS) for (const match of code.matchAll(pattern)) findings.push({ line: lineOf(code, match.index), why })
  const method = new RegExp(`\\bfs\\s*\\.\\s*(?:${READ_METHODS.join('|')})\\b`, 'g')
  for (const match of code.matchAll(method)) if (!inside(match.index)) findings.push({ line: lineOf(code, match.index), why: `fs read outside the guarded functions: ${match[0].replace(/\s+/g, '')}` })
  return findings
}

module.exports = { codeOnly, functionRanges, unguardedReads }
