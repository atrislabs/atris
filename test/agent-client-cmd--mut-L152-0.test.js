'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { agentClientCommand } = require('../commands/agent-client');

function deps() {
  return {
    log() {},
    err() {},
    readActiveCredentials() { return null; },
    ensureValidCredentials: async () => {
      throw new Error('login must not run');
    },
    apiRequestJson: async () => {
      throw new Error('api must not run');
    },
  };
}

test('missing arguments exit 1 and an explicit help request exits 0', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-client-cmd-mut-L152-'));
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    assert.equal(await agentClientCommand([], deps()), 1);
    assert.equal(await agentClientCommand(['--help'], deps()), 0);
  } finally {
    process.chdir(cwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
