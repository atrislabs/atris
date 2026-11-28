'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { compileSpecPacket, parseSpecPacketPrompt, checkScopeDrift, hasPipedVerify, normalizeRepoPath } = require('../lib/spec-packet');

const base = { goal: 'Build a bounded feature', files: ['./lib/a.js', 'lib\\a.js', 'test/a.js'], contract: ['Keep it small'], verify: 'node --test test/a.js', antiGoals: ['other.js'] };

test('compiles and round trips a bounded packet', () => {
  const result = compileSpecPacket(base);
  assert.equal(result.ok, true);
  assert.equal(result.packet.effort, 'low');
  assert.equal(result.packet.weightClass, 'worker');
  assert.deepEqual(result.packet.files, ['lib/a.js', 'test/a.js']);
  for (const section of ['Goal', 'Files in scope', 'Exact contract', 'Do not touch', 'Verify (run bare, never piped)', 'Routing']) assert.ok(result.prompt.includes(`## ${section}`));
  assert.deepEqual(parseSpecPacketPrompt(result.prompt), { goal: base.goal, files: result.packet.files, verify: base.verify });
  assert.equal(compileSpecPacket({ ...base, job: 'search' }).packet.weightClass, 'sprinter');
  assert.equal(normalizeRepoPath('  ./lib//a.js  '), 'lib/a.js');
});

test('routes explicit effort and rejects invalid values', () => {
  assert.equal(compileSpecPacket({ ...base, effort: ' HIGH ' }).packet.effort, 'high');
  assert.equal(compileSpecPacket({ ...base, effort: 'high', engine: 'devin' }).packet.effort, null);
  assert.deepEqual(compileSpecPacket({ ...base, effort: 'huge' }).errors, ['invalid effort: huge']);
});

test('rejects pipes but accepts shell chains', () => {
  assert.equal(compileSpecPacket({ ...base, verify: 'node --test a.js | tail -n 20' }).ok, false);
  for (const command of ['node --test a.js && node --test b.js', 'cmd1 || cmd2']) {
    assert.equal(hasPipedVerify(command), false);
    assert.equal(compileSpecPacket({ ...base, verify: command }).ok, true);
  }
});

test('rejects unsafe paths in packets and drift checks', () => {
  const unsafe = ['../secret.js', '/etc/passwd', '.atris/state/foo.json', 'atris/TODO.md', 'C:\\secret', 'x/../secret'];
  const result = compileSpecPacket({ ...base, files: unsafe });
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, unsafe.length);
  assert.deepEqual(checkScopeDrift(unsafe, unsafe).forbidden, unsafe.map(normalizeRepoPath));
});

test('checks unexpected and missing files', () => {
  assert.equal(checkScopeDrift(['./lib/a.js'], ['lib/a.js', 'test/a.js']).ok, true);
  assert.deepEqual(checkScopeDrift(['lib/a.js', 'other.js'], ['lib/a.js']).unexpected, ['other.js']);
  const missing = checkScopeDrift(['lib/a.js'], ['lib/a.js', 'test/a.js'], { requireAll: true });
  assert.equal(missing.ok, false);
  assert.deepEqual(missing.missing, ['test/a.js']);
});
