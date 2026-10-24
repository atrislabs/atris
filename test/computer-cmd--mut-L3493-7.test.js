const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');

test('chat carries the returned session into the next prompt', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-session-'));
  const env = { ...process.env };
  const cwd = process.cwd();
  const stdin = Object.getOwnPropertyDescriptor(process, 'stdin');
  const log = console.log;
  const exit = process.exit;
  const api = require('../utils/api');
  const request = api.apiRequestJson;
  const sessions = [];
  try {
    process.env.HOME = temp;
    process.env.ATRIS_NO_INTERACTIVE = '1';
    process.chdir(temp);
    fs.mkdirSync(path.join(temp, '.atris'));
    fs.writeFileSync(path.join(temp, '.atris', 'credentials.json'), JSON.stringify({
      token: 'test-token', provider: 'test', saved_at: '2026-01-01T00:00:00.000Z',
    }));
    Object.defineProperty(process, 'stdin', { configurable: true, value: Readable.from(['first prompt\nsecond prompt\n/exit\n']) });
    console.log = () => {};
    process.exit = code => { throw new Error(`unexpected exit ${code}`); };
    api.apiRequestJson = async (pathname, options = {}) => {
      if (pathname === '/business/') return { ok: true, status: 200, data: [{ id: 'biz-1', slug: 'acme', name: 'Acme', workspace_id: 'ws-1' }] };
      if (pathname.endsWith('/workspaces')) return { ok: true, status: 200, data: [{ id: 'ws-1', name: 'Main', status: 'active', is_default: true }] };
      if (pathname.endsWith('/ai-computer/status')) return { ok: true, status: 200, data: { status: 'running', endpoint: 'https://runner.example', attached_workspace_id: 'ws-1' } };
      if (pathname.endsWith('/chat')) {
        sessions.push(options.body.session_id);
        return { ok: true, status: 200, data: { execution_id: 'exec-1', session_id: 'returned-session' } };
      }
      if (pathname.includes('/chat/events?')) return { ok: true, status: 200, data: { status: 'completed', events: [{ type: 'assistant_text', content: 'reply' }, { type: 'complete' }] } };
      throw new Error(`unexpected request ${pathname}`);
    };
    const { runComputer } = require('../commands/computer');
    await runComputer(['chat', '--business', 'acme', '--workspace', 'ws-1'], temp);
    assert.strictEqual(sessions[1], 'returned-session');
  } finally {
    api.apiRequestJson = request;
    console.log = log;
    process.exit = exit;
    Object.defineProperty(process, 'stdin', stdin);
    process.chdir(cwd);
    for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
    Object.assign(process.env, env);
  }
});
