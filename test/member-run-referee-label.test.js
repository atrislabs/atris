'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { scrubAgentEnv } = require('./helpers/agent-env');

const cliPath = path.resolve(__dirname, '..', 'bin', 'atris.js');

// Live repro: the engine made a clean commit, `git diff --check` exited 0, the
// second-model referee said FAIL, and the tick blamed diff cleanliness.
test('member run names the failing referee, not the passing diff check', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-referee-label-'));
  const root = path.join(base, 'repo');
  const binDir = path.join(base, 'bin');
  try {
    fs.mkdirSync(path.join(root, 'atris', 'team', 'executor'), { recursive: true });
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(root, 'atris', 'team', 'executor', 'MEMBER.md'), '---\nname: executor\nrole: Test Member\n---\n\n# executor\n', 'utf8');
    const fakeCodex = path.join(binDir, 'codex');
    fs.writeFileSync(fakeCodex, [
      '#!/bin/sh',
      'echo "clean line" >> work.txt',
      'git add work.txt >/dev/null 2>&1 && git commit -qm "clean one-line change" >/dev/null 2>&1',
      'echo "VERDICT: FAIL"',
      '',
    ].join('\n'), 'utf8');
    fs.chmodSync(fakeCodex, 0o755);

    const git = (args) => {
      const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr || r.stdout);
    };
    git(['init', '-q']);
    git(['config', 'user.email', 'test@example.com']);
    git(['config', 'user.name', 'Test User']);
    git(['add', '.']);
    git(['commit', '-qm', 'baseline']);

    const res = spawnSync(process.execPath, [
      cliPath, 'member', 'run', 'executor', 'Append a clean line to work.txt',
      '--engine', 'codex', '--referee', '--referee-engine', 'codex',
      '--ignite', '--verify', 'git diff --check',
    ], {
      cwd: root,
      encoding: 'utf8',
      timeout: 60000,
      env: {
        ...scrubAgentEnv(),
        ATRIS_SKIP_UPDATE_CHECK: '1',
        PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}`,
      },
    });
    const out = `${res.stdout}\n${res.stderr}`;
    assert.match(out, /verifier=fail/, out);
    assert.doesNotMatch(out, /diff cleanliness check failed/i, out);
    assert.match(out, /engine verify pass did not end with VERDICT: PASS/, out);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
