const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { execFileSync } = require('child_process');
const { loadCredentials } = require('../utils/auth');
const { apiRequestJson } = require('../utils/api');
const { runAliveTick } = require('../lib/member-alive');

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

function resolveMemberRunMissionId(name, args = []) {
  const override = readFlag(args, '--mission', '') || readFlag(args, '--mission-id', '');
  if (override) return override;

  const paths = requireMemberDir(name);
  const purpose = missionPurpose(paths);
  if (purpose.runtimeMission?.id) return purpose.runtimeMission.id;

  const goals = loadMemberGoals(name, paths);
  const goal = activeGoal(goals);
  return goal?.mission_id || '';
}

function memberRun(name, ...args) {
  if (!name || name === '--help' || name === '-h' || hasFlag(args, '--help') || hasFlag(args, '-h')) {
    console.log('Usage: atris member run <name> [mission run flags]');
    console.log('Example: atris member run block-builder --max-ticks 1 --max-wall 900 --json');
    console.log('Override: atris member run block-builder --mission <mission-id> --json');
    return;
  }

  const missionId = resolveMemberRunMissionId(name, args);
  if (!missionId) {
    console.error(`No active Mission Runtime found for member "${name}".`);
    console.error(`Try: atris member goal-from-mission ${name} --json`);
    console.error(`Or:  atris mission start "..." --owner ${name}`);
    process.exitCode = 1;
    return;
  }

  const runArgs = stripKnownFlags(args, ['--mission', '--mission-id']);
  if (!readFlag(runArgs, '--max-ticks', '')) runArgs.push('--max-ticks', '1');
  if (!readFlag(runArgs, '--max-wall', '')) runArgs.push('--max-wall', '900');

  const cliPath = path.join(__dirname, '..', 'bin', 'atris.js');
  try {
    execFileSync(process.execPath, [cliPath, 'mission', 'run', missionId, ...runArgs], {
      cwd: process.cwd(),
      stdio: 'inherit',
    });
  } catch (error) {
    process.exitCode = Number(error?.status) || 1;
  }
}

