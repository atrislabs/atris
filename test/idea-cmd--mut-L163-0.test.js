'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ideaAtris } = require('../commands/idea');
const { addIdea, updateIdea } = require('../lib/idea-inbox');

test('the idea list prints the reason beneath a refused idea', (t) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-idea-refusal-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const idea = addIdea(repo, 'tidy the help text', {
    now: new Date('2020-01-01T00:00:00Z'),
  });
  updateIdea(repo, idea.id, {
    status: 'refused',
    reason: 'needs owner review',
  });

  const output = [];
  const code = ideaAtris([], {
    cwd: repo,
    log: (line) => output.push(line),
    keepDeps: {
      plan: { platform: 'linux', homeDir: repo },
      spawn: () => ({ status: 1, stdout: '' }),
    },
  });

  assert.equal(code, 0);
  assert.deepEqual(output, [
    `ideas in ${path.basename(repo)}: 1\n\n` +
    '  1. refused   tidy the help text\n' +
    '               needs owner review',
  ]);
});
