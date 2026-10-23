const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

function valuesSection(text) {
  const match = text.match(/\n## values\n([\s\S]*?)\n## /);
  return match ? match[1] : '';
}

test('the shipped atris.md names the four values every agent works by', () => {
  const section = valuesSection(fs.readFileSync(path.join(repoRoot, 'atris.md'), 'utf8'));
  for (const name of ['Acceleration', 'Accuracy', 'Ambition', 'Agency']) {
    assert.match(section, new RegExp(`\\*\\*${name}\\.\\*\\*`), `missing ${name}`);
  }
});

test('atris init gives a new workspace the four values', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-four-a-'));
  try {
    const result = spawnSync(process.execPath, [cliPath, 'init', '--yes', '--no-commit'], {
      cwd: dir,
      encoding: 'utf8',
      timeout: 60000,
      env: { ...process.env, ATRIS_NO_UPDATE_CHECK: '1', CI: '1' },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const section = valuesSection(fs.readFileSync(path.join(dir, 'atris', 'atris.md'), 'utf8'));
    assert.match(section, /\*\*Agency\.\*\*/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
