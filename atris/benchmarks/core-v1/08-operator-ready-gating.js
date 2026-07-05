'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');

module.exports = {
  id: 'operator-ready-gating',
  title: 'Operator-ready gate accepts plain why and rejects agent jargon',
  timeoutMs: 10000,
  async run(ctx) {
    const { operatorReady, clarify } = require(path.join(ctx.repoRoot, 'lib', 'autoland.js'));
    assert.equal(operatorReady('Slow boot makes every demo start with an apology: cache the workspace scan'), true);
    assert.equal(operatorReady('Add --inspect flag so users save time'), false);
    assert.equal(operatorReady('Make codex_goal slot handoff faster for users'), false);
    const cleaned = clarify('CLI-844 add --inspect flag so agent_state parsers stop burning tokens');
    assert.ok(!/CLI-\d+/.test(cleaned));
    assert.ok(!/--[a-z]/.test(cleaned));
    assert.ok(!/[a-z]_[a-z]/.test(cleaned));
  },
};
