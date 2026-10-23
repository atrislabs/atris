'use strict';

// Codex review round 9 on #1483, honest mistakes and regressions: atris verbs
// that cost credits are spend, and package scripts keep the shell the project
// or user configured while the wrappers stay first on PATH.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');

const yesLock = require('../lib/yes-lock');
const { prepareMissionGitGuard } = require('../lib/mission-protected-lane');

const has = bin => spawnSync('sh', ['-c', `command -v ${bin}`], { encoding: 'utf8' }).stdout.trim();

// ---- 1: paid atris verbs are spend ----------------------------------------------------

test('codex 1: atris verbs that cost credits are spend; free uses of them are not', () => {
  const cats = args => yesLock.analyze('atris', args).cats;
  for (const args of [['x-search', 'competitors'], ['x-search', '--name', 'sam'], ['youtube', 'search', '--paid', 'topic'],
    ['youtube', 'process', 'https://youtu.be/x'], ['youtube', 'https://youtu.be/x'], ['improve', 'tick'], ['aeo', 'draft'],
    ['visualize', 'a red barn'], ['ask', 'find me leads'], ['chat', 'hi'], ['fast', 'hi'], ['ax', 'fast', 'hi'], ['computer', 'run', 'ls'],
    ['terminal', 'ls'], ['wake'], ['align'], ['pull'], ['fleet-report'], ['wiki', 'query', '--cloud', 'q'], ['lint', '--cloud'],
    ['ingest', '--cloud', 'x.md'], ['campaign', 'cloud-run', 'c1'], ['agent', 'spawn', 'researcher']]) {
    assert.ok(cats(args).includes('spend'), args.join(' '));
  }
  for (const args of [['youtube', 'search', 'topic'], ['youtube', 'notes', 'https://youtu.be/x'], ['improve', 'doctor'],
    ['wiki', 'query', 'q'], ['lint'], ['chat', 'scan'], ['computer', 'status'], ['aeo', 'status'], ['balance'], ['sleep']]) {
    assert.ok(!cats(args).includes('spend'), args.join(' '));
  }
});

test('a bet that locks spending holds paid research; a bet that does not lets it run', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yes-r9-'));
  try {
    const spend = yesLock.sealFor([{ text: 'pay for the research', who: 'you', public: false }]);
    const post = yesLock.sealFor([{ text: 'post the thread', who: 'you', public: true }]);
    yesLock.writeYesLocks(dir, 'm-spend', { seal: spend });
    yesLock.writeYesLocks(dir, 'm-post', { seal: post });
    const v = (id, seal, args) => yesLock.check({ stateDir: dir, missionId: id, seal, tool: 'atris', args, cwd: dir });
    assert.equal(v('m-spend', spend, ['x-search', 'competitors']).hold, true);
    assert.equal(v('m-spend', spend, ['youtube', 'search', '--paid', 'topic']).hold, true);
    assert.equal(v('m-spend', spend, ['youtube', 'search', 'topic']), null, 'free search runs');
    assert.equal(v('m-post', post, ['x-search', 'competitors']), null, 'spending is not locked in this bet');
    // a woken run: paid research waits, free search runs
    const seal = yesLock.handoffSeal();
    yesLock.writeYesLocks(dir, 'm-woken', { seal });
    assert.equal(v('m-woken', seal, ['x-search', 'competitors']).hold, true);
    assert.equal(v('m-woken', seal, ['youtube', 'search', '--paid', 'topic']).hold, true);
    assert.equal(v('m-woken', seal, ['youtube', 'search', 'topic']), null, 'plain youtube search is free and allowed');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('final round: a paid verb with no sub, or a sub it does not know, is spend', () => {
  const cats = args => yesLock.analyze('atris', args).cats;
  for (const args of [['computer'], ['computer', 'frob'], ['aeo'], ['aeo', 'frob'], ['agent'], ['campaign', 'frob'], ['youtube'], ['improve'], ['chat']]) {
    assert.ok(cats(args).includes('spend'), args.join(' '));
  }
  for (const args of [['computer', 'status'], ['aeo', 'status'], ['agent', 'spawns'], ['campaign', 'status'], ['improve', 'doctor'], ['computer', 'help']]) {
    assert.ok(!cats(args).includes('spend'), args.join(' '));
  }
});

// ---- 2: package scripts keep the configured shell, wrappers first -----------------------

// A repo under a woken run's guard, with a project-local npm that must never
// run and a configured shell that says it ran.
function scriptWorld(t, tool) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'yes-r9-shell-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'repo');
  const stateDir = path.join(base, 'state');
  fs.mkdirSync(path.join(root, 'node_modules', '.bin'), { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'feature', root]);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'p', version: '1.0.0', license: 'MIT', scripts: { ok: 'echo fine', ship: 'npm publish' } }));
  fs.writeFileSync(path.join(root, 'node_modules', '.bin', 'npm'), '#!/bin/sh\necho LOCAL-NPM-RAN\n', { mode: 0o755 });
  const shell = path.join(base, 'configured-shell');
  fs.writeFileSync(shell, '#!/bin/sh\necho configured-shell-ran\nexec /bin/sh "$@"\n', { mode: 0o755 });
  const seal = yesLock.handoffSeal();
  yesLock.writeYesLocks(stateDir, 'm-woken', { seal });
  const bins = [has(tool), has('npm'), process.execPath, has('git')].filter(Boolean).map(b => path.dirname(b));
  const guard = prepareMissionGitGuard({ root, missionId: 'm-woken', yesLockSeal: seal, stateDir, pathValue: [...new Set(bins), '/usr/bin', '/bin'].join(path.delimiter) });
  t.after(() => guard.cleanup());
  const run = cmd => spawnSync('sh', ['-c', cmd], { cwd: root, env: { ...process.env, PATH: guard.env.PATH }, encoding: 'utf8' });
  return { root, shell, run };
}

