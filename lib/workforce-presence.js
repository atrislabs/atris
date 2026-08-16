'use strict';

const DEFAULT_STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
const PROCESS_START_TOLERANCE_MS = 30 * 60 * 1000;
const ACTIVE_TASK_STATUSES = new Set(['claimed', 'do', 'doing', 'in_progress', 'review']);
const ACTIVE_MISSION_STATUSES = new Set(['planning', 'active', 'running', 'ready']);
const RUNNING_RECEIPT_STATUSES = new Set(['active', 'in_progress', 'running', 'started', 'working']);
const TERMINAL_RECEIPT_STATUSES = new Set([
  'cancelled',
  'completed',
  'done',
  'failed',
  'landed',
  'no_output',
  'passed',
  'presumed_dead',
  'succeeded',
  'timed_out',
]);
const WORK_TOKEN_STOP_WORDS = new Set([
  'agent', 'build', 'building', 'engine', 'local', 'mission', 'process', 'running', 'task', 'working',
]);

function timestampMs(value) {
  if (value == null || value === '') return 0;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return 0;
    return value > 1000000000000 ? value : value * 1000;
  }
  const numeric = Number(value);
  if (Number.isFinite(numeric) && String(value).trim()) return timestampMs(numeric);
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

function isoTimestamp(value) {
  const ms = timestampMs(value);
  return ms ? new Date(ms).toISOString() : null;
}

function ageSeconds(value, nowMs) {
  const ms = timestampMs(value);
  return ms ? Math.max(0, Math.floor((nowMs - ms) / 1000)) : null;
}

function normalizeEngine(value) {
  const engine = String(value || '').trim().toLowerCase();
  if (!engine) return '';
  if (engine === 'cursor-agent' || engine === 'cursor agent') return 'cursor';
  if (engine === 'claude-code') return 'claude';
  return engine.replace(/[^a-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '');
}

function engineForCommand(command) {
  const text = String(command || '');
  if (/ChatGPT\.app|Codex Framework\.framework|Claude\.app/.test(text)) return '';
  const executable = text.trim().split(/\s+/)[0] || '';
  const name = executable.split('/').pop().toLowerCase();
  if (name === 'cursor-agent') return 'cursor';
  if (/^codex(?:-|$)/.test(name)) return 'codex';
  if (name === 'grok') return 'grok';
  if (name === 'devin') return 'devin';
  if (name === 'droid') return 'droid';
  if (name === 'agy') return 'agy';
  if (name === 'claude' && /(^|\s)(?:-p|--print)(?:\s|$)/.test(text)) return 'claude';
  return '';
}

function parsePsOutput(text) {
  const allRows = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 8) continue;
    const pid = Number(parts[0]);
    const ppid = Number(parts[1]);
    const command = parts.slice(7).join(' ');
    if (!Number.isInteger(pid) || pid <= 0) continue;
    const started = Date.parse(parts.slice(2, 7).join(' '));
    allRows.push({
      pid,
      ppid: Number.isInteger(ppid) && ppid > 0 ? ppid : null,
      command,
      started_at: Number.isFinite(started) ? new Date(started).toISOString() : null,
    });
  }
  const byPid = new Map(allRows.map((row) => [row.pid, row]));
  const engineRows = allRows
    .map((row) => ({ ...row, engine: engineForCommand(row.command) }))
    .filter((row) => row.engine);
  const parentPids = new Set(engineRows.map((row) => row.ppid).filter(Boolean));
  return engineRows
    .filter((row) => !parentPids.has(row.pid))
    .map((row) => {
      const ancestorPids = [];
      let parent = row.ppid;
      while (parent && !ancestorPids.includes(parent) && ancestorPids.length < 64) {
        ancestorPids.push(parent);
        parent = byPid.get(parent)?.ppid || null;
      }
      return { ...row, ancestor_pids: ancestorPids };
    });
}

function normalizeProcesses(processes) {
  const byPid = new Map();
  for (const row of Array.isArray(processes) ? processes : []) {
    const pid = Number(row?.pid);
    const engine = normalizeEngine(row?.engine) || engineForCommand(row?.command);
    if (!Number.isInteger(pid) || pid <= 0 || !engine) continue;
    byPid.set(pid, {
      pid,
      ppid: Number(row?.ppid) || null,
      engine,
      command: String(row?.command || ''),
      started_at: isoTimestamp(row?.started_at || row?.start || row?.at),
      ancestor_pids: (Array.isArray(row?.ancestor_pids) ? row.ancestor_pids : [])
        .map(Number)
        .filter((value) => Number.isInteger(value) && value > 0),
    });
  }
  return [...byPid.values()].sort((left, right) => left.pid - right.pid);
}

