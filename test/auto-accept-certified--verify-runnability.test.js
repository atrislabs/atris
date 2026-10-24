'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { verifyRunnability } = require('../lib/auto-accept-certified');

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-runnability-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('allowed commands and chains return null without executing them', (t) => {
  const root = workspace(t);
  const marker = path.join(root, 'executed');
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.writeFileSync(path.join(root, 'scripts', 'check.js'),
    "require('node:fs').writeFileSync('executed', 'ran');\n");

  for (const verify of [
    'node scripts/check.js',
    '  node --check scripts/check.js  ',
    'node --check scripts/check.js && node --test test/example.test.js',
    'node --test --test-name-pattern "normal case|edge case" test/example.test.js',
  ]) {
    assert.strictEqual(verifyRunnability({ workspace_root: root, metadata: { verify } }), null, verify);
  }
  assert.strictEqual(fs.existsSync(marker), false);
});

test('absent, empty, and whitespace-only metadata commands report no command', (t) => {
  const root = workspace(t);
  for (const metadata of [undefined, null, {}, { verify: '' }, { verify: ' \t\n ' }]) {
    assert.strictEqual(verifyRunnability({ workspace_root: root, metadata }), 'no_verify_command');
  }
});

test('unsafe commands and malformed chains are rejected', (t) => {
  const root = workspace(t);
  for (const verify of [
    'echo hello',
    'node --check ../outside.js',
    'node --check scripts/check.js | cat',
    'node --check scripts/check.js &&',
    'node --test --test-name-pattern',
  ]) {
    assert.strictEqual(verifyRunnability({ workspace_root: root, metadata: { verify } }),
      'verify_command_not_allowed', verify);
  }
});

test('rewritten commands distinguish missing files from files present in the workspace', (t) => {
  const root = workspace(t);
  const task = {
    workspace_root: root,
    metadata: { verify: `cd ${root} && node --check scripts/check.js` },
  };
  assert.strictEqual(verifyRunnability(task), 'verify_only_on_agent_branch');

  fs.mkdirSync(path.join(root, 'scripts'));
  // Invalid JavaScript is still runnable: this function checks paths, not syntax.
  fs.writeFileSync(path.join(root, 'scripts', 'check.js'), 'invalid javascript {');
  assert.strictEqual(verifyRunnability(task), null);

  task.metadata.verify = `cd ${root}/nested && node --check check.js`;
  assert.strictEqual(verifyRunnability(task), 'verify_only_on_agent_branch');
  fs.mkdirSync(path.join(root, 'nested'));
  fs.writeFileSync(path.join(root, 'nested', 'check.js'), '');
  assert.strictEqual(verifyRunnability(task), null);
});
