'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const VALID_STATUSES = new Set(['planning', 'running', 'ready', 'paused', 'blocked', 'stopped', 'complete']);

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

function readPositiveIntegerFlag(args, name, fallback = null) {
  const raw = readFlag(args, name, '');
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    console.error(`${name} must be a positive integer`);
    process.exit(2);
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

function assertMissionVerifier(command) {
  const issue = lintMissionVerifier(command);
  if (!issue) return;
  console.error(`Invalid --verify: ${issue}. Example: --verify 'test $(wc -l < atris/learnings.jsonl) -ge 478'`);
  process.exit(2);
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

function statePaths(root = process.cwd()) {
  const stateDir = path.join(root, '.atris', 'state');
  return {
    stateDir,
    missionsJsonl: path.join(stateDir, 'missions.jsonl'),
    eventsJsonl: path.join(stateDir, 'mission_events.jsonl'),
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
    if (mission && mission.id) map.set(mission.id, mission);
  }
  return map;
}

function listMissions(root = process.cwd()) {
  return Array.from(loadMissionMap(root).values())
    .sort((a, b) => String(b.updated_at || b.created_at || '').localeCompare(String(a.updated_at || a.created_at || '')));
}

function resolveMission(ref, root = process.cwd()) {
  const missions = listMissions(root);
  if (!ref) return missions.find((mission) => mission.status !== 'complete' && mission.status !== 'stopped') || missions[0] || null;
  return missions.find((mission) => mission.id === ref || mission.id.startsWith(ref) || mission.slug === ref) || null;
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
  const next = {
    ...mission,
    schema: 'atris.mission.v1',
    updated_at: stampIso(),
  };
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
    lines.push(`- runner: ${mission.runner}`);
    lines.push(`- lane: ${mission.lane}`);
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

function renderMissionStatus(root = process.cwd()) {
  const paths = statePaths(root);
  const missions = listMissions(root);
  fs.mkdirSync(path.dirname(paths.statusNow), { recursive: true });
  const active = missions.filter((mission) => !['complete', 'stopped'].includes(mission.status));
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
      if (mission.receipt_path) lines.push(`  - proof: ${mission.receipt_path}`);
    }
    lines.push('');
  }
  lines.push(`Active missions: ${active.length}`);
  lines.push('');
  fs.writeFileSync(paths.statusNow, lines.join('\n'), 'utf8');
  return paths.statusNow;
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
  ], ['--json', '--always-on']).join(' ').trim();
  if (!objective) {
    console.error('Usage: atris mission start "<objective>" --owner <member> [--verify "..."] [--cadence manual]');
    process.exit(1);
  }
  const owner = readFlag(args, '--owner', process.env.ATRIS_AGENT_ID || 'mission-lead');
  const cadence = readFlag(args, '--cadence', readFlag(args, '--loop', 'manual')) || 'manual';
  const runner = readFlag(args, '--runner', 'manual');
  const lane = readFlag(args, '--lane', 'workspace');
  const verifier = readFlag(args, '--verify', '');
  assertMissionVerifier(verifier);
  const stopCondition = readFlag(args, '--stop', verifier ? 'verifier passes and no human asks remain' : 'human marks complete with proof');
  const taskIds = readRepeatedFlag(args, '--task');
  const humanAsks = readRepeatedFlag(args, '--ask');
  const alwaysOn = hasFlag(args, '--always-on');
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
    lane,
    verifier,
    always_on: alwaysOn,
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

function startMission(args) {
  const asJson = wantsJson(args);
  const mission = missionFromArgs(args);
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
  printJsonOrText(
    { ok: true, action: 'mission_started', mission: saved, state_path: statePaths().missionsJsonl, member_state: memberState, log_path: logPath },
    [
      `Started mission: ${saved.objective}`,
      `Owner: ${saved.owner}`,
      `State: ${saved.status}`,
      `Next: atris mission tick ${saved.id}`,
    ],
    asJson,
  );
}

