'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const { apiRequestJson } = require('../utils/api');
const { runBoundedPrRound, receiptWriter } = require('../lib/computer-pr-bounded');

// This fixture is a local protocol adapter, not the deployed backend or runner.
// Explicit path prevents silently testing a vendored/reimplemented helper.
const helperPath = process.env.ATRIS_OWNED_CLI_PATH;
const skipReason = helperPath === undefined
  ? 'Set ATRIS_OWNED_CLI_PATH to the real owned_cli.py for cross-repository proof' : false;
if (!skipReason && (!path.isAbsolute(helperPath) || path.basename(helperPath) !== 'owned_cli.py'
    || !fs.existsSync(helperPath) || !fs.statSync(helperPath).isFile())) {
  throw new Error('ATRIS_OWNED_CLI_PATH must select an existing absolute owned_cli.py file');
}
const helper = skipReason ? null : path.dirname(helperPath);

async function withFixture(mode, body) {
  const child = spawn('python3', [path.join(__dirname, 'fixtures/owned-cli-http-fixture.py'), mode], {
    env: { ...process.env, ATRIS_TEST_OWNED_CLI_DIR: helper, PYTHONDONTWRITEBYTECODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let diagnostics = '';
  child.stderr.on('data', b => { diagnostics += b; });
  const exit = once(child, 'exit');
  const previousUrl = process.env.ATRIS_API_URL;
  let info;
  let ownedPid;
  try {
    info = await new Promise((resolve, reject) => {
      let buffer = '';
      const timer = setTimeout(() => reject(new Error(`fixture startup timed out: ${diagnostics}`)), 5000);
      child.once('exit', () => { clearTimeout(timer); reject(new Error(diagnostics || 'fixture exited')); });
      child.stdout.on('data', b => {
        buffer += b;
        if (buffer.includes('\n')) {
          clearTimeout(timer);
          try { resolve(JSON.parse(buffer.split('\n')[0])); } catch (err) { reject(err); }
        }
      });
    });
    process.env.ATRIS_API_URL = `http://127.0.0.1:${info.port}`;
    const request = (url, opts = {}) => apiRequestJson(url, { retries: 0, noAuthRenewal: true, timeoutMs: 2000, ...opts });
    await body(request);
  } finally {
    if (info && child.exitCode === null) {
      try {
        const observed = await apiRequestJson('/inspect', { retries: 0, noAuthRenewal: true, timeoutMs: 1000 });
        ownedPid = observed.data?.owned_pid;
      } catch (_) {}
      try { await apiRequestJson('/shutdown', { method: 'POST', retries: 0, noAuthRenewal: true, timeoutMs: 1000 }); } catch (_) {}
    }
    // Give /shutdown its normal exit path before signaling the process.
    // Immediate SIGTERM can race Python's signal-handler teardown.
    const gracefulTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    }, 2500);
    let timer;
    await Promise.race([exit, new Promise(resolve => { timer = setTimeout(() => {
      for (const pid of [ownedPid, info?.unrelated_pid]) {
        if (pid) { try { process.kill(-pid, 'SIGKILL'); } catch (_) {} }
      }
      child.kill('SIGKILL'); exit.then(resolve);
    }, 6000); })]);
    clearTimeout(timer);
    clearTimeout(gracefulTimer);
    if (previousUrl === undefined) delete process.env.ATRIS_API_URL;
    else process.env.ATRIS_API_URL = previousUrl;
    for (const pid of [ownedPid, info?.unrelated_pid]) {
      if (!pid) continue;
      let alive = false;
      try { process.kill(-pid, 0); alive = true; } catch (err) { if (err.code !== 'ESRCH') throw err; }
      if (alive) { try { process.kill(-pid, 'SIGKILL'); } catch (_) {} }
      assert.equal(alive, false, `fixture left child process group ${pid} alive`);
    }
    assert.equal(child.exitCode, 0, `fixture failed: ${diagnostics}`);
  }
}

async function round(request, cancellationGraceMs = 1500) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-owned-http-'));
  try {
    const result = await runBoundedPrRound({ request, token: null,
      ctx: { businessId: 'fixture-business', workspaceId: 'fixture-workspace' },
      startOptions: { body: { message: 'local sleep test only' } },
      deadlineAt: Date.now() + 3000, cancellationGraceMs,
      saveReceipt: receiptWriter(directory),
    });
    const disk = JSON.parse(fs.readFileSync(result.receiptPath, 'utf8'));
    assert.deepEqual(disk, result.receipt);
    assert.equal(disk.execution_id, result.receipt.execution_id);
    assert.equal(fs.statSync(result.receiptPath).mode & 0o777, 0o600);
    return result;
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

test('dropped acceptance response starts one owned child, never retries', { timeout: 15000, skip: skipReason }, async () => {
  await withFixture('dropped-start', async request => {
    const result = await round(request);
    assert.equal(result.receipt.status, 'start_outcome_unknown');
    assert.equal(result.receipt.execution_id, null);
    const state = (await request('/inspect')).data;
    assert.equal(state.starts, 1);
    assert.equal(state.cancels, 0);
    assert.equal(state.owned_alive, true);
    assert.equal(state.unrelated_alive, true);
  });
});

test('captured execution cancellation reaches real OwnedCliCancelled without killing unrelated child', { timeout: 15000, skip: skipReason }, async () => {
  await withFixture('normal', async request => {
    const pending = round(request);
    try {
    let before;
    for (let i = 0; i < 50; i++) {
      before = (await request('/inspect')).data;
      if (before.owned_alive) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(before.owned_alive, true);
    const wrong = await request('/business/fixture-business/chat/cancel-strict?execution_id=wrong-run&workspace_id=fixture-workspace', { method: 'POST' });
    assert.equal(wrong.status, 404);
    const untouched = (await request('/inspect')).data;
    assert.equal(untouched.owned_alive, true);
    assert.equal(untouched.unrelated_alive, true);
    const result = await pending;
    assert.equal(result.receipt.execution_id, 'fixture-run');
    assert.equal(result.receipt.status, 'stopped_with_terminal_status');
    assert.equal(result.receipt.terminal_status_observed, true);
    const state = (await request('/inspect')).data;
    assert.equal(state.starts, 1);
    assert.equal(state.cancels, 1);
    assert.equal(state.cancel_execution_id, 'fixture-run');
    assert.equal(state.cancel_workspace_id, 'fixture-workspace');
    assert.equal(state.outcome, 'OwnedCliCancelled');
    assert.equal(state.cleanup_status, 'confirmed');
    assert.equal(state.owned_alive, false);
    assert.equal(state.owned_group_alive, false);
    assert.equal(state.unrelated_alive, true);
    } finally { await pending.catch(() => {}); }
  });
});

test('cleanup inspection uncertainty never becomes terminal proof', { timeout: 15000, skip: skipReason }, async () => {
  await withFixture('cleanup-unknown', async request => {
    const result = await round(request, 650);
    assert.equal(result.receipt.status, 'cancellation_unconfirmed');
    assert.equal(result.receipt.terminal_status_observed, false);
    const state = (await request('/inspect')).data;
    assert.equal(state.starts, 1);
    assert.equal(state.cancels, 1);
    assert.equal(state.outcome, 'CleanupUnconfirmed');
    assert.equal(state.cleanup_status, 'unknown');
    assert.equal(state.unrelated_alive, true);
  });
});


test('real HTTP bind failure reaps child before server exists', { timeout: 10000, skip: skipReason }, async () => {
  const occupied = net.createServer();
  occupied.listen(0, '127.0.0.1');
  await once(occupied, 'listening');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-owned-bind-'));
  const pidAudit = path.join(directory, 'unrelated.pid');
  let child;
  let exited;
  let timer;
  let fallback;
  let output = '';
  let errors = '';
  let pid;
  try {
    child = spawn('python3', [path.join(__dirname, 'fixtures/owned-cli-http-fixture.py'), 'normal'], {
      env: { ...process.env, ATRIS_TEST_OWNED_CLI_DIR: helper, PYTHONDONTWRITEBYTECODE: '1',
        ATRIS_TEST_HTTP_PORT: String(occupied.address().port), ATRIS_TEST_PID_AUDIT: pidAudit },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', b => { output += b; });
    child.stderr.on('data', b => { errors += b; });
    exited = once(child, 'close');
    timer = setTimeout(() => child.kill('SIGTERM'), 4000);
    fallback = setTimeout(() => child.kill('SIGKILL'), 6000);
    const [code] = await exited;
    pid = Number(fs.readFileSync(pidAudit, 'utf8').trim());
    assert.equal(code, 1);
    assert.match(errors, /address already in use/i);
    assert.equal(output, ''); // Readiness is never announced before successful bind.
    assert.ok(Number.isInteger(pid) && pid > 0);
    assert.throws(() => process.kill(-pid, 0), { code: 'ESRCH' });
  } finally {
    clearTimeout(timer);
    clearTimeout(fallback);
    if (!pid) { try { pid = Number(fs.readFileSync(pidAudit, 'utf8').trim()); } catch (_) {} }
    if (Number.isInteger(pid) && pid > 0) { try { process.kill(-pid, 'SIGKILL'); } catch (_) {} }
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await exited;
    }
    await new Promise(resolve => occupied.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
