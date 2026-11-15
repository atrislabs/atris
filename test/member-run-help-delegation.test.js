'use strict';

// `atris member run --help` tells a person how to delegate: which checkout
// the work uses, how to pick Claude Opus, what happens to commits and
// landing, and where to watch progress. It only prints help, so it starts
// nothing. Each line pinned here names a real flag, env var, or file the
// code reads.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { execFileSync } = require('child_process');

const ATRIS_BIN = path.join(__dirname, '..', 'bin', 'atris.js');

test('member run --help says where work goes, how to pick Opus, and what lands', () => {
  const out = execFileSync(process.execPath, [ATRIS_BIN, 'member', 'run', '--help'], {
    encoding: 'utf8',
    cwd: path.join(__dirname, '..'),
  });
  assert.match(out, /where work goes: in its own checkout and branch by default in a git repo\. --shared-checkout works in this folder\./);
  assert.match(out, /a job that says do not commit stays in this folder too\./);
  assert.match(out, /choose Claude Opus: add --engine claude --model "opus 5\.5" --ignite\./);
  assert.match(out, /ATRIS_CLAUDE_SPEND_OK=claude-opus-5-5 atris member run growth/);
  assert.match(out, /without that yes, the run falls back to Haiku\./);
  assert.match(out, /commit: a run in its own checkout whose check passes saves its leftover work as a commit on its branch\./);
  assert.match(out, /a run in this folder \(--shared-checkout\) or a job that says do not commit is not saved this way\./);
  assert.match(out, /land: work merges only if self-landing is on \(\.atris\/policy\/autoland\.json with "enabled": true\)\./);
  assert.match(out, /otherwise the branch waits for you\./);
  assert.match(out, /progress: --ignite prints where to watch\. atris member board --watch/);
  assert.match(out, /tail -f ~\/\.atris\/progress\/<name>\.log/);
  assert.match(out, /atris member stop <name>/);
  assert.doesNotMatch(out, /\u2014/, 'no em dashes in the help');
});
