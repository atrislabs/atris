'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

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
  ], ['--json']).join(' ').trim();
  if (!objective) {
    console.error('Usage: atris mission start "<objective>" --owner <member> [--verify "..."] [--cadence manual]');
    process.exit(1);
  }
  const owner = readFlag(args, '--owner', process.env.ATRIS_AGENT_ID || 'mission-lead');
  const cadence = readFlag(args, '--cadence', readFlag(args, '--loop', 'manual')) || 'manual';
  const runner = readFlag(args, '--runner', 'manual');
  const lane = readFlag(args, '--lane', 'workspace');
  const verifier = readFlag(args, '--verify', '');
  const stopCondition = readFlag(args, '--stop', verifier ? 'verifier passes and no human asks remain' : 'human marks complete with proof');
  const taskIds = readRepeatedFlag(args, '--task');
  const humanAsks = readRepeatedFlag(args, '--ask');
  const id = missionId(objective);
  return {
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
    stop_condition: stopCondition,
    task_ids: taskIds,
    human_asks: humanAsks,
    next_action: verifier ? 'run verifier with `atris mission tick <id> --verify`' : 'define verifier or run next task',
    receipt_path: null,
    created_at: stampIso(),
    updated_at: stampIso(),
  };
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
  const ref = stripKnownFlags(args, [], ['--json'])[0] || '';
  const missions = ref ? [resolveMission(ref)].filter(Boolean) : listMissions();
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
  fs.writeFileSync(receiptPath, JSON.stringify({
    schema: 'atris.mission_receipt.v1',
    mission_id: mission.id,
    objective: mission.objective,
    owner: mission.owner,
    at: stampIso(),
    verifier: mission.verifier || null,
    result,
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

function tickMission(args) {
  const asJson = wantsJson(args);
  const verify = hasFlag(args, '--verify');
  const completeOnPass = hasFlag(args, '--complete-on-pass');
  const ref = stripKnownFlags(args, [], ['--json', '--verify', '--complete-on-pass'])[0] || '';
  const mission = resolveMission(ref);
  if (!mission) {
    console.error(ref ? `Mission "${ref}" not found.` : 'No mission found. Run: atris mission start "..."');
    process.exit(1);
  }
  if (['complete', 'stopped'].includes(mission.status)) {
    const { mission: saved } = saveMission({ ...mission, next_action: 'mission is closed' }, process.cwd(), 'mission_tick_skipped', { reason: mission.status });
    printJsonOrText({ ok: true, action: 'tick_skipped', mission: saved }, [`Skipped ${mission.id}: ${mission.status}`], asJson);
    return;
  }

  let verifierResult = null;
  let receiptPath = mission.receipt_path || null;
  let status = 'running';
  let nextAction = mission.verifier ? `run verifier: ${mission.verifier}` : 'attach task, verifier, or proof';
  if (verify) {
    verifierResult = runVerifier(mission.verifier);
    receiptPath = writeReceipt(mission, verifierResult);
    if (verifierResult?.passed) {
      status = completeOnPass ? 'complete' : 'ready';
      nextAction = completeOnPass ? 'mission complete' : `review proof then run: atris mission complete ${mission.id} --proof "${receiptPath}"`;
    } else {
      status = 'blocked';
      nextAction = 'fix verifier failure or revise mission';
    }
  }
  const nextMission = {
    ...mission,
    status,
    receipt_path: receiptPath,
    last_tick_at: stampIso(),
    verifier_result: verifierResult,
    next_action: nextAction,
  };
  const { mission: saved } = saveMission(nextMission, process.cwd(), 'mission_tick', { verify, verifier_result: verifierResult, receipt_path: receiptPath });
  const logPath = appendMemberLog(saved.owner, 'Mission tick', {
    mission: saved.objective,
    state: saved.status,
    verifier: verify ? (verifierResult?.passed ? 'passed' : 'failed') : 'not_run',
    receipt: receiptPath,
  });
  printJsonOrText(
    { ok: true, action: 'mission_tick', mission: saved, verifier_result: verifierResult, receipt_path: receiptPath, log_path: logPath },
    [
      `Ticked mission: ${saved.objective}`,
      `State: ${saved.status}`,
      `Next: ${saved.next_action}`,
      ...(receiptPath ? [`Receipt: ${receiptPath}`] : []),
    ],
    asJson,
  );
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

  atris mission start "<objective>" --owner <member> [--verify "..."]
  atris mission status [id] [--json]
  atris mission tick <id> [--verify] [--complete-on-pass] [--json]
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
