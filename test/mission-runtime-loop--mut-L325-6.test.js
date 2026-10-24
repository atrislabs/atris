'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runRuntimeMissionLoop } = require('../lib/mission-runtime-loop');

test('no-complete keeps a mission open even with a successful tick and receipt', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-no-complete-'));
  const savedHome = process.env.HOME;
  process.env.HOME = root;
  try {
    const cliPath = path.join(root, 'cli-fixture.js');
    const proof = path.join(root, 'receipt.md');
    fs.writeFileSync(proof, 'Updated the parser and checked its output.\n');
    fs.writeFileSync(cliPath, `
const args = process.argv.slice(2);
const mission = { id: 'parser-fix', objective: 'Fix the parser', status: 'active', runner: 'atris2' };
let payload;
if (args[1] === 'complete') {
  payload = { ok: true, action: 'mission_completed', mission: { ...mission, status: 'complete', proof: ${JSON.stringify(proof)} } };
} else if (args.includes('--max-ticks')) {
  payload = { ok: true, mission, ran_ticks: 1, tick_count: 1, summary_receipt: ${JSON.stringify(proof)} };
} else {
  payload = { ok: true, mission };
}
process.stdout.write(JSON.stringify(payload));
`);
    const result = await runRuntimeMissionLoop(
      { objective: 'Fix the parser', noComplete: true, maxTicks: 1 },
      { cliPath, cwd: root },
    );
    assert.equal(result.achieved, false);
    assert.equal(result.complete, undefined);
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