function taskRef(task) {
  return String(task?.display_id || task?.legacy_ref || task?.id || '').trim();
}

function taskOwner(task) {
  return String(task?.claimed_by || task?.assigned_to || task?.metadata?.assigned_to || '').trim();
}

function taskActivity(task) {
  return task?.updated_at || task?.claimed_at || task?.created_at || null;
}

function receiptTaskRefs(receipt) {
  const values = [receipt?.task_id, receipt?.task];
  if (Array.isArray(receipt?.tasks)) values.push(...receipt.tasks);
  if (Array.isArray(receipt?.task_ids)) values.push(...receipt.task_ids);
  if (Array.isArray(receipt?.results)) values.push(...receipt.results.map((row) => row?.task || row?.task_id));
  return [...new Set(values.map((value) => {
    if (value && typeof value === 'object') return value.display_id || value.id || value.task;
    return value;
  }).map((value) => String(value || '').trim()).filter(Boolean))];
}

function receiptEngine(receipt) {
  return normalizeEngine(
    receipt?.engine
      || receipt?.engines?.[0]
      || receipt?.results?.find((row) => row?.engine)?.engine,
  );
}

function receiptStatus(receipt) {
  return String(receipt?.status || '').trim().toLowerCase();
}

function isRunningReceipt(receipt) {
  return !receipt?.finished_at && RUNNING_RECEIPT_STATUSES.has(receiptStatus(receipt));
}

function isFinishedReceipt(receipt) {
  if (!receipt || isRunningReceipt(receipt)) return false;
  return Boolean(receipt.finished_at || TERMINAL_RECEIPT_STATUSES.has(receiptStatus(receipt)));
}

function receiptStartedAt(receipt, fallback) {
  return receipt?.started_at || receipt?.at || receipt?.created_at || fallback || null;
}

function receiptFinishedAt(receipt, fallback) {
  return receipt?.finished_at || receipt?.completed_at || receipt?.updated_at || fallback || null;
}

function finalResult(receipt) {
  if (typeof receipt?.result === 'string') return receipt.result.trim();
  if (receipt?.result && typeof receipt.result === 'object') {
    const kind = String(receipt.result.kind || '').trim();
    if (typeof receipt.result.passed === 'boolean') return `${kind || 'result'} ${receipt.result.passed ? 'passed' : 'failed'}`;
    if (kind) return kind;
  }
  if (receipt?.summary && typeof receipt.summary === 'object') {
    const answered = Number(receipt.summary.answered) || 0;
    const failed = Number(receipt.summary.failed) || 0;
    if (answered || failed) return `${answered} answered, ${failed} failed`;
  }
  return receiptStatus(receipt) || 'finished';
}

function taskLookup(tasks) {
  const byRef = new Map();
  for (const task of tasks) {
    for (const ref of [task?.id, task?.display_id, task?.legacy_ref]) {
      const key = String(ref || '').trim().toLowerCase();
      if (key) byRef.set(key, task);
    }
  }
  return byRef;
}

function firstTaskForRefs(refs, byRef) {
  for (const ref of refs) {
    const task = byRef.get(String(ref).toLowerCase());
    if (task) return task;
  }
  return null;
}

function rowTask(refs, task) {
  return taskRef(task) || refs[0] || null;
}

function baseRow({ member, task, title, engine, source, at, nowMs }) {
  return {
    member: member || null,
    task: task || null,
    title: title || null,
    engine: engine || null,
    source,
    at: isoTimestamp(at),
    age_seconds: ageSeconds(at, nowMs),
  };
}

