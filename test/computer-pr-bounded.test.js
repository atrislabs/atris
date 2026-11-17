'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { runBoundedPrRound } = require('../lib/computer-pr-bounded');
const { parsePrArgs } = require('../lib/computer-pr');

function harness({ onRequest, deadlineAt = 1000, stop } = {}) {
  let time = 0;
  const calls = [], receipts = [];
  const controller = new AbortController();
  return { calls, receipts, controller, run: () => runBoundedPrRound({
    request: async (url, options) => {
      calls.push({ url, options });
      return onRequest ? onRequest(url, options, controller, calls.length) : { ok: false };
    }, token: 'fake', ctx: { businessId: 'business', workspaceId: 'workspace' },
    startOptions: { body: { require_subscription: true, max_turns: 2 } },
    deadlineAt, signal: controller.signal, now: () => time,
    sleep: async ms => { time += ms; if (stop) controller.abort(); },
    saveReceipt: value => { receipts.push(value); return 'receipt.json'; },
    cancellationGraceMs: 1000,
  }) };
}
const started = { ok: true, data: { execution_id: 'run-a' } };
const running = { ok: true, data: { status: 'running', events: [] } };
const ack = { ok: true, data: { execution_id: 'run-a', status: 'cancel_requested' } };

test('bounded flags require explicit subscription, turn cap and one-round mode', () => {
  assert.throws(() => parsePrArgs(['owner/repo', 'fix', '--timeout-seconds=10']), /requires/);
  for (const value of ['0', '3601', '-1', '1.1', 'bad']) {
    assert.throws(() => parsePrArgs(['owner/repo', 'fix', `--timeout-seconds=${value}`]), /whole number/);
  }
  assert.equal(parsePrArgs(['owner/repo', 'fix', '--timeout-seconds=10', '--require-subscription', '--max-turns=2', '--no-think']).timeoutSeconds, 10);
});

test('expired deadline starts nothing and writes a receipt', async () => {
  const h = harness({ deadlineAt: 0 });
  const r = await h.run();
  assert.equal(r.receipt.status, 'stopped_before_dispatch');
  assert.equal(h.calls.length, 0);
});

test('normal completion observes terminal status without cancellation', async () => {
  const h = harness({ onRequest: url => url.endsWith('/subscription-only') ? started
    : { ok: true, data: { status: 'completed', execution_id: 'run-a', events: [{ type: 'result', result: 'done' }] } } });
  const r = await h.run();
  assert.equal(r.streamed.ok, true);
  assert.equal(r.receipt.terminal_status_observed, true);
  assert.equal(h.calls.length, 2);
  assert.equal(h.receipts[2].execution_id, 'run-a');
});

test('deadline cancels only captured id once and ack is not terminal proof', async () => {
  const h = harness({ onRequest: url => url.endsWith('/subscription-only') ? started : url.includes('/cancel-strict?') ? ack : running });
  const r = await h.run();
  assert.equal(r.receipt.status, 'cancellation_unconfirmed');
  assert.equal(r.receipt.cancellation_acknowledged, true);
  assert.equal(r.receipt.terminal_status_observed, false);
  const cancel = h.calls.filter(c => c.url.includes('/cancel-strict?'));
  assert.equal(cancel.length, 1);
  assert.match(cancel[0].url, /execution_id=run-a&workspace_id=workspace/);
  assert.equal(cancel[0].options.retries, 0);
  assert.ok(h.calls.every(call => call.options.noAuthRenewal === true));
  assert.equal(h.calls.some(c => /\/stop|\/cancel\?/.test(c.url)), false);
});

test('interrupt stops via scoped cancellation and observes terminal service state', async () => {
  let cancelled = false;
  const h = harness({ stop: true, onRequest: url => {
    if (url.endsWith('/subscription-only')) return started;
    if (url.includes('/cancel-strict?')) { cancelled = true; return ack; }
    return cancelled ? { ok: true, data: { status: 'cancelled', execution_id: 'run-a', events: [] } } : running;
  } });
  const r = await h.run();
  assert.equal(r.receipt.stop_reason, 'interrupted');
  assert.equal(r.receipt.terminal_status_observed, true);
  assert.equal(r.receipt.observed_terminal_status, 'cancelled');
  assert.ok(r.startError);
});

test('lost start reply is unknown and never retried or globally cancelled', async () => {
  const h = harness({ onRequest: () => { throw new Error('lost reply'); } });
  const r = await h.run();
  assert.equal(r.receipt.status, 'start_outcome_unknown');
  assert.equal(h.calls.length, 1);
  assert.equal(r.receipt.execution_id, null);
});

test('missing strict endpoint stays unconfirmed without legacy fallback', async () => {
  const h = harness({ onRequest: url => url.endsWith('/subscription-only') ? started
    : url.includes('/cancel-strict?') ? { ok: false, status: 404 } : running });
  const r = await h.run();
  assert.equal(r.receipt.status, 'cancellation_unconfirmed');
  assert.equal(r.receipt.cancellation_acknowledged, false);
  assert.equal(h.calls.filter(c => c.url.includes('/cancel')).length, 1);
});

test('poll error cancels rather than launching another round', async () => {
  const h = harness({ onRequest: url => url.endsWith('/subscription-only') ? started
    : url.includes('/cancel-strict?') ? ack : { ok: false, status: 503 } });
  const r = await h.run();
  assert.equal(r.receipt.stop_reason, 'events_unavailable');
  assert.equal(h.calls.filter(c => c.url.endsWith('/subscription-only')).length, 1);
});

