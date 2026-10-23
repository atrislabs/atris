'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runIdeaTick } = require('../lib/idea-tick');
const { addIdea, readIdeas } = require('../lib/idea-inbox');
const { recordOutcome } = require('../lib/idea-ledger');

test('a repeated build failure reports when its loop idea is also refused', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-tick-refused-loop-'));
  const now = Date.parse('2024-01-15T12:00:00.000Z');
  const logs = [];
  try {
    const idea = addIdea(root, 'make search faster', {
      verify: 'node --test',
      now: new Date(now),
    });
    recordOutcome(root, {
      idea,
      outcome: 'failed',
      stage: 'build',
      cause: 'auth unavailable',
      finished: new Date(now - 1000).toISOString(),
    });

    const result = await runIdeaTick({
      root,
      clock: () => now,
      lockOptions: { now },
      log: (line) => logs.push(line),
      runLap: async (_text, options) => {
        options.onResult({ status: 'stuck', reason: 'auth unavailable' });
      },
    });

    const loopIdea = readIdeas(root).find((row) => row.tag === 'loop');
    assert.equal(result.status, 'refused');
    assert.ok(loopIdea);
    assert.equal(result.loop_idea, loopIdea.id);
    assert.equal(loopIdea.status, 'refused');
    assert.equal(logs.at(-1), '  loop idea 2 is refused too: touches auth ("auth"), needs owner');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
