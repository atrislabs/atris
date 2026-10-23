const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { check, saveRegistry } = require('../commands/strings');

test('an empty document has no banned undefined wording', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-empty-wording-'));
  const cwd = process.cwd();
  const log = console.log;
  const output = [];
  try {
    saveRegistry({
      strings: [],
      terms: [{ ban: 'undefined', prefer: 'not set', why: '' }],
    }, root);
    fs.writeFileSync(path.join(root, 'page.md'), '');
    process.chdir(root);
    console.log = (value) => output.push(value);

    const code = check(['page.md', '--json']);
    assert.strictEqual(JSON.parse(output.join('\n')).findings.length, 0);
    assert.strictEqual(code, 0);
  } finally {
    console.log = log;
    process.chdir(cwd);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
