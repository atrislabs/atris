'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { PII_RULES, scanLine, scanText } = require('../lib/security-scan');

// PII_RULES is plain data (four rule objects with a regex each), so these tests
// run the patterns directly. Nothing here touches the disk, env, or clock.

const byId = Object.fromEntries(PII_RULES.map((r) => [r.id, r]));

function hit(id, text) {
  const m = byId[id].re.exec(text);
  return m ? m[0] : null;
}

test('PII_RULES lists the four pii rules with usable shape', () => {
  assert.ok(Array.isArray(PII_RULES));
  assert.deepEqual(PII_RULES.map((r) => r.id), ['home-path', 'windows-home-path', 'email', 'phone']);
  for (const rule of PII_RULES) {
    assert.equal(rule.cat, 'pii');
    assert.ok(rule.re instanceof RegExp, `${rule.id} has a regex`);
    assert.equal(rule.re.global, false, `${rule.id} must not be global (exec would carry state)`);
    assert.ok(['low', 'medium'].includes(rule.sev), `${rule.id} severity`);
    assert.ok(rule.why && rule.why.length > 0, `${rule.id} explains itself`);
  }
  assert.equal(byId['home-path'].sev, 'medium');
  assert.equal(byId['windows-home-path'].sev, 'medium');
  assert.equal(byId.email.sev, 'low');
  assert.equal(byId.phone.sev, 'low');
});

test('home-path catches personal unix paths and skips CI and system users', () => {
  assert.equal(hit('home-path', 'cwd: /Users/someuser/arena/project'), '/Users/someuser');
  assert.equal(hit('home-path', 'path = /home/jdoe/secret/app'), '/home/jdoe');
  assert.equal(hit('home-path', 'at /HOME/Bob/x'), '/HOME/Bob', 'match is case-insensitive');

  for (const safe of [
    '/home/runner/work/repo',
    '/home/ubuntu/app',
    '/home/user/app',
    '/home/node/app',
    '/Users/root/x',
  ]) {
    assert.equal(hit('home-path', safe), null, `${safe} is a generic path`);
  }

  // edge: no username at all, or a username that does not start with a letter
  assert.equal(hit('home-path', '/Users/'), null);
  assert.equal(hit('home-path', '/Users/9abc/x'), null);
  assert.equal(hit('home-path', ''), null);
});

test('windows-home-path catches a user folder but not Public', () => {
  assert.equal(hit('windows-home-path', 'C:\\Users\\jdoe\\Desktop'), 'C:\\Users\\jdoe');
  assert.equal(hit('windows-home-path', 'D:\\Users\\jdoe'), 'D:\\Users\\jdoe');
  assert.equal(hit('windows-home-path', 'C:\\Users\\Public\\Documents'), null);
  assert.equal(hit('windows-home-path', 'C:/Users/jdoe'), null, 'forward slashes are the unix rule\'s job');
  assert.equal(hit('windows-home-path', 'no path here'), null);
});

test('email catches real addresses and skips example, test, and local domains', () => {
  assert.equal(hit('email', 'contact jane.doe@acme.com now'), 'jane.doe@acme.com');
  assert.equal(hit('email', 'bob+tag@mail.acme.io'), 'bob+tag@mail.acme.io');

  for (const safe of [
    'a@example.com',
    'a@example.org',
    'a@sentry.io',
    'a@test.com',
    'a@localhost.com',
    'a@foo.local.com',
    'a@sub.acme.com',
  ]) {
    assert.equal(hit('email', safe), null, `${safe} is placeholder noise`);
  }

  // edge: an unlisted top-level domain is not flagged, and bare text has no address
  assert.equal(hit('email', 'a@acme.xyz'), null);
  assert.equal(hit('email', 'just text, no at sign'), null);
});

test('phone catches common formats and ignores digit runs that are not phones', () => {
  assert.equal(hit('phone', 'call 415-555-0134 today'), '415-555-0134');
  assert.equal(hit('phone', 'call (415) 555-0134'), '(415) 555-0134');
  assert.equal(hit('phone', 'call +1 415 555 0134'), '+1 415 555 0134');
  assert.equal(hit('phone', 'call 1.415.555.0134'), '1.415.555.0134');

  assert.equal(hit('phone', 'call 4155550134'), null, 'unseparated digits are skipped');
  assert.equal(hit('phone', 'version 1.2.3.4567'), null);
  assert.equal(hit('phone', 'ip 192.168.100.1234'), null);
  assert.equal(hit('phone', 'id 4415-555-01345'), null, 'longer digit groups are not phones');
  assert.equal(hit('phone', ''), null);
});

test('scanLine with PII_RULES reports findings and honors the skip rules', () => {
  const found = scanLine('mail jane@acme.com', PII_RULES);
  assert.equal(found.length, 1);
  assert.equal(found[0].rule, 'email');
  assert.equal(found[0].sev, 'low');
  assert.equal(found[0].cat, 'pii');
  assert.equal(found[0].snippet, 'jane@acme.com');

  // role addresses are skipped by the line-level email filter
  assert.deepEqual(scanLine('mail support@acme.com', PII_RULES), []);
  // the opt-out marker silences the whole line
  assert.deepEqual(scanLine('mail jane@acme.com # atris-allow-secret', PII_RULES), []);
  // empty and non-matching lines give no findings
  assert.deepEqual(scanLine('', PII_RULES), []);
  assert.deepEqual(scanLine('const x = 1;', PII_RULES), []);

  // one line can trip several rules at once
  const both = scanLine('/Users/bob/notes.txt bob@acme.com', PII_RULES).map((f) => f.rule).sort();
  assert.deepEqual(both, ['email', 'home-path']);
});

test('scanText with PII_RULES numbers lines from one and handles empty input', () => {
  const text = 'clean\n/Users/bob/x\n\n(415) 555-0134';
  const found = scanText(text, PII_RULES);
  assert.deepEqual(found.map((f) => [f.rule, f.line]), [['home-path', 2], ['phone', 4]]);
  assert.equal(found[0].snippet, '/Users/bob');
  assert.equal(found[1].snippet, '(415) 555-0134');

  assert.deepEqual(scanText('', PII_RULES), []);
  assert.deepEqual(scanText(null, PII_RULES), []);
});
