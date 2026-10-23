'use strict';

// SECRET_RULES is the data table behind the secret detectors (an array of rule
// objects, not a callable). These tests pin its shape and run each rule's regex
// directly. Token fixtures are assembled at runtime so no literal secret-shaped
// string sits in this file.

const test = require('node:test');
const assert = require('node:assert');

const { SECRET_RULES, RULES, PII_RULES, CODE_RULES, scanLine } = require('../lib/security-scan');

const EXPECTED_IDS = [
  'private-key', 'aws-access-key-id', 'github-token', 'slack-token', 'slack-webhook',
  'openai-key', 'anthropic-key', 'google-api-key', 'stripe-key', 'npm-token',
  'sendgrid-key', 'jwt', 'bearer-token', 'assigned-secret',
];

const ALNUM = 'Y7qP2mN8vR4tL6zX9cB3sD5fH1jK0wE2aG9R6tV5mQ8nB4xC';
const body = (n) => ALNUM.slice(0, n);

function rule(id) {
  const found = SECRET_RULES.find((r) => r.id === id);
  assert.ok(found, `missing rule ${id}`);
  return found;
}

// The text the scanner would treat as the secret value for a match.
function captured(id, text) {
  const r = rule(id);
  const m = r.re.exec(text);
  if (!m) return null;
  return m[r.valueGroup != null ? r.valueGroup : 1];
}

test('SECRET_RULES has the expected rules, each well formed', () => {
  assert.ok(Array.isArray(SECRET_RULES));
  assert.deepStrictEqual(SECRET_RULES.map((r) => r.id), EXPECTED_IDS);
  assert.strictEqual(new Set(SECRET_RULES.map((r) => r.id)).size, SECRET_RULES.length);

  for (const r of SECRET_RULES) {
    assert.strictEqual(r.cat, 'secret', `${r.id} cat`);
    assert.ok(['critical', 'high', 'medium'].includes(r.sev), `${r.id} sev ${r.sev}`);
    assert.ok(r.re instanceof RegExp, `${r.id} re`);
    // a global or sticky regex would carry lastIndex state between scanned lines
    assert.strictEqual(r.re.global, false, `${r.id} global`);
    assert.strictEqual(r.re.sticky, false, `${r.id} sticky`);
    assert.strictEqual(typeof r.why, 'string');
    assert.ok(r.why.length > 0, `${r.id} why`);
  }
});

test('SECRET_RULES leads the combined RULES list, ahead of PII and code rules', () => {
  assert.strictEqual(RULES.length, SECRET_RULES.length + PII_RULES.length + CODE_RULES.length);
  assert.deepStrictEqual(RULES.slice(0, SECRET_RULES.length), SECRET_RULES);
  for (const r of [...PII_RULES, ...CODE_RULES]) {
    assert.notStrictEqual(r.cat, 'secret', `${r.id} should not be a secret rule`);
  }
});

test('known-provider rules are marked known and are critical; generic ones are not', () => {
  const knownIds = SECRET_RULES.filter((r) => r.known).map((r) => r.id);
  assert.deepStrictEqual(knownIds, EXPECTED_IDS.slice(0, 11));
  for (const r of SECRET_RULES.filter((x) => x.known)) assert.strictEqual(r.sev, 'critical', r.id);

  assert.strictEqual(rule('jwt').sev, 'medium');
  assert.strictEqual(rule('bearer-token').sev, 'medium');
  assert.strictEqual(rule('assigned-secret').sev, 'high');
  assert.strictEqual(rule('assigned-secret').valueGroup, 2);
  assert.strictEqual(rule('jwt').known, undefined);

  // only the private key marker skips the entropy check
  assert.deepStrictEqual(SECRET_RULES.filter((r) => r.noEntropy).map((r) => r.id), ['private-key']);
});

