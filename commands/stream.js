'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { collectBoard } = require('./land');
const { listWorktrees } = require('./worktree');

const DEFAULT_INTERVAL_MS = 3000;
const DEFAULT_TAIL_LIMIT = 200;
const MAX_SUMMARY = 180;
const ACTIVE_MISSION_STATES = new Set(['planning', 'active', 'running', 'ready']);
const ACTIVE_TASK_STATES = new Set(['claimed', 'do', 'doing', 'in_progress', 'review']);

function defaultDeps() {
  return {
    existsSync: fs.existsSync,
    readFileSync: fs.readFileSync,
    readdirSync: fs.readdirSync,
    statSync: fs.statSync,
    watch: fs.watch,
    spawnSync,
    now: () => Date.now(),
  };
}

function hasFlag(args, name) {
  return args.includes(name);
}

function readFlag(args, name, fallback = '') {
  const prefix = `${name}=`;
  for (let i = 0; i < args.length; i += 1) {
    const arg = String(args[i] || '');
    if (arg === name && args[i + 1] && !String(args[i + 1]).startsWith('--')) return String(args[i + 1]);
    if (arg.startsWith(prefix)) return arg.slice(prefix.length);
  }
  return fallback;
}

function timestampMs(value) {
  if (value == null || value === '') return 0;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return 0;
    return value > 1000000000000 ? value : value * 1000;
  }
  const asNumber = Number(value);
  if (Number.isFinite(asNumber) && String(value).trim() !== '') return timestampMs(asNumber);
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

function isoFrom(value) {
  const ms = timestampMs(value);
  return ms ? new Date(ms).toISOString() : '';
}

function safeJson(text, fallback = null) {
  try {
    return JSON.parse(String(text));
  } catch {
    return fallback;
  }
}

function readJson(file, deps, fallback = null) {
  try {
    if (!deps.existsSync(file)) return fallback;
    return safeJson(deps.readFileSync(file, 'utf8'), fallback);
  } catch {
    return fallback;
  }
}

function readJsonl(file, deps, { tail = DEFAULT_TAIL_LIMIT } = {}) {
  try {
    if (!deps.existsSync(file)) return [];
    const lines = String(deps.readFileSync(file, 'utf8')).split(/\r?\n/).filter(Boolean);
    return lines.slice(-tail).map((line) => safeJson(line)).filter(Boolean);
  } catch {
    return [];
  }
}

function listDir(dir, deps) {
  try {
    if (!deps.existsSync(dir)) return [];
    return deps.readdirSync(dir);
  } catch {
    return [];
  }
}

function isDirectory(file, deps) {
  try {
    return deps.existsSync(file) && deps.statSync(file).isDirectory();
  } catch {
    return false;
  }
}

function runGit(root, args, deps) {
  try {
    const result = deps.spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    return result && typeof result.status === 'number' ? result : { status: 1, stdout: '', stderr: '' };
  } catch {
    return { status: 1, stdout: '', stderr: '' };
  }
}

function repoRoot(cwd = process.cwd(), deps = defaultDeps()) {
  const result = runGit(cwd, ['rev-parse', '--show-toplevel'], deps);
  return result.status === 0 && result.stdout ? result.stdout.trim() : path.resolve(cwd);
}

function firstText(...values) {
  for (const value of values) {
    const text = String(value == null ? '' : value)
      .split(/\r?\n/)
      .map((line) => line.trim().replace(/^[-*]\s+/, ''))
      .find(Boolean);
    if (text) return text;
  }
  return '';
}

