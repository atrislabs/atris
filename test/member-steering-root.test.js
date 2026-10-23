'use strict';

// Footgun (a), member steering read path: memberPaths().steeringJsonl pointed
// at <process.cwd()>/.atris/state/steering.jsonl, so a member run from a
// subdirectory read steering from a nonexistent nested .atris and silently got
// no steering signals. It must resolve the shared workspace root.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'commands', 'member.js'), 'utf8');

test('memberPaths resolves the workspace root for the steering store', () => {
  // steering.jsonl must be built from the resolved root, not raw process.cwd().
  assert.match(SRC, /steeringJsonl: path\.join\(workspaceRoot, '\.atris', 'state', 'steering\.jsonl'\)/);
  assert.doesNotMatch(SRC, /steeringJsonl: path\.join\(process\.cwd\(\), '\.atris', 'state', 'steering\.jsonl'\)/);
});
