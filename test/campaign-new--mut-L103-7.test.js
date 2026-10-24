'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { draftAndStart } = require('../lib/campaign-new');
const memberEngine = require('../lib/member-engine');
const engineAsk = require('../lib/engine-ask');

test('drafting uses the owner engine and model instead of the default engine', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'campaign-owner-pick-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const jobsSeen = [];
  t.mock.method(memberEngine, 'resolveEngineForMember', (owner, workspace) => {
    assert.equal(owner, 'builder');
    assert.equal(workspace, root);
    return { engine: { id: 'codex' }, model: 'owner-model' };
  });
  t.mock.method(engineAsk, 'runEngineAskJobs', async (jobs) => {
    jobsSeen.push(...jobs.map(({ engine, model }) => ({ engine, model })));
    return [{ ok: true, stdout: JSON.stringify({
      title: 'Ship the feature', judge_script: 'exit 1', why: 'feature is missing', seats: [],
    }) }];
  });
  let output;
  const code = await draftAndStart(['--owner', 'builder', '--id', 'fixed-draft'], {
    asJson: true,
    judge: async () => ({ passed: false, exit: 1, summary: 'feature is missing' }),
    fail: (message) => assert.fail(message),
    out: (_human, json) => { output = json; },
  }, { root, goal: 'Ship the feature' });

  assert.equal(code, 0);
  assert.deepEqual(jobsSeen, [{ engine: 'codex', model: 'owner-model' }]);
  assert.equal(output.draft.engine, 'codex');
});
