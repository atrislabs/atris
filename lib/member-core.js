const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { memberRefusalReason } = require('./member-type');
const { readJson, writeJson } = require('./json-file');

function findWorkspaceBusinessId(startDir = process.cwd()) {
  let dir = path.resolve(startDir);
  while (true) {
    const file = path.join(dir, '.atris', 'business.json');
    if (fs.existsSync(file)) {
      try {
        return JSON.parse(fs.readFileSync(file, 'utf8')).business_id || null;
      } catch (error) {
        console.warn(`Warning: could not parse ${file}: ${error.message}`);
        return null;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function todayLogName() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}.md`;
}

function ensureMemberLog(memberDir, { name, role, description, source = 'cli' } = {}) {
  const logsDir = path.join(memberDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });
  const logPath = path.join(logsDir, todayLogName());
  if (fs.existsSync(logPath)) return logPath;
  const stamp = new Date().toTimeString().slice(0, 5);
  const content = [
    `## ${stamp} · Member initialized`,
    `- team: ${name || path.basename(memberDir)}`,
    role ? `- role: ${role}` : '',
    description ? `- mission: ${description}` : '',
    `- source: ${source}`,
    '- status: ready_for_room',
  ].filter(Boolean).join('\n') + '\n';
  fs.writeFileSync(logPath, content, 'utf8');
  return logPath;
}

function appendMemberLifecycleLog(memberDir, name, action, detail = '') {
  const logsDir = path.join(memberDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });
  const logPath = path.join(logsDir, todayLogName());
  const stamp = new Date().toTimeString().slice(0, 5);
  const content = [
    `## ${stamp} · Member ${action}`,
    `- team: ${name || path.basename(memberDir)}`,
    detail ? `- detail: ${detail}` : '',
    `- status: ${action}`,
    '',
  ].filter(Boolean).join('\n');
  fs.appendFileSync(logPath, content, 'utf8');
  return logPath;
}

function archiveName(name) {
  return `${name}-${todayLogName().replace(/\.md$/, '')}`;
}

function uniqueArchiveDir(archiveRoot, name) {
  const base = archiveName(name);
  let candidate = path.join(archiveRoot, base);
  let i = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(archiveRoot, `${base}-${i}`);
    i += 1;
  }
  return candidate;
}

function parseDaysFlag(flags, fallback = 60) {
  const joined = flags.join(' ');
  const match = joined.match(/--days[=\s]+(\d+)/);
  const days = match ? Number(match[1]) : fallback;
  return Number.isFinite(days) && days >= 0 ? days : fallback;
}

function parseConfirmFlag(flags) {
  const joined = flags.join(' ');
  return joined.match(/--confirm[=\s]+["']?([^"']+)["']?/)?.[1] || '';
}

