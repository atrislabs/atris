'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runIdeaTick } = require('../lib/idea-tick');
const { addIdea, readIdeas, updateIdea } = require('../lib/idea-inbox');
const { recordOutcome } = require('../lib/idea-ledger');

test('a closed loop idea stops suppressing its cause at exactly 24 hours', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-tick-day-boundary-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  const loopRepo = path.join(root, 'loop');
  const now = Date.parse('2025-03-09T12:00:00.000Z');
  const previous = new Date(now - 24 * 60 * 60 * 1000);
  const cause = 'engine could not start';
  const causeKey = 'build|engine could not start';
  const old = addIdea(loopRepo, 'make the idea loop handle slow builds', {
    tag: 'loop', causeKey, now: previous,
  });
  updateIdea(loopRepo, old.id, { status: 'landed' }, { now: previous });

  const idea = addIdea(repo, 'make search faster', {
    verify: 'node --test', now: new Date(now),
  });
  recordOutcome(repo, {
    idea, outcome: 'failed', stage: 'build', cause,
    finished: new Date(now - 1000).toISOString(),
  });
  const result = await runIdeaTick({
    root: repo,
    loopRepo,
    clock: () => now,
    log: () => {},
    runLap: async (_text, options) => {
      options.onResult({ status: 'stuck', reason: cause });
    },
    ship: () => assert.fail('a failed build must not ship'),
  });

  const followups = readIdeas(loopRepo).slice(1);
  assert.deepEqual(followups.map(({ text, at, tag, cause_key, status }) => ({
    text, at, tag, cause_key, status,
  })), [{
    text: 'make the idea loop handle "engine could not start" at the build stage (seen 2 times in 24h)',
    at: '2025-03-09T12:00:00.000Z',
    tag: 'loop',
    cause_key: causeKey,
    status: 'waiting',
  }]);
  assert.deepEqual(result, {
    status: 'refused', outcome: 'failed', stage: 'build', idea_id: idea.id,
    reason: 'the build did not pass: engine could not start',
    loop_idea: followups[0].id,
  });
});
