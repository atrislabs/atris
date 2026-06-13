'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const VALID_STATUSES = new Set(['planning', 'running', 'ready', 'paused', 'blocked', 'stopped', 'complete']);
const TERMINAL_STATUSES = new Set(['stopped', 'complete']);
const GOAL_LOOP_STATUSES = new Set(['planning', 'running', 'ready']);
const STATUS_ALIASES = new Set(['active']);

function stampIso() {
  return new Date().toISOString();
}

function todayName() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function slugify(value) {
  return String(value || 'mission')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'mission';
}

function shortHash(value) {
  return crypto.createHash('sha1').update(String(value || '')).digest('hex').slice(0, 8);
}

function missionId(objective) {
  return `mission-${todayName()}-${slugify(objective).slice(0, 28)}-${shortHash(`${objective}:${Date.now()}`)}`;
}

function hasFlag(args, name) {
  return args.includes(name);
}

function unquote(value) {
  const text = String(value);
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1);
  }
  return text;
}

function readFlag(args, name, fallback = '') {
  const prefix = `${name}=`;
  for (let i = 0; i < args.length; i += 1) {
    const arg = String(args[i]);
    if (arg === name && args[i + 1] && !String(args[i + 1]).startsWith('--')) return unquote(args[i + 1]);
    if (arg.startsWith(prefix)) return unquote(arg.slice(prefix.length));
  }
  return fallback;
}

function exitMissionError(message, code = 1, asJson = false) {
  if (asJson) console.log(JSON.stringify({ ok: false, error: message }, null, 2));
  else console.error(message);
  process.exit(code);
}

function readPositiveIntegerFlag(args, name, fallback = null, options = {}) {
  const raw = readFlag(args, name, '');
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    exitMissionError(`${name} must be a positive integer`, 2, options.json);
  }
  return value;
}

function readRepeatedFlag(args, name) {
  const values = [];
  const prefix = `${name}=`;
  for (let i = 0; i < args.length; i += 1) {
    const arg = String(args[i]);
    if (arg === name && args[i + 1] && !String(args[i + 1]).startsWith('--')) {
      values.push(unquote(args[i + 1]));
      i += 1;
      continue;
    }
    if (arg.startsWith(prefix)) values.push(unquote(arg.slice(prefix.length)));
  }
  return values.filter(Boolean);
}

function lintMissionVerifier(command) {
  const text = String(command || '').trim();
  if (!text) return null;
  const compact = text.replace(/\s+/g, ' ');
  const staticNumericTest = /^test \d+ -(?:eq|ne|gt|ge|lt|le) \d+$/.test(compact)
    || /^\[ \d+ -(?:eq|ne|gt|ge|lt|le) \d+ \]$/.test(compact);
  if (!staticNumericTest) return null;
  return 'looks like shell substitution expanded before Atris received it; quote dynamic verifiers with single quotes';
}

function assertMissionVerifier(command, asJson = false) {
  const issue = lintMissionVerifier(command);
  if (!issue) return;
  exitMissionError(`Invalid --verify: ${issue}. Example: --verify 'test $(wc -l < atris/learnings.jsonl) -ge 478'`, 2, asJson);
}

function stripKnownFlags(args, valueNames, booleanNames = []) {
  const valueSet = new Set(valueNames);
  const booleanSet = new Set(booleanNames);
  const out = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = String(args[i]);
    const key = arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg;
    if (booleanSet.has(key)) continue;
    if (valueSet.has(key)) {
      if (!arg.includes('=') && args[i + 1] && !String(args[i + 1]).startsWith('--')) i += 1;
      continue;
    }
    out.push(args[i]);
  }
  return out;
}

function wantsJson(args) {
  return hasFlag(args, '--json');
}

function printJsonOrText(payload, lines, asJson) {
  if (asJson) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  for (const line of lines) console.log(line);
}

function loadTaskDb(asJson = false) {
  try {
    return require('../lib/task-db');
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    if (error?.code === 'ERR_UNKNOWN_BUILTIN_MODULE' || /node:sqlite/.test(message)) {
      exitMissionError('AgentXP mission tasks require Node 22+ with node:sqlite.', 2, asJson);
    }
    throw error;
  }
}

function writeMissionTaskProjection(taskDb, db, workspaceRoot) {
  const projection = taskDb.taskProjection(db, { workspaceRoot, limit: 500 });
  const outPath = path.join(workspaceRoot, '.atris', 'state', 'tasks.projection.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(projection, null, 2) + '\n', 'utf8');
  return { projection, outPath };
}

function missionTaskRef(task) {
  return task?.display_id || task?.legacy_ref || String(task?.id || '').replace(/[^a-zA-Z0-9]/g, '').toUpperCase().slice(0, 8);
}

function createMissionXpTask(mission, root = process.cwd(), asJson = false) {
  const taskDb = loadTaskDb(asJson);
  const db = taskDb.open();
  const workspaceRoot = taskDb.workspaceRoot(root);
  const title = `Mission XP: ${mission.objective}`;
  const metadata = {
    assigned_to: mission.owner,
    delegate_via: 'mission_goal_loop',
    created_for_day: todayName(),
    goal_id: mission.id,
    goal_objective: mission.objective,
    mission_id: mission.id,
    mission_objective: mission.objective,
    mission_owner: mission.owner,
    mission_lane: mission.lane,
    mission_runner: mission.runner,
    verify: mission.verifier || null,
    stop_condition: mission.stop_condition || null,
  };
  const result = taskDb.addTask(db, {
    title,
    tag: 'agent-xp',
    workspaceRoot,
    sourceKey: `mission-xp:${mission.id}`,
    status: 'claimed',
    claimedBy: mission.owner,
    metadata,
  });
  const rows = taskDb.withTaskDisplayRefs(taskDb.listTasks(db, { workspaceRoot }));
  const task = rows.find(row => row.id === result.id);
  if (task) {
    taskDb.noteTask(db, {
      id: task.id,
      actor: process.env.ATRIS_AGENT_ID || mission.owner || 'mission-lead',
      content: `Mission goal loop XP bridge for ${mission.id}. Proof goes through task current-step; AgentXP lands only after human accept.`,
    });
  }
  const { outPath } = writeMissionTaskProjection(taskDb, db, workspaceRoot);
  return {
    task_id: result.id,
    ref: missionTaskRef(task) || result.id,
    title,
    status: task?.status || 'claimed',
    assigned_to: mission.owner,
    inserted: result.inserted !== false,
    projection_path: outPath,
  };
}

function statePaths(root = process.cwd()) {
  const stateDir = path.join(root, '.atris', 'state');
  return {
    stateDir,
    missionsJsonl: path.join(stateDir, 'missions.jsonl'),
    eventsJsonl: path.join(stateDir, 'mission_events.jsonl'),
    codexGoalJson: path.join(stateDir, 'codex_goal.json'),
    codexGoalStatus: path.join(root, 'atris', 'status', 'codex-goal.md'),
    statusNow: path.join(root, 'atris', 'status', 'now.md'),
    runsDir: path.join(root, 'atris', 'runs'),
  };
}

function readJsonLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function loadMissionMap(root = process.cwd()) {
  const paths = statePaths(root);
  const map = new Map();
  for (const mission of readJsonLines(paths.missionsJsonl)) {
    if (mission && mission.id) map.set(mission.id, normalizeMissionState(mission));
  }
  return map;
}

function terminalNextAction(status) {
  if (status === 'complete') return 'mission complete';
  if (status === 'stopped') return 'mission stopped';
  return null;
}

function normalizeMissionState(mission) {
  if (!mission) return mission;
  const nextAction = terminalNextAction(mission.status);
  if (!nextAction || mission.next_action === nextAction) return mission;
  return { ...mission, next_action: nextAction };
}

function listMissions(root = process.cwd()) {
  return Array.from(loadMissionMap(root).values())
    .sort((a, b) => String(b.updated_at || b.created_at || '').localeCompare(String(a.updated_at || a.created_at || '')));
}

// Cross-worktree rollup: missions started with --worktree keep their state inside
// that worktree, so a plain `mission status` from any single checkout is blind to
// them. Enumerate sibling git worktrees and surface their missions read-only.
function listWorktreeRollupMissions(root = process.cwd()) {
  let entries = [];
  try {
    entries = require('./worktree').listWorktrees(root);
  } catch {
    return []; // not a git repo (or git unavailable): nothing to roll up
  }
  let here = root;
  try {
    here = fs.realpathSync(root);
  } catch { /* keep raw path */ }
  const rolled = [];
  for (const entry of entries) {
    let wtRoot;
    try {
      wtRoot = fs.realpathSync(entry.path);
    } catch {
      continue; // stale worktree record
    }
    if (wtRoot === here) continue;
    for (const mission of listMissions(wtRoot)) {
      rolled.push({ ...mission, worktree_root: entry.path, worktree_branch: entry.branch });
    }
  }
  return rolled;
}

function resolveMission(ref, root = process.cwd()) {
  const missions = listMissions(root);
  if (!ref) return missions.find((mission) => !TERMINAL_STATUSES.has(mission.status)) || missions[0] || null;
  return missions.find((mission) => mission.id === ref || mission.id.startsWith(ref) || mission.slug === ref) || null;
}

function missionMatchesStatusFilter(mission, statusFilter) {
  if (statusFilter === 'active') return !TERMINAL_STATUSES.has(mission.status);
  return mission.status === statusFilter;
}

function appendJsonLine(file, payload) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(payload) + '\n', 'utf8');
}

function appendEvent(type, mission, payload = {}, root = process.cwd()) {
  const paths = statePaths(root);
  const event = {
    schema: 'atris.mission_event.v1',
    type,
    mission_id: mission.id,
    at: stampIso(),
    actor: process.env.ATRIS_AGENT_ID || process.env.USER || null,
    payload,
  };
  appendJsonLine(paths.eventsJsonl, event);
  return event;
}

function saveMission(mission, root = process.cwd(), eventType = 'mission_updated', payload = {}) {
  const paths = statePaths(root);
  const next = normalizeMissionState({
    ...mission,
    schema: 'atris.mission.v1',
    updated_at: stampIso(),
  });
  appendJsonLine(paths.missionsJsonl, next);
  const event = appendEvent(eventType, next, payload, root);
  renderMissionStatus(root);
  renderMemberMissionState(next.owner, root);
  return { mission: next, event };
}

function memberDir(owner, root = process.cwd()) {
  if (!owner || !/^[a-zA-Z0-9._-]+$/.test(owner)) return null;
  const dir = path.join(root, 'atris', 'team', owner);
  if (!fs.existsSync(path.join(dir, 'MEMBER.md'))) return null;
  return dir;
}

function appendMemberLog(owner, title, fields = {}, root = process.cwd()) {
  const dir = memberDir(owner, root);
  if (!dir) return null;
  const logsDir = path.join(dir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });
  const logPath = path.join(logsDir, `${todayName()}.md`);
  const stamp = new Date().toTimeString().slice(0, 5);
  const rows = [
    `## ${stamp} · ${title}`,
    `- member: ${owner}`,
    ...Object.entries(fields)
      .filter(([, value]) => value !== undefined && value !== null && value !== '')
      .map(([key, value]) => `- ${key}: ${String(value).replace(/\n/g, ' ')}`),
    '',
  ];
  fs.appendFileSync(logPath, rows.join('\n'), 'utf8');
  return logPath;
}

function memberMissionFile(owner, root = process.cwd()) {
  const dir = memberDir(owner, root);
  if (!dir) return null;
  return path.join(dir, 'MISSION.md');
}

function ensureMemberMissionFile(owner, root = process.cwd(), objective = '') {
  const missionPath = memberMissionFile(owner, root);
  if (!missionPath || fs.existsSync(missionPath)) return missionPath;
  const purpose = String(objective || '').trim() || 'Define why this member exists and how it chooses goals.';
  const content = [
    '# Mission',
    '',
    '<!-- Human-authored purpose file. Keep this durable; runtime state belongs in .atris/state/*.jsonl and now.md. -->',
    '',
    '## North Star',
    '',
    purpose,
    '',
    '## How To Choose Goals',
    '',
    '- Read MEMBER.md, MISSION.md, current goals, now.md, and recent logs.',
    '- Choose one useful bounded goal toward the mission.',
    '- Verify the work, write the receipt, and update the log.',
    '- Ask the human when vision, taste, risk, or uncertainty matters.',
    '',
  ].join('\n');
  fs.writeFileSync(missionPath, content, 'utf8');
  return missionPath;
}

function removeLegacyGeneratedMissionViews(dir) {
  for (const name of ['missions.md', 'missions.json']) {
    const legacyPath = path.join(dir, name);
    if (!fs.existsSync(legacyPath)) continue;
    let text = '';
    try {
      text = fs.readFileSync(legacyPath, 'utf8');
    } catch {}
    const looksGenerated = name.endsWith('.json')
      ? text.includes('"schema": "atris.member_missions.v1"')
      : text.includes('Generated from local Mission state');
    if (looksGenerated) fs.unlinkSync(legacyPath);
  }
}

