'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { askOwner } = require('../lib/campaign-loop');
const memberEngine = require('../lib/member-engine');
const engineAsk = require('../lib/engine-ask');

// Both external boundaries are replaced before askOwner runs: no engine is
// launched and no member configuration is read from the host machine.
function fixture(t, pick, answers) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'campaign-ask-owner-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const resolve = t.mock.method(memberEngine, 'resolveEngineForMember', () => pick);
  const run = t.mock.method(engineAsk, 'runEngineAskJobs', async () => answers);
  return { root, resolve, run };
}

test('askOwner forwards the owner, prompt, engine and model and returns the answer', async (t) => {
  const { root, resolve, run } = fixture(t,
    { engine: { id: 'codex' }, model: 'chosen-model' },
    [{ stdout: '[{"objective":"check the result"}]\n', ok: true, stderr: 'ignored' }]);
  const view = { owner: 'planner', id: 'example' };
  const prompt = 'Propose one small mission.\nKeep the result checkable.';

  const result = await askOwner(root, view, prompt);

  assert.deepStrictEqual(result, {
    text: '[{"objective":"check the result"}]\n', engine: 'codex', ok: true,
  });
  assert.strictEqual(resolve.mock.callCount(), 1);
  assert.deepStrictEqual(resolve.mock.calls[0].arguments, ['planner', root]);
  assert.strictEqual(run.mock.callCount(), 1);
  assert.deepStrictEqual(run.mock.calls[0].arguments, [[{
    engine: 'codex', model: 'chosen-model', prompt, label: 'campaign example plan',
  }], { root, timeoutMs: 5 * 60 * 1000 }]);
});

test('askOwner defaults to claude and an empty model when no engine is selected', async (t) => {
  const { root, run } = fixture(t, null, []);

  assert.deepStrictEqual(await askOwner(root, { owner: 'planner', id: 'empty' }, ''), {
    text: '', engine: 'claude', ok: false,
  });
  assert.deepStrictEqual(run.mock.calls[0].arguments[0], [{
    engine: 'claude', model: '', prompt: '', label: 'campaign empty plan',
  }]);
});

test('askOwner preserves failed output and handles an answer without stdout or status', async (t) => {
  const { root, run } = fixture(t, { engine: { id: 'haiku' } }, [
    { stdout: 'partial plan', ok: false },
  ]);
  const view = { owner: 'planner', id: 'failure' };

  assert.deepStrictEqual(await askOwner(root, view, 'Plan next steps'), {
    text: 'partial plan', engine: 'haiku', ok: false,
  });
  run.mock.mockImplementation(async () => [{}]);
  assert.deepStrictEqual(await askOwner(root, view, 'Try again'), {
    text: '', engine: 'haiku', ok: false,
  });
});
