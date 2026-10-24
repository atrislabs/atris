const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { start, review } = require('../commands/write');

test('a clean draft with every beat filled reports ok in the json verdict', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-write-mut-'));
  const beforeHome = process.env.HOME;
  process.env.HOME = root;
  t.after(() => {
    if (beforeHome === undefined) delete process.env.HOME;
    else process.env.HOME = beforeHome;
    fs.rmSync(root, { recursive: true, force: true });
  });

  start(['Verdict', '--beats', 'Only'], root);
  fs.writeFileSync(
    path.join(root, 'atris', 'writing', 'verdict', 'draft.md'),
    '# Verdict\n\n## Only\nA plain sentence in my own voice.\n'
  );

  const lines = [];
  const log = console.log;
  console.log = (...parts) => lines.push(parts.join(' '));
  let code;
  try {
    code = review(['verdict', '--json'], root);
  } finally {
    console.log = log;
  }

  assert.equal(code, 0);
  assert.strictEqual(JSON.parse(lines.join('\n')).ok, true);
});
