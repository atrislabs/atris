'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { playbookCommand, readPlaybook } = require('../commands/playbook');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-playbook-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const lines = [];
  let nextId = 1;
  const run = (args) => playbookCommand(args, {
    root,
    output: (line) => lines.push(line),
    makeId: () => `rule-${nextId++}`,
    now: () => '2026-08-25T00:00:00.000Z',
  });
  return { root, lines, run };
}

test('add stores a rule and show groups it by family', (t) => {
  const item = fixture(t);
  assert.equal(item.run(['add', 'voice', 'use plain words', '--source', 'gate']), 0);
  item.lines.length = 0;
  assert.equal(item.run(['show']), 0);
  assert.deepEqual(item.lines, ['voice:', '- rule-1: use plain words']);
  assert.deepEqual(readPlaybook(item.root).rules[0], {
    id: 'rule-1', family: 'voice', rule: 'use plain words', source: 'gate', verified: null,
    created_at: '2026-08-25T00:00:00.000Z',
  });
});

test('add deduplicates exact family and rule matches', (t) => {
  const item = fixture(t);
  item.run(['add', 'voice', 'use plain words']);
  item.lines.length = 0;
  item.run(['add', 'voice', 'use plain words']);
  assert.deepEqual(item.lines, ['rule already exists: rule-1']);
  assert.equal(readPlaybook(item.root).rules.length, 1);
});

test('inject filters by family', (t) => {
  const item = fixture(t);
  item.run(['add', 'voice', 'use plain words']);
  item.run(['add', 'code', 'keep functions small']);
  item.lines.length = 0;
  item.run(['inject', '--family', 'code']);
  assert.deepEqual(item.lines, [
    'Workspace style rules (follow every rule that applies):',
    '- keep functions small',
  ]);
});

test('verify quarantines a regressing rule and inject skips it', (t) => {
  const item = fixture(t);
  item.run(['add', 'voice', 'use plain words']);
  item.run(['add', 'voice', 'keep sentences short']);
  item.lines.length = 0;
  item.run(['verify', 'rule-1', '--with', '71', '--without', '88', '--method', 'replay']);
  assert.deepEqual(item.lines, ['rule quarantined: rule-1']);
  item.lines.length = 0;
  item.run(['inject']);
  assert.deepEqual(item.lines, [
    'Workspace style rules (follow every rule that applies):',
    '- keep sentences short',
  ]);
});

test('remove deletes a rule by id', (t) => {
  const item = fixture(t);
  item.run(['add', 'voice', 'use plain words']);
  item.lines.length = 0;
  item.run(['remove', 'rule-1']);
  assert.deepEqual(item.lines, ['rule removed: rule-1']);
  assert.deepEqual(readPlaybook(item.root).rules, []);
});
