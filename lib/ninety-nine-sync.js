'use strict';

const { createHash } = require('node:crypto');
const { apiRequestJson, getApiBaseUrl } = require('../utils/api');
const { decodeJwtClaims } = require('../utils/auth');
const { parseSessionLog, lineIdentity, uniqueLines } = require('./ninety-nine');

const WORKSPACE_DIRECTORY = 'atris/99';

function validateSync(sync) {
  if (!sync || !['personal', 'workspace'].includes(sync.target)) {
    throw new Error('choose sync target personal or workspace in the 99 config');
  }
  const appSlug = sync.app_slug ?? 'project-99';
  if (sync.target === 'personal' && (typeof appSlug !== 'string' || !/^[a-z][a-z0-9-]{1,63}$/.test(appSlug))) {
    throw new Error('sync app_slug must be 2 to 64 lowercase letters, digits, or hyphens, starting with a letter');
  }
  if (sync.target === 'workspace' && (typeof sync.business !== 'string' || !sync.business.trim())) {
    throw new Error('set sync business to your business slug in the 99 config');
  }
  if (sync.workspace !== undefined && (typeof sync.workspace !== 'string' || !sync.workspace.trim())) {
    throw new Error('sync workspace must be a workspace id');
  }
}

function checkpointKey(sync, credentials) {
  const account = credentials.user_id || decodeJwtClaims(credentials.token)?.sub || credentials.email
    || createHash('sha256').update(credentials.token).digest('hex');
  return createHash('sha256').update(JSON.stringify([
    getApiBaseUrl(), account, sync.target, sync.app_slug ?? 'project-99', sync.business, sync.workspace,
  ])).digest('hex');
}

async function requestData(request, endpoint, options) {
  let response;
  try { response = await request(endpoint, options); } catch {
    throw new Error('could not reach sync; try again');
  }
  if (!response?.ok) {
    if ([401, 403].includes(response?.status)) throw new Error('sync needs your signed-in user login; run atris login');
    // Server errors can echo request headers. Keep credentials out of all output.
    throw new Error(`sync request failed${response?.status ? ` (http ${response.status})` : ''}; try again`);
  }
  return response.data;
}

// Personal records are append-only. Retain acknowledged identities as well as
// the server's received-time cursor, so retries send only unacknowledged lines.
async function personalPlan(records, sync, checkpoint, request, token) {
  const endpoint = `/me/apps/${sync.app_slug ?? 'project-99'}/records`;
  const known = new Set(checkpoint.known || []);
  let since = checkpoint.since || null;
  const cursors = new Set(since ? [since] : []);
  const remote = [];
  for (;;) {
    const query = new URLSearchParams({ limit: '1000' });
    if (since) query.set('since', since);
    const data = await requestData(request, `${endpoint}?${query}`, { method: 'GET', token });
    if (!Array.isArray(data?.lines) || data.lines.length > 1000
      || !(data.next_since === null || (typeof data.next_since === 'string' && Number.isFinite(Date.parse(data.next_since))))) {
      throw new Error('sync returned invalid records or cursor; nothing was saved');
    }
    const lines = parseSessionLog(data.lines.map((line) => JSON.stringify(line)).join('\n'));
    remote.push(...lines);
    for (const line of lines) known.add(lineIdentity(line));
    if (!data.next_since) break;
    if (cursors.has(data.next_since) || (since && Date.parse(data.next_since) <= Date.parse(since))) {
      if (lines.length) throw new Error('sync cursor did not advance; nothing was saved');
      break;
    }
    since = data.next_since;
    cursors.add(since);
    if (!lines.length) break;
  }
  const send = records.filter((line) => !known.has(lineIdentity(line)));
  if (send.some((line) => Buffer.byteLength(JSON.stringify(line), 'utf8') > 2048)) {
    throw new Error('a personal sync line exceeds 2 kb; nothing was sent');
  }
  return { remote, send, known, since, endpoint };
}

