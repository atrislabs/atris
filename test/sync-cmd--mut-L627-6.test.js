const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { syncAtris } = require('../commands/sync');

test('keeps the current task list when legacy tasks also exist', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-task-migration-'));
  const cwd = process.cwd();
  const env = { ...process.env };
  const log = console.log;
  t.after(() => {
    console.log = log;
    process.chdir(cwd);
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, env);
    fs.rmSync(root, { recursive: true, force: true });
  });
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('ATRIS_')) delete process.env[key];
  }
  process.env.HOME = root;
  process.chdir(root);
  console.log = () => {};
  fs.mkdirSync(path.join(root, 'atris'));
  const todo = path.join(root, 'atris', 'TODO.md');
  const current = '# TODO\n\n- [ ] Ship the current release\n';
  fs.writeFileSync(todo, current);
  fs.writeFileSync(path.join(root, 'atris', 'TASK_CONTEXTS.md'), '# Task contexts\n\n- [ ] Review the old release\n');

  syncAtris({ yes: true, dryRun: false, force: false });

  assert.strictEqual(fs.readFileSync(todo, 'utf8'), current);
});
