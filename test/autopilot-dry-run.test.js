'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

function makeTempWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-autopilot-dry-run-'));
  fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'atris', 'TODO.md'), '# TODO\n\n## Backlog\n(empty)\n');
  fs.writeFileSync(path.join(dir, 'atris', 'MAP.md'), '# MAP\n');
  fs.writeFileSync(path.join(dir, 'atris', 'PERSONA.md'), '# Persona\n');
  return dir;
}

function runCli(args, cwd) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 15000,
    env: {
      ...process.env,
      ATRIS_SKIP_UPDATE_CHECK: '1',
    },
  });
  if (result.error) throw result.error;
  return result;
}

function readWorkspaceFiles(dir) {
  const files = [];
  const visit = (current) => {
    for (const name of fs.readdirSync(current)) {
      const full = path.join(current, name);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) visit(full);
      else files.push(full);
    }
  };
  visit(dir);
  return files.map((file) => fs.readFileSync(file, 'utf8')).join('\n');
}

test('autopilot description dry-run uses preview language instead of committed inbox language', () => {
  const dir = makeTempWorkspace();
  try {
    const res = runCli([
      'autopilot',
      'dry run should not persist',
      '--dry-run',
      '--iterations=1',
      '--runner-bin',
      'echo',
    ], dir);

    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.match(res.stdout, /Dry run: I would add this request to the inbox\./);
    assert.match(res.stdout, /without writing that request/);
    assert.doesNotMatch(res.stdout, /I added this request to the inbox\./);
    assert.doesNotMatch(readWorkspaceFiles(dir), /dry run should not persist/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
