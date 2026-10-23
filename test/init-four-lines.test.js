const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const { extractOpeningLines } = require('../lib/opening-lines');

const repoRoot = path.join(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');
const sourceBullets = extractOpeningLines(fs.readFileSync(path.join(repoRoot, 'atris.md'), 'utf8'))
  .split('\n');

function runInit(cwd, home) {
  const result = spawnSync(process.execPath, [cliPath, 'init', '--yes', '--no-commit'], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1', HOME: home },
  });
  assert.equal(result.status, 0, `init failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
}

test('atris.md opens its operating rules with four bullets', () => {
  assert.equal(sourceBullets.length, 4);
  for (const word of ['Acceleration', 'Accuracy', 'Ambition', 'Agency']) {
    assert.ok(sourceBullets.some((line) => line.startsWith(`- **${word}.**`)), `missing ${word}`);
  }
});

test('fresh init copies the four lines into AGENTS.md and CLAUDE.md, sourced and unlabeled', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-init-four-lines-'));
  const home = path.join(dir, 'home');
  const project = path.join(dir, 'project');
  fs.mkdirSync(home);
  fs.mkdirSync(project);
  try {
    spawnSync('git', ['init', '-q'], { cwd: project });
    runInit(project, home);
    runInit(project, home);

    for (const file of ['AGENTS.md', 'CLAUDE.md']) {
      const content = fs.readFileSync(path.join(project, file), 'utf8');
      for (const line of sourceBullets) {
        assert.equal(content.split(line).length, 2, `${file} should carry exactly one copy of: ${line}`);
      }
      assert.match(content, /Canonical source: `atris\/atris\.md` `## operating rules`/, `${file} names its source`);
      assert.doesNotMatch(content, /four a'?s|4 ?a'?s|## attitude/i, `${file} labels the lines`);
    }

    const claude = fs.readFileSync(path.join(project, 'CLAUDE.md'), 'utf8');
    const end = claude.indexOf('<!-- ATRIS:END -->');
    assert.ok(end > claude.indexOf(sourceBullets[3]), 'CLAUDE.md copy sits inside the managed atris block');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
