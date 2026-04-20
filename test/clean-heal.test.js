const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { healBrokenMapRefs } = require('../commands/clean');

function makeTempAtris() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-heal-test-'));
  const atrisDir = path.join(dir, 'atris');
  fs.mkdirSync(atrisDir, { recursive: true });
  return { dir, atrisDir };
}

test('healer verifies Function Inventory refs (symbol BEFORE ref)', () => {
  const { dir, atrisDir } = makeTempAtris();
  try {
    // Source file: function starts at line 3, not line 10
    const source = [
      '// header',
      '// more',
      'function autopilotAtris() {',
      '  return 42;',
      '}',
      '',
    ].join('\n');
    const srcFile = path.join(dir, 'commands', 'autopilot.js');
    fs.mkdirSync(path.dirname(srcFile), { recursive: true });
    fs.writeFileSync(srcFile, source);

    // MAP.md uses "Function Inventory" pre-ref form: `symbol()` → `file:line-line`
    // Drifted line: says 10-14 but symbol actually at 3
    const mapContent = [
      '# MAP',
      '## Function Inventory',
      '`autopilotAtris()` → `commands/autopilot.js:10-14`',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(atrisDir, 'MAP.md'), mapContent);

    const result = healBrokenMapRefs(dir, atrisDir, false);

    assert.equal(result.healed, 1, 'should heal 1 pre-ref drift');
    const updated = fs.readFileSync(path.join(atrisDir, 'MAP.md'), 'utf8');
    assert.match(updated, /commands\/autopilot\.js:3-/, 'should rewrite start line to 3');
    assert.doesNotMatch(updated, /:10-14/, 'old drifted range should be gone');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('healer still handles post-ref symbol context (baseline)', () => {
  const { dir, atrisDir } = makeTempAtris();
  try {
    const source = [
      '// header',
      '// more',
      'function fooBar() {',
      '  return 1;',
      '}',
      '',
    ].join('\n');
    const srcFile = path.join(dir, 'commands', 'foo.js');
    fs.mkdirSync(path.dirname(srcFile), { recursive: true });
    fs.writeFileSync(srcFile, source);

    // Post-ref symbol form: "file:line (symbol)"
    const mapContent = [
      '# MAP',
      '`commands/foo.js:10` (fooBar function)',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(atrisDir, 'MAP.md'), mapContent);

    const result = healBrokenMapRefs(dir, atrisDir, false);
    assert.equal(result.healed, 1, 'should heal post-ref form too');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
