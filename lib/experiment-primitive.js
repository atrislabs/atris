'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const VALID_SCOPES = ['nexus_list', 'member_goal', 'loop', 'page', 'feature', 'raise'];
const VALID_STATUSES = ['proposed', 'running', 'blocked', 'accepted', 'discarded', 'superseded'];
const DECISION_STATUSES = ['accepted', 'discarded', 'superseded'];
const DEFAULT_MIN_N = 5;

function storePath(root) {
  return path.join(root, '.atris', 'state', 'experiments.jsonl');
}

function nowIso() {
  return new Date().toISOString();
}

function todayIso() {
  return nowIso().slice(0, 10);
}

function readAll(root) {
  const file = storePath(root);
  if (!fs.existsSync(file)) return [];
  const rows = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && parsed.id) rows.push(parsed);
    } catch {
      // skip malformed line
    }
  }
  return rows;
}

function writeAll(root, rows) {
  const file = storePath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = rows.map((row) => JSON.stringify(row)).join('\n');
  fs.writeFileSync(file, body ? `${body}\n` : '', 'utf8');
}

function sampleOf(row) {
  const counts = row?.counts && typeof row.counts === 'object' ? row.counts : {};
  for (const key of ['sample', 'reached', 'total', 'people', 'n']) {
    if (typeof counts[key] === 'number' && Number.isFinite(counts[key])) return Math.floor(counts[key]);
  }
  return 0;
}

function rateOf(row) {
  const rates = row?.rates && typeof row.rates === 'object' ? row.rates : {};
  for (const key of ['primary_rate', 'reply_rate', 'conversion_rate', 'rate']) {
    if (typeof rates[key] === 'number' && Number.isFinite(rates[key])) return rates[key];
  }
  return typeof row?.value === 'number' && Number.isFinite(row.value) ? row.value : null;
}

function decorate(row) {
  const minN = Number.isInteger(row.min_n) && row.min_n > 0 ? row.min_n : DEFAULT_MIN_N;
  const sample = sampleOf(row);
  return {
    ...row,
    min_n: minN,
    sample,
    ready_to_decide: sample >= minN,
  };
}

function propose({
  root,
  scopeType = 'loop',
  scopeId = 'general',
  guess,
  loop = null,
  verifier = 'manual',
  minN = DEFAULT_MIN_N,
  status = 'running',
  startedAt = null,
  ref = null,
}) {
  const cleanGuess = String(guess || '').trim();
  if (!cleanGuess) throw new Error('guess is required.');
  if (!VALID_SCOPES.includes(scopeType)) throw new Error(`scope_type must be one of: ${VALID_SCOPES.join(', ')}`);
  if (!['proposed', 'running'].includes(status)) throw new Error('status must be proposed or running.');
  const cleanMinN = Number(minN);
  if (!Number.isInteger(cleanMinN) || cleanMinN < 1 || cleanMinN > 10000) {
    throw new Error('min_n must be a whole number from 1 to 10000.');
  }

  const rows = readAll(root);
  const cleanRef = ref ? String(ref).trim() : null;
  if (cleanRef) {
    const existing = rows.find((r) => r.ref === cleanRef);
    if (existing) return { experiment: decorate(existing), replayed: true };
  }

  const stamp = nowIso();
  const row = {
    id: crypto.randomUUID(),
    scope_type: scopeType,
    scope_id: String(scopeId || 'general').trim(),
    loop: loop ? String(loop).trim() : null,
    guess: cleanGuess,
    status,
    verifier: String(verifier || 'manual').trim(),
    min_n: cleanMinN,
    value: null,
    learned: null,
    counts: {},
    rates: {},
    ref: cleanRef,
    started_at: startedAt || (status === 'running' ? todayIso() : null),
    decided_at: null,
    created_at: stamp,
    updated_at: stamp,
  };
  rows.push(row);
  writeAll(root, rows);
  return { experiment: decorate(row), replayed: false };
}