function buildWorkforcePresence(input = {}) {
  const nowMs = timestampMs(input.nowMs ?? input.now ?? Date.now()) || Date.now();
  const staleAfterMs = Number(input.staleAfterMs) > 0 ? Number(input.staleAfterMs) : DEFAULT_STALE_AFTER_MS;
  const tasks = (Array.isArray(input.tasks) ? input.tasks : [])
    .filter((task) => ACTIVE_TASK_STATUSES.has(String(task?.status || '').toLowerCase()) && taskOwner(task));
  const missions = (Array.isArray(input.missions) ? input.missions : [])
    .filter((mission) => ACTIVE_MISSION_STATUSES.has(String(mission?.status || '').toLowerCase()));
  const receipts = Array.isArray(input.receipts) ? input.receipts : [];
  const processes = normalizeProcesses(input.processes);
  const byTaskRef = taskLookup(tasks);
  const usedPids = new Set();
  const representedTasks = new Set();
  const working = [];
  const waiting = [];
  const done = [];
  const stale = [];

  const claimProcess = (engine, pid, expectedStart) => {
    const wantedPid = Number(pid);
    if (Number.isInteger(wantedPid) && wantedPid > 0) {
      const exact = processes.find((row) => (
        row.pid === wantedPid || row.ancestor_pids.includes(wantedPid)
      ) && row.engine === engine && !usedPids.has(row.pid) && (
        !timestampMs(expectedStart)
        || !timestampMs(row.started_at)
        || Math.abs(timestampMs(row.started_at) - timestampMs(expectedStart)) <= PROCESS_START_TOLERANCE_MS
      ));
      if (exact) usedPids.add(exact.pid);
      return exact || null;
    }
    return null;
  };
  const workTokens = (value) => new Set(
    (String(value || '').toLowerCase().match(/[a-z][a-z0-9]{4,}/g) || [])
      .filter((token) => !WORK_TOKEN_STOP_WORDS.has(token)),
  );
  const processMatchesWork = (row, refs, title) => {
    const command = String(row.command || '').toLowerCase();
    if (refs.some((ref) => command.includes(String(ref).toLowerCase()))) return true;
    const titleTokens = workTokens(title);
    const commandTokens = workTokens(command);
    return [...titleTokens].some((token) => commandTokens.has(token));
  };
  const claimMatchingProcess = (engine, refs, title) => {
    const candidate = processes.find((row) => (
      (!engine || row.engine === engine)
      && !usedPids.has(row.pid)
      && processMatchesWork(row, refs, title)
    ));
    if (candidate) usedPids.add(candidate.pid);
    return candidate || null;
  };

  for (const entry of receipts) {
    const receipt = entry?.receipt || entry;
    const engine = receiptEngine(receipt);
    if (!engine) continue;
    const refs = receiptTaskRefs(receipt);
    const task = firstTaskForRefs(refs, byTaskRef);
    const member = String(receipt?.member || receipt?.owner || receipt?.actor || taskOwner(task) || '').trim();
    const taskValue = rowTask(refs, task);
    const startedAt = receiptStartedAt(receipt, entry?.mtimeMs);
    const common = baseRow({
      member,
      task: taskValue,
      title: task?.title || receipt?.objective || '',
      engine,
      source: 'receipt',
      at: startedAt,
      nowMs,
    });
    if (isRunningReceipt(receipt)) {
      const processRow = claimProcess(engine, receipt.pid, startedAt)
        || claimMatchingProcess(engine, refs, task?.title || receipt?.objective || '');
      const row = {
        ...common,
        pid: processRow?.pid || Number(receipt.pid) || null,
        receipt: entry?.name || receipt?.receipt || null,
      };
      if (processRow) working.push(row);
      else if (Number(receipt.pid) > 0 || nowMs - timestampMs(startedAt) > staleAfterMs) {
        stale.push({ ...row, reason: 'run has no live process' });
      } else {
        waiting.push({ ...row, reason: 'run has not started a local process' });
      }
      if (taskValue) representedTasks.add(String(taskValue).toLowerCase());
      continue;
    }
    if (isFinishedReceipt(receipt)) {
      done.push({
        ...common,
        at: isoTimestamp(receiptFinishedAt(receipt, entry?.mtimeMs)),
        age_seconds: ageSeconds(receiptFinishedAt(receipt, entry?.mtimeMs), nowMs),
        run_status: receiptStatus(receipt) || 'finished',
        result: finalResult(receipt),
        receipt: entry?.name || receipt?.receipt || null,
      });
    }
  }

  for (const mission of missions) {
    const refs = Array.isArray(mission?.task_ids) ? mission.task_ids.map(String) : [];
    if (refs.some((ref) => representedTasks.has(ref.toLowerCase()))) continue;
    const task = firstTaskForRefs(refs, byTaskRef);
    const engine = normalizeEngine(mission?.runner || mission?.engine || mission?.executed_by);
    const member = String(mission?.owner || mission?.member || taskOwner(task) || '').trim();
    const at = mission?.last_tick_at || mission?.updated_at || mission?.created_at;
    const common = baseRow({
      member,
      task: rowTask(refs, task),
      title: task?.title || mission?.objective || mission?.name || '',
      engine,
      source: 'mission',
      at,
      nowMs,
    });
    const processRow = engine
      ? claimProcess(engine, mission?.pid, at) || claimMatchingProcess(engine, refs, common.title)
      : null;
    if (processRow) working.push({ ...common, pid: processRow.pid, mission: mission?.id || null });
    else if (nowMs - timestampMs(at) > staleAfterMs) stale.push({ ...common, reason: 'mission has no live process', mission: mission?.id || null });
    else waiting.push({ ...common, reason: 'mission is waiting for a local process', mission: mission?.id || null });
    for (const ref of refs) representedTasks.add(ref.toLowerCase());
  }

  for (const task of tasks) {
    const ref = taskRef(task);
    if (representedTasks.has(ref.toLowerCase())) continue;
    const engine = normalizeEngine(task?.executed_by || task?.metadata?.executed_by || task?.metadata?.engine);
    const at = taskActivity(task);
    const common = baseRow({
      member: taskOwner(task),
      task: ref,
      title: task?.title || '',
      engine,
      source: 'task',
      at,
      nowMs,
    });
    const processRow = claimProcess(engine, task?.pid || task?.metadata?.pid, at)
      || claimMatchingProcess(engine, [ref], '');
    if (processRow) working.push({ ...common, engine: processRow.engine, pid: processRow.pid });
    else if (nowMs - timestampMs(at) > staleAfterMs) stale.push({ ...common, reason: 'claim is older than seven days with no live process' });
    else waiting.push({ ...common, reason: 'claim has no live process yet' });
  }

  const unowned = processes
    .filter((row) => !usedPids.has(row.pid))
    .map((row) => ({
      engine: row.engine,
      pid: row.pid,
      command: row.command,
      started_at: row.started_at,
      age_seconds: ageSeconds(row.started_at, nowMs),
      reason: 'no matching claim, mission, or run receipt',
    }));

  const newestFirst = (left, right) => timestampMs(right.at || right.started_at) - timestampMs(left.at || left.started_at);
  working.sort(newestFirst);
  waiting.sort(newestFirst);
  done.sort(newestFirst);
  stale.sort(newestFirst);

  return {
    schema: 'atris.workforce_presence.v1',
    generated_at: new Date(nowMs).toISOString(),
    stale_after_seconds: Math.round(staleAfterMs / 1000),
    totals: {
      working: working.length,
      waiting: waiting.length,
      done: done.length,
      stale: stale.length,
      unowned: unowned.length,
    },
    working,
    waiting,
    done,
    stale,
    unowned,
  };
}

