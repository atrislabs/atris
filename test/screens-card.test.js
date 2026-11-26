const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { extractScreensRules, screensRulesForRoot, upsertScreensAdapters } = require('../lib/opening-lines');

const repoRoot = path.join(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');
const bullets = extractScreensRules(fs.readFileSync(path.join(repoRoot, 'atris.md'), 'utf8')).split('\n');

test('init puts the six screen rules in every start-up file and a rerun adds nothing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-screens-card-'));
  try {
    fs.mkdirSync(path.join(dir, 'home'));
    fs.writeFileSync(path.join(dir, 'GEMINI.md'), '# GEMINI\n');
    const result = spawnSync(process.execPath, [cliPath, 'init', '--no-commit'], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1', HOME: path.join(dir, 'home') },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(bullets.length, 6);
    for (const rel of ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md', '.cursorrules']) {
      const content = fs.readFileSync(path.join(dir, rel), 'utf8');
      for (const bullet of bullets) assert.ok(content.includes(bullet), `${rel} is missing: ${bullet}`);
    }
    assert.equal(fs.existsSync(path.join(dir, '.cursor/rules/atris-screens.mdc')), false);
    assert.deepEqual(upsertScreensAdapters(dir, screensRulesForRoot(dir)), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an atris.md with no screens section gives no block and changes nothing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-screens-old-'));
  try {
    const old = '# atris\n\n## voice\n\n- **Lead with the move.** Answer first.\n';
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# AGENTS\n');
    const rules = extractScreensRules(old);
    assert.equal(rules, '');
    assert.deepEqual(upsertScreensAdapters(dir, rules), []);
    assert.equal(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8'), '# AGENTS\n');
    assert.equal(fs.existsSync(path.join(dir, '.cursor')), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
