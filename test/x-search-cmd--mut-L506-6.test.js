'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { xSearchCommand } = require('../commands/x-search');

test('saving a second brief does not insert a blank line before its journal entry', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-brief-append-'));
  const previousHome = process.env.HOME;
  const previousCwd = process.cwd();
  const previousExit = process.exit;
  const previousLog = console.log;
  process.env.HOME = cwd;
  process.chdir(cwd);
  process.exit = (code) => { throw new Error(`unexpected exit: ${code}`); };
  console.log = () => {};
  try {
    fs.mkdirSync(path.join(cwd, 'atris', 'wiki'), { recursive: true });
    const options = {
      cwd,
      applyNow: '2026-08-26',
      output: () => {},
      ensureValidCredentials: async () => ({ credentials: {
        token: 'fixture-token',
        agent_token: 'fixture-token',
        agent_token_scopes: ['x-search', 'youtube'],
        agent_token_expires_at: '2099-01-01T00:00:00Z',
      } }),
      apiRequestJson: async () => ({
        ok: true,
        status: 200,
        data: {
          status: 'success',
          credits_used: 5,
          credits_remaining: 995,
          data: {
            content: '37signals has 80 people and uses the omakase model',
            citations: [],
          },
        },
      }),
    };
    await xSearchCommand(['first brief', '--save'], options);
    const journal = path.join(cwd, 'atris', 'logs', '2026', '2026-08-26.md');
    const before = fs.readFileSync(journal, 'utf8');
    await xSearchCommand(['second brief', '--save'], options);
    const appended = fs.readFileSync(journal, 'utf8').slice(before.length);
    assert.equal(appended[0], '-');
  } finally {
    console.log = previousLog;
    process.exit = previousExit;
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});
