'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('a refused build keeps its saved task reference out of the active task line', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-idea-task-line-'));
  const previousHome = process.env.HOME;
  const previousCwd = process.cwd();
  process.env.HOME = root;
  process.chdir(root);

  try {
    const { ideaAtris } = require('../commands/idea');
    const { addIdea, updateIdea } = require('../lib/idea-inbox');
    const now = new Date('2026-01-15T12:00:00Z');
    const idea = addIdea(root, 'shorten the help text', { now });
    updateIdea(root, idea.id, { status: 'building', task_id: 'T-42' }, { now });
    updateIdea(root, idea.id, {
      status: 'refused',
      reason: 'the change touches database migrations, needs owner',
    }, { now });

    const lines = [];
    ideaAtris([], {
      cwd: root,
      log: (line) => lines.push(line),
      keepDeps: {
        spawn: () => ({ status: 1, stdout: '', stderr: '' }),
        plan: { platform: 'linux', homeDir: root },
      },
    });

    const output = lines.join('\n');
    assert.match(output, /refused\s+shorten the help text/);
    assert.doesNotMatch(output, /\btask\s+T-42\b/);
  } finally {
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});
