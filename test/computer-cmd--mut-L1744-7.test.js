const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('computer lane prefers the exact saved key over an earlier slug match', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-computer-cache-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  t.mock.method(os, 'homedir', () => home);
  const savedEnv = { ...process.env };
  for (const key of Object.keys(process.env)) delete process.env[key];
  process.env.HOME = home;
  process.env.ATRIS_TEST_STATE_DIR = home;
  t.after(() => {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, savedEnv);
  });
  const state = path.join(home, '.atris');
  fs.mkdirSync(state);
  fs.writeFileSync(path.join(state, 'credentials.json'), JSON.stringify({ token: 'test-token' }));
  fs.writeFileSync(path.join(state, 'businesses.json'), JSON.stringify({
    earlier: {
      slug: 'selected',
      business_id: 'business-earlier',
      workspace_id: 'workspace-earlier',
      worker: 'claude',
    },
    selected: {
      slug: 'canonical-selected',
      business_id: 'business-selected',
      workspace_id: 'workspace-selected',
      worker: 'openai',
    },
  }));

  const { runComputer } = require('../commands/computer');
  const output = [];
  t.mock.method(console, 'log', (...args) => output.push(args.join(' ')));
  await runComputer(['lane', '--business', 'selected']);
  assert.deepEqual(output, [
    '  Saved lane for selected: OpenAI',
    '  Set one: atris computer lane <claude|openai> --business selected',
  ]);
});