function list({ root, scopeType = null, scopeId = null, status = null, loop = null } = {}) {
  return readAll(root)
    .filter((row) => {
      if (scopeType && row.scope_type !== scopeType) return false;
      if (scopeId && row.scope_id !== scopeId) return false;
      if (status && row.status !== status) return false;
      if (loop && row.loop !== loop) return false;
      return true;
    })
    .sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')))
    .map(decorate);
}

function findIndex(rows, idOrPrefix) {
  const needle = String(idOrPrefix || '').trim().toLowerCase();
  if (!needle) return -1;
  const exact = rows.findIndex((r) => r.id.toLowerCase() === needle);
  if (exact >= 0) return exact;
  const matches = rows.reduce((acc, r, i) => (r.id.toLowerCase().startsWith(needle) ? [...acc, i] : acc), []);
  if (matches.length > 1) throw new Error(`Ambiguous experiment id prefix "${idOrPrefix}".`);
  return matches.length === 1 ? matches[0] : -1;
}

function score({ root, id, sample = null, rate = null, counts = null, rates = null }) {
  const rows = readAll(root);
  const idx = findIndex(rows, id);
  if (idx < 0) throw new Error(`Experiment not found: ${id}`);
  const row = rows[idx];
  const nextCounts = { ...(row.counts || {}), ...(counts || {}) };
  const nextRates = { ...(row.rates || {}), ...(rates || {}) };
  if (sample !== null && sample !== undefined) {
    const n = Number(sample);
    if (!Number.isFinite(n) || n < 0) throw new Error('sample must be a non-negative number.');
    nextCounts.sample = Math.floor(n);
  }
  if (rate !== null && rate !== undefined) {
    const r = Number(rate);
    if (!Number.isFinite(r)) throw new Error('rate must be a number.');
    nextRates.primary_rate = r;
  }
  const updated = { ...row, counts: nextCounts, rates: nextRates, updated_at: nowIso() };
  rows[idx] = updated;
  writeAll(root, rows);
  return { experiment: decorate(updated) };
}

function compare({ root, ids }) {
  if (!Array.isArray(ids) || ids.length < 2 || ids.length > 6) {
    throw new Error('Give 2 to 6 experiment ids to compare.');
  }
  const rows = readAll(root);
  const picked = ids.map((id) => {
    const idx = findIndex(rows, id);
    if (idx < 0) throw new Error(`Experiment not found: ${id}`);
    return decorate(rows[idx]);
  });
  let best = null;
  let bestRate = -Infinity;
  for (const item of picked) {
    const rate = rateOf(item);
    if (item.ready_to_decide && rate !== null && rate > bestRate) {
      best = item.id;
      bestRate = rate;
    }
  }
  return { experiments: picked, best };
}

function decide({ root, id, decision, learned = null, value = null, force = false }) {
  if (!DECISION_STATUSES.includes(decision)) {
    throw new Error(`decision must be one of: ${DECISION_STATUSES.join(', ')}`);
  }
  const rows = readAll(root);
  const idx = findIndex(rows, id);
  if (idx < 0) throw new Error(`Experiment not found: ${id}`);
  const current = decorate(rows[idx]);
  if (['accepted', 'discarded'].includes(decision) && !force && !current.ready_to_decide) {
    throw new Error(
      `Need at least ${current.min_n} samples before marking ${decision} (have ${current.sample}). Pass --force to override.`
    );
  }
  const stamp = nowIso();
  const updated = {
    ...rows[idx],
    status: decision,
    learned: learned !== null && learned !== undefined ? String(learned).trim() || null : rows[idx].learned,
    value: value !== null && value !== undefined ? Number(value) : rows[idx].value,
    decided_at: stamp,
    updated_at: stamp,
  };
  rows[idx] = updated;
  writeAll(root, rows);
  return { experiment: decorate(updated) };
}

