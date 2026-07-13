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

test('healer ignores editorial annotations on valid refs', () => {
  const { dir, atrisDir } = makeTempAtris();
  try {
    const source = [
      '// header',
      'function annotatedTarget() {',
      '  return true;',
      '}',
      '',
    ].join('\n');
    const srcFile = path.join(dir, 'commands', 'annotated.js');
    fs.mkdirSync(path.dirname(srcFile), { recursive: true });
    fs.writeFileSync(srcFile, source);

    const mapContent = [
      '# MAP',
      '`commands/annotated.js:1` (WIP)',
      '`commands/annotated.js:2` (PATCH +177)',
      '`commands/annotated.js:3` (NEW)',
      '`commands/annotated.js:4` (TODO)',
      '`commands/annotated.js:5` (DEPRECATED)',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(atrisDir, 'MAP.md'), mapContent);

    const result = healBrokenMapRefs(dir, atrisDir, false);

    assert.equal(result.healed, 0);
    assert.deepEqual(result.unhealable, []);
    assert.equal(fs.readFileSync(path.join(atrisDir, 'MAP.md'), 'utf8'), mapContent);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('healer still reports a genuine symbol mismatch as unhealable', () => {
  const { dir, atrisDir } = makeTempAtris();
  try {
    const source = [
      '// header',
      'function actualTarget() {',
      '  return true;',
      '}',
      '',
    ].join('\n');
    const srcFile = path.join(dir, 'commands', 'mismatch.js');
    fs.mkdirSync(path.dirname(srcFile), { recursive: true });
    fs.writeFileSync(srcFile, source);

    const mapContent = [
      '# MAP',
      '`commands/mismatch.js:2` (missingTarget function)',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(atrisDir, 'MAP.md'), mapContent);

    const result = healBrokenMapRefs(dir, atrisDir, false);

    assert.equal(result.healed, 0);
    assert.deepEqual(result.unhealable, [
      { file: 'commands/mismatch.js', line: 2, reason: 'Symbol "missingTarget" not found' },
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('healer treats prose after an in-bounds ref as a description', () => {
  const { dir, atrisDir } = makeTempAtris();
  try {
    const source = [
      '// header',
      'const fleetState = {};',
      '',
    ].join('\n');
    const srcFile = path.join(dir, 'commands', 'fleet.js');
    fs.mkdirSync(path.dirname(srcFile), { recursive: true });
    fs.writeFileSync(srcFile, source);

    const mapContent = [
      '# MAP',
      '`commands/fleet.js:2` - Single source of truth for fleet state',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(atrisDir, 'MAP.md'), mapContent);

    const result = healBrokenMapRefs(dir, atrisDir, false);

    assert.equal(result.healed, 0);
    assert.deepEqual(result.unhealable, []);
    assert.equal(fs.readFileSync(path.join(atrisDir, 'MAP.md'), 'utf8'), mapContent);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('healer still treats camelCase context as a symbol', () => {
  const { dir, atrisDir } = makeTempAtris();
  try {
    const source = [
      '// header',
      'function actualTarget() {',
      '  return true;',
      '}',
      '',
    ].join('\n');
    const srcFile = path.join(dir, 'commands', 'mission.js');
    fs.mkdirSync(path.dirname(srcFile), { recursive: true });
    fs.writeFileSync(srcFile, source);

    const mapContent = [
      '# MAP',
      '`commands/mission.js:2` - resolveMission helper',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(atrisDir, 'MAP.md'), mapContent);

    const result = healBrokenMapRefs(dir, atrisDir, false);

    assert.equal(result.healed, 0);
    assert.deepEqual(result.unhealable, [
      { file: 'commands/mission.js', line: 2, reason: 'Symbol "resolveMission" not found' },
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('healer resolves tilde refs from an injected home and preserves missing refs', () => {
  const { dir, atrisDir } = makeTempAtris();
  const fakeHome = path.join(dir, 'home');
  try {
    const source = [
      '// header',
      '// more',
      'function tildeTarget() {',
      '  return true;',
      '}',
      '',
    ].join('\n');
    const srcFile = path.join(fakeHome, 'arena', 'sibling', 'tilde.js');
    fs.mkdirSync(path.dirname(srcFile), { recursive: true });
    fs.writeFileSync(srcFile, source);

    const mapContent = [
      '# MAP',
      '`~/arena/sibling/tilde.js:20` (tildeTarget function)',
      '`~/arena/sibling/missing.js:8` (missingTarget function)',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(atrisDir, 'MAP.md'), mapContent);

    const result = healBrokenMapRefs(dir, atrisDir, false, fakeHome);

    assert.equal(result.healed, 1);
    assert.deepEqual(result.unhealable, [
      { file: '~/arena/sibling/missing.js', line: 8, reason: 'File not found' },
    ]);
    const updated = fs.readFileSync(path.join(atrisDir, 'MAP.md'), 'utf8');
    assert.match(updated, /~\/arena\/sibling\/tilde\.js:3/);
    assert.match(updated, /~\/arena\/sibling\/missing\.js:8/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('healer uses absolute refs as-is and preserves missing refs', () => {
  const { dir, atrisDir } = makeTempAtris();
  try {
    const source = [
      '// header',
      '// more',
      'function absoluteTarget() {',
      '  return true;',
      '}',
      '',
    ].join('\n');
    const srcFile = path.join(dir, 'sibling', 'absolute.js');
    fs.mkdirSync(path.dirname(srcFile), { recursive: true });
    fs.writeFileSync(srcFile, source);
    const missingFile = path.join(dir, 'sibling', 'missing.js');

    const mapContent = [
      '# MAP',
      `\`${srcFile}:20\` (absoluteTarget function)`,
      `\`${missingFile}:8\` (missingTarget function)`,
      '',
    ].join('\n');
    fs.writeFileSync(path.join(atrisDir, 'MAP.md'), mapContent);

    const result = healBrokenMapRefs(dir, atrisDir, false);

    assert.equal(result.healed, 1);
    assert.deepEqual(result.unhealable, [
      { file: missingFile, line: 8, reason: 'File not found' },
    ]);
    const updated = fs.readFileSync(path.join(atrisDir, 'MAP.md'), 'utf8');
    assert.ok(updated.includes(`${srcFile}:3`));
    assert.ok(updated.includes(`${missingFile}:8`));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('healer ignores descriptive annotations that are not code symbols', () => {
  const { dir, atrisDir } = makeTempAtris();
  try {
    const source = [
      '// header',
      'function realTarget() {',
      '  return true;',
      '}',
      '',
    ].join('\n');
    const srcFile = path.join(dir, 'api.js');
    fs.writeFileSync(srcFile, source);

    const mapContent = [
      '# MAP',
      // in-bounds ref, annotation is prose ("PATCH /api/...") not a symbol
      '`api.js:2` (PATCH endpoint handler)',
      // out-of-bounds ref with an unfindable symbol stays unhealable
      '`api.js:99` (GHOST function)',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(atrisDir, 'MAP.md'), mapContent);

    const result = healBrokenMapRefs(dir, atrisDir, false);

    assert.deepEqual(result.unhealable, [
      { file: 'api.js', line: 99, reason: 'Symbol "GHOST" not found' },
    ]);
    const updated = fs.readFileSync(path.join(atrisDir, 'MAP.md'), 'utf8');
    assert.ok(updated.includes('api.js:2'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