function renderMemberNowMarkdown(owner, missions) {
  const lines = [
    '# Now',
    '',
    '<!-- Generated by Atris. Do not hand-edit. Durable purpose belongs in MISSION.md. -->',
    '',
  ];
  if (!missions.length) {
    lines.push('No missions yet.', '');
    return lines.join('\n');
  }
  for (const mission of missions) {
    lines.push(`## ${mission.objective}`);
    lines.push('');
    lines.push(`- id: ${mission.id}`);
    lines.push(`- status: ${mission.status}`);
    lines.push(`- cadence: ${mission.cadence}`);
    lines.push(`- runner: ${mission.runner}${mission.model ? ` (${mission.model})` : ''}`);
    lines.push(`- lane: ${mission.lane}`);
    if (mission.xp_task?.ref) lines.push(`- AgentXP task: ${mission.xp_task.ref}`);
    if (mission.verifier) lines.push(`- verifier: ${mission.verifier}`);
    if (mission.stop_condition) lines.push(`- stop: ${mission.stop_condition}`);
    if (mission.next_action) lines.push(`- next: ${mission.next_action}`);
    if (mission.receipt_path) lines.push(`- receipt: ${mission.receipt_path}`);
    if (mission.human_asks?.length) {
      lines.push('- human asks:');
      for (const ask of mission.human_asks) lines.push(`  - ${ask}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function renderMemberMissionState(owner, root = process.cwd()) {
  const dir = memberDir(owner, root);
  if (!dir) return null;
  const missionPath = ensureMemberMissionFile(owner, root);
  const missions = listMissions(root).filter((mission) => mission.owner === owner);
  const nowPath = path.join(dir, 'now.md');
  removeLegacyGeneratedMissionViews(dir);
  fs.writeFileSync(nowPath, renderMemberNowMarkdown(owner, missions), 'utf8');
  return { missionPath, nowPath };
}

// One glanceable label for how a mission earned its completion: evidence
// source when the gate passed, an explicit marker when an operator forced it.
function completionGateLabel(gate) {
  if (!gate) return null;
  return gate.forced ? `forced override (${gate.source})` : gate.source;
}

function renderMissionStatus(root = process.cwd()) {
  const paths = statePaths(root);
  const missions = listMissions(root);
  fs.mkdirSync(path.dirname(paths.statusNow), { recursive: true });
  const active = missions.filter((mission) => !TERMINAL_STATUSES.has(mission.status));
  const lines = [
    '# Now',
    '',
    '## Missions',
    '',
  ];
  if (!missions.length) {
    lines.push('No missions yet.', '');
  } else {
    for (const mission of missions.slice(0, 12)) {
      lines.push(`- **${mission.id}** ${mission.objective}`);
      lines.push(`  - owner: ${mission.owner}`);
      lines.push(`  - state: ${mission.status}`);
      lines.push(`  - next: ${mission.next_action || 'tick or verify'}`);
      if (mission.xp_task?.ref) lines.push(`  - AgentXP task: ${mission.xp_task.ref}`);
      if (mission.receipt_path) lines.push(`  - proof: ${mission.receipt_path}`);
      const gateLabel = completionGateLabel(mission.completion_gate);
      if (gateLabel) lines.push(`  - gate: ${gateLabel}`);
    }
    lines.push('');
  }
  lines.push(`Active missions: ${active.length}`);
  lines.push('');
  fs.writeFileSync(paths.statusNow, lines.join('\n'), 'utf8');
  return paths.statusNow;
}

function missionXpTaskRefFromMission(mission) {
  if (mission?.xp_task?.ref) return mission.xp_task.ref;
  if (mission?.xp_task_enabled && mission?.task_ids?.[0]) return mission.task_ids[0];
  return '';
}

function missionXpReadyAction(mission, receiptPath) {
  const ref = missionXpTaskRefFromMission(mission);
  if (!ref || !receiptPath) return null;
  const owner = mission.owner || process.env.ATRIS_AGENT_ID || 'mission-lead';
  return `queue AgentXP review: atris task current-step --goal-id ${mission.id} --as ${owner} --proof "${receiptPath}" --json`;
}

function missionFromArgs(args) {
  const objective = stripKnownFlags(args, [
    '--owner',
    '--cadence',
    '--loop',
    '--runner',
    '--lane',
    '--verify',
    '--stop',
    '--task',
    '--ask',
    '--model',
  ], ['--json', '--always-on', '--xp-task', '--agent-xp', '--worktree']).join(' ').trim();
  if (!objective) {
    exitMissionError('Usage: atris mission start "<objective>" --owner <member> [--verify "..."] [--cadence manual] [--worktree]', 1, wantsJson(args));
  }
  const owner = readFlag(args, '--owner', process.env.ATRIS_AGENT_ID || 'mission-lead');
  const cadence = readFlag(args, '--cadence', readFlag(args, '--loop', 'manual')) || 'manual';
  const runner = readFlag(args, '--runner', 'manual');
  const model = readFlag(args, '--model', '') || (String(runner).toLowerCase() === 'atris2' ? 'atris:fast' : '');
  const lane = readFlag(args, '--lane', 'workspace');
  const verifier = readFlag(args, '--verify', '');
  assertMissionVerifier(verifier, wantsJson(args));
  const stopCondition = readFlag(args, '--stop', verifier ? 'verifier passes and no human asks remain' : 'human marks complete with proof');
  const taskIds = readRepeatedFlag(args, '--task');
  const humanAsks = readRepeatedFlag(args, '--ask');
  const alwaysOn = hasFlag(args, '--always-on');
  const xpTaskEnabled = hasFlag(args, '--xp-task') || hasFlag(args, '--agent-xp');
  const id = missionId(objective);
  const mission = {
    schema: 'atris.mission.v1',
    id,
    slug: slugify(objective),
    objective,
    owner,
    status: 'planning',
    cadence,
    runner,
    ...(model ? { model } : {}),
    lane,
    verifier,
    always_on: alwaysOn,
    xp_task_enabled: xpTaskEnabled,
    stop_condition: stopCondition,
    task_ids: taskIds,
    human_asks: humanAsks,
    next_action: verifier ? 'run verifier with `atris mission tick <id> --verify`' : 'define verifier or run next task',
    receipt_path: null,
    created_at: stampIso(),
    updated_at: stampIso(),
  };
  if (alwaysOn) mission.next_action = nextCandidateTickAction(mission);
  return mission;
}

function missingVerifierWarning(mission) {
  if (String(mission.verifier || '').trim()) return null;
  return {
    code: 'missing_verifier',
    message: 'Mission has no verifier; it cannot complete automatically and future runs will report unverified worktree side effects.',
  };
}

function startMission(args) {
  const asJson = wantsJson(args);
  const mission = missionFromArgs(args);
  // --worktree: bind the mission to its own isolated checkout. We chdir before
  // any state writes so the mission record, baseline sidecar, receipts, and
  // member files all land inside the worktree — ticks run there, and the main
  // checkout's dirt never reaches the mission baseline.
  if (hasFlag(args, '--worktree')) {
    let created;
    try {
      const { createAgentWorktree } = require('./worktree');
      created = createAgentWorktree({ member: mission.owner, task: mission.objective });
    } catch (e) {
      exitMissionError(`[mission start] worktree creation failed: ${e.message}`, 2, asJson);
    }
    mission.worktree = { path: created.path, branch: created.branch, base: created.base };
    process.chdir(created.path);
  }
  if (mission.xp_task_enabled) {
    const xpTask = createMissionXpTask(mission, process.cwd(), asJson);
    mission.xp_task = xpTask;
    mission.task_ids = Array.from(new Set([...(mission.task_ids || []), xpTask.task_id]));
    if (!mission.verifier && !mission.always_on) {
      mission.next_action = `work task then run: atris task current-step --goal-id ${mission.id} --as ${mission.owner} --proof "<proof>" --json`;
    }
  }
  const warnings = [missingVerifierWarning(mission)].filter(Boolean);
  ensureMemberMissionFile(mission.owner, process.cwd(), mission.objective);
  const { mission: saved } = saveMission(mission, process.cwd(), 'mission_started', { objective: mission.objective });
  const memberState = renderMemberMissionState(saved.owner);
  const logPath = appendMemberLog(saved.owner, 'Mission started', {
    mission: saved.objective,
    cadence: saved.cadence,
    runner: saved.runner,
    lane: saved.lane,
    verifier: saved.verifier,
  });
  const worktreeBaseline = captureMissionWorktreeBaseline(saved, process.cwd());
  printJsonOrText(
    { ok: true, action: 'mission_started', mission: saved, warnings, state_path: statePaths().missionsJsonl, member_state: memberState, log_path: logPath, worktree_baseline: worktreeBaseline ? { path: path.relative(process.cwd(), missionBaselinePath(saved.id)), dirty_count: worktreeBaseline.dirty_count, dirty_hash: worktreeBaseline.dirty_hash } : null },
    [
      `Started mission: ${saved.objective}`,
      `Owner: ${saved.owner}`,
      `State: ${saved.status}`,
      ...(saved.worktree ? [`Worktree: ${saved.worktree.path}`, `Branch: ${saved.worktree.branch}`] : []),
      ...warnings.map((warning) => `Warning: ${warning.message}`),
      ...(saved.xp_task ? [`AgentXP task: ${saved.xp_task.ref}`] : []),
      ...(saved.worktree ? [`Next: cd ${saved.worktree.path} && atris mission tick ${saved.id}`] : [`Next: atris mission tick ${saved.id}`]),
    ],
    asJson,
  );
}

function statusMission(args) {
  const asJson = wantsJson(args);
  const localOnly = hasFlag(args, '--local');
  const ref = stripKnownFlags(args, ['--status', '--limit'], ['--json', '--local'])[0] || '';
  const statusFilter = readFlag(args, '--status', '');
  if (statusFilter && !VALID_STATUSES.has(statusFilter) && !STATUS_ALIASES.has(statusFilter)) {
    exitMissionError(`Invalid --status: ${statusFilter}`, 2, asJson);
  }
  const limit = readPositiveIntegerFlag(args, '--limit', null, { json: asJson });
  let missions = ref ? [resolveMission(ref)].filter(Boolean) : listMissions();
  if (!ref && !localOnly) {
    const seen = new Set(missions.map((mission) => mission.id));
    for (const rolled of listWorktreeRollupMissions()) {
      if (seen.has(rolled.id)) continue;
      seen.add(rolled.id);
      missions.push(rolled);
    }
    missions.sort((a, b) => String(b.updated_at || b.created_at || '').localeCompare(String(a.updated_at || a.created_at || '')));
  }
  if (!ref && statusFilter) missions = missions.filter((mission) => missionMatchesStatusFilter(mission, statusFilter));
  if (!ref && limit) missions = missions.slice(0, limit);
  if (ref && !missions.length) {
    exitMissionError(`Mission "${ref}" not found.`, 1, asJson);
  }
  // Member state renders are cwd-local writes; rolled-up missions stay read-only.
  for (const owner of new Set(missions.filter((mission) => !mission.worktree_root).map((mission) => mission.owner).filter(Boolean))) {
    renderMemberMissionState(owner);
  }
  const payload = {
    ok: true,
    action: 'mission_status',
    missions,
    state_path: statePaths().missionsJsonl,
    events_path: statePaths().eventsJsonl,
    status_path: renderMissionStatus(),
  };
  printJsonOrText(
    payload,
    missions.length
      ? missions.flatMap((mission) => [
        `Mission: ${mission.objective}`,
        `  id: ${mission.id}`,
        `  owner: ${mission.owner}`,
        `  state: ${mission.status}`,
        ...missionHeartbeatLines(mission),
        ...(mission.worktree_root ? [`  worktree: ${mission.worktree_root}`] : []),
        `  next: ${mission.next_action || 'tick or verify'}`,
        ...(mission.receipt_path ? [`  proof: ${mission.receipt_path}`] : []),
        ...(completionGateLabel(mission.completion_gate) ? [`  gate: ${completionGateLabel(mission.completion_gate)}`] : []),
      ])
      : ['No missions yet. Run: atris mission start "..." --owner <member>'],
    asJson,
  );
}

// `atris mission watch [id]` — read-only live heartbeat. Prints a line per tick as it
// lands so a human (or any terminal) can see the loop is alive without rerunning status.
function watchMission(args) {
  const ref = stripKnownFlags(args, ['--interval', '--idle-every'], [])[0] || '';
  const intervalSeconds = Math.max(1, parseInt(readFlag(args, '--interval', '2'), 10) || 2);
  const idleEverySeconds = Math.max(1, parseInt(readFlag(args, '--idle-every', '30'), 10) || 30);
  const loadTargets = () => {
    if (ref) {
      const mission = resolveMission(ref);
      return mission ? [mission] : [];
    }
    return listMissions().filter((mission) => !HEARTBEAT_TERMINAL_STATUSES.has(mission.status));
  };
  if (ref && !loadTargets().length) {
    exitMissionError(`Mission "${ref}" not found.`, 1, false);
  }
  const stamp = () => new Date().toTimeString().slice(0, 8);
  const shortId = (mission) => mission.id.length > 20 ? `…${mission.id.slice(-8)}` : mission.id;
  const emit = (mission, note) => console.log(`[${stamp()}] ${mission.owner} ${shortId(mission)} — ${note}`);
  const fingerprint = (mission) => [mission.status, mission.last_tick_at, mission.last_tick_index, mission.receipt_path].join('|');
  const tickNote = (mission) => {
    const heartbeat = missionHeartbeatLines(mission).map((line) => line.trim()).join(', ');
    return `${heartbeat || `state: ${mission.status}`}${mission.receipt_path ? ` — proof: ${mission.receipt_path}` : ''}`;
  };
  const seen = new Map();
  let lastIdleAt = Date.now();
  console.log(`watching ${ref || 'active missions'} every ${intervalSeconds}s — ctrl+c to stop`);
  const poll = () => {
    const targets = loadTargets();
    if (!targets.length && !seen.size) {
      emitOnce('no active missions yet — waiting');
    }
    let changed = false;
    for (const mission of targets) {
      const fp = fingerprint(mission);
      if (seen.get(mission.id) !== fp) {
        seen.set(mission.id, fp);
        emit(mission, tickNote(mission));
        changed = true;
      }
    }
    if (changed) {
      lastIdleAt = Date.now();
    } else if (Date.now() - lastIdleAt >= idleEverySeconds * 1000) {
      lastIdleAt = Date.now();
      for (const mission of targets) {
        emit(mission, `alive, ${missionHeartbeatLines(mission).map((line) => line.trim()).join(', ') || `state: ${mission.status}`}`);
      }
    }
  };
  let warnedEmpty = false;
  const emitOnce = (message) => {
    if (warnedEmpty) return;
    warnedEmpty = true;
    console.log(`[${stamp()}] ${message}`);
  };
  poll();
  setInterval(poll, intervalSeconds * 1000);
  // The bin router exits when the command's promise settles; watch runs until ctrl+c.
  return new Promise(() => {});
}

function writeReceipt(mission, result, root = process.cwd()) {
  const paths = statePaths(root);
  fs.mkdirSync(paths.runsDir, { recursive: true });
  const safeTime = stampIso().replace(/[:.]/g, '-');
  const receiptPath = path.join(paths.runsDir, `mission-${mission.id}-${safeTime}.json`);
  // Back-compat: legacy consumers read receipt.result.passed (verifier-only shape).
  // New shape nests verifier under result.verifier_result, so mirror .passed at top.
  const finalResult = (result && typeof result === 'object' && result.verifier_result && !('passed' in result))
    ? { ...result, passed: !!result.verifier_result.passed }
    : result;
  fs.writeFileSync(receiptPath, JSON.stringify({
    schema: 'atris.mission_receipt.v1',
    mission_id: mission.id,
    objective: mission.objective,
    owner: mission.owner,
    at: stampIso(),
    verifier: mission.verifier || null,
    result: finalResult,
  }, null, 2) + '\n', 'utf8');
  return path.relative(root, receiptPath);
}

function shellQuote(value) {
  return `'${String(value || '').replace(/'/g, `'\\''`)}'`;
}

function resolveVerifierCommand(command) {
  const raw = String(command || '');
  const leading = raw.match(/^\s*/)?.[0] || '';
  const trimmed = raw.trimStart();
  if (!trimmed || !/^atris(?:\s|$)/.test(trimmed)) return raw;
  const cliPath = path.resolve(__dirname, '..', 'bin', 'atris.js');
  return `${leading}${shellQuote(process.execPath)} ${shellQuote(cliPath)}${trimmed.slice('atris'.length)}`;
}

function runVerifier(command, root = process.cwd()) {
  if (!command) return null;
  const resolvedCommand = resolveVerifierCommand(command);
  const result = spawnSync(resolvedCommand, {
    cwd: root,
    shell: true,
    encoding: 'utf8',
    timeout: 120000,
    env: process.env,
  });
  return {
    command,
    resolved_command: resolvedCommand === command ? null : resolvedCommand,
    status: result.status,
    signal: result.signal || null,
    passed: result.status === 0,
    stdout: String(result.stdout || '').slice(-4000),
    stderr: String(result.stderr || '').slice(-4000),
  };
}

const REVIEW_LANE_DRAIN_TIMEOUT_MS = 120000;

// Bounded agent-side review sweep, recorded on the tick. Failures never break
// the mission loop; they surface in the tick record instead.
function runReviewLaneDrain(root = process.cwd()) {
  const cliPath = path.resolve(__dirname, '..', 'bin', 'atris.js');
  const res = spawnSync(process.execPath, [cliPath, 'task', 'review-lane-run', '--json'], {
    cwd: root,
    encoding: 'utf8',
    timeout: REVIEW_LANE_DRAIN_TIMEOUT_MS,
  });
  let receipt = null;
  try {
    receipt = JSON.parse(res.stdout);
  } catch { /* fall through to error shape */ }
  if (!receipt) {
    return {
      ok: false,
      error: 'review_lane_run_unparseable',
      status: res.status ?? null,
      stderr: String(res.stderr || '').slice(-400),
    };
  }
  return {
    ok: receipt.ok === true,
    run_count: receipt.run_count ?? null,
    total_acted_count: receipt.total_acted_count ?? 0,
    stopped_reason: receipt.stopped_reason || null,
    receipt_path: receipt.receipt_path || null,
  };
}

function gitWorktreeSnapshot(root = process.cwd()) {
  const inside = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 5000,
  });
  if (inside.status !== 0 || String(inside.stdout || '').trim() !== 'true') {
    return { available: false, reason: 'not-git-worktree' };
  }
  const status = spawnSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 10000,
  });
  if (status.status !== 0) {
    return {
      available: false,
      reason: 'git-status-failed',
      stderr: String(status.stderr || '').slice(-1000),
    };
  }
  const entries = String(status.stdout || '').split(/\r?\n/).filter(Boolean).sort();
  const digest = crypto.createHash('sha1').update(entries.join('\n')).digest('hex');
  return {
    available: true,
    dirty_count: entries.length,
    dirty_hash: digest,
    dirty_sample: entries.slice(0, 25),
    entries,
  };
}