test('receipt failure before start prevents model dispatch', async () => {
  let calls = 0;
  await assert.rejects(runBoundedPrRound({ request: async () => { calls++; }, ctx: {}, deadlineAt: Date.now() + 1000,
    saveReceipt: () => { throw new Error('disk full'); } }), /disk full/);
  assert.equal(calls, 0);
});

test('real command SIGTERM cancels captured run instead of exiting or retrying', async () => {
  const { computerPr } = require('../commands/computer');
  const calls = [], receipts = [];
  const oldExitCode = process.exitCode;
  try {
    const result = await computerPr('fake', ['owner/repo', 'fix', '--no-feed', '--no-think',
      '--require-subscription', '--max-turns=2', '--timeout-seconds=30'],
    { businessId: 'business', workspaceId: 'workspace' }, {}, {
      log() {}, logError() {}, write() {}, cloudTeam: null,
      ensureBusinessAwake: async () => true,
      saveReceipt: value => { receipts.push(value); return 'receipt.json'; },
      apiRequestJson: async (url, options) => {
        calls.push(url);
        if (url.endsWith('/execution-policy')) return { ok: true, data: { version: 1, require_subscription: true } };
        if (url.endsWith('/ai-computer/status')) return { ok: true, data: { status: 'running', endpoint: 'ready' } };
        if (url.endsWith('/capability')) return { ok: true, data: { version: 1, execution_scoped: true } };
        if (url.endsWith('/subscription-only')) { process.emit('SIGTERM'); return started; }
        if (url.includes('/cancel-strict?')) return ack;
        return { ok: true, data: { status: 'cancelled', execution_id: 'run-a', events: [] } };
      },
    });
    assert.equal(result, 1);
    assert.equal(calls.filter(url => url.endsWith('/subscription-only')).length, 1);
    assert.equal(calls.filter(url => url.includes('/cancel-strict?')).length, 1);
    assert.equal(receipts.at(-1).observed_terminal_status, 'cancelled');
  } finally { process.exitCode = oldExitCode; }
});

test('missing cancellation capability prevents wake and dispatch', async () => {
  const { computerPr } = require('../commands/computer');
  const calls = [];
  const oldExitCode = process.exitCode;
  try {
    const result = await computerPr('fake', ['owner/repo', 'fix', '--no-feed', '--no-think',
      '--require-subscription', '--max-turns=2', '--timeout-seconds=30'],
    { businessId: 'business', workspaceId: 'workspace' }, {}, {
      log() {}, logError() {}, cloudTeam: null,
      ensureBusinessAwake: async () => { throw new Error('must not wake'); },
      apiRequestJson: async url => {
        calls.push(url);
        return url.endsWith('/execution-policy') ? { ok: true, data: { version: 1, require_subscription: true } }
          : { ok: false, status: 404 };
      },
    });
    assert.equal(result, 1);
    assert.equal(calls.length, 2);
  } finally { process.exitCode = oldExitCode; }
});

test('receipt writer replaces a private on-disk receipt without credentials', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { receiptWriter } = require('../lib/computer-pr-bounded');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-receipt-'));
  try {
    const save = receiptWriter(root);
    const file = save({ execution_id: null, status: 'starting' });
    assert.equal(save({ execution_id: 'run-a', status: 'running' }), file);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { execution_id: 'run-a', status: 'running' });
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.existsSync(`${file}.tmp`), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('backend synthetic missing-run failure stays unknown and attempts scoped cancellation', async () => {
  const missing = { ok: true, data: {
    execution_id: 'run-a', status: 'failed',
    events: [{ type: 'error', error: 'Execution no longer active on runner.' }], next_index: 1,
  } };
  const h = harness({ onRequest: url => url.endsWith('/subscription-only') ? started
    : url.includes('/cancel-strict?') ? ack : missing });
  const r = await h.run();
  assert.equal(r.receipt.status, 'cancellation_unconfirmed');
  assert.equal(r.receipt.terminal_status_observed, false);
  assert.equal(r.receipt.stop_reason, 'events_unavailable');
  assert.equal(h.calls.filter(c => c.url.includes('/cancel-strict?')).length, 1);
});

test('failed atomic receipt replacement preserves prior execution receipt', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { receiptWriter } = require('../lib/computer-pr-bounded');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-receipt-fail-'));
  const rename = fs.renameSync;
  try {
    const save = receiptWriter(root);
    const file = save({ execution_id: 'run-a', status: 'running' });
    fs.renameSync = () => { throw new Error('rename failed'); };
    assert.throws(() => save({ execution_id: 'run-a', status: 'cancel_requested' }), /rename failed/);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { execution_id: 'run-a', status: 'running' });
  } finally { fs.renameSync = rename; fs.rmSync(root, { recursive: true, force: true }); }
});

test('runner cleanup unknown marker prevents terminal success or stopped claim', async () => {
  const h = harness({ onRequest: url => url.endsWith('/subscription-only') ? started
    : url.includes('/cancel-strict?') ? ack : { ok: true, data: {
      execution_id: 'run-a', status: 'failed',
      events: [{ type: 'error', error: 'permission denied', cleanup_status: 'unknown' }],
    } } });
  const r = await h.run();
  assert.equal(r.receipt.status, 'cancellation_unconfirmed');
  assert.equal(r.receipt.terminal_status_observed, false);
  assert.equal(h.calls.filter(c => c.url.includes('/cancel-strict?')).length, 1);
});