test('provider regexes capture the token from a realistic line', () => {
  const cases = [
    ['private-key', `-----BEGIN ${'RSA '}PRIVATE KEY-----`, `-----BEGIN ${'RSA '}PRIVATE KEY-----`],
    ['private-key', '-----BEGIN PRIVATE KEY-----', '-----BEGIN PRIVATE KEY-----'],
    ['private-key', '-----BEGIN OPENSSH PRIVATE KEY-----', '-----BEGIN OPENSSH PRIVATE KEY-----'],
    ['aws-access-key-id', `id = "${'AKI' + 'A'}${'4F7D9Q2L8W6R3P5S'}"`, 'AKIA4F7D9Q2L8W6R3P5S'],
    ['aws-access-key-id', `${'AS' + 'IA'}${'4F7D9Q2L8W6R3P5S'}`, 'ASIA4F7D9Q2L8W6R3P5S'],
    ['github-token', `token ${'gh' + 'p_'}${body(36)}`, `ghp_${body(36)}`],
    ['github-token', `${'gh' + 'o_'}${body(40)}`, `gho_${body(40)}`],
    ['github-token', `${'github' + '_pat_'}${body(44)}`, `github_pat_${body(44)}`],
    ['slack-token', `${'xo' + 'xb-'}1234567890-${body(12)}`, `xoxb-1234567890-${body(12)}`],
    ['slack-webhook', `${'https://hooks.slack' + '.com/services/'}T0A1B2C3D/B4E5F6G7H/${body(24)}`, `https://hooks.slack.com/services/T0A1B2C3D/B4E5F6G7H/${body(24)}`],
    ['openai-key', `${'s' + 'k-'}${body(40)}`, `sk-${body(40)}`],
    ['openai-key', `${'s' + 'k-proj-'}${body(20)}_${body(20)}`, `sk-proj-${body(20)}_${body(20)}`],
    ['anthropic-key', `${'s' + 'k-ant-'}api03-${body(30)}`, `sk-ant-api03-${body(30)}`],
    ['google-api-key', `${'AI' + 'za'}${body(35)}`, `AIza${body(35)}`],
    ['stripe-key', `${'s' + 'k_live_'}${body(24)}`, `sk_live_${body(24)}`],
    ['stripe-key', `${'r' + 'k_live_'}${body(24)}`, `rk_live_${body(24)}`],
    ['npm-token', `${'np' + 'm_'}${body(36)}`, `npm_${body(36)}`],
    ['sendgrid-key', `${'S' + 'G.'}${body(22)}.${body(43)}`, `SG.${body(22)}.${body(43)}`],
    ['jwt', `${'ey' + 'J'}hbGciOiJIUzI1NiJ9.${body(20)}.${body(10)}`, `eyJhbGciOiJIUzI1NiJ9.${body(20)}.${body(10)}`],
    ['bearer-token', `Authorization: Bearer ${body(30)}`, body(30)],
  ];
  for (const [id, text, expected] of cases) {
    assert.strictEqual(captured(id, text), expected, `${id} on ${text.slice(0, 24)}...`);
  }
});

test('assigned-secret captures the quoted value (group 2) for several key names and quotes', () => {
  assert.strictEqual(captured('assigned-secret', 'const clientSecret = "9qR4xZ7nP2mV8sT5kL0bC3dF6hJ1wE";'), '9qR4xZ7nP2mV8sT5kL0bC3dF6hJ1wE');
  assert.strictEqual(captured('assigned-secret', "password: 'k9Xv2Lq7Rm'"), 'k9Xv2Lq7Rm');
  assert.strictEqual(captured('assigned-secret', 'API_KEY = `k9Xv2Lq7Rm4T`'), 'k9Xv2Lq7Rm4T');
  assert.strictEqual(captured('assigned-secret', 'auth-token: "k9Xv2Lq7"'), 'k9Xv2Lq7');
  assert.strictEqual(captured('assigned-secret', 'authToken: "k9Xv2Lq7"'), 'k9Xv2Lq7');
  assert.strictEqual(captured('assigned-secret', 'username: "k9Xv2Lq7Rm4T"'), null, 'name is not in the keyword list');
});