function readRepeatedFlag(args, name) {
  const values = [];
  const prefix = `${name}=`;
  for (let i = 0; i < args.length; i += 1) {
    const arg = String(args[i]);
    if (arg === name && args[i + 1] && !String(args[i + 1]).startsWith('--')) {
      values.push(String(args[i + 1]).replace(/^["']|["']$/g, ''));
      i += 1;
      continue;
    }
    if (arg.startsWith(prefix)) values.push(arg.slice(prefix.length).replace(/^["']|["']$/g, ''));
  }
  return values.filter(Boolean);
}

function stripKnownFlags(args, valueNames, booleanNames = []) {
  const out = [];
  const valueSet = new Set(valueNames);
  const booleanSet = new Set(['--full', '--verbose', ...booleanNames]);
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

function stampIso() {
  return new Date().toISOString();
}

function fileSafeStamp() {
  return stampIso().replace(/[:.]/g, '-');
}

function slugHash(value) {
  return crypto.createHash('sha1').update(String(value || '')).digest('hex').slice(0, 8);
}

function makeGoalId(title) {
  return `goal-${todayLogName().replace(/\.md$/, '')}-${slugHash(title)}`;
}

function uniqueGoalId(state, baseId) {
  const existingIds = new Set((state.goals || []).map((goal) => goal.id).filter(Boolean));
  if (!existingIds.has(baseId)) return baseId;
  let index = 2;
  let id = `${baseId}-${index}`;
  while (existingIds.has(id)) {
    index += 1;
    id = `${baseId}-${index}`;
  }
  return id;
}

function makeExperimentId(goalId, title) {
  return `exp-${slugHash(`${goalId}:${title}:${Date.now()}`)}`;
}

function taskRef(task) {
  return task?.display_id || task?.displayId || task?.legacy_ref || task?.legacyRef || task?.ref || task?.id || null;
}

function lowerCompact(value) {
  return String(value || '').trim().toLowerCase();
}

function shellQuote(value) {
  return `'${String(value || '').replace(/'/g, "'\\''")}'`;
}

const MEMBER_RUNTIME_ALIASES = Object.freeze({
  'problem-finder': 'signal-scout',
  'info-organizer': 'wiki-miner',
  coordinator: 'supervisor',
  'task-planner': 'objective-generator',
  improver: 'architect',
  'problem-solver': 'generalist',
});

function memberRuntimeKind(name) {
  const key = lowerCompact(name);
  return MEMBER_RUNTIME_ALIASES[key] || key;
}

function resolveMemberRuntime(name) {
  const requestedName = String(name || '').trim();
  const requestedPaths = memberPaths(requestedName);
  const runtimeKind = memberRuntimeKind(requestedName);
  const aliasOf = runtimeKind !== lowerCompact(requestedName) ? runtimeKind : null;
  if (requestedName && fs.existsSync(requestedPaths.memberFile)) {
    return {
      requestedName,
      storageName: requestedName,
      runtimeKind,
      aliasOf,
      paths: requestedPaths,
    };
  }
  if (aliasOf) {
    const legacyPaths = memberPaths(runtimeKind);
    if (fs.existsSync(legacyPaths.memberFile)) {
      return {
        requestedName,
        storageName: runtimeKind,
        runtimeKind,
        aliasOf,
        paths: legacyPaths,
      };
    }
  }
  return {
    requestedName,
    storageName: requestedName,
    runtimeKind,
    aliasOf,
    paths: requestedPaths,
  };
}

function memberPaths(name) {
  const teamDir = path.join(process.cwd(), 'atris', 'team');
  const memberDir = path.join(teamDir, name || '');
  // Steering signals live in the workspace's single .atris/state store. Resolve
  // the shared workspace root (spine -> git -> cwd) so a member run from a
  // subdirectory reads steering from the real store instead of a nonexistent
  // nested .atris, the same resolver the mission/task/usage/autopilot state
  // uses. (teamDir markdown discovery is a separate cwd concern, filed.)
  const workspaceRoot = require('./mission-root').resolveWorkspaceRoot(process.cwd());
  return {
    teamDir,
    memberDir,
    memberFile: path.join(memberDir, 'MEMBER.md'),
    missionFile: path.join(memberDir, 'MISSION.md'),
    goalsJson: path.join(memberDir, 'goals.json'),
    goalsMd: path.join(memberDir, 'goals.md'),
    steeringJsonl: path.join(workspaceRoot, '.atris', 'state', 'steering.jsonl'),
  };
}

function missionFileMarkdown({ name, role, description } = {}) {
  const title = role || name || 'Member';
  const purpose = description || `Define why ${name || 'this member'} exists and how it chooses goals.`;
  return [
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
    `- Use MEMBER.md to stay inside ${title}'s identity, authority, and tools.`,
    '- Choose one useful bounded goal toward this mission.',
    '- Verify the work, write the receipt, and update the log.',
    '- Ask the human when vision, taste, risk, or uncertainty matters.',
    '',
  ].join('\n');
}

function ensureMissionFile(memberDir, { name, role, description } = {}) {
  const missionPath = path.join(memberDir, 'MISSION.md');
  if (!fs.existsSync(missionPath)) {
    fs.writeFileSync(missionPath, missionFileMarkdown({ name, role, description }), 'utf8');
  }
  return missionPath;
}

function listExistingMemberSlugs() {
  const teamDir = path.join(process.cwd(), 'atris', 'team');
  try {
    return fs.readdirSync(teamDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && !entry.name.startsWith('_'))
      .map(entry => entry.name)
      .filter(slug => fs.existsSync(path.join(teamDir, slug, 'MEMBER.md')))
      .sort();
  } catch {
    return [];
  }
}

function editDistance(a, b) {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const dist = Array.from({ length: rows }, (_, i) => [i, ...Array(cols - 1).fill(0)]);
  for (let j = 0; j < cols; j++) dist[0][j] = j;
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      dist[i][j] = Math.min(
        dist[i - 1][j] + 1,
        dist[i][j - 1] + 1,
        dist[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return dist[rows - 1][cols - 1];
}

function nearestMemberSlug(name, slugs) {
  const needle = String(name || '').toLowerCase();
  let best = null;
  let bestScore = Infinity;
  for (const slug of slugs) {
    const score = editDistance(needle, slug.toLowerCase());
    if (score < bestScore) {
      best = slug;
      bestScore = score;
    }
  }
  return bestScore <= Math.max(2, Math.floor(needle.length / 3)) ? best : null;
}

// A person is never run as an agent. Reads the member's own type and returns
// the plain refusal sentence, or '' when the member can run.
function memberRefusalFor(name, memberFile) {
  try {
    return memberRefusalReason(name, parseFrontmatter(fs.readFileSync(memberFile, 'utf8')) || {});
  } catch {
    return '';
  }
}

// Same as requireMemberDir, then stops with a non-zero exit for a human or
// odd-typed member. Every path that runs a member as an agent starts here.
function requireRunnableMember(name) {
  const paths = requireMemberDir(name);
  const reason = memberRefusalFor(name, paths.memberFile);
  if (reason) {
    console.error(reason);
    process.exit(1);
  }
  return paths;
}

function requireMemberDir(name) {
  if (!name) {
    console.error('Usage: atris member <goal|tick|review> <name> ...');
    process.exit(1);
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(name)) {
    console.error('Member name must be a local slug: letters, numbers, dots, underscores, or dashes.');
    process.exit(1);
  }
  const resolved = resolveMemberRuntime(name);
  const paths = resolved.paths;
  if (!fs.existsSync(paths.memberFile)) {
    const aliasHint = resolved.aliasOf ? ` or atris/team/${resolved.aliasOf}/MEMBER.md` : '';
    console.error(`Member "${name}" not found at atris/team/${name}/MEMBER.md${aliasHint}`);
    const team = listExistingMemberSlugs();
    const nearest = nearestMemberSlug(name, team);
    if (nearest) {
      console.error(`Did you mean "${nearest}"?`);
    } else if (team.length) {
      console.error(`Team here: ${team.join(', ')}`);
    } else {
      console.error(`No team members exist here yet. Create one: atris member create ${name} --role="..."`);
    }
    process.exit(1);
  }
  return {
    ...paths,
    requestedName: resolved.requestedName,
    storageName: resolved.storageName,
    runtimeKind: resolved.runtimeKind,
    aliasOf: resolved.aliasOf,
  };
}

function emptyMemberGoals(name) {
  return {
    schema: 'atris.member_goals.v1',
    member: name,
    updated_at: stampIso(),
    goals: [],
  };
}

function loadMemberGoals(name, paths = memberPaths(name)) {
  const parsed = readJson(paths.goalsJson, {}) || {};
  return {
    ...emptyMemberGoals(name),
    ...parsed,
    goals: Array.isArray(parsed.goals) ? parsed.goals : [],
  };
}

function activeGoal(goalsState, goalId = '') {
  if (goalId) return goalsState.goals.find((goal) => goal.id === goalId) || null;
  for (let i = (goalsState.goals || []).length - 1; i >= 0; i -= 1) {
    if (goalsState.goals[i]?.status === 'active') return goalsState.goals[i];
  }
  return goalsState.goals[0] || null;
}

function allExperiments(state) {
  const out = [];
  for (const goal of state.goals || []) {
    for (const experiment of goal.experiments || []) out.push({ goal, experiment });
  }
  return out;
}

function findExperiment(state, experimentId) {
  for (const item of allExperiments(state)) {
    if (item.experiment.id === experimentId) return item;
  }
  return { goal: null, experiment: null };
}

function latestByTime(items, field = 'created_at') {
  return items
    .filter(Boolean)
    .slice()
    .sort((a, b) => String(b[field] || '').localeCompare(String(a[field] || '')))[0] || null;
}

function recentLogLines(memberDir, maxLines = 8) {
  const logsDir = path.join(memberDir, 'logs');
  if (!fs.existsSync(logsDir)) return [];
  const logs = fs.readdirSync(logsDir)
    .filter((name) => /^\d{4}-\d{2}-\d{2}\.md$/.test(name))
    .sort();
  const latest = logs[logs.length - 1];
  if (!latest) return [];
  return fs.readFileSync(path.join(logsDir, latest), 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .slice(-maxLines);
}

function readOptionalText(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function extractMarkdownSection(text, heading) {
  const lines = String(text || '').split(/\r?\n/);
  const target = String(heading || '').trim().toLowerCase();
  const start = lines.findIndex((line) => {
    const match = line.match(/^##\s+(.+?)\s*$/);
    return match && match[1].trim().toLowerCase() === target;
  });
  if (start === -1) return '';
  const out = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^##\s+/.test(lines[i])) break;
    out.push(lines[i]);
  }
  return out.join('\n').trim();
}

function firstUsefulLine(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.replace(/^[-*]\s+/, '').trim())
    .find((line) => line && !line.startsWith('<!--')) || '';
}

function compactSentence(text, max = 120) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  // Cut at a word boundary so titles never end mid-word ("rollb...").
  const cut = clean.slice(0, Math.max(0, max - 1));
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trim()}...`;
}

function activeRuntimeMissionFromNow(nowText) {
  const heading = String(nowText || '').match(/^##\s+(.+?)\s*$/m)?.[1]?.trim() || '';
  const id = String(nowText || '').match(/^- id:\s*(.+?)\s*$/m)?.[1]?.trim() || '';
  const status = String(nowText || '').match(/^- status:\s*(.+?)\s*$/m)?.[1]?.trim() || '';
  const next = String(nowText || '').match(/^- next:\s*(.+?)\s*$/m)?.[1]?.trim() || '';
  return { heading, id, status, next };
}

function missionPurpose(paths) {
  const missionText = readOptionalText(paths.missionFile);
  const nowText = readOptionalText(path.join(paths.memberDir, 'now.md'));
  const northStar = firstUsefulLine(extractMarkdownSection(missionText, 'North Star'));
  const goalGuidance = extractMarkdownSection(missionText, 'How To Choose Goals');
  const runtimeMission = activeRuntimeMissionFromNow(nowText);
  const meaningful = Boolean(northStar) && !/define why .* exists/i.test(northStar);
  return {
    missionText,
    nowText,
    northStar,
    goalGuidance,
    runtimeMission,
    meaningful,
  };
}

const MEMBER_RUN_RUNNABLE_STATUSES = new Set(['planning', 'running', 'ready']);
const MISSION_TERMINAL_STATUSES = new Set(['complete', 'stopped', 'failed']);

function memberRunMissionMap(root = process.cwd()) {
  try {
    const missionMod = require('../commands/mission');
    const map = new Map(missionMod.loadMissionMap(root));
    for (const rolled of missionMod.listWorktreeRollupMissions(root)) {
      if (!rolled?.id) continue;
      const existing = map.get(rolled.id);
      if (!existing || missionTimeMs(rolled) >= missionTimeMs(existing)) {
        map.set(rolled.id, rolled);
      }
    }
    return map;
  } catch {
    return new Map();
  }
}

function memberRunRunnableMissionId(candidateId, missionMap) {
  const id = String(candidateId || '').trim();
  if (!id) return '';
  const mission = missionMap.get(id);
  // Unknown here can mean a worktree-held mission; let mission run decide.
  if (!mission) return id;
  return MEMBER_RUN_RUNNABLE_STATUSES.has(mission.status) ? id : '';
}

function memberRunOwnedActiveMissionId(name, missionMap) {
  // Discovery fallback when the member's own pointers are stale: resume the
  // member's newest moving mission. ready is excluded, it waits for review.
  const owner = String(name || '').trim().toLowerCase();
  const candidates = Array.from(missionMap.values())
    .filter((mission) => String(mission?.owner || '').trim().toLowerCase() === owner)
    .filter((mission) => mission.status === 'running' || mission.status === 'planning')
    .filter((mission) => !/^decide and start the next useful mission after:/i.test(String(mission?.objective || '')))
    .sort((a, b) => {
      if (a.status !== b.status) return a.status === 'running' ? -1 : 1;
      return String(b.updated_at || b.created_at || '').localeCompare(String(a.updated_at || a.created_at || ''));
    });
  return candidates[0]?.id || '';
}

const MEMBER_LIVE_MISSION_STATUSES = new Set(['running', 'planning']);
const MEMBER_ACTIVE_ACTIVITY_MS = 24 * 60 * 60 * 1000;
const MEMBER_RECENT_ACTIVITY_MS = 72 * 60 * 60 * 1000;

function memberSlugFromRecord(member) {
  if (member?.format === 'directory' && member.dir) return path.basename(member.dir);
  if (member?.format === 'flat' && member.path) return path.basename(member.path, '.md');
  return lowerCompact(member?.name || '');
}

function isFleetMember(member) {
  if (!member || member.format !== 'directory') return false;
  const slug = memberSlugFromRecord(member);
  return Boolean(slug) && !new Set(['_archive', '_archived', '_template']).has(slug);
}

function missionTimeMs(mission) {
  return Date.parse(mission?.last_tick_at || mission?.updated_at || mission?.created_at || '') || 0;
}

function memberOwnedMissions(name, missionMap = memberRunMissionMap()) {
  const owner = lowerCompact(name);
  return Array.from(missionMap.values())
    .filter((mission) => lowerCompact(mission?.owner) === owner)
    .sort((a, b) => missionTimeMs(b) - missionTimeMs(a));
}

function memberLatestMission(name, missionMap = memberRunMissionMap()) {
  return memberOwnedMissions(name, missionMap)[0] || null;
}

function memberLiveMission(name, missionMap = memberRunMissionMap()) {
  return memberOwnedMissions(name, missionMap)
    .find((mission) => {
      if (!MEMBER_LIVE_MISSION_STATUSES.has(String(mission?.status || '').toLowerCase())) return false;
      // A closed window can leave a running row behind. Only a known dead
      // process proves it is free; missing process records still hold it.
      try {
        const root = mission.worktree_root || mission.worktree?.path || process.cwd();
        const health = require('../commands/mission').missionDriverHealth(mission, root);
        return !health.pid || health.alive;
      } catch { return true; }
    }) || null;
}

function missionShortName(mission, max = 36) {
  return compactSentence(mission?.slug || mission?.title || mission?.objective || mission?.id || '', max) || '-';
}

function ageLabelFromMs(ms, nowMs = Date.now()) {
  if (!ms) return '-';
  const seconds = Math.max(0, Math.floor((nowMs - ms) / 1000));
  if (seconds < 60) return 'now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function timestampMs(value) {
  const ms = Date.parse(value || '');
  return Number.isFinite(ms) ? ms : 0;
}

function newestMtimeRecursive(root) {
  if (!fs.existsSync(root)) return 0;
  let newest = 0;
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    let stat = null;
    try {
      stat = fs.statSync(current);
    } catch {
      continue;
    }
    newest = Math.max(newest, stat.mtimeMs || 0);
    if (!stat.isDirectory()) continue;
    let entries = [];
    try {
      entries = fs.readdirSync(current);
    } catch {
      continue;
    }
    for (const entry of entries) stack.push(path.join(current, entry));
  }
  return newest;
}

function newestRunActivityMtime(name, root = process.cwd()) {
  const runsDir = path.join(root, 'atris', 'runs');
  if (!fs.existsSync(runsDir)) return 0;
  const needle = lowerCompact(name);
  let newest = 0;
  for (const entry of fs.readdirSync(runsDir)) {
    if (!lowerCompact(entry).includes(needle)) continue;
    try {
      newest = Math.max(newest, fs.statSync(path.join(runsDir, entry)).mtimeMs || 0);
    } catch { /* ignore unreadable activity entries */ }
  }
  return newest;
}

function memberLastActivity(name, paths = memberPaths(name), root = process.cwd()) {
  const logsMs = newestMtimeRecursive(path.join(paths.memberDir, 'logs'));
  const runsMs = newestRunActivityMtime(name, root);
  const ms = Math.max(logsMs, runsMs);
  return {
    at_ms: ms,
    age: ageLabelFromMs(ms),
  };
}

function readJsonlRowsIfExists(filePath, maxRows = 80) {
  const tailBytes = 256 * 1024;
  let fd;
  let text = '';
  let truncated = false;
  try {
    fd = fs.openSync(filePath, 'r');
    const stat = fs.fstatSync(fd);
    const bytesToRead = Math.min(stat.size, tailBytes);
    const start = Math.max(0, stat.size - bytesToRead);
    const buffer = Buffer.alloc(bytesToRead);
    let bytesRead = 0;
    while (bytesRead < bytesToRead) {
      const count = fs.readSync(
        fd,
        buffer,
        bytesRead,
        bytesToRead - bytesRead,
        start + bytesRead
      );
      if (count === 0) break;
      bytesRead += count;
    }
    text = buffer.toString('utf8', 0, bytesRead);
    truncated = start > 0;
  } catch {
    return [];
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
  }
  const rows = [];
  const lines = text
    .split(/\r?\n/)
    .slice(truncated ? 1 : 0)
    .filter((line) => line.trim())
    .slice(-Math.max(1, maxRows));
  for (const line of lines) {
    try {
      rows.push(JSON.parse(line));
    } catch {
      // Bad rows should not block discovery from valid rows in the same stream.
    }
  }
  return rows;
}

function writeMemberReceipt(prefix, payload, { root = process.cwd(), receiptPath = null } = {}) {
  const runsDir = path.join(root, 'atris', 'runs');
  fs.mkdirSync(runsDir, { recursive: true });
  const finalReceiptPath = receiptPath || path.join(runsDir, `${prefix}-${fileSafeStamp()}.json`);
  writeJson(finalReceiptPath, payload);
  return finalReceiptPath;
}

function writeAutonomousDiscoveryReceipt(name, candidate, taskResult) {
  const payload = {
    schema: 'atris.signal_scout_autonomous_discovery.v1',
    created_at: stampIso(),
    member: name,
    source: candidate.source,
    action: taskResult.existing ? 'existing_task_found' : 'task_created',
    task_ref: taskResult.task_ref || null,
    task_id: taskResult.task_id || taskResult.task?.id || null,
    task_title: candidate.task_title || candidate.objective_title || candidate.title || null,
    error_pattern: candidate.error_pattern || null,
    error_count: candidate.error_count || null,
    evidence_paths: candidate.evidence_paths || [],
    command: taskResult.command || candidate.next_command || null,
    ok: taskResult.ok === true,
    error: taskResult.error || null,
  };
  const receiptPath = writeMemberReceipt('signal-scout-autonomous-discovery', payload);
  const fields = {
    team: name,
    decision: 'auto-discovery',
    pattern: payload.error_pattern,
    count: payload.error_count,
    task: payload.task_ref,
    receipt: path.relative(process.cwd(), receiptPath),
  };
  const projectLogPath = appendProjectLog('Signal Scout autonomous problem discovery', fields);
  return {
    receipt_path: receiptPath,
    project_log_path: projectLogPath,
    payload,
  };
}

function writeWakeReceipt(name, payload) {
  return writeMemberReceipt(`member-wake-${name}`, payload);
}

function writeMemberLoopReceipt(name, payload) {
  return writeMemberReceipt(`member-loop-${name}`, payload);
}

function writeAutoImproverReceipt(name, payload, receiptPath = null) {
  const finalReceiptPath = writeMemberReceipt('auto-improver-dogfood', payload, { receiptPath });
  const latestPath = path.join(process.cwd(), '.atris', 'state', 'auto-improver-dogfood-latest.json');
  writeJson(latestPath, { ...payload, receipt_path: finalReceiptPath });
  return { receiptPath: finalReceiptPath, latestPath };
}

function isPidAlive(pid) {
  const numeric = Number(pid);
  if (!Number.isFinite(numeric) || numeric <= 0) return false;
  try {
    process.kill(numeric, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function safeReadText(filePath, maxBytes = 250000) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > maxBytes) return '';
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function repoRelative(root, filePath) {
  return path.relative(root, filePath).replace(/\\/g, '/');
}

function dateFromLogPath(relativePath) {
  const match = String(relativePath || '').match(/\b(\d{4}-\d{2}-\d{2})\b/);
  return match ? match[1] : null;
}

// Mission driver logs, goals files, and the wiki log have no date in their
// name; without one they skipped the 7-day window and months-old lines kept
// counting as this week's pain. The last write date stands in for them.
function logDateForScan(relativePath, filePath) {
  const named = dateFromLogPath(relativePath);
  if (named) return named;
  try {
    // Local calendar day, like the dated journal names beside it;
    // toISOString is UTC and calls an evening write tomorrow's.
    const mtime = fs.statSync(filePath).mtime;
    return `${mtime.getFullYear()}-${String(mtime.getMonth() + 1).padStart(2, '0')}-${String(mtime.getDate()).padStart(2, '0')}`;
  } catch {
    return null;
  }
}

function compareLogEvidenceRecentFirst(a, b) {
  const dateA = a?.date || '';
  const dateB = b?.date || '';
  if (dateA !== dateB) return dateB.localeCompare(dateA);
  const pathCompare = String(a?.path || '').localeCompare(String(b?.path || ''));
  if (pathCompare !== 0) return pathCompare;
  return Number(a?.line || 0) - Number(b?.line || 0);
}

function compareRepeatedFailureSignals(a, b) {
  const countCompare = Number(b?.count || 0) - Number(a?.count || 0);
  if (countCompare !== 0) return countCompare;
  const evidenceCompare = compareLogEvidenceRecentFirst(a?.evidence?.[0], b?.evidence?.[0]);
  if (evidenceCompare !== 0) return evidenceCompare;
  return String(a?.pattern || '').localeCompare(String(b?.pattern || ''));
}

function listFilesBounded(rootDir, { maxFiles = 220, extensions = ['.md', '.txt', '.json', '.jsonl'] } = {}) {
  const files = [];
  const stack = [rootDir];
  const skipDirs = new Set(['.git', 'node_modules', '.next', 'dist', 'build', '__pycache__']);
  while (stack.length && files.length < maxFiles) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (files.length >= maxFiles) break;
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!skipDirs.has(entry.name) && !entry.name.startsWith('.')) stack.push(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (extensions.includes(path.extname(entry.name))) files.push(fullPath);
    }
  }
  return files;
}

function appendMemberGoalLog(memberDir, name, title, fields = {}) {
  const logsDir = path.join(memberDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });
  const logPath = path.join(logsDir, todayLogName());
  const stamp = new Date().toTimeString().slice(0, 5);
  const rows = [
    `## ${stamp} · ${title}`,
    `- team: ${name}`,
    ...Object.entries(fields)
      .filter(([, value]) => value !== undefined && value !== null)
      .map(([key, value]) => [key, String(value).replace(/\n/g, ' ').trim()])
      .filter(([, text]) => text !== '')
      .map(([key, text]) => `- ${key}: ${text}`),
    '',
  ];
  fs.appendFileSync(logPath, rows.join('\n'), 'utf8');
  return logPath;
}

function appendProjectLog(title, fields = {}) {
  const today = todayLogName();
  const year = today.slice(0, 4);
  const logsDir = path.join(process.cwd(), 'atris', 'logs', year);
  fs.mkdirSync(logsDir, { recursive: true });
  const logPath = path.join(logsDir, today);
  const stamp = new Date().toTimeString().slice(0, 5);
  const rows = [
    `## ${stamp} · ${title}`,
    ...Object.entries(fields)
      .filter(([, value]) => value !== undefined && value !== null)
      .map(([key, value]) => [key, String(value).replace(/\n/g, ' ').trim()])
      .filter(([, text]) => text !== '')
      .map(([key, text]) => `- ${key}: ${text}`),
    '',
  ];
  fs.appendFileSync(logPath, rows.join('\n'), 'utf8');
  return logPath;
}

// --- YAML Frontmatter Parser (shared with skill.js) ---

function parseFrontmatter(content) {
  // \r?\n so a CRLF-line-ending MEMBER.md (Windows-edited) still parses; otherwise
  // the delimiter never matched (and trailing \r broke the per-line key matchers),
  // silently dropping the member's entire frontmatter: role, skills, permissions, tools.
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;

  const yaml = match[1];
  const result = {};
  let currentKey = null;

  for (const line of yaml.split(/\r?\n/)) {
    const listMatch = line.match(/^\s+-\s+(.+)$/);
    if (listMatch && currentKey) {
      if (!Array.isArray(result[currentKey])) result[currentKey] = [];
      result[currentKey].push(listMatch[1].trim());
      continue;
    }

    const nestedMatch = line.match(/^\s+([a-z_-]+):\s*(.*)$/);
    if (nestedMatch && currentKey && typeof result[currentKey] === 'object' && !Array.isArray(result[currentKey])) {
      const val = nestedMatch[2].trim();
      result[currentKey][nestedMatch[1]] = val === 'true' ? true : val === 'false' ? false : val || true;
      continue;
    }

    const kvMatch = line.match(/^([a-z_-]+):\s*(.*)$/);
    if (kvMatch) {
      currentKey = kvMatch[1];
      const val = kvMatch[2].trim();
      if (val === '') {
        result[currentKey] = {};
      } else if (val.startsWith('[') && val.endsWith(']')) {
        result[currentKey] = val.slice(1, -1).split(',').map(s => s.trim().replace(/^["']|["']$/g, ''));
      } else {
        // Unwrap only a matching outer pair: `verify: node -e "process.exit(0)"`
        // must keep its closing quote or the check is a shell syntax error.
        const quoted = val.match(/^(["'])([\s\S]*)\1$/);
        result[currentKey] = quoted ? quoted[2] : val;
      }
    }
  }

  return result;
}

module.exports = {
  findWorkspaceBusinessId,
  todayLogName,
  ensureMemberLog,
  appendMemberLifecycleLog,
  archiveName,
  uniqueArchiveDir,
  parseDaysFlag,
  parseConfirmFlag,
  readRepeatedFlag,
  stripKnownFlags,
  stampIso,
  fileSafeStamp,
  slugHash,
  makeGoalId,
  uniqueGoalId,
  makeExperimentId,
  taskRef,
  lowerCompact,
  shellQuote,
  MEMBER_RUNTIME_ALIASES,
  memberRuntimeKind,
  resolveMemberRuntime,
  memberPaths,
  missionFileMarkdown,
  ensureMissionFile,
  listExistingMemberSlugs,
  editDistance,
  nearestMemberSlug,
  memberRefusalFor,
  requireRunnableMember,
  requireMemberDir,
  emptyMemberGoals,
  loadMemberGoals,
  activeGoal,
  allExperiments,
  findExperiment,
  latestByTime,
  recentLogLines,
  readOptionalText,
  extractMarkdownSection,
  firstUsefulLine,
  compactSentence,
  activeRuntimeMissionFromNow,
  missionPurpose,
  MEMBER_RUN_RUNNABLE_STATUSES,
  MISSION_TERMINAL_STATUSES,
  memberRunMissionMap,
  memberRunRunnableMissionId,
  memberRunOwnedActiveMissionId,
  MEMBER_LIVE_MISSION_STATUSES,
  MEMBER_ACTIVE_ACTIVITY_MS,
  MEMBER_RECENT_ACTIVITY_MS,
  memberSlugFromRecord,
  isFleetMember,
  missionTimeMs,
  memberOwnedMissions,
  memberLatestMission,
  memberLiveMission,
  missionShortName,
  ageLabelFromMs,
  timestampMs,
  newestMtimeRecursive,
  newestRunActivityMtime,
  memberLastActivity,
  readJsonlRowsIfExists,
  writeMemberReceipt,
  writeAutonomousDiscoveryReceipt,
  writeWakeReceipt,
  writeMemberLoopReceipt,
  writeAutoImproverReceipt,
  isPidAlive,
  safeReadText,
  repoRelative,
  dateFromLogPath,
  logDateForScan,
  compareLogEvidenceRecentFirst,
  compareRepeatedFailureSignals,
  listFilesBounded,
  appendMemberGoalLog,
  appendProjectLog,
  parseFrontmatter,
};