// Porcelain v1 entries are "XY path" or "XY old -> new"; baselines compare by
// post-rename path so a status-letter change alone never counts as new dirt.
function porcelainEntryPath(line) {
  const trimmed = String(line || '').slice(3);
  const arrow = trimmed.indexOf(' -> ');
  return arrow >= 0 ? trimmed.slice(arrow + 4) : trimmed;
}

const LOOP_EXHAUST_PREFIXES = ['.atris/', 'atris/runs/', 'atris/status/'];

function isLoopExhaustPath(entryPath) {
  return LOOP_EXHAUST_PREFIXES.some((prefix) => String(entryPath).startsWith(prefix));
}

function missionBaselinePath(missionId, root = process.cwd()) {
  return path.join(root, '.atris', 'state', 'mission-baselines', `${missionId}.json`);
}

// Write-once sidecar capturing the dirt the mission inherited. Receipts subtract
// these paths so pre-existing workspace noise stops flagging unverified_dirty.
// Stored outside missions.jsonl because that log re-appends the full mission
// record on every save. Captured after start bookkeeping so the mission's own
// state writes land inside the baseline, not in new_since_baseline.
function captureMissionWorktreeBaseline(mission, root = process.cwd()) {
  const snapshot = gitWorktreeSnapshot(root);
  if (!snapshot.available) return null;
  const baselineFile = missionBaselinePath(mission.id, root);
  const paths = new Set((snapshot.entries || []).map(porcelainEntryPath));
  // The sidecar itself and the per-tick lock are mission bookkeeping; without
  // these the mission would flag its own state files as unverified dirt.
  paths.add(path.relative(root, baselineFile));
  paths.add(path.relative(root, path.join(root, '.atris', 'state', `mission-${mission.id}.lock`)));
  const baseline = {
    schema: 'atris.mission_worktree_baseline.v1',
    mission_id: mission.id,
    captured_at: stampIso(),
    dirty_count: snapshot.dirty_count,
    dirty_hash: snapshot.dirty_hash,
    paths: Array.from(paths).sort(),
  };
  fs.mkdirSync(path.dirname(baselineFile), { recursive: true });
  fs.writeFileSync(baselineFile, JSON.stringify(baseline, null, 2) + '\n', 'utf8');
  return baseline;
}

function loadMissionWorktreeBaseline(missionId, root = process.cwd()) {
  try {
    const baseline = JSON.parse(fs.readFileSync(missionBaselinePath(missionId, root), 'utf8'));
    return Array.isArray(baseline?.paths) ? baseline : null;
  } catch {
    return null;
  }
}

// Closed missions no longer tick, so the sidecar is dead weight; prune it and
// fold a compact audit summary into the mission record (full path lists stay
// out of missions.jsonl, which re-appends the whole record on every save).
// Paused missions keep their sidecar — resume ticks still subtract it.
function pruneMissionWorktreeBaseline(mission, root = process.cwd()) {
  const baseline = loadMissionWorktreeBaseline(mission.id, root);
  try { fs.rmSync(missionBaselinePath(mission.id, root), { force: true }); } catch {}
  if (!baseline) return null;
  return {
    captured_at: baseline.captured_at,
    dirty_count: baseline.dirty_count,
    dirty_hash: baseline.dirty_hash,
    path_count: baseline.paths.length,
  };
}

function worktreeReceipt(before, after, { verifier = '', baseline = null } = {}) {
  if (!before?.available || !after?.available) {
    return {
      available: false,
      before_reason: before?.reason || null,
      after_reason: after?.reason || null,
    };
  }
  const beforeSet = new Set(before.entries || []);
  const afterSet = new Set(after.entries || []);
  const newDirty = (after.entries || []).filter((entry) => !beforeSet.has(entry));
  const clearedDirty = (before.entries || []).filter((entry) => !afterSet.has(entry));
  const changed = before.dirty_hash !== after.dirty_hash;
  const hasVerifier = !!String(verifier || '').trim();
  // Baseline = dirt the mission inherited (mission-start sidecar when present,
  // tick-start snapshot for legacy missions). Only paths dirtied beyond that
  // baseline count toward the unverified signal. Loop exhaust the mission
  // writes about itself (state plane, receipts, rendered status) is not work
  // product, so it never counts — otherwise every multi-tick mission in a repo
  // that doesn't gitignore those dirs would flag its own bookkeeping.
  const baselinePaths = baseline
    ? new Set(baseline.paths)
    : new Set((before.entries || []).map(porcelainEntryPath));
  const newSinceBaseline = Array.from(new Set((after.entries || []).map(porcelainEntryPath)))
    .filter((entryPath) => !baselinePaths.has(entryPath) && !isLoopExhaustPath(entryPath));
  return {
    available: true,
    before_dirty_count: before.dirty_count,
    after_dirty_count: after.dirty_count,
    changed,
    baseline_source: baseline ? 'mission_start' : 'tick_start',
    baseline_dirty_count: baseline ? baseline.dirty_count : before.dirty_count,
    new_since_baseline_count: newSinceBaseline.length,
    new_since_baseline_sample: newSinceBaseline.slice(0, 25),
    unverified_dirty: !hasVerifier && newSinceBaseline.length > 0,
    unverified_change: !hasVerifier && changed,
    new_dirty_count: newDirty.length,
    cleared_dirty_count: clearedDirty.length,
    dirty_sample_after: after.dirty_sample,
    new_dirty_sample: newDirty.slice(0, 25),
    cleared_dirty_sample: clearedDirty.slice(0, 25),
    before_dirty_hash: before.dirty_hash,
    after_dirty_hash: after.dirty_hash,
  };
}

// ---------------------------------------------------------------------------
// `atris mission run <id>` — bounded local headless loop. v0.1.
// Spawns `claude -p --resume <session>` per tick. Honors cadence, active-hours,
// rate-limit info, and a flock per mission. `max-ticks` bounds total attempts;
// `ran_ticks` separately reports ticks that actually made progress.
// ---------------------------------------------------------------------------

const MISSION_RUN_DEFAULTS = {
  maxTicks: 4,
  maxWallSeconds: 3600,
  claudeTimeoutMs: 10 * 60 * 1000,
  backoff: { initialMs: 30_000, maxMs: 10 * 60_000, factor: 2, jitter: 0.3 },
};

