require('./helpers/clean-temp');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('force push reports the server rejection for an individual document', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'align-results-'));
  const previous = { home: process.env.HOME, cwd: process.cwd(), argv: process.argv, exit: process.exit, log: console.log, error: console.error };
  const api = require('../utils/api');
  const request = api.apiRequestJson;
  const logs = [];
  const exited = Symbol('exit');
  try {
    process.env.HOME = home;
    process.chdir(home);
    fs.mkdirSync(path.join(home, '.atris'), { recursive: true });
    fs.mkdirSync(path.join(home, 'atris'), { recursive: true });
    fs.writeFileSync(path.join(home, 'atris', 'cloud-note.md'), 'cloud document sentinel');
    fs.writeFileSync(path.join(home, '.atris', 'business.json'), JSON.stringify({ slug: 'example-co' }));
    fs.writeFileSync(path.join(home, '.atris', 'credentials.json'), JSON.stringify({ token: 'test-token', saved_at: '2025-01-01T00:00:00.000Z' }));
    api.apiRequestJson = async (...args) => {
      if (String(args[0]).endsWith("/files")) return { ok: true, data: { files: [] } };
      if (String(args[0]).endsWith("/status")) return { ok: true, data: { status: "running", endpoint: "https://runner.example" } };
      if (String(args[0]) === "/business/") return { ok: true, data: [{ id: "biz-test", workspace_id: "ws-test", slug: "example-co", name: "Example" }] };
      if (String(args[0]).endsWith('/sync')) return { ok: true, status: 200, data: { written: 0, errors: 1, results: [{ path: '/atris/cloud-note.md', status: 'error', error: 'permission denied' }] } };
      throw new Error(`unexpected API request: ${args[0]}`);
    };
    const { alignAtris } = require('../commands/align');
    process.argv = ['node', 'atris', 'align', 'example-co', '--fix', '--hard', '--from', 'local'];
    console.log = console.error = (...args) => logs.push(args.join(' '));
    process.exit = () => { throw exited; };
    try { await alignAtris(); } catch (error) { if (error !== exited) throw error; }
    assert.match(logs.join('\n'), /permission denied/);
  } finally {
    api.apiRequestJson = request;
    process.chdir(previous.cwd);
    process.argv = previous.argv;
    process.exit = previous.exit;
    console.log = previous.log;
    console.error = previous.error;
    if (previous.home === undefined) delete process.env.HOME;
    else process.env.HOME = previous.home;
  }
});
