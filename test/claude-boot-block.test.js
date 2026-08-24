'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');
const startMarker = '<!-- ATRIS:START - Auto-generated, do not edit -->';
const endMarker = '<!-- ATRIS:END -->';

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-claude-boot-block-'));
}

function runCli(cwd, args) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1' },
  });
}

function markerCount(content, marker) {
  return content.split(marker).length - 1;
}

test('init emits a hook-aware and terminated CLAUDE.md boot block', () => {
  const dir = makeTempDir();
  try {
    const result = runCli(dir, ['init', '--yes']);
    assert.equal(result.status, 0, result.stderr || result.stdout);

    const content = fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8');
    assert.match(content, /If a SessionStart hook already displayed the Atris status block in this session, do not run it again\./);
    assert.match(content, /Otherwise, before your first response, execute `atris atris\.md` and display the full output\./);
    assert.equal(markerCount(content, startMarker), 1);
    assert.equal(markerCount(content, endMarker), 1);

    const update = runCli(dir, ['update', '--yes']);
    assert.equal(update.status, 0, update.stderr || update.stdout);
    assert.equal(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8'), content);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('update replaces an unterminated boot block with one clean terminated block', () => {
  const dir = makeTempDir();
  try {
    const init = runCli(dir, ['init', '--yes']);
    assert.equal(init.status, 0, init.stderr || init.stdout);

    fs.writeFileSync(
      path.join(dir, 'CLAUDE.md'),
      `# Project rules\n\n${startMarker}\nold boot instructions without an end marker\n`,
      'utf8',
    );

    const result = runCli(dir, ['update', '--yes']);
    assert.equal(result.status, 0, result.stderr || result.stdout);

    const content = fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8');
    assert.equal(markerCount(content, startMarker), 1);
    assert.equal(markerCount(content, endMarker), 1);
    assert.doesNotMatch(content, /old boot instructions/);
    assert.match(content, /# Project rules/);
    assert.ok(content.indexOf(endMarker) < content.indexOf('# Project rules'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
