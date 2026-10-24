'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runRuntimeMissionLoop } = require('../lib/mission-runtime-loop');

test('a completed run displays its summary receipt as proof', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-summary-proof-'));
  const previousHome = process.env.HOME;
  process.env.HOME = root;
  try {
    const receipt = path.join(root, 'summary-receipt.json');
    fs.writeFileSync(receipt, JSON.stringify({ ok: true, mission_id: 'm-proof' }));
    const cliPath = path.join(root, 'fixture-cli.js');
    fs.writeFileSync(cliPath, `
const running = process.argv.includes('--max-ticks');
process.stdout.write(JSON.stringify({
  ok: true,
  mission: { id: 'm-proof', objective: 'Repair parser', status: running ? 'complete' : 'active', runner: 'atris2' },
  state_path: ${JSON.stringify(path.join(root, 'mission.json'))},
  summary_receipt: running ? ${JSON.stringify(receipt)} : undefined,
  ran_ticks: running ? 1 : 0,
  tick_count: running ? 1 : 0,
  ticks: running ? [{ summary: 'Repaired parser' }] : []
}));
`);
    const result = await runRuntimeMissionLoop(
      { objective: 'Repair parser', owner: 'mission-lead', maxTicks: 1, noRoomPreflight: true },
      { cliPath, cwd: root },
    );
    assert.ok(result.text.split('\n').some(line => line.includes('Proof:') && line.includes(receipt)));
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});