async function workspacePlan(records, sync, deviceId, request, token) {
  if (typeof deviceId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(deviceId)) {
    throw new Error('check the 99 sync-state device id');
  }
  const deviceFile = `${WORKSPACE_DIRECTORY}/sessions.${deviceId}.jsonl`;
  // Use the same business lookup, filtered snapshot, and file sync routes as
  // push.js and pull.js. Never invoke those commands or sync unrelated files.
  const { businessMatchesSlug } = require('../commands/business');
  const businesses = await requestData(request, '/business/', { method: 'GET', token });
  if (!Array.isArray(businesses)) throw new Error('sync returned an invalid business list');
  const business = businesses.find((item) => businessMatchesSlug(item, sync.business, { includeName: true }));
  if (!business?.id) throw new Error('sync business was not found; check the 99 config');
  const workspace = sync.workspace || business.workspace_id;
  if (!workspace) throw new Error('sync business has no default workspace; set sync workspace in the 99 config');
  const endpoint = `/business/${encodeURIComponent(business.id)}/workspaces/${encodeURIComponent(workspace)}`;
  const data = await requestData(request, `${endpoint}/snapshot?include_content=true&paths=${encodeURIComponent(WORKSPACE_DIRECTORY)}`, {
    method: 'GET', token,
  });
  if (!Array.isArray(data?.files)) throw new Error('sync returned an invalid workspace snapshot');
  const files = data.files.filter((item) => typeof item?.path === 'string'
    && /^atris\/99\/sessions(?:\.[^/]+)?\.jsonl$/.test(item.path.replace(/^\/+/, '')));
  if (files.some((file) => typeof file.content !== 'string')) {
    throw new Error('sync could not read the workspace session log');
  }
  const text = files.find((file) => file.path.replace(/^\/+/, '') === deviceFile)?.content || '';
  const remote = uniqueLines(files.flatMap((file) => parseSessionLog(file.content)));
  const known = new Set(remote.map(lineIdentity));
  const send = records.filter((line) => !known.has(lineIdentity(line)));
  const separator = text && !text.endsWith('\n') ? '\n' : '';
  const content = text + (send.length ? separator + send.map((line) => JSON.stringify(line)).join('\n') + '\n' : '');
  return { remote, send, content, endpoint, deviceFile };
}

async function syncLines({ records, sync, checkpoint = {}, deviceId, credentials, dryRun = false, request = apiRequestJson }) {
  validateSync(sync);
  const local = uniqueLines(records);
  const plan = sync.target === 'personal'
    ? await personalPlan(local, sync, checkpoint, request, credentials.token)
    : await workspacePlan(local, sync, deviceId, request, credentials.token);
  const localKeys = new Set(local.map(lineIdentity));
  const pull = uniqueLines(plan.remote).filter((line) => !localKeys.has(lineIdentity(line)));
  if (!dryRun && plan.send.length) {
    if (sync.target === 'personal') {
      for (let offset = 0; offset < plan.send.length; offset += 500) {
        const lines = plan.send.slice(offset, offset + 500);
        const data = await requestData(request, plan.endpoint, {
          method: 'POST', token: credentials.token, body: { lines },
        });
        if (!Number.isInteger(data?.stored) || !Number.isInteger(data?.skipped)
          || data.stored < 0 || data.skipped < 0 || data.stored + data.skipped !== lines.length) {
          throw new Error('sync did not acknowledge every line; try again');
        }
      }
    } else {
      const data = await requestData(request, `${plan.endpoint}/sync?timeout=120`, {
        method: 'POST', token: credentials.token,
        headers: { 'X-Atris-Actor-Source': 'cli' }, timeoutMs: 135000,
        body: { files: [{ path: plan.deviceFile, content: plan.content }] },
      });
      const result = data?.results?.find((item) => item?.path?.replace(/^\/+/, '') === plan.deviceFile);
      if (!result || !['written', 'unchanged'].includes(result.status)) {
        throw new Error('sync did not confirm the workspace file was saved; try again');
      }
    }
  }
  return {
    send: plan.send,
    pull,
    checkpoint: sync.target === 'personal'
      ? { since: plan.since, known: [...new Set([...plan.known, ...plan.send.map(lineIdentity)])] }
      : {},
  };
}

module.exports = { validateSync, checkpointKey, syncLines };
