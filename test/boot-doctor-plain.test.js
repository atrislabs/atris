'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { collectDoctor, renderDoctor } = require('../commands/doctor');
const cli = path.resolve(__dirname, '../bin/atris.js');

test('boot and doctor speak plainly in isolated folders', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-plain-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home'); fs.mkdirSync(home);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('ATRIS_')));
  Object.assign(env, { HOME: home, ATRIS_SKIP_UPDATE_CHECK: '1', NODE_NO_WARNINGS: '1', ATRIS_TASKS_DB: path.join(root, 'tasks.db') });
  const run = (cwd, ...args) => {
    const r = spawnSync(process.execPath, [cli, ...args], { cwd, env, encoding: 'utf8', timeout: 30000 });
    assert.equal(r.status, 0, r.stderr || r.stdout); return r.stdout;
  };
  const plain = (text) => {
    assert.doesNotMatch(text, /^\s*[A-Z][A-Z ]{2,}:/m);
    assert.doesNotMatch(text, /—|one hop|boot \d+(?:\.\d+)?k? tokens|Autoland:|agent translates|cli runnable|byte shim|task support|\d\/100 · add atris\/doc-health/i);
    for (const line of text.split('\n').filter((line) => /^\s*(?:next\s+|fix:)/.test(line))) assert.match(line, /\([^()]+\)\s*$/);
  };
  const empty = path.join(root, 'empty'); fs.mkdirSync(empty);
  const first = run(empty, 'atris.md'); plain(first); assert.match(first, /atris is not set up/);
  run(empty, 'init', '--yes');
  const fresh = run(empty, 'atris.md'); plain(fresh); assert.doesNotMatch(fresh, /^\s*docs\s/m);
  fs.writeFileSync(path.join(empty, 'atris', 'MAP.md'), '# map\n\n| topic | file |\n| --- | --- |\n| guide | `guide.md` |\n');
  fs.writeFileSync(path.join(empty, 'guide.md'), '# guide\n');
  fs.mkdirSync(path.join(empty, 'atris', 'doc-health'), { recursive: true });
  fs.writeFileSync(path.join(empty, 'atris', 'doc-health', 'questions.jsonl'), JSON.stringify({ q: 'where is the guide', expect: 'guide.md' }) + '\n');
  const created = JSON.parse(run(empty, 'task', 'new', 'write a useful guide', '--json')).task;
  run(empty, 'task', 'claim', created.display_id, '--as', 'tester');
  const busy = run(empty, 'atris.md'); plain(busy); assert.match(busy, /now\s+write a useful guide/); assert.match(busy, /docs\s+\d+\/100 · the map answers .* tokens to read at start/);
  const notReady = run(empty, 'doctor'); plain(notReady); assert.match(notReady, /needs? fixing/);
  const json = JSON.parse(run(empty, 'doctor', '--json'));
  assert.deepEqual(Object.keys(json).sort(), ['action', 'auth', 'bin', 'cli_runnable', 'home', 'install_git', 'members', 'node', 'ok', 'task_support', 'task_support_requires', 'version', 'version_line', 'warnings', 'workspace_root'].sort());
  const ready = collectDoctor({ cwd: empty, binInstalled: () => true });
  ready.auth = { signed_in: true, email: 'person@example.com', source: 'env' };
  ready.members.git_repo = true; ready.members.members = 1; ready.members.built_in_tool = true;
  const readyText = renderDoctor(ready); plain(readyText); assert.match(readyText, /this computer is ready/);
});

test('doctor names each kind of failure and its first fix', () => {
  const base = { version: '1', node: { version: 'v22.0.0', exec_path: '/node' }, task_support: true, cli_runnable: true, bin: { shim: true, public_bin: 'bin/atris', shim_bytes: 10 }, auth: { signed_in: true, email: 'a' }, workspace_root: __dirname, members: { members: 1, git_installed: true, git_repo: true, tools: ['codex'], built_in_tool: true }, warnings: [] };
  const cases = [
    [{ task_support: false }, /node.*too old/, /fix: install node/],
    [{ cli_runnable: false }, /program file is missing/, /fix: npm install -g atris  \(reinstall atris/],
    [{ bin: { shim: false, public_bin: 'bin/atris', shim_bytes: null } }, /startup file.*missing/, /fix: npm install -g atris  \(reinstall atris/],
    [{ auth: { signed_in: false } }, /signed in\s+no/, /fix: atris login/],
  ];
  for (const [change, row, fix] of cases) { const text = renderDoctor({ ...base, ...change }); assert.match(text, row); assert.match(text, fix); }
});

test('doctor offers the right fix for team and tool problems', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-doctor-plain-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'atris')); fs.writeFileSync(path.join(root, 'atris', 'atris.md'), '# atris\n');
  const base = { version: '1', node: { version: 'v22.0.0', exec_path: '/node' }, task_support: true, cli_runnable: true, bin: { shim: true }, auth: { signed_in: true, email: 'a' }, workspace_root: root, members: { members: 1, git_installed: true, git_repo: true, tools: ['codex'], built_in_tool: true }, warnings: [] };
  const cases = [
    [{ members: 0 }, /team\s+none/, /fix: atris init/],
    [{ git_installed: false }, /git\s+not installed/, /fix: install git/],
    [{ git_repo: false }, /folder has no git history/, /fix: git init/],
    [{ tools: [], built_in_tool: false }, /coding tools\s+none/, /fix: install claude code or codex/],
  ];
  for (const [change, row, fix] of cases) {
    const text = renderDoctor({ ...base, members: { ...base.members, ...change } });
    assert.match(text, row); assert.match(text, fix);
  }
  fs.rmSync(path.join(root, 'atris'), { recursive: true });
  const noFolder = renderDoctor(base);
  assert.match(noFolder, /not set up/); assert.match(noFolder, /fix: atris init/);
});