function runnerUsesCallerSession(runner) {
  return new Set(['codex_goal', 'caller_session', 'current_agent']).has(String(runner || '').trim().toLowerCase());
}

function nextCandidateTickAction(mission) {
  const completeFlag = mission.always_on ? '' : ' --complete-on-pass';
  return `next move: run atris mission run ${mission.id}${completeFlag}`;
}

function missionVerifierPassed(mission) {
  return (mission && mission.verifier_result && mission.verifier_result.passed) === true;
}

function missionDueAt(mission, now = new Date()) {
  const cadenceSeconds = parseCadenceSeconds(mission.cadence);
  if (!mission.last_tick_at) return true;
  if (cadenceSeconds === 0) return !(mission.always_on && missionVerifierPassed(mission));
  const lastTickAt = Date.parse(mission.last_tick_at);
  if (!Number.isFinite(lastTickAt)) return true;
  return now.getTime() - lastTickAt >= cadenceSeconds * 1000;
}

function missionSelectableForLoop(mission, now = new Date()) {
  return missionIsRunnable(mission)
    && !(mission.always_on && missionVerifierPassed(mission) && !missionDueAt(mission, now));
}

function secondsUntilMissionDue(mission, now = new Date()) {
  const cadenceSeconds = parseCadenceSeconds(mission?.cadence);
  if (!mission || !mission.last_tick_at || cadenceSeconds === 0) return 0;
  const lastTickAt = Date.parse(mission.last_tick_at);
  if (!Number.isFinite(lastTickAt)) return 0;
  const dueAt = lastTickAt + cadenceSeconds * 1000;
  return Math.max(0, Math.ceil((dueAt - now.getTime()) / 1000));
}

function formatDurationShort(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ${Math.round((seconds % 3600) / 60)}m`;
  return `${Math.floor(seconds / 86400)}d`;
}

const HEARTBEAT_TERMINAL_STATUSES = new Set(['complete', 'stopped', 'paused']);

function missionHeartbeatLines(mission, now = new Date()) {
  const lines = [];
  const lastTickAt = mission.last_tick_at ? Date.parse(mission.last_tick_at) : NaN;
  if (Number.isFinite(lastTickAt)) {
    const age = formatDurationShort((now.getTime() - lastTickAt) / 1000);
    const verifier = mission.verifier
      ? (mission.verifier_result ? (mission.verifier_result.passed ? 'verifier passed' : 'verifier failed') : 'verifier not run')
      : 'no verifier';
    const tickIdx = mission.last_tick_index != null ? `#${mission.last_tick_index}, ` : '';
    const layerSuffix = mission.last_tick_layer ? `, layer: ${mission.last_tick_layer}` : '';
    lines.push(`  last tick: ${age} ago (${tickIdx}${mission.last_tick_status || 'unknown'}, ${verifier}${layerSuffix})`);
  } else if (!HEARTBEAT_TERMINAL_STATUSES.has(mission.status)) {
    lines.push('  last tick: never');
  }
  if (parseCadenceSeconds(mission.cadence) > 0 && !HEARTBEAT_TERMINAL_STATUSES.has(mission.status)) {
    const dueIn = secondsUntilMissionDue(mission, now);
    lines.push(dueIn === 0 ? '  due: now' : `  due: in ${formatDurationShort(dueIn)}`);
  }
  return lines;
}

function missionHasHumanAsks(mission) {
  return Array.isArray(mission?.human_asks)
    && mission.human_asks.some((ask) => String(ask || '').trim());
}

function missionIsRunnable(mission) {
  return mission
    && GOAL_LOOP_STATUSES.has(String(mission.status || ''))
    && !missionHasHumanAsks(mission);
}

function missionSortTime(mission) {
  return Date.parse(mission?.updated_at || mission?.created_at || '') || 0;
}

function selectDueMission(root = process.cwd(), now = new Date()) {
  const candidates = listMissions(root)
    .filter((mission) => missionSelectableForLoop(mission, now))
    .filter((mission) => mission.verifier)
    .filter((mission) => mission.always_on || !missionVerifierPassed(mission))
    .filter((mission) => missionDueAt(mission, now));

  candidates.sort((a, b) => {
    const aCaller = runnerUsesCallerSession(a.runner) ? 1 : 0;
    const bCaller = runnerUsesCallerSession(b.runner) ? 1 : 0;
    if (aCaller !== bCaller) return bCaller - aCaller;

    const aTime = missionSortTime(a);
    const bTime = missionSortTime(b);
    return bTime - aTime;
  });
  return candidates[0] || null;
}

function missionSelectableForCodexGoal(mission, now = new Date()) {
  if (!missionIsRunnable(mission)) return false;
  if (mission.always_on && missionVerifierPassed(mission) && !missionDueAt(mission, now)) {
    return parseCadenceSeconds(mission.cadence) > 0;
  }
  return true;
}

function selectCodexGoalMission(root = process.cwd(), now = new Date()) {
  const candidates = listMissions(root)
    .filter((mission) => missionSelectableForCodexGoal(mission, now));

  candidates.sort((a, b) => {
    const aCaller = runnerUsesCallerSession(a.runner) ? 1 : 0;
    const bCaller = runnerUsesCallerSession(b.runner) ? 1 : 0;
    if (aCaller !== bCaller) return bCaller - aCaller;

    const aVerifier = a.verifier ? 1 : 0;
    const bVerifier = b.verifier ? 1 : 0;
    if (aVerifier !== bVerifier) return bVerifier - aVerifier;

    const aTime = missionSortTime(a);
    const bTime = missionSortTime(b);
    return bTime - aTime;
  });

  const mission = candidates[0] || null;
  if (!mission) return null;
  const due = mission.verifier && missionDueAt(mission, now);
  return { mission, reason: due ? 'due' : 'active' };
}

function codexGoalObjective(mission) {
  return `Advance Atris mission ${mission.id}: ${mission.objective}`;
}

function codexGoalNextCommand(mission) {
  if (mission.status === 'ready') {
    const xpAction = missionXpReadyAction(mission, mission.receipt_path);
    if (xpAction) return xpAction.replace(/^queue AgentXP review: /, '');
  }
  if (mission.verifier && missionDueAt(mission)) {
    const completeFlag = mission.always_on ? '' : ' --complete-on-pass';
    return `atris mission run --due --max-ticks 1${completeFlag}`;
  }
  if (mission.verifier) {
    return `atris mission tick ${mission.id} --verify --summary "<what changed>"`;
  }
  return `atris mission tick ${mission.id} --summary "<what changed>"`;
}

function codexGoalToolContract(mission) {
  return {
    current_policy: 'keep one visible Codex /goal active for the selected Atris mission',
    read_current_goal: 'get_goal',
    complete_current_goal: 'update_goal({ status: "complete" })',
    select_next_goal: 'atris mission goal --json',
    set_next_goal: 'replace_goal(goal.objective) or create_goal(goal.objective) after the completed goal slot is reusable',
    platform_requirement: 'Codex runtime must expose replace_goal/set_goal, or allow create_goal after update_goal completes the prior goal.',
    blocked_without_platform_goal_write: true,
    mission_id: mission.id,
  };
}

function codexGoalHeartbeat(goal, mission, now = new Date()) {
  const secondsUntilDue = secondsUntilMissionDue(mission, now);
  return {
    due: mission ? missionDueAt(mission, now) : false,
    seconds_until_due: secondsUntilDue,
    recommended_sleep_seconds: secondsUntilDue === 0 ? 0 : Math.min(Math.max(secondsUntilDue, 15), 900),
    heavy_work_performed: false,
    next_heavy_command: goal?.next_command || null,
  };
}

function writeCodexGoalState(payload, root = process.cwd()) {
  const paths = statePaths(root);
  const state = {
    schema: 'atris.codex_goal_controller.v1',
    updated_at: stampIso(),
    ...payload,
  };
  fs.mkdirSync(path.dirname(paths.codexGoalJson), { recursive: true });
  fs.writeFileSync(paths.codexGoalJson, JSON.stringify(state, null, 2) + '\n', 'utf8');

  const lines = [
    '# Codex Goal Controller',
    '',
    '<!-- Generated by Atris. Do not hand-edit. -->',
    '',
    `- updated: ${state.updated_at}`,
    `- action: ${state.action}`,
  ];
  if (state.goal) {
    lines.push(`- mission: ${state.goal.mission_id}`);
    lines.push(`- status: ${state.goal.mission_status}`);
    lines.push(`- reason: ${state.goal.reason}`);
    lines.push(`- objective: ${state.goal.objective}`);
    lines.push(`- next: ${state.goal.next_command}`);
    lines.push(`- platform write blocked: ${state.goal.codex_tool_contract.blocked_without_platform_goal_write}`);
  } else {
    lines.push('- mission: none');
  }
  lines.push('');
  fs.mkdirSync(path.dirname(paths.codexGoalStatus), { recursive: true });
  fs.writeFileSync(paths.codexGoalStatus, lines.join('\n'), 'utf8');
  return {
    state_path: paths.codexGoalJson,
    status_path: paths.codexGoalStatus,
    state,
  };
}

function buildCodexGoalPayload(root = process.cwd(), options = {}) {
  const heartbeatMode = options.heartbeat === true;
  const selected = selectCodexGoalMission(root);
  if (!selected) {
    const heartbeat = heartbeatMode ? codexGoalHeartbeat(null, null) : undefined;
    return {
      ok: true,
      action: heartbeatMode ? 'codex_goal_heartbeat' : 'no_goal_candidate',
      mission: null,
      heartbeat,
    };
  }

  const { mission, reason } = selected;
  const goal = {
    objective: codexGoalObjective(mission),
    mission_id: mission.id,
    mission_objective: mission.objective,
    mission_status: mission.status,
    reason,
    next_command: codexGoalNextCommand(mission),
    replace_after: 'After proof or verifier pass, run atris mission goal --json again and replace the Codex /goal with the returned objective.',
    codex_tool_contract: codexGoalToolContract(mission),
  };
  const heartbeat = heartbeatMode ? codexGoalHeartbeat(goal, mission) : undefined;
  return {
    ok: true,
    action: heartbeatMode ? 'codex_goal_heartbeat' : 'codex_goal_candidate',
    goal,
    mission,
    heartbeat,
  };
}

function refreshCodexGoalController(root = process.cwd(), options = {}) {
  const payload = buildCodexGoalPayload(root, options);
  const rendered = writeCodexGoalState(payload, root);
  return {
    ...payload,
    state_path: rendered.state_path,
    status_path: rendered.status_path,
  };
}

function runMissionRunDueOnce(root = process.cwd(), options = {}) {
  const cliPath = path.join(__dirname, '..', 'bin', 'atris.js');
  const args = ['mission', 'run', '--due', '--max-ticks', '1', '--complete-on-pass', '--json'];
  if (options.noClaude) args.push('--no-claude');
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: 120000,
    env: { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1' },
  });
  let payload = null;
  try {
    payload = JSON.parse(result.stdout || '{}');
  } catch {}
  return {
    command: `atris ${args.join(' ')}`,
    status: result.status,
    ok: result.status === 0,
    stdout: String(result.stdout || '').slice(-4000),
    stderr: String(result.stderr || '').slice(-4000),
    payload,
  };
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (ms <= 0) return resolve();
    const onAbort = () => { clearTimeout(timer); reject(Object.assign(new Error('aborted'), { code: 'ABORTED' })); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

function parseCadenceSeconds(cadence) {
  const text = String(cadence || '').trim().toLowerCase();
  if (!text || text === 'manual' || text === 'once') return 0;
  const m = text.match(/^(\d+)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hour|hours|d|day|days)$/);
  if (!m) return 0;
  const n = Number(m[1]);
  const unit = m[2];
  if (/^d/.test(unit)) return n * 86400;
  if (/^h/.test(unit)) return n * 3600;
  if (/^m(?!s)/.test(unit)) return n * 60;
  return n; // seconds
}

function computeBackoff(policy, attempt) {
  const base = policy.initialMs * Math.pow(policy.factor, Math.max(attempt - 1, 0));
  const jitter = base * policy.jitter * Math.random();
  return Math.min(policy.maxMs, Math.round(base + jitter));
}

function consecutiveVerifierFails(ticks) {
  let n = 0;
  for (let i = ticks.length - 1; i >= 0; i--) {
    const t = ticks[i];
    if (t.status !== 'ran') break;
    if (t.verifier_passed === false) n++;
    else break;
  }
  return n;
}