for (const tool of ['npm', 'pnpm', 'yarn']) {
  test(`codex 2: ${tool} scripts run in the configured shell, and the wrappers still come first`, (t) => {
    if (!has(tool) || !has('npm')) { t.skip(`no ${tool} here`); return; }
    const w = scriptWorld(t, tool);
    if (tool === 'yarn') fs.writeFileSync(path.join(w.root, '.yarnrc'), `script-shell "${w.shell}"\n`);
    else fs.writeFileSync(path.join(w.root, '.npmrc'), `script-shell=${w.shell}\n`);
    const ok = w.run(`${tool} run ok`);
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    assert.match(ok.stdout, /^configured-shell-ran$/m, 'the configured shell ran the script');
    assert.match(ok.stdout, /^fine$/m, 'the script ran, not just its banner');
    const ship = w.run(`${tool} run ship`);
    assert.doesNotMatch(ship.stdout + ship.stderr, /LOCAL-NPM-RAN/, 'the project npm never ran');
    assert.match(ship.stderr, /held: a handed-off job wants to npm publish/);
  });
}

test('codex 2: a zsh script still runs when zsh is the configured shell', (t) => {
  const zsh = has('zsh');
  if (!zsh || !has('npm')) { t.skip('no zsh here'); return; }
  const w = scriptWorld(t, 'npm');
  fs.writeFileSync(path.join(w.root, '.npmrc'), `script-shell=${zsh}\n`);
  fs.writeFileSync(path.join(w.root, 'package.json'), JSON.stringify({ name: 'p', version: '1.0.0', scripts: { z: 'print -r -- zsh-ok; npm publish' } }));
  const res = w.run('npm run z');
  assert.match(res.stdout, /^zsh-ok$/m, `zsh ran it: ${res.stdout}${res.stderr}`);
  assert.doesNotMatch(res.stdout + res.stderr, /LOCAL-NPM-RAN/);
  assert.match(res.stderr, /held: a handed-off job wants to npm publish/, 'a zsh that rebuilds PATH still reaches the wrapper');
});

test('final round: a shell set in a --userconfig file is the one scripts run in', (t) => {
  if (!has('npm')) { t.skip('no npm here'); return; }
  const w = scriptWorld(t, 'npm');
  fs.writeFileSync(path.join(w.root, 'custom.npmrc'), `script-shell=${w.shell}\n`);
  for (const cmd of ['npm --userconfig=custom.npmrc run ok', 'npm --userconfig custom.npmrc run ok']) {
    const res = w.run(cmd);
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /^configured-shell-ran$/m, `${cmd}: ${res.stdout}`);
  }
});