function loadTeamScoreEvidence(scoreJsonPath) {
  const sourcePath = String(scoreJsonPath || '').trim();
  try {
    if (sourcePath) {
      const raw = sourcePath === '-'
        ? fs.readFileSync(0, 'utf8')
        : fs.readFileSync(path.resolve(process.cwd(), sourcePath), 'utf8');
      return {
        ok: true,
        source: sourcePath === '-' ? 'stdin' : path.relative(process.cwd(), path.resolve(process.cwd(), sourcePath)),
        parsed: JSON.parse(raw),
      };
    }
    const scoreScript = path.join(process.cwd(), 'scripts', 'team-overall-score.mjs');
    if (!fs.existsSync(scoreScript)) {
      return {
        ok: false,
        source: null,
        error: 'No --score-json was provided and scripts/team-overall-score.mjs was not found.',
      };
    }
    const raw = execFileSync(process.execPath, [scoreScript, '--json'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return {
      ok: true,
      source: 'scripts/team-overall-score.mjs --json',
      parsed: JSON.parse(raw),
    };
  } catch (error) {
    return {
      ok: false,
      source: sourcePath || null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function normalizeTeamScoreEvidence(parsed, source) {
  const score = parsed?.score || parsed || {};
  const learningPacket = parsed?.learningPacket || {};
  const dimensions = Array.isArray(score.dimensions) ? score.dimensions : [];
  const weakest = score.weakest || dimensions.slice().sort((a, b) => Number(a.score || 0) - Number(b.score || 0))[0] || null;
  const nextMove = compactSentence(
    score.nextMove
      || (weakest ? `Raise ${weakest.label || weakest.id || 'Team Overall'}: ${weakest.recommendation || 'Run one verified improvement loop.'}` : ''),
    220,
  );
  if (!nextMove || !weakest) return null;
  const latestReward = parsed?.taskLedger?.latestReward || parsed?.latestReward || null;
  const targetMember = learningPacket.targetMember || parsed?.targetMember || null;
  return {
    source: source || 'unknown',
    overall: Number.isFinite(Number(score.overall)) ? Number(score.overall) : null,
    formula: score.formula || null,
    next_move: nextMove,
    weakest: {
      id: weakest.id || null,
      label: weakest.label || weakest.id || 'Team Overall',
      score: Number.isFinite(Number(weakest.score)) ? Number(weakest.score) : null,
      recommendation: weakest.recommendation || null,
      evidence: weakest.evidence || null,
    },
    latest_reward: latestReward ? {
      ref: latestReward.ref || latestReward.display_id || latestReward.id || null,
      title: latestReward.title || null,
      reward: latestReward.reward == null ? null : Number.isFinite(Number(latestReward.reward)) ? Number(latestReward.reward) : null,
      proof: latestReward.proof || null,
    } : null,
    target_member: targetMember ? {
      slug: targetMember.slug || null,
      label: targetMember.label || targetMember.slug || null,
      overall: Number.isFinite(Number(targetMember.overall)) ? Number(targetMember.overall) : null,
      next: targetMember.next || null,
      weakest_attribute: targetMember.weakestAttribute || targetMember.weakest_attribute || null,
    } : null,
    drill: learningPacket.drill || null,
    verifier: learningPacket.verifier || null,
    generated_at: parsed?.generated_at || parsed?.generatedAt || parsed?.created_at || null,
  };
}

function latestRewardLine(latestReward) {
  if (!latestReward) return 'no latest reward receipt';
  const ref = latestReward.ref ? `${latestReward.ref} ` : '';
  const reward = latestReward.reward == null ? '' : ` reward ${latestReward.reward}`;
  const proof = latestReward.proof ? ` - ${compactSentence(latestReward.proof, 120)}` : '';
  return `${ref}${latestReward.title || 'latest reviewed task'}${reward}${proof}`.trim();
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
        raw: record.raw || null,
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

const WAKE_DIRECTIVE_DECISIONS = new Set(['close_loop', 'report_proof', 'create_missing_task', 'ask', 'wait']);
const CLOSED_TASK_STATUSES = new Set(['done', 'complete', 'completed', 'reviewed', 'failed', 'stopped', 'closed', 'cancelled', 'canceled']);

function parseWakeDirectiveLine(line) {
  const match = String(line || '').match(/\bwake directive:\s*(close_loop|report_proof|create_missing_task|ask|wait)\b(?:\s*[-:]\s*(.*))?/i);
  if (!match) return null;
  return {
    decision: match[1].toLowerCase(),
    note: compactSentence(match[2] || '', 180),
  };
}

function commandForWakeDirective(name, directive, goal) {
  const note = directive.note || goal?.title || 'self-improvement loop';
  if (directive.decision === 'close_loop') return `atris task next --json`;
  if (directive.decision === 'report_proof') return `atris task note ${note}`;
  if (directive.decision === 'create_missing_task') return `atris task delegate "${note}" --to ${name} --tag agent`;
  if (directive.decision === 'ask') return `ask: ${note}`;
  return `atris member loop ${name} --status --json`;
}

function taskRefsFromText(text) {
  return [...new Set(String(text || '').match(/\b[A-Z]{2,10}-\d+\b/gi)?.map((ref) => ref.toUpperCase()) || [])];
}

function steeringWakeDirective(steering, name, goal) {
  for (const record of steering || []) {
    const lines = [...(record.memory || []), record.raw || ''];
    const task_refs = taskRefsFromText(lines.join('\n'));
    for (const line of lines) {
      const parsed = parseWakeDirectiveLine(line);
      if (!parsed || !WAKE_DIRECTIVE_DECISIONS.has(parsed.decision)) continue;
      return {
        ...parsed,
        steering_id: record.id || null,
        task_refs,
        next_command: commandForWakeDirective(name, parsed, goal),
      };
    }
  }
  return null;
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

function taskCandidateOwnerValues(task) {
  return [
    task?.claimed_by,
    task?.claimedBy,
    task?.assigned_to,
    task?.assignedTo,
    task?.owner,
    task?.metadata?.assigned_to,
    task?.metadata?.assignedTo,
    task?.metadata?.owner,
    task?.atrisContext?.teamMember,
  ].filter(Boolean).map(lowerCompact);
}

function taskBelongsToMember(task, name) {
  return taskCandidateOwnerValues(task).includes(lowerCompact(name));
}

function taskHasReviewProof(task) {
  if (task?.review?.proof) return true;
  if (task?.proof) return true;
  return (task?.events || []).some((event) => event?.payload?.proof || event?.payload?.review?.proof);
}

function taskCandidateFromSource(task, source, sourcePath = '') {
  const ref = taskRef(task);
  if (!ref) return null;
  const status = lowerCompact(task.status || task.state || 'open');
  const title = compactSentence(task.title || task.summary || ref, 120);
  const base = {
    source,
    source_path: sourcePath || null,
    task_ref: ref,
    title,
    status,
    claimed_by: task.claimed_by || task.claimedBy || null,
    assigned_to: task.assigned_to || task.assignedTo || task.owner || task.metadata?.assigned_to || task.metadata?.owner || null,
    proof: task.review?.proof || task.proof || null,
    updated_at: task.updated_at || task.updatedAt || task.done_at || task.created_at || task.createdAt || null,
  };

  if (['blocked', 'needs_you', 'needs-user', 'needs_user'].includes(status)) {
    return {
      ...base,
      decision: 'ask',
      ask: compactSentence(task.blocker || task.block?.ask || task.review?.next_task || `Need operator input for ${ref}.`, 180),
      next_command: `atris task show ${ref} --json`,
    };
  }

  if (['review', 'ready'].includes(status)) {
    return taskHasReviewProof(task)
      ? null
      : {
          ...base,
          decision: 'report_proof',
          ask: null,
          next_command: `atris task note ${ref} "Report proof for completed loop: ${title}"`,
        };
  }

  if (['open', 'backlog', 'claimed', 'in_progress', 'in-progress', 'working', 'plan', 'do'].includes(status)) {
    const alreadyClaimedByMember = lowerCompact(base.claimed_by) === lowerCompact(base.assigned_to);
    return {
      ...base,
      decision: 'close_loop',
      ask: null,
      next_command: alreadyClaimedByMember
        ? `atris task note ${ref} "Closing nearest open loop: ${title}"`
        : `atris task claim ${ref} --as ${base.assigned_to || 'member'}`,
    };
  }

  if (status === 'done' && !taskHasReviewProof(task)) {
    return {
      ...base,
      decision: 'report_proof',
      ask: null,
      next_command: `atris task note ${ref} "Report proof for completed loop: ${title}"`,
    };
  }

  return null;
}

function goalEvidenceStrings(goal) {
  const seen = new Set();
  const out = [];
  function push(value) {
    if (typeof value !== 'string') return;
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    out.push(trimmed);
  }
  function walk(value, depth = 0) {
    if (depth > 4 || value == null) return;
    if (typeof value === 'string') {
      push(value);
      return;
    }
    if (Array.isArray(value)) {
      value.slice(0, 30).forEach((item) => walk(item, depth + 1));
      return;
    }
    if (typeof value === 'object') {
      for (const [key, item] of Object.entries(value).slice(0, 60)) {
        if (/^(history|experiments)$/i.test(key)) continue;
        walk(item, depth + 1);
      }
    }
  }
  walk(goal);
  return out;
}

function normalizeEvidencePath(raw, root = process.cwd()) {
  let value = String(raw || '').trim().replace(/^["'`(<[]+|["'`)>.,;\]]+$/g, '');
  value = value.replace(/:\d+(?::\d+)?$/, '');
  if (!value || value.includes('\0')) return null;
  if (/^[a-z]+:\/\//i.test(value)) return null;
  if (value.startsWith('~/')) value = path.join(os.homedir(), value.slice(2));
  const resolved = path.isAbsolute(value) ? path.resolve(value) : path.resolve(root, value);
  const workspace = path.resolve(root);
  if (resolved !== workspace && !resolved.startsWith(`${workspace}${path.sep}`)) return null;
  const rel = path.relative(workspace, resolved);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  if (rel.split(path.sep).some((part) => ['.git', 'node_modules', 'dist', 'build'].includes(part))) return null;
  return { input: raw, path: resolved, relative_path: rel };
}

function filePathsFromGoal(goal, root = process.cwd()) {
  const explicit = [
    goal?.mission_file,
    goal?.missionFile,
    goal?.source_file,
    goal?.sourceFile,
    goal?.verifier,
  ].filter(Boolean);
  const text = [...explicit, ...goalEvidenceStrings(goal)].join('\n');
  const matches = [];
  const pathPattern = /(?:^|[\s"'(])((?:~\/|\.{1,2}\/|\/)?(?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]+\.[A-Za-z0-9_-]{1,12})(?::\d+(?::\d+)?)?/g;
  const rootFilePattern = /(?:^|[\s"'(])([A-Za-z0-9._-]+\.(?:md|json|js|cjs|mjs|ts|tsx|py|yml|yaml|toml|txt|csv))(?::\d+(?::\d+)?)?/g;
  for (const pattern of [pathPattern, rootFilePattern]) {
    let match = pattern.exec(text);
    while (match) {
      matches.push(match[1]);
      match = pattern.exec(text);
    }
  }
  return [...new Map(
    matches
      .map((item) => normalizeEvidencePath(item, root))
      .filter(Boolean)
      .map((item) => [item.relative_path, item]),
  ).values()].slice(0, 12);
}

function readGoalFileEvidence(goal, root = process.cwd()) {
  const paths = filePathsFromGoal(goal, root);
  const files = [];
  for (const item of paths) {
    const row = {
      input: item.input,
      path: item.relative_path,
      exists: false,
      bytes: 0,
      excerpt: '',
      truncated: false,
    };
    try {
      const stat = fs.statSync(item.path);
      if (!stat.isFile()) {
        row.error = 'not_file';
        files.push(row);
        continue;
      }
      row.exists = true;
      row.bytes = stat.size;
      const maxBytes = 8000;
      const raw = fs.readFileSync(item.path, 'utf8');
      row.excerpt = raw.slice(0, maxBytes);
      row.truncated = raw.length > maxBytes;
    } catch (error) {
      row.error = error && error.code ? error.code : 'read_failed';
    }
    files.push(row);
  }
  return {
    path_count: paths.length,
    files_read: files.filter((file) => file.exists && file.excerpt).length,
    files,
  };
}

function taskIsClosed(task) {
  if (!task) return false;
  const status = lowerCompact(task.status || task.state || '');
  if (CLOSED_TASK_STATUSES.has(status)) return true;
  return Boolean(task.done_at || task.doneAt) && !['open', 'backlog', 'claimed', 'in_progress', 'in-progress', 'working', 'plan', 'do', 'review', 'ready'].includes(status);
}

function taskProjectionRows() {
  const projectionPath = path.join(process.cwd(), '.atris', 'state', 'tasks.projection.json');
  const projection = readJsonIfExists(projectionPath);
  return Array.isArray(projection?.tasks) ? projection.tasks : [];
}

function findProjectionTaskByRef(ref) {
  const wanted = String(ref || '').toUpperCase();
  return taskProjectionRows().find((task) => String(taskRef(task) || '').toUpperCase() === wanted) || null;
}

function readTaskShowByRef(ref) {
  try {
    const cliPath = path.join(__dirname, '..', 'bin', 'atris.js');
    const output = execFileSync(process.execPath, [cliPath, 'task', 'show', ref, '--json'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    });
    const parsed = JSON.parse(output || '{}');
    return parsed?.task || parsed || null;
  } catch {
    return null;
  }
}

function resolveTaskRefStatus(ref) {
  const projectionTask = findProjectionTaskByRef(ref);
  if (projectionTask) {
    return {
      ref,
      found: true,
      source: 'task_projection',
      status: projectionTask.status || projectionTask.state || null,
      closed: taskIsClosed(projectionTask),
    };
  }
  const shownTask = readTaskShowByRef(ref);
  if (shownTask) {
    return {
      ref,
      found: true,
      source: 'task_show',
      status: shownTask.status || shownTask.state || null,
      closed: taskIsClosed(shownTask),
    };
  }
  return {
    ref,
    found: false,
    source: null,
    status: null,
    closed: false,
  };
}

function steeringDirectiveClosure(directive) {
  const refs = Array.isArray(directive?.task_refs) ? directive.task_refs : [];
  const tasks = refs.map(resolveTaskRefStatus);
  const missing_refs = tasks.filter((task) => !task.found).map((task) => task.ref);
  const open_refs = tasks.filter((task) => task.found && !task.closed).map((task) => task.ref);
  const closed_refs = tasks.filter((task) => task.found && task.closed).map((task) => task.ref);
  return {
    steering_id: directive?.steering_id || null,
    task_refs: refs,
    tasks,
    closed_refs,
    open_refs,
    missing_refs,
    all_closed: refs.length > 0 && open_refs.length === 0 && missing_refs.length === 0,
  };
}

function candidatePriority(candidate) {
  const decisionPriority = {
    ask: 4,
    close_loop: 3,
    report_proof: 2,
    create_missing_task: 1,
  }[candidate?.decision] || 0;
  const sourcePriority = {
    task_projection: 3,
    member_room: 2,
    member_room_unlinked_request: 2,
  }[candidate?.source] || 0;
  return decisionPriority * 10 + sourcePriority;
}

function sortEvidenceCandidates(candidates) {
  return candidates
    .filter(Boolean)
    .slice()
    .sort((a, b) => {
      const byPriority = candidatePriority(b) - candidatePriority(a);
      if (byPriority) return byPriority;
      return String(b.updated_at || '').localeCompare(String(a.updated_at || ''));
    });
}

function readTaskProjectionEvidence(name) {
  const projectionPath = path.join(process.cwd(), '.atris', 'state', 'tasks.projection.json');
  const projection = readJsonIfExists(projectionPath);
  const tasks = taskProjectionRows();
  const candidates = sortEvidenceCandidates(
    tasks
      .filter((task) => taskBelongsToMember(task, name))
      .map((task) => taskCandidateFromSource(task, 'task_projection', projectionPath)),
  );
  return {
    path: projectionPath,
    exists: Boolean(projection),
    task_count: tasks.length,
    candidate_count: candidates.length,
    candidates: candidates.slice(0, 20),
    nearest: candidates[0] || null,
  };
}

function listThreadJsonFiles(root) {
  if (!root || !fs.existsSync(root)) return [];
  const out = [];
  try {
    for (const entry of fs.readdirSync(root)) {
      const projectPath = path.join(root, entry);
      let stat = null;
      try {
        stat = fs.statSync(projectPath);
      } catch {
        continue;
      }
      if (stat.isFile() && entry.endsWith('.json')) {
        out.push({ path: projectPath, mtimeMs: stat.mtimeMs });
        continue;
      }
      if (!stat.isDirectory()) continue;
      for (const file of fs.readdirSync(projectPath)) {
        if (!file.endsWith('.json')) continue;
        const fullPath = path.join(projectPath, file);
        try {
          const fileStat = fs.statSync(fullPath);
          out.push({ path: fullPath, mtimeMs: fileStat.mtimeMs });
        } catch {
          // ignore unreadable thread files
        }
      }
    }
  } catch {
    return [];
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, 80);
}

function latestActionableUserLine(thread) {
  const messages = Array.isArray(thread?.messages) ? thread.messages : [];
  for (const message of messages.slice().reverse()) {
    if (message?.role !== 'user') continue;
    const text = compactSentence(message.text || message.content || '', 140);
    if (!text) continue;
    if (/\b(did you|was it|status|check if|quick check|what happened|what's happening)\b/i.test(text)) continue;
    if (/\b(fix|build|add|wire|prove|ship|close|make|implement|update|create)\b/i.test(text)) return text;
  }
  return '';
}

function readMemberRoomEvidence(name) {
  const roots = [path.join(process.cwd(), '.obelisk', 'threads')];
  const projectsPath = path.join(os.homedir(), '.obelisk', 'projects.json');
  const projects = readJsonIfExists(projectsPath);
  if (Array.isArray(projects)) {
    const cwd = path.resolve(process.cwd());
    const project = projects.find((item) => item?.path && path.resolve(item.path) === cwd && item.id);
    if (project) roots.push(path.join(os.homedir(), '.obelisk', 'threads', project.id));
  }
  const seen = new Set();
  const candidates = [];
  let files_checked = 0;
  for (const root of roots) {
    for (const item of listThreadJsonFiles(root)) {
      if (seen.has(item.path)) continue;
      seen.add(item.path);
      const thread = readJsonIfExists(item.path);
      files_checked += 1;
      const context = thread?.atrisContext || {};
      const linkedTasks = Array.isArray(context.linkedTasks) ? context.linkedTasks : [];
      const threadMember = lowerCompact(context.teamMember) === lowerCompact(name);
      for (const linked of linkedTasks) {
        const owned = lowerCompact(linked?.owner || linked?.teamMember || context.teamMember) === lowerCompact(name);
        if (!owned) continue;
        const candidate = taskCandidateFromSource(linked, 'member_room', item.path);
        if (candidate) candidates.push(candidate);
      }
      if (threadMember && linkedTasks.length === 0) {
        const updatedAtMs = Number(thread.updatedAt || thread.updated_at || item.mtimeMs || 0);
        if (updatedAtMs && Date.now() - updatedAtMs > 60 * 60 * 1000) continue;
        const request = latestActionableUserLine(thread);
        if (request) {
          candidates.push({
            source: 'member_room_unlinked_request',
            source_path: item.path,
            task_ref: null,
            title: request,
            status: 'missing_task',
            decision: 'create_missing_task',
            ask: null,
            next_command: `atris task delegate "${request}" --to ${name} --tag agent`,
            updated_at: thread.updatedAt || thread.updated_at || item.mtimeMs,
          });
        }
      }
    }
  }
  const sorted = sortEvidenceCandidates(candidates);
  return {
    files_checked,
    candidate_count: sorted.length,
    candidates: sorted.slice(0, 20),
    nearest: sorted[0] || null,
  };
}

function readRecentWakeReceiptEvidence(name) {
  const latestLoop = readJsonIfExists(memberLoopPaths(name).latestPath);
  const receiptPath = Array.isArray(latestLoop?.tick_receipts)
    ? latestLoop.tick_receipts.slice().reverse().find(Boolean)
    : null;
  const latestWake = receiptPath ? readJsonIfExists(receiptPath) : null;
  return {
    latest_loop_path: memberLoopPaths(name).latestPath,
    latest_loop_status: latestLoop?.status || null,
    latest_wake_receipt_path: receiptPath || null,
    latest_wake_decision: latestWake?.decision || null,
    latest_wake_reason: latestWake?.reason || null,
  };
}

function readJsonlRowsIfExists(filePath, maxRows = 80) {
  let text = '';
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch {
    return [];
  }
  const rows = [];
  const lines = text.split(/\r?\n/).filter((line) => line.trim()).slice(-Math.max(1, maxRows));
  for (const line of lines) {
    try {
      rows.push(JSON.parse(line));
    } catch {
      // Bad rows should not block discovery from valid rows in the same stream.
    }
  }
  return rows;
}

function stringFromSignalValue(value) {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) return value.map(stringFromSignalValue).filter(Boolean).slice(0, 4).join('; ');
  if (value && typeof value === 'object') {
    return [
      value.title,
      value.summary,
      value.reason,
      value.next_action,
      value.recommended_next_action,
      value.next_task_suggestion,
    ].map(stringFromSignalValue).find(Boolean) || '';
  }
  return '';
}

function valueAtPath(row, dottedPath) {
  return String(dottedPath || '').split('.').reduce((value, part) => {
    if (value == null || typeof value !== 'object') return null;
    return value[part];
  }, row);
}

function firstSignalText(row, paths) {
  for (const fieldPath of paths) {
    const text = stringFromSignalValue(valueAtPath(row, fieldPath));
    if (text) return text;
  }
  return '';
}

function signalTimestamp(row) {
  return row?.created_at
    || row?.createdAt
    || row?.generated_at
    || row?.finished_at
    || row?.timestamp
    || row?.ts
    || row?.at
    || row?.episode_created_at
    || null;
}

function actionableProblemText(text) {
  const value = compactSentence(text, 220);
  if (value.length < 12) return '';
  if (/^(none|null|false|n\/a|unknown)$/i.test(value)) return '';
  if (/\b(wait for|waiting for|manual send|owner approval only|human only)\b/i.test(value)) return '';
  const actionish = /\b(add|audit|build|capture|close|compile|connect|create|debug|discover|extract|fix|implement|ingest|model|patch|prove|rank|read|repair|review|scan|seed|ship|summarize|sync|test|triage|update|validate|verify|write)\b/i;
  const strategic = /\b(agi|autonomous|objective|world model|causal|transfer|architecture|emergent|scorecard|receipt|proof|telemetry|loop|customer|revenue|security|release)\b/i;
  return actionish.test(value) || strategic.test(value) ? value : '';
}

function titleFromProblemSignal(text) {
  const clean = compactSentence(text, 110)
    .replace(/^next\s+(task|move|action)\s*[:\-]\s*/i, '')
    .replace(/^recommended\s+next\s+(task|move|action)\s*[:\-]\s*/i, '')
    .replace(/^run\s+`([^`]+)`.*$/i, 'Run $1')
    .trim();
  if (!clean) return 'Investigate discovered problem';
  return `${clean[0].toUpperCase()}${clean.slice(1)}`;
}

function problemSignalSources(root = process.cwd()) {
  const sources = [];
  const seen = new Set();
  function push(source) {
    if (!source) return;
    const key = `${source.source}:${source.path}`;
    if (seen.has(key)) return;
    seen.add(key);
    sources.push(source);
  }
  for (const source of problemSignalFilesForStateDir(path.join(root, '.atris', 'state'))) push(source);
  const siblingBackend = path.resolve(root, '..', 'atrisos-backend');
  if (fs.existsSync(siblingBackend)) {
    for (const source of problemSignalFilesForStateDir(path.join(siblingBackend, '.atris', 'state'), 'backend')) push(source);
  }
  for (const source of configuredProblemSignalSources(root)) push(source);
  return sources;
}

function rowsFromProblemSignalSource(source) {
  if (source.kind === 'jsonl') return readJsonlRowsIfExists(source.path, 80);
  const row = readJsonIfExists(source.path);
  return row ? [row] : [];
}

function logErrorScanScriptPath(root = process.cwd()) {
  const envPath = process.env.ATRIS_SCAN_ERRORS_SCRIPT;
  const candidates = [
    envPath ? path.resolve(root, envPath) : null,
    path.join(root, 'scripts', 'scan-errors.mjs'),
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function runLogErrorScan(root = process.cwd()) {
  const scriptPath = logErrorScanScriptPath(root);
  if (!scriptPath) {
    return {
      ok: false,
      skipped: 'missing_scan_errors_script',
      script_path: path.join(root, 'scripts', 'scan-errors.mjs'),
    };
  }
  try {
    const stdout = execFileSync(process.execPath, [scriptPath, '--root', root, '--json'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10000,
      env: process.env,
    });
    return {
      ok: true,
      script_path: scriptPath,
      scan: JSON.parse(stdout || '{}'),
    };
  } catch (error) {
    return {
      ok: false,
      script_path: scriptPath,
      error: error instanceof Error ? error.message : String(error),
      stderr: error?.stderr ? compactSentence(String(error.stderr), 500) : null,
    };
  }
}

function recurringErrorTaskTitle(pattern) {
  return `Fix recurring error: ${compactSentence(pattern, 90)}`;
}

function existingOpenTaskByTitle(title) {
  const wanted = lowerCompact(title);
  return taskProjectionRows().find((task) => lowerCompact(task.title) === wanted && !taskIsClosed(task)) || null;
}

function signalSourceKind(filePath, override = '') {
  const kind = lowerCompact(override || '');
  if (kind === 'jsonl' || kind === 'json') return kind;
  return String(filePath || '').endsWith('.jsonl') ? 'jsonl' : 'json';
}

function signalSourceLabel(value, fallback = 'external') {
  const clean = lowerCompact(value || fallback).replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return clean || fallback;
}

function problemSignalFilesForStateDir(stateDir, prefix = '') {
  const label = (name) => prefix ? `${prefix}_${name}` : name;
  return [
    { source: label('scorecards'), path: path.join(stateDir, 'scorecards.jsonl'), kind: 'jsonl' },
    { source: label('episodes'), path: path.join(stateDir, 'episodes.jsonl'), kind: 'jsonl' },
    { source: label('task_episodes'), path: path.join(stateDir, 'task_episodes.jsonl'), kind: 'jsonl' },
    { source: label('events'), path: path.join(stateDir, 'events.jsonl'), kind: 'jsonl' },
    { source: label('master_loop_events'), path: path.join(stateDir, 'master_loop_events.jsonl'), kind: 'jsonl' },
    { source: label('pulse_agi_loop_receipts'), path: path.join(stateDir, 'pulse_agi_loop_receipts.jsonl'), kind: 'jsonl' },
    { source: label('company_yc_wow_latest'), path: path.join(stateDir, 'company_yc_wow_latest.json'), kind: 'json' },
  ];
}

function normalizeSignalRoot(raw, baseDir = process.cwd()) {
  const text = typeof raw === 'string'
    ? raw
    : raw?.path || raw?.root || raw?.workspace || '';
  if (!text || String(text).includes('\0')) return null;
  const expanded = String(text).trim().startsWith('~/')
    ? path.join(os.homedir(), String(text).trim().slice(2))
    : String(text).trim();
  if (!expanded) return null;
  const resolved = path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(baseDir, expanded);
  try {
    if (!fs.statSync(resolved).isDirectory()) return null;
  } catch {
    return null;
  }
  const label = signalSourceLabel(raw?.label || raw?.source || path.basename(resolved), 'external');
  return { root: resolved, label };
}

function configuredSignalFile(raw, baseDir = process.cwd()) {
  if (!raw) return null;
  const filePath = typeof raw === 'string' ? raw : raw.path || raw.file || '';
  if (!filePath || String(filePath).includes('\0')) return null;
  const expanded = String(filePath).trim().startsWith('~/')
    ? path.join(os.homedir(), String(filePath).trim().slice(2))
    : String(filePath).trim();
  if (!expanded) return null;
  const resolved = path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(baseDir, expanded);
  if (!/\.(jsonl|json)$/i.test(resolved)) return null;
  const label = signalSourceLabel(raw?.source || raw?.label || path.basename(resolved).replace(/\.(jsonl|json)$/i, ''), 'external_file');
  return {
    source: label,
    path: resolved,
    kind: signalSourceKind(resolved, raw?.kind || ''),
  };
}

function readMemberSignalSourceConfig(root = process.cwd()) {
  const candidates = [
    path.join(root, '.atris', 'state', 'member-signal-sources.json'),
    path.join(root, '.atris', 'member-signal-sources.json'),
  ];
  for (const configPath of candidates) {
    const config = readJsonIfExists(configPath);
    if (config && typeof config === 'object') return { config, configPath };
  }
  return { config: null, configPath: null };
}

function configuredProblemSignalSources(root = process.cwd()) {
  const sources = [];
  const seen = new Set();
  function push(source) {
    if (!source) return;
    const key = `${source.source}:${source.path}`;
    if (seen.has(key)) return;
    seen.add(key);
    sources.push(source);
  }

  const envRoots = String(process.env.ATRIS_MEMBER_SIGNAL_ROOTS || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  for (const item of envRoots) {
    const normalized = normalizeSignalRoot(item, root);
    if (!normalized) continue;
    for (const source of problemSignalFilesForStateDir(path.join(normalized.root, '.atris', 'state'), normalized.label)) {
      push(source);
    }
  }

  const { config } = readMemberSignalSourceConfig(root);
  if (config) {
    const rootEntries = [
      ...(Array.isArray(config.roots) ? config.roots : []),
      ...(Array.isArray(config.external_roots) ? config.external_roots : []),
    ];
    for (const entry of rootEntries) {
      const normalized = normalizeSignalRoot(entry, root);
      if (!normalized) continue;
      for (const source of problemSignalFilesForStateDir(path.join(normalized.root, '.atris', 'state'), normalized.label)) {
        push(source);
      }
    }
    const fileEntries = [
      ...(Array.isArray(config.sources) ? config.sources : []),
      ...(Array.isArray(config.files) ? config.files : []),
    ];
    for (const entry of fileEntries) push(configuredSignalFile(entry, root));
  }

  return sources;
}

const PROBLEM_ACTION_FIELDS = [
  'next_task_suggestion',
  'recommended_next_action',
  'recommended_next_move',
  'next_owner_action',
  'next_operator_action',
  'next_action',
  'next_move',
  'next_task',
  'useful_work',
  'task',
  'summary.recommended_next_action',
  'summary.next_action',
  'summary.next_owner_action',
  'owner_gate.recommended_next_action',
  'owner_gate.next_owner_action',
  'action_packet.recommended_next_action',
  'task_seed.next_task',
  'decision.recommended_next_action',
];

const PROBLEM_CONTEXT_FIELDS = [
  'current_blocker',
  'first_external_blocker',
  'next_priority_gap',
  'lesson',
  'failure',
  'blocker',
  'why',
  'goal',
  'problem',
  'summary.current_blocker',
  'summary.next_priority_gap',
  'summary.pending_requirements',
  'owner_gate.pending_requirements',
  'pending_requirements',
  'blockers',
];

function problemCandidateFromSignal(row, source, rowIndex, name, purpose) {
  const actionText = actionableProblemText(firstSignalText(row, PROBLEM_ACTION_FIELDS));
  const contextText = actionableProblemText(firstSignalText(row, PROBLEM_CONTEXT_FIELDS));
  const seedText = actionText || contextText;
  if (!seedText) return null;
  const problem = contextText || seedText;
  const title = titleFromProblemSignal(seedText);
  const candidate = {
    source: source.source,
    source_path: source.path,
    signal_index: rowIndex,
    title,
    objective_title: title,
    problem: compactSentence(problem, 180),
    suggested_action: compactSentence(actionText || seedText, 180),
    next_command: `atris member wake ${name} --execute --confirm-autonomy-policy`,
    updated_at: signalTimestamp(row),
  };
  return scoreProblemCandidate(candidate, purpose);
}

function problemCandidateFromLogErrorScan(scanResult, name, purpose) {
  const scan = scanResult?.scan || {};
  const selected = scan.selected || (scan.pattern ? { pattern: scan.pattern, count: scan.count, evidence: [] } : null);
  const pattern = compactSentence(selected?.pattern || '', 180);
  const count = Number(selected?.count || scan.count || 0);
  const threshold = Number(scan.threshold || 3);
  if (!pattern || !Number.isFinite(count) || count < threshold) return null;
  const title = recurringErrorTaskTitle(pattern);
  const existingTask = existingOpenTaskByTitle(title);
  const duplicateRef = existingTask ? taskRef(existingTask) : null;
  const evidencePaths = Array.isArray(selected.evidence)
    ? [...new Set(selected.evidence.map((item) => item?.path).filter(Boolean))]
    : [];
  const candidate = {
    source: 'log_error_scan',
    source_path: scanResult.script_path,
    signal_index: null,
    title,
    objective_title: title,
    task_title: title,
    problem: `${count} occurrences in ${scan.since_hours || 24}h: ${pattern}`,
    suggested_action: title,
    autonomous_action: duplicateRef ? 'note_existing_task' : 'create_task',
    duplicate_task_ref: duplicateRef,
    error_pattern: pattern,
    error_count: count,
    evidence_paths: evidencePaths,
    next_command: duplicateRef
      ? `atris task show ${duplicateRef} --json`
      : `atris task new ${shellQuote(title)} --tag auto-discovery`,
    updated_at: new Date().toISOString(),
  };
  return scoreProblemCandidate(candidate, purpose);
}

function scoreProblemCandidate(candidate, purpose) {
  const text = `${candidate.title || ''} ${candidate.problem || ''} ${candidate.suggested_action || ''} ${purpose?.northStar || ''}`;
  const components = {
    urgency: Math.max(1, Math.min(5, 1 + scoreKeywords(text, ['blocked', 'missing', 'failed', 'failing', 'stalled', 'required', 'gap']))),
    strategic_value: strategicScore(text, { title: purpose?.northStar || '', why: purpose?.goalGuidance || '', acceptance: [] }, null),
    novelty: Math.max(1, Math.min(5, 2 + scoreKeywords(text, ['new', 'novel', 'discover', 'scan', 'unknown', 'emergent', 'explore']))),
    signal_quality: candidate.suggested_action && candidate.problem ? 5 : 3,
    recency: recencyScore(candidate.updated_at),
  };
  const sourceBoost = {
    pulse_agi_loop_receipts: 18,
    backend_pulse_agi_loop_receipts: 18,
    scorecards: 15,
    episodes: 10,
    task_episodes: 10,
    master_loop_events: 8,
    backend_master_loop_events: 8,
    log_error_scan: 22,
  }[candidate.source] || 4;
  const score = sourceBoost
    + (components.urgency * 22)
    + (components.strategic_value * 25)
    + (components.novelty * 16)
    + (components.signal_quality * 8)
    + (components.recency * 5);
  return { ...candidate, score, components };
}

function collectProblemDiscoveryEvidence(name, purpose) {
  const candidates = [];
  const sources = problemSignalSources();
  const sourcesWithRows = [];
  const logErrorScan = lowerCompact(name) === 'signal-scout' ? runLogErrorScan() : null;
  const logErrorCandidate = logErrorScan ? problemCandidateFromLogErrorScan(logErrorScan, name, purpose) : null;
  if (logErrorCandidate) candidates.push(logErrorCandidate);
  for (const source of sources) {
    const rows = rowsFromProblemSignalSource(source);
    if (!rows.length) continue;
    sourcesWithRows.push({
      source: source.source,
      path: source.path,
      row_count: rows.length,
    });
    rows.forEach((row, index) => {
      const candidate = problemCandidateFromSignal(row, source, index, name, purpose);
      if (candidate) candidates.push(candidate);
    });
  }
  const deduped = [];
  const seen = new Set();
  for (const candidate of candidates.sort((a, b) => b.score - a.score)) {
    const key = lowerCompact(candidate.objective_title || candidate.title);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    deduped.push(candidate);
  }
  return {
    sources_checked: sources.length,
    sources_with_rows: sourcesWithRows,
    candidate_count: deduped.length,
    selected: deduped[0] ? {
      source: deduped[0].source,
      source_path: deduped[0].source_path,
      signal_index: deduped[0].signal_index,
      title: deduped[0].title,
      objective_title: deduped[0].objective_title,
      problem: deduped[0].problem,
      suggested_action: deduped[0].suggested_action,
      score: deduped[0].score,
      components: deduped[0].components,
      next_command: deduped[0].next_command,
      autonomous_action: deduped[0].autonomous_action || null,
      task_title: deduped[0].task_title || null,
      duplicate_task_ref: deduped[0].duplicate_task_ref || null,
      error_pattern: deduped[0].error_pattern || null,
      error_count: deduped[0].error_count || null,
      evidence_paths: deduped[0].evidence_paths || [],
    } : null,
    candidates: deduped.map((candidate) => ({
      source: candidate.source,
      title: candidate.title,
      objective_title: candidate.objective_title,
      problem: candidate.problem,
      suggested_action: candidate.suggested_action,
      score: candidate.score,
      components: candidate.components,
      next_command: candidate.next_command,
      autonomous_action: candidate.autonomous_action || null,
      task_title: candidate.task_title || null,
      duplicate_task_ref: candidate.duplicate_task_ref || null,
      error_pattern: candidate.error_pattern || null,
      error_count: candidate.error_count || null,
      evidence_paths: candidate.evidence_paths || [],
    })).slice(0, 12),
    log_error_scan: logErrorScan ? {
      ok: logErrorScan.ok === true,
      skipped: logErrorScan.skipped || null,
      script_path: displaySignalPath(logErrorScan.script_path),
      error: logErrorScan.error || null,
      threshold: logErrorScan.scan?.threshold || null,
      selected: logErrorScan.scan?.selected || null,
      scanned: logErrorScan.scan?.scanned || null,
    } : null,
  };
}

function collectWakeEvidence(name, goal = null, purpose = null) {
  const taskProjection = readTaskProjectionEvidence(name);
  const memberRoom = readMemberRoomEvidence(name);
  const receipt = readRecentWakeReceiptEvidence(name);
  const openLoopCandidates = sortEvidenceCandidates([
    ...(taskProjection.candidates || []),
    ...(memberRoom.candidates || []),
  ]);
  const nearest = openLoopCandidates[0] || null;
  return {
    task_projection: taskProjection,
    member_room: memberRoom,
    receipt,
    goal_files: goal ? readGoalFileEvidence(goal) : { path_count: 0, files_read: 0, files: [] },
    problem_discovery: goal && lowerCompact(name) !== 'signal-scout'
      ? { sources_checked: 0, sources_with_rows: [], candidate_count: 0, selected: null, candidates: [], log_error_scan: null }
      : collectProblemDiscoveryEvidence(name, purpose || {}),
    open_loop_candidates: openLoopCandidates.slice(0, 30),
    nearest_open_loop: nearest,
  };
}

function scoreKeywords(text, keywords) {
  const haystack = lowerCompact(text);
  return keywords.reduce((score, keyword) => score + (haystack.includes(keyword) ? 1 : 0), 0);
}

function strategicScore(text, goal = null, evidence = null) {
  const strategicKeywords = [
    'agi', 'autonomous', 'objective', 'world model', 'knowledge graph', 'meta',
    'causal', 'transfer', 'architecture', 'emergent', 'customer', 'revenue',
    'security', 'release', 'production', 'feedback', 'proof', 'strategy',
  ];
  const score = scoreKeywords(text, strategicKeywords);
  const goalText = compactSentence(`${goal?.title || ''} ${goal?.why || ''} ${(goal?.acceptance || []).join(' ')}`, 500).toLowerCase();
  const candidateWords = new Set(lowerCompact(text).split(/[^a-z0-9]+/).filter((word) => word.length >= 5));
  let overlap = 0;
  for (const word of candidateWords) {
    if (goalText.includes(word)) overlap += 1;
  }
  const fileBoost = evidence?.goal_files?.files_read ? 1 : 0;
  return Math.max(1, Math.min(5, score + Math.min(2, overlap) + fileBoost));
}

function noveltyScore(candidate, evidence = null) {
  const text = `${candidate?.title || ''} ${candidate?.reason || ''}`;
  let score = 2 + Math.min(3, scoreKeywords(text, ['new', 'novel', 'unknown', 'explore', 'experiment', 'discover', 'scan']));
  const recentDecision = evidence?.receipt?.latest_wake_decision || '';
  const recentReason = evidence?.receipt?.latest_wake_reason || '';
  if (candidate?.task_ref && recentReason.includes(candidate.task_ref)) score -= 1;
  if (candidate?.decision && candidate.decision === recentDecision) score -= 1;
  return Math.max(1, Math.min(5, score));
}

function recencyScore(value) {
  if (!value) return 1;
  const ms = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(ms)) return 1;
  const ageHours = Math.max(0, (Date.now() - ms) / (60 * 60 * 1000));
  if (ageHours <= 6) return 5;
  if (ageHours <= 24) return 4;
  if (ageHours <= 72) return 3;
  if (ageHours <= 168) return 2;
  return 1;
}

function scoreWakeCandidate(candidate, goal, evidence) {
  const urgencyByDecision = {
    ask: 5,
    report_proof: 4,
    close_loop: 3,
    create_missing_task: 3,
    tick: 1,
  };
  const proximityBySource = {
    steering: 5,
    task_projection: 5,
    member_room: 4,
    member_room_unlinked_request: 3,
    goal: 1,
  };
  const text = `${candidate.title || ''} ${candidate.ask || ''} ${candidate.reason || ''}`;
  const components = {
    urgency: urgencyByDecision[candidate.decision] || 1,
    strategic_value: strategicScore(text, goal, evidence),
    novelty: noveltyScore(candidate, evidence),
    loop_proximity: proximityBySource[candidate.source] || 1,
    recency: recencyScore(candidate.updated_at),
  };
  const score = (components.urgency * 30)
    + (components.strategic_value * 25)
    + (components.novelty * 15)
    + (components.loop_proximity * 10)
    + (components.recency * 5);
  return { ...candidate, score, components };
}

function scoredWakeCandidates(name, goal, evidence, directive = null) {
  const candidates = [];
  if (directive) {
    candidates.push({
      source: 'steering',
      decision: directive.decision,
      title: directive.note || `Steering directive for ${name}`,
      reason: `steering_directive:${directive.steering_id || 'unknown'}`,
      task_ref: Array.isArray(directive.task_refs) && directive.task_refs.length ? directive.task_refs[0] : null,
      ask: directive.decision === 'ask' ? directive.note || 'Needs operator direction.' : null,
      next_command: directive.next_command,
      updated_at: directive.created_at || null,
    });
  }
  for (const openLoop of evidence.open_loop_candidates || []) {
    const evidenceRef = openLoop.task_ref || 'missing_task';
    candidates.push({
      ...openLoop,
      reason: `nearest_open_loop:${openLoop.source}:${evidenceRef}`,
    });
  }
  if (goal) {
    candidates.push({
      source: 'goal',
      decision: 'tick',
      title: goal.title || `Next bounded step for ${name}`,
      reason: 'safe_next_bounded_step',
      task_ref: null,
      ask: null,
      next_command: `atris member tick ${name} --goal ${goal.id}`,
      updated_at: goal.updated_at || goal.created_at || null,
    });
  }
  const scored = candidates
    .map((candidate) => scoreWakeCandidate(candidate, goal, evidence))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return candidatePriority(b) - candidatePriority(a);
    });
  return {
    selected: scored[0] || null,
    candidates: scored.map((candidate) => ({
      source: candidate.source,
      decision: candidate.decision,
      reason: candidate.reason,
      task_ref: candidate.task_ref || null,
      title: candidate.title,
      score: candidate.score,
      components: candidate.components,
      next_command: candidate.next_command,
    })).slice(0, 12),
  };
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

function experimentIsClosed(experiment) {
  return ['accepted', 'discarded', 'superseded'].includes(String(experiment?.status || '').toLowerCase());
}

function supersedeOtherOpenExperiments(state, activeGoal, proof) {
  const superseded = [];
  for (const goal of state.goals || []) {
    if (goal === activeGoal || goal.id === activeGoal?.id) continue;
    for (const experiment of goal.experiments || []) {
      if (!['proposed', 'running'].includes(experiment.status)) continue;
      experiment.status = 'superseded';
      experiment.superseded_at = stampIso();
      experiment.proof = proof;
      experiment.lesson = 'Direction changed by score-derived goal evidence.';
      experiment.source = experiment.source || 'previous_goal';
      superseded.push({
        goal_id: goal.id,
        goal_title: goal.title,
        experiment_id: experiment.id,
        experiment_title: experiment.title,
      });
    }
  }
  return superseded;
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
  return `${lines.join('\n').trimEnd()}\n`;
}

function writeMemberGoals(paths, state) {
  state.updated_at = stampIso();
  fs.writeFileSync(paths.goalsJson, JSON.stringify(state, null, 2) + '\n', 'utf8');
  fs.writeFileSync(paths.goalsMd, renderMemberGoalsMarkdown(state), 'utf8');
}

function displaySignalPath(filePath) {
  if (!filePath) return '';
  const rel = path.relative(process.cwd(), filePath);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel;
  return filePath;
}

function seedAutonomousProblemGoal(name, paths, state, candidate, purpose) {
  const title = candidate.objective_title || candidate.title || 'Investigate discovered problem';
  const id = makeGoalId(title);
  const existing = state.goals.find((goal) => goal.id === id || lowerCompact(goal.title) === lowerCompact(title));
  const sourcePath = displaySignalPath(candidate.source_path);
  const goal = existing || {
    id,
    title,
    status: 'active',
    cadence: 'manual',
    why: `Autonomous problem discovery selected ${candidate.source}: ${candidate.problem || candidate.suggested_action || title}`,
    acceptance: [
      `Use discovery evidence from ${sourcePath || candidate.source} before proposing work.`,
      `Prove one bounded improvement toward: ${candidate.suggested_action || title}.`,
      'Leave a receipt or task note; do not claim the full AGI bar is complete from this slice.',
    ],
    source: 'autonomous_problem_discovery',
    source_signal: {
      source: candidate.source,
      source_path: sourcePath || candidate.source_path || null,
      signal_index: candidate.signal_index ?? null,
      problem: candidate.problem || null,
      suggested_action: candidate.suggested_action || null,
      score: candidate.score || null,
      components: candidate.components || null,
    },
    mission_snapshot: {
      north_star: purpose?.northStar || null,
      runtime_id: purpose?.runtimeMission?.id || null,
    },
    created_at: stampIso(),
    experiments: [],
    history: [],
  };
  goal.status = 'active';
  goal.cadence = goal.cadence || 'manual';
  goal.history = Array.isArray(goal.history) ? goal.history : [];
  goal.history.push({
    at: stampIso(),
    event: existing ? 'autonomous_problem_goal_reused' : 'autonomous_problem_goal_created',
    source: candidate.source,
    source_path: sourcePath || candidate.source_path || null,
    score: candidate.score || null,
  });
  if (!existing) state.goals.push(goal);
  writeMemberGoals(paths, state);
  return { goal, state, existing: Boolean(existing) };
}

function createAutonomousDiscoveryTask(candidate) {
  const title = candidate.task_title || candidate.objective_title || candidate.title || 'Fix recurring error';
  if (candidate.duplicate_task_ref) {
    return {
      ok: true,
      existing: true,
      task_ref: candidate.duplicate_task_ref,
      command: `atris task show ${candidate.duplicate_task_ref} --json`,
      task: findProjectionTaskByRef(candidate.duplicate_task_ref) || null,
    };
  }
  const commandArgs = ['task', 'new', title, '--tag', 'auto-discovery', '--json'];
  const command = `atris task new ${shellQuote(title)} --tag auto-discovery`;
  try {
    const stdout = execFileSync(process.execPath, [path.join(__dirname, '..', 'bin', 'atris.js'), ...commandArgs], {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10000,
      env: process.env,
    });
    const parsed = JSON.parse(stdout || '{}');
    const task = parsed.task || null;
    return {
      ok: parsed.ok !== false,
      existing: false,
      command,
      task,
      task_id: parsed.task_id || task?.id || null,
      task_ref: taskRef(task) || parsed.task_id || null,
      raw: parsed,
    };
  } catch (error) {
    return {
      ok: false,
      existing: false,
      command,
      error: error instanceof Error ? error.message : String(error),
      stderr: error?.stderr ? compactSentence(String(error.stderr), 500) : null,
    };
  }
}

function writeAutonomousDiscoveryReceipt(name, candidate, taskResult) {
  const runsDir = path.join(process.cwd(), 'atris', 'runs');
  fs.mkdirSync(runsDir, { recursive: true });
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
  const receiptPath = path.join(runsDir, `signal-scout-autonomous-discovery-${fileSafeStamp()}.json`);
  fs.writeFileSync(receiptPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
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
    const expired = active && Number(active.expires_at_ms || 0) <= nowMs;
    const deadPid = active && !isPidAlive(active.pid);
    if (active && (expired || deadPid)) {
      fs.rmSync(paths.lockPath, { force: true });
      const result = writeLease();
      return {
        ...result,
        recovered_stale: true,
        stale_lease: active,
        stale_reason: expired ? 'expired' : 'dead_pid',
      };
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

function activeMemberLoopLease(lease) {
  if (!lease) return false;
  const expiresAt = Number(lease.expires_at_ms || 0);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return false;
  return isPidAlive(lease.pid);
}

function archiveMemberLoopState(name) {
  const paths = memberLoopPaths(name);
  const archivedAt = stampIso();
  const previousLease = readJsonIfExists(paths.lockPath);
  const activeLease = activeMemberLoopLease(previousLease);
  fs.mkdirSync(paths.stateDir, { recursive: true });
  if (activeLease) {
    writeJsonFile(paths.stopPath, {
      schema: 'atris.member_loop_stop.v1',
      member: name,
      requested_at: archivedAt,
      pid: process.pid,
      reason: 'member_archived',
    });
  } else {
    fs.rmSync(paths.lockPath, { force: true });
    fs.rmSync(paths.stopPath, { force: true });
  }
  const payload = {
    schema: 'atris.member_loop_archived.v1',
    action: 'loop_archived',
    member: name,
    status: 'archived',
    reason: 'member_archived',
    archived_at: archivedAt,
    active_lease_requested_stop: Boolean(activeLease),
    stale_lease_removed: Boolean(previousLease && !activeLease),
    previous_lease: previousLease || null,
    lock_path: paths.lockPath,
    stop_path: paths.stopPath,
    latest_path: paths.latestPath,
  };
  writeJsonFile(paths.latestPath, payload);
  return payload;
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
  console.log(`${members.length} ${members.length === 1 ? 'member' : 'members'} found.`);
}

// --- CREATE subcommand ---

function printMemberCreateUsage(stream = console.log) {
  stream('Usage: atris member create <name> [--role="Title"] [--description="..."] [--push]');
}

async function memberCreate(name, ...flags) {
  if (name === '--help' || name === '-h' || flags.includes('--help') || flags.includes('-h')) {
    printMemberCreateUsage();
    return;
  }
  if (!name || String(name).startsWith('-')) {
    printMemberCreateUsage(console.error);
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
  const loopState = archiveMemberLoopState(name);
  appendMemberLifecycleLog(memberDir, name, 'archived', 'Archived by atris member archive');
  fs.mkdirSync(archiveRoot, { recursive: true });
  fs.renameSync(memberDir, archiveDir);
  console.log(`Archived atris/team/${name} -> ${path.relative(process.cwd(), archiveDir)}`);
  console.log(`Loop state: ${path.relative(process.cwd(), loopState.latest_path)}`);
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
  const goalId = makeGoalId(title);
  const goal = existing || {
    id: uniqueGoalId(state, goalId),
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
  state.goals = [goal, ...state.goals.filter((item) => item !== goal)];
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

function memberGoalFromScore(name, ...args) {
  const paths = requireMemberDir(name);
  const asJson = hasFlag(args, '--json');
  const force = hasFlag(args, '--force');
  const cadence = readFlag(args, '--cadence', 'manual') || 'manual';
  const scoreJsonPath = readFlag(args, '--score-json', readFlag(args, '--score', ''));
  const purpose = missionPurpose(paths);
  if (!purpose.meaningful) {
    const ask = `Define atris/team/${name}/MISSION.md with a concrete North Star before this member creates a score-derived goal.`;
    const logPath = appendMemberGoalLog(paths.memberDir, name, 'Member goal-from-score blocked', {
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

  const loaded = loadTeamScoreEvidence(scoreJsonPath);
  if (!loaded.ok) {
    console.error(`Could not load Team score evidence: ${loaded.error || 'unknown error'}`);
    process.exit(1);
  }
  const scoreEvidence = normalizeTeamScoreEvidence(loaded.parsed, loaded.source);
  if (!scoreEvidence) {
    console.error('Team score evidence must include score.nextMove plus a weakest dimension.');
    process.exit(1);
  }

  const state = loadMemberGoals(name, paths);
  const title = compactSentence(scoreEvidence.next_move, 120);
  const goalId = makeGoalId(title);
  const existing = state.goals.find((goal) => (
    goal.source === 'team_score'
    && goal.status === 'active'
    && (
      goal.id === goalId
      || goal.team_score?.next_move === scoreEvidence.next_move
      || goal.title.toLowerCase() === title.toLowerCase()
    )
  ));
  const acceptance = [
    `One bounded experiment targets the score-selected next move: ${scoreEvidence.drill || scoreEvidence.next_move}`,
    `The goal records weakest dimension ${scoreEvidence.weakest.label} and latest reward receipt ${latestRewardLine(scoreEvidence.latest_reward)}.`,
    scoreEvidence.target_member
      ? `Target member: ${scoreEvidence.target_member.label || scoreEvidence.target_member.slug}${scoreEvidence.target_member.weakest_attribute?.label ? `; weakest attribute: ${scoreEvidence.target_member.weakest_attribute.label}` : ''}.`
      : 'Target member is recorded when the score packet provides one.',
    'Review proof or ask the human before replacing this with another score-derived goal.',
  ];
  const goal = existing || {
    id: goalId,
    title,
    status: 'active',
    cadence,
    why: compactSentence(`Team Overall ${scoreEvidence.overall == null ? 'score' : scoreEvidence.overall} selected this from proof: ${scoreEvidence.next_move}`, 240),
    acceptance,
    source: 'team_score',
    mission_file: path.relative(process.cwd(), paths.missionFile),
    mission_north_star: purpose.northStar,
    team_score: scoreEvidence,
    created_at: stampIso(),
    experiments: [],
    history: [],
  };
  goal.status = 'active';
  goal.cadence = cadence || goal.cadence || 'manual';
  goal.source = 'team_score';
  goal.why = compactSentence(`Team Overall ${scoreEvidence.overall == null ? 'score' : scoreEvidence.overall} selected this from proof: ${scoreEvidence.next_move}`, 240);
  goal.acceptance = acceptance;
  goal.mission_file = path.relative(process.cwd(), paths.missionFile);
  goal.mission_north_star = purpose.northStar;
  goal.team_score = scoreEvidence;
  goal.history = Array.isArray(goal.history) ? goal.history : [];
  goal.history.push({
    at: stampIso(),
    event: existing ? 'goal_from_score_reused' : 'goal_from_score_created',
    score_source: scoreEvidence.source,
    weakest_dimension: scoreEvidence.weakest.label,
    latest_reward_ref: scoreEvidence.latest_reward?.ref || null,
  });
  if (!existing) state.goals.push(goal);
  state.goals = [goal, ...state.goals.filter((item) => item !== goal)];
  const supersedeProof = `Score-derived goal selected ${scoreEvidence.next_move}; superseding older open experiments so the member can change direction.`;
  const supersededExperiments = supersedeOtherOpenExperiments(state, goal, supersedeProof);
  writeMemberGoals(paths, state);
  const logPath = appendMemberGoalLog(paths.memberDir, name, existing ? 'Member goal reused from Team score' : 'Member goal created from Team score', {
    goal: goal.title,
    score: scoreEvidence.overall == null ? '' : scoreEvidence.overall,
    weakest: `${scoreEvidence.weakest.label}${scoreEvidence.weakest.score == null ? '' : ` ${scoreEvidence.weakest.score}`}`,
    latest_reward: latestRewardLine(scoreEvidence.latest_reward),
    superseded: supersededExperiments.map((item) => item.experiment_id).join(', '),
    source: scoreEvidence.source,
    next: `atris member tick ${name} --goal ${goal.id}`,
  });
  printJsonOrText(
    {
      ok: true,
      action: existing ? 'goal_from_score_reused' : 'goal_from_score_created',
      member: name,
      goal,
      score: scoreEvidence,
      superseded_experiments: supersededExperiments,
      goals_path: paths.goalsJson,
      goals_md_path: paths.goalsMd,
      log_path: logPath,
      next_command: `atris member tick ${name} --goal ${goal.id}`,
    },
    [
      `${existing ? 'Reused' : 'Created'} score-derived goal for ${name}: ${goal.title}`,
      `Weakest: ${scoreEvidence.weakest.label}${scoreEvidence.weakest.score == null ? '' : ` ${scoreEvidence.weakest.score}`}`,
      `Latest reward: ${latestRewardLine(scoreEvidence.latest_reward)}`,
      `Next: atris member tick ${name} --goal ${goal.id}`,
    ],
    asJson,
  );
}

function fallbackProposalForGoal(goal, context = {}) {
  const criteria = Array.isArray(goal.acceptance) && goal.acceptance.length
    ? goal.acceptance[0]
    : 'Return proof, risk, and next move.';
  const scoreEvidence = goal.team_score || null;
  const target = scoreEvidence?.target_member || null;
  const drill = scoreEvidence?.drill || null;
  const fileEvidence = context?.evidence?.goal_files || context?.goal_files || null;
  const primaryFile = (fileEvidence?.files || []).find((file) => file.exists && file.excerpt) || null;
  const fileInstruction = primaryFile
    ? `Use ${primaryFile.path} evidence to produce one receipt-backed bounded proof step for: ${goal.title}`
    : '';
  const title = drill && target
    ? `Run ${target.label || target.slug} drill: ${compactSentence(drill, 96)}`
    : drill
      ? `Run score drill: ${compactSentence(drill, 108)}`
      : primaryFile
        ? `Use ${primaryFile.path}: ${compactSentence(goal.title, 88)}`
        : `Run next proof step for ${goal.title}`;
  const nextStep = drill
    ? drill
    : fileInstruction
      ? fileInstruction
    : goal.source === 'mission'
      ? `Use ${goal.mission_file || 'MISSION.md'} to produce one receipt-backed bounded proof step for: ${goal.title}`
      : criteria;
  return {
    id: makeExperimentId(goal.id, title),
    title,
    status: 'proposed',
    proof_target: drill ? `Concrete drill: ${drill}` : criteria,
    next_step: nextStep,
    target_member: target || null,
    verifier: scoreEvidence?.verifier || null,
    stop_rule: 'Stop if proof is missing, risk is unclear, or the next move would require new authority.',
    created_at: stampIso(),
    generation: {
      mode: 'fallback',
      source: primaryFile ? 'goal_file_evidence' : 'goal_rules',
    },
  };
}

function proposalPromptForGoal(goal, context = {}) {
  const files = (context?.evidence?.goal_files?.files || [])
    .filter((file) => file.exists && file.excerpt)
    .slice(0, 4)
    .map((file) => ({
      path: file.path,
      excerpt: compactSentence(file.excerpt, 1200),
    }));
  const payload = {
    goal: {
      id: goal.id || null,
      title: goal.title || null,
      source: goal.source || null,
      why: goal.why || null,
      acceptance: Array.isArray(goal.acceptance) ? goal.acceptance.slice(0, 8) : [],
      mission_file: goal.mission_file || null,
      mission_north_star: goal.mission_north_star || null,
      team_score: goal.team_score || null,
    },
    wake_decision: context?.decision || null,
    evidence: {
      latest_receipt: context?.evidence?.receipt || null,
      selected_wake_candidate: context?.evidence?.selected_wake_candidate || null,
      wake_candidate_scores: context?.evidence?.wake_candidate_scores || [],
      files,
    },
  };
  return [
    'You generate the next bounded Atris member experiment.',
    'Read the JSON context and return only JSON with keys: title, proof_target, next_step, verifier, stop_rule.',
    'The next_step must be adaptive to the goal/evidence, concrete, receipt-backed, and safe for one bounded tick.',
    'Do not ask for human input unless authority is missing. Do not copy generic templates.',
    '',
    JSON.stringify(payload, null, 2),
  ].join('\n');
}

function parseJsonObjectFromText(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    try {
      return JSON.parse(raw.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

function normalizeLlmProposal(raw, fallback, goal = null) {
  if (!raw || typeof raw !== 'object') return null;
  const title = compactSentence(raw.title || '', 140);
  const proofTarget = compactSentence(raw.proof_target || raw.proofTarget || '', 220);
  const nextStep = compactSentence(raw.next_step || raw.nextStep || '', 360);
  if (!title || !proofTarget || !nextStep) return null;
  return {
    ...fallback,
    id: makeExperimentId(goal?.id || fallback.id || '', title),
    title,
    proof_target: proofTarget,
    next_step: nextStep,
    verifier: compactSentence(raw.verifier || fallback.verifier || '', 180) || null,
    stop_rule: compactSentence(raw.stop_rule || raw.stopRule || fallback.stop_rule, 220),
  };
}

function injectedLlmProposal() {
  if (!process.env.ATRIS_MEMBER_PROPOSAL_LLM_JSON) return null;
  const parsed = parseJsonObjectFromText(process.env.ATRIS_MEMBER_PROPOSAL_LLM_JSON);
  return parsed ? { source: 'env_json', proposal: parsed } : { source: 'env_json', error: 'invalid_json' };
}

async function callAtris2ProposalLlm(goal, context = {}) {
  const injected = injectedLlmProposal();
  if (injected) return injected;
  if (process.env.ATRIS_MEMBER_PROPOSAL_LLM !== '1') return null;
  try {
    const { postTurn } = require('../ax');
    const output = { isTTY: false, write() { return true; } };
    const result = await postTurn(proposalPromptForGoal(goal, context), {
      mode: process.env.ATRIS_MEMBER_PROPOSAL_LLM_MODE || 'fast',
      route: 'local',
      cwd: process.cwd(),
      output,
      color: false,
    });
    const parsed = parseJsonObjectFromText(result?.output || '');
    return parsed
      ? { source: 'atris2_backend', proposal: parsed }
      : { source: 'atris2_backend', error: 'missing_json_response' };
  } catch (error) {
    return {
      source: 'atris2_backend',
      error: compactSentence(error instanceof Error ? error.message : String(error), 220),
    };
  }
}

async function proposalForGoal(goal, context = {}) {
  const fallback = fallbackProposalForGoal(goal, context);
  const llm = await callAtris2ProposalLlm(goal, context);
  const normalized = normalizeLlmProposal(llm?.proposal, fallback, goal);
  if (!normalized) {
    return {
      ...fallback,
      generation: {
        ...fallback.generation,
        llm_source: llm?.source || null,
        llm_error: llm?.error || null,
      },
    };
  }
  return {
    ...normalized,
    generation: {
      mode: 'llm',
      source: llm.source,
      fallback_title: fallback.title,
    },
  };
}

function wikiMinerGraphPath(root = process.cwd()) {
  return path.join(root, 'atris', 'wiki', '.graph.json');
}

function emptyWikiGraph() {
  return {
    schema: 'atris.wiki_graph.v1',
    updated_at: null,
    entities: [],
    relationships: [],
  };
}

function readWikiGraph(root = process.cwd()) {
  const graphPath = wikiMinerGraphPath(root);
  if (!fs.existsSync(graphPath)) return emptyWikiGraph();
  try {
    const parsed = JSON.parse(fs.readFileSync(graphPath, 'utf8'));
    return {
      ...emptyWikiGraph(),
      ...parsed,
      entities: Array.isArray(parsed.entities) ? parsed.entities : [],
      relationships: Array.isArray(parsed.relationships) ? parsed.relationships : [],
    };
  } catch {
    return emptyWikiGraph();
  }
}

function listWikiMarkdownPages(root = process.cwd(), limit = 10) {
  const wikiDir = path.join(root, 'atris', 'wiki');
  const out = [];
  function walk(dir) {
    if (!fs.existsSync(dir) || out.length >= limit) return;
    for (const entry of fs.readdirSync(dir).sort()) {
      if (out.length >= limit) break;
      const full = path.join(dir, entry);
      let stat;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        if (!entry.startsWith('.')) walk(full);
      } else if (stat.isFile() && entry.endsWith('.md')) {
        out.push(full);
      }
    }
  }
  walk(wikiDir);
  return out;
}

function wikiMinerPrompt(pageContent) {
  return `Extract entities and relationships from this wiki page. Return JSON:
{
  "entities": [{"type": "person|system|concept", "name": "..."}],
  "relationships": [{"from": "...", "to": "...", "type": "uses|depends-on|owns"}]
}

Wiki content:
${pageContent}`;
}

function normalizeWikiMinerExtraction(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const allowedEntityTypes = new Set(['person', 'system', 'concept']);
  const allowedRelationTypes = new Set(['uses', 'depends-on', 'owns']);
  const entities = (Array.isArray(raw.entities) ? raw.entities : [])
    .map((entity) => ({
      type: allowedEntityTypes.has(String(entity?.type || '').toLowerCase()) ? String(entity.type).toLowerCase() : 'concept',
      name: compactSentence(entity?.name || '', 120),
    }))
    .filter((entity) => entity.name);
  const relationships = (Array.isArray(raw.relationships) ? raw.relationships : [])
    .map((relationship) => ({
      from: compactSentence(relationship?.from || '', 120),
      to: compactSentence(relationship?.to || '', 120),
      type: allowedRelationTypes.has(String(relationship?.type || '').toLowerCase()) ? String(relationship.type).toLowerCase() : 'uses',
    }))
    .filter((relationship) => relationship.from && relationship.to);
  return { entities, relationships };
}

function heuristicWikiMinerExtraction(pagePath, pageContent) {
  const title = compactSentence((String(pageContent).match(/^#\s+(.+)$/m) || [])[1] || path.basename(pagePath, '.md'), 120);
  const candidates = new Set();
  const patterns = [
    /\b[A-Z][A-Za-z0-9]+(?:\s+[A-Z][A-Za-z0-9]+){0,3}\b/g,
    /\b[a-z][a-z0-9]+(?:-[a-z0-9]+)+\b/g,
    /`([^`\n]{2,80})`/g,
  ];
  for (const pattern of patterns) {
    let match = pattern.exec(pageContent);
    while (match) {
      const value = compactSentence(match[1] || match[0], 80);
      if (value && !/^the|this|that|wiki|mission$/i.test(value)) candidates.add(value);
      match = pattern.exec(pageContent);
    }
  }
  const entities = [{ type: 'concept', name: title }];
  for (const name of [...candidates].slice(0, 12)) entities.push({ type: /agent|api|sdk|cli|hub|system/i.test(name) ? 'system' : 'concept', name });
  const relationships = [...candidates].slice(0, 12).map((name) => ({ from: title, to: name, type: 'uses' }));
  return { entities, relationships };
}

function injectedWikiMinerExtraction(pageIndex) {
  if (!process.env.ATRIS_WIKI_MINER_LLM_JSON) return null;
  const parsed = parseJsonObjectFromText(process.env.ATRIS_WIKI_MINER_LLM_JSON);
  if (!parsed) return { source: 'env_json', error: 'invalid_json' };
  const payload = Array.isArray(parsed.pages) ? parsed.pages[pageIndex] : parsed;
  return payload ? { source: 'env_json', extraction: payload } : { source: 'env_json', error: 'missing_page_payload' };
}

async function callWikiMinerLlm(pagePath, pageContent, pageIndex) {
  const injected = injectedWikiMinerExtraction(pageIndex);
  if (injected) return injected;
  if (process.env.ATRIS_WIKI_MINER_LLM !== '1') return null;
  try {
    const { postTurn } = require('../ax');
    const output = { isTTY: false, write() { return true; } };
    const result = await postTurn(wikiMinerPrompt(pageContent), {
      mode: process.env.ATRIS_WIKI_MINER_LLM_MODE || 'fast',
      route: 'local',
      cwd: process.cwd(),
      output,
      color: false,
    });
    const parsed = parseJsonObjectFromText(result?.output || '');
    return parsed
      ? { source: 'atris2_backend', extraction: parsed }
      : { source: 'atris2_backend', error: 'missing_json_response' };
  } catch (error) {
    return {
      source: 'atris2_backend',
      error: compactSentence(error instanceof Error ? error.message : String(error), 220),
    };
  }
}

function mergeWikiGraph(graph, extraction, sourcePath) {
  const entityMap = new Map();
  for (const entity of graph.entities || []) {
    const key = `${String(entity.type || 'concept').toLowerCase()}:${lowerCompact(entity.name)}`;
    entityMap.set(key, { ...entity, sources: Array.isArray(entity.sources) ? entity.sources : [] });
  }
  for (const entity of extraction.entities || []) {
    const key = `${entity.type}:${lowerCompact(entity.name)}`;
    const existing = entityMap.get(key) || { type: entity.type, name: entity.name, sources: [] };
    if (sourcePath && !existing.sources.includes(sourcePath)) existing.sources.push(sourcePath);
    entityMap.set(key, existing);
  }

  const relationshipMap = new Map();
  for (const relationship of graph.relationships || []) {
    const key = `${lowerCompact(relationship.from)}|${String(relationship.type || 'uses').toLowerCase()}|${lowerCompact(relationship.to)}`;
    relationshipMap.set(key, { ...relationship, sources: Array.isArray(relationship.sources) ? relationship.sources : [] });
  }
  for (const relationship of extraction.relationships || []) {
    const key = `${lowerCompact(relationship.from)}|${relationship.type}|${lowerCompact(relationship.to)}`;
    const existing = relationshipMap.get(key) || { from: relationship.from, to: relationship.to, type: relationship.type, sources: [] };
    if (sourcePath && !existing.sources.includes(sourcePath)) existing.sources.push(sourcePath);
    relationshipMap.set(key, existing);
  }

  return {
    schema: 'atris.wiki_graph.v1',
    updated_at: stampIso(),
    entities: [...entityMap.values()].sort((a, b) => `${a.type}:${a.name}`.localeCompare(`${b.type}:${b.name}`)),
    relationships: [...relationshipMap.values()].sort((a, b) => `${a.from}|${a.type}|${a.to}`.localeCompare(`${b.from}|${b.type}|${b.to}`)),
  };
}

async function runWikiMinerWake(name, paths, { execute = false } = {}) {
  const mode = execute ? 'execute' : 'dry_run';
  const root = process.cwd();
  const pages = listWikiMarkdownPages(root, 10);
  let graph = readWikiGraph(root);
  const pageReceipts = [];
  let llmSuccessfulPages = 0;

  for (let index = 0; index < pages.length; index += 1) {
    const pagePath = pages[index];
    const relativePath = path.relative(root, pagePath);
    let pageContent = '';
    try {
      pageContent = fs.readFileSync(pagePath, 'utf8').slice(0, 12000);
    } catch (error) {
      pageReceipts.push({ path: relativePath, ok: false, error: error instanceof Error ? error.message : String(error) });
      continue;
    }
    const llm = await callWikiMinerLlm(pagePath, pageContent, index);
    let extraction = normalizeWikiMinerExtraction(llm?.extraction);
    let modeUsed = llm?.source || null;
    let error = llm?.error || null;
    if (!extraction && !llm?.error) {
      extraction = heuristicWikiMinerExtraction(pagePath, pageContent);
      modeUsed = 'heuristic';
    }
    if (!extraction) {
      pageReceipts.push({ path: relativePath, ok: false, llm_source: llm?.source || null, error: error || 'invalid_json' });
      continue;
    }
    if (llm?.source) llmSuccessfulPages += 1;
    pageReceipts.push({
      path: relativePath,
      ok: true,
      mode: modeUsed,
      llm_source: llm?.source || null,
      entity_count: extraction.entities.length,
      relationship_count: extraction.relationships.length,
      error,
    });
    if (execute) graph = mergeWikiGraph(graph, extraction, relativePath);
  }

  const graphPath = wikiMinerGraphPath(root);
  if (execute) {
    fs.mkdirSync(path.dirname(graphPath), { recursive: true });
    fs.writeFileSync(graphPath, JSON.stringify(graph, null, 2) + '\n', 'utf8');
  }

  const runsDir = path.join(root, 'atris', 'runs');
  fs.mkdirSync(runsDir, { recursive: true });
  const receiptPath = path.join(runsDir, `wiki-miner-tick-${fileSafeStamp()}.json`);
  const receipt = {
    schema: 'atris.wiki_miner_tick.v1',
    created_at: stampIso(),
    member: name,
    mode,
    executed: execute,
    ok: true,
    pages_scanned: pages.length,
    pages_succeeded: pageReceipts.filter((page) => page.ok).length,
    pages_failed: pageReceipts.filter((page) => !page.ok).length,
    llm_successful_pages: llmSuccessfulPages,
    graph_path: path.relative(root, graphPath),
    entity_count: graph.entities.length,
    relationship_count: graph.relationships.length,
    pages: pageReceipts,
  };
  fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n', 'utf8');
  const logPath = appendMemberGoalLog(paths.memberDir, name, 'Wiki miner tick', {
    mode,
    pages: pages.length,
    succeeded: receipt.pages_succeeded,
    failed: receipt.pages_failed,
    graph: receipt.graph_path,
    receipt: path.relative(root, receiptPath),
  });

  return {
    ok: true,
    action: 'wake',
    member: name,
    mode,
    decision: 'wiki_mine',
    reason: execute ? 'wiki_graph_extracted' : 'wiki_graph_dry_run',
    executed: execute,
    needs_user: false,
    ask: null,
    next_command: `atris wiki related <entity>`,
    receipt_path: receiptPath,
    log_path: logPath,
    graph_path: graphPath,
    wiki_miner: receipt,
  };
}

function readMemberScope(name, paths) {
  const scope = [`atris/team/${name}/`];
  if (paths?.memberFile && fs.existsSync(paths.memberFile)) {
    try {
      const fm = parseFrontmatter(fs.readFileSync(paths.memberFile, 'utf8'));
      if (fm && Array.isArray(fm.scope)) {
        for (const p of fm.scope) {
          if (typeof p === 'string' && p.trim()) scope.push(p.trim());
        }
      }
    } catch { /* ignore — fall through with default scope */ }
  }
  return scope;
}

// Auto-generated artifacts that wake/tick produce as side-effects. Dirty here is expected
// and must not gate the next wake — otherwise the loop deadlocks on its own log writes.
function isAutoGeneratedArtifact(filePath, name) {
  const memberLogs = `atris/team/${name}/logs/`;
  if (filePath.startsWith(memberLogs)) return true;
  if (filePath === `atris/team/${name}/now.md`) return true;
  return false;
}

function porcelainPath(line) {
  // git status --porcelain entries are "XY path" or "XY old -> new"; we want the post-rename path.
  const trimmed = String(line || '').slice(3);
  const arrow = trimmed.indexOf(' -> ');
  return arrow >= 0 ? trimmed.slice(arrow + 4) : trimmed;
}

function workspaceSnapshot(name = null, paths = null) {
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
    const memberScope = name ? readMemberScope(name, paths) : [];
    const dirtyInScope = memberScope.length
      ? porcelain.filter((line) => {
          const p = porcelainPath(line);
          if (name && isAutoGeneratedArtifact(p, name)) return false;
          return memberScope.some((s) => p.startsWith(s));
        })
      : [];
    return {
      kind: 'git',
      root,
      clean: porcelain.length === 0,
      // Member-scoped clean: dirty files outside the member's scope don't block this member's loop.
      // Only files inside scope (the member's own lane) gate the wake decision.
      clean_for_member: dirtyInScope.length === 0,
      member_scope: memberScope,
      dirty_count: porcelain.length,
      dirty_count_in_scope: dirtyInScope.length,
      dirty_sample: porcelain.slice(0, 8),
      dirty_in_scope_sample: dirtyInScope.slice(0, 8),
    };
  } catch {
    return {
      kind: 'none',
      clean: true,
      clean_for_member: true,
      member_scope: [],
      dirty_count: 0,
      dirty_count_in_scope: 0,
      dirty_sample: [],
      dirty_in_scope_sample: [],
    };
  }
}

function wakeDecision(name, paths, { force = false } = {}) {
  const purpose = missionPurpose(paths);
  const steering = readSteeringMemory(paths, name);
  const state = loadMemberGoals(name, paths);
  const goal = activeGoal(state);
  const current = memberOpenExperiment(state);
  const rawDirective = steeringWakeDirective(steering, name, goal);
  const directiveClosure = rawDirective ? steeringDirectiveClosure(rawDirective) : null;
  const directive = directiveClosure?.all_closed ? null : rawDirective;
  const evidence = collectWakeEvidence(name, goal, purpose);
  evidence.steering_directive_closure = directiveClosure;
  const blocked = allExperiments(state)
    .map(({ goal: experimentGoal, experiment }) => ({ ...experiment, goal_id: experimentGoal.id, goal_title: experimentGoal.title }))
    .filter((experiment) => experiment.status === 'blocked')
    .sort((a, b) => String(b.blocked_at || b.created_at || '').localeCompare(String(a.blocked_at || a.created_at || '')))[0] || null;
  const workspace = workspaceSnapshot(name, paths);
  const checks = {
    has_member: true,
    has_mission: Boolean(purpose.missionText),
    mission_meaningful: purpose.meaningful,
    has_goal: Boolean(goal),
    has_open_experiment: Boolean(current),
    has_blocked_experiment: Boolean(blocked),
    has_steering: steering.length > 0,
    has_steering_directive: Boolean(directive),
    has_satisfied_steering_directive: Boolean(directiveClosure?.all_closed),
    has_open_loop_evidence: Boolean(evidence.nearest_open_loop),
    open_loop_source: evidence.nearest_open_loop?.source || null,
    has_member_room_evidence: Number(evidence.member_room?.candidate_count || 0) > 0,
    has_autonomous_problem_candidate: Boolean(evidence.problem_discovery?.selected),
    autonomous_problem_source: evidence.problem_discovery?.selected?.source || null,
    has_recent_receipt: Boolean(evidence.receipt?.latest_wake_receipt_path),
    workspace_clean: workspace.clean,
    workspace_clean_for_member: workspace.clean_for_member,
  };
  const wakeScores = scoredWakeCandidates(name, goal, evidence, directive);
  evidence.wake_candidate_scores = wakeScores.candidates;
  evidence.selected_wake_candidate = wakeScores.selected ? {
    source: wakeScores.selected.source,
    decision: wakeScores.selected.decision,
    reason: wakeScores.selected.reason,
    task_ref: wakeScores.selected.task_ref || null,
    title: wakeScores.selected.title,
    score: wakeScores.selected.score,
    components: wakeScores.selected.components,
    next_command: wakeScores.selected.next_command,
  } : null;

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
      evidence,
      workspace,
    };
  }

  const discoveredTask = evidence.problem_discovery?.selected || null;
  if (discoveredTask?.source === 'log_error_scan' && discoveredTask.autonomous_action === 'create_task') {
    return {
      decision: 'create_task',
      reason: 'autonomous_error_discovery:log_error_scan',
      needs_user: false,
      ask: null,
      next_command: discoveredTask.next_command,
      state,
      goal: goal || null,
      current_experiment: current || null,
      autonomous_problem: discoveredTask,
      checks,
      mission: {
        north_star: purpose.northStar,
        runtime_id: purpose.runtimeMission.id || null,
        runtime_status: purpose.runtimeMission.status || null,
        runtime_next: purpose.runtimeMission.next || null,
      },
      steering,
      evidence,
      workspace,
    };
  }

  if (!goal) {
    const discoveredProblem = evidence.problem_discovery?.selected || null;
    if (discoveredProblem) {
      return {
        decision: 'set_objective',
        reason: `autonomous_problem_discovery:${discoveredProblem.source}`,
        needs_user: false,
        ask: null,
        next_command: discoveredProblem.next_command || `atris member wake ${name} --execute --confirm-autonomy-policy`,
        state,
        goal: null,
        current_experiment: null,
        autonomous_problem: discoveredProblem,
        checks,
        mission: {
          north_star: purpose.northStar,
          runtime_id: purpose.runtimeMission.id || null,
          runtime_status: purpose.runtimeMission.status || null,
          runtime_next: purpose.runtimeMission.next || null,
        },
        steering,
        evidence,
        workspace,
      };
    }
    return {
      decision: 'stop',
      reason: 'no_active_goal',
      needs_user: false,
      ask: null,
      next_command: `atris member goal-from-mission ${name}`,
      state,
      goal: null,
      current_experiment: null,
      autonomous_problem: null,
      checks,
      mission: {
        north_star: purpose.northStar,
        runtime_id: purpose.runtimeMission.id || null,
        runtime_status: purpose.runtimeMission.status || null,
        runtime_next: purpose.runtimeMission.next || null,
      },
      steering,
      evidence,
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
      evidence,
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
      evidence,
      workspace,
    };
  }

  if (wakeScores.selected && wakeScores.selected.decision !== 'tick') {
    const selected = wakeScores.selected;
    const needsUser = selected.decision === 'ask';
    return {
      decision: selected.decision,
      reason: selected.reason,
      needs_user: needsUser,
      ask: needsUser ? (selected.ask || `Need operator input for ${selected.title}.`) : null,
      next_command: selected.next_command,
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
      evidence,
      workspace,
    };
  }

  if (!workspace.clean_for_member && !force) {
    return {
      decision: 'wait',
      reason: 'workspace_dirty_in_member_scope',
      needs_user: false,
      ask: null,
      next_command: `commit/stash files in atris/team/${name}/ (or member scope) — or rerun: atris member wake ${name} --force`,
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
      evidence,
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
    evidence,
    workspace,
  };
}

async function runMemberWake(name, { execute = false, confirmed = false, force = false } = {}) {
  const paths = requireMemberDir(name);
  if (lowerCompact(name) === 'wiki-miner') {
    return runWikiMinerWake(name, paths, { execute });
  }
  const planned = wakeDecision(name, paths, { force });
  const mode = execute ? 'execute' : 'dry_run';
  let decision = planned.decision;
  let reason = planned.reason;
  let executed = false;
  let experiment = null;
  let state = planned.state;
  let goal = planned.goal;
  let nextCommand = planned.next_command;
  let autonomousProblem = planned.autonomous_problem || null;
  let seededGoal = null;
  let createdTask = null;
  let autonomousDiscoveryReceipt = null;
  const now = stampIso();

  if (execute && !confirmed) {
    decision = 'stop';
    reason = 'execute_requires_confirm_autonomy_policy';
    nextCommand = `atris member wake ${name} --execute --confirm-autonomy-policy`;
  } else if (execute && planned.decision === 'create_task' && autonomousProblem) {
    const taskResult = createAutonomousDiscoveryTask(autonomousProblem);
    createdTask = taskResult.task || null;
    autonomousDiscoveryReceipt = writeAutonomousDiscoveryReceipt(name, autonomousProblem, taskResult);
    executed = taskResult.ok === true;
    decision = taskResult.ok ? 'create_task' : 'stop';
    reason = taskResult.ok
      ? taskResult.existing ? 'autonomous_error_task_exists' : 'autonomous_error_task_created'
      : 'autonomous_error_task_create_failed';
    nextCommand = taskResult.task_ref
      ? `atris task show ${taskResult.task_ref} --json`
      : (autonomousProblem.next_command || nextCommand);
  } else if (execute && planned.decision === 'set_objective' && autonomousProblem) {
    const seeded = seedAutonomousProblemGoal(name, paths, state, autonomousProblem, planned.mission);
    state = seeded.state;
    goal = seeded.goal;
    seededGoal = seeded.goal;
    executed = true;
    decision = 'tick';
    reason = seeded.existing ? 'autonomous_objective_reused' : 'autonomous_objective_seeded';
    nextCommand = `atris member tick ${name} --goal ${goal.id}`;
  } else if (execute && planned.decision === 'tick' && goal) {
    goal.experiments = Array.isArray(goal.experiments) ? goal.experiments : [];
    experiment = await proposalForGoal(goal, {
      decision: planned,
      evidence: planned.evidence,
      mission: planned.mission,
    });
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
    evidence: planned.evidence,
    checks: planned.checks,
    workspace: planned.workspace,
    autonomous_problem: autonomousProblem,
    created_task: createdTask ? {
      id: createdTask.id || null,
      display_id: createdTask.display_id || null,
      legacy_ref: createdTask.legacy_ref || null,
      title: createdTask.title || null,
      tag: createdTask.tag || null,
      status: createdTask.status || null,
    } : null,
    autonomous_discovery_receipt: autonomousDiscoveryReceipt?.payload || null,
    autonomous_discovery_receipt_path: autonomousDiscoveryReceipt?.receipt_path || null,
    autonomous_discovery_project_log_path: autonomousDiscoveryReceipt?.project_log_path || null,
    active_goal: goal ? {
      id: goal.id,
      title: goal.title,
      source: goal.source || null,
      mission_id: goal.mission_id || null,
    } : null,
    current_experiment: experiment || planned.current_experiment || null,
  };
  const receiptPath = writeWakeReceipt(name, receiptPayload);
  const logTitle = experiment
    ? 'Member wake executed tick'
    : seededGoal
      ? 'Member wake seeded objective'
      : 'Member wake decision';
  const logPath = appendMemberGoalLog(paths.memberDir, name, logTitle, {
    decision,
    reason,
    mode,
    goal: goal?.title || '',
    experiment: (experiment || planned.current_experiment)?.title || '',
    problem: autonomousProblem?.problem || '',
    task: createdTask ? taskRef(createdTask) : '',
    discovery_receipt: autonomousDiscoveryReceipt?.receipt_path ? path.relative(process.cwd(), autonomousDiscoveryReceipt.receipt_path) : '',
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
    evidence: planned.evidence,
    checks: planned.checks,
    workspace: planned.workspace,
    autonomous_problem: autonomousProblem,
    created_task: receiptPayload.created_task,
    autonomous_discovery_receipt: autonomousDiscoveryReceipt?.payload || null,
    autonomous_discovery_receipt_path: autonomousDiscoveryReceipt?.receipt_path || null,
    autonomous_discovery_project_log_path: autonomousDiscoveryReceipt?.project_log_path || null,
    active_goal: receiptPayload.active_goal,
    current_experiment: receiptPayload.current_experiment,
    receipt_path: receiptPath,
    log_path: logPath,
  };
}

async function memberWake(name, ...args) {
  const asJson = hasFlag(args, '--json');
  const execute = hasFlag(args, '--execute') && !hasFlag(args, '--dry-run');
  const confirmed = hasFlag(args, '--confirm-autonomy-policy');
  const force = hasFlag(args, '--force');
  const result = await runMemberWake(name, { execute, confirmed, force });
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

function memberAlive(name, ...args) {
  const nextArgs = args.includes('--alive') ? args : [...args, '--alive'];
  return memberLoop(name, ...nextArgs);
}

async function memberLoop(name, ...args) {
  requireMemberDir(name);
  const asJson = hasFlag(args, '--json');
  const aliveMode = hasFlag(args, '--alive');
  const execute = hasFlag(args, '--execute');
  const confirmed = hasFlag(args, '--confirm-autonomy-policy');
  const force = hasFlag(args, '--force');
  const stop = hasFlag(args, '--stop');
  const status = hasFlag(args, '--status');
  const operateMaxWall = Math.max(60, Math.min(1800, Number(readNumberFlag(args, '--operate-max-wall', readNumberFlag(args, '--max-wall', 900)))));
  const autoAcceptLimit = Math.max(1, Math.floor(Number(readNumberFlag(args, '--auto-accept-limit', 8))));
  const paths = memberLoopPaths(name);
  fs.mkdirSync(paths.stateDir, { recursive: true });

  if (status) {
    const active = readJsonIfExists(paths.lockPath);
    const latest = readJsonIfExists(paths.latestPath);
    const payload = {
      ok: true,
      action: 'loop_status',
      member: name,
      active: Boolean(active && Number(active.expires_at_ms || 0) > Date.now() && isPidAlive(active.pid)),
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
        if (aliveMode) {
          const alive = runAliveTick(name, {
            execute,
            confirmed,
            force,
            maxWallSeconds: operateMaxWall,
            autoAcceptLimit,
            noPrime: index > 0,
          });
          const key = `${alive.status || 'alive'}:${alive.reason || 'tick'}`;
          decisions[key] = (decisions[key] || 0) + 1;
          const tick = {
            tick: index + 1,
            started_at: tickStartedAt,
            finished_at: alive.finished_at || stampIso(),
            ok: alive.ok !== false,
            decision: alive.status || 'alive_tick',
            reason: alive.reason || null,
            executed: execute,
            needs_user: alive.needs_user === true,
            next_command: alive.next_command || null,
            has_mission: alive.has_mission === true,
            has_goal: alive.has_goal === true,
            has_steering: false,
            operate_ok: alive.operate?.ok,
            auto_accept_accepted: alive.auto_accept?.json?.summary?.accepted ?? alive.auto_accept?.json?.summary?.would_accept,
            receipt_path: alive.receipt_path || alive.operate?.receipt_path || null,
            alive,
          };
          tickResults.push(tick);
          fs.appendFileSync(tickLogPath, JSON.stringify(tick) + '\n', 'utf8');
        } else {
        const wake = await runMemberWake(name, { execute, confirmed, force });
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
        }
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
    action: aliveMode ? 'alive' : 'loop',
    schema: aliveMode ? 'atris.member_alive.v1' : 'atris.member_loop.v1',
    member: name,
    alive: aliveMode,
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
    `${aliveMode ? 'Alive' : 'Loop'}: ${name}`,
    `Status: ${payload.status}`,
    `Ticks: ${payload.ticks}/${payload.ticks_requested}`,
    `Decisions: ${Object.entries(decisions).map(([key, count]) => `${key} x${count}`).join(', ') || 'none'}`,
    `Receipt: ${path.relative(process.cwd(), receiptPath)}`,
  ], asJson);
}

async function memberTick(name, ...args) {
  const paths = requireMemberDir(name);
  const asJson = hasFlag(args, '--json');
  const force = hasFlag(args, '--force');
  const goalId = readFlag(args, '--goal', '');
  const state = loadMemberGoals(name, paths);
  const goal = activeGoal(state, goalId);
  const evidence = collectWakeEvidence(name, goal);
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
    experiment = await proposalForGoal(goal, { evidence });
    goal.experiments.push(experiment);
  }
  goal.history = Array.isArray(goal.history) ? goal.history : [];
  goal.history.push({ at: stampIso(), event: reused ? 'tick_reused_proposal' : 'tick_proposed_experiment', experiment_id: experiment.id });
  writeMemberGoals(paths, state);
  const logPath = appendMemberGoalLog(paths.memberDir, name, reused ? 'Member tick reused proposal' : 'Member tick proposed experiment', {
    goal: goal.title,
    experiment: experiment.title,
    proof_target: experiment.proof_target,
    next_step: experiment.next_step || '',
    verifier: experiment.verifier || '',
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
  if (experimentIsClosed(experiment)) {
    console.error(`Experiment "${experimentId}" is already ${experiment.status}; closed member experiments cannot be reviewed again.`);
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
  if (experimentIsClosed(experiment)) {
    console.error(`Experiment "${experimentId}" is already ${experiment.status}; closed member experiments cannot be blocked.`);
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

async function memberCommand(subcommand, ...args) {
  // Subcommands that take a member name as args[0] otherwise treat `--help` as
  // a name and error with "Member '--help' not found". `create`/`new` handle
  // help themselves (with subcommand-specific usage) — leave those alone.
  const HELP_AWARE_SUBCOMMANDS = new Set(['create', 'new']);
  if (!HELP_AWARE_SUBCOMMANDS.has(subcommand) && (args[0] === '-h' || args[0] === '--help')) {
    subcommand = undefined;
  }
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
    case 'goal-from-score':
    case 'score-goal':
      return memberGoalFromScore(args[0], ...args.slice(1));
    case 'tick':
      return memberTick(args[0], ...args.slice(1));
    case 'wake':
      return memberWake(args[0], ...args.slice(1));
    case 'run':
      return memberRun(args[0], ...args.slice(1));
    case 'loop':
      return memberLoop(args[0], ...args.slice(1));
    case 'alive':
      return memberAlive(args[0], ...args.slice(1));
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
      console.log('  goal-from-score <name>    Create/reuse an active goal from Team score evidence');
      console.log('  wake <name>         Read Mission state and decide tick/wait/ask/stop');
      console.log("  run <name>          Run the member's active Mission Runtime");
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
      console.log('  atris member goal-from-score growth --score-json team-score.json --json');
      console.log('  atris member wake growth --json');
      console.log('  atris member run growth --max-ticks 1 --max-wall 900 --json');
      console.log('  atris member wake growth --execute --confirm-autonomy-policy');
      console.log('  atris member loop growth --minutes 10 --interval 60 --json');
      console.log('  atris member alive growth --minutes 480 --interval 900 --execute --confirm-autonomy-policy --json');
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
