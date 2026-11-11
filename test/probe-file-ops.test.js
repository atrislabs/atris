'use strict';

// `atris probe` relays the file ops the server offers. It used to know only
// bash, list, search and read, so a turn that used write or glob ended in
// "unsupported relayed call(s): file_op:glob". These run every op for real in
// a scratch folder.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { fileOpCommand, runLocalTerminal, SERVER_FILE_OPS, buildProbeLine } = require('../commands/probe');

const LABEL = '/workspace/personal';

function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-probe-ops-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function relay(dir, args) {
  const command = fileOpCommand(args, LABEL);
  assert.ok(command, `no command for ${JSON.stringify(args)}`);
  return runLocalTerminal(command, dir);
}

test('the op list is the server list, and every op builds a command', () => {
  // Backend: LOCAL_FILE_TOOL's enum in rl/tool_policy_bench.py. The backend test
  // tests/test_local_file_op_probe_lockstep.py pins the same literal list, so a
  // server change fails there until this list, SERVER_FILE_OPS and fileOpCommand
  // are updated together.
  assert.deepEqual(SERVER_FILE_OPS, ['list', 'search', 'glob', 'inspect', 'read', 'write', 'append', 'edit', 'bash']);
  const sample = {
    list: { path: '.' },
    search: { path: '.', query: 'x' },
    glob: { pattern: '*.md' },
    inspect: { path: '.', paths: ['a.md'] },
    read: { path: 'a.md' },
    write: { path: 'a.md', content: 'x' },
    append: { path: 'a.md', content: 'x' },
    edit: { path: 'a.md', find: 'x', replace: 'y' },
    bash: { command: 'true' },
  };
  for (const op of SERVER_FILE_OPS) {
    assert.ok(fileOpCommand({ type: op, ...sample[op] }, LABEL), `${op} has no command`);
  }
});

test('write then read: the file really exists with the content', async (t) => {
  const dir = scratch(t);
  const wrote = await relay(dir, { type: 'write', path: `${LABEL}/notes/cli-check.txt`, content: 'hello' });
  assert.equal(wrote.exit_code, 0, wrote.stderr);
  assert.equal(fs.readFileSync(path.join(dir, 'notes', 'cli-check.txt'), 'utf8'), 'hello');
  const read = await relay(dir, { type: 'read', path: 'notes/cli-check.txt' });
  assert.equal(read.stdout, 'hello');
});

test('write handles quotes, newlines and unicode without a shell escape', async (t) => {
  const dir = scratch(t);
  const content = "it's \"quoted\"\n$(touch pwned) `touch pwned2` é中\n";
  const wrote = await relay(dir, { type: 'write', path: 'odd name.txt', content });
  assert.equal(wrote.exit_code, 0, wrote.stderr);
  assert.equal(fs.readFileSync(path.join(dir, 'odd name.txt'), 'utf8'), content);
  assert.equal(fs.existsSync(path.join(dir, 'pwned')), false);
  assert.equal(fs.existsSync(path.join(dir, 'pwned2')), false);
});

test('append adds to the end and write replaces', async (t) => {
  const dir = scratch(t);
  await relay(dir, { type: 'write', path: 'log.md', content: 'one\n' });
  await relay(dir, { type: 'append', path: 'log.md', content: 'two\n' });
  assert.equal(fs.readFileSync(path.join(dir, 'log.md'), 'utf8'), 'one\ntwo\n');
  await relay(dir, { type: 'write', path: 'log.md', content: 'fresh\n' });
  assert.equal(fs.readFileSync(path.join(dir, 'log.md'), 'utf8'), 'fresh\n');
});

test('edit replaces the first match and fails loudly when the text is not there', async (t) => {
  const dir = scratch(t);
  fs.writeFileSync(path.join(dir, 'a.md'), 'cat cat cat\n');
  const ok = await relay(dir, { type: 'edit', path: 'a.md', find: 'cat', replace: 'dog' });
  assert.equal(ok.exit_code, 0, ok.stderr);
  assert.equal(fs.readFileSync(path.join(dir, 'a.md'), 'utf8'), 'dog cat cat\n');
  const miss = await relay(dir, { type: 'edit', path: 'a.md', find: 'bird', replace: 'x' });
  assert.notEqual(miss.exit_code, 0);
  assert.match(miss.stderr, /find text not found/);
});

