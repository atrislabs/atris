const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// CI spreads test files across four machines, one whole file at a time. The old
// 20k-line commands.test.js landed on one machine and made it the long pole, so
// it lives as several parts now. This keeps any part from growing back into it.
const testDir = __dirname;
const MAX_PART_LINES = 6000;

function partFiles() {
  return fs.readdirSync(testDir).filter((name) => /^commands-part-\d+\.test\.js$/.test(name)).sort();
}

test('the old single commands test file stays split', () => {
  assert.equal(fs.existsSync(path.join(testDir, 'commands.test.js')), false,
    'test/commands.test.js is back; add new tests to the smallest commands-part file instead');
  assert.ok(partFiles().length >= 4, `expected at least 4 commands-part files, found ${partFiles().length}`);
});

test('no commands part grows into the long pole again', () => {
  for (const name of partFiles()) {
    const lines = fs.readFileSync(path.join(testDir, name), 'utf8').split('\n').length;
    assert.ok(lines <= MAX_PART_LINES, `${name} has ${lines} lines (limit ${MAX_PART_LINES}); start a new part`);
  }
});

test('every commands part loads the shared setup it names', () => {
  const shared = require('./helpers/commands-shared');
  for (const name of partFiles()) {
    const text = fs.readFileSync(path.join(testDir, name), 'utf8');
    const block = text.match(/const \{([^{}]*)\} = require\('\.\/helpers\/commands-shared'\);/);
    if (!block) continue;
    for (const key of block[1].split(',').map((s) => s.trim()).filter(Boolean)) {
      assert.ok(key in shared, `${name} imports ${key}, which commands-shared does not export`);
    }
  }
});
