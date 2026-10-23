'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { routerCommand, promotionCandidates } = require('../commands/router');

test('promotion adds a new signature when an unrelated override already exists', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-new-signature-'));
  const previousHome = process.env.HOME;
  const previousCwd = process.cwd();
  const previousExit = process.exit;
  const previousLog = console.log;
  try {
    process.env.HOME = dir;
    process.chdir(dir);
    process.exit = (code) => { throw new Error(`unexpected exit ${code}`); };
    console.log = () => {};
    const records = [];
    for (let index = 0; index < 3; index += 1) {
      records.push({
        at: '2099-01-01T00:00:00.000Z',
        pick_id: `miss-${index}`,
        lane: 'fast',
        message: `what is example ${index}`,
      });
      records.push({ event: 'outcome', pick_id: `miss-${index}`, ok: false, error: 'miss' });
    }
    const candidate = promotionCandidates(records)[0].override;
    const picksPath = path.join(dir, 'picks.jsonl');
    const goldPath = path.join(dir, 'gold.jsonl');
    const overridesPath = path.join(dir, 'overrides.json');
    fs.writeFileSync(picksPath, records.map(JSON.stringify).join('\n') + '\n');
    fs.writeFileSync(goldPath, JSON.stringify({ message: 'what is example', lane: 'pro' }) + '\n');
    fs.writeFileSync(overridesPath, JSON.stringify([
      { id: 'unrelated-saved-rule', test: { startsWith: 'draft this' }, lane: 'max', reason: 'saved preference' },
    ]));
    routerCommand(['promote', '--picks', picksPath, '--overrides', overridesPath, '--gold', goldPath], {
      env: { HOME: dir },
      output: () => {},
    });
    const saved = JSON.parse(fs.readFileSync(overridesPath, 'utf8'));
    assert.equal(saved.some((override) => override.id === candidate.id), true);
  } finally {
    console.log = previousLog;
    process.exit = previousExit;
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});