test('glob matches like the server: recursion, hidden files, directory slash, generated dirs hidden', async (t) => {
  const dir = scratch(t);
  for (const file of ['atris/team/maze/MEMBER.md', 'atris/team/kai/MEMBER.md', 'atris/notes/a.md', '.hidden/x.md', 'node_modules/p/MEMBER.md', 'top.md']) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), 'x');
  }
  const members = await relay(dir, { type: 'glob', pattern: 'atris/team/*/MEMBER.md' });
  assert.equal(members.exit_code, 0, members.stderr);
  assert.deepEqual(members.stdout.trim().split('\n'), ['atris/team/kai/MEMBER.md', 'atris/team/maze/MEMBER.md']);
  const deep = await relay(dir, { type: 'glob', pattern: '**/*.md' });
  assert.ok(deep.stdout.includes('atris/notes/a.md') && deep.stdout.includes('.hidden/x.md') && deep.stdout.includes('top.md'));
  assert.ok(!deep.stdout.includes('node_modules'), 'generated directories stay hidden');
  const withGenerated = await relay(dir, { type: 'glob', pattern: '**/MEMBER.md', include_generated: true });
  assert.ok(withGenerated.stdout.includes('node_modules/p/MEMBER.md'));
  const dirs = await relay(dir, { type: 'glob', pattern: 'atris/*' });
  assert.deepEqual(dirs.stdout.trim().split('\n'), ['atris/notes/', 'atris/team/']);
  const none = await relay(dir, { type: 'glob', pattern: 'nothing/*.md' });
  assert.equal(none.exit_code, 0);
  assert.equal(none.stdout.trim(), '');
  const viaPath = await relay(dir, { type: 'glob', path: `${LABEL}/atris/team/*` });
  assert.deepEqual(viaPath.stdout.trim().split('\n'), ['atris/team/kai/', 'atris/team/maze/']);
});

test('read with a wildcard is a glob, like the server', async (t) => {
  const dir = scratch(t);
  fs.mkdirSync(path.join(dir, 'atris', 'team', 'kai'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'atris', 'team', 'kai', 'MEMBER.md'), 'x');
  const r = await relay(dir, { type: 'read', path: `${LABEL}/atris/team/*/MEMBER.md` });
  assert.equal(r.stdout.trim(), 'atris/team/kai/MEMBER.md');
});

test('glob caps its output and says so', async (t) => {
  const dir = scratch(t);
  for (let i = 0; i < 5; i += 1) fs.writeFileSync(path.join(dir, `f${i}.md`), 'x');
  const r = await relay(dir, { type: 'glob', pattern: '*.md', max_results: 2 });
  assert.deepEqual(r.stdout.trim().split('\n'), ['f0.md', 'f1.md', '[3 more match(es) not shown]']);
});

test('inspect lists, reads the named files and runs the check command', async (t) => {
  const dir = scratch(t);
  fs.writeFileSync(path.join(dir, 'a.md'), 'alpha line\n');
  fs.writeFileSync(path.join(dir, 'b.md'), 'beta line\n');
  const r = await relay(dir, { type: 'inspect', path: '.', paths: ['a.md', 'b.md'], command: 'echo verified' });
  assert.equal(r.exit_code, 0, r.stderr);
  assert.match(r.stdout, /== a\.md ==\nalpha line/);
  assert.match(r.stdout, /== b\.md ==\nbeta line/);
  assert.match(r.stdout, /verified/);
  const csv = await relay(dir, { type: 'inspect', path: '.', paths: 'a.md,b.md' });
  assert.match(csv.stdout, /beta line/);
});

test('the .. guard covers every op and every path argument', () => {
  const bad = [
    { type: 'read', path: '../secrets' },
    { type: 'list', path: 'a/../../b' },
    { type: 'search', path: '..', query: 'x' },
    { type: 'write', path: '../x.md', content: 'x' },
    { type: 'append', path: 'a/../../x.md', content: 'x' },
    { type: 'edit', path: '../x.md', find: 'a', replace: 'b' },
    { type: 'glob', pattern: '../*' },
    { type: 'glob', pattern: 'a/../../*.md' },
    { type: 'glob', path: '../*' },
    { type: 'inspect', path: '.', paths: ['ok.md', '../secrets'] },
    { type: 'inspect', path: '.', paths: '../secrets' },
  ];
  for (const args of bad) assert.equal(fileOpCommand(args, LABEL), null, JSON.stringify(args));
});

test('a write or edit without what it needs is refused, not run as an empty write', () => {
  assert.equal(fileOpCommand({ type: 'write', path: 'a.md' }, LABEL), null);
  assert.equal(fileOpCommand({ type: 'write', content: 'x' }, LABEL), null);
  assert.equal(fileOpCommand({ type: 'write', path: '.', content: 'x' }, LABEL), null);
  assert.equal(fileOpCommand({ type: 'append', path: 'a.md' }, LABEL), null);
  assert.equal(fileOpCommand({ type: 'edit', path: 'a.md', replace: 'x' }, LABEL), null);
  assert.equal(fileOpCommand({ type: 'glob' }, LABEL), null);
  assert.ok(fileOpCommand({ type: 'write', path: 'a.md', content: '' }, LABEL), 'empty content is a real write');
});

test('a probe limit is labelled as the harness, not the product', () => {
  const line = buildProbeLine({
    stamp: '2026-11-11T00:00:00Z', where: 'personal', model: 'atris:fast', engine: null, ok: true, secs: 1,
    toolsRun: 2, calendar: false, cliCalendarOps: 0,
    detail: 'answer: fine · probe limit (this harness did not run it, not a product failure): tool:dispatch_scout',
  });
  assert.match(line, /pass/);
  assert.match(line, /not a product failure/);
});
