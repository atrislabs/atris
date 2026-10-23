'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildAgentRows } = require('../commands/agents');

test('agent rows preserve the team folder display name instead of its normalized slug', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-agents-display-name-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'atris', 'team', 'Release Captain'), { recursive: true });

  assert.deepEqual(buildAgentRows(root), [
    { owner: 'Release Captain', state: 'idle', label: null },
  ]);
});