function statusMission(args) {
  const asJson = wantsJson(args);
  const ref = stripKnownFlags(args, ['--status', '--limit'], ['--json'])[0] || '';
  const statusFilter = readFlag(args, '--status', '');
  if (statusFilter && !VALID_STATUSES.has(statusFilter)) {
    console.error(`Invalid --status: ${statusFilter}`);
    process.exit(2);
  }
  const limit = readPositiveIntegerFlag(args, '--limit');
  let missions = ref ? [resolveMission(ref)].filter(Boolean) : listMissions();
  if (!ref && statusFilter) missions = missions.filter((mission) => mission.status === statusFilter);
  if (!ref && limit) missions = missions.slice(0, limit);
  if (ref && !missions.length) {
    console.error(`Mission "${ref}" not found.`);
    process.exit(1);
  }
  for (const owner of new Set(missions.map((mission) => mission.owner).filter(Boolean))) {
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
        `  next: ${mission.next_action || 'tick or verify'}`,
        ...(mission.receipt_path ? [`  proof: ${mission.receipt_path}`] : []),
      ])
      : ['No missions yet. Run: atris mission start "..." --owner <member>'],
    asJson,
  );
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

function runVerifier(command, root = process.cwd()) {
  if (!command) return null;
  const result = spawnSync(command, {
    cwd: root,
    shell: true,
    encoding: 'utf8',
    timeout: 120000,
    env: process.env,
  });
  return {
    command,
    status: result.status,
    signal: result.signal || null,
    passed: result.status === 0,
    stdout: String(result.stdout || '').slice(-4000),
    stderr: String(result.stderr || '').slice(-4000),
  };
}

