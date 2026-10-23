'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { draftAndStart } = require('../lib/campaign-new');
const memberEngine = require('../lib/member-engine');
const engineAsk = require('../lib/engine-ask');

test('draftAndStart uses the engine stdout as the judge draft', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'campaign-new-mut-L106-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'atris', 'team', 'builder'), { recursive: true });
  fs.writeFileSync(path.join(root, 'atris', 'team', 'builder', 'MEMBER.md'), '# builder\n');

  const script = 'echo no\nexit 1';
  const stdout = JSON.stringify({
    title: 'Ship the gate',
    judge_script: script,
    why: 'counts the gate',
    seats: ['builder'],
  });
  t.mock.method(memberEngine, 'resolveEngineForMember', () => ({ engine: { id: 'codex' }, model: 'chosen-model' }));
  t.mock.method(engineAsk, 'runEngineAskJobs', async () => [{ stdout, ok: true }]);

  const reading = { passed: false, exit: 1, summary: 'pass 0, fail 1' };
  const lines = [];
  const code = await draftAndStart(
    ['new', '--id', 'cmp-gate', '--owner', 'builder', '--budget', '4'],
    {
      asJson: true,
      judge: async () => reading,
      out: (_human, json) => lines.push(json),
      fail: (message, status = 2) => {
        lines.push({ ok: false, error: message });
        return status;
      },
    },
    { goal: 'make the gate hold', root },
  );

  const judge = 'sh atris/campaigns/cmp-gate/judge.sh';
  assert.equal(code, 0);
  assert.deepEqual(lines, [{
    ok: true,
    action: 'campaign_drafted',
    draft: {
      id: 'cmp-gate',
      title: 'Ship the gate',
      judge,
      judge_file: 'atris/campaigns/cmp-gate/judge.sh',
      why: 'counts the gate',
      seats: ['builder'],
      owner: 'builder',
      budget: 4,
      engine: 'codex',
    },
    reading,
    start_command: `atris campaign start 'Ship the gate' --judge '${judge}' --budget 4 --id cmp-gate --owner builder --seat builder`,
  }]);
  assert.equal(
    fs.readFileSync(path.join(root, 'atris', 'campaigns', 'cmp-gate', 'judge.sh'), 'utf8'),
    `#!/bin/sh\n${script}\n`,
  );
});
