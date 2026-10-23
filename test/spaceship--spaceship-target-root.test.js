'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function withWorkspace(run) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'spaceship-target-root-'));
  const root = fs.realpathSync(temp);
  const previousCwd = process.cwd();
  const previousHome = process.env.HOME;
  const atrisEnv = Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => key.startsWith('ATRIS_')));
  try {
    for (const key of Object.keys(atrisEnv)) delete process.env[key];
    process.env.HOME = root;
    fs.mkdirSync(path.join(root, 'atris'));
    fs.writeFileSync(path.join(root, 'atris', 'atris.md'), 'test workspace\n');
    const nested = path.join(root, 'src', 'nested');
    fs.mkdirSync(nested, { recursive: true });
    process.chdir(nested);
    const { spaceshipTargetRoot } = require('../commands/spaceship');
    run({ root, nested, spaceshipTargetRoot });
  } finally {
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('ATRIS_')) delete process.env[key];
    }
    Object.assign(process.env, atrisEnv);
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

test('explicit absolute and relative repo paths resolve to their workspace root', () => {
  withWorkspace(({ root, spaceshipTargetRoot }) => {
    const other = path.join(root, 'other workspace');
    const child = path.join(other, 'source');
    fs.mkdirSync(path.join(other, 'atris'), { recursive: true });
    fs.writeFileSync(path.join(other, 'atris', 'atris.md'), 'other workspace\n');
    fs.mkdirSync(child);

    assert.strictEqual(spaceshipTargetRoot(['--repo', child]), other);
    assert.strictEqual(spaceshipTargetRoot(['--repo', '../../other workspace/source']), other);
    assert.strictEqual(spaceshipTargetRoot(['--repo', child, '--repo', root]), other);
  });
});

test('empty arguments and incomplete repo flags fall back to the current workspace', () => {
  withWorkspace(({ root, spaceshipTargetRoot }) => {
    assert.strictEqual(spaceshipTargetRoot(), root);
    for (const args of [[], null, '--repo', {}, ['--repo'], ['--repo', ''], ['--repo', '--yes']]) {
      assert.strictEqual(spaceshipTargetRoot(args), root);
    }
  });
});

test('a truthy non-string repo value raises a path argument error', () => {
  withWorkspace(({ spaceshipTargetRoot }) => {
    assert.throws(() => spaceshipTargetRoot(['--repo', 42]), {
      name: 'TypeError',
      code: 'ERR_INVALID_ARG_TYPE',
    });
  });
});
