const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { loadCredentials } = require('../utils/auth');
const { apiRequestJson } = require('../utils/api');

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
    '',
  ].filter(Boolean).join('\n');
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

function hasFlag(args, name) {
  return args.includes(name);
}

function readFlag(args, name, fallback = '') {
  const prefix = `${name}=`;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === name && args[i + 1] && !String(args[i + 1]).startsWith('--')) return args[i + 1];
    if (String(arg).startsWith(prefix)) return String(arg).slice(prefix.length).replace(/^["']|["']$/g, '');
  }
  return fallback;
}

function readNumberFlag(args, name, fallback = null) {
  const raw = readFlag(args, name, '');
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
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
  const booleanSet = new Set(booleanNames);
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

function makeExperimentId(goalId, title) {
  return `exp-${slugHash(`${goalId}:${title}:${Date.now()}`)}`;
}

function memberPaths(name) {
  const teamDir = path.join(process.cwd(), 'atris', 'team');
  const memberDir = path.join(teamDir, name || '');
  return {
    teamDir,
    memberDir,
    memberFile: path.join(memberDir, 'MEMBER.md'),
    missionFile: path.join(memberDir, 'MISSION.md'),
    goalsJson: path.join(memberDir, 'goals.json'),
    goalsMd: path.join(memberDir, 'goals.md'),
    steeringJsonl: path.join(process.cwd(), '.atris', 'state', 'steering.jsonl'),
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

function requireMemberDir(name) {
  if (!name) {
    console.error('Usage: atris member <goal|tick|review> <name> ...');
    process.exit(1);
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(name)) {
    console.error('Member name must be a local slug: letters, numbers, dots, underscores, or dashes.');
    process.exit(1);
  }
  const paths = memberPaths(name);
  if (!fs.existsSync(paths.memberFile)) {
    console.error(`Member "${name}" not found at atris/team/${name}/MEMBER.md`);
    process.exit(1);
  }
  return paths;
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
  if (!fs.existsSync(paths.goalsJson)) return emptyMemberGoals(name);
  try {
    const parsed = JSON.parse(fs.readFileSync(paths.goalsJson, 'utf8'));
    return {
      ...emptyMemberGoals(name),
      ...parsed,
      goals: Array.isArray(parsed.goals) ? parsed.goals : [],
    };
  } catch {
    return emptyMemberGoals(name);
  }
}

function activeGoal(goalsState, goalId = '') {
  if (goalId) return goalsState.goals.find((goal) => goal.id === goalId) || null;
  return goalsState.goals.find((goal) => goal.status === 'active') || goalsState.goals[0] || null;
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
  return clean.length > max ? `${clean.slice(0, Math.max(0, max - 1)).trim()}...` : clean;
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

function readSteeringMemory(paths, name) {
  if (!fs.existsSync(paths.steeringJsonl)) return [];
  const records = [];
  try {
    for (const line of fs.readFileSync(paths.steeringJsonl, 'utf8').split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const record = JSON.parse(trimmed);
      if (!record || record.schema !== 'atris.steering.v1' || (record.status || 'active') !== 'active') continue;
      const member = record.scope?.member;
      if (member && member !== name) continue;
      records.push({
        id: record.id,
        kind: record.kind || 'preference',
        created_at: record.created_at || null,
        memory: Array.isArray(record.memory) ? record.memory.filter(Boolean).slice(0, 8) : [],
        anti_patterns: Array.isArray(record.anti_patterns) ? record.anti_patterns.filter(Boolean).slice(0, 8) : [],
        applies_to: Array.isArray(record.applies_to) ? record.applies_to.filter(Boolean).slice(0, 8) : [],
      });
    }
  } catch {
    return [];
  }
  return records.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || ''))).slice(0, 12);
}

function memberValueSummary(state) {
  const reviewed = allExperiments(state)
    .map(({ experiment }) => experiment)
    .filter((experiment) => experiment.status === 'accepted' || experiment.status === 'discarded');
  const scored = reviewed.filter((experiment) => Number.isFinite(Number(experiment.value)));
  const accepted = reviewed.filter((experiment) => experiment.status === 'accepted').length;
  if (!reviewed.length) return { reviewed: 0, accepted: 0, average: null, line: 'No reviewed experiments yet.' };
  const average = scored.length
    ? Math.round((scored.reduce((sum, experiment) => sum + Number(experiment.value), 0) / scored.length) * 10) / 10
    : null;
  const scoreLine = average == null ? 'value not scored yet' : `avg value ${average}/5`;
  return { reviewed: reviewed.length, accepted, average, line: `${accepted}/${reviewed.length} accepted; ${scoreLine}.` };
}

function memberOpenExperiment(state) {
  return latestByTime(allExperiments(state)
    .map(({ goal, experiment }) => ({ ...experiment, goal_id: goal.id, goal_title: goal.title }))
    .filter((experiment) => ['blocked', 'proposed', 'running'].includes(experiment.status)));
}

function memberLastReviewedExperiment(state) {
  return latestByTime(allExperiments(state)
    .map(({ goal, experiment }) => ({ ...experiment, goal_id: goal.id, goal_title: goal.title }))
    .filter((experiment) => experiment.status === 'accepted' || experiment.status === 'discarded'), 'reviewed_at');
}

function renderMemberGoalsMarkdown(state) {
  const lines = [
    '# Goals',
    '',
    '<!-- Generated from goals.json. Edit with `atris member goal/tick/review` when possible. -->',
    '',
  ];
  for (const goal of state.goals) {
    lines.push(`## ${goal.title}`);
    lines.push('');
    lines.push(`- id: ${goal.id}`);
    lines.push(`- status: ${goal.status}`);
    lines.push(`- cadence: ${goal.cadence || 'manual'}`);
    if (goal.why) lines.push(`- why: ${goal.why}`);
    const criteria = Array.isArray(goal.acceptance) ? goal.acceptance : [];
    if (criteria.length) {
      lines.push('- acceptance:');
      for (const item of criteria) lines.push(`  - ${item}`);
    }
    const experiments = Array.isArray(goal.experiments) ? goal.experiments : [];
    if (experiments.length) {
      lines.push('');
      lines.push('### Experiments');
      for (const experiment of experiments) {
        lines.push(`- ${experiment.id}: ${experiment.status} - ${experiment.title}`);
        if (experiment.proof) lines.push(`  - proof: ${experiment.proof}`);
        if (experiment.lesson) lines.push(`  - lesson: ${experiment.lesson}`);
        if (Number.isFinite(Number(experiment.value))) lines.push(`  - value: ${experiment.value}/5`);
        if (experiment.block?.ask) lines.push(`  - ask: ${experiment.block.ask}`);
      }
    }
    lines.push('');
  }
  if (state.goals.length === 0) lines.push('No goals yet.');
  lines.push('');
  return lines.join('\n');
}

function writeMemberGoals(paths, state) {
  state.updated_at = stampIso();
  fs.writeFileSync(paths.goalsJson, JSON.stringify(state, null, 2) + '\n', 'utf8');
  fs.writeFileSync(paths.goalsMd, renderMemberGoalsMarkdown(state), 'utf8');
}

function writeWakeReceipt(name, payload) {
  const runsDir = path.join(process.cwd(), 'atris', 'runs');
  fs.mkdirSync(runsDir, { recursive: true });
  const receiptPath = path.join(runsDir, `member-wake-${name}-${fileSafeStamp()}.json`);
  fs.writeFileSync(receiptPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  return receiptPath;
}

function memberLoopPaths(name) {
  const stateDir = path.join(process.cwd(), '.atris', 'state', 'member-loops');
  return {
    stateDir,
    lockPath: path.join(stateDir, `${name}.lock.json`),
    stopPath: path.join(stateDir, `${name}.stop.json`),
    latestPath: path.join(stateDir, `${name}.latest.json`),
  };
}

function writeMemberLoopReceipt(name, payload) {
  const runsDir = path.join(process.cwd(), 'atris', 'runs');
  fs.mkdirSync(runsDir, { recursive: true });
  const receiptPath = path.join(runsDir, `member-loop-${name}-${fileSafeStamp()}.json`);
  fs.writeFileSync(receiptPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  return receiptPath;
}

function readJsonIfExists(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function writeJsonFile(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
}

function acquireMemberLoopLease(name, { runId, ttlMs }) {
  const paths = memberLoopPaths(name);
  fs.mkdirSync(paths.stateDir, { recursive: true });
  const nowMs = Date.now();
  const lease = {
    schema: 'atris.member_loop_lease.v1',
    member: name,
    run_id: runId,
    pid: process.pid,
    started_at: stampIso(),
    heartbeat_at: stampIso(),
    expires_at_ms: nowMs + ttlMs,
  };
  const writeLease = () => {
    const fd = fs.openSync(paths.lockPath, 'wx');
    try {
      fs.writeFileSync(fd, JSON.stringify(lease, null, 2) + '\n', 'utf8');
    } finally {
      fs.closeSync(fd);
    }
    return { acquired: true, lease, paths, recovered_stale: false };
  };
  try {
    return writeLease();
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const active = readJsonIfExists(paths.lockPath);
    if (active && Number(active.expires_at_ms || 0) <= nowMs) {
      fs.rmSync(paths.lockPath, { force: true });
      const result = writeLease();
      return { ...result, recovered_stale: true, stale_lease: active };
    }
    return { acquired: false, lease: active, paths, recovered_stale: false };
  }
}

function refreshMemberLoopLease(paths, lease, ttlMs) {
  writeJsonFile(paths.lockPath, {
    ...lease,
    heartbeat_at: stampIso(),
    expires_at_ms: Date.now() + ttlMs,
  });
}

function releaseMemberLoopLease(paths, lease) {
  const active = readJsonIfExists(paths.lockPath);
  if (!active || active.run_id !== lease.run_id || active.pid !== lease.pid) return;
  fs.rmSync(paths.lockPath, { force: true });
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
      .filter(([, value]) => value !== undefined && value !== null && value !== '')
      .map(([key, value]) => `- ${key}: ${String(value).replace(/\n/g, ' ')}`),
    '',
  ];
  fs.appendFileSync(logPath, rows.join('\n'), 'utf8');
  return logPath;
}

// --- YAML Frontmatter Parser (shared with skill.js) ---

function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;

  const yaml = match[1];
  const result = {};
  let currentKey = null;

  for (const line of yaml.split('\n')) {
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
        result[currentKey] = val.replace(/^["']|["']$/g, '');
      }
    }
  }

  return result;
}

// --- Member Discovery ---

function findAllMembers(teamDir) {
  if (!fs.existsSync(teamDir)) return [];

  const members = [];
  const entries = fs.readdirSync(teamDir);

  for (const entry of entries) {
    // Skip template directory and hidden files
    if (entry === '_template' || entry.startsWith('.')) continue;

    const fullPath = path.join(teamDir, entry);
    const stat = fs.statSync(fullPath);

    // Directory format: team/<name>/MEMBER.md
    if (stat.isDirectory()) {
      const memberFile = path.join(fullPath, 'MEMBER.md');
      if (fs.existsSync(memberFile)) {
        const content = fs.readFileSync(memberFile, 'utf8');
        const fm = parseFrontmatter(content) || {};

        // Count local skills
        const skillsDir = path.join(fullPath, 'skills');
        let skillCount = 0;
        if (fs.existsSync(skillsDir)) {
          const skillEntries = fs.readdirSync(skillsDir);
          for (const s of skillEntries) {
            if (fs.existsSync(path.join(skillsDir, s, 'SKILL.md'))) skillCount++;
          }
        }

        // Count context files
        const contextDir = path.join(fullPath, 'context');
        let contextCount = 0;
        if (fs.existsSync(contextDir)) {
          contextCount = fs.readdirSync(contextDir).filter(f => f.endsWith('.md')).length;
        }

        // Check for tools
        const toolsDir = path.join(fullPath, 'tools');
        const hasTools = fs.existsSync(toolsDir);

        members.push({
          name: fm.name || entry,
          role: fm.role || '(no role)',
          description: fm.description || '',
          version: fm.version || '',
          format: 'directory',
          path: memberFile,
          dir: fullPath,
          skillCount,
          contextCount,
          hasTools,
          skills: Array.isArray(fm.skills) ? fm.skills : [],
          permissions: fm.permissions || {},
          frontmatter: fm
        });
      }
      continue;
    }

    // Flat file format: team/<name>.md
    if (entry.endsWith('.md') && stat.isFile()) {
      const content = fs.readFileSync(fullPath, 'utf8');
      const fm = parseFrontmatter(content);
      if (!fm) continue; // No frontmatter = not a member

      const name = entry.replace('.md', '');
      members.push({
        name: fm.name || name,
        role: fm.role || '(no role)',
        description: fm.description || '',
        version: fm.version || '',
        format: 'flat',
        path: fullPath,
        dir: path.dirname(fullPath),
        skillCount: 0,
        contextCount: 0,
        hasTools: false,
        skills: Array.isArray(fm.skills) ? fm.skills : [],
        permissions: fm.permissions || {},
        frontmatter: fm
      });
    }
  }

  return members;
}

// --- LIST subcommand ---

function memberList() {
  const teamDir = path.join(process.cwd(), 'atris', 'team');
  const members = findAllMembers(teamDir);

  if (members.length === 0) {
    console.log('No team members found in atris/team/.');
    console.log('Run "atris member create <name>" to create one.');
    return;
  }

  console.log('');
  console.log('Team Members');
  console.log('─'.repeat(70));

  const nameW = 16;
  const roleW = 16;
  const fmtW = 6;
  const skillW = 8;
  const ctxW = 8;

  console.log(
    '  ' +
    'Name'.padEnd(nameW) +
    'Role'.padEnd(roleW) +
    'Format'.padEnd(fmtW) +
    'Skills'.padEnd(skillW) +
    'Context'.padEnd(ctxW) +
    'Version'
  );
  console.log('  ' + '─'.repeat(66));

  for (const m of members) {
    const skills = m.format === 'directory' ? String(m.skillCount) : '-';
    const context = m.format === 'directory' ? String(m.contextCount) : '-';
    console.log(
      '  ' +
      m.name.padEnd(nameW) +
      m.role.substring(0, roleW - 1).padEnd(roleW) +
      (m.format === 'directory' ? 'dir' : 'flat').padEnd(fmtW) +
      skills.padEnd(skillW) +
      context.padEnd(ctxW) +
      (m.version || '-')
    );
  }

  console.log('');
  console.log(`${members.length} member(s) found.`);
}

// --- CREATE subcommand ---

async function memberCreate(name, ...flags) {
  if (!name) {
    console.error('Usage: atris member create <name> [--role="Title"] [--push]');
    process.exit(1);
  }

  // Parse flags
  let role = name.charAt(0).toUpperCase() + name.slice(1).replace(/-/g, ' ');
  let description = '';
  let shouldPush = false;

  for (const flag of flags) {
    if (flag === '--push') { shouldPush = true; continue; }

    const roleMatch = flag.match(/^--role=["']?(.+?)["']?$/);
    if (roleMatch) role = roleMatch[1];

    const descMatch = flag.match(/^--description=["']?(.+?)["']?$/);
    if (descMatch) description = descMatch[1];
  }

  const teamDir = path.join(process.cwd(), 'atris', 'team');
  const memberDir = path.join(teamDir, name);
  const memberFile = path.join(memberDir, 'MEMBER.md');
  const legacyFile = path.join(teamDir, `${name}.md`);

  // Check for existing
  if (fs.existsSync(memberFile)) {
    console.error(`Member "${name}" already exists at team/${name}/MEMBER.md`);
    process.exit(1);
  }
  if (fs.existsSync(legacyFile)) {
    console.error(`Member "${name}" already exists at team/${name}.md`);
    console.log(`Run "atris member upgrade ${name}" to convert to directory format.`);
    process.exit(1);
  }

  // Scaffold
  fs.mkdirSync(memberDir, { recursive: true });
  fs.mkdirSync(path.join(memberDir, 'skills'), { recursive: true });
  fs.mkdirSync(path.join(memberDir, 'tools'), { recursive: true });
  fs.mkdirSync(path.join(memberDir, 'context'), { recursive: true });
  const logPath = ensureMemberLog(memberDir, { name, role, description: description || `Handles ${role.toLowerCase()} tasks` });
  ensureMissionFile(memberDir, { name, role, description: description || `Handles ${role.toLowerCase()} tasks` });

  const content = `---
name: ${name}
role: ${role}
description: ${description || `Handles ${role.toLowerCase()} tasks`}
version: 1.0.0

skills: []

permissions:
  can-read: true
  approval-required: []

tools: []
---

# ${role}

## Persona

(Define how this member communicates, their tone, and decision-making style)

## Workflow

1. Step one
2. Step two
3. Step three

## Rules

1. Rule one
2. Rule two
`;

  fs.writeFileSync(memberFile, content);

  console.log('');
  console.log(`✓ Created team/${name}/MEMBER.md`);
  console.log(`✓ Created team/${name}/MISSION.md`);
  console.log(`✓ Created team/${name}/skills/`);
  console.log(`✓ Created team/${name}/tools/`);
  console.log(`✓ Created team/${name}/context/`);
  console.log(`✓ Created team/${name}/logs/${path.basename(logPath)}`);

  if (shouldPush) {
    console.log('');
    await memberPush(name);
  } else {
    console.log('');
    console.log(`Next: edit team/${name}/MEMBER.md to define persona, workflow, and permissions.`);
    console.log(`      edit team/${name}/MISSION.md to define why this member exists.`);
    console.log(`      add skills to team/${name}/skills/<skill-name>/SKILL.md`);
    console.log(`      add context docs to team/${name}/context/`);
    console.log(`      run "atris member push ${name}" to create a cloud agent`);
  }
}

// --- ACTIVATE subcommand ---

function memberActivate(name) {
  if (!name) {
    console.error('Usage: atris member activate <name>');
    process.exit(1);
  }

  const teamDir = path.join(process.cwd(), 'atris', 'team');
  const memberDir = path.join(teamDir, name);
  const memberFile = path.join(memberDir, 'MEMBER.md');
  const legacyFile = path.join(teamDir, `${name}.md`);

  // Find the member (directory first, flat fallback)
  let activePath = null;
  let activeDir = null;
  let isLegacy = false;

  if (fs.existsSync(memberFile)) {
    activePath = memberFile;
    activeDir = memberDir;
  } else if (fs.existsSync(legacyFile)) {
    activePath = legacyFile;
    activeDir = teamDir;
    isLegacy = true;
  } else {
    console.error(`Member "${name}" not found. Run "atris member list".`);
    process.exit(1);
  }

  const content = fs.readFileSync(activePath, 'utf8');
  const fm = parseFrontmatter(content) || {};

  console.log('');
  console.log(`Activating: ${fm.name || name} (${fm.role || 'no role'})`);

  // If legacy format, offer upgrade
  if (isLegacy) {
    console.log(`  Format: flat file (team/${name}.md)`);
    console.log(`  Tip: run "atris member upgrade ${name}" to convert to directory format.`);
  }

  // Symlink member's local skills to system-level
  if (!isLegacy) {
    const skillsDir = path.join(activeDir, 'skills');
    if (fs.existsSync(skillsDir)) {
      const home = require('os').homedir();
      const toolDirs = [
        { dir: path.join(home, '.claude', 'skills'), label: 'Claude' },
        { dir: path.join(home, '.codex', 'skills'), label: 'Codex' },
        { dir: path.join(home, '.cursor', 'skills'), label: 'Cursor' },
      ];

      for (const { dir } of toolDirs) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const skillEntries = fs.readdirSync(skillsDir);
      let linked = 0;

      for (const entry of skillEntries) {
        const skillDir = path.join(skillsDir, entry);
        if (!fs.statSync(skillDir).isDirectory()) continue;
        if (!fs.existsSync(path.join(skillDir, 'SKILL.md'))) continue;

        for (const { dir, label } of toolDirs) {
          const linkPath = path.join(dir, entry);
          if (fs.existsSync(linkPath)) continue;

          try {
            fs.symlinkSync(skillDir, linkPath);
          } catch (e) { /* silent */ }
        }
        linked++;
        console.log(`  ✓ Linked skill: ${entry}`);
      }

      if (linked === 0) {
        console.log('  No local skills to link.');
      }
    }

    // Show context files
    const contextDir = path.join(activeDir, 'context');
    if (fs.existsSync(contextDir)) {
      const ctxFiles = fs.readdirSync(contextDir).filter(f => f.endsWith('.md'));
      if (ctxFiles.length > 0) {
        console.log(`  Context: ${ctxFiles.join(', ')}`);
      }
    }

    // Show tools
    const toolsDir = path.join(activeDir, 'tools');
    if (fs.existsSync(toolsDir)) {
      const toolFiles = fs.readdirSync(toolsDir);
      if (toolFiles.length > 0) {
        console.log(`  Tools: ${toolFiles.join(', ')}`);
      }
    }
  }

  // Show permissions
  if (fm.permissions && typeof fm.permissions === 'object') {
    const perms = Object.entries(fm.permissions);
    if (perms.length > 0) {
      const allowed = perms.filter(([, v]) => v === true || v === 'true').map(([k]) => k);
      const denied = perms.filter(([, v]) => v === false || v === 'false').map(([k]) => k);
      if (allowed.length) console.log(`  Allowed: ${allowed.join(', ')}`);
      if (denied.length) console.log(`  Denied: ${denied.join(', ')}`);
    }
  }

  console.log('');
  console.log(`Member "${fm.name || name}" activated.`);
  console.log(`Tell your agent: "You are the ${fm.role || name}. Read team/${name}/MEMBER.md."`);
}

// --- UPGRADE subcommand ---

function memberUpgrade(name) {
  if (!name) {
    console.error('Usage: atris member upgrade <name>');
    process.exit(1);
  }

  const teamDir = path.join(process.cwd(), 'atris', 'team');
  const legacyFile = path.join(teamDir, `${name}.md`);
  const memberDir = path.join(teamDir, name);
  const memberFile = path.join(memberDir, 'MEMBER.md');

  if (!fs.existsSync(legacyFile)) {
    if (fs.existsSync(memberFile)) {
      console.log(`"${name}" is already in directory format.`);
    } else {
      console.error(`Member "${name}" not found at team/${name}.md`);
    }
    return;
  }

  if (fs.existsSync(memberDir)) {
    console.error(`Directory team/${name}/ already exists. Resolve manually.`);
    process.exit(1);
  }

  // Move flat file to directory format
  fs.mkdirSync(memberDir, { recursive: true });
  fs.mkdirSync(path.join(memberDir, 'skills'), { recursive: true });
  fs.mkdirSync(path.join(memberDir, 'tools'), { recursive: true });
  fs.mkdirSync(path.join(memberDir, 'context'), { recursive: true });
  const logPath = ensureMemberLog(memberDir, { name, source: 'upgrade' });
  fs.renameSync(legacyFile, memberFile);
  ensureMissionFile(memberDir, { name, description: 'Define why this member exists and how it chooses goals.' });

  console.log(`✓ Upgraded team/${name}.md → team/${name}/MEMBER.md`);
  console.log(`✓ Created MISSION.md, skills/, tools/, context/, logs/${path.basename(logPath)}`);
}

// --- PUSH subcommand ---

async function memberPush(name) {
  if (!name) {
    console.error('Usage: atris member push <name>');
    process.exit(1);
  }

  const creds = loadCredentials();
  if (!creds || !creds.token) {
    console.error('Not logged in. Run: atris login');
    process.exit(1);
  }

  const teamDir = path.join(process.cwd(), 'atris', 'team');
  const memberFile = path.join(teamDir, name, 'MEMBER.md');

  if (!fs.existsSync(memberFile)) {
    console.error(`Member "${name}" not found at atris/team/${name}/MEMBER.md`);
    process.exit(1);
  }

  const content = fs.readFileSync(memberFile, 'utf8');
  const fm = parseFrontmatter(content);
  const existingAgentId = fm && fm['agent-id'];

  if (existingAgentId) {
    console.log(`Pushing member "${name}" to cloud (updating agent ${existingAgentId})...`);
  } else {
    console.log(`Pushing member "${name}" to cloud (creating new agent)...`);
  }

  const result = await apiRequestJson('/agent/import-member', {
    method: 'POST',
    headers: { 'Content-Type': 'text/markdown' },
    body: content,
    token: creds.token,
  });

  if (!result.ok) {
    console.error(`Push failed: ${result.error || 'Unknown error'}`);
    process.exit(1);
  }

  const agentId = result.data?.agent_id || result.data?.id || '(unknown)';

  // Write agent-id back into frontmatter if this was a new agent
  if (!existingAgentId && agentId && agentId !== '(unknown)') {
    const fmMatch = content.match(/^(---\n)([\s\S]*?)(\n---)/);
    if (fmMatch) {
      const updatedContent = fmMatch[1] + fmMatch[2] + `\nagent-id: ${agentId}` + fmMatch[3] + content.slice(fmMatch[0].length);
      fs.writeFileSync(memberFile, updatedContent);
      console.log(`Linked: agent-id ${agentId} written to MEMBER.md`);
    }
  }

  const action = existingAgentId ? 'Updated' : 'Created';
  console.log(`${action} successfully. Agent ID: ${agentId}`);
}

// --- PULL subcommand ---

async function memberPull(nameOrAgentId) {
  const creds = loadCredentials();
  if (!creds || !creds.token) {
    console.error('Not logged in. Run: atris login');
    process.exit(1);
  }

  let agentId = nameOrAgentId;

  // If arg looks like a member name (not a UUID), check local MEMBER.md for agent-id
  if (nameOrAgentId && !nameOrAgentId.includes('-')) {
    const teamDir = path.join(process.cwd(), 'atris', 'team');
    const localFile = path.join(teamDir, nameOrAgentId, 'MEMBER.md');
    if (fs.existsSync(localFile)) {
      const localContent = fs.readFileSync(localFile, 'utf8');
      const fm = parseFrontmatter(localContent);
      if (fm && fm['agent-id']) {
        agentId = fm['agent-id'];
        console.log(`Found agent-id ${agentId} in local MEMBER.md`);
      } else {
        console.error(`Member "${nameOrAgentId}" has no agent-id. Push it first: atris member push ${nameOrAgentId}`);
        process.exit(1);
      }
    }
  }

  if (!agentId) {
    console.error('Usage: atris member pull <name|agent_id>');
    process.exit(1);
  }

  console.log(`Pulling agent "${agentId}" from cloud...`);

  const result = await apiRequestJson(`/agent/${agentId}/export-member`, {
    method: 'GET',
    token: creds.token,
  });

  if (!result.ok) {
    console.error(`Pull failed: ${result.error || 'Unknown error'}`);
    process.exit(1);
  }

  // The response body is the MEMBER.md content (may be returned as text or in data)
  const content = result.text || (result.data && typeof result.data === 'string' ? result.data : null);

  if (!content) {
    console.error('Pull failed: empty response from server');
    process.exit(1);
  }

  // Parse the name from frontmatter
  const fm = parseFrontmatter(content);
  const memberName = (fm && fm.name) || nameOrAgentId;

  const teamDir = path.join(process.cwd(), 'atris', 'team');
  const memberDir = path.join(teamDir, memberName);
  const memberFile = path.join(memberDir, 'MEMBER.md');

  // Create directory structure
  fs.mkdirSync(memberDir, { recursive: true });
  fs.mkdirSync(path.join(memberDir, 'skills'), { recursive: true });
  fs.mkdirSync(path.join(memberDir, 'tools'), { recursive: true });
  fs.mkdirSync(path.join(memberDir, 'context'), { recursive: true });
  const logPath = ensureMemberLog(memberDir, {
    name: memberName,
    role: fm && fm.role,
    description: fm && fm.description,
    source: 'pull',
  });
  const missionPath = ensureMissionFile(memberDir, {
    name: memberName,
    role: fm && fm.role,
    description: fm && fm.description,
  });

  fs.writeFileSync(memberFile, content);
  console.log(`Saved to atris/team/${memberName}/MEMBER.md`);
  console.log(`Mission ready at atris/team/${memberName}/${path.basename(missionPath)}`);
  console.log(`Log ready at atris/team/${memberName}/logs/${path.basename(logPath)}`);

  // Sync journal entries
  const journalResult = await apiRequestJson(`/agent/${agentId}/export-journal`, {
    method: 'GET',
    token: creds.token,
  });

  if (journalResult.ok && journalResult.data && journalResult.data.files) {
    const journalFiles = journalResult.data.files;
    let synced = 0;

    for (const file of journalFiles) {
      if (!file.path || !file.content) continue;
      const localJournalPath = String(file.path).replace(/^journal\//, 'logs/');
      const localPath = path.join(memberDir, localJournalPath);
      fs.mkdirSync(path.dirname(localPath), { recursive: true });
      fs.writeFileSync(localPath, file.content);
      synced++;
    }

    if (synced > 0) {
      console.log(`Synced ${synced} journal ${synced === 1 ? 'entry' : 'entries'}`);
    } else {
      console.log('No journal entries yet');
    }
  } else {
    console.log('No journal entries yet');
  }
}

function memberArchive(name) {
  if (!name) {
    console.error('Usage: atris member archive <name>');
    process.exit(1);
  }
  const teamDir = path.join(process.cwd(), 'atris', 'team');
  const memberDir = path.join(teamDir, name);
  const memberFile = path.join(memberDir, 'MEMBER.md');
  if (!fs.existsSync(memberFile)) {
    console.error(`Member "${name}" not found at atris/team/${name}/MEMBER.md`);
    process.exit(1);
  }
  const archiveRoot = path.join(teamDir, '_archived');
  const archiveDir = uniqueArchiveDir(archiveRoot, name);
  appendMemberLifecycleLog(memberDir, name, 'archived', 'Archived by atris member archive');
  fs.mkdirSync(archiveRoot, { recursive: true });
  fs.renameSync(memberDir, archiveDir);
  console.log(`Archived atris/team/${name} -> ${path.relative(process.cwd(), archiveDir)}`);
}

function memberPurgeArchived(...flags) {
  const days = parseDaysFlag(flags, 60);
  const confirm = parseConfirmFlag(flags);
  if (confirm !== 'delete archived members') {
    console.error('Refusing purge. Pass --confirm "delete archived members".');
    process.exit(1);
  }
  const archiveRoot = path.join(process.cwd(), 'atris', 'team', '_archived');
  if (!fs.existsSync(archiveRoot)) {
    console.log('No archived members found.');
    return;
  }
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const entries = fs.readdirSync(archiveRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const fullPath = path.join(archiveRoot, entry.name);
      return { name: entry.name, path: fullPath, mtimeMs: fs.statSync(fullPath).mtimeMs };
    })
    .filter((entry) => entry.mtimeMs <= cutoff);
  for (const entry of entries) {
    fs.rmSync(entry.path, { recursive: true, force: true });
    console.log(`Purged archived member: ${entry.name}`);
  }
  console.log(`Purged ${entries.length} archived member${entries.length === 1 ? '' : 's'} older than ${days} days.`);
}

function printJsonOrText(payload, lines, asJson) {
  if (asJson) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  for (const line of lines) console.log(line);
}

function sleepSync(ms) {
  const duration = Math.max(0, Number(ms) || 0);
  if (duration <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, duration);
}

function memberGoal(name, ...args) {
  const paths = requireMemberDir(name);
  const asJson = hasFlag(args, '--json');
  const acceptance = readRepeatedFlag(args, '--acceptance');
  const cadence = readFlag(args, '--cadence', 'manual') || 'manual';
  const why = readFlag(args, '--why', '');
  const title = stripKnownFlags(args, ['--acceptance', '--cadence', '--why'], ['--json']).join(' ').trim();
  if (!title) {
    console.error('Usage: atris member goal <name> "Long-term goal" [--acceptance "..."] [--cadence daily] [--why "..."]');
    process.exit(1);
  }

  const state = loadMemberGoals(name, paths);
  const id = makeGoalId(title);
  const existing = state.goals.find((goal) => goal.id === id || goal.title.toLowerCase() === title.toLowerCase());
  const goal = existing || {
    id,
    title,
    status: 'active',
    cadence,
    why,
    acceptance: acceptance.length ? acceptance : ['Return proof, risk, and next move.'],
    created_at: stampIso(),
    experiments: [],
    history: [],
  };
  goal.status = 'active';
  goal.cadence = cadence || goal.cadence || 'manual';
  if (why) goal.why = why;
  if (acceptance.length) goal.acceptance = acceptance;
  goal.history = Array.isArray(goal.history) ? goal.history : [];
  goal.history.push({ at: stampIso(), event: existing ? 'goal_updated' : 'goal_created' });
  if (!existing) state.goals.push(goal);
  writeMemberGoals(paths, state);
  const logPath = appendMemberGoalLog(paths.memberDir, name, existing ? 'Member goal updated' : 'Member goal created', {
    goal: goal.title,
    cadence: goal.cadence,
    acceptance: (goal.acceptance || []).join(' | '),
  });
  printJsonOrText(
    { ok: true, action: existing ? 'goal_updated' : 'goal_created', member: name, goal, goals_path: paths.goalsJson, goals_md_path: paths.goalsMd, log_path: logPath },
    [
      `${existing ? 'Updated' : 'Created'} goal for ${name}: ${goal.title}`,
      `Goals: ${path.relative(process.cwd(), paths.goalsJson)}`,
      `Readout: ${path.relative(process.cwd(), paths.goalsMd)}`,
    ],
    asJson,
  );
}

function memberGoalFromMission(name, ...args) {
  const paths = requireMemberDir(name);
  const asJson = hasFlag(args, '--json');
  const force = hasFlag(args, '--force');
  const cadence = readFlag(args, '--cadence', 'manual') || 'manual';
  const purpose = missionPurpose(paths);
  if (!purpose.meaningful) {
    const ask = `Define atris/team/${name}/MISSION.md with a concrete North Star before this member creates its own goal.`;
    const logPath = appendMemberGoalLog(paths.memberDir, name, 'Member goal-from-mission blocked', {
      ask,
      mission_file: path.relative(process.cwd(), paths.missionFile),
    });
    printJsonOrText(
      { ok: true, action: 'needs_user', member: name, needs_user: true, ask, mission_file: paths.missionFile, log_path: logPath },
      [
        `Blocked for ${name}: MISSION.md needs a concrete North Star.`,
        `Ask: ${ask}`,
      ],
      asJson,
    );
    return;
  }

  const state = loadMemberGoals(name, paths);
  const runtime = purpose.runtimeMission;
  const runtimeFocus = runtime.heading || purpose.northStar;
  const title = `Prove one bounded step toward: ${compactSentence(runtimeFocus, 88)}`;
  const existing = state.goals.find((goal) => (
    goal.source === 'mission'
    && goal.status === 'active'
    && !force
    && (
      goal.mission_id === runtime.id
      || String(goal.mission_north_star || '') === purpose.northStar
      || goal.title.toLowerCase() === title.toLowerCase()
    )
  ));
  const acceptance = [
    'One bounded next move is proposed from MISSION.md, not hand-fed by the human.',
    'The move has verifier/proof target, stop rule, and human-ask condition.',
    'A receipt or log entry records what changed and what remains uncertain.',
  ];
  const goal = existing || {
    id: makeGoalId(title),
    title,
    status: 'active',
    cadence,
    why: compactSentence(purpose.northStar, 240),
    acceptance,
    source: 'mission',
    mission_file: path.relative(process.cwd(), paths.missionFile),
    now_file: fs.existsSync(path.join(paths.memberDir, 'now.md')) ? path.relative(process.cwd(), path.join(paths.memberDir, 'now.md')) : null,
    mission_id: runtime.id || null,
    mission_north_star: purpose.northStar,
    created_at: stampIso(),
    experiments: [],
    history: [],
  };
  goal.status = 'active';
  goal.cadence = cadence || goal.cadence || 'manual';
  goal.source = 'mission';
  goal.why = goal.why || compactSentence(purpose.northStar, 240);
  goal.acceptance = Array.isArray(goal.acceptance) && goal.acceptance.length ? goal.acceptance : acceptance;
  goal.mission_file = path.relative(process.cwd(), paths.missionFile);
  goal.now_file = fs.existsSync(path.join(paths.memberDir, 'now.md')) ? path.relative(process.cwd(), path.join(paths.memberDir, 'now.md')) : null;
  goal.mission_id = runtime.id || goal.mission_id || null;
  goal.mission_north_star = purpose.northStar;
  goal.history = Array.isArray(goal.history) ? goal.history : [];
  goal.history.push({
    at: stampIso(),
    event: existing ? 'goal_from_mission_reused' : 'goal_from_mission_created',
    mission_id: runtime.id || null,
    mission_status: runtime.status || null,
  });
  if (!existing) state.goals.push(goal);
  writeMemberGoals(paths, state);
  const logPath = appendMemberGoalLog(paths.memberDir, name, existing ? 'Member goal reused from Mission' : 'Member goal created from Mission', {
    goal: goal.title,
    north_star: purpose.northStar,
    runtime_mission: runtime.id || '',
    next: `atris member tick ${name} --goal ${goal.id}`,
  });
  printJsonOrText(
    {
      ok: true,
      action: existing ? 'goal_from_mission_reused' : 'goal_from_mission_created',
      member: name,
      goal,
      mission: {
        north_star: purpose.northStar,
        runtime_id: runtime.id || null,
        runtime_status: runtime.status || null,
        runtime_next: runtime.next || null,
      },
      goals_path: paths.goalsJson,
      goals_md_path: paths.goalsMd,
      log_path: logPath,
      next_command: `atris member tick ${name} --goal ${goal.id}`,
    },
    [
      `${existing ? 'Reused' : 'Created'} mission-derived goal for ${name}: ${goal.title}`,
      `Mission: ${purpose.northStar}`,
      `Next: atris member tick ${name} --goal ${goal.id}`,
    ],
    asJson,
  );
}

function proposalForGoal(goal) {
  const criteria = Array.isArray(goal.acceptance) && goal.acceptance.length
    ? goal.acceptance[0]
    : 'Return proof, risk, and next move.';
  const title = `Run next proof step for ${goal.title}`;
  return {
    id: makeExperimentId(goal.id, title),
    title,
    status: 'proposed',
    proof_target: criteria,
    stop_rule: 'Stop if proof is missing, risk is unclear, or the next move would require new authority.',
    created_at: stampIso(),
  };
}

function workspaceSnapshot() {
  try {
    const root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const porcelain = execFileSync('git', ['status', '--porcelain'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).split(/\r?\n/).filter(Boolean);
    return {
      kind: 'git',
      root,
      clean: porcelain.length === 0,
      dirty_count: porcelain.length,
      dirty_sample: porcelain.slice(0, 8),
    };
  } catch {
    return {
      kind: 'none',
      clean: true,
      dirty_count: 0,
      dirty_sample: [],
    };
  }
}

function wakeDecision(name, paths, { force = false } = {}) {
  const purpose = missionPurpose(paths);
  const steering = readSteeringMemory(paths, name);
  const state = loadMemberGoals(name, paths);
  const goal = activeGoal(state);
  const current = memberOpenExperiment(state);
  const blocked = allExperiments(state)
    .map(({ goal: experimentGoal, experiment }) => ({ ...experiment, goal_id: experimentGoal.id, goal_title: experimentGoal.title }))
    .filter((experiment) => experiment.status === 'blocked')
    .sort((a, b) => String(b.blocked_at || b.created_at || '').localeCompare(String(a.blocked_at || a.created_at || '')))[0] || null;
  const workspace = workspaceSnapshot();
  const checks = {
    has_member: true,
    has_mission: Boolean(purpose.missionText),
    mission_meaningful: purpose.meaningful,
    has_goal: Boolean(goal),
    has_open_experiment: Boolean(current),
    has_blocked_experiment: Boolean(blocked),
    has_steering: steering.length > 0,
    workspace_clean: workspace.clean,
  };

  if (!purpose.meaningful) {
    const ask = `Define atris/team/${name}/MISSION.md with a concrete North Star before this member wakes itself.`;
    return {
      decision: 'ask',
      reason: 'mission_missing_or_placeholder',
      needs_user: true,
      ask,
      next_command: `edit atris/team/${name}/MISSION.md`,
      state,
      goal: goal || null,
      current_experiment: current || null,
      checks,
      mission: {
        north_star: purpose.northStar || null,
        runtime_id: purpose.runtimeMission.id || null,
        runtime_status: purpose.runtimeMission.status || null,
        runtime_next: purpose.runtimeMission.next || null,
      },
      steering,
      workspace,
    };
  }

  if (!goal) {
    return {
      decision: 'stop',
      reason: 'no_active_goal',
      needs_user: false,
      ask: null,
      next_command: `atris member goal-from-mission ${name}`,
      state,
      goal: null,
      current_experiment: null,
      checks,
      mission: {
        north_star: purpose.northStar,
        runtime_id: purpose.runtimeMission.id || null,
        runtime_status: purpose.runtimeMission.status || null,
        runtime_next: purpose.runtimeMission.next || null,
      },
      steering,
      workspace,
    };
  }

  if (blocked) {
    return {
      decision: 'ask',
      reason: 'blocked_experiment',
      needs_user: true,
      ask: blocked.block?.ask || 'Needs operator input before another wake.',
      next_command: `atris member review ${name} ${blocked.id} --discard --proof "..."`,
      state,
      goal,
      current_experiment: blocked,
      checks,
      mission: {
        north_star: purpose.northStar,
        runtime_id: purpose.runtimeMission.id || null,
        runtime_status: purpose.runtimeMission.status || null,
        runtime_next: purpose.runtimeMission.next || null,
      },
      steering,
      workspace,
    };
  }

  if (current) {
    return {
      decision: 'wait',
      reason: `open_experiment_${current.status}`,
      needs_user: false,
      ask: null,
      next_command: `atris member review ${name} ${current.id} --accept --proof "..." --value 4`,
      state,
      goal,
      current_experiment: current,
      checks,
      mission: {
        north_star: purpose.northStar,
        runtime_id: purpose.runtimeMission.id || null,
        runtime_status: purpose.runtimeMission.status || null,
        runtime_next: purpose.runtimeMission.next || null,
      },
      steering,
      workspace,
    };
  }

  if (!workspace.clean && !force) {
    return {
      decision: 'wait',
      reason: 'workspace_dirty',
      needs_user: false,
      ask: null,
      next_command: `review git status or rerun: atris member wake ${name} --force`,
      state,
      goal,
      current_experiment: null,
      checks,
      mission: {
        north_star: purpose.northStar,
        runtime_id: purpose.runtimeMission.id || null,
        runtime_status: purpose.runtimeMission.status || null,
        runtime_next: purpose.runtimeMission.next || null,
      },
      steering,
      workspace,
    };
  }

  return {
    decision: 'tick',
    reason: 'safe_next_bounded_step',
    needs_user: false,
    ask: null,
    next_command: `atris member tick ${name} --goal ${goal.id}`,
    state,
    goal,
    current_experiment: null,
    checks,
    mission: {
      north_star: purpose.northStar,
      runtime_id: purpose.runtimeMission.id || null,
      runtime_status: purpose.runtimeMission.status || null,
      runtime_next: purpose.runtimeMission.next || null,
    },
    steering,
    workspace,
  };
}

function runMemberWake(name, { execute = false, confirmed = false, force = false } = {}) {
  const paths = requireMemberDir(name);
  const planned = wakeDecision(name, paths, { force });
  const mode = execute ? 'execute' : 'dry_run';
  let decision = planned.decision;
  let reason = planned.reason;
  let executed = false;
  let experiment = null;
  let state = planned.state;
  let goal = planned.goal;
  let nextCommand = planned.next_command;
  const now = stampIso();

  if (execute && !confirmed) {
    decision = 'stop';
    reason = 'execute_requires_confirm_autonomy_policy';
    nextCommand = `atris member wake ${name} --execute --confirm-autonomy-policy`;
  } else if (execute && planned.decision === 'tick' && goal) {
    goal.experiments = Array.isArray(goal.experiments) ? goal.experiments : [];
    experiment = proposalForGoal(goal);
    goal.experiments.push(experiment);
    goal.history = Array.isArray(goal.history) ? goal.history : [];
    goal.history.push({ at: now, event: 'wake_tick_proposed_experiment', experiment_id: experiment.id });
    writeMemberGoals(paths, state);
    executed = true;
    decision = 'wait';
    reason = 'tick_executed_experiment_proposed';
    nextCommand = `atris member review ${name} ${experiment.id} --accept --proof "..." --value 4`;
  }

  const receiptPayload = {
    schema: 'atris.member_wake.v1',
    created_at: now,
    member: name,
    mode,
    decision,
    reason,
    executed,
    needs_user: planned.needs_user || false,
    ask: planned.ask || null,
    next_command: nextCommand,
    mission: planned.mission,
    steering: planned.steering,
    checks: planned.checks,
    workspace: planned.workspace,
    active_goal: goal ? {
      id: goal.id,
      title: goal.title,
      source: goal.source || null,
      mission_id: goal.mission_id || null,
    } : null,
    current_experiment: experiment || planned.current_experiment || null,
  };
  const receiptPath = writeWakeReceipt(name, receiptPayload);
  const logPath = appendMemberGoalLog(paths.memberDir, name, executed ? 'Member wake executed tick' : 'Member wake decision', {
    decision,
    reason,
    mode,
    goal: goal?.title || '',
    experiment: (experiment || planned.current_experiment)?.title || '',
    ask: planned.ask || '',
    receipt: path.relative(process.cwd(), receiptPath),
    next: nextCommand,
  });

  return {
    ok: true,
    action: 'wake',
    member: name,
    mode,
    decision,
    reason,
    executed,
    needs_user: planned.needs_user || false,
    ask: planned.ask || null,
    next_command: nextCommand,
    mission: planned.mission,
    steering: planned.steering,
    checks: planned.checks,
    workspace: planned.workspace,
    active_goal: receiptPayload.active_goal,
    current_experiment: receiptPayload.current_experiment,
    receipt_path: receiptPath,
    log_path: logPath,
  };
}

function memberWake(name, ...args) {
  const asJson = hasFlag(args, '--json');
  const execute = hasFlag(args, '--execute');
  const confirmed = hasFlag(args, '--confirm-autonomy-policy');
  const force = hasFlag(args, '--force');
  const result = runMemberWake(name, { execute, confirmed, force });
  printJsonOrText(
    result,
    [
      `Wake: ${name}`,
      `Decision: ${result.decision}`,
      `Reason: ${result.reason}`,
      `Mode: ${result.mode}${result.executed ? ' executed' : ''}`,
      ...(result.ask ? [`Ask: ${result.ask}`] : []),
      `Next: ${result.next_command}`,
      `Receipt: ${path.relative(process.cwd(), result.receipt_path)}`,
    ],
    asJson,
  );
}

function memberLoop(name, ...args) {
  requireMemberDir(name);
  const asJson = hasFlag(args, '--json');
  const execute = hasFlag(args, '--execute');
  const confirmed = hasFlag(args, '--confirm-autonomy-policy');
  const force = hasFlag(args, '--force');
  const stop = hasFlag(args, '--stop');
  const status = hasFlag(args, '--status');
  const paths = memberLoopPaths(name);
  fs.mkdirSync(paths.stateDir, { recursive: true });

  if (status) {
    const active = readJsonIfExists(paths.lockPath);
    const latest = readJsonIfExists(paths.latestPath);
    const payload = {
      ok: true,
      action: 'loop_status',
      member: name,
      active: Boolean(active && Number(active.expires_at_ms || 0) > Date.now()),
      lease: active || null,
      latest: latest || null,
      lock_path: paths.lockPath,
      latest_path: paths.latestPath,
    };
    printJsonOrText(payload, [
      `Loop status: ${name}`,
      `Active: ${payload.active ? 'yes' : 'no'}`,
      `Latest: ${latest?.receipt_path ? path.relative(process.cwd(), latest.receipt_path) : 'none'}`,
    ], asJson);
    return;
  }

  if (stop) {
    const requestedAt = stampIso();
    const stopPayload = {
      schema: 'atris.member_loop_stop.v1',
      member: name,
      requested_at: requestedAt,
      pid: process.pid,
    };
    writeJsonFile(paths.stopPath, stopPayload);
    const receiptPath = writeMemberLoopReceipt(name, {
      ok: true,
      action: 'loop_stop',
      member: name,
      requested_at: requestedAt,
      stop_path: paths.stopPath,
    });
    printJsonOrText({
      ok: true,
      action: 'loop_stop',
      member: name,
      stop_path: paths.stopPath,
      receipt_path: receiptPath,
    }, [
      `Stop requested for ${name}.`,
      `Receipt: ${path.relative(process.cwd(), receiptPath)}`,
    ], asJson);
    return;
  }

  const ticksFlag = readNumberFlag(args, '--ticks', null);
  const minutes = readNumberFlag(args, '--minutes', null);
  const durationSeconds = readNumberFlag(args, '--duration-seconds', readNumberFlag(args, '--seconds', null));
  const intervalSeconds = readNumberFlag(args, '--interval', readNumberFlag(args, '--interval-seconds', 60));
  const intervalMs = Math.max(0, Math.floor(Number(intervalSeconds == null ? 60 : intervalSeconds) * 1000));
  const durationMs = Math.max(0, Math.floor(durationSeconds != null ? Number(durationSeconds) * 1000 : Number(minutes == null ? 10 : minutes) * 60 * 1000));
  const ticks = ticksFlag != null
    ? Math.max(1, Math.floor(Number(ticksFlag)))
    : intervalMs > 0
      ? Math.max(1, Math.floor(durationMs / intervalMs))
      : 1;
  const runId = `member-loop-${name}-${fileSafeStamp()}`;
  const startedAt = stampIso();
  const ttlSeconds = readNumberFlag(args, '--lease-ttl-seconds', null);
  const ttlMs = Math.max(
    30000,
    Math.floor(Number(ttlSeconds == null ? 0 : ttlSeconds) * 1000),
    durationMs + 60000,
    intervalMs + 60000,
  );

  if (execute && !confirmed) {
    const receiptPath = writeMemberLoopReceipt(name, {
      ok: false,
      action: 'loop',
      member: name,
      status: 'blocked',
      reason: 'execute_requires_confirm_autonomy_policy',
      mode: 'execute',
      started_at: startedAt,
      finished_at: stampIso(),
    });
    const payload = {
      ok: false,
      action: 'loop',
      member: name,
      status: 'blocked',
      reason: 'execute_requires_confirm_autonomy_policy',
      receipt_path: receiptPath,
    };
    writeJsonFile(paths.latestPath, payload);
    printJsonOrText(payload, [
      `Loop blocked for ${name}: execute requires --confirm-autonomy-policy.`,
      `Receipt: ${path.relative(process.cwd(), receiptPath)}`,
    ], asJson);
    process.exitCode = 1;
    return;
  }

  const lease = acquireMemberLoopLease(name, { runId, ttlMs });
  if (!lease.acquired) {
    const receiptPath = writeMemberLoopReceipt(name, {
      ok: true,
      action: 'loop',
      member: name,
      status: 'skipped',
      reason: 'loop_already_active',
      mode: execute ? 'execute' : 'dry_run',
      active_lease: lease.lease || null,
      started_at: startedAt,
      finished_at: stampIso(),
    });
    const payload = {
      ok: true,
      action: 'loop',
      member: name,
      status: 'skipped',
      reason: 'loop_already_active',
      ticks: 0,
      receipt_path: receiptPath,
      active_lease: lease.lease || null,
    };
    writeJsonFile(paths.latestPath, payload);
    printJsonOrText(payload, [
      `Loop skipped for ${name}: another loop is active.`,
      `Receipt: ${path.relative(process.cwd(), receiptPath)}`,
    ], asJson);
    return;
  }

  fs.rmSync(paths.stopPath, { force: true });
  const tickLogPath = path.join(process.cwd(), 'atris', 'runs', `${runId}.jsonl`);
  fs.mkdirSync(path.dirname(tickLogPath), { recursive: true });
  const tickResults = [];
  const decisions = {};
  let stopped = false;
  let failed = false;

  try {
    for (let index = 0; index < ticks; index += 1) {
      if (fs.existsSync(paths.stopPath)) {
        stopped = true;
        break;
      }
      refreshMemberLoopLease(paths, lease.lease, ttlMs);
      const tickStartedAt = stampIso();
      try {
        const wake = runMemberWake(name, { execute, confirmed, force });
        const key = `${wake.decision}:${wake.reason}`;
        decisions[key] = (decisions[key] || 0) + 1;
        const tick = {
          tick: index + 1,
          started_at: tickStartedAt,
          finished_at: stampIso(),
          ok: true,
          decision: wake.decision,
          reason: wake.reason,
          executed: wake.executed,
          needs_user: wake.needs_user,
          next_command: wake.next_command,
          has_mission: wake.checks?.has_mission === true,
          has_goal: wake.checks?.has_goal === true,
          has_steering: wake.checks?.has_steering === true,
          current_experiment: wake.current_experiment?.id || null,
          receipt_path: wake.receipt_path,
        };
        tickResults.push(tick);
        fs.appendFileSync(tickLogPath, JSON.stringify(tick) + '\n', 'utf8');
      } catch (error) {
        failed = true;
        const tick = {
          tick: index + 1,
          started_at: tickStartedAt,
          finished_at: stampIso(),
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
        tickResults.push(tick);
        fs.appendFileSync(tickLogPath, JSON.stringify(tick) + '\n', 'utf8');
        break;
      }
      if (index < ticks - 1 && intervalMs > 0) sleepSync(intervalMs);
    }
  } finally {
    releaseMemberLoopLease(paths, lease.lease);
  }

  const finishedAt = stampIso();
  const summary = {
    ok: !failed,
    action: 'loop',
    schema: 'atris.member_loop.v1',
    member: name,
    status: failed ? 'failed' : stopped ? 'stopped' : 'completed',
    mode: execute ? 'execute' : 'dry_run',
    run_id: runId,
    ticks_requested: ticks,
    ticks: tickResults.length,
    interval_ms: intervalMs,
    duration_ms_requested: durationMs,
    duration_ms_actual: Date.parse(finishedAt) - Date.parse(startedAt),
    decisions,
    has_mission_all_ticks: tickResults.length > 0 && tickResults.every((tick) => tick.has_mission === true),
    has_goal_all_ticks: tickResults.length > 0 && tickResults.every((tick) => tick.has_goal === true),
    has_steering_all_ticks: tickResults.length > 0 && tickResults.every((tick) => tick.has_steering === true),
    recovered_stale_lease: lease.recovered_stale,
    stale_lease: lease.stale_lease || null,
    started_at: startedAt,
    finished_at: finishedAt,
    log_path: tickLogPath,
    lock_path: paths.lockPath,
    latest_path: paths.latestPath,
    tick_receipts: tickResults.map((tick) => tick.receipt_path).filter(Boolean),
  };
  const receiptPath = writeMemberLoopReceipt(name, summary);
  const payload = { ...summary, receipt_path: receiptPath };
  writeJsonFile(paths.latestPath, payload);
  printJsonOrText(payload, [
    `Loop: ${name}`,
    `Status: ${payload.status}`,
    `Ticks: ${payload.ticks}/${payload.ticks_requested}`,
    `Decisions: ${Object.entries(decisions).map(([key, count]) => `${key} x${count}`).join(', ') || 'none'}`,
    `Receipt: ${path.relative(process.cwd(), receiptPath)}`,
  ], asJson);
}

function memberTick(name, ...args) {
  const paths = requireMemberDir(name);
  const asJson = hasFlag(args, '--json');
  const force = hasFlag(args, '--force');
  const goalId = readFlag(args, '--goal', '');
  const state = loadMemberGoals(name, paths);
  const goal = activeGoal(state, goalId);
  if (!goal) {
    console.error(`No active goal for ${name}. Run: atris member goal ${name} "..."`);
    process.exit(1);
  }
  goal.experiments = Array.isArray(goal.experiments) ? goal.experiments : [];
  const blocked = goal.experiments.find((item) => item.status === 'blocked') || null;
  if (blocked && !force) {
    goal.history = Array.isArray(goal.history) ? goal.history : [];
    goal.history.push({ at: stampIso(), event: 'tick_paused_blocked', experiment_id: blocked.id });
    writeMemberGoals(paths, state);
    const logPath = appendMemberGoalLog(paths.memberDir, name, 'Member tick paused blocked', {
      goal: goal.title,
      experiment: blocked.title,
      ask: blocked.block?.ask || 'Needs operator input.',
      orchestrator: blocked.block?.orchestrator || '',
    });
    printJsonOrText(
      { ok: true, action: 'blocked', member: name, goal_id: goal.id, experiment: blocked, needs_user: true, ask: blocked.block?.ask || 'Needs operator input.', goals_path: paths.goalsJson, log_path: logPath },
      [
        `Blocked for ${name}: ${blocked.title}`,
        `Ask: ${blocked.block?.ask || 'Needs operator input.'}`,
        `Next: atris member review ${name} ${blocked.id} --discard --proof "..."`,
      ],
      asJson,
    );
    return;
  }
  let experiment = goal.experiments.find((item) => item.status === 'proposed' || item.status === 'running') || null;
  const reused = Boolean(experiment && !force);
  if (!experiment || force) {
    experiment = proposalForGoal(goal);
    goal.experiments.push(experiment);
  }
  goal.history = Array.isArray(goal.history) ? goal.history : [];
  goal.history.push({ at: stampIso(), event: reused ? 'tick_reused_proposal' : 'tick_proposed_experiment', experiment_id: experiment.id });
  writeMemberGoals(paths, state);
  const logPath = appendMemberGoalLog(paths.memberDir, name, reused ? 'Member tick reused proposal' : 'Member tick proposed experiment', {
    goal: goal.title,
    experiment: experiment.title,
    proof_target: experiment.proof_target,
  });
  printJsonOrText(
    { ok: true, action: 'tick', member: name, goal_id: goal.id, experiment, reused, goals_path: paths.goalsJson, log_path: logPath },
    [
      `${reused ? 'Reusing' : 'Proposed'} experiment for ${name}: ${experiment.title}`,
      `Proof target: ${experiment.proof_target}`,
      `Stop rule: ${experiment.stop_rule}`,
    ],
    asJson,
  );
}

function memberReview(name, experimentId, ...args) {
  const paths = requireMemberDir(name);
  const asJson = hasFlag(args, '--json');
  const accepted = hasFlag(args, '--accept');
  const discarded = hasFlag(args, '--discard');
  if (!experimentId || accepted === discarded) {
    console.error('Usage: atris member review <name> <experiment-id> (--accept|--discard) --proof "..." [--lesson "..."] [--next "..."]');
    process.exit(1);
  }
  const proof = readFlag(args, '--proof', '');
  if (!proof) {
    console.error('Refusing review without --proof.');
    process.exit(1);
  }
  const value = readNumberFlag(args, '--value', null);
  if (value != null && (!Number.isInteger(value) || value < 1 || value > 5)) {
    console.error('Value must be an integer from 1 to 5.');
    process.exit(1);
  }
  const lesson = readFlag(args, '--lesson', '');
  const nextTitle = readFlag(args, '--next', '');
  const state = loadMemberGoals(name, paths);
  const { goal: foundGoal, experiment } = findExperiment(state, experimentId);
  if (!foundGoal || !experiment) {
    console.error(`Experiment "${experimentId}" not found for ${name}.`);
    process.exit(1);
  }
  experiment.status = accepted ? 'accepted' : 'discarded';
  experiment.reviewed_at = stampIso();
  experiment.proof = proof;
  if (value != null) experiment.value = value;
  if (lesson) experiment.lesson = lesson;
  let nextExperiment = null;
  if (accepted && nextTitle) {
    nextExperiment = {
      id: makeExperimentId(foundGoal.id, nextTitle),
      title: nextTitle,
      status: 'proposed',
      proof_target: (foundGoal.acceptance || [])[0] || 'Return proof, risk, and next move.',
      stop_rule: 'Stop if proof is missing, risk is unclear, or the next move would require new authority.',
      created_at: stampIso(),
      source: `review:${experiment.id}`,
    };
    foundGoal.experiments.push(nextExperiment);
  }
  foundGoal.history = Array.isArray(foundGoal.history) ? foundGoal.history : [];
  foundGoal.history.push({
    at: stampIso(),
    event: accepted ? 'experiment_accepted' : 'experiment_discarded',
    experiment_id: experiment.id,
    next_experiment_id: nextExperiment?.id,
    value,
  });
  writeMemberGoals(paths, state);
  const logPath = appendMemberGoalLog(paths.memberDir, name, accepted ? 'Member experiment accepted' : 'Member experiment discarded', {
    goal: foundGoal.title,
    experiment: experiment.title,
    proof,
    lesson,
    value: value == null ? '' : `${value}/5`,
    next: nextExperiment?.title || '',
  });
  printJsonOrText(
    { ok: true, action: 'review', member: name, goal_id: foundGoal.id, experiment, outcome: experiment.status, value, next_experiment: nextExperiment, goals_path: paths.goalsJson, log_path: logPath },
    [
      `${accepted ? 'Accepted' : 'Discarded'} experiment for ${name}: ${experiment.title}`,
      `Proof: ${proof}`,
      ...(value == null ? [] : [`Value: ${value}/5`]),
      ...(nextExperiment ? [`Next proposed: ${nextExperiment.title}`] : []),
    ],
    asJson,
  );
}

function memberBlock(name, experimentId, ...args) {
  const paths = requireMemberDir(name);
  const asJson = hasFlag(args, '--json');
  const reason = readFlag(args, '--reason', '');
  const ask = readFlag(args, '--ask', '');
  const orchestrator = readFlag(args, '--orchestrator', '');
  if (!experimentId || !reason || !ask) {
    console.error('Usage: atris member block <name> <experiment-id> --reason "..." --ask "..." [--orchestrator name]');
    process.exit(1);
  }
  const state = loadMemberGoals(name, paths);
  const { goal, experiment } = findExperiment(state, experimentId);
  if (!goal || !experiment) {
    console.error(`Experiment "${experimentId}" not found for ${name}.`);
    process.exit(1);
  }
  experiment.status = 'blocked';
  experiment.blocked_at = stampIso();
  experiment.block = { reason, ask, orchestrator: orchestrator || null };
  goal.history = Array.isArray(goal.history) ? goal.history : [];
  goal.history.push({ at: stampIso(), event: 'experiment_blocked', experiment_id: experiment.id, ask, orchestrator: orchestrator || null });
  writeMemberGoals(paths, state);
  const logPath = appendMemberGoalLog(paths.memberDir, name, 'Member experiment blocked', {
    goal: goal.title,
    experiment: experiment.title,
    reason,
    ask,
    orchestrator,
  });
  printJsonOrText(
    { ok: true, action: 'blocked', member: name, goal_id: goal.id, experiment, needs_user: true, ask, orchestrator: orchestrator || null, goals_path: paths.goalsJson, log_path: logPath },
    [
      `Blocked ${name}: ${experiment.title}`,
      `Reason: ${reason}`,
      `Ask: ${ask}`,
      ...(orchestrator ? [`Orchestrator: ${orchestrator}`] : []),
    ],
    asJson,
  );
}

function memberStatus(name, ...args) {
  const paths = requireMemberDir(name);
  const asJson = hasFlag(args, '--json');
  const state = loadMemberGoals(name, paths);
  const goal = activeGoal(state);
  const current = memberOpenExperiment(state);
  const lastReviewed = memberLastReviewedExperiment(state);
  const value = memberValueSummary(state);
  const logs = recentLogLines(paths.memberDir);
  const needsUser = current?.status === 'blocked';
  const stateLabel = !goal
    ? 'no_goal'
    : needsUser
      ? 'needs_user'
      : current
        ? current.status
        : 'ready';
  const ask = needsUser ? (current.block?.ask || 'Needs operator input.') : null;
  const nextCommand = !goal
    ? `atris member goal ${name} "..."`
    : needsUser
      ? `atris member review ${name} ${current.id} --discard --proof "..."`
      : current
        ? `atris member review ${name} ${current.id} --accept --proof "..." --value 4`
        : `atris member tick ${name}`;
  const payload = {
    ok: true,
    action: 'status',
    member: name,
    state: stateLabel,
    needs_user: needsUser,
    ask,
    active_goal: goal || null,
    current_experiment: current || null,
    last_reviewed: lastReviewed || null,
    value,
    next_command: nextCommand,
    recent_log: logs,
    goals_path: paths.goalsJson,
    goals_md_path: paths.goalsMd,
  };
  printJsonOrText(
    payload,
    [
      `Member: ${name}`,
      `State: ${stateLabel}`,
      `Goal: ${goal?.title || 'No goal yet'}`,
      `Current: ${current ? `${current.status} - ${current.title}` : 'No open experiment'}`,
      ...(ask ? [`Ask: ${ask}`] : []),
      `Value: ${value.line}`,
      `Next: ${nextCommand}`,
      ...(logs.length ? ['Recent log:', ...logs.map((line) => `  ${line}`)] : []),
    ],
    asJson,
  );
}

// --- Command Dispatcher ---

function memberCommand(subcommand, ...args) {
  switch (subcommand) {
    case 'list':
    case 'ls':
      return memberList();
    case 'create':
    case 'new':
      return memberCreate(args[0], ...args.slice(1));
    case 'activate':
      return memberActivate(args[0]);
    case 'upgrade':
      return memberUpgrade(args[0]);
    case 'push':
      return memberPush(args[0]);
    case 'pull':
      return memberPull(args[0]);
    case 'goal':
      return memberGoal(args[0], ...args.slice(1));
    case 'goal-from-mission':
    case 'mission-goal':
      return memberGoalFromMission(args[0], ...args.slice(1));
    case 'tick':
      return memberTick(args[0], ...args.slice(1));
    case 'wake':
      return memberWake(args[0], ...args.slice(1));
    case 'loop':
      return memberLoop(args[0], ...args.slice(1));
    case 'review':
      return memberReview(args[0], args[1], ...args.slice(2));
    case 'block':
      return memberBlock(args[0], args[1], ...args.slice(2));
    case 'status':
      return memberStatus(args[0], ...args.slice(1));
    case 'archive':
      return memberArchive(args[0]);
    case 'purge-archived':
      return memberPurgeArchived(...args);
    default:
      console.log('');
      console.log('Usage: atris member <subcommand> [name]');
      console.log('');
      console.log('Subcommands:');
      console.log('  create <name>       Scaffold a new team member (MEMBER.md + dirs) [--push]');
      console.log('  list                Show all team members');
      console.log('  activate <name>     Symlink member skills, show context and permissions');
      console.log('  upgrade <name>      Convert flat file (name.md) to directory format');
      console.log('  push <name>         Push a local team member to the cloud');
      console.log('  pull <name|id>      Pull a cloud agent as a local team member');
      console.log('  goal <name> "..."   Create/update a member long-term goal');
      console.log('  goal-from-mission <name>  Create/reuse a goal from MISSION.md and now.md');
      console.log('  wake <name>         Read Mission state and decide tick/wait/ask/stop');
      console.log('  loop <name>         Repeat wake on a bounded cadence with a no-overlap lease');
      console.log('  tick <name>         Propose the next bounded experiment');
      console.log('  review <name> <id>  Accept/discard an experiment with proof');
      console.log('  block <name> <id>   Mark an experiment blocked with a human/orchestrator ask');
      console.log('  status <name>       Show goal, open experiment, value, ask, and recent log');
      console.log('  archive <name>      Move a member to atris/team/_archived/');
      console.log('  purge-archived      Delete archived members older than --days=60 with confirmation');
      console.log('');
      console.log('Create flags:');
      console.log('  --role="Title"         Set the member role');
      console.log('  --description="..."    Set the member description');
      console.log('  --push                 Also create a cloud agent after scaffolding');
      console.log('');
      console.log('Examples:');
      console.log('  atris member create sdr --role="Sales Development Rep"');
      console.log('  atris member list');
      console.log('  atris member activate navigator');
      console.log('  atris member upgrade executor');
      console.log('  atris member push navigator');
      console.log('  atris member pull navigator           (reads agent-id from local MEMBER.md)');
      console.log('  atris member goal growth "Recover more customer revenue" --acceptance "one proof-backed action"');
      console.log('  atris member goal-from-mission growth --json');
      console.log('  atris member wake growth --json');
      console.log('  atris member wake growth --execute --confirm-autonomy-policy');
      console.log('  atris member loop growth --minutes 10 --interval 60 --json');
      console.log('  atris member loop growth --ticks 2 --interval 0 --json');
      console.log('  atris member tick growth --json');
      console.log('  atris member status growth');
      console.log('  atris member review growth exp_123 --accept --proof "validated" --value 4');
      console.log('  atris member archive old-member');
      console.log('  atris member purge-archived --days=60 --confirm "delete archived members"');
      console.log('');
  }
}

module.exports = { memberCommand, findAllMembers, parseFrontmatter };
