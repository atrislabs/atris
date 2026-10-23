const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('keep reports a regular file as an experiment that was not found', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-experiments-keep-file-'));
  const previousCwd = process.cwd();
  const previousHome = process.env.HOME;
  t.after(() => {
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(root, { recursive: true, force: true });
  });
  process.env.HOME = root;
  process.chdir(root);
  const experimentsDir = path.join(root, 'atris', 'experiments');
  fs.mkdirSync(experimentsDir, { recursive: true });
  fs.writeFileSync(path.join(experimentsDir, 'plain-file'), 'not a directory\n');

  const { experimentsCommand } = require('../commands/experiments');
  const errors = [];
  t.mock.method(console, 'error', (...args) => errors.push(args.join(' ')));
  const exit = new Error('command exited');
  t.mock.method(process, 'exit', () => { throw exit; });

  assert.throws(() => experimentsCommand('keep', 'plain-file'), (error) => error === exit);
  assert.deepEqual(errors, ['experiment "plain-file" not found.']);
});
