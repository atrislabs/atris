'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { scrubAgentEnv } = require('./helpers/agent-env');
const { runRecallExam } = require('../lib/recall-exam');

const cli = path.resolve(__dirname, '../bin/atris.js');

function workspace(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-recall-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), content);
  }
  return root;
}

const layout = {
  'atris/atris.md': '# boot\n\n- When you ship a release, read [release steps](notes/release.md).\n- [misc](notes/misc.md)\n',
  'atris/notes/release.md': '# release\n\nPush a version tag from master and CI publishes.\n',
  'atris/notes/misc.md': '# misc\n\nNothing here. See [deep](deep.md).\n',
  'atris/notes/deep.md': '# deep\n\nThe cache lives in the state folder.\n',
};

test('follows the link whose words match the question and counts what it read', (t) => {
  const root = workspace(t, layout);
  fs.writeFileSync(path.join(root, 'q.jsonl'), [
    JSON.stringify({ id: 'a', q: 'how do I ship a release', needle: 'push a version tag' }),
    JSON.stringify({ id: 'b', q: 'what is in the boot file', needle: 'read [release steps]' }),
    JSON.stringify({ id: 'c', q: 'where does the cache live', needle: 'the cache lives' }),
  ].join('\n'));
  const report = runRecallExam(root, path.join(root, 'q.jsonl'), { bootFiles: ['atris/atris.md'] });
  const byId = Object.fromEntries(report.results.map(row => [row.id, row]));
  assert.equal(byId.a.found, true);
  assert.deepEqual(byId.a.opened, ['atris/notes/release.md']);
  assert.ok(byId.a.tokens_opened > 0);
  assert.equal(byId.b.found, true);
  assert.equal(byId.b.files_opened, 0, 'an answer already in boot costs no extra file');
  // No link on the path mentions the cache, so a reader that only follows matching links never gets there.
  assert.equal(byId.c.found, false);
  assert.equal(report.found, 2);
  assert.ok(report.boot_tokens > 0);
});

test('the summary flag hides held-out questions from the output', (t) => {
  const root = workspace(t, layout);
  const secret = 'how do I ship a release secretword';
  fs.writeFileSync(path.join(root, 'q.jsonl'), JSON.stringify({ id: 'hidden1', q: secret, needle: 'push a version tag' }) + '\nnot json\n');
  const run = args => spawnSync(process.execPath, [cli, 'doc-health', '--recall', 'q.jsonl', ...args], {
    cwd: root, encoding: 'utf8', timeout: 15000, env: { ...scrubAgentEnv(), ATRIS_SKIP_UPDATE_CHECK: '1' },
  });
  const summary = run(['--summary']);
  assert.equal(summary.status, 0, summary.stderr);
  assert.match(summary.stdout, /recall exam: 1\/1 found/);
  assert.match(summary.stdout, /invalid question lines skipped: 2/);
  assert.doesNotMatch(summary.stdout, /hidden1|secretword/);
  const json = JSON.parse(run(['--summary', '--json']).stdout);
  assert.equal(json.found, 1);
  assert.equal(json.results, undefined);
  const full = run([]);
  assert.match(full.stdout, /hidden1/);
});