function isWithinActiveHours(activeHours, now = new Date()) {
  if (!activeHours || !activeHours.start || !activeHours.end) return true;
  const tz = activeHours.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const map = Object.fromEntries(parts.filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]));
  const cur = Number(map.hour) * 60 + Number(map.minute);
  const [sh, sm] = String(activeHours.start).split(':').map(Number);
  const [eh, em] = String(activeHours.end).split(':').map(Number);
  const start = sh * 60 + (sm || 0);
  const end = (eh === 24 ? 24 * 60 : eh * 60 + (em || 0));
  if (start === end) return false;
  if (end > start) return cur >= start && cur < end;
  return cur >= start || cur < end;
}

function acquireMissionLock(missionId, root = process.cwd()) {
  const dir = path.join(root, '.atris', 'state');
  fs.mkdirSync(dir, { recursive: true });
  const lockFile = path.join(dir, `mission-${missionId}.lock`);
  let fd;
  try {
    fd = fs.openSync(lockFile, 'wx');
    fs.writeSync(fd, JSON.stringify({ pid: process.pid, started_at: stampIso(), mission_id: missionId }));
    return { ok: true, lockFile, fd };
  } catch (e) {
    if (e.code === 'EEXIST') {
      let info = {};
      try { info = JSON.parse(fs.readFileSync(lockFile, 'utf8') || '{}'); } catch {}
      return { ok: false, lockFile, busy: true, holder: info };
    }
    return { ok: false, lockFile, error: e.message };
  }
}

function releaseMissionLock(lock) {
  if (!lock || !lock.ok) return;
  try { if (lock.fd != null) fs.closeSync(lock.fd); } catch {}
  try { fs.unlinkSync(lock.lockFile); } catch {}
}

function probeClaudeBinary() {
  const help = spawnSync('claude', ['--help'], { encoding: 'utf8', timeout: 8000 });
  if (help.status !== 0) return { ok: false, error: 'claude --help failed' };
  const text = String(help.stdout || '');
  const required = ['--output-format', '--permission-mode', '--resume', '--session-id', '--include-partial-messages'];
  const missing = required.filter((flag) => !text.includes(flag));
  if (missing.length) return { ok: false, error: `claude binary missing flags: ${missing.join(', ')}` };
  return { ok: true };
}

function buildTickPrompt(mission, tickIndex, maxTicks, frozen) {
  const lines = [
    `# Mission Tick ${tickIndex}/${maxTicks}`,
    ``,
    `**Objective:** ${mission.objective}`,
    `**Owner:** ${mission.owner}`,
    `**Lane:** ${frozen.lane}`,
    `**Cadence:** ${mission.cadence}`,
    `**Stop condition:** ${mission.stop_condition || 'human marks complete'}`,
    `**Verifier (frozen):** ${frozen.verifier || '(none — receipt only)'}`,
    `**Last status:** ${mission.status}`,
    `**Last tick:** ${mission.last_tick_at || 'never'}`,
    ``,
    `## Your task`,
    `Do ONE increment of work toward the stop condition. ONE. No more.`,
    `- You are the member "${mission.owner}". Read atris/team/${mission.owner}/MEMBER.md (and SOUL.md if present) before acting — work in that identity, inside its scope and stop rules. After your work, append what you did and what you learned to atris/team/${mission.owner}/logs/<today's date>.md.`,
    `- FIRST: inspect current mission/task state before acting. Read the relevant files, run \`atris mission status ${mission.id}\`, \`git status\`, or \`atris task list\` as needed so you know what's already done.`,
    `- Pick the smallest concrete action that moves the mission forward.`,
    `- Edit / run / research as needed for the lane.`,
    `- After your work, the harness runs the frozen verifier — make sure it'll pass.`,
    `- If you can't make progress this tick, say why explicitly. Don't fake it.`,
    ``,
    `## Constraints`,
    `- Lane = ${frozen.lane}: stay inside that lane.`,
    `- Do NOT modify mission.verifier, mission.lane, or any tool policy.`,
    `- Do NOT start new missions, modify other missions, or expand scope.`,
    `- Do NOT run destructive commands without strong evidence they're correct.`,
    ``,
    `When done, output a short receipt: (1) the exact files edited / commands run / artifacts produced — name them, (2) the metric of progress, (3) what the next tick should pick up. End the receipt with one line naming the layer this tick touched: \`layer: identity|beliefs|capabilities|behaviors|environment\` (final line — the harness parses it).`,
  ];
  if (mission.task_ids?.length) {
    lines.push('', `## Task ids`, mission.task_ids.map((t) => `- ${t}`).join('\n'));
  }
  if (mission.human_asks?.length) {
    lines.push('', `## Human asks (don't act on these — surface them)`, mission.human_asks.map((t) => `- ${t}`).join('\n'));
  }
  return lines.join('\n');
}

function spawnClaudeTick(mission, opts) {
  const { sessionMode, sessionId, cwd, signal, timeoutMs, prompt, model } = opts;
  return new Promise((resolve) => {
    const args = [
      '-p', prompt,
      '--output-format', 'stream-json',
      '--verbose',
      '--permission-mode', 'bypassPermissions',
      '--include-partial-messages',
    ];
    if (model) args.push('--model', model);
    if (sessionMode === 'set') args.push('--session-id', sessionId);
    else if (sessionMode === 'resume') args.push('--resume', sessionId);

    const startedAt = Date.now();
    const proc = spawn('claude', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });

    let stdoutBuf = '';
    let observedSessionIds = new Set();
    let finalText = null;
    let isError = false;
    let costEstimate = null;
    let durationApiMs = null;
    let numTurns = null;
    let rateLimitInfo = null;
    let stopReason = null;
    let parseErrors = 0;
    let stderr = '';
    let timedOut = false;
    let aborted = false;

    const kill = (reason) => {
      try { proc.kill('SIGTERM'); } catch {}
      setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 3000).unref();
    };
    const timer = setTimeout(() => { timedOut = true; kill('timeout'); }, timeoutMs);
    const onAbort = () => { aborted = true; kill('aborted'); };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    proc.stdout.on('data', (chunk) => {
      stdoutBuf += chunk.toString();
      let nl;
      while ((nl = stdoutBuf.indexOf('\n')) !== -1) {
        const line = stdoutBuf.slice(0, nl).trim();
        stdoutBuf = stdoutBuf.slice(nl + 1);
        if (!line) continue;
        try {
          const ev = JSON.parse(line);
          if (ev.session_id) observedSessionIds.add(ev.session_id);
          if (ev.type === 'rate_limit_event' && ev.rate_limit_info) {
            rateLimitInfo = ev.rate_limit_info;
          }
          if (ev.type === 'result') {
            if (typeof ev.result === 'string') finalText = ev.result;
            if (ev.is_error) isError = true;
            if (typeof ev.total_cost_usd === 'number') costEstimate = ev.total_cost_usd;
            if (typeof ev.duration_api_ms === 'number') durationApiMs = ev.duration_api_ms;
            if (typeof ev.num_turns === 'number') numTurns = ev.num_turns;
            if (ev.stop_reason) stopReason = ev.stop_reason;
          }
        } catch {
          parseErrors++;
        }
      }
    });

    proc.stderr.on('data', (c) => { stderr += c.toString(); });

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener?.('abort', onAbort);
      const ok = code === 0 && !isError && !timedOut && !aborted;
      const errStr = stderr.slice(-2000);
      const authExpired = /not authenticated|please log in|login required|auth(?:entication)? expired/i.test(errStr);
      resolve({
        ok,
        timedOut,
        aborted,
        authExpired,
        exitCode: code,
        sessionIds: Array.from(observedSessionIds),
        result: finalText,
        summary: usefulClaudeReceiptSummary(finalText, ok ? 'no-text' : 'error'),
        receipt_text: cappedClaudeReceiptText(finalText),
        api_equivalent_estimate: costEstimate,
        duration_api_ms: durationApiMs,
        duration_total_ms: Date.now() - startedAt,
        num_turns: numTurns,
        stop_reason: stopReason,
        is_error: isError,
        rate_limit_info: rateLimitInfo,
        stderr: errStr,
        parse_errors: parseErrors,
      });
    });

    proc.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, error: e.message, sessionIds: [], aborted, timedOut, authExpired: false });
    });
  });
}

function stripClaudeReceiptLine(line) {
  return String(line || '')
    .trim()
    .replace(/^#{1,6}\s+/, '')
    .replace(/^[-*]\s+/, '')
    .replace(/^\d+[.)]\s+/, '')
    .trim();
}

function usefulClaudeReceiptSummary(text, fallback = 'no-text') {
  const lines = String(text || '').split(/\r?\n/);
  for (const line of lines) {
    const clean = stripClaudeReceiptLine(line);
    if (!clean) continue;
    if (/^(receipt|summary|final|final answer|result)$/i.test(clean)) continue;
    return clean.slice(0, 240);
  }
  return fallback;
}

function cappedClaudeReceiptText(text, limit = 4000) {
  const clean = String(text || '').trim();
  if (!clean) return '';
  if (clean.length <= limit) return clean;
  return clean.slice(0, limit - 16).trimEnd() + '\n...[truncated]';
}

