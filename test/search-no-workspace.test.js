const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// CLI-906 papercut: running atris search in a folder with no atris/ used to
// print four empty scan rows before the one line that matters. Outside a
// workspace the only useful output is how to start.

const { searchCommand } = require(path.join('..', 'commands', 'search.js'));

test('search outside a workspace prints only the init hint', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-search-'));
  const logs = [];
  const originalLog = console.log;
  console.log = (msg) => logs.push(String(msg));
  try {
    const code = searchCommand(['auth'], { root: dir });
    assert.strictEqual(code, 0);
    const output = logs.join('\n');
    assert.ok(output.includes('No atris folder here. Run atris init to set one up.'));
    assert.ok(!output.includes('Feature: none'), 'must not print empty scan rows');
    assert.ok(!output.includes('No matches found.'), 'the hint replaces the empty-result line');
  } finally {
    console.log = originalLog;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
