'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { skillEvalCommand } = require('../commands/skill-eval');

test('a missing skill without git history reports the unreadable skill', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-history-'));
  const originalLog = console.log;
  const output = [];
  try {
    const initialized = spawnSync('git', ['init', '--quiet', root], {
      encoding: 'utf8',
      env: {},
    });
    assert.equal(initialized.status, 0, initialized.stderr);
    console.log = (line) => output.push(line);

    const status = skillEvalCommand(['skills/missing/SKILL.md', '--json'], {
      root,
      env: {},
      getEngineAdapter() {
        throw new Error('review must not start for a missing skill without history');
      },
      fs: {
        mkdtempSync() {
          const directory = path.join(root, 'review');
          fs.mkdirSync(directory);
          return directory;
        },
        rmSync: fs.rmSync,
      },
    });

    assert.deepEqual(output, [
      '{"ok":false,"error":"could not read skills/missing/SKILL.md"}',
    ]);
    assert.equal(status, 2);
  } finally {
    console.log = originalLog;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
