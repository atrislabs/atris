'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { draftAndStart } = require('../lib/campaign-new');

test('drafting preserves an explicit campaign id in its output', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'campaign-explicit-id-'));
  try {
    let output;
    const code = await draftAndStart(['--id', 'chosen-campaign'], {
      asJson: true,
      judge: async () => ({ passed: false, exit: 1, summary: 'not ready' }),
      out: (_human, json) => { output = json; },
      fail: (message) => assert.fail(message),
    }, {
      root,
      goal: 'ship the feature',
      ask: async () => ({
        engine: 'test',
        text: JSON.stringify({ title: 'Ship feature', judge_script: 'exit 1', seats: [] }),
      }),
    });

    assert.equal(code, 0);
    assert.equal(output.draft.id, 'chosen-campaign');
    assert.equal(output.draft.judge_file, 'atris/campaigns/chosen-campaign/judge.sh');
    assert.equal(output.draft.judge, 'sh atris/campaigns/chosen-campaign/judge.sh');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
