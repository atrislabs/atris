'use strict';

// Client-side supervision is not a remote hard deadline. A lost start reply,
// dead client, or unreachable runner can leave work running. Keep the receipt.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function receiptWriter(root = process.cwd()) {
  const file = path.join(root, '.atris', 'receipts', 'computer-pr', `${crypto.randomUUID()}.json`);
  return (receipt) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.tmp`;
    const fd = fs.openSync(temporary, 'w', 0o600);
    try {
      fs.writeFileSync(fd, `${JSON.stringify(receipt, null, 2)}\n`);
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, file);
    const directory = fs.openSync(path.dirname(file), 'r');
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    return file;
  };
}

async function runBoundedPrRound({ request, token, ctx, startOptions, deadlineAt,
  signal, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  saveReceipt = receiptWriter(), write = () => {}, cancellationGraceMs = 15000 }) {
  let executionId = null;
  let text = '';
  let fromIndex = 0;
  let receiptPath = null;
  const receipt = { business_id: ctx.businessId, workspace_id: ctx.workspaceId,
    deadline_at: new Date(deadlineAt).toISOString(), execution_id: null,
    status: 'not_started', terminal_status_observed: false };
  const persist = () => { receiptPath = saveReceipt({ ...receipt }); };
  const failure = status => {
    receipt.status = status;
    try { persist(); } catch (_) { receipt.receipt_write_failed = true; }
    return { startError: `${status.replaceAll('_', ' ')}; execution: ${executionId || 'unknown'}; receipt: ${receiptPath || 'unavailable'}`,
      receipt, receiptPath };
  };
  const stopped = () => signal?.aborted || now() >= deadlineAt;
  // apiRequestJson has a hard deadline at twice timeoutMs. Never retry starts.
  const options = (end, method = 'GET') => ({ method, token, retries: 0, noAuthRenewal: true, noRedirects: true,
    timeoutMs: Math.max(1, Math.min(1000, Math.floor((end - now()) / 2))) });
  const eventsPath = () => `/business/${ctx.businessId}/chat/events?execution_id=${encodeURIComponent(executionId)}&workspace_id=${encodeURIComponent(ctx.workspaceId)}&from_index=${fromIndex}`;
  persist(); // A failed receipt write must prevent launch.
  if (stopped()) return failure('stopped_before_dispatch');
  receipt.status = 'starting';
  persist();
  let started;
  try {
    started = await request(`/business/${ctx.businessId}/chat/subscription-only`,
      { ...startOptions, ...options(deadlineAt, 'POST'), timeoutMs: Math.max(1, Math.min(15000, Math.floor((deadlineAt - now()) / 2))) });
  } catch (_) { return failure('start_outcome_unknown'); }
  if (!started.ok || !started.data?.execution_id) {
    // Do not retry an ambiguous start: a second request could create a second run.
    return failure(started.status >= 400 && started.status < 500 ? 'start_rejected' : 'start_outcome_unknown');
  }
  executionId = started.data.execution_id;
  receipt.execution_id = executionId;
  receipt.status = 'running';
  let persistenceFailed = false;
  try { persist(); } catch (_) { persistenceFailed = true; }

  const readEvents = async end => {
    const response = await request(eventsPath(), options(end));
    if (!response.ok || !response.data || typeof response.data !== 'object') throw new Error('events unavailable');
    const data = response.data;
    // The legacy events API turns runner404 into a synthetic failed result.
    // Absence is not evidence that the selected run or its processes stopped.
    const cleanup = [...(data.events || [])].reverse().find(event => event.cleanup_status)?.cleanup_status;
    if (['unknown', 'pending'].includes(data.cleanup_status || cleanup)) {
      throw new Error('execution cleanup unconfirmed');
    }
    if ((data.events || []).some(event => event.error === 'Execution no longer active on runner.')) {
      throw new Error('execution state unknown');
    }
    if (data.execution_id && data.execution_id !== executionId) throw new Error('wrong execution');
    for (const event of data.events || []) {
      if (['assistant_text', 'text'].includes(event.type) && event.content) { text += event.content; write(event.content); }
      if (event.type === 'result' && event.result) { text += String(event.result); }
    }
    fromIndex = Number.isInteger(data.next_index) && data.next_index >= fromIndex
      ? data.next_index : fromIndex + (data.events || []).length;
    return ['completed', 'cancelled', 'failed', 'error'].includes(data.status) ? data.status : null;
  };

  let reason = persistenceFailed ? 'receipt_failed' : null;
  while (!reason && !stopped()) {
    try {
      const terminal = await readEvents(deadlineAt);
      if (terminal) {
        receipt.status = terminal;
        receipt.terminal_status_observed = true;
        persist();
        if (terminal !== 'completed') return failure(terminal);
        return { streamed: { ok: true, status: terminal, text }, text, receipt, receiptPath };
      }
    } catch (_) { reason = 'events_unavailable'; break; }
    await sleep(Math.min(500, Math.max(0, deadlineAt - now())));
  }
  reason ||= signal?.aborted ? 'interrupted' : 'deadline_exceeded';
  receipt.stop_reason = reason;
  const verifyUntil = now() + cancellationGraceMs;
  let cancel;
  try {
    cancel = await request(`/business/${ctx.businessId}/chat/cancel-strict?execution_id=${encodeURIComponent(executionId)}&workspace_id=${encodeURIComponent(ctx.workspaceId)}`,
      options(verifyUntil, 'POST'));
  } catch (_) { cancel = null; }
  // Acknowledgment only. Never call legacy /cancel or global /stop.
  receipt.cancellation_acknowledged = Boolean(cancel?.ok && cancel.data?.execution_id === executionId
    && cancel.data?.status === 'cancel_requested');
  try { persist(); } catch (_) { receipt.receipt_write_failed = true; }
  while (now() < verifyUntil) {
    try {
      const terminal = await readEvents(verifyUntil);
      if (terminal) {
        receipt.terminal_status_observed = true;
        receipt.observed_terminal_status = terminal;
        return failure('stopped_with_terminal_status');
      }
    } catch (_) { /* Bounded observation only; no cancellation retry. */ }
    await sleep(Math.min(500, Math.max(0, verifyUntil - now())));
  }
  return failure('cancellation_unconfirmed');
}

module.exports = { runBoundedPrRound, receiptWriter };