function syncByRef({
  root,
  ref,
  scopeType = 'member_goal',
  scopeId,
  guess,
  loop = null,
  status = 'proposed',
  learned = null,
  value = null,
  minN = 1,
}) {
  const cleanRef = String(ref || '').trim();
  const cleanGuess = String(guess || '').trim();
  if (!cleanRef || !cleanGuess) return null;
  const rows = readAll(root);
  const idx = rows.findIndex((r) => r.ref === cleanRef);
  const stamp = nowIso();
  if (idx < 0) {
    const created = propose({
      root,
      scopeType,
      scopeId: String(scopeId || 'goal').trim(),
      guess: cleanGuess,
      loop,
      minN,
      status: status === 'running' ? 'running' : 'proposed',
      ref: cleanRef,
    });
    if (!['accepted', 'discarded', 'superseded', 'blocked'].includes(status)) return created.experiment;
    const latest = readAll(root);
    const createdIdx = latest.findIndex((r) => r.ref === cleanRef);
    if (createdIdx >= 0) {
      latest[createdIdx] = {
        ...latest[createdIdx],
        status,
        learned: learned || latest[createdIdx].learned,
        value: value ?? latest[createdIdx].value,
        decided_at: ['accepted', 'discarded', 'superseded'].includes(status) ? stamp : null,
        updated_at: stamp,
      };
      writeAll(root, latest);
      return decorate(latest[createdIdx]);
    }
    return created.experiment;
  }
  const next = {
    ...rows[idx],
    status: VALID_STATUSES.includes(status) ? status : rows[idx].status,
    learned: learned !== null && learned !== undefined ? String(learned).trim() || rows[idx].learned : rows[idx].learned,
    value: value !== null && value !== undefined ? Number(value) : rows[idx].value,
    decided_at: ['accepted', 'discarded', 'superseded'].includes(status) ? (rows[idx].decided_at || stamp) : rows[idx].decided_at,
    updated_at: stamp,
  };
  rows[idx] = next;
  writeAll(root, rows);
  return decorate(next);
}

const OPEN_STATUSES = new Set(['proposed', 'running']);

