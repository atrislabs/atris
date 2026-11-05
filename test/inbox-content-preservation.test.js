'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { addInboxIdea, addInboxItemToContent } = require('../lib/file-ops');
const cli = path.resolve(__dirname, '../bin/atris.js');

test('adding an idea preserves human text and unnumbered items in Inbox', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-preserve-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'log.md');
  const input = '# Journal\n\n## Inbox\n\nA note written by a person.\n- [ ] Keep this task\n  continuation line\n- **I4:** prior numbered idea\n\n---\n\n## Notes\nKeep this too.\n';
  fs.writeFileSync(file, input);
  assert.equal(addInboxIdea(file, 'fresh idea'), 5);
  const output = fs.readFileSync(file, 'utf8');
  for (const text of ['A note written by a person.', '- [ ] Keep this task', '  continuation line', '- **I4:** prior numbered idea', 'Keep this too.', '- **I5:** fresh idea']) assert.ok(output.includes(text), `missing ${text}`);
});

test('preserves CRLF text and rejects a duplicate requested id without modifying content', () => {
  const input = '# Log\r\n\r\n## Inbox\r\n\r\n- [ ] keep\r\n- **I3:** existing\r\n\r\n## Notes\r\n';
  const out = addInboxItemToContent(input, 4, 'new');
  assert.ok(out.includes('- [ ] keep\r\n- **I3:** existing\r\n'));
  assert.ok(out.includes('- **I4:** new\r\n'));
  assert.throws(() => addInboxItemToContent(input, 3, 'replacement'), /already exists/);
});

test('keeps a placeholder-like line when mixed with other Inbox content', () => {
  const input = '# Log\n\n## Inbox\n\n(Empty - inbox zero achieved)\n- [ ] actual task\n';
  const out = addInboxItemToContent(input, 1, 'new');
  assert.ok(out.includes('(Empty - inbox zero achieved)\n- [ ] actual task'));
});

test('actual log CLI preserves unnumbered Inbox content', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-cli-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const now = new Date();
  const day = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
  const logs = path.join(dir, 'atris', 'logs', String(now.getFullYear()));
  fs.mkdirSync(logs, { recursive: true });
  fs.writeFileSync(path.join(dir, 'atris', 'atris.md'), '# workspace\n');
  const file = path.join(logs, `${day}.md`);
  fs.writeFileSync(file, '# Log\n\n## Inbox\n\n- [ ] keep this important task\n\n## Notes\nend\n');
  const run = spawnSync(process.execPath, [cli, 'log', 'new note', '--json'], { cwd: dir, encoding: 'utf8', env: { ...process.env, ATRIS_TEST_STATE_DIR: path.join(dir,'state') } });
  assert.equal(run.status, 0, run.stderr);
  assert.match(fs.readFileSync(file, 'utf8'), /- \[ \] keep this important task/);
});

for (const [label, input, check] of [
  ['fenced sample', '# Daily\n\n```md\n## Inbox\nexample\n```\n\n## Inbox\n\n- [ ] Real item\n\n## Notes\nend\n', (after) => {
    assert.ok(after.indexOf('new capture') > after.indexOf('```\n\n## Inbox'));
    assert.ok(after.includes('```md\n## Inbox\nexample\n```'));
    assert.ok(after.includes('- [ ] Real item'));
  }],
  ['nested heading', '# Daily\n\n### Inbox\nNested example\n\n## Notes\nend\n', (after) => {
    assert.ok(after.includes('### Inbox\nNested example'));
    assert.equal((after.match(/^## Inbox$/gm) || []).length, 1);
  }],
  ['heading at EOF', '# Daily\n\n## Inbox', (after) => {
    assert.equal((after.match(/^## Inbox$/gm) || []).length, 1);
    assert.match(after, /## Inbox\n\n- \*\*I1:\*\* new capture/);
  }],
]) {
  test(`actual log capture finds ${label} safely`, (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-boundary-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const now = new Date();
    const day = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
    const logs = path.join(dir, 'atris', 'logs', String(now.getFullYear()));
    fs.mkdirSync(logs, { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'atris.md'), '# workspace\n');
    const file = path.join(logs, `${day}.md`);
    fs.writeFileSync(file, input);
    const run = spawnSync(process.execPath, [cli, 'log', 'new capture', '--json'], { cwd: dir, encoding: 'utf8', env: { ...process.env, ATRIS_TEST_STATE_DIR: path.join(dir,'state') } });
    assert.equal(run.status, 0, run.stderr);
    check(fs.readFileSync(file, 'utf8'));
  });
}

test('actual log refuses duplicate Inbox sections without changing bytes', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-duplicates-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const now = new Date();
  const day = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
  const logs = path.join(dir, 'atris', 'logs', String(now.getFullYear()));
  fs.mkdirSync(logs, { recursive: true });
  fs.writeFileSync(path.join(dir, 'atris', 'atris.md'), '# workspace\n');
  const file = path.join(logs, `${day}.md`);
  const input = '# Daily\n\n## Inbox\n\n- **I1:** first\n\n## Inbox\n\n- **I2:** second\n';
  fs.writeFileSync(file, input);
  const run = spawnSync(process.execPath, [cli, 'log', 'new capture', '--json'], { cwd: dir, encoding: 'utf8', env: { ...process.env, ATRIS_TEST_STATE_DIR: path.join(dir,'state') } });
  assert.notEqual(run.status, 0);
  assert.equal(fs.readFileSync(file, 'utf8'), input);
});

test('capture refuses an unclosed fence instead of guessing a section', () => {
  const input = '# Daily\n\n```markdown\n## Inbox\nexample\n';
  assert.throws(() => addInboxItemToContent(input, 1, 'new'), /Unclosed code fence/);
});