// ---------------------------------------------------------------------------
// `atris mission run <id>` — bounded local headless loop. v0.1.
// Spawns `claude -p --resume <session>` per tick. Honors cadence, active-hours,
// rate-limit info, and a flock per mission. Only consumes max-ticks on `ran`.
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
  return `next move: run atris mission run ${mission.id} --complete-on-pass`;
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
    `When done, output a short receipt: (1) the exact files edited / commands run / artifacts produced — name them, (2) the metric of progress, (3) what the next tick should pick up.`,
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
  const { sessionMode, sessionId, cwd, signal, timeoutMs, prompt } = opts;
  return new Promise((resolve) => {
    const args = [
      '-p', prompt,
      '--output-format', 'stream-json',
      '--verbose',
      '--permission-mode', 'bypassPermissions',
      '--include-partial-messages',
    ];
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
        summary: (finalText || '').split('\n').filter(Boolean)[0]?.slice(0, 240) || (ok ? 'no-text' : 'error'),
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

async function runMission(args) {
  const asJson = wantsJson(args);
  const skipClaude = hasFlag(args, '--no-claude');
  const verifyEach = !hasFlag(args, '--no-verify');
  const completeOnPass = hasFlag(args, '--complete-on-pass');
  const maxTicksFlag = readFlag(args, '--max-ticks', '');
  const maxTicks = Math.max(1, Number(maxTicksFlag) || MISSION_RUN_DEFAULTS.maxTicks);
  const maxWallSeconds = Math.max(60, Number(readFlag(args, '--max-wall', '')) || MISSION_RUN_DEFAULTS.maxWallSeconds);
  const cadenceOverride = readFlag(args, '--cadence', '');
  const ref = stripKnownFlags(args, ['--max-ticks', '--max-wall', '--cadence'], ['--json', '--no-claude', '--no-verify', '--complete-on-pass'])[0] || '';

  let mission = resolveMission(ref);
  if (!mission) {
    console.error(ref ? `Mission "${ref}" not found.` : 'Usage: atris mission run <id> [--max-ticks 4] [--max-wall 3600]');
    process.exit(1);
  }
  if (['complete', 'stopped'].includes(mission.status)) {
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
    console.error(`[mission run] lock busy (held by pid ${lock.holder?.pid || '?'} since ${lock.holder?.started_at || '?'}). Exit.`);
    process.exit(3);
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
    const skipWorker = skipClaude || callerSessionRunner;

    // Freeze run-start contract (verifier, lane). Stored on receipts, not the mission record.
    const frozen = {
      verifier: mission.verifier || '',
      lane: mission.lane || 'workspace',
      started_at: stampIso(),
    };
    const cadence = cadenceOverride || mission.cadence || 'manual';
    let cadenceSeconds = parseCadenceSeconds(cadence);
    // cadence=manual|once: exactly 1 tick unless user explicitly raised --max-ticks
    const effectiveMaxTicks = (cadenceSeconds === 0 && !maxTicksFlag) ? 1 : maxTicks;

    // Session setup: only Claude-backed workers need a persisted session id.
    if (!skipWorker && !sessionId && !pendingSessionId) {
      pendingSessionId = crypto.randomUUID();
      mission = saveMission({ ...mission, pending_session_id: pendingSessionId }, cwd, 'mission_session_pending', { session_id: pendingSessionId }).mission;
    }

    const startedAt = Date.now();
    let backoffAttempt = 0;
    let lastRateLimit = null;

    const sessionLabel = skipWorker ? 'caller-session' : (sessionId || `pending=${pendingSessionId}`);
    console.error(`[mission run] ${mission.id}\n  objective: ${mission.objective}\n  lane: ${frozen.lane}\n  cadence: ${cadence} (${cadenceSeconds}s)\n  max_ticks: ${effectiveMaxTicks}, max_wall: ${maxWallSeconds}s\n  session: ${sessionLabel}`);

    while (ranTicks < effectiveMaxTicks) {
      const elapsedSec = (Date.now() - startedAt) / 1000;
      const remainingWall = maxWallSeconds - elapsedSec;
      if (remainingWall <= 0) { pauseReason = 'max-wall-reached'; break; }
      if (controller.signal.aborted) { pauseReason = 'aborted'; break; }

      // Re-read mission, detect mutation of frozen fields
      mission = resolveMission(mission.id) || mission;
      if (['complete', 'stopped', 'paused'].includes(mission.status)) { pauseReason = mission.status; break; }
      if (mission.verifier !== frozen.verifier) { pauseReason = 'verifier-mutated'; break; }
      if ((mission.lane || 'workspace') !== frozen.lane) { pauseReason = 'lane-mutated'; break; }

      const tickIdx = ticks.length + 1;
      const tickStart = stampIso();
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
      } else {
        const sessionMode = sessionId ? 'resume' : 'set';
        const useId = sessionId || pendingSessionId;
        const prompt = buildTickPrompt(mission, tickIdx, effectiveMaxTicks, frozen);
        const claudeResult = await spawnClaudeTick(mission, {
          sessionMode, sessionId: useId, cwd, signal: controller.signal,
          timeoutMs: MISSION_RUN_DEFAULTS.claudeTimeoutMs, prompt,
        });
        result.claude = {
          ok: claudeResult.ok,
          summary: claudeResult.summary,
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

      // Persist tick to mission state + write structured receipt
      const finishedAt = stampIso();
      const tickRecord = { ...result, started_at: tickStart, finished_at: finishedAt };
      ticks.push(tickRecord);
      receiptPath = writeReceipt(mission, {
        kind: 'mission_run_tick',
        tick: tickRecord,
        frozen,
        verifier_result: verifierResult,
        rate_limit_info: lastRateLimit,
      });

      const newStatus = (verifierResult?.passed && completeOnPass && !mission.always_on) ? 'complete' :
                        (verifierResult?.passed ? 'ready' :
                        (verifierResult ? 'blocked' :
                        (result.status === 'ran' ? 'running' : mission.status)));
      let nextAction = mission.next_action;
      if (verifierResult?.passed && mission.always_on) {
        nextAction = nextCandidateTickAction(mission);
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
        verifier_result: verifierResult || mission.verifier_result || null,
        receipt_path: receiptPath,
        next_action: nextAction,
      }, cwd, 'mission_tick', {
        tick_index: tickIdx, status: result.status, reason: result.reason, receipt_path: receiptPath,
      }).mission;
      appendMemberLog(mission.owner, `Mission run tick ${tickIdx}`, {
        mission: mission.objective,
        state: mission.status,
        tick_status: result.status,
        reason: result.reason,
        verifier: verifierResult ? (verifierResult.passed ? 'passed' : 'failed') : 'not_run',
        receipt: receiptPath,
      });

      console.error(`[tick ${tickIdx}] status=${result.status} reason=${result.reason} verifier=${verifierResult ? (verifierResult.passed ? 'pass' : 'fail') : 'skip'} -> ${receiptPath || '-'}`);

      if (result.status === 'ran') {
        ranTicks++;
        backoffAttempt = 0;
      } else if (result.status === 'errored') {
        backoffAttempt++;
      }

      if (newStatus === 'complete' || newStatus === 'ready') break;
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
      if (sleepMs > 0 && ranTicks < effectiveMaxTicks) {
        try { await sleep(sleepMs, controller.signal); }
        catch (e) { if (e.code === 'ABORTED') { pauseReason = 'aborted'; break; } throw e; }
      }
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
    });

    printJsonOrText(
      { ok: true, action: 'mission_run', mission, ran_ticks: ranTicks, tick_count: ticks.length, ticks, pause_reason: pauseReason, session_id: sessionId, summary_receipt: finalReceipt },
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
    console.error(ref ? `Mission "${ref}" not found.` : 'No mission found. Run: atris mission start "..."');
    process.exit(1);
  }

  // Same per-mission flock that `mission run` uses. Without it, a tick could
  // increment last_tick_index/receipt_path concurrently with a run loop and
  // get its mutation overwritten by the run's saveMission on the next tick.
  const lock = acquireMissionLock(mission.id);
  if (!lock.ok) {
    console.error(`[mission tick] lock busy (held by pid ${lock.holder?.pid || '?'} since ${lock.holder?.started_at || '?'}). Exit.`);
    process.exit(3);
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
    const tickStart = stampIso();
    const lastTickIndex = Number(mission.last_tick_index || 0);
    const tickIdx = lastTickIndex + 1;

    let verifierResult = null;
    if (verify && mission.verifier) {
      verifierResult = runVerifier(mission.verifier);
    }

    const tickRecord = {
      status: 'ran',
      reason: 'tick-recorded',
      tick_index: tickIdx,
      ran: true,
      started_at: tickStart,
      claude: { skipped: true, reason: 'orchestrator-is-caller-session' },
      summary: summary || null,
      verifier_passed: verifierResult ? !!verifierResult.passed : null,
      finished_at: stampIso(),
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
    });

    let status = 'running';
    let nextAction = mission.verifier ? `run verifier: ${mission.verifier}` : 'attach task, verifier, or proof';
    if (verifierResult?.passed) {
      status = (completeOnPass && !mission.always_on) ? 'complete' : 'ready';
      nextAction = mission.always_on ? nextCandidateTickAction(mission) :
        (completeOnPass ? 'mission complete' : `review proof then run: atris mission complete ${mission.id} --proof "${receiptPath}"`);
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
      verifier_result: verifierResult || mission.verifier_result || null,
      next_action: nextAction,
    };
    const { mission: saved } = saveMission(nextMission, process.cwd(), 'mission_tick', {
      tick_index: tickIdx, verify, verifier_result: verifierResult, receipt_path: receiptPath,
    });
    const logPath = appendMemberLog(saved.owner, 'Mission tick', {
      mission: saved.objective,
      state: saved.status,
      tick_index: tickIdx,
      verifier: verifierResult ? (verifierResult.passed ? 'passed' : 'failed') : 'not_run',
      receipt: receiptPath,
      summary: summary || undefined,
    });
    printJsonOrText(
      { ok: true, action: 'mission_tick', mission: saved, tick: tickRecord, verifier_result: verifierResult, receipt_path: receiptPath, log_path: logPath },
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

function completeMission(args) {
  const asJson = wantsJson(args);
  const proof = readFlag(args, '--proof', '');
  const ref = stripKnownFlags(args, ['--proof'], ['--json'])[0] || '';
  if (!ref || !proof) {
    console.error('Usage: atris mission complete <id> --proof "..."');
    process.exit(1);
  }
  const mission = resolveMission(ref);
  if (!mission) {
    console.error(`Mission "${ref}" not found.`);
    process.exit(1);
  }
  const next = {
    ...mission,
    status: 'complete',
    completed_at: stampIso(),
    proof,
    next_action: 'mission complete',
  };
  const { mission: saved } = saveMission(next, process.cwd(), 'mission_completed', { proof });
  const logPath = appendMemberLog(saved.owner, 'Mission completed', { mission: saved.objective, proof });
  printJsonOrText(
    { ok: true, action: 'mission_completed', mission: saved, log_path: logPath },
    [`Completed mission: ${saved.objective}`, `Proof: ${proof}`],
    asJson,
  );
}

function stopMission(args) {
  const asJson = wantsJson(args);
  const reason = readFlag(args, '--reason', 'stopped by operator');
  const pause = hasFlag(args, '--pause');
  const ref = stripKnownFlags(args, ['--reason'], ['--json', '--pause'])[0] || '';
  if (!ref) {
    console.error('Usage: atris mission stop <id> [--pause] [--reason "..."]');
    process.exit(1);
  }
  const mission = resolveMission(ref);
  if (!mission) {
    console.error(`Mission "${ref}" not found.`);
    process.exit(1);
  }
  const status = pause ? 'paused' : 'stopped';
  const next = {
    ...mission,
    status,
    stopped_at: status === 'stopped' ? stampIso() : mission.stopped_at || null,
    paused_at: status === 'paused' ? stampIso() : mission.paused_at || null,
    stop_reason: reason,
    next_action: status === 'paused' ? `resume with: atris mission tick ${mission.id}` : 'mission stopped',
  };
  const { mission: saved } = saveMission(next, process.cwd(), pause ? 'mission_paused' : 'mission_stopped', { reason });
  const logPath = appendMemberLog(saved.owner, pause ? 'Mission paused' : 'Mission stopped', { mission: saved.objective, reason });
  printJsonOrText(
    { ok: true, action: pause ? 'mission_paused' : 'mission_stopped', mission: saved, log_path: logPath },
    [`${pause ? 'Paused' : 'Stopped'} mission: ${saved.objective}`, `Reason: ${reason}`],
    asJson,
  );
}

function help() {
  console.log(`
atris mission - durable goal + loop + owner + proof state

  atris mission start "<objective>" --owner <member> [--verify "..."] [--always-on]
  atris mission status [id] [--json]
  atris mission tick <id> [--verify] [--complete-on-pass] [--summary "..."] [--json]
  atris mission run <id> [--max-ticks 4] [--max-wall 3600] [--cadence "15m"]
                          [--no-claude] [--no-verify] [--complete-on-pass] [--json]
  atris mission complete <id> --proof "..."
  atris mission stop <id> [--pause] [--reason "..."]

State:
  .atris/state/missions.jsonl
  .atris/state/mission_events.jsonl
  atris/team/<owner>/MISSION.md
  atris/team/<owner>/now.md
  atris/status/now.md
`.trim());
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
  listMissions,
  loadMissionMap,
  renderMissionStatus,
};
