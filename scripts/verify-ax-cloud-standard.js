#!/usr/bin/env node
'use strict';

// AX Context Standard verifier (2026-07-02, supersedes the Cloud-First
// Standard). The cloud lane is for chat and cloud workspaces; a
// workspace-shaped prompt asked from INSIDE a local workspace routes local so
// the cloud model gets workspace tools. Before this, resolveRoute never
// consulted workspaceIntent and `ax --fast` confabulated repo answers from the
// tool-less chat lane (SwapBench 2026-07-02: 1/6 vs 6/6 with tools). The old
// privacy guarantee is preserved where it matters: a non-workspace cwd NEVER
// exposes workspace_path, no matter what the prompt says.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ax = require('../ax');

const repoRoot = path.resolve(__dirname, '..');
const memberPath = path.join(repoRoot, 'atris', 'team', 'codex-executor', 'MEMBER.md');

// A guaranteed non-workspace cwd: a real temp dir with no .git/atris markers
// above it (assert that, so a stray /tmp/.git can't silently flip the gate).
const bareCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ax-context-standard-'));

const WORKSPACE_PROMPTS = [
  'what files are here?',
  'search src for the input component',
  'fix the xp game tests',
  'commit a tiny proof change and push to github',
  // Live misses 2026-07-02: a literal path / SCREAMING_SNAKE identifier /
  // launchd-lane phrasing routed cloud and the model answered tool-less.
  "in scripts/fast-coach/tick.mjs, what does SLOW_MS control and what's its value?",
  'which launchd lane runs fast-coach nightly and at what time?',
  'what does CLAUDE_TIMEOUT_MS default to?',
  // Live miss 2026-07-02 (Clowen's first prompt): recent-events phrasing —
  // the journal IS the workspace answer surface.
  'what did Atris ship last night? give me the highlights in plain words',
  'summarize the journal from yesterday',
];
// GitHub connector phrasing stays cloud even inside a workspace — only
// local-checkout wording (commit/branch/change) claims the local lane.
assert.equal(ax.resolveRoute('what github repos do I have?', { cwd: repoRoot }), 'cloud');
assert.equal(ax.resolveRoute('push something to github', { cwd: repoRoot }), 'cloud');
const CHAT_PROMPTS = [
  'write an essay about the product',
  'plan my morning',
  'what is the capital of france?',
  "what's 15% of 2400?",
  'is it an either/or decision — pick one for me',
];

// 1) Workspace standard v2: INSIDE a workspace even chat prompts route local —
// tools are always attached, the model decides whether to use them (the
// Claude Code shape; intent regexes lost three live rounds on 2026-07-02).
// From a bare cwd chat stays pure cloud with one turn and no workspace_path.
for (const message of CHAT_PROMPTS) {
  assert.equal(ax.resolveRoute(message, { cwd: repoRoot }), 'local', `chat prompt inside a workspace gets tools (${message})`);
  assert.equal(ax.resolveRoute(message, { cwd: bareCwd }), 'cloud', `chat prompt from a bare cwd stays cloud (${message})`);
  const payload = ax.buildPayload(message, { mode: 'fast', cwd: bareCwd });
  assert.equal(payload.model, 'atris:fast');
  assert.equal(payload.workspace_path, undefined, `${message} should not expose workspace_path from a bare cwd`);
  assert.equal(payload.max_turns, 1, `${message} should use one cloud turn from a bare cwd`);
}

// 2) Workspace prompts from a NON-workspace cwd stay cloud — the privacy line.
for (const message of WORKSPACE_PROMPTS) {
  assert.equal(ax.resolveRoute(message, { cwd: bareCwd }), 'cloud', `${message} from a bare cwd should stay cloud`);
  const payload = ax.buildPayload(message, { mode: 'fast', cwd: bareCwd });
  assert.equal(payload.workspace_path, undefined, `${message} must never expose workspace_path from a bare cwd`);
  assert.equal(payload.max_turns, 1);
}

// 3) Workspace prompts from INSIDE a workspace route local with tools.
for (const message of WORKSPACE_PROMPTS) {
  assert.equal(ax.resolveRoute(message, { cwd: repoRoot }), 'local', `${message} from a workspace should route local`);
}
const fastLocal = ax.buildPayload('what files are here?', { mode: 'fast', cwd: repoRoot });
assert.equal(fastLocal.workspace_path, repoRoot, 'local fast payload carries the checkout as workspace_path');
assert.equal(fastLocal.max_turns, 16, 'local fast turns get the tool loop');
const proLocal = ax.buildPayload('fix the xp game tests', { mode: 'pro', cwd: repoRoot });
assert.equal(proLocal.model, 'atris:pro');
assert.equal(proLocal.max_turns, 24, 'local pro turns get the deeper tool loop');

// 4) Explicit flags always win, both directions.
assert.equal(ax.resolveRoute('what files are here?', { route: 'cloud', cwd: repoRoot }), 'cloud');
assert.equal(ax.resolveRoute('what files are here?', { route: 'local', cwd: bareCwd }), 'local');
const forcedLocal = ax.buildPayload('what files are here?', { mode: 'fast', route: 'local', cwd: bareCwd });
assert.equal(forcedLocal.workspace_path, bareCwd);
assert.equal(forcedLocal.max_turns, 16);

// 5) Run profile from a bare cwd stays a cloud profile.
const cloudProfile = ax.buildRunProfile({ mode: 'fast', cwd: bareCwd });
assert.equal(cloudProfile.route, 'cloud');
assert.equal(cloudProfile.workspace_path, 'cloud');
assert.match(cloudProfile.runtime, /cloud/i);

// 6) The member contract names the standard and this verifier.
const member = fs.readFileSync(memberPath, 'utf8');
assert.match(member, /AX Context Standard/);
assert.match(member, /INSIDE a workspace/);
assert.match(member, /--local/);
assert.match(member, /--cloud/);
assert.match(member, /scripts\/verify-ax-cloud-standard\.js/);

console.log('AX Context Standard');
console.log('- inside a workspace every prompt gets tools (v2, Claude Code shape); bare-cwd chat stays pure cloud');
console.log('- workspace prompts from a bare cwd stay cloud (privacy line holds)');
console.log('- workspace prompts inside a workspace route local with tools (fast=8, pro=14 turns)');
console.log('- explicit --cloud/--local always win; run profile from bare cwd is cloud');
console.log('- codex-executor member contract names the standard and verifier');
