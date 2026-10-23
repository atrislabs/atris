'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ideaAtris } = require('../commands/idea');

test('JSON idea listing preserves a loop tag and emits null for an absent tag', (t) => {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'idea-json-tag-')));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const state = path.join(repo, '.atris', 'state');
  fs.mkdirSync(state, { recursive: true });
  const at = '2020-01-02T03:04:05.000Z';
  const events = [
    { kind: 'idea', id: 'tagged', text: 'handle slow builds', at, tag: 'loop' },
    { kind: 'idea', id: 'untagged', text: 'tidy the help text', at },
  ];
  fs.writeFileSync(path.join(state, 'ideas.jsonl'), events.map(JSON.stringify).join('\n') + '\n');

  const output = [];
  assert.equal(ideaAtris(['--json', '--repo', repo], {
    cwd: repo,
    log: (line) => output.push(line),
  }), 0);
  assert.equal(output.length, 1);
  assert.deepEqual(JSON.parse(output[0]).ideas, [
    { n: 1, id: 'tagged', text: 'handle slow builds', status: 'waiting',
      reason: null, task_id: null, link: null, at, tag: 'loop' },
    { n: 2, id: 'untagged', text: 'tidy the help text', status: 'waiting',
      reason: null, task_id: null, link: null, at, tag: null },
  ]);
});