function formatAge(seconds) {
  if (seconds == null) return 'age unknown';
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function rowSubject(row) {
  const member = row.member || 'unassigned';
  const task = row.task || row.title || 'local work';
  return `${member}: ${row.engine || 'unknown engine'} on ${task}`;
}

function renderWorkforcePresence(presence) {
  const lines = [];
  const section = (name, rows, render, limit = rows.length) => {
    lines.push(`${name}:`);
    if (!rows.length) lines.push('  none');
    else rows.slice(0, limit).forEach((row) => lines.push(`  ${render(row)}`));
    if (rows.length > limit) lines.push(`  ${rows.length - limit} more; clear finished runs with atris who --clear`);
  };
  section('working', presence.working, (row) => `${rowSubject(row)} (${formatAge(row.age_seconds)}, pid ${row.pid || '?'})`);
  section('waiting', presence.waiting, (row) => `${rowSubject(row)} (${formatAge(row.age_seconds)}), ${row.reason}`);
  section('done', presence.done, (row) => `${rowSubject(row)} (${formatAge(row.age_seconds)}), ${row.run_status}: ${row.result}`, 10);
  section('stale', presence.stale, (row) => `${rowSubject(row)} (${formatAge(row.age_seconds)}), ${row.reason}`);
  section('unowned', presence.unowned, (row) => `${row.engine} pid ${row.pid} (${formatAge(row.age_seconds)}), ${row.reason}`);
  const totals = presence.totals;
  lines.push(`totals: ${totals.working} working, ${totals.waiting} waiting, ${totals.done} done, ${totals.stale} stale, ${totals.unowned} unowned`);
  return lines.join('\n');
}

module.exports = {
  buildWorkforcePresence,
  isFinishedReceipt,
  parsePsOutput,
  receiptEngine,
  renderWorkforcePresence,
};
