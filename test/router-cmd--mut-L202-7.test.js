'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { routerCommand } = require('../commands/router');

test('promotion reports a sealed evaluation failure even when spawning succeeded', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-exit-failure-'));
  try {
    const picks = path.join(dir, 'picks.jsonl');
    const overrides = path.join(dir, 'overrides.json');
    const gold = path.join(dir, 'gold.jsonl');
    const records = [];
    for (let index = 0; index < 3; index += 1) {
      records.push({ pick_id: `pick-${index}`, lane: 'fast', message: 'what is alpha' });
      records.push({ event: 'outcome', pick_id: `pick-${index}`, ok: false });
    }
    fs.writeFileSync(picks, records.map((row) => JSON.stringify(row)).join('\n') + '\n');
    fs.writeFileSync(overrides, '[]\n');
    fs.writeFileSync(gold, '{"message":"what is alpha","lane":"fast"}\n');

    let calls = 0;
    assert.throws(() => routerCommand([
      'promote', '--dry-run', '--picks', picks, '--overrides', overrides, '--gold', gold,
    ], {
      env: { HOME: dir },
      output: () => {},
      // A child can emit valid JSON and still exit unsuccessfully.
      spawnSync: () => ({
        status: calls++ === 0 ? 1 : 0,
        stdout: '{"weighted_error_rate":0,"weighted_accuracy":1}\n',
        stderr: 'sealed evaluation rejected the input\n',
      }),
    }), { name: 'Error', message: 'sealed evaluation rejected the input' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
