const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const CONFIG = path.join(ROOT, '.gitleaks.toml')

function config() {
  return fs.readFileSync(CONFIG, 'utf8')
}

// The allowlist regexes, as written, in source order. Parsed rather than
// TOML-loaded because the repo carries no dependencies and a triple-quoted
// string list is the only shape this file uses.
function allowlistRegexes(text) {
  const block = text.slice(text.indexOf('regexes = ['), text.indexOf(']', text.indexOf('regexes = [')))
  return [...block.matchAll(/'''(.*?)'''/gs)].map((m) => m[1])
}

test("gitleaks config: the default ruleset stays on -- an allowlist that silences findings is one thing, disabling every rule is another", () => {
  assert.match(config(), /useDefault\s*=\s*true/,
    'extend.useDefault must stay true; without it gitleaks runs only the rules defined in this file, which is none, and the scan passes by scanning for nothing')
})

test("gitleaks config: every allowlisted value is ANCHORED, so it silences that exact string and never a secret that merely contains it", () => {
  // The risk this pins is concrete. One allowlisted value is the English
  // phrase "dependency/vulnerability" from a prompt sentence. Unanchored, it
  // would silence any secret containing those words anywhere -- proven by
  // execution: `const api_key = 'dependency/vulnerability8Kd92...'` IS caught
  // with the anchors and would not be without them.
  const regexes = allowlistRegexes(config())
  assert.ok(regexes.length > 0, 'expected at least one allowlist regex to check')
  for (const r of regexes) {
    assert.ok(r.startsWith('^') && r.endsWith('$'),
      `allowlist regex ${JSON.stringify(r)} is not anchored at both ends; it would silence any secret containing this substring, not just this exact value`)
  }
})

test("gitleaks config: nothing is allowlisted by PATH or by COMMIT -- a file-wide exemption would hide a real secret in a fixture, which is the one genuine leak this repo has ever had", () => {
  // 2026-09-04: the only real leak found in this repo was a test fixture
  // carrying the operator's actual username. A `paths` entry for test/** would
  // have made that unfindable. Same for `commits`, which exempts whole commits.
  const text = config()
  for (const key of ['paths', 'commits', 'stopwords']) {
    assert.doesNotMatch(text, new RegExp(`^\\s*${key}\\s*=`, 'm'),
      `.gitleaks.toml must not use an allowlist "${key}" entry: it exempts by location rather than by value, so it hides whatever lands there later`)
  }
})

test("gitleaks config: the allowlist targets the matched SECRET, not the surrounding line", () => {
  // regexTarget defaults to "match" (the whole matched region). Anchoring a
  // value against the line would either never fire or silence the entire line.
  assert.match(config(), /regexTarget\s*=\s*"secret"/,
    'regexTarget must be "secret" so each anchored value is compared against the matched secret itself')
})

test("gitleaks config: every allowlisted value carries a reason and an expiry condition, so no dismissal is silent", () => {
  // The standards are explicit that dismissing a finding to move a number is
  // the one action that silently destroys a scanner's value, and that a
  // dismissal must say why and what would make it expire. This makes that
  // mechanical rather than remembered.
  const text = config()
  const regexes = allowlistRegexes(text)
  const expiries = (text.match(/EXPIRES IF:/g) || []).length
  assert.ok(expiries >= regexes.length,
    `${regexes.length} allowlisted value(s) but only ${expiries} "EXPIRES IF:" note(s); every dismissal must record what would make it no longer true`)
})