async function runMission(args) {
  const asJson = wantsJson(args);
  const dueMode = hasFlag(args, '--due');
  const skipClaude = hasFlag(args, '--no-claude');
  const verifyEach = !hasFlag(args, '--no-verify');
  const completeOnPass = hasFlag(args, '--complete-on-pass');
  const skipDrain = hasFlag(args, '--no-drain');
  const maxTicksFlag = readFlag(args, '--max-ticks', '');
  const maxTicks = Math.max(1, Number(maxTicksFlag) || MISSION_RUN_DEFAULTS.maxTicks);
  const maxWallSeconds = Math.max(60, Number(readFlag(args, '--max-wall', '')) || MISSION_RUN_DEFAULTS.maxWallSeconds);
  const cadenceOverride = readFlag(args, '--cadence', '');
  const ref = stripKnownFlags(args, ['--max-ticks', '--max-wall', '--cadence'], ['--json', '--due', '--no-claude', '--no-verify', '--complete-on-pass', '--no-drain'])[0] || '';

  let mission = dueMode && !ref ? selectDueMission() : resolveMission(ref);
  if (!mission && dueMode && !ref) {
    printJsonOrText(
      { ok: true, action: 'run_skipped', reason: 'no_due_mission', mission: null },
      ['No due mission found.'],
      asJson,
    );
    return;
  }
  if (!mission) {
    exitMissionError(ref ? `Mission "${ref}" not found.` : 'Usage: atris mission run <id> [--max-ticks 4] [--max-wall 3600]', 1, asJson);
  }
  if (['complete', 'stopped'].includes(mission.status)) {
    if (asJson) {
      printJsonOrText(
        { ok: true, action: 'run_skipped', reason: mission.status, mission },
        [],
        true,
      );
      return;
    }
    console.error(`Mission ${mission.id} is ${mission.status}; nothing to run.`);
    process.exit(0);
  }

  const preLockCallerSession = runnerUsesCallerSession(mission.runner);
  if (!skipClaude && !preLockCallerSession) {
    const probe = probeClaudeBinary();
    if (!probe.ok) {
      console.error(`[mission run] claude probe failed: ${probe.error}`);
      process.exit(2);
    }
  }

  const lock = acquireMissionLock(mission.id);
  if (!lock.ok) {
    exitMissionError(`[mission run] lock busy (held by pid ${lock.holder?.pid || '?'} since ${lock.holder?.started_at || '?'}). Exit.`, 3, asJson);
  }

  // Everything past lock acquisition runs inside try/finally so the lock + signal handlers
  // always get cleaned up — including saveMission failures during pending-session setup.
  let pauseReason = null;
  let sessionId = null;
  let pendingSessionId = null;
  let ranTicks = 0;
  const ticks = [];
  let onSig = null;

  try {
    const cwd = process.cwd();
    const controller = new AbortController();
    onSig = () => { controller.abort(); };
    process.on('SIGINT', onSig);
    process.on('SIGTERM', onSig);

    // Re-read inside the lock. The initial resolveMission ran pre-lock, so a concurrent
    // `mission tick` could have written between resolveMission and acquireMissionLock.
    // Derive sessionId, pendingSessionId, and the frozen contract from the fresh record
    // so a fast tick's writes can't be silently overwritten by this run loop.
    mission = resolveMission(mission.id) || mission;
    if (['complete', 'stopped'].includes(mission.status)) {
      console.error(`Mission ${mission.id} is ${mission.status}; nothing to run.`);
      return;
    }
    if (mission.status === 'paused') {
      mission = saveMission({
        ...mission,
        status: 'running',
        resumed_at: stampIso(),
        stop_reason: null,
        next_action: `running: atris mission run ${mission.id}`,
      }, cwd, 'mission_run_resumed', { reason: 'operator-resume' }).mission;
    }
    sessionId = mission.claude_session_id || null;
    pendingSessionId = mission.pending_session_id || null;
    const callerSessionRunner = runnerUsesCallerSession(mission.runner);
    const atris2Runner = String(mission.runner || '').trim().toLowerCase() === 'atris2';
    const skipWorker = skipClaude || callerSessionRunner;

    // Freeze run-start contract (verifier, lane). Stored on receipts, not the mission record.
    const frozen = {
      verifier: mission.verifier || '',
      lane: mission.lane || 'workspace',
      started_at: stampIso(),
    };
    const runWorktreeBefore = gitWorktreeSnapshot(cwd);
    const runWorktreeBaseline = loadMissionWorktreeBaseline(mission.id, cwd);
    const cadence = cadenceOverride || mission.cadence || 'manual';
    let cadenceSeconds = parseCadenceSeconds(cadence);
    // cadence=manual|once: exactly 1 tick unless user explicitly raised --max-ticks
    const effectiveMaxTicks = (cadenceSeconds === 0 && !maxTicksFlag) ? 1 : maxTicks;

    // Session setup: only Claude-backed workers need a persisted session id.
    // atris2 turns are stateless per tick — continuity lives on disk (logs, receipts, now.md).
    if (!skipWorker && !atris2Runner && !sessionId && !pendingSessionId) {
      pendingSessionId = crypto.randomUUID();
      mission = saveMission({ ...mission, pending_session_id: pendingSessionId }, cwd, 'mission_session_pending', { session_id: pendingSessionId }).mission;
    }

    const startedAt = Date.now();
    let backoffAttempt = 0;
    let lastRateLimit = null;

    const sessionLabel = skipWorker
      ? 'caller-session'
      : atris2Runner
        ? `atris2 (${mission.model || 'atris:fast'})`
        : (sessionId || `pending=${pendingSessionId}`);
    console.error(`[mission run] ${mission.id}\n  objective: ${mission.objective}\n  lane: ${frozen.lane}\n  cadence: ${cadence} (${cadenceSeconds}s)\n  max_ticks: ${effectiveMaxTicks}, max_wall: ${maxWallSeconds}s\n  session: ${sessionLabel}`);

    while (ticks.length < effectiveMaxTicks) {
      const elapsedSec = (Date.now() - startedAt) / 1000;
      const remainingWall = maxWallSeconds - elapsedSec;
      if (remainingWall <= 0) { pauseReason = 'max-wall-reached'; break; }
      if (controller.signal.aborted) { pauseReason = 'aborted'; break; }

      // Re-read mission, detect mutation of frozen fields
      mission = resolveMission(mission.id) || mission;
      if (['complete', 'stopped', 'paused'].includes(mission.status)) { pauseReason = mission.status; break; }
      if (mission.verifier !== frozen.verifier) { pauseReason = 'verifier-mutated'; break; }
      if ((mission.lane || 'workspace') !== frozen.lane) { pauseReason = 'lane-mutated'; break; }

      const tickIdx = Number(mission.last_tick_index || 0) + 1;
      const tickStart = stampIso();
      const tickWorktreeBefore = gitWorktreeSnapshot(cwd);
      let result = { status: 'skipped', reason: 'unknown', tick_index: tickIdx, ran: false, started_at: tickStart };

      // Active-hours gate
      if (!isWithinActiveHours(mission.active_hours)) {
        result = { ...result, status: 'skipped', reason: 'quiet-hours' };
      }
      // Rate-limit cooldown
      else if (lastRateLimit && lastRateLimit.resetsAt && Date.now() / 1000 < Number(lastRateLimit.resetsAt)) {
        const waitSec = Number(lastRateLimit.resetsAt) - Math.floor(Date.now() / 1000);
        if (waitSec > remainingWall) { pauseReason = 'rate-limit-exceeded-wall'; break; }
        result = { ...result, status: 'skipped', reason: 'rate-limited', resets_at: lastRateLimit.resetsAt };
      }
      // Real tick
      else if (skipWorker) {
        result = {
          ...result,
          status: 'ran',
          reason: callerSessionRunner ? 'caller-session-runner' : 'no-claude-mode',
          ran: true,
          claude: { skipped: true, reason: callerSessionRunner ? 'runner-uses-caller-session' : 'no-claude-mode' },
        };
      } else if (atris2Runner) {
        const prompt = buildTickPrompt(mission, tickIdx, effectiveMaxTicks, frozen);
        const { runAtris2Turn } = require('./probe');
        const turn = await runAtris2Turn({
          prompt,
          model: mission.model || 'atris:fast',
          maxTurns: 16,
          signal: controller.signal,
        });
        result.atris2 = {
          ok: turn.ok,
          engine: turn.engine,
          model: mission.model || 'atris:fast',
          tools_run: turn.tools_run,
          unsupported: turn.unsupported,
          duration_ms: turn.duration_ms,
          error: turn.error,
          receipt_text: String(turn.text || '').slice(0, 4000),
        };
        if (controller.signal.aborted) { pauseReason = 'aborted-during-atris2'; break; }
        if (turn.error === 'not-logged-in') { pauseReason = 'auth-required'; break; }
        if (!turn.ok || !String(turn.text || '').trim()) {
          result = { ...result, status: 'errored', reason: 'atris2-error' };
        } else {
          result = { ...result, status: 'ran', reason: 'tick-ok', ran: true };
        }
      } else {
        const sessionMode = sessionId ? 'resume' : 'set';
        const useId = sessionId || pendingSessionId;
        const prompt = buildTickPrompt(mission, tickIdx, effectiveMaxTicks, frozen);
        const claudeResult = await spawnClaudeTick(mission, {
          sessionMode, sessionId: useId, cwd, signal: controller.signal,
          timeoutMs: MISSION_RUN_DEFAULTS.claudeTimeoutMs, prompt,
          model: mission.model || null,
        });
        result.claude = {
          ok: claudeResult.ok,
          summary: claudeResult.summary,
          receipt_text: claudeResult.receipt_text,
          stop_reason: claudeResult.stop_reason,
          api_equivalent_estimate: claudeResult.api_equivalent_estimate,
          duration_total_ms: claudeResult.duration_total_ms,
          num_turns: claudeResult.num_turns,
          observed_session_ids: claudeResult.sessionIds,
          parse_errors: claudeResult.parse_errors,
          stderr: claudeResult.stderr?.slice(-1000),
          timed_out: claudeResult.timedOut,
          aborted: claudeResult.aborted,
        };
        if (claudeResult.rate_limit_info) {
          lastRateLimit = claudeResult.rate_limit_info;
          if (lastRateLimit.status && lastRateLimit.status !== 'allowed') {
            // throttled / overage
          }
        }
        if (claudeResult.aborted) { pauseReason = 'aborted-during-claude'; break; }
        if (claudeResult.authExpired) { pauseReason = 'auth-required'; break; }

        if (!claudeResult.ok) {
          result = { ...result, status: 'errored', reason: claudeResult.timedOut ? 'claude-timeout' : 'claude-error' };
        } else {
          // Promote pending session id ONLY if claude confirmed the exact UUID we requested.
          // Mismatch is an invariant failure (we sent --session-id X, got Y) → pause, don't rotate.
          if (!sessionId && pendingSessionId) {
            if (claudeResult.sessionIds.includes(pendingSessionId)) {
              sessionId = pendingSessionId;
              mission = saveMission({ ...mission, claude_session_id: sessionId, pending_session_id: null }, cwd, 'mission_session_started', { session_id: sessionId }).mission;
            } else if (claudeResult.sessionIds.length > 0) {
              const observed = claudeResult.sessionIds[0];
              mission = saveMission({ ...mission, session_id_mismatch: { requested: pendingSessionId, observed } }, cwd, 'mission_session_mismatch', { requested: pendingSessionId, observed }).mission;
              pauseReason = 'session-id-mismatch-first-tick';
              break;
            }
          } else if (sessionId && claudeResult.sessionIds.length > 0 && !claudeResult.sessionIds.includes(sessionId)) {
            // session_id mismatch on a resumed session — abort run
            pauseReason = 'session-id-mismatch';
            break;
          }
          result = { ...result, status: 'ran', reason: 'tick-ok', ran: true };
        }
      }

      // Verifier (only if claude succeeded or no-claude mode)
      let verifierResult = null;
      let receiptPath = null;
      if (result.status === 'ran' && verifyEach && frozen.verifier) {
        verifierResult = runVerifier(frozen.verifier);
        result.verifier_passed = verifierResult.passed;
      }

      // Review-lane drain: always-on loops sweep the agent-safe review actions
      // each tick so proof-backed work reaches certified on cadence with zero
      // human turns. Human accept stays the only path to Done; --no-drain opts out.
      if (mission.always_on && result.status === 'ran') {
        result.review_lane = skipDrain
          ? { skipped: true, reason: 'no-drain-flag' }
          : runReviewLaneDrain(cwd);
      }
      const tickWorktree = worktreeReceipt(tickWorktreeBefore, gitWorktreeSnapshot(cwd), { verifier: frozen.verifier, baseline: runWorktreeBaseline });

      // Layer classification needs the receipt text AND the worktree receipt, so it
      // runs here — after both exist — covering the claude and atris2 branches alike.
      const tickReceiptText = result.atris2?.receipt_text || result.claude?.receipt_text || '';
      const layerInfo = extractLayerFromReceiptText(tickReceiptText, tickWorktree?.new_since_baseline_sample);
      result.layer = layerInfo.layer;
      result.layer_source = layerInfo.source;

      // Persist tick to mission state + write structured receipt
      const finishedAt = stampIso();
      const tickRecord = { ...result, started_at: tickStart, finished_at: finishedAt, worktree: tickWorktree };
      ticks.push(tickRecord);
      receiptPath = writeReceipt(mission, {
        kind: 'mission_run_tick',
        tick: tickRecord,
        frozen,
        verifier_result: verifierResult,
        rate_limit_info: lastRateLimit,
        worktree: tickWorktree,
      });

      const xpReadyAction = missionXpReadyAction(mission, receiptPath);
      const newStatus = (verifierResult?.passed && mission.always_on) ? 'ready' :
                        (verifierResult?.passed && xpReadyAction) ? 'ready' :
                        (verifierResult?.passed && completeOnPass) ? 'complete' :
                        (verifierResult?.passed ? 'ready' :
                        (verifierResult ? 'blocked' :
                        (result.status === 'ran' ? 'running' : mission.status)));
      let nextAction = mission.next_action;
      if (verifierResult?.passed && mission.always_on) {
        nextAction = nextCandidateTickAction(mission);
      } else if (verifierResult?.passed && xpReadyAction) {
        nextAction = xpReadyAction;
      } else if (verifierResult?.passed && completeOnPass) {
        nextAction = 'mission complete';
      } else if (verifierResult?.passed) {
        nextAction = `review proof then run: atris mission complete ${mission.id} --proof "${receiptPath}"`;
      } else if (verifierResult) {
        nextAction = 'fix verifier failure or revise mission';
      }
      mission = saveMission({
        ...mission,
        status: newStatus,
        last_tick_at: finishedAt,
        last_tick_status: result.status,
        last_tick_reason: result.reason,
        last_tick_index: tickIdx,
        last_tick_layer: result.layer,
        last_tick_layer_source: result.layer_source,
        verifier_result: verifierResult || mission.verifier_result || null,
        receipt_path: receiptPath,
        next_action: nextAction,
      }, cwd, 'mission_tick', {
        tick_index: tickIdx, status: result.status, reason: result.reason, receipt_path: receiptPath, layer: result.layer,
      }).mission;
      appendMemberLog(mission.owner, `Mission run tick ${tickIdx}`, {
        mission: mission.objective,
        state: mission.status,
        tick_status: result.status,
        reason: result.reason,
        layer: result.layer || undefined,
        verifier: verifierResult ? (verifierResult.passed ? 'passed' : 'failed') : 'not_run',
        receipt: receiptPath,
      });
      refreshCodexGoalController(cwd);

      console.error(`[tick ${tickIdx}] status=${result.status} reason=${result.reason} verifier=${verifierResult ? (verifierResult.passed ? 'pass' : 'fail') : 'skip'} -> ${receiptPath || '-'}`);

      if (result.status === 'ran') {
        ranTicks++;
        backoffAttempt = 0;
      } else if (result.status === 'errored') {
        backoffAttempt++;
      }

      if (newStatus === 'complete' || (newStatus === 'ready' && !mission.always_on)) break;
      if (consecutiveVerifierFails(ticks) >= 2) { pauseReason = 'consecutive-verifier-fails'; break; }

      // Sleep until next tick
      let sleepMs = 0;
      if (result.status === 'errored') {
        sleepMs = computeBackoff(MISSION_RUN_DEFAULTS.backoff, backoffAttempt);
      } else if (cadenceSeconds > 0) {
        sleepMs = cadenceSeconds * 1000;
      } else if (result.status === 'skipped' && result.reason === 'quiet-hours') {
        sleepMs = 60_000; // 1min poll while waiting for window
      } else if (result.status === 'skipped' && result.reason === 'rate-limited') {
        sleepMs = Math.min(60_000, (Number(lastRateLimit.resetsAt) * 1000) - Date.now());
      }
      const remainingMs = remainingWall * 1000 - 1;
      sleepMs = Math.min(Math.max(0, sleepMs), Math.max(0, remainingMs));
      if (sleepMs > 0 && ticks.length < effectiveMaxTicks) {
        try { await sleep(sleepMs, controller.signal); }
        catch (e) { if (e.code === 'ABORTED') { pauseReason = 'aborted'; break; } throw e; }
      }
    }

    if (!pauseReason && ticks.length >= effectiveMaxTicks) {
      const lastTick = ticks[ticks.length - 1];
      if (lastTick && lastTick.status !== 'ran') pauseReason = 'max-ticks-reached';
    }

    if (pauseReason && !['complete', 'ready', 'max-wall-reached'].includes(pauseReason)) {
      mission = saveMission({
        ...mission,
        status: 'paused',
        paused_at: stampIso(),
        stop_reason: pauseReason,
        next_action: `resume with: atris mission run ${mission.id}`,
      }, cwd, 'mission_run_paused', { reason: pauseReason }).mission;
    }

    const summaryWorktree = worktreeReceipt(runWorktreeBefore, gitWorktreeSnapshot(cwd), { verifier: frozen.verifier, baseline: runWorktreeBaseline });
    const finalReceipt = writeReceipt(mission, {
      kind: 'mission_run_summary',
      frozen,
      pause_reason: pauseReason,
      ran_ticks: ranTicks,
      tick_count: ticks.length,
      ticks,
      session_id: sessionId,
      pending_session_id: mission.pending_session_id || null,
      elapsed_seconds: (Date.now() - startedAt) / 1000,
      worktree: summaryWorktree,
    });
    const codexGoalState = refreshCodexGoalController(cwd);

    printJsonOrText(
      { ok: true, action: 'mission_run', mission, ran_ticks: ranTicks, tick_count: ticks.length, ticks, pause_reason: pauseReason, session_id: sessionId, summary_receipt: finalReceipt, worktree: summaryWorktree, codex_goal_state: codexGoalState },
      [
        `Ran mission ${mission.id}`,
        `  objective: ${mission.objective}`,
        `  ran_ticks: ${ranTicks}/${effectiveMaxTicks}  (skipped/errored: ${ticks.length - ranTicks})`,
        `  final state: ${mission.status}`,
        pauseReason ? `  pause: ${pauseReason}` : null,
        `  session: ${sessionId || '(none)'}`,
        `  summary receipt: ${finalReceipt}`,
      ].filter(Boolean),
      asJson,
    );
  } finally {
    if (onSig) {
      try { process.removeListener('SIGINT', onSig); } catch {}
      try { process.removeListener('SIGTERM', onSig); } catch {}
    }
    releaseMissionLock(lock);
  }
}

