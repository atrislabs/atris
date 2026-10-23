'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const rsiCmd = require('../commands/rsi');

test('a nothing outcome is counted as nothing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rsi-cmd-mut-L44-0-'));
  try {
    const state = path.join(dir, '.atris', 'state', 'rsi');
    fs.mkdirSync(state, { recursive: true });
    const row = {
      schema: 'atris.rsi.node.v1',
      id: 'n_quiet',
      tree_id: 'x-2020-01-02',
      parent_id: null,
      created_at: '2020-01-02T12:00:00Z',
      lane: 'improve_tick',
      context: {},
      action: {
        policy_id: 'p-0009',
        kind: 'open',
        ground: '',
        engine: 'claude',
        cap_s: 1800,
        prompt_variant: 'v1',
      },
      outcome: {
        status: 'nothing',
        verify: 'skipped',
        commits: 0,
        files: [],
        reason: 'quiet',
        elapsed_s: 12.5,
        engine_calls: 1,
      },
      split: 'train',
    };
    fs.writeFileSync(path.join(state, 'attempts.jsonl'), JSON.stringify(row) + '\n');

    const status = rsiCmd.collectStatus(dir);
    const lane = status.lanes.get('improve_tick');
    assert.equal(lane.nothing, 1);
    assert.equal(lane.shipped, 0);
    assert.equal(lane.failed, 0);
    assert.equal(lane.open, 0);
    assert.equal(lane.nodes, 1);

    const laneLine = rsiCmd.formatStatus(status).split('\n').find((line) => line.includes('improve_tick:'));
    assert.equal(laneLine, '    improve_tick: 1 tree, 1 attempt (1 nothing)');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
