#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ax = require('../ax');

const repoRoot = path.resolve(__dirname, '..');
const memberPath = path.join(repoRoot, 'atris', 'team', 'codex-executor', 'MEMBER.md');

function assertCloudPrompt(message) {
  assert.equal(ax.resolveRoute(message), 'cloud', `${message} should default to cloud`);
  const payload = ax.buildPayload(message, {
    mode: 'fast',
    cwd: '/tmp/ax-cloud-standard',
  });
  assert.equal(payload.model, 'atris:fast');
  assert.equal(payload.workspace_path, undefined, `${message} should not expose local workspace_path by default`);
  assert.equal(payload.max_turns, 1, `${message} should use one cloud turn by default`);
}

for (const message of [
  'write an essay about the product',
  'what files are here?',
  'search src for the input component',
  'fix the xp game tests',
  'push something to github',
]) {
  assertCloudPrompt(message);
}

const localPayload = ax.buildPayload('what files are here?', {
  mode: 'fast',
  route: 'local',
  cwd: '/tmp/ax-cloud-standard',
});
assert.equal(ax.resolveRoute('what files are here?', { route: 'local' }), 'local');
assert.equal(localPayload.workspace_path, '/tmp/ax-cloud-standard');
assert.equal(localPayload.max_turns, 8);

const cloudProfile = ax.buildRunProfile({
  mode: 'fast',
  cwd: '/tmp/ax-cloud-standard',
});
assert.equal(cloudProfile.route, 'cloud');
assert.equal(cloudProfile.workspace_path, 'cloud');
assert.match(cloudProfile.runtime, /cloud/i);

const member = fs.readFileSync(memberPath, 'utf8');
assert.match(member, /AX Cloud-First Standard/);
assert.match(member, /default route is cloud/i);
assert.match(member, /--local/);
assert.match(member, /scripts\/verify-ax-cloud-standard\.js/);

console.log('AX Cloud-First Standard');
console.log('- default prose/workspace/code prompts route to cloud');
console.log('- cloud payloads avoid local workspace_path and run one cloud turn');
console.log('- explicit --local keeps local workspace behavior available');
console.log('- codex-executor member contract names the standard and verifier');