function tickMission(args) {
  const asJson = wantsJson(args);
  const verify = hasFlag(args, '--verify');
  const completeOnPass = hasFlag(args, '--complete-on-pass');
  const summary = readFlag(args, '--summary', '');
  const ref = stripKnownFlags(args, ['--summary'], ['--json', '--verify', '--complete-on-pass'])[0] || '';
  let mission = resolveMission(ref);
  if (!mission) {
    exitMissionError(ref ? `Mission "${ref}" not found.` : 'No mission found. Run: atris mission start "..."', 1, asJson);
  }

  // Same per-mission flock that `mission run` uses. Without it, a tick could
  // increment last_tick_index/receipt_path concurrently with a run loop and
  // get its mutation overwritten by the run's saveMission on the next tick.
  const lock = acquireMissionLock(mission.id);
  if (!lock.ok) {
    exitMissionError(`[mission tick] lock busy (held by pid ${lock.holder?.pid || '?'} since ${lock.holder?.started_at || '?'}). Exit.`, 3, asJson);
  }

  try {
    // Re-read inside the lock — the initial resolveMission ran before we held it.
    mission = resolveMission(mission.id) || mission;

    if (['complete', 'stopped'].includes(mission.status)) {
      const { mission: saved } = saveMission({ ...mission, next_action: 'mission is closed' }, process.cwd(), 'mission_tick_skipped', { reason: mission.status });
      printJsonOrText({ ok: true, action: 'tick_skipped', mission: saved }, [`Skipped ${mission.id}: ${mission.status}`], asJson);
      return;
    }

    // Per the /mission skill design, the calling Claude session IS the per-tick LLM.
    // This CLI subcommand records the tick: writes a structured receipt (matching the
    // `mission_run_tick` envelope) and runs the verifier when asked. Always emit a
    // receipt so every tick has its own audit row, not just verifier ticks.
    const cwd = process.cwd();
    const tickStart = stampIso();
    const lastTickIndex = Number(mission.last_tick_index || 0);
    const tickIdx = lastTickIndex + 1;
    const tickWorktreeBefore = gitWorktreeSnapshot(cwd);
    const worktreeBaseline = loadMissionWorktreeBaseline(mission.id, cwd);

    let verifierResult = null;
    if (verify && mission.verifier) {
      verifierResult = runVerifier(mission.verifier);
    }
    const tickWorktree = worktreeReceipt(tickWorktreeBefore, gitWorktreeSnapshot(cwd), { verifier: mission.verifier, baseline: worktreeBaseline });

    // Same layer classification as the run-tick path; manual ticks carry their
    // receipt text in --summary.
    const layerInfo = extractLayerFromReceiptText(summary || '', tickWorktree?.new_since_baseline_sample);
    const tickRecord = {
      status: 'ran',
      reason: 'tick-recorded',
      tick_index: tickIdx,
      ran: true,
      started_at: tickStart,
      claude: { skipped: true, reason: 'orchestrator-is-caller-session' },
      summary: summary || null,
      layer: layerInfo.layer,
      layer_source: layerInfo.source,
      verifier_passed: verifierResult ? !!verifierResult.passed : null,
      finished_at: stampIso(),
      worktree: tickWorktree,
    };
    const receiptPath = writeReceipt(mission, {
      kind: 'mission_tick',
      tick: tickRecord,
      frozen: {
        verifier: mission.verifier || '',
        lane: mission.lane || 'workspace',
        started_at: tickStart,
      },
      verifier_result: verifierResult,
      rate_limit_info: null,
      worktree: tickWorktree,
    });

    let status = 'running';
    let nextAction = mission.verifier ? `run verifier: ${mission.verifier}` : 'attach task, verifier, or proof';
    if (verifierResult?.passed) {
      const xpReadyAction = missionXpReadyAction(mission, receiptPath);
      status = (completeOnPass && !mission.always_on && !xpReadyAction) ? 'complete' : 'ready';
      nextAction = mission.always_on ? nextCandidateTickAction(mission) :
        (xpReadyAction || (completeOnPass ? 'mission complete' : `review proof then run: atris mission complete ${mission.id} --proof "${receiptPath}"`));
    } else if (verifierResult) {
      status = 'blocked';
      nextAction = 'fix verifier failure or revise mission';
    }
    const nextMission = {
      ...mission,
      status,
      receipt_path: receiptPath,
      last_tick_at: tickRecord.finished_at,
      last_tick_status: tickRecord.status,
      last_tick_reason: tickRecord.reason,
      last_tick_index: tickIdx,
      last_tick_layer: tickRecord.layer,
      last_tick_layer_source: tickRecord.layer_source,
      verifier_result: verifierResult || mission.verifier_result || null,
      next_action: nextAction,
    };
    const { mission: saved } = saveMission(nextMission, cwd, 'mission_tick', {
      tick_index: tickIdx, verify, verifier_result: verifierResult, receipt_path: receiptPath, layer: tickRecord.layer,
    });
    const logPath = appendMemberLog(saved.owner, 'Mission tick', {
      mission: saved.objective,
      state: saved.status,
      tick_index: tickIdx,
      layer: tickRecord.layer || undefined,
      verifier: verifierResult ? (verifierResult.passed ? 'passed' : 'failed') : 'not_run',
      receipt: receiptPath,
      summary: summary || undefined,
    });
    const codexGoalState = refreshCodexGoalController(process.cwd());
    printJsonOrText(
      { ok: true, action: 'mission_tick', mission: saved, tick: tickRecord, verifier_result: verifierResult, receipt_path: receiptPath, log_path: logPath, codex_goal_state: codexGoalState },
      [
        `Ticked mission: ${saved.objective}`,
        `State: ${saved.status}`,
        `Tick: ${tickIdx}`,
        `Next: ${saved.next_action}`,
        ...(receiptPath ? [`Receipt: ${receiptPath}`] : []),
      ],
      asJson,
    );
  } finally {
    releaseMissionLock(lock);
  }
}

// Proof receipts are JSON files written by writeReceipt(); anything else
// (free text, command strings, missing paths) reads as null and falls back
// to durable mission state.
function readReceiptProof(proof, root = process.cwd()) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.resolve(root, String(proof || '')), 'utf8'));
    return parsed?.schema === 'atris.mission_receipt.v1' ? parsed : null;
  } catch {
    return null;
  }
}

function receiptShowsPass(receipt) {
  const result = receipt?.result;
  return result?.passed === true
    || result?.verifier_result?.passed === true
    || result?.tick?.verifier_passed === true;
}

// Terminal gate: a verifier mission may only complete on real evidence — a
// passing receipt belonging to this mission, or durable state showing the
// verifier passed. Mirrors the task plane's proof-only accept guard so the
// final transition consumes the receipts instead of trusting free text.
function missionCompletionGate(mission, proof, root = process.cwd()) {
  if (!String(mission.verifier || '').trim()) return { ok: true, source: 'no_verifier' };
  const receipt = readReceiptProof(proof, root);
  if (receipt) {
    if (receipt.mission_id !== mission.id) {
      return { ok: false, source: 'receipt', reason: `proof receipt belongs to mission ${receipt.mission_id}, not ${mission.id}` };
    }
    return receiptShowsPass(receipt)
      ? { ok: true, source: 'receipt', receipt_path: String(proof) }
      : { ok: false, source: 'receipt', reason: 'proof receipt does not show a passing verifier' };
  }
  if (mission.verifier_result?.passed === true) return { ok: true, source: 'mission_state' };
  return { ok: false, source: 'mission_state', reason: 'verifier has not passed for this mission and proof is not a passing receipt' };
}

function completeMission(args) {
  const asJson = wantsJson(args);
  const force = hasFlag(args, '--force');
  const proof = readFlag(args, '--proof', '');
  const ref = stripKnownFlags(args, ['--proof'], ['--json', '--force'])[0] || '';
  if (!ref || !proof) {
    exitMissionError('Usage: atris mission complete <id> --proof "..."', 1, asJson);
  }
  const mission = resolveMission(ref);
  if (!mission) {
    exitMissionError(`Mission "${ref}" not found.`, 1, asJson);
  }
  const gate = missionCompletionGate(mission, proof, process.cwd());
  if (!gate.ok && !force) {
    exitMissionError(`[mission complete] ${gate.reason}. Run: atris mission tick ${mission.id} --verify (or override as operator with --force)`, 2, asJson);
  }
  const baselineSummary = pruneMissionWorktreeBaseline(mission, process.cwd());
  const next = {
    ...mission,
    status: 'complete',
    completed_at: stampIso(),
    proof,
    completion_gate: { ...gate, forced: force && !gate.ok },
    worktree_baseline: baselineSummary || mission.worktree_baseline || null,
    next_action: 'mission complete',
  };
  const { mission: saved } = saveMission(next, process.cwd(), 'mission_completed', { proof, completion_gate: next.completion_gate });
  const logPath = appendMemberLog(saved.owner, 'Mission completed', { mission: saved.objective, proof });
  const codexGoalState = refreshCodexGoalController(process.cwd());
  const xpNextCommand = missionXpReadyAction(saved, proof);
  printJsonOrText(
    { ok: true, action: 'mission_completed', mission: saved, log_path: logPath, codex_goal_state: codexGoalState, xp_next_command: xpNextCommand },
    [`Completed mission: ${saved.objective}`, `Proof: ${proof}`, ...(xpNextCommand ? [`AgentXP: ${xpNextCommand}`] : [])],
    asJson,
  );
}

