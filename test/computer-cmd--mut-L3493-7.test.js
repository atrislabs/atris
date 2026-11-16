require('./helpers/clean-temp');
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

function chatHarness(temp) {
  const env = { ...process.env };
  const cwd = process.cwd();
  const log = console.log;
  const error = console.error;
  const exit = process.exit;
  const api = require('../utils/api');
  const request = api.apiRequestJson;
  const chats = [];
  const logs = [];
  const errors = [];
  return {
    chats, logs, errors,
    async run(argv) {
      try {
        process.env.HOME = temp;
        process.env.ATRIS_NO_INTERACTIVE = '1';
        process.chdir(temp);
        console.log = (...args) => logs.push(args.join(' '));
        console.error = (...args) => errors.push(args.join(' '));
        process.exit = (code) => { throw new Error(`unexpected exit ${code}`); };
        api.apiRequestJson = async (pathname, options = {}) => {
          if (pathname === '/business/') return { ok: true, status: 200, data: [{ id: 'biz-1', slug: 'acme', name: 'Acme', workspace_id: 'ws-1' }] };
          if (pathname.endsWith('/workspaces')) return { ok: true, status: 200, data: [{ id: 'ws-1', name: 'Main', status: 'active', is_default: true }] };
          if (pathname.endsWith('/ai-computer/status')) return { ok: true, status: 200, data: { status: 'running', endpoint: 'https://runner.example', attached_workspace_id: 'ws-1' } };
          if (pathname.endsWith('/chat')) {
            chats.push(options.body);
            return { ok: true, status: 200, data: { execution_id: 'exec-1', session_id: 's-1' } };
          }
          if (pathname.includes('/chat/events?')) return { ok: true, status: 200, data: { status: 'completed', events: [{ type: 'assistant_text', content: 'reply' }, { type: 'complete' }] } };
          throw new Error(`unexpected request ${pathname}`);
        };
        const { runComputer } = require('../commands/computer');
        await runComputer(argv, temp);
      } finally {
        api.apiRequestJson = request;
        console.log = log;
        console.error = error;
        process.exit = exit;
        process.chdir(cwd);
        for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
        Object.assign(process.env, env);
      }
    },
  };
}

function chatTemp() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-chat-as-'));
  fs.mkdirSync(path.join(temp, '.atris'), { recursive: true });
  fs.writeFileSync(path.join(temp, '.atris', 'credentials.json'), JSON.stringify({
    token: 'test-token', provider: 'test', saved_at: '2026-01-01T00:00:00.000Z',
  }));
  const dir = path.join(temp, 'atris', 'team', 'scout');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'MEMBER.md'), 'scout identity');
  fs.writeFileSync(path.join(dir, 'SOUL.md'), 'scout soul');
  return temp;
}

test('chat --as sends the member brief inside the one-shot message', async () => {
  const temp = chatTemp();
  const h = chatHarness(temp);
  await h.run(['chat', '--business', 'acme', '--workspace', 'ws-1', '--message', 'do x', '--as', 'scout']);
  const { buildMemberBrief, withMemberBrief } = require('../lib/member-brief');
  const brief = buildMemberBrief(temp, 'scout');
  assert.equal(brief.ok, true);
  assert.equal(h.chats.length, 1);
  assert.equal(h.chats[0].message, withMemberBrief(brief.text, 'do x'));
  assert.ok(h.logs.includes('Working as scout (2 files loaded).'));
});

test('chat --as without --message exits 1 and sends nothing; plain --message is unchanged', async () => {
  const temp = chatTemp();
  const h = chatHarness(temp);
  const before = process.exitCode;
  await h.run(['chat', '--business', 'acme', '--workspace', 'ws-1', '--as', 'scout']);
  assert.equal(process.exitCode, 1);
  process.exitCode = before;
  assert.equal(h.chats.length, 0);
  assert.ok(h.errors.some((l) => l.includes('--as works with --message "<job>".')));

  await h.run(['chat', '--business', 'acme', '--workspace', 'ws-1', '--message', 'do x']);
  assert.equal(h.chats.length, 1);
  assert.equal(h.chats[0].message, 'do x');
});
