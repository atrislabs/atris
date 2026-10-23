'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { draftAndStart } = require('../lib/campaign-new');

test('the drafted campaign reports the owner selected engine exactly', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'campaign-new-engine-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  t.mock.method(require('../lib/member-engine'), 'resolveEngineForMember', () => ({
    engine: { id: 'codex' },
    model: '',
  }));
  t.mock.method(require('../lib/engine-ask'), 'runEngineAskJobs', async () => [{
    ok: true,
    stdout: JSON.stringify({ title: 'Local check', judge_script: 'exit 1', seats: [] }),
  }]);

  let output;
  const code = await draftAndStart(['--id', 'engine-check'], {
    asJson: true,
    judge: async () => ({ passed: false, exit: 1, summary: 'exit 1' }),
    out: (_human, json) => { output = json; },
    fail: (message) => assert.fail(message),
  }, { root, goal: 'Check the selected engine' });

  assert.equal(code, 0);
  assert.equal(output.action, 'campaign_drafted');
  assert.equal(output.draft.engine, 'codex');
});
