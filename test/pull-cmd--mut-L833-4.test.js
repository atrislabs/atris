'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('a pull with no deletions omits a deletion count', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-pull-zero-'));
  const savedEnv = { ...process.env };
  const cwd = process.cwd();
  const argv = process.argv;
  const log = console.log;
  const exit = process.exit;
  const api = require('../utils/api');
  const request = api.apiRequestJson;
  const lines = [];
  try {
    process.env.HOME = home;
    process.env.TERM_SESSION_ID = 'pull-zero-test';
    process.chdir(home);
    process.argv = ['node', 'atris', 'pull', 'example-co'];
    fs.mkdirSync(path.join(home, '.atris'), { recursive: true });
    fs.writeFileSync(path.join(home, '.atris', 'business.json'), JSON.stringify({ slug: 'example-co' }));
    fs.writeFileSync(path.join(home, '.atris', 'credentials.json'), JSON.stringify({ token: 'test-token', refresh_token: null, email: 'reader@example.test', user_id: 'reader', provider: 'google', saved_at: '2026-01-15T12:00:00Z' }));
    api.apiRequestJson = async (endpoint) => {
      if (endpoint === '/business/') return { ok: true, status: 200, data: [{ id: 'biz-1', slug: 'example-co', name: 'Example', workspace_id: 'ws-1' }] };
      if (endpoint.endsWith('/snapshot?include_content=true')) return { ok: true, status: 200, data: { files: [{ path: 'atris/wiki/note.md', content: 'Remote note\n' }] } };
      return { ok: false, status: 404, error: 'not found' };
    };
    console.log = (...args) => lines.push(args.join(' '));
    process.exit = (code) => { throw new Error(`exit ${code}: ${lines.join('\n')}`); };
    await require('../commands/pull').pullAtris();
    assert.match(lines.join('\n'), /\b1\s+pulled\b/);
    assert.doesNotMatch(lines.join('\n'), /\b0\s+deleted\b/);
  } finally {
    api.apiRequestJson = request;
    console.log = log;
    process.exit = exit;
    process.argv = argv;
    process.chdir(cwd);
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
  }
});
