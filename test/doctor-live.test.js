const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { doctorCommand } = require('../commands/doctor');

// Runs doctor --live in a temp project with a fake engine. Never calls a model.
async function live(t, { installed = ['claude'], ran = null, args = [] } = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-live-'));
  fs.mkdirSync(path.join(cwd, '.atris'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const calls = [];
  const lines = [];
  t.mock.method(console, 'log', (line) => lines.push(String(line)));
  const code = await doctorCommand(['--live', ...args], {
    cwd,
    binInstalled: (bin) => installed.includes(bin),
    runAsk: async (invocation) => { calls.push(invocation); return ran; },
  });
  const receipt = JSON.parse(fs.readFileSync(path.join(cwd, '.atris', 'state', 'doctor-live.json'), 'utf8'));
  return { code, out: lines.join('\n'), calls, receipt };
}

test('doctor --live passes on the exact reply and saves a receipt', async (t) => {
  const r = await live(t, { ran: { ok: true, stdout: 'ATRIS LIVE OK\n', duration_ms: 3240, model_ran: 'claude-haiku-5-5' } });
  assert.equal(r.code, 0);
  assert.equal(r.out, 'atris doctor --live: passed in 3.2 seconds with claude (claude-haiku-5-5).');
  assert.equal(r.calls[0].bin, 'claude');
  assert.ok(r.calls[0].args.includes('--permission-mode'));
  assert.equal(r.receipt.ok, true);
});

test('doctor --live falls back to codex and fails on a different reply', async (t) => {
  const r = await live(t, { installed: ['codex'], ran: { ok: true, stdout: 'ATRIS LIVE OK.', duration_ms: 10 }, args: ['--json'] });
  assert.equal(r.code, 1);
  assert.equal(r.calls[0].bin, 'codex');
  assert.equal(JSON.parse(r.out).error, 'replied "ATRIS LIVE OK." instead of "ATRIS LIVE OK"');
});

test('doctor --live keeps the engine error text', async (t) => {
  const r = await live(t, { ran: { ok: false, reason: 'exit_1', stdout: '', stderr: 'Invalid API key. Please run /login', duration_ms: 900 } });
  assert.equal(r.code, 1);
  assert.match(r.out, /failed with claude \(asked for claude-haiku-5-5\)\. exit_1: Invalid API key\. Please run \/login$/);
  assert.equal(r.receipt.error, 'exit_1: Invalid API key. Please run /login');
  assert.equal(r.receipt.model, null);
});

test('doctor --live with no coding tool says what to install and runs nothing', async (t) => {
  const r = await live(t, { installed: [] });
  assert.equal(r.code, 1);
  assert.equal(r.calls.length, 0);
  assert.match(r.out, /failed\. no coding tool found\. install claude code or codex/);
});
