'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const cli = path.resolve(__dirname, '../bin/atris.js');

test('malformed dispatch options fail before an engine can run', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-dispatch-args-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'atris'));
  const marker = path.join(root, 'engine-ran');
  const engine = path.join(root, 'cursor');
  fs.writeFileSync(engine, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
  const run = (args) => spawnSync(process.execPath, [cli, 'engine', 'dispatch', 'CLI-1', '--engine', 'cursor', ...args], {
    cwd: root, encoding: 'utf8', timeout: 20000,
    env: { ...process.env, PATH: `${root}:/usr/bin:/bin`, ATRIS_SKIP_UPDATE_CHECK: '1' },
  });
  for (const flag of ['--engine', '--pick', '--prompt-file', '--base']) {
    for (const args of [[flag], [`${flag}=`], [flag, '--json'], [`${flag}=   `]]) {
      const result = run(args);
      assert.ifError(result.error);
      assert.equal(result.status, 2, JSON.stringify(args));
      assert.match(result.stderr, new RegExp(`${flag} requires a non-empty value`));
      assert.equal(fs.existsSync(marker), false);
    }
  }
  for (const args of [['--typo', 'other-task'], ['--json=1'], ['-x']]) {
    const result = run(args);
    assert.ifError(result.error);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /unknown option/);
    assert.equal(fs.existsSync(marker), false);
  }
  for (const [option, first, second] of [
    ['--engine', 'cursor', 'codex'],
    ['--prompt-file', 'first.md', 'second.md'],
    ['--base', 'master', 'other'],
    ['--pick', 'rating', 'turns'],
  ]) {
    // The default --engine above is already the first occurrence.
    const args = option === '--engine' ? [`${option}=${second}`]
      : [option, first, `${option}=${second}`];
    const result = run(args);
    assert.ifError(result.error);
    assert.equal(result.status, 2, JSON.stringify(args));
    assert.match(result.stderr, new RegExp(`${option} may only be specified once`));
    assert.equal(fs.existsSync(marker), false);
  }
  for (const contents of ['', ' \n\t']) {
    const promptFile = path.join(root, 'empty-prompt.md');
    fs.writeFileSync(promptFile, contents);
    const result = run(['--prompt-file', promptFile]);
    assert.ifError(result.error);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /--prompt-file must contain a non-empty prompt/);
    assert.equal(fs.existsSync(marker), false);
  }
  const valid = run(['--prompt-file=/definitely/missing/prompt.md', '--base=master', '--pick=rating']);
  assert.equal(valid.status, 2);
  assert.match(valid.stderr, /could not read --prompt-file/);
  assert.equal(fs.existsSync(marker), false);
});
