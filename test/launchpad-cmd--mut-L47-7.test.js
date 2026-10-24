'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { launchpadCommand } = require('../commands/launchpad');

test('a Claude session marker selects Claude as the default owner', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-owner-'));
  const cwd = process.cwd();
  const env = { ...process.env };
  const log = console.log;
  const lines = [];
  try {
    for (const key of Object.keys(process.env)) {
      if (/^(ATRIS_|CODEX_|CLAUDE|CURSOR|DEVIN)/.test(key)) delete process.env[key];
    }
    process.env.HOME = root;
    delete process.env.CLAUDE_CODE_ENTRYPOINT;
    delete process.env.ATRIS_AGENT;
    delete process.env.ATRIS_MEMBER;
    process.env.CLAUDECODE = '1';
    fs.mkdirSync(path.join(root, 'atris'));
    const state = path.join(root, '.atris', 'state');
    fs.mkdirSync(state, { recursive: true });
    fs.writeFileSync(path.join(state, 'tasks.projection.json'), JSON.stringify({
      tasks: [{ id: 'pending-task', title: 'Check owner selection', status: 'open' }],
    }));
    process.chdir(root);
    console.log = (...values) => lines.push(values.join(' '));
    launchpadCommand(['--json']);
    const payload = JSON.parse(lines.join('\n'));
    assert.match(payload.next_action.command, /--as claude(?:\s|$)/);
  } finally {
    console.log = log;
    process.chdir(cwd);
    for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
    Object.assign(process.env, env);
  }
});
