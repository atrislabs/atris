const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { verifyAtris } = require('../commands/verify');

// Task verification with file-only descriptions never invokes external tools.
// These synchronous tests restore the process-wide state before returning.
function withWorkspace(files, check) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-atris-'));
  const previousCwd = process.cwd();
  const previousLog = console.log;
  const lines = [];
  try {
    fs.mkdirSync(path.join(root, 'atris'));
    for (const [name, content] of Object.entries(files)) {
      const target = path.join(root, name);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
    }
    process.chdir(root);
    console.log = (...args) => lines.push(args.join(' '));
    check(lines);
  } finally {
    console.log = previousLog;
    process.chdir(previousCwd);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('verifyAtris verifies an existing file documented in the map', () => {
  withWorkspace({
    'atris/TODO.md': '### T1: Add entry\nCreate `src/entry.js`.\n',
    'atris/MAP.md': '`src/entry.js` is the entry point.\n',
    'src/entry.js': 'module.exports = 42;\n',
  }, (lines) => {
    assert.strictEqual(verifyAtris('1'), 0);
    assert.ok(lines.includes('Verifying: T1: Add entry'));
    assert.ok(lines.includes('✓ File exists: src/entry.js'));
    assert.ok(lines.includes('○ Tests: Not configured'));
    assert.ok(lines.includes('✓ MAP.md: Files documented'));
    assert.ok(lines.includes('Result: VERIFIED ✓ (1/1 checks passed)'));
  });
});

test('verifyAtris returns failure for a missing expected file', () => {
  withWorkspace({
    'atris/TODO.md': '### T2: Add missing entry\nCreate `src/missing.js`.\n',
    'atris/MAP.md': '`src/missing.js` is planned.\n',
  }, (lines) => {
    assert.strictEqual(verifyAtris('2'), 1);
    assert.ok(lines.includes('✗ File exists: src/missing.js'));
    assert.ok(lines.includes('   File not found'));
    assert.ok(lines.includes('Result: INCOMPLETE (0/1 checks passed)'));
  });
});

test('verifyAtris rejects an existing file absent from an empty map', () => {
  withWorkspace({
    'atris/TODO.md': '### T3: Add entry\nCreate `src/entry.js`.\n',
    'atris/MAP.md': '',
    'src/entry.js': 'module.exports = 42;\n',
  }, (lines) => {
    assert.strictEqual(verifyAtris('3'), 1);
    assert.ok(lines.includes('✓ File exists: src/entry.js'));
    assert.ok(lines.includes('⚠ MAP.md: May need updating for new files'));
  });
});

test('verifyAtris supports the legacy task file but refuses unverifiable descriptions', () => {
  withWorkspace({
    'atris/TASK_CONTEXTS.md': '### T4: Polish\nImprove the experience.\n',
    'atris/MAP.md': '',
  }, (lines) => {
    assert.strictEqual(verifyAtris('4'), 1);
    assert.ok(lines.includes('Verifying: T4: Polish'));
    assert.ok(lines.includes('✗ Task has implementation'));
    assert.ok(lines.includes('   No verifiable check for this change type. Add an explicit verify command.'));
    assert.ok(lines.includes('Result: INCOMPLETE (0/1 checks passed)'));
  });
});