function clip(value, limit = MAX_SUMMARY) {
  const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit - 3)}...` : text;
}

function sentence(value, fallback = 'updated the work') {
  let text = clip(firstText(value) || fallback);
  text = text.replace(/^(summary|result|receipt|final answer|changed|proof):\s*/i, '');
  if (!/[.!?]$/.test(text)) text += '.';
  return text;
}

function taskTitle(task) {
  return clip(task && (task.title || task.objective || task.result), 90) || 'the task';
}

function payloadText(payload, ...keys) {
  if (!payload || typeof payload !== 'object') return '';
  for (const key of keys) {
    if (payload[key] != null && payload[key] !== '') return payload[key];
  }
  return '';
}

function taskEventSummary(task, event = {}) {
  const payload = event.payload || {};
  const title = taskTitle(task);
  const type = String(event.event_type || event.type || 'updated');
  if (type === 'claimed') return `started ${title}`;
  if (type === 'proof_ready' || type === 'ready') return `finished ${title}; proof is ready`;
  if (type === 'completed' || type === 'done') return `finished ${title}`;
  if (type === 'accepted' || type === 'auto_accepted') return `accepted ${title}`;
  if (type === 'revision_requested') return `bounced ${title}: ${payloadText(payload, 'lesson', 'summary', 'reason') || 'needs another pass'}`;
  if (type === 'reviewed') {
    const reward = Number(payload.reward);
    if (Number.isFinite(reward) && reward < 0) return `bounced ${title}: ${payloadText(payload, 'lesson', 'summary') || 'review failed'}`;
    return `validated ${title}`;
  }
  if (type === 'message' || type === 'comment') return `left a note on ${title}`;
  return `updated ${title}`;
}

function taskStateSummary(task) {
  const title = taskTitle(task);
  const status = String(task && task.status || 'updated');
  if (status === 'claimed' || status === 'do' || status === 'doing') return `started ${title}`;
  if (status === 'review') return `sent ${title} to review`;
  if (status === 'done') return `finished ${title}`;
  if (status === 'blocked' || status === 'failed') return `got blocked on ${title}`;
  return `updated ${title}`;
}

function taskEpisodeSummary(row) {
  const state = row && row.state || {};
  const action = row && row.action || {};
  const title = taskTitle(state);
  const type = String(action.event_type || row.action || 'reviewed');
  const reward = Number(row?.reward?.value ?? row?.reward);
  if (type === 'revision_requested' || (Number.isFinite(reward) && reward < 0)) {
    return `bounced ${title}: ${row.lesson || 'needs another pass'}`;
  }
  if (type === 'reviewed') return `validated ${title}`;
  return `recorded feedback on ${title}`;
}

function scorecardSummary(row) {
  const shipped = row && (row.what_shipped || row.summary || row.title || row.next_task_suggestion);
  if (row && row.verify_passed === false) return `hit a failed check on ${shipped || 'the latest tick'}`;
  if (shipped) return `finished ${shipped}`;
  const reward = Number(row && row.reward);
  if (Number.isFinite(reward) && reward < 0) return 'recorded a negative scorecard';
  return 'recorded a scorecard';
}

function missionEventSummary(row) {
  const payload = row && row.payload || {};
  const type = String(row && (row.type || row.event || row.action) || 'mission_event');
  const text = firstText(payload.summary, payload.objective, payload.reason, payload.next_action, row.summary, row.reason);
  if (/start/.test(type)) return `started ${text || 'a mission'}`;
  if (/tick/.test(type)) return `ran a mission tick${text ? `: ${text}` : ''}`;
  if (/complete|done|ready/.test(type)) return `finished ${text || 'a mission'}`;
  if (/pause|block|fail|error|stop/.test(type)) return `got blocked${text ? `: ${text}` : ''}`;
  return text || 'updated a mission';
}

function missionStateSummary(mission) {
  const objective = clip(mission.objective || mission.title || mission.next_action || 'the mission', 100);
  const status = String(mission.status || 'active');
  if (status === 'ready') return `finished ${objective}; proof is ready`;
  if (status === 'paused' || status === 'blocked') return `paused ${objective}; waiting on operator`;
  if (status === 'complete' || status === 'done') return `completed ${objective}`;
  return `is working on ${objective}`;
}

function tickSummary(tick) {
  const text = firstText(
    tick.summary,
    tick.result,
    tick.reason,
    tick.atris2 && tick.atris2.summary,
    tick.claude && tick.claude.summary,
    tick.atris2 && tick.atris2.receipt_text,
    tick.claude && tick.claude.receipt_text,
  );
  const pass = tick.verifier_passed === true || tick.verifier_result?.passed === true;
  const fail = tick.verifier_passed === false || tick.verifier_result?.passed === false || /fail|error|blocked/i.test(tick.status || tick.reason || '');
  if (fail) return text ? `hit a failed check: ${text}` : 'hit a failed check during a mission tick';
  if (pass && text) return `${text}; checks passed`;
  return text || 'ran a mission tick';
}

function landingSummary(result) {
  const landing = result && result.landing || {};
  return firstText(landing.changed, landing.happened, landing.summary, result.summary, result.reason) || 'recorded a mission landing';
}

function sanitizeAgent(value) {
  let text = String(value || '').trim();
  if (!text) return 'team';
  if (text.includes('/')) text = text.split('/')[0];
  text = text.replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '');
  return clip(text || 'team', 32);
}

function stripLeadingAgent(summary, agent) {
  const cleanAgent = String(agent || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!cleanAgent) return summary;
  return String(summary || '').replace(new RegExp(`^${cleanAgent}\\s+`, 'i'), '');
}

function sanitizeSummary(value, agent = '') {
  let text = sentence(stripLeadingAgent(value, agent));
  text = text
    .replace(/\b[0-9A-HJKMNP-TV-Z]{20,26}\b/g, 'the item')
    .replace(/\b[A-Z]{2,12}-\d+\b/g, 'the task')
    .replace(/\bmission-[a-z0-9][a-z0-9-]{8,}\b/ig, 'the mission')
    .replace(/\b(?:refs\/heads\/|origin\/)?(?:codex|agent|feature|fix|chore|bugfix)\/[A-Za-z0-9._/-]+/g, 'the branch')
    .replace(/(^|\s)~\/[^\s,;:)]+/g, '$1the workspace')
    .replace(/(^|\s)\/[^\s,;:)]+/g, '$1the workspace')
    .replace(/\b(?:\.{1,2}\/)?(?:\.atris|atris\/runs|commands|lib|test|bin|scripts)\/[^\s,;:)]+/g, 'the workspace')
    .replace(/\s+/g, ' ')
    .trim();
  if (!/[.!?]$/.test(text)) text += '.';
  return clip(text);
}

function makeEvent({ ts, agent, event, summary, raw, source, root }) {
  const ms = timestampMs(ts);
  if (!ms) return null;
  const cleanAgent = sanitizeAgent(agent);
  const cleanSummary = sanitizeSummary(summary, cleanAgent);
  return {
    ts: new Date(ms).toISOString(),
    ms,
    agent: cleanAgent,
    event: String(event || source || 'event'),
    summary: cleanSummary,
    raw: raw || null,
    source: source || 'state',
    root: root || null,
  };
}

function eventKey(record) {
  const raw = record.raw || {};
  return [
    record.event,
    record.ts,
    record.agent,
    raw.event_id || raw.episode_id || raw.receipt_path || raw.file || raw.path || raw.task_id || raw.mission_id || '',
    raw.index != null ? raw.index : '',
    record.summary,
  ].join('|');
}

function pushEvent(events, input) {
  const event = makeEvent(input);
  if (event) events.push({ ...event, key: eventKey(event) });
}

function statePaths(root) {
  const stateDir = path.join(root, '.atris', 'state');
  return {
    stateDir,
    tasksProjection: path.join(stateDir, 'tasks.projection.json'),
    missions: path.join(stateDir, 'missions.jsonl'),
    missionEvents: path.join(stateDir, 'mission_events.jsonl'),
    scorecards: path.join(stateDir, 'scorecards.jsonl'),
    taskEpisodes: path.join(stateDir, 'task_episodes.jsonl'),
    runsDir: path.join(root, 'atris', 'runs'),
    sidecar: path.join(root, '.atris', 'agent-worktree.json'),
  };
}

function readMissionMap(root, deps) {
  const map = new Map();
  for (const mission of readJsonl(statePaths(root).missions, deps, { tail: 1000 })) {
    if (mission && mission.id) map.set(String(mission.id), mission);
  }
  return map;
}

function collectTaskProjectionEvents(root, deps, events) {
  const projection = readJson(statePaths(root).tasksProjection, deps, {});
  const tasks = Array.isArray(projection && projection.tasks) ? projection.tasks : [];
  for (const task of tasks) {
    const taskEvents = Array.isArray(task.events) ? task.events : [];
    if (!taskEvents.length && task.updated_at) {
      pushEvent(events, {
        ts: task.updated_at,
        agent: task.claimed_by || task.assigned_to || task.metadata?.assigned_to || 'team',
        event: `task_${task.status || 'updated'}`,
        summary: taskStateSummary(task),
        raw: { source: 'tasks.projection.json', task },
        source: 'task',
        root,
      });
      continue;
    }
    for (const taskEvent of taskEvents) {
      pushEvent(events, {
        ts: taskEvent.created_at,
        agent: taskEvent.actor || task.claimed_by || task.assigned_to || task.metadata?.assigned_to || 'team',
        event: `task_${taskEvent.event_type || 'event'}`,
        summary: taskEventSummary(task, taskEvent),
        raw: { source: 'tasks.projection.json', task_id: task.id, task_title: task.title, ...taskEvent },
        source: 'task',
        root,
      });
    }
  }
}

function collectTaskEpisodeEvents(root, deps, events) {
  for (const row of readJsonl(statePaths(root).taskEpisodes, deps)) {
    pushEvent(events, {
      ts: row.created_at || row.ts,
      agent: row.action?.actor || row.state?.claimed_by || row.actor || 'team',
      event: `task_${row.action?.event_type || row.action || 'episode'}`,
      summary: taskEpisodeSummary(row),
      raw: row,
      source: 'task_episode',
      root,
    });
  }
}

function collectScorecardEvents(root, deps, events) {
  for (const row of readJsonl(statePaths(root).scorecards, deps)) {
    pushEvent(events, {
      ts: row.ts || row.created_at || row.updated_at,
      agent: row.member || row.actor || row.source || 'team',
      event: row.verify_passed === false ? 'scorecard_failed' : 'scorecard',
      summary: scorecardSummary(row),
      raw: row,
      source: 'scorecard',
      root,
    });
  }
}

function collectMissionEvents(root, deps, events) {
  const paths = statePaths(root);
  for (const mission of readJsonl(paths.missions, deps, { tail: 1000 })) {
    const status = String(mission.status || '');
    if (!ACTIVE_MISSION_STATES.has(status)) continue;
    pushEvent(events, {
      ts: mission.last_tick_at || mission.updated_at || mission.created_at || mission.started_at,
      agent: mission.owner || mission.member || mission.runner || 'team',
      event: `mission_${status || 'active'}`,
      summary: missionStateSummary(mission),
      raw: mission,
      source: 'mission_state',
      root,
    });
  }
  for (const row of readJsonl(paths.missionEvents, deps)) {
    pushEvent(events, {
      ts: row.at || row.ts || row.created_at,
      agent: row.actor || row.owner || row.payload?.owner || 'team',
      event: row.type || row.event || 'mission_event',
      summary: missionEventSummary(row),
      raw: row,
      source: 'mission_event',
      root,
    });
  }
}

function collectRunReceiptEvents(root, deps, events) {
  const paths = statePaths(root);
  const missionMap = readMissionMap(root, deps);
  const files = listDir(paths.runsDir, deps)
    .filter((file) => file.endsWith('.json'))
    .sort();
  for (const file of files.slice(-DEFAULT_TAIL_LIMIT)) {
    const fullPath = path.join(paths.runsDir, file);
    const receipt = readJson(fullPath, deps, null);
    if (!receipt || receipt.schema !== 'atris.mission_receipt.v1') continue;
    const mission = missionMap.get(String(receipt.mission_id || '')) || {};
    const agent = receipt.owner || mission.owner || 'team';
    const result = receipt.result || {};
    if (result.tick) {
      pushEvent(events, {
        ts: result.tick.finished_at || result.tick.started_at || receipt.at,
        agent,
        event: result.kind || 'mission_tick',
        summary: tickSummary(result.tick),
        raw: { ...receipt, file: fullPath, result: { ...result, tick: result.tick } },
        source: 'mission_receipt',
        root,
      });
    }
    if (Array.isArray(result.ticks)) {
      result.ticks.forEach((tick, index) => {
        pushEvent(events, {
          ts: tick.finished_at || tick.started_at || receipt.at,
          agent,
          event: 'mission_tick',
          summary: tickSummary(tick),
          raw: { ...receipt, file: fullPath, index, tick },
          source: 'mission_receipt',
          root,
        });
      });
    }
    if (result.landing) {
      pushEvent(events, {
        ts: receipt.at || result.finished_at || result.created_at,
        agent,
        event: result.kind || 'mission_landing',
        summary: landingSummary(result),
        raw: { ...receipt, file: fullPath },
        source: 'mission_landing',
        root,
      });
    }
  }
}

function candidateWorktreeDirs(root, deps) {
  const dirs = new Set([
    path.resolve(root, '..', '.agent-worktrees'),
    path.join(path.dirname(root), '.agent-worktrees', path.basename(root)),
  ]);
  const sidecar = readJson(statePaths(root).sidecar, deps, null);
  if (sidecar && sidecar.workspace_root) {
    dirs.add(path.join(path.dirname(sidecar.workspace_root), '.agent-worktrees', path.basename(sidecar.workspace_root)));
  }
  const parts = path.resolve(root).split(path.sep);
  const idx = parts.lastIndexOf('.agent-worktrees');
  if (idx >= 0 && parts[idx + 1]) {
    dirs.add(parts.slice(0, idx + 2).join(path.sep) || path.sep);
  }
  return [...dirs];
}

function discoverAgentWorktreeRoots(root, deps) {
  const found = new Set();
  const scanOne = (dir, depth = 0) => {
    if (!isDirectory(dir, deps) || depth > 1) return;
    for (const name of listDir(dir, deps)) {
      const child = path.join(dir, name);
      if (!isDirectory(child, deps)) continue;
      if (deps.existsSync(path.join(child, '.atris', 'agent-worktree.json'))) {
        found.add(child);
        continue;
      }
      scanOne(child, depth + 1);
    }
  };
  for (const dir of candidateWorktreeDirs(root, deps)) scanOne(dir);
  return [...found];
}

function gitWorktrees(root, deps) {
  if (deps.listWorktrees) {
    try {
      return deps.listWorktrees(root) || [];
    } catch {
      return [];
    }
  }
  try {
    return listWorktrees(root) || [];
  } catch {
    return [];
  }
}

function collectWorkspaceRoots(root, deps) {
  const out = new Map();
  const add = (workspaceRoot, reason) => {
    if (!workspaceRoot) return;
    const resolved = path.resolve(workspaceRoot);
    if (!out.has(resolved)) out.set(resolved, { root: resolved, reason });
  };
  add(root, 'current');
  for (const wt of gitWorktrees(root, deps)) add(wt.path, 'git_worktree');
  for (const wtRoot of discoverAgentWorktreeRoots(root, deps)) add(wtRoot, 'agent_worktree_dir');
  return [...out.values()];
}

function worktreeOwner(root, deps) {
  const sidecar = readJson(statePaths(root).sidecar, deps, null);
  if (sidecar) return sidecar.owner || sidecar.member || sidecar.agent || '';
  const result = runGit(root, ['config', '--get-regexp', '^branch\\..*\\.atris-owner$'], deps);
  if (result.status === 0) {
    const line = String(result.stdout || '').split(/\r?\n/).find(Boolean);
    if (line) return line.split(/\s+/).slice(1).join(' ');
  }
  return '';
}

function worktreeTask(root, deps) {
  const sidecar = readJson(statePaths(root).sidecar, deps, null);
  if (sidecar && sidecar.task) return sidecar.task;
  const result = runGit(root, ['config', '--get-regexp', '^branch\\..*\\.atris-task$'], deps);
  if (result.status === 0) {
    const line = String(result.stdout || '').split(/\r?\n/).find(Boolean);
    if (line) return line.split(/\s+/).slice(1).join(' ');
  }
  return '';
}

function collectWorktreeActivityEvents(root, deps, events) {
  const roots = collectWorkspaceRoots(root, deps);
  for (const item of roots) {
    const owner = worktreeOwner(item.root, deps);
    if (!owner) continue;
    const log = runGit(item.root, ['log', '-1', '--format=%cI%x09%an%x09%s'], deps);
    if (log.status !== 0 || !String(log.stdout || '').trim()) continue;
    const [ts, author, subject] = String(log.stdout || '').trim().split('\t');
    pushEvent(events, {
      ts,
      agent: owner || author || 'agent',
      event: 'worktree_commit',
      summary: `committed ${subject || worktreeTask(item.root, deps) || 'worktree changes'}`,
      raw: { root: item.root, reason: item.reason, owner, task: worktreeTask(item.root, deps), author, subject },
      source: 'worktree',
      root: item.root,
    });
  }
}

function collectLandingStateEvent(root, deps, events, nowMs) {
  try {
    const board = collectBoard(root);
    const summary = board && board.summary || {};
    const active = Number(summary.active || 0);
    const due = Number(summary.due || 0);
    const landed = Number(summary.landed || 0);
    const worktrees = Number(summary.worktrees || 0);
    if (!active && !due && !landed && !worktrees) return;
    const pieces = [];
    if (active) pieces.push(`${active} active`);
    if (due) pieces.push(`${due} overdue`);
    if (landed) pieces.push(`${landed} landed and ready to clear`);
    if (worktrees) pieces.push(`${worktrees} side copies`);
    pushEvent(events, {
      ts: nowMs,
      agent: 'landing',
      event: 'landing_state',
      summary: `landing board has ${pieces.join(', ')}`,
      raw: board,
      source: 'landing',
      root,
    });
  } catch {
    // Landing state is advisory; stream should still run outside git repos.
  }
}

function collectStreamEvents({ root = process.cwd(), sinceMs = 0, agent = '', nowMs = Date.now(), deps = defaultDeps() } = {}) {
  const allDeps = { ...defaultDeps(), ...deps };
  const events = [];
  const roots = collectWorkspaceRoots(root, allDeps);
  for (const item of roots) {
    collectMissionEvents(item.root, allDeps, events);
    collectRunReceiptEvents(item.root, allDeps, events);
    collectTaskProjectionEvents(item.root, allDeps, events);
    collectTaskEpisodeEvents(item.root, allDeps, events);
    collectScorecardEvents(item.root, allDeps, events);
  }
  collectWorktreeActivityEvents(root, allDeps, events);
  collectLandingStateEvent(root, allDeps, events, nowMs);
  const wantedAgent = agent ? sanitizeAgent(agent).toLowerCase() : '';
  const byKey = new Map();
  for (const event of events) {
    if (sinceMs && event.ms < sinceMs) continue;
    if (wantedAgent && event.agent.toLowerCase() !== wantedAgent) continue;
    byKey.set(event.key, event);
  }
  return [...byKey.values()].sort((a, b) => (a.ms - b.ms) || a.event.localeCompare(b.event));
}

function waitingOnOperator(tasks) {
  return tasks.filter((task) => {
    const review = task.review || {};
    const metadata = task.metadata || {};
    const handoff = review.handoff || metadata.handoff || {};
    const action = String(handoff.next_action || metadata.next_action || review.next_action || '');
    const approval = String(review.approval_status || metadata.approval_status || '');
    return task.status === 'blocked'
      || action === 'human_accept_waiting'
      || /human|operator|approval|waiting/i.test(approval)
      || metadata.agent_certified === true
      || review.agent_certified === true;
  });
}

function collectSnapshot({ root = process.cwd(), deps = defaultDeps() } = {}) {
  const allDeps = { ...defaultDeps(), ...deps };
  const active = new Map();
  const waiting = [];
  for (const item of collectWorkspaceRoots(root, allDeps)) {
    const projection = readJson(statePaths(item.root).tasksProjection, allDeps, {});
    const tasks = Array.isArray(projection && projection.tasks) ? projection.tasks : [];
    for (const task of tasks) {
      const owner = task.claimed_by || task.assigned_to || task.metadata?.assigned_to || '';
      if (owner && ACTIVE_TASK_STATES.has(String(task.status || ''))) active.set(sanitizeAgent(owner), taskTitle(task));
    }
    waiting.push(...waitingOnOperator(tasks));
    for (const mission of readJsonl(statePaths(item.root).missions, allDeps, { tail: 1000 })) {
      if (!ACTIVE_MISSION_STATES.has(String(mission.status || ''))) continue;
      active.set(sanitizeAgent(mission.owner || mission.member || 'team'), clip(mission.objective || mission.next_action || 'mission work', 90));
    }
    const owner = worktreeOwner(item.root, allDeps);
    if (owner) active.set(sanitizeAgent(owner), clip(worktreeTask(item.root, allDeps) || 'worktree changes', 90));
  }
  let landingWait = 0;
  try {
    const board = collectBoard(root);
    landingWait = Number(board?.summary?.due || 0);
  } catch {}
  const activeRows = [...active.entries()];
  const lines = [];
  lines.push(`Team stream: ${activeRows.length} active agent${activeRows.length === 1 ? '' : 's'}.`);
  const shown = activeRows.slice(0, 3).map(([agent, work]) => `${agent}: ${sanitizeSummary(work, agent).replace(/[.!?]$/, '')}`);
  const more = activeRows.length > shown.length ? `, +${activeRows.length - shown.length} more` : '';
  lines.push(`On now: ${shown.length ? `${shown.join('; ')}${more}.` : 'no active work found on disk.'}`);
  const waits = [];
  if (waiting.length) waits.push(`${waiting.length} review${waiting.length === 1 ? '' : 's'}`);
  if (landingWait) waits.push(`${landingWait} overdue landing${landingWait === 1 ? '' : 's'}`);
  lines.push(`Waiting on operator: ${waits.length ? waits.join(', ') : 'nothing obvious'}.`);
  lines.push('Watching missions, task events, scorecards, landings, and worktrees. Ctrl-C exits.');
  return { active_agents: activeRows.length, active: activeRows, waiting_operator: waiting.length, landing_wait: landingWait, lines };
}

function formatTs(ts) {
  const iso = isoFrom(ts);
  return iso ? iso.replace('T', ' ').replace(/\.\d{3}Z$/, 'Z') : String(ts || '');
}

function renderTextLine(record, { raw = false } = {}) {
  const line = `${formatTs(record.ts)} ${sanitizeAgent(record.agent)} ${sanitizeSummary(record.summary, record.agent)}`;
  if (!raw) return line;
  return `${line} raw=${JSON.stringify(record.raw)}`;
}

function renderJsonLine(record) {
  return JSON.stringify({
    ts: record.ts,
    agent: sanitizeAgent(record.agent),
    event: record.event,
    summary: sanitizeSummary(record.summary, record.agent),
    raw: record.raw || null,
  });
}

function renderRecords(records, opts = {}) {
  return records.map((record) => (opts.json ? renderJsonLine(record) : renderTextLine(record, opts))).join('\n');
}

function snapshotRecords(snapshot, nowMs) {
  return snapshot.lines.map((line, index) => makeEvent({
    ts: nowMs,
    agent: 'team',
    event: 'snapshot',
    summary: line,
    raw: { line: index + 1, snapshot: { active_agents: snapshot.active_agents, waiting_operator: snapshot.waiting_operator, landing_wait: snapshot.landing_wait } },
    source: 'snapshot',
  }));
}

function parseSince(value, nowMs = Date.now()) {
  const raw = String(value || '').trim();
  if (!raw) return 0;
  const match = raw.match(/^(\d+(?:\.\d+)?)(s|m|h|d)$/i);
  if (match) {
    const n = Number(match[1]);
    const unit = match[2].toLowerCase();
    const scale = unit === 's' ? 1000 : unit === 'm' ? 60000 : unit === 'h' ? 3600000 : 86400000;
    return nowMs - n * scale;
  }
  const parsed = Date.parse(raw);
  if (Number.isFinite(parsed)) return parsed;
  throw new Error(`invalid --since value: ${value}`);
}

function parseArgs(args = [], nowMs = Date.now()) {
  const sinceRaw = readFlag(args, '--since', '');
  const intervalRaw = readFlag(args, '--interval', '');
  const interval = Number(intervalRaw);
  return {
    agent: readFlag(args, '--agent', ''),
    sinceMs: parseSince(sinceRaw, nowMs),
    json: hasFlag(args, '--json'),
    raw: hasFlag(args, '--raw'),
    once: hasFlag(args, '--once'),
    intervalMs: Number.isFinite(interval) && interval > 0 ? Math.max(250, interval * 1000) : DEFAULT_INTERVAL_MS,
  };
}

function createStreamState({ root, sinceMs = 0, agent = '', deps = defaultDeps(), nowMs = Date.now(), skipExisting = false } = {}) {
  const seen = new Set();
  if (skipExisting) {
    for (const event of collectStreamEvents({ root, sinceMs, agent, deps, nowMs })) seen.add(event.key);
  }
  return { seen };
}

function pollStreamOnce(state, { root, sinceMs = 0, agent = '', deps = defaultDeps(), nowMs = Date.now() } = {}) {
  const events = collectStreamEvents({ root, sinceMs, agent, deps, nowMs });
  const fresh = [];
  for (const event of events) {
    if (state.seen.has(event.key)) continue;
    state.seen.add(event.key);
    fresh.push(event);
  }
  return fresh;
}

function showHelp() {
  console.log('');
  console.log('atris stream - watch the whole team work live');
  console.log('');
  console.log('  atris stream');
  console.log('  atris stream --agent codex');
  console.log('  atris stream --since 1h');
  console.log('  atris stream --json');
  console.log('  atris stream --raw');
  console.log('');
  console.log('Default lines hide ids, branch names, and paths. Use --raw or --json for source records.');
  console.log('');
  return 0;
}

function watchDirs(root, deps, onChange) {
  if (typeof deps.watch !== 'function') return [];
  const dirs = [statePaths(root).stateDir, statePaths(root).runsDir].filter((dir) => deps.existsSync(dir));
  const watchers = [];
  for (const dir of dirs) {
    try {
      watchers.push(deps.watch(dir, { persistent: true }, onChange));
    } catch {}
  }
  return watchers;
}

function streamCommand(args = [], deps = defaultDeps()) {
  if (args.includes('--help') || args.includes('-h') || args[0] === 'help') return showHelp();
  const allDeps = { ...defaultDeps(), ...deps };
  const root = repoRoot(process.cwd(), allDeps);
  const nowMs = allDeps.now();
  const opts = parseArgs(args, nowMs);
  const snapshot = collectSnapshot({ root, deps: allDeps });
  const initialSince = opts.sinceMs || 0;

  if (opts.json) {
    for (const record of snapshotRecords(snapshot, nowMs)) console.log(renderJsonLine(record));
  } else {
    for (const line of snapshot.lines) console.log(line);
  }

  const state = createStreamState({
    root,
    sinceMs: initialSince,
    agent: opts.agent,
    deps: allDeps,
    nowMs,
    skipExisting: !opts.sinceMs,
  });
  const backfill = opts.sinceMs
    ? pollStreamOnce(state, { root, sinceMs: opts.sinceMs, agent: opts.agent, deps: allDeps, nowMs })
    : [];
  if (backfill.length) console.log(renderRecords(backfill, opts));
  if (opts.once) return 0;

  let closed = false;
  let polling = false;
  const poll = () => {
    if (closed || polling) return;
    polling = true;
    try {
      const fresh = pollStreamOnce(state, { root, sinceMs: opts.sinceMs || (nowMs - 24 * 60 * 60 * 1000), agent: opts.agent, deps: allDeps, nowMs: allDeps.now() });
      if (fresh.length) console.log(renderRecords(fresh, opts));
    } finally {
      polling = false;
    }
  };
  const interval = setInterval(poll, opts.intervalMs);
  const watchers = watchDirs(root, allDeps, () => setTimeout(poll, 25));
  return new Promise((resolve) => {
    const stop = () => {
      if (closed) return;
      closed = true;
      clearInterval(interval);
      for (const watcher of watchers) {
        try { watcher.close(); } catch {}
      }
      process.stdout.write('\n');
      resolve(0);
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}

module.exports = {
  collectSnapshot,
  collectStreamEvents,
  createStreamState,
  parseArgs,
  parseSince,
  pollStreamOnce,
  renderJsonLine,
  renderRecords,
  renderTextLine,
  repoRoot,
  sanitizeSummary,
  snapshotRecords,
  streamCommand,
};