function stopMission(args) {
  const asJson = wantsJson(args);
  const reason = readFlag(args, '--reason', 'stopped by operator');
  const pause = hasFlag(args, '--pause');
  const ref = stripKnownFlags(args, ['--reason'], ['--json', '--pause'])[0] || '';
  if (!ref) {
    exitMissionError('Usage: atris mission stop <id> [--pause] [--reason "..."]', 1, asJson);
  }
  const mission = resolveMission(ref);
  if (!mission) {
    exitMissionError(`Mission "${ref}" not found.`, 1, asJson);
  }
  const status = pause ? 'paused' : 'stopped';
  // Full stops abandon work, so leave evidence: snapshot the worktree against
  // the mission baseline (what did this mission leave dirty?) before pruning it.
  let receiptPath = null;
  if (!pause) {
    const snapshot = gitWorktreeSnapshot(process.cwd());
    const worktree = worktreeReceipt(snapshot, snapshot, {
      verifier: mission.verifier,
      baseline: loadMissionWorktreeBaseline(mission.id, process.cwd()),
    });
    receiptPath = writeReceipt(mission, { kind: 'mission_stop', reason, worktree });
  }
  const baselineSummary = pause ? null : pruneMissionWorktreeBaseline(mission, process.cwd());
  const next = {
    ...mission,
    status,
    stopped_at: status === 'stopped' ? stampIso() : mission.stopped_at || null,
    paused_at: status === 'paused' ? stampIso() : mission.paused_at || null,
    stop_reason: reason,
    receipt_path: receiptPath || mission.receipt_path || null,
    worktree_baseline: baselineSummary || mission.worktree_baseline || null,
    next_action: status === 'paused' ? `resume with: atris mission tick ${mission.id}` : 'mission stopped',
  };
  const { mission: saved } = saveMission(next, process.cwd(), pause ? 'mission_paused' : 'mission_stopped', { reason, receipt_path: receiptPath });
  const logPath = appendMemberLog(saved.owner, pause ? 'Mission paused' : 'Mission stopped', { mission: saved.objective, reason });
  printJsonOrText(
    { ok: true, action: pause ? 'mission_paused' : 'mission_stopped', mission: saved, receipt_path: receiptPath, log_path: logPath },
    [
      `${pause ? 'Paused' : 'Stopped'} mission: ${saved.objective}`,
      `Reason: ${reason}`,
      ...(receiptPath ? [`Receipt: ${receiptPath}`] : []),
    ],
    asJson,
  );
}

function goalMission(args) {
  const asJson = wantsJson(args);
  const heartbeatMode = hasFlag(args, '--heartbeat');
  const payload = refreshCodexGoalController(process.cwd(), { heartbeat: heartbeatMode });
  if (!payload.goal) {
    printJsonOrText(
      payload,
      ['No active mission found for Codex /goal.'],
      asJson,
    );
    return;
  }

  printJsonOrText(
    payload,
    [
      `Codex /goal: ${payload.goal.objective}`,
      `Reason: ${payload.goal.reason}`,
      `Next: ${payload.goal.next_command}`,
      payload.goal.replace_after,
    ],
    asJson,
  );
}

async function goalLoopMission(args) {
  const asJson = wantsJson(args);
  const noClaude = hasFlag(args, '--no-claude');
  const dryRun = hasFlag(args, '--dry-run');
  const once = hasFlag(args, '--once');
  const maxIterations = once ? 1 : Math.max(1, Number(readFlag(args, '--max-iterations', '')) || 32);
  const maxWallSeconds = Math.max(1, Number(readFlag(args, '--max-wall', '')) || 8 * 60 * 60);
  const root = process.cwd();
  const startedAt = Date.now();
  const events = [];

  for (let index = 0; index < maxIterations; index += 1) {
    const heartbeat = refreshCodexGoalController(root, { heartbeat: true });
    const event = {
      iteration: index + 1,
      heartbeat,
      ran_heavy_work: false,
      dry_run: dryRun,
    };

    if (heartbeat.heartbeat?.due && heartbeat.goal) {
      if (dryRun) {
        event.ran_heavy_work = false;
        event.run = { skipped: true, reason: 'dry-run', command: 'atris mission run --due --max-ticks 1 --complete-on-pass --json' };
      } else {
        event.run = runMissionRunDueOnce(root, { noClaude });
        event.ran_heavy_work = event.run.ok === true;
        event.after_run = refreshCodexGoalController(root, { heartbeat: true });
      }
    }
    events.push(event);

    if (index + 1 >= maxIterations) break;
    const elapsedSeconds = (Date.now() - startedAt) / 1000;
    const remainingSeconds = maxWallSeconds - elapsedSeconds;
    if (remainingSeconds <= 0) break;

    const sleepSeconds = Math.min(
      Number(event.after_run?.heartbeat?.recommended_sleep_seconds ?? event.heartbeat?.heartbeat?.recommended_sleep_seconds ?? 15) || 15,
      remainingSeconds,
    );
    if (sleepSeconds <= 0) continue;
    await sleep(sleepSeconds * 1000);
  }

  const finalState = refreshCodexGoalController(root, { heartbeat: true });
  const payload = {
    ok: true,
    action: 'codex_goal_loop',
    iterations: events.length,
    max_iterations: maxIterations,
    max_wall_seconds: maxWallSeconds,
    heavy_runs: events.filter((event) => event.ran_heavy_work).length,
    events,
    final_state: finalState,
  };
  printJsonOrText(
    payload,
    [
      `Codex goal loop iterations: ${payload.iterations}`,
      `Heavy runs: ${payload.heavy_runs}`,
      `Final action: ${finalState.action}`,
      finalState.goal ? `Final mission: ${finalState.goal.mission_id}` : 'Final mission: none',
    ],
    asJson,
  );
}

function help() {
  console.log(`
atris mission - durable goal + loop + owner + proof state

  atris mission start "<objective>" --owner <member> [--verify "..."] [--always-on] [--xp-task] [--worktree]
                      [--runner manual|claude|atris2|codex_goal] [--model <id>]
                      (runner claude spawns local claude -p per tick, --model passes through;
                       runner atris2 runs each tick as one /atris2/turn on the AtrisOS backend,
                       default model atris:fast; runner codex_goal publishes the goal for a live
                       Codex session to pull via atris mission goal)
  atris mission status [id] [--status <state>] [--limit <n>] [--local] [--json]
  atris mission watch [id] [--interval <s>] [--idle-every <s>]   Live heartbeat: prints a line per tick as it lands
                       (rolls up sibling git-worktree missions; --local scopes to this checkout)
  atris mission goal [--heartbeat] [--json]
  atris mission goal-loop [--max-wall 28800] [--max-iterations 32] [--no-claude] [--json]
  atris mission tick <id> [--verify] [--complete-on-pass] [--summary "..."] [--json]
  atris mission run <id|--due> [--max-ticks 4] [--max-wall 3600] [--cadence "15m"]
                                [--no-claude] [--no-verify] [--complete-on-pass] [--no-drain] [--json]
                       (always-on runs drain the review lane each tick; --no-drain skips)
  atris mission complete <id> --proof "..."
  atris mission stop <id> [--pause] [--reason "..."]

Autonomy recipe:
  1. Pick an owner member: atris member create <member>  (if missing)
  2. Start a current-agent mission with a verifier:
     atris mission start "ship one proof" --owner <member> --runner codex_goal --lane code --verify "npm test" --stop "verifier passes" --xp-task
  3. Codex sessions: atris mission goal --json, then set /goal to goal.objective
     Overnight controller: atris mission goal --heartbeat --json
     Bounded overnight runner: atris mission goal-loop --max-wall 28800 --no-claude --json
  4. Do one bounded step, then record it:
     atris mission tick <id> --verify --summary "what changed"
  5. Close or continue from the receipt:
     atris task current-step --goal-id <mission_id> --as <owner> --proof "<receipt_path>" --json  (if --xp-task)
     atris task accept <xp_task_ref> --reward <n>             (human accept mints AgentXP)
     atris mission complete <id> --proof "<receipt_path>"
     repeat status -> step -> tick for current-agent work
     atris mission run <id> --max-ticks 4 --complete-on-pass  (Claude/always-on runner)
     atris mission run --due --max-ticks 1 --complete-on-pass  (/loop heartbeat)
  Headless: start with --runner claude --cadence "15m" --always-on, then run.

Backend/web agents:
  In atrisos-backend and atrisos-web, check active missions before choosing work.
  If no active mission exists and autonomy was requested, create one with owner,
  verifier, lane, and stop condition before starting the loop.

Filters:
  --status active shows planning/running/ready/paused/blocked missions.
  --status complete|stopped|planning|running|ready|paused|blocked shows that exact state.

State:
  .atris/state/missions.jsonl
  .atris/state/mission_events.jsonl
  .atris/state/codex_goal.json
  atris/status/codex-goal.md
  atris/team/<owner>/MISSION.md
  atris/team/<owner>/now.md
  atris/status/now.md
`.trim());
}

// Extract layer classification from receipt text.
// Priority: layer tag on the last non-empty line (source: explicit) >
// last strictly-matching layer line anywhere in the text (source: explicit-inline) >
// changed-path classification (source: fallback). The single-token regex keeps the
// enum docs line ("layer: identity|beliefs|...") from ever matching.
function extractLayerFromReceiptText(text, fallbackPaths = []) {
  const text_str = String(text || '').trim();

  if (text_str) {
    // Matches a standalone "layer: x" line, or a one-line summary ending in
    // "...; layer: x". Quoted bullets ("- layer: x") and the enum-doc line stay inert.
    const layerPattern = /^(?:.*;\s*)?layer:\s*(identity|beliefs|capabilities|behaviors|environment)\s*$/i;
    const lines = text_str.split(/\r?\n/).reverse();
    let isLastNonEmpty = true;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const match = trimmed.match(layerPattern);
      if (match) {
        return { layer: match[1].toLowerCase(), source: isLastNonEmpty ? 'explicit' : 'explicit-inline' };
      }
      isLastNonEmpty = false;
    }
  }

  // Fallback to path classification
  if (Array.isArray(fallbackPaths) && fallbackPaths.length > 0) {
    const classified = classifyPathsByLayer(fallbackPaths);
    if (classified && classified.layer) {
      return { layer: classified.layer, source: classified.source };
    }
  }

  return { layer: null, source: 'unknown' };
}

// Classify paths into layers. Returns { layer: string, source: string, confidence: number }
// Rules: atris/team/ => identity, atris/lessons.md|atris/wiki/ => beliefs,
// test/|skills/ => capabilities, commands/|bin/ => behaviors, else environment
function classifyPathsByLayer(paths) {
  if (!Array.isArray(paths) || paths.length === 0) {
    return { layer: null, source: 'unknown' };
  }

  const counts = {
    identity: 0,
    beliefs: 0,
    capabilities: 0,
    behaviors: 0,
    environment: 0,
  };

  for (const pathStr of paths) {
    const p = String(pathStr || '');
    if (p.includes('atris/team/')) {
      counts.identity++;
    } else if (p.includes('atris/lessons.md') || p.includes('atris/wiki/')) {
      counts.beliefs++;
    } else if (p.includes('test/') || p.includes('skills/')) {
      counts.capabilities++;
    } else if (p.includes('commands/') || p.includes('bin/')) {
      counts.behaviors++;
    } else {
      counts.environment++;
    }
  }

  // Find max with tie-break: identity > beliefs > capabilities > behaviors > environment
  const tieBreakOrder = ['identity', 'beliefs', 'capabilities', 'behaviors', 'environment'];
  let maxCount = 0;
  let winnerLayer = null;
  for (const layer of tieBreakOrder) {
    if (counts[layer] > maxCount) {
      maxCount = counts[layer];
      winnerLayer = layer;
    }
  }

  return winnerLayer ? { layer: winnerLayer, source: 'fallback' } : { layer: null, source: 'unknown' };
}

function missionCommand(args) {
  const subcommand = args[0] || 'status';
  const rest = args.slice(1);
  switch (subcommand) {
    case 'start':
    case 'create':
    case 'new':
      return startMission(rest);
    case 'status':
    case 'list':
    case 'ls':
      return statusMission(rest);
    case 'watch':
      return watchMission(rest);
    case 'goal':
    case 'codex-goal':
      return goalMission(rest);
    case 'goal-loop':
    case 'codex-goal-loop':
      return goalLoopMission(rest);
    case 'tick':
      return tickMission(rest);
    case 'run':
      return runMission(rest);
    case 'complete':
    case 'done':
      return completeMission(rest);
    case 'stop':
    case 'pause':
      return stopMission(subcommand === 'pause' ? ['--pause', ...rest] : rest);
    case 'help':
    case '--help':
    case '-h':
      return help();
    default:
      return help();
  }
}

module.exports = {
  missionCommand,
  missionHeartbeatLines,
  listMissions,
  loadMissionMap,
  renderMissionStatus,
  selectDueMission,
  selectCodexGoalMission,
  usefulClaudeReceiptSummary,
  cappedClaudeReceiptText,
  extractLayerFromReceiptText,
  classifyPathsByLayer,
};
