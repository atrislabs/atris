const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { sanitizePersonalizationName } = require('../commands/pack');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

// A share link is only useful if the page honours it, so the tests run against
// a known base url instead of whatever the environment happens to point at.
function share(args) {
  const result = spawnSync(process.execPath, [cliPath, 'pack', 'share', ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 20000,
    env: {
      ...process.env,
      ATRIS_SKIP_UPDATE_CHECK: '1',
      ATRIS_APP_URL: 'https://packs.example.com',
    },
  });
  if (result.error) throw result.error;
  return result;
}

test('pack share prints the plain pack url without --for', () => {
  const result = share(['design-brain']);
  assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  const lines = result.stdout.trim().split('\n');
  assert.equal(lines[0], 'https://packs.example.com/packs/design-brain');
  assert.equal(lines.length, 2, 'the url plus at most one line of context');
});

test('pack share personalizes and url-encodes the name', () => {
  const result = share(['design-brain', '--for', 'Ada Lovelace']);
  assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  const lines = result.stdout.trim().split('\n');
  assert.equal(lines[0], 'https://packs.example.com/packs/design-brain?for=Ada%20Lovelace');
  assert.equal(lines.length, 2);
});

test('pack share keeps the punctuation real names use', () => {
  const result = share(['design-brain', '--for', "Se'an O'Brien"]);
  assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.match(result.stdout, /\?for=Se'an%20O'Brien/);
});

test('pack share encodes non-ascii names instead of dropping them', () => {
  const result = share(['design-brain', '--for', 'Renée Curie']);
  assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.match(result.stdout, /\?for=Ren%C3%A9e%20Curie/);
});

// The page caps at 40 characters, so the link must carry the capped name; a
// longer one would print a link that does not match what the visitor sees.
test('pack share caps a long name the way the page does', () => {
  const long = `${'A'.repeat(30)} Bartholomew Fitzgerald`;
  const result = share(['design-brain', '--for', long]);
  assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  const url = new URL(result.stdout.trim().split('\n')[0]);
  const value = url.searchParams.get('for');
  assert.equal(value.length, 40);
  assert.equal(value, long.slice(0, 40));
  assert.match(result.stdout, /trimmed from/);
});

// Better a clear error than a link that renders as if `for` were never there.
for (const [label, name] of [
  ['markup', '<script>alert(1)</script>'],
  ['an ampersand', 'Bob & Alice'],
  ['a quote', 'Ada "The Countess"'],
  ['a slash', 'ops/team'],
  ['no letters', '12345'],
  ['only punctuation', '...'],
  ['whitespace', '   '],
]) {
  test(`pack share refuses a dead link for a name with ${label}`, () => {
    const result = share(['design-brain', '--for', name]);
    assert.equal(result.status, 1, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.match(result.stderr, /is not a name the share page will display/);
    assert.equal(result.stdout.trim(), '', 'no link may be printed');
  });
}

test('pack share rejects a slug the web viewer cannot render', () => {
  const result = share(['ab', '--for', 'Ada Lovelace']);
  assert.equal(result.status, 1, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.match(result.stderr, /is not viewable on the web/);
});

test('pack share needs a slug', () => {
  const result = share(['--for', 'Ada Lovelace']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /pack share needs a slug/);
});

// Mirrors atrisos-web app/lib/pack/personalize.ts. If that file changes, this
// is the test that should fail first.
test('sanitizePersonalizationName mirrors the web sanitizer', () => {
  assert.equal(sanitizePersonalizationName('Ada Lovelace'), 'Ada Lovelace');
  assert.equal(sanitizePersonalizationName('  Ada   Lovelace  '), 'Ada Lovelace');
  assert.equal(sanitizePersonalizationName("O'Brien-Smith Jr."), "O'Brien-Smith Jr.");
  assert.equal(sanitizePersonalizationName('Ada 3000'), 'Ada');
  assert.equal(sanitizePersonalizationName('A'.repeat(50)).length, 40);
  assert.equal(sanitizePersonalizationName('<b>Ada</b>'), null);
  assert.equal(sanitizePersonalizationName('Bob & Alice'), null);
  assert.equal(sanitizePersonalizationName('a\\b'), null);
  assert.equal(sanitizePersonalizationName('123'), null);
  assert.equal(sanitizePersonalizationName(''), null);
  assert.equal(sanitizePersonalizationName(undefined), null);
});