test('regexes reject near-misses: wrong prefix, too short, wrong shape', () => {
  const misses = [
    ['private-key', '-----BEGIN PUBLIC KEY-----'],
    ['private-key', '-----BEGIN CERTIFICATE-----'],
    ['aws-access-key-id', `${'AKI' + 'A'}${'4F7D9Q2L8W6R3P5'}`],
    ['aws-access-key-id', `${'AKI' + 'A'}${'4F7D9Q2L8W6R3P5S9'}`],
    ['aws-access-key-id', `${'aki' + 'a'}${'4f7d9q2l8w6r3p5s'}`],
    ['github-token', `${'gh' + 'p_'}${body(35)}`],
    ['github-token', `${'gh' + 'x_'}${body(36)}`],
    ['slack-token', `${'xo' + 'xb-'}short`],
    ['slack-token', `${'xo' + 'xz-'}1234567890-abcdef`],
    ['slack-webhook', `${'https://hooks.slack' + '.com/services/'}T0A1B2C3D`],
    ['openai-key', `${'s' + 'k-'}${body(31)}`],
    ['anthropic-key', `${'s' + 'k-ant-'}${body(19)}`],
    ['google-api-key', `${'AI' + 'za'}${body(34)}`],
    ['stripe-key', `${'p' + 'k_live_'}${body(24)}`],
    ['stripe-key', `${'s' + 'k_test_'}${body(24)}`],
    ['npm-token', `${'np' + 'm_'}${body(35)}`],
    ['sendgrid-key', `${'S' + 'G.'}${body(22)}.${body(42)}`],
    ['jwt', 'eyJabc.def.ghi'],
    ['bearer-token', `Bearer ${body(23)}`],
    ['assigned-secret', 'password = "short"'],
    ['assigned-secret', 'password = hunter2hunter2'],
    ['assigned-secret', `password = "k9Xv2Lq7Rm'`],
    ['assigned-secret', 'password = "has space inside"'],
  ];
  for (const [id, text] of misses) {
    assert.strictEqual(rule(id).re.exec(text), null, `${id} should not match ${text.slice(0, 30)}`);
  }
});

test('OpenAI and Anthropic key shapes do not overlap', () => {
  const anthropic = `${'s' + 'k-ant-'}api03-${body(30)}`;
  const openai = `${'s' + 'k-'}${body(40)}`;
  assert.strictEqual(rule('openai-key').re.exec(anthropic), null);
  assert.strictEqual(rule('anthropic-key').re.exec(openai), null);
  assert.ok(rule('anthropic-key').re.exec(anthropic));
  assert.ok(rule('openai-key').re.exec(openai));
});

test('empty, blank and non-secret input matches no rule', () => {
  for (const text of ['', ' ', '\n', 'const x = 1;', 'plain prose about passwords and tokens', 'user@example.org']) {
    for (const r of SECRET_RULES) {
      assert.strictEqual(r.re.exec(text), null, `${r.id} on ${JSON.stringify(text)}`);
    }
  }
});

test('rule regexes keep no state between calls', () => {
  const text = `token ${'gh' + 'p_'}${body(36)}`;
  const r = rule('github-token');
  const first = r.re.exec(text);
  const second = r.re.exec(text);
  assert.ok(first);
  assert.strictEqual(second.index, first.index);
  assert.strictEqual(second[1], first[1]);
  assert.strictEqual(r.re.lastIndex, 0);
});

test('scanLine with SECRET_RULES reports a masked finding for a real-shaped key', () => {
  const key = `${'AKI' + 'A'}4F7D9Q2L8W6R3P5S`;
  const findings = scanLine(`const k = "${key}";`, SECRET_RULES);
  assert.strictEqual(findings.length, 1);
  const [f] = findings;
  assert.strictEqual(f.rule, 'aws-access-key-id');
  assert.strictEqual(f.sev, 'critical');
  assert.strictEqual(f.cat, 'secret');
  assert.strictEqual(f.why, rule('aws-access-key-id').why);
  assert.ok(f.snippet.startsWith('AKIA4F7D9Q2L'));
  assert.ok(/ sha256:[0-9a-f]{12}$/.test(f.snippet), f.snippet);
  assert.ok(!f.snippet.includes(key), 'the full key must not appear in the snippet');
});

test('a rule match is not enough: scanLine drops repeating values and honors the allow marker', () => {
  const dull = `${'AKI' + 'A'}ABCDEFGHABCDEFGH`;
  assert.ok(rule('aws-access-key-id').re.exec(dull), 'regex alone matches the shape');
  assert.deepStrictEqual(scanLine(`id = "${dull}"`, SECRET_RULES), []);

  const real = `${'AKI' + 'A'}4F7D9Q2L8W6R3P5S`;
  assert.deepStrictEqual(scanLine(`id = "${real}" // atris-allow-secret`, SECRET_RULES), []);
  assert.deepStrictEqual(scanLine('const apiKey = process.env.API_KEY;', SECRET_RULES), []);
});

test('scanLine with SECRET_RULES ignores personal data and code-risk lines', () => {
  assert.deepStrictEqual(scanLine('home is /Users/someone/project', SECRET_RULES), []);
  assert.deepStrictEqual(scanLine('mail jane.doe@acme.com or call 415-555-0134', SECRET_RULES), []);
  assert.deepStrictEqual(scanLine('eval(userInput)', SECRET_RULES), []);
});
