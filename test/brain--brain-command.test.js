'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { brainCommand } = require('../commands/brain');

const USAGE = [
  'Usage: atris brain compile [--root <workspace>] [--yes] [--verify] [--json]',
  '       atris brain activate [--member <slug>] [--root <workspace>] [--yes] [--verify] [--json]',
  '       atris brain gallery [--root <workspace>] [--yes] [--verify] [--json]',
  '       atris brain go|hold [note] [--recommendation <text>] [--root <workspace>] [--verify]',
  '       atris brain approval go|edit|hold [note] [--recommendation <text>] [--root <workspace>] [--verify]',
  '       atris brain scorecard [--root <workspace>] [--verify] [--json]',
  '       atris brain feedback --rating approve|edit|reject [--recommendation <text>] [--note <text>] [--root <workspace>] [--verify]',
  '       atris brain yes|edit|no [note] [--root <workspace>] [--verify]',
];

function makeTemp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-brain-command-'));
}

function withIsolatedHome(dir, fn) {
  const names = ['HOME', 'USERPROFILE', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_CEILING_DIRECTORIES', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM'];
  const saved = new Map(names.map((name) => [name, process.env[name]]));
  const atrisNames = Object.keys(process.env).filter((name) => name.startsWith('ATRIS_'));
  const savedAtris = new Map(atrisNames.map((name) => [name, process.env[name]]));

  for (const name of atrisNames) delete process.env[name];
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  delete process.env.GIT_DIR;
  delete process.env.GIT_WORK_TREE;
  const ceiling = [path.dirname(dir)];
  try {
    ceiling.push(path.dirname(fs.realpathSync(dir)));
  } catch {
    // The temp directory is enough when realpath is unavailable.
  }
  process.env.GIT_CEILING_DIRECTORIES = Array.from(new Set(ceiling)).join(path.delimiter);
  const gitconfig = path.join(dir, 'gitconfig');
  fs.writeFileSync(gitconfig, '');
  process.env.GIT_CONFIG_GLOBAL = gitconfig;
  process.env.GIT_CONFIG_SYSTEM = gitconfig;
  spawnSync('git', ['init', '-q'], { cwd: dir, env: process.env, encoding: 'utf8' });

  try {
    return fn();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    for (const [name, value] of savedAtris) process.env[name] = value;
  }
}

function capture(fn) {
  const logs = [];
  const errors = [];
  const log = console.log;
  const error = console.error;
  console.log = (...args) => logs.push(args.map((item) => String(item)).join(' '));
  console.error = (...args) => errors.push(args.map((item) => String(item)).join(' '));
  try {
    return { result: fn(), logs, errors };
  } finally {
    console.log = log;
    console.error = error;
  }
}

test('brain help prints the usage lines', () => {
  const dir = makeTemp();
  try {
    const { result, logs, errors } = withIsolatedHome(dir, () => capture(() => brainCommand(['help'])));
    assert.equal(result, undefined);
    assert.deepEqual(logs, USAGE);
    assert.deepEqual(errors, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('help flags skip work, and an empty folder reports no scorecards', () => {
  const dir = makeTemp();
  try {
    withIsolatedHome(dir, () => {
      const helped = capture(() => brainCommand(['compile', '--help', '--root', dir]));
      assert.deepEqual(helped.logs, USAGE);
      assert.equal(fs.existsSync(path.join(dir, 'atris')), false);
      assert.equal(fs.existsSync(path.join(dir, '.atris')), false);

      const scored = capture(() => brainCommand(['scorecard', '--json', `--root=${dir}`]));
      assert.equal(scored.logs.length, 1);
      const payload = JSON.parse(scored.logs[0]);
      assert.equal(payload.ok, true);
      assert.equal(payload.stateRoot, path.resolve(dir));
      assert.equal(payload.taskEpisodes, 0);
      assert.equal(payload.written, 0);
      assert.deepEqual(payload.scorecards, []);
      assert.equal(fs.existsSync(path.join(dir, '.atris', 'state', 'scorecards.jsonl')), false);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('bad rating, bad decision, and a missing atris folder fail before any write', () => {
  const dir = makeTemp();
  try {
    withIsolatedHome(dir, () => {
      assert.throws(
        () => brainCommand(['feedback', '--root', dir, '--rating=maybe']),
        { message: 'rating must be approve, edit, or reject' },
      );
      assert.throws(
        () => brainCommand(['approval', '--root', dir]),
        { message: 'decision must be go, edit, or hold' },
      );
      assert.throws(
        () => brainCommand(['status', '--root', dir]),
        { message: 'atris/ folder not found. Run "atris init" first.' },
      );
    });
    assert.equal(fs.existsSync(path.join(dir, 'atris')), false);
    assert.equal(fs.existsSync(path.join(dir, '.atris')), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