async function syncCloud({
  root,
  scopeType = null,
  pushOnly = false,
  dryRun = false,
  request,
  token,
}) {
  if (scopeType && !VALID_SCOPES.includes(scopeType)) {
    throw new Error(`scope_type must be one of: ${VALID_SCOPES.join(', ')}`);
  }
  if (typeof request !== 'function') {
    throw new Error('request client is required for cloud sync.');
  }

  const call = async (pathname, options = {}) => {
    const res = await request(pathname, { ...options, token });
    if (!res || !res.ok) {
      const detail = res?.data?.detail || res?.error || `HTTP ${res?.status || 'error'}`;
      throw new Error(String(detail));
    }
    return res.data || {};
  };

  const rows = readAll(root);
  const nextRows = rows.map((r) => ({ ...r }));
  let pushed = 0;
  let scored = 0;
  let decided = 0;
  let pulled = 0;
  let updated = 0;

  // 1) Push local experiments that match filter.
  for (let i = 0; i < nextRows.length; i++) {
    const row = nextRows[i];
    if (scopeType && row.scope_type !== scopeType) continue;
    const syncRef = row.ref || `cli:${row.id}`;
    const localSample = sampleOf(row);
    const localHasMetrics = localSample > 0 || Object.keys(row.counts || {}).length > 0 || Object.keys(row.rates || {}).length > 0;
    const localDecided = DECISION_STATUSES.includes(row.status);

    if (dryRun) {
      if (!row.cloud_id) pushed += 1;
      continue;
    }

    let remoteExp = null;
    if (!row.cloud_id) {
      const created = await call('/experiments', {
        method: 'POST',
        body: {
          scope_type: row.scope_type,
          scope_id: row.scope_id,
          guess: row.guess,
          loop: row.loop || undefined,
          min_n: row.min_n || DEFAULT_MIN_N,
          status: row.status === 'proposed' ? 'proposed' : 'running',
          started_at: row.started_at || undefined,
          ref: syncRef,
        },
      });
      remoteExp = created.experiment || null;
      if (!created.replayed) pushed += 1;
    }

    const cloudId = row.cloud_id || remoteExp?.id;
    if (!cloudId) continue;

    if (localHasMetrics && (!remoteExp || sampleOf(remoteExp) < localSample)) {
      const sc = await call(`/experiments/${encodeURIComponent(cloudId)}/score`, {
        method: 'POST',
        body: { counts: row.counts || {}, rates: row.rates || {} },
      });
      if (sc.experiment) remoteExp = sc.experiment;
      scored += 1;
    }

    if (localDecided && (!remoteExp || remoteExp.status !== row.status)) {
      const dec = await call(`/experiments/${encodeURIComponent(cloudId)}/decide`, {
        method: 'POST',
        body: {
          decision: row.status,
          learned: row.learned || undefined,
          value: row.value ?? undefined,
          force: true,
        },
      });
      if (dec.experiment) remoteExp = dec.experiment;
      decided += 1;
    }

    nextRows[i] = {
      ...row,
      cloud_id: cloudId,
      ref: row.ref || syncRef,
    };
  }

  // 2) Pull remote experiments and merge new rows + remote progress on shared open tests.
  if (!pushOnly) {
    const query = scopeType ? `?scope_type=${encodeURIComponent(scopeType)}` : '';
    const fetched = await call(`/experiments${query}`, { method: 'GET' });
    const remotes = Array.isArray(fetched.experiments) ? fetched.experiments : [];

    for (const remote of remotes) {
      if (!remote || !remote.id) continue;
      if (scopeType && remote.scope_type !== scopeType) continue;
      const idx = nextRows.findIndex(
        (r) => r.cloud_id === remote.id || (remote.ref && r.ref === remote.ref) || r.id === remote.id
      );

      if (idx < 0) {
        pulled += 1;
        if (!dryRun) {
          nextRows.push({
            id: remote.id,
            cloud_id: remote.id,
            scope_type: remote.scope_type,
            scope_id: remote.scope_id,
            loop: remote.loop ?? null,
            guess: remote.guess,
            status: remote.status || 'running',
            verifier: remote.verifier || 'manual',
            min_n: remote.min_n || DEFAULT_MIN_N,
            value: remote.value ?? null,
            learned: remote.learned ?? null,
            counts: remote.counts && typeof remote.counts === 'object' ? remote.counts : {},
            rates: remote.rates && typeof remote.rates === 'object' ? remote.rates : {},
            ref: remote.ref ?? null,
            started_at: remote.started_at ?? null,
            decided_at: remote.decided_at ?? null,
            created_at: remote.created_at || nowIso(),
            updated_at: remote.updated_at || nowIso(),
          });
        }
        continue;
      }

      const local = nextRows[idx];
      const remoteClosed = DECISION_STATUSES.includes(remote.status);
      const remoteMoreSamples = sampleOf(remote) > sampleOf(local);
      const shouldMerge = OPEN_STATUSES.has(local.status) && (remoteClosed || remoteMoreSamples || remote.status !== local.status);
      if (shouldMerge) {
        updated += 1;
        if (!dryRun) {
          nextRows[idx] = {
            ...local,
            cloud_id: remote.id,
            ref: local.ref || remote.ref || null,
            status: remote.status || local.status,
            counts: remote.counts && typeof remote.counts === 'object' ? remote.counts : local.counts,
            rates: remote.rates && typeof remote.rates === 'object' ? remote.rates : local.rates,
            learned: remote.learned ?? local.learned,
            value: remote.value ?? local.value,
            decided_at: remote.decided_at ?? local.decided_at,
            updated_at: remote.updated_at || nowIso(),
          };
        }
      }
    }
  }

  if (!dryRun) {
    writeAll(root, nextRows);
  }

  return {
    dry_run: Boolean(dryRun),
    pushed,
    scored,
    decided,
    pulled,
    updated,
    total: nextRows.length,
  };
}

module.exports = {
  VALID_SCOPES,
  VALID_STATUSES,
  DECISION_STATUSES,
  DEFAULT_MIN_N,
  propose,
  list,
  score,
  compare,
  decide,
  syncByRef,
  syncCloud,
};
