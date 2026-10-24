'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runRuntimeMissionLoop } = require('../lib/mission-runtime-loop');

test('worker receipt supplies the displayed work when a summary also exists', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-worker-receipt-'));
  const previousHome = process.env.HOME;
  process.env.HOME = root;
  try {
    const cliPath = path.join(root, 'fixture-cli.js');
    fs.writeFileSync(cliPath, `
const running = process.argv.includes('--max-ticks');
process.stdout.write(JSON.stringify({
  ok: true,
  mission: { id: 'm-receipt', objective: 'Repair parser', status: running ? 'complete' : 'active', runner: 'claude' },
  ran_ticks: running ? 1 : 0,
  tick_count: running ? 1 : 0,
  ticks: running ? [{ summary: 'Worker completed its assignment', claude: { receipt_text: 'Repaired quoted argument parsing' } }] : []
}));
`);
    const result = await runRuntimeMissionLoop(
      { objective: 'Repair parser', owner: 'mission-lead', maxTicks: 1, noRoomPreflight: true },
      { cliPath, cwd: root },
    );
    assert.match(result.text, /Work: Repaired quoted argument parsing/);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});
