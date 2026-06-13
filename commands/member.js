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
  const resolved = resolveMemberRuntime(name);
  const paths = resolved.paths;
  if (!fs.existsSync(paths.memberFile)) {
    const aliasHint = resolved.aliasOf ? ` or atris/team/${resolved.aliasOf}/MEMBER.md` : '';
    console.error(`Member "${name}" not found at atris/team/${name}/MEMBER.md${aliasHint}`);
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

function collectProblemDiscoveryEvidence(name, purpose, runtimeKind = memberRuntimeKind(name)) {
  const candidates = [];
  const sources = problemSignalSources();
  const sourcesWithRows = [];
  const logErrorScan = runtimeKind === 'signal-scout' ? runLogErrorScan() : null;
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

function collectWakeEvidence(name, goal = null, purpose = null, runtimeKind = memberRuntimeKind(name)) {
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
    problem_discovery: goal && runtimeKind !== 'signal-scout'
      ? { sources_checked: 0, sources_with_rows: [], candidate_count: 0, selected: null, candidates: [], log_error_scan: null }
      : collectProblemDiscoveryEvidence(name, purpose || {}, runtimeKind),
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

function safeReadText(filePath, maxBytes = 250000) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > maxBytes) return '';
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function safeReadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function repoRelative(root, filePath) {
  return path.relative(root, filePath).replace(/\\/g, '/');
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

function stripAutoImproverTitleNoise(text) {
  let clean = String(text || '').replace(/\s+/g, ' ').trim();
  for (let i = 0; i < 6; i += 1) {
    const next = clean
      .replace(/^auto[- ]improver:\s*/i, '')
      .replace(/^recurring log pattern:\s*/i, '')
      .replace(/^candidate:\s*/i, '')
      .trim();
    if (next === clean) break;
    clean = next;
  }
  return compactSentence(clean, 180);
}

function isAutoImproverGeneratedLogLine(line) {
  const text = String(line || '').trim();
  if (!text) return false;
  if (/\bauto[- ]improver\b/i.test(text) && /\b(dogfood|receipt|prevented|pain_)\b/i.test(text)) return true;
  if (/\bauto_improver\b/i.test(text)) return true;
  if (/^-\s*candidate:\s*/i.test(text)) return true;
  if (/recurring log pattern:\s*(candidate:|recurring log pattern:)/i.test(text)) return true;
  return false;
}

function normalizeFailurePattern(line) {
  return stripAutoImproverTitleNoise(String(line || '')
    .replace(/^\s*[-*]\s*/, '')
    .replace(/\b\d{4}-\d{2}-\d{2}[T ][^\s]+/g, '<timestamp>')
    .replace(/[0-9a-f]{10,}/gi, '<hash>')
    .replace(/\b\d+\b/g, '#')
    .trim());
}

function collectAutoImproverLogSignals(root) {
  const roots = [
    path.join(root, 'atris', 'logs'),
    path.join(root, 'atris', 'team'),
    path.join(root, 'atris', 'wiki'),
  ].filter((candidate) => fs.existsSync(candidate));
  const failureRegex = /\b(error|failed|failure|blocked|timeout|regression|crash|missing proof|naraka|suffering)\b/i;
  const unclearRegex = /\b(tbd|unclear|unknown|needs user|needs owner|needs proof|no next|blocked)\b/i;
  const counts = new Map();
  let filesScanned = 0;
  let linesScanned = 0;
  let unclearNextActions = 0;
  for (const scanRoot of roots) {
    for (const filePath of listFilesBounded(scanRoot)) {
      const relative = repoRelative(root, filePath);
      if (relative.startsWith('atris/logs/archive/')) continue;
      const isRuntimeLog = relative.startsWith('atris/logs/')
        || /^atris\/team\/[^/]+\/logs\//.test(relative)
        || /^atris\/team\/[^/]+\/goals\.(md|json)$/.test(relative)
        || relative === 'atris/wiki/log.md';
      if (!isRuntimeLog) continue;
      const text = safeReadText(filePath);
      if (!text) continue;
      filesScanned += 1;
      const lines = text.split(/\r?\n/).slice(-500);
      linesScanned += lines.length;
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        if (isAutoImproverGeneratedLogLine(line)) continue;
        // Declared verification receipts ("check: <command> ...") describe what
        // was verified, not what broke. Wiki upkeep sweeps write one per page,
        // so counting them as failures spawns bogus recurring-pattern tasks
        // (CLI-199 came from 13 such lines in atris/wiki/log.md).
        if (/^\s*[-*]?\s*check:\s/i.test(line)) continue;
        if (/\b(errors?|fail(?:ed|ures?)|blocked|timeouts?)\s*:\s*0\b/i.test(line)) continue;
        if (unclearRegex.test(line)) unclearNextActions += 1;
        if (!failureRegex.test(line)) continue;
        const pattern = normalizeFailurePattern(line);
        if (!pattern) continue;
        const existing = counts.get(pattern) || { pattern, count: 0, evidence: [] };
        existing.count += 1;
        if (existing.evidence.length < 5) {
          existing.evidence.push({
            path: repoRelative(root, filePath),
            line: index + 1,
            text: compactSentence(line, 180),
          });
        }
        counts.set(pattern, existing);
      }
    }
  }
  const repeated = [...counts.values()]
    .filter((item) => item.count >= 2)
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);
  return {
    files_scanned: filesScanned,
    lines_scanned: linesScanned,
    repeated_failures: repeated,
    repeated_failure_count: repeated.length,
    unclear_next_action_count: unclearNextActions,
  };
}

function autoImproverTaskWaitingForHuman(task, status) {
  if (status !== 'review') return false;
  const metadata = task?.metadata || {};
  const review = task?.review || {};
  const certified = metadata.agent_certified === true || review.agent_certified === true;
  const approval = lowerCompact(review.approval_status || metadata.approval_status || task?.approval_status || '');
  return certified && (!approval || approval === 'pending' || approval === 'agent_certified');
}

function collectAutoImproverTaskSignals(root) {
  const projectionPath = path.join(root, '.atris', 'state', 'tasks.projection.json');
  const projection = safeReadJson(projectionPath);
  const tasks = Array.isArray(projection?.tasks) ? projection.tasks : [];
  const openStatuses = new Set(['open', 'todo', 'claimed', 'doing', 'in_progress', 'review', 'blocked']);
  const staleTasks = [];
  const blockedTasks = [];
  const reviewTasks = [];
  const unclearTasks = [];
  for (const task of tasks) {
    const status = lowerCompact(task.status || task.state || '');
    const title = task.title || task.name || task.objective || '';
    const sample = {
      ref: taskRef(task),
      title: compactSentence(title, 140),
      status: status || null,
      owner: task.claimed_by || task.assigned_to || task.owner || task.metadata?.assigned_to || null,
    };
    const waitingForHuman = autoImproverTaskWaitingForHuman(task, status);
    if (status === 'blocked') blockedTasks.push(sample);
    if (status === 'review') reviewTasks.push(sample);
    if (openStatuses.has(status) && !waitingForHuman) staleTasks.push(sample);
    if (!waitingForHuman && /\b(tbd|unclear|unknown|needs proof|needs owner|blocked|stale|no next)\b/i.test(`${title} ${task.notes || ''}`)) {
      unclearTasks.push(sample);
    }
  }

  const todoPath = path.join(root, 'atris', 'TODO.md');
  const todoText = safeReadText(todoPath, 500000);
  const todoLines = todoText ? todoText.split(/\r?\n/) : [];
  const todoSignalLines = todoLines
    .filter((line) => /\b(TODO|CLAIMED|DOING|IN_PROGRESS|REVIEW|BLOCKED|stale|proof|next)\b/i.test(line))
    .slice(0, 40)
    .map((line) => compactSentence(line, 160));

  return {
    projection_path: fs.existsSync(projectionPath) ? repoRelative(root, projectionPath) : null,
    todo_path: fs.existsSync(todoPath) ? repoRelative(root, todoPath) : null,
    task_count: tasks.length,
    stale_tasks: staleTasks.slice(0, 12),
    stale_task_count: staleTasks.length || todoSignalLines.length,
    blocked_tasks: blockedTasks.slice(0, 8),
    blocked_task_count: blockedTasks.length,
    review_tasks: reviewTasks.slice(0, 8),
    review_task_count: reviewTasks.length,
    unclear_tasks: unclearTasks.slice(0, 8),
    unclear_task_count: unclearTasks.length,
    todo_signal_lines: todoSignalLines,
  };
}

function collectGitStatusSignals(root) {
  try {
    const stdout = execFileSync('git', ['status', '--short'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    });
    const lines = stdout.split(/\r?\n/).filter(Boolean);
    return {
      is_git_repo: true,
      dirty_file_count: lines.length,
      sample: lines.slice(0, 20),
    };
  } catch {
    return { is_git_repo: false, dirty_file_count: 0, sample: [] };
  }
}

function extractRsiRouterPaths(routerText) {
  const paths = [];
  const regex = /@router\.(?:get|post|put|delete|patch)\(["']([^"']+)["']/g;
  let match = regex.exec(routerText);
  while (match) {
    paths.push(match[1]);
    match = regex.exec(routerText);
  }
  return paths;
}

function collectRepoContractChecks(root) {
  const autoImproverMember = path.join(root, 'atris', 'team', 'auto-improver', 'MEMBER.md');
  const memberJs = path.join(root, 'commands', 'member.js');
  const memberJsText = fs.existsSync(memberJs) ? safeReadText(memberJs, 900000) : '';
  const missingAliases = memberJsText
    ? Object.keys(MEMBER_RUNTIME_ALIASES).filter((alias) => !memberJsText.includes(alias))
    : [];
  const rsiRouter = path.join(root, 'backend', 'routers', 'rsi_router.py');
  const rsiService = path.join(root, 'backend', 'services', 'rsi_service.py');
  const routerText = safeReadText(rsiRouter, 300000);
  const serviceText = safeReadText(rsiService, 500000);
  const rsiChecked = fs.existsSync(rsiRouter) || fs.existsSync(rsiService);
  return {
    auto_improver_member: {
      checked: true,
      present: fs.existsSync(autoImproverMember),
      path: repoRelative(root, autoImproverMember),
    },
    member_aliases: {
      checked: fs.existsSync(memberJs),
      path: fs.existsSync(memberJs) ? repoRelative(root, memberJs) : null,
      aliases: MEMBER_RUNTIME_ALIASES,
      missing_aliases: missingAliases,
      complete: fs.existsSync(memberJs) && missingAliases.length === 0,
    },
    auto_improver_runtime: {
      checked: fs.existsSync(memberJs),
      present: memberJsText.includes('auto_improver_dogfood'),
      path: fs.existsSync(memberJs) ? repoRelative(root, memberJs) : null,
    },
    rsi_api: {
      checked: rsiChecked,
      router_path: fs.existsSync(rsiRouter) ? repoRelative(root, rsiRouter) : null,
      service_path: fs.existsSync(rsiService) ? repoRelative(root, rsiService) : null,
      exposed_paths: routerText ? extractRsiRouterPaths(routerText) : [],
      improve_endpoint_present: /["']\/improve["']/.test(routerText),
      auth_dependency_present: routerText.includes('authenticate_request'),
      usage_tracking_signal_present: /\b(usage|billing|credit|meter|track)\b/i.test(`${routerText}\n${serviceText}`),
    },
  };
}

function collectRepoContractGaps(root, checks = collectRepoContractChecks(root)) {
  const gaps = [];
  if (!checks.auto_improver_member.present) {
    gaps.push({
      id: 'auto_improver_member_missing',
      severity: 'high',
      title: 'Auto-improver member is not installed in this repo',
      evidence: ['atris/team/auto-improver/MEMBER.md missing'],
      recommendation: 'Install the auto-improver member so scans have an owner and log path.',
    });
  }

  if (checks.member_aliases.checked) {
    if (checks.member_aliases.missing_aliases.length) {
      gaps.push({
        id: 'simple_member_aliases_missing',
        severity: 'medium',
        title: 'Simple member aliases are not fully wired',
        evidence: checks.member_aliases.missing_aliases.map((alias) => `${alias} missing from commands/member.js`),
        recommendation: 'Wire simple aliases to their runtime member behavior before moving users to simple names.',
      });
    }
    if (!checks.auto_improver_runtime.present) {
      gaps.push({
        id: 'auto_improver_runtime_missing',
        severity: 'high',
        title: 'Auto-improver has docs but no executable dogfood scan',
        evidence: ['commands/member.js lacks auto_improver_dogfood receipt path'],
        recommendation: 'Add an executable wake path that writes scan receipts.',
      });
    }
  }

  if (checks.rsi_api.checked) {
    if (!checks.rsi_api.improve_endpoint_present) {
      gaps.push({
        id: 'rsi_improve_endpoint_missing',
        severity: 'high',
        title: 'RSI plan names /api/rsi/improve but backend exposes tick/run/status/history',
        evidence: ['backend/routers/rsi_router.py has no POST /api/rsi/improve'],
        recommendation: 'Either add /api/rsi/improve or update client/member instructions to call /api/rsi/tick.',
      });
    }
    if (!checks.rsi_api.auth_dependency_present) {
      gaps.push({
        id: 'rsi_auth_missing',
        severity: 'critical',
        title: 'RSI router is missing request authentication',
        evidence: ['authenticate_request not found in backend/routers/rsi_router.py'],
        recommendation: 'Gate RSI endpoints behind the existing API auth dependency.',
      });
    }
    if (!checks.rsi_api.usage_tracking_signal_present) {
      gaps.push({
        id: 'rsi_usage_tracking_missing',
        severity: 'high',
        title: 'RSI API has no obvious usage/billing meter in router or service',
        evidence: ['No usage, billing, credit, meter, or tracking term found in RSI router/service'],
        recommendation: 'Add explicit usage tracking before selling RSI API usage.',
      });
    }
  }
  return gaps;
}

function severityWeight(severity) {
  return { critical: 5, high: 4, medium: 2, low: 1 }[severity] || 1;
}

function collectAutoImproverScan(root = process.cwd()) {
  const logSignals = collectAutoImproverLogSignals(root);
  const taskSignals = collectAutoImproverTaskSignals(root);
  const gitSignals = collectGitStatusSignals(root);
  const contractChecks = collectRepoContractChecks(root);
  const contractGaps = collectRepoContractGaps(root, contractChecks);
  const findings = [];

  for (const gap of contractGaps) {
    findings.push({
      source: 'contract_gap',
      severity: gap.severity,
      title: gap.title,
      problem: gap.title,
      recommendation: gap.recommendation,
      evidence: gap.evidence,
      score: severityWeight(gap.severity) * 10,
    });
  }
  for (const failure of logSignals.repeated_failures) {
    findings.push({
      source: 'repeated_failure',
      severity: failure.count >= 5 ? 'high' : 'medium',
      title: `Recurring log pattern: ${stripAutoImproverTitleNoise(failure.pattern)}`,
      problem: `The same failure-like line appeared ${failure.count} times.`,
      recommendation: 'Create a bounded fix task before this pattern turns into a larger support/debug loop.',
      evidence: failure.evidence,
      score: Math.min(40, failure.count * 5),
    });
  }
  if (taskSignals.blocked_task_count > 0) {
    findings.push({
      source: 'task_truth',
      severity: 'high',
      title: `${taskSignals.blocked_task_count} blocked task(s) need an owner or unblocker`,
      problem: 'Blocked work is accumulating in task truth.',
      recommendation: 'Assign one unblock action with proof expected.',
      evidence: taskSignals.blocked_tasks,
      score: 35,
    });
  } else if (taskSignals.stale_task_count > 12) {
    findings.push({
      source: 'task_truth',
      severity: 'medium',
      title: `${taskSignals.stale_task_count} open task signal(s) need pruning or next actions`,
      problem: 'Open task signals are high enough to hide the next useful action.',
      recommendation: 'Close, merge, or re-scope the top stale tasks before adding more work.',
      evidence: taskSignals.stale_tasks.length ? taskSignals.stale_tasks : taskSignals.todo_signal_lines.slice(0, 8),
      score: 22,
    });
  }
  if (taskSignals.unclear_task_count + logSignals.unclear_next_action_count > 10) {
    findings.push({
      source: 'unclear_next_actions',
      severity: 'medium',
      title: 'Unclear next-action language is accumulating',
      problem: 'Several logs or tasks mention blocked/unclear/proof-needed states without a crisp next move.',
      recommendation: 'Convert the highest-value unclear item into one task with owner, proof, and stop rule.',
      evidence: taskSignals.unclear_tasks.length ? taskSignals.unclear_tasks : logSignals.repeated_failures.slice(0, 3),
      score: 18,
    });
  }
  if (gitSignals.dirty_file_count > 50) {
    findings.push({
      source: 'workspace_hygiene',
      severity: 'medium',
      title: `${gitSignals.dirty_file_count} dirty git entries make broad autonomous edits risky`,
      problem: 'Large dirty worktrees increase the chance of overwriting user work or losing attribution.',
      recommendation: 'Keep auto-improver changes receipt-only until scoped tasks isolate the touched files.',
      evidence: gitSignals.sample,
      score: 20,
    });
  }

  findings.sort((a, b) => (b.score || 0) - (a.score || 0));
  const painScoreBefore = Math.min(100,
    (logSignals.repeated_failure_count * 8)
    + Math.min(24, taskSignals.stale_task_count)
    + (taskSignals.blocked_task_count * 5)
    + Math.min(16, taskSignals.unclear_task_count + logSignals.unclear_next_action_count)
    + Math.min(16, Math.floor(gitSignals.dirty_file_count / 5))
    + contractGaps.reduce((sum, gap) => sum + (severityWeight(gap.severity) * 3), 0));

  return {
    schema: 'atris.auto_improver_scan.v1',
    scanned_at: stampIso(),
    repo_root: root,
    repo_name: path.basename(root),
    metrics: {
      findings_count: findings.length,
      repeated_failure_count: logSignals.repeated_failure_count,
      stale_task_count: taskSignals.stale_task_count,
      blocked_task_count: taskSignals.blocked_task_count,
      unclear_next_action_count: taskSignals.unclear_task_count + logSignals.unclear_next_action_count,
      dirty_file_count: gitSignals.dirty_file_count,
      contract_gap_count: contractGaps.length,
      pain_score_before: painScoreBefore,
    },
    log_signals: logSignals,
    task_signals: taskSignals,
    git_signals: gitSignals,
    contract_checks: contractChecks,
    contract_gaps: contractGaps,
    findings: findings.slice(0, 12),
    prevented_fire_candidate: findings[0] || null,
  };
}

// Lifecycle filter for wake dedupe: a task that already crossed the review boundary
// (done/failed/archived, or human-accepted) must never be re-selected as the wake target —
// that loop produced an endless "existing_task_found OBL-1433" no-op spiral (OBL-1469).
const AUTO_IMPROVER_INACTIVE_STATUSES = new Set(['done', 'failed', 'archived']);

function autoImproverTaskIsActionable(task) {
  const status = String(task?.status || '').toLowerCase();
  if (AUTO_IMPROVER_INACTIVE_STATUSES.has(status)) return false;
  const approval = String(task?.metadata?.approval_status || task?.approval_status || '').toLowerCase();
  if (approval === 'accepted') return false;
  return true;
}

function findExistingAutoImproverTask(title) {
  const projection = safeReadJson(path.join(process.cwd(), '.atris', 'state', 'tasks.projection.json'));
  const tasks = Array.isArray(projection?.tasks) ? projection.tasks : [];
  const key = lowerCompact(stripAutoImproverTitleNoise(title));
  if (!key) return null;
  return tasks.find((task) => {
    if (!autoImproverTaskIsActionable(task)) return false;
    const taskTitle = lowerCompact(stripAutoImproverTitleNoise(task.title || ''));
    if (!taskTitle) return false;
    return taskTitle.includes(key) || key.includes(taskTitle);
  }) || null;
}

function autoImproverTaskTitle(candidate) {
  const core = stripAutoImproverTitleNoise(candidate?.title || 'Prevent top dogfood failure');
  return `Auto-improver: ${compactSentence(core, 92)}`;
}

function existingAutoImproverTaskForCandidate(candidate) {
  return findExistingAutoImproverTask(autoImproverTaskTitle(candidate));
}

function createAutoImproverTask(candidate, receiptPath) {
  const title = autoImproverTaskTitle(candidate);
  const existing = findExistingAutoImproverTask(title);
  if (existing) {
    return {
      ok: true,
      existing: true,
      task_ref: taskRef(existing),
      task: existing,
      command: `atris task show ${taskRef(existing)} --json`,
    };
  }
  const commandArgs = [
    'task',
    'new',
    title,
    '--tag',
    'auto-improver',
    '--json',
  ];
  const command = `atris task new ${shellQuote(title)} --tag auto-improver`;
  try {
    const stdout = execFileSync(process.execPath, [path.join(__dirname, '..', 'bin', 'atris.js'), ...commandArgs], {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10000,
      env: {
        ...process.env,
        ATRIS_SKIP_UPDATE_CHECK: '1',
        ATRIS_AUTO_IMPROVER_RECEIPT: receiptPath || '',
      },
    });
    const parsed = JSON.parse(stdout || '{}');
    const task = parsed.task || null;
    return {
      ok: parsed.ok !== false,
      existing: false,
      task,
      task_id: parsed.task_id || task?.id || null,
      task_ref: taskRef(task) || parsed.task_id || null,
      command,
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

function writeAutoImproverReceipt(name, payload, receiptPath = null) {
  const finalReceiptPath = receiptPath || path.join(process.cwd(), 'atris', 'runs', `auto-improver-dogfood-${fileSafeStamp()}.json`);
  writeJsonFile(finalReceiptPath, payload);
  const latestPath = path.join(process.cwd(), '.atris', 'state', 'auto-improver-dogfood-latest.json');
  writeJsonFile(latestPath, { ...payload, receipt_path: finalReceiptPath });
  return { receiptPath: finalReceiptPath, latestPath };
}

async function runAutoImproverWake(name, paths, { execute = false, confirmed = false } = {}) {
  const scan = collectAutoImproverScan(process.cwd());
  const mode = execute ? 'execute' : 'dry_run';
  const candidate = scan.prevented_fire_candidate;
  const existingTask = candidate ? existingAutoImproverTaskForCandidate(candidate) : null;
  let createdTask = existingTask ? {
    ok: true,
    existing: true,
    task_ref: taskRef(existingTask),
    task: existingTask,
    command: `atris task show ${taskRef(existingTask)} --json`,
  } : null;
  let decision = candidate ? (existingTask ? 'existing_task_found' : 'scan_found_problem') : 'scan_clean';
  let reason = candidate ? (existingTask ? 'auto_improver_task_already_exists' : `top_candidate:${candidate.source}`) : 'no_prevented_fire_candidate';
  let nextCommand = candidate
    ? (existingTask ? createdTask.command : `atris member wake ${name} --execute --confirm-autonomy-policy --json`)
    : `atris member wake ${name} --json`;

  let payload = {
    schema: 'atris.auto_improver_dogfood.v1',
    created_at: stampIso(),
    member: name,
    runtime_member: paths.storageName || name,
    mode,
    executed: execute,
    task_creation_requested: execute && confirmed,
    scan,
    created_task: null,
    pain: {
      before: scan.metrics.pain_score_before,
      after: scan.metrics.pain_score_before,
      delta: 0,
    },
    proof: {
      found_problems: scan.metrics.findings_count,
      prevented_suffering: 0,
      improved_things: 0,
      ready_for_marko: false,
      reason: 'Dogfood requires at least one bounded prevented-fire task before promotion.',
    },
  };
  const plannedReceiptPath = path.join(process.cwd(), 'atris', 'runs', `auto-improver-dogfood-${fileSafeStamp()}.json`);
  if (candidate && execute && confirmed) {
    createdTask = createAutoImproverTask(candidate, repoRelative(process.cwd(), plannedReceiptPath));
    if (createdTask.ok) {
      decision = createdTask.existing ? 'existing_task_found' : 'task_created';
      reason = createdTask.existing ? 'auto_improver_task_already_exists' : 'auto_improver_task_created';
      nextCommand = createdTask.task_ref ? `atris task show ${createdTask.task_ref} --json` : 'atris task list';
    } else {
      decision = 'task_create_failed';
      reason = 'auto_improver_task_create_failed';
      nextCommand = createdTask.command || nextCommand;
    }
  }

  const prevented = createdTask?.ok ? 1 : 0;
  const improvement = prevented ? Math.min(15, Math.max(3, severityWeight(candidate?.severity) * 3)) : 0;
  payload = {
    ...payload,
    decision,
    reason,
    next_command: nextCommand,
    created_task: createdTask ? {
      ok: createdTask.ok,
      existing: createdTask.existing,
      task_ref: createdTask.task_ref || null,
      task_id: createdTask.task_id || createdTask.task?.id || null,
      title: createdTask.task?.title || null,
      command: createdTask.command || null,
      error: createdTask.error || null,
    } : null,
    pain: {
      before: scan.metrics.pain_score_before,
      after: Math.max(0, scan.metrics.pain_score_before - improvement),
      delta: improvement,
    },
    proof: {
      found_problems: scan.metrics.findings_count,
      prevented_suffering: prevented,
      improved_things: prevented,
      ready_for_marko: prevented > 0 && scan.metrics.findings_count > 0,
      reason: prevented
        ? 'A top prevented-fire candidate has a bounded task and receipt.'
        : 'No bounded prevented-fire task was created yet.',
    },
  };
  const previousLatest = safeReadJson(path.join(process.cwd(), '.atris', 'state', 'auto-improver-dogfood-latest.json'));
  const finalWrite = writeAutoImproverReceipt(name, payload, plannedReceiptPath);
  // A no-op scan identical to the previous tick earns a receipt but not a journal entry —
  // the cadence loop was appending the same "found: N, prevented: 0" row every ~4 minutes
  // and flooding the daily log (2026-06-10 had 100+ identical entries).
  const createdNewTask = Boolean(payload.created_task) && payload.created_task.existing === false;
  const duplicateNoop = Boolean(previousLatest)
    && !createdNewTask
    && previousLatest.decision === decision
    && previousLatest.proof?.found_problems === payload.proof.found_problems
    && previousLatest.pain?.before === payload.pain.before
    && (previousLatest.created_task?.task_ref || null) === (payload.created_task?.task_ref || null);
  let logPath = null;
  let memberLogPath = null;
  if (!duplicateNoop) {
    logPath = appendProjectLog('Auto-improver dogfood scan', {
      member: name,
      mode,
      found: payload.proof.found_problems,
      prevented: payload.proof.prevented_suffering,
      pain_before: payload.pain.before,
      pain_after: payload.pain.after,
      candidate: candidate ? stripAutoImproverTitleNoise(candidate.title) : '',
      task: payload.created_task?.task_ref || '',
      receipt: repoRelative(process.cwd(), finalWrite.receiptPath),
    });
    memberLogPath = appendMemberGoalLog(paths.memberDir, name, 'Auto-improver dogfood scan', {
      mode,
      found: payload.proof.found_problems,
      prevented: payload.proof.prevented_suffering,
      pain_before: payload.pain.before,
      pain_after: payload.pain.after,
      receipt: repoRelative(process.cwd(), finalWrite.receiptPath),
      next: nextCommand,
    });
  }

  return {
    ok: true,
    action: 'wake',
    member: name,
    runtime_member: paths.storageName || name,
    mode,
    decision,
    reason,
    executed: execute,
    needs_user: false,
    ask: null,
    next_command: nextCommand,
    auto_improver: payload,
    receipt_path: finalWrite.receiptPath,
    latest_path: finalWrite.latestPath,
    log_path: logPath,
    member_log_path: memberLogPath,
    journal_skipped: duplicateNoop ? 'duplicate_noop' : null,
    created_task: payload.created_task,
  };
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
  if (lowerCompact(runtime.status || '') === 'blocked') {
    const ask = runtime.next
      ? `${compactSentence(runtimeFocus, 120)} is blocked. ${compactSentence(runtime.next, 180)}`
      : `Mission ${runtime.id || compactSentence(runtimeFocus, 88)} is blocked. Human should unblock or revise before this member reuses its goal.`;
    const logPath = appendMemberGoalLog(paths.memberDir, name, 'Member goal-from-mission blocked', {
      ask,
      mission_id: runtime.id || '',
      mission_status: runtime.status || 'blocked',
      next: runtime.next || '',
    });
    printJsonOrText(
      {
        ok: true,
        action: 'needs_user',
        member: name,
        needs_user: true,
        ask,
        mission: {
          north_star: purpose.northStar,
          runtime_id: runtime.id || null,
          runtime_status: runtime.status || null,
          runtime_next: runtime.next || null,
        },
        mission_file: paths.missionFile,
        log_path: logPath,
      },
      [
        `Blocked for ${name}: active mission is blocked.`,
        `Ask: ${ask}`,
      ],
      asJson,
    );
    return;
  }
  // The title IS the mission focus — no boilerplate prefix; the acceptance list already
  // says "one bounded step" and the why carries the full sentence.
  const title = compactSentence(runtimeFocus, 96);
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
  // Refresh the title on reuse so older bloated/truncated titles self-heal on the next tick.
  goal.title = title;
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
  // Don't restate the goal title inside the experiment — the experiment lives under the goal.
  const title = drill && target
    ? `Run ${target.label || target.slug} drill: ${compactSentence(drill, 96)}`
    : drill
      ? `Run score drill: ${compactSentence(drill, 108)}`
      : `Next proof step: ${compactSentence(goal.title, 96)}`;
  const nextStep = drill
    ? drill
    : primaryFile
      ? `Read ${primaryFile.path} and take one receipt-backed step toward the goal.`
    : goal.source === 'mission'
      ? `Read ${goal.mission_file || 'MISSION.md'} and take one receipt-backed step toward the goal.`
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
    causal_patterns: [],
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
      causal_patterns: Array.isArray(parsed.causal_patterns) ? parsed.causal_patterns : [],
    };
  } catch {
    return emptyWikiGraph();
  }
}

function readCausalPatterns(root = process.cwd()) {
  const causalPath = path.join(root, 'atris', 'wiki', '.causal.json');
  if (!fs.existsSync(causalPath)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(causalPath, 'utf8'));
    return Array.isArray(parsed.patterns) ? parsed.patterns : [];
  } catch {
    return [];
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
    causal_patterns: Array.isArray(graph.causal_patterns) ? graph.causal_patterns : [],
  };
}

async function runWikiMinerWake(name, paths, { execute = false } = {}) {
  const mode = execute ? 'execute' : 'dry_run';
  const root = process.cwd();
  const pages = listWikiMarkdownPages(root, 10);
  let graph = readWikiGraph(root);
  const causalPatterns = readCausalPatterns(root);
  graph.causal_patterns = causalPatterns;
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
    graph.causal_patterns = causalPatterns;
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
    causal_pattern_count: causalPatterns.length,
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

function supervisorRecommendationsPath(root = process.cwd()) {
  return path.join(root, 'atris', 'team', 'supervisor', 'recommendations.json');
}

function emptySupervisorRecommendations(extra = {}) {
  return {
    schema: 'atris.supervisor_recommendations.v1',
    updated_at: stampIso(),
    status: extra.status || 'empty',
    advisory_only: true,
    llm_source: extra.llm_source || null,
    llm_error: extra.llm_error || null,
    top_performers: [],
    bottlenecks: [],
    recommendations: [],
  };
}

function listRecentSupervisorReceipts(root = process.cwd(), windowMs = 24 * 60 * 60 * 1000) {
  const runsDir = path.join(root, 'atris', 'runs');
  if (!fs.existsSync(runsDir)) return [];
  const cutoff = Date.now() - windowMs;
  return fs.readdirSync(runsDir)
    .filter((entry) => /^member-.*-.*\.json$/.test(entry))
    .map((entry) => {
      const fullPath = path.join(runsDir, entry);
      let stat;
      try {
        stat = fs.statSync(fullPath);
      } catch {
        return null;
      }
      return stat.isFile() && stat.mtimeMs >= cutoff ? { fullPath, relativePath: path.relative(root, fullPath), mtimeMs: stat.mtimeMs } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .map((entry) => {
      try {
        const parsed = JSON.parse(fs.readFileSync(entry.fullPath, 'utf8'));
        return {
          path: entry.relativePath,
          member: parsed.member || parsed.claimed_by || null,
          ok: parsed.ok !== false,
          decision: parsed.decision || null,
          reason: parsed.reason || parsed.error || null,
          created_at: parsed.created_at || parsed.finished_at || parsed.started_at || null,
          duration_ms: parsed.duration_ms || parsed.elapsed_ms || null,
        };
      } catch (error) {
        return {
          path: entry.relativePath,
          member: null,
          ok: false,
          decision: null,
          reason: compactSentence(error instanceof Error ? error.message : String(error), 220),
          created_at: null,
          duration_ms: null,
        };
      }
    });
}

function readSupervisorMemberLogs(root = process.cwd(), maxFiles = 40) {
  const teamDir = path.join(root, 'atris', 'team');
  if (!fs.existsSync(teamDir)) return '';
  const files = [];
  for (const member of fs.readdirSync(teamDir).sort()) {
    if (member.startsWith('_')) continue;
    const logsDir = path.join(teamDir, member, 'logs');
    if (!fs.existsSync(logsDir)) continue;
    for (const entry of fs.readdirSync(logsDir).sort()) {
      if (!entry.endsWith('.md')) continue;
      const fullPath = path.join(logsDir, entry);
      try {
        const stat = fs.statSync(fullPath);
        if (stat.isFile()) files.push({ fullPath, relativePath: path.relative(root, fullPath), mtimeMs: stat.mtimeMs });
      } catch {
        // Ignore unreadable log files; the receipt records the aggregate input size.
      }
    }
  }
  return files
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, maxFiles)
    .map((entry) => {
      try {
        return `\n--- ${entry.relativePath} ---\n${fs.readFileSync(entry.fullPath, 'utf8').slice(0, 2000)}`;
      } catch (error) {
        return `\n--- ${entry.relativePath} ---\n[unreadable: ${compactSentence(error instanceof Error ? error.message : String(error), 180)}]`;
      }
    })
    .join('\n')
    .slice(0, 20000);
}

function supervisorPrompt(receipts, logs) {
  return `Analyze these member receipts and logs. Identify:
1. Which members are performing best (success rate, speed)?
2. Any coordination bottlenecks or repeated failures?
3. Suggest specific adjustments: priority weights, member assignments

Return JSON:
{
  "top_performers": [{"member": "...", "reason": "..."}],
  "bottlenecks": [{"issue": "...", "suggestion": "..."}],
  "recommendations": [{"type": "priority|assignment", "from": "...", "to": "...", "reason": "..."}]
}

Receipts: ${JSON.stringify(receipts.slice(0, 20))}
Logs: ${logs.slice(0, 5000)}`;
}

function normalizeSupervisorAnalysis(raw, extra = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const recommendationTypes = new Set(['priority', 'assignment']);
  const topPerformers = (Array.isArray(raw.top_performers) ? raw.top_performers : [])
    .map((entry) => ({
      member: compactSentence(entry?.member || '', 100),
      reason: compactSentence(entry?.reason || '', 260),
    }))
    .filter((entry) => entry.member);
  const bottlenecks = (Array.isArray(raw.bottlenecks) ? raw.bottlenecks : [])
    .map((entry) => ({
      issue: compactSentence(entry?.issue || '', 220),
      suggestion: compactSentence(entry?.suggestion || '', 320),
    }))
    .filter((entry) => entry.issue);
  const recommendations = (Array.isArray(raw.recommendations) ? raw.recommendations : [])
    .map((entry) => ({
      type: recommendationTypes.has(String(entry?.type || '').toLowerCase()) ? String(entry.type).toLowerCase() : 'priority',
      from: compactSentence(entry?.from || '', 100),
      to: compactSentence(entry?.to || '', 100),
      reason: compactSentence(entry?.reason || '', 320),
    }))
    .filter((entry) => entry.reason || entry.to);
  return {
    ...emptySupervisorRecommendations(extra),
    status: extra.status || 'ok',
    top_performers: topPerformers,
    bottlenecks,
    recommendations,
  };
}

function injectedSupervisorAnalysis() {
  if (!process.env.ATRIS_SUPERVISOR_LLM_JSON) return null;
  const parsed = parseJsonObjectFromText(process.env.ATRIS_SUPERVISOR_LLM_JSON);
  return parsed
    ? { source: 'env_json', analysis: parsed }
    : { source: 'env_json', error: 'invalid_json' };
}

async function callSupervisorLlm(receipts, logs) {
  const injected = injectedSupervisorAnalysis();
  if (injected) return injected;
  if (process.env.ATRIS_SUPERVISOR_LLM !== '1') return null;
  try {
    const { postTurn } = require('../ax');
    const output = { isTTY: false, write() { return true; } };
    const result = await postTurn(supervisorPrompt(receipts, logs), {
      mode: process.env.ATRIS_SUPERVISOR_LLM_MODE || 'fast',
      route: 'local',
      cwd: process.cwd(),
      output,
      color: false,
    });
    const parsed = parseJsonObjectFromText(result?.output || '');
    return parsed
      ? { source: 'atris2_backend', analysis: parsed }
      : { source: 'atris2_backend', error: 'missing_json_response' };
  } catch (error) {
    return {
      source: 'atris2_backend',
      error: compactSentence(error instanceof Error ? error.message : String(error), 220),
    };
  }
}

function fallbackSupervisorAnalysis(receipts) {
  const byMember = new Map();
  for (const receipt of receipts) {
    const member = compactSentence(receipt.member || 'unknown', 100);
    const current = byMember.get(member) || { member, total: 0, ok: 0, durations: [], reasons: new Map() };
    current.total += 1;
    if (receipt.ok) current.ok += 1;
    if (Number.isFinite(Number(receipt.duration_ms))) current.durations.push(Number(receipt.duration_ms));
    if (!receipt.ok || receipt.reason) {
      const reason = compactSentence(receipt.reason || 'unspecified', 180);
      current.reasons.set(reason, (current.reasons.get(reason) || 0) + 1);
    }
    byMember.set(member, current);
  }
  const ranked = [...byMember.values()].sort((a, b) => (b.ok / Math.max(1, b.total)) - (a.ok / Math.max(1, a.total)) || b.ok - a.ok);
  const top_performers = ranked.slice(0, 3).filter((entry) => entry.ok > 0).map((entry) => ({
    member: entry.member,
    reason: `${entry.ok}/${entry.total} recent member receipts succeeded`,
  }));
  const bottlenecks = ranked
    .filter((entry) => entry.ok < entry.total)
    .slice(0, 3)
    .map((entry) => {
      const [reason] = [...entry.reasons.entries()].sort((a, b) => b[1] - a[1])[0] || ['unknown failure'];
      return {
        issue: `${entry.member} has ${entry.total - entry.ok} failed recent receipt(s)`,
        suggestion: `Review repeated reason: ${reason}`,
      };
    });
  const recommendations = top_performers.length
    ? [{
        type: 'priority',
        from: 'supervisor',
        to: top_performers[0].member,
        reason: `Favor ${top_performers[0].member} for coordination work until LLM analysis is configured.`,
      }]
    : [];
  return normalizeSupervisorAnalysis(
    { top_performers, bottlenecks, recommendations },
    { status: 'heuristic', llm_source: null, llm_error: 'llm_not_configured' },
  );
}

async function runSupervisorWake(name, paths, { execute = false } = {}) {
  const mode = execute ? 'execute' : 'dry_run';
  const root = process.cwd();
  const receipts = listRecentSupervisorReceipts(root);
  const logs = readSupervisorMemberLogs(root);
  let llm = null;
  let analysis = null;
  let reason = execute ? 'supervisor_recommendations_written' : 'supervisor_recommendations_dry_run';

  if (!receipts.length) {
    reason = 'insufficient_data';
    analysis = {
      ...emptySupervisorRecommendations({ status: 'insufficient_data' }),
      recommendations: [{
        type: 'priority',
        from: 'supervisor',
        to: 'member-receipts',
        reason: 'Insufficient data: no atris/runs/member-*-*.json receipts from the last 24 hours.',
      }],
    };
  } else {
    llm = await callSupervisorLlm(receipts, logs);
    if (llm?.analysis) {
      analysis = normalizeSupervisorAnalysis(llm.analysis, { status: 'ok', llm_source: llm.source });
      if (!analysis) {
        reason = 'llm_json_parse_failed';
        analysis = emptySupervisorRecommendations({ status: 'parse_error', llm_source: llm.source, llm_error: 'invalid_analysis_shape' });
      }
    } else if (llm?.error) {
      reason = llm.error === 'invalid_json' ? 'llm_json_parse_failed' : 'llm_analysis_failed';
      analysis = emptySupervisorRecommendations({ status: llm.error === 'invalid_json' ? 'parse_error' : 'llm_error', llm_source: llm.source, llm_error: llm.error });
    } else {
      reason = 'llm_not_configured';
      analysis = fallbackSupervisorAnalysis(receipts);
    }
  }

  const recommendationsPath = supervisorRecommendationsPath(root);
  if (execute) {
    fs.mkdirSync(path.dirname(recommendationsPath), { recursive: true });
    fs.writeFileSync(recommendationsPath, JSON.stringify(analysis, null, 2) + '\n', 'utf8');
  }

  const runsDir = path.join(root, 'atris', 'runs');
  fs.mkdirSync(runsDir, { recursive: true });
  const receiptPath = path.join(runsDir, `supervisor-tick-${fileSafeStamp()}.json`);
  const receipt = {
    schema: 'atris.supervisor_tick.v1',
    created_at: stampIso(),
    member: name,
    mode,
    executed: execute,
    ok: true,
    advisory_only: true,
    decision: 'supervise',
    reason,
    receipts_scanned: receipts.length,
    logs_bytes: logs.length,
    llm_source: llm?.source || analysis.llm_source || null,
    llm_successful: Boolean(llm?.source && llm?.analysis && analysis.status === 'ok'),
    llm_error: llm?.error || analysis.llm_error || null,
    recommendations_path: path.relative(root, recommendationsPath),
    top_performer_count: analysis.top_performers.length,
    bottleneck_count: analysis.bottlenecks.length,
    recommendation_count: analysis.recommendations.length,
    analysis,
  };
  fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n', 'utf8');
  const logPath = appendMemberGoalLog(paths.memberDir, name, 'Supervisor tick', {
    mode,
    reason,
    receipts: receipts.length,
    llm_source: receipt.llm_source || '',
    llm_error: receipt.llm_error || '',
    recommendations: analysis.recommendations.length,
    receipt: path.relative(root, receiptPath),
    output: path.relative(root, recommendationsPath),
  });

  return {
    ok: true,
    action: 'wake',
    member: name,
    mode,
    decision: 'supervise',
    reason,
    executed: execute,
    needs_user: false,
    ask: null,
    next_command: 'atris member supervisor recommendations',
    receipt_path: receiptPath,
    log_path: logPath,
    recommendations_path: recommendationsPath,
    supervisor: receipt,
  };
}

function memberSupervisorRecommendations(...args) {
  const asJson = hasFlag(args, '--json');
  const recommendationsPath = supervisorRecommendationsPath(process.cwd());
  let payload;
  if (fs.existsSync(recommendationsPath)) {
    try {
      payload = JSON.parse(fs.readFileSync(recommendationsPath, 'utf8'));
    } catch (error) {
      payload = emptySupervisorRecommendations({
        status: 'parse_error',
        llm_error: compactSentence(error instanceof Error ? error.message : String(error), 220),
      });
    }
  } else {
    payload = emptySupervisorRecommendations({ status: 'missing' });
  }
  const lines = payload.status === 'missing'
    ? ['No supervisor recommendations found. Run: atris member wake supervisor --execute']
    : [
        `Supervisor recommendations: ${payload.status}`,
        ...(payload.top_performers || []).slice(0, 5).map((entry) => `Top: ${entry.member} - ${entry.reason}`),
        ...(payload.bottlenecks || []).slice(0, 5).map((entry) => `Bottleneck: ${entry.issue} - ${entry.suggestion}`),
        ...(payload.recommendations || []).slice(0, 5).map((entry) => `Recommendation: ${entry.type} ${entry.from || 'supervisor'} -> ${entry.to || 'coordination'} - ${entry.reason}`),
      ];
  printJsonOrText({ ok: payload.status !== 'missing', action: 'supervisor_recommendations', recommendations_path: recommendationsPath, recommendations: payload }, lines, asJson);
}

function memberSupervisorCommand(command, ...args) {
  if (command === 'recommendations') return memberSupervisorRecommendations(...args);
  console.log('Usage: atris member supervisor recommendations [--json]');
}

function objectiveGeneratorProposalsPath(root = process.cwd()) {
  return path.join(root, 'atris', 'team', 'objective-generator', 'proposals.json');
}

function emptyObjectiveGeneratorProposal(extra = {}) {
  return {
    schema: 'atris.objective_generator_proposals.v1',
    updated_at: stampIso(),
    status: extra.status || 'empty',
    advisory_only: true,
    world_model_used: false,
    llm_source: extra.llm_source || null,
    llm_error: extra.llm_error || null,
    proposed_objective: null,
    impact_score: null,
    urgency_score: null,
    alignment_score: null,
    overall_score: null,
    justification: '',
    suggested_member: '',
    suggested_patterns: [],
    created_task: null,
  };
}

function readObjectiveGeneratorWorldModel(root = process.cwd()) {
  const graph = readWikiGraph(root);
  return {
    ...graph,
    entities: Array.isArray(graph.entities) ? graph.entities : [],
    relationships: Array.isArray(graph.relationships) ? graph.relationships : [],
  };
}

function readSupervisorRecommendations(root = process.cwd()) {
  const recommendationsPath = supervisorRecommendationsPath(root);
  if (!fs.existsSync(recommendationsPath)) return emptySupervisorRecommendations({ status: 'missing' });
  try {
    const parsed = JSON.parse(fs.readFileSync(recommendationsPath, 'utf8'));
    return {
      ...emptySupervisorRecommendations({ status: parsed.status || 'ok', llm_source: parsed.llm_source || null, llm_error: parsed.llm_error || null }),
      ...parsed,
      top_performers: Array.isArray(parsed.top_performers) ? parsed.top_performers : [],
      bottlenecks: Array.isArray(parsed.bottlenecks) ? parsed.bottlenecks : [],
      recommendations: Array.isArray(parsed.recommendations) ? parsed.recommendations : [],
    };
  } catch (error) {
    return emptySupervisorRecommendations({
      status: 'parse_error',
      llm_error: compactSentence(error instanceof Error ? error.message : String(error), 220),
    });
  }
}

function readTransferPatterns(root = process.cwd()) {
  const patternsPath = path.join(root, 'atris', 'wiki', '.patterns.json');
  if (!fs.existsSync(patternsPath)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(patternsPath, 'utf8'));
    return Array.isArray(parsed.patterns) ? parsed.patterns : [];
  } catch {
    return [];
  }
}

function objectivePatternMatches(patterns, objective, limit = 3) {
  const terms = new Set(String(objective || '').toLowerCase().split(/[^a-z0-9]+/).filter((term) => term.length >= 3));
  return (Array.isArray(patterns) ? patterns : [])
    .map((pattern) => {
      const text = [
        pattern.pattern,
        pattern.from_domain,
        ...(pattern.steps || []),
        ...(pattern.suggested_for || []),
      ].join(' ').toLowerCase();
      let overlap = 0;
      for (const term of terms) if (text.includes(term)) overlap += 1;
      return {
        id: pattern.id || null,
        pattern: compactSentence(pattern.pattern || '', 260),
        from_domain: compactSentence(pattern.from_domain || '', 100),
        transfer_score: Number(pattern.transfer_score) || 0,
        match_score: (Number(pattern.transfer_score) || 0) + overlap * 3,
        reason: overlap > 0 ? `Matched ${overlap} objective term(s)` : 'Highest available reusable pattern',
        source_reason: compactSentence(pattern.reason || '', 320),
        cross_domain_pattern: Boolean(pattern.cross_domain_pattern),
        success_rate: Number(pattern.success_rate) || 0,
        domain_count: Number(pattern.domain_count) || 0,
      };
    })
    .filter((pattern) => pattern.pattern)
    .sort((a, b) => b.match_score - a.match_score || a.pattern.localeCompare(b.pattern))
    .slice(0, limit);
}

function fallbackObjectiveGeneratorProposal(graph, recommendations, transferPatterns = []) {
  const relationships = Array.isArray(graph?.relationships) ? graph.relationships : [];
  const entities = Array.isArray(graph?.entities) ? graph.entities : [];
  const supervisorRecommendation = Array.isArray(recommendations?.recommendations)
    ? recommendations.recommendations.find((entry) => entry?.to)
    : null;
  const topPerformer = Array.isArray(recommendations?.top_performers)
    ? recommendations.top_performers.find((entry) => entry?.member)
    : null;
  const member = compactSentence(
    supervisorRecommendation?.to
      || topPerformer?.member
      || entities.find((entity) => entity?.type === 'system')?.name
      || entities[0]?.name
      || 'project-owner',
    100,
  );
  const relationship = relationships.find((entry) => entry?.from === member || entry?.to === member) || relationships[0] || null;
  const relationTarget = compactSentence(
    relationship?.from === member ? relationship?.to : relationship?.from || relationship?.to || 'world model',
    100,
  );
  const bottleneck = Array.isArray(recommendations?.bottlenecks)
    ? recommendations.bottlenecks.find((entry) => entry?.issue || entry?.suggestion)
    : null;
  const hasProofSignal = [
    supervisorRecommendation?.reason,
    bottleneck?.issue,
    bottleneck?.suggestion,
    relationTarget,
  ].join(' ').toLowerCase().includes('proof');
  const proposedObjective = hasProofSignal && member !== 'project-owner'
    ? `Repair proof routing gaps around ${member} ${relationTarget} handoffs`
    : `Apply ${member} world model evidence to the next proof-ready objective`;
  const proposal = normalizeObjectiveProposal({
    proposed_objective: proposedObjective,
    impact_score: 7,
    urgency_score: 7,
    alignment_score: 7,
    justification: compactSentence(
      supervisorRecommendation?.reason
        || bottleneck?.suggestion
        || `World model links ${member} to ${relationTarget}, so the next objective should convert that signal into proof-ready work.`,
      600,
    ),
    suggested_member: member,
    suggested_patterns: objectivePatternMatches(transferPatterns, proposedObjective),
  }, { status: 'ok', llm_error: 'llm_not_configured', world_model_used: true });
  return proposal || emptyObjectiveGeneratorProposal({ status: 'llm_not_configured', llm_error: 'llm_not_configured' });
}

function objectiveGeneratorPrompt(graph, recommendations, transferPatterns = []) {
  return `Analyze this world model and identify the highest-value problem to solve next.

Consider:
1. What entities/systems have the most dependencies?
2. What relationships are weak or missing?
3. What would have the biggest cross-domain impact?
4. What does the supervisor recommend?
5. Which reusable transfer patterns apply?

Return JSON:
{
  "proposed_objective": "Specific problem to solve",
  "impact_score": 1-10,
  "urgency_score": 1-10,
  "alignment_score": 1-10,
  "justification": "Why this matters",
  "suggested_member": "which member should handle this",
  "suggested_patterns": [{"pattern": "...", "reason": "..."}]
}

World model: ${JSON.stringify(graph)}
Supervisor recommendations: ${JSON.stringify(recommendations)}
Transfer patterns: ${JSON.stringify(transferPatterns.slice(0, 20))}`;
}

function score1to10(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.max(1, Math.min(10, Math.round(number)));
}

function normalizeObjectiveProposal(raw, extra = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const impact = score1to10(raw.impact_score);
  const urgency = score1to10(raw.urgency_score);
  const alignment = score1to10(raw.alignment_score);
  const objective = compactSentence(raw.proposed_objective || raw.objective || raw.title || '', 240);
  if (!objective || impact === null || urgency === null || alignment === null) return null;
  const overall = Number(((impact + urgency + alignment) / 3).toFixed(2));
  const suggestedPatterns = (Array.isArray(raw.suggested_patterns) ? raw.suggested_patterns : [])
    .map((pattern) => ({
      pattern: compactSentence(pattern?.pattern || pattern?.name || '', 260),
      reason: compactSentence(pattern?.reason || '', 320),
    }))
    .filter((pattern) => pattern.pattern);
  return {
    ...emptyObjectiveGeneratorProposal(extra),
    status: extra.status || 'ok',
    world_model_used: Boolean(extra.world_model_used),
    proposed_objective: objective,
    impact_score: impact,
    urgency_score: urgency,
    alignment_score: alignment,
    overall_score: overall,
    justification: compactSentence(raw.justification || '', 600),
    suggested_member: compactSentence(raw.suggested_member || '', 100),
    suggested_patterns: suggestedPatterns,
  };
}

function injectedObjectiveGeneratorProposal() {
  if (!process.env.ATRIS_OBJECTIVE_GENERATOR_LLM_JSON) return null;
  const parsed = parseJsonObjectFromText(process.env.ATRIS_OBJECTIVE_GENERATOR_LLM_JSON);
  return parsed
    ? { source: 'env_json', proposal: parsed }
    : { source: 'env_json', error: 'invalid_json' };
}

async function callObjectiveGeneratorLlm(graph, recommendations, transferPatterns = []) {
  const injected = injectedObjectiveGeneratorProposal();
  if (injected) return injected;
  if (process.env.ATRIS_OBJECTIVE_GENERATOR_LLM !== '1') return null;
  try {
    const { postTurn } = require('../ax');
    const output = { isTTY: false, write() { return true; } };
    const result = await postTurn(objectiveGeneratorPrompt(graph, recommendations, transferPatterns), {
      mode: process.env.ATRIS_OBJECTIVE_GENERATOR_LLM_MODE || 'fast',
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

function createAutoObjectiveTask(proposal) {
  const title = proposal.proposed_objective || 'Autonomous objective';
  const commandArgs = ['task', 'new', title, '--tag', 'auto-objective', '--json'];
  const command = `atris task new ${shellQuote(title)} --tag auto-objective`;
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
      command,
      task,
      task_id: parsed.task_id || task?.id || null,
      task_ref: taskRef(task) || parsed.task_id || null,
      raw: parsed,
    };
  } catch (error) {
    return {
      ok: false,
      command,
      error: error instanceof Error ? error.message : String(error),
      stderr: error?.stderr ? compactSentence(String(error.stderr), 500) : null,
    };
  }
}

async function runObjectiveGeneratorWake(name, paths, { execute = false } = {}) {
  const mode = execute ? 'execute' : 'dry_run';
  const root = process.cwd();
  const graph = readObjectiveGeneratorWorldModel(root);
  const recommendations = readSupervisorRecommendations(root);
  const transferPatterns = readTransferPatterns(root);
  const hasWorldModel = graph.entities.length > 0 || graph.relationships.length > 0;
  let llm = null;
  let proposal = null;
  let createdTask = null;
  let reason = execute ? 'objective_proposal_written' : 'objective_proposal_dry_run';

  if (!hasWorldModel) {
    reason = 'insufficient_world_model_data';
    proposal = {
      ...emptyObjectiveGeneratorProposal({ status: 'insufficient_world_model_data' }),
      justification: 'Insufficient world model data: atris/wiki/.graph.json has no entities or relationships.',
    };
  } else {
    llm = await callObjectiveGeneratorLlm(graph, recommendations, transferPatterns);
    if (llm?.proposal) {
      proposal = normalizeObjectiveProposal(llm.proposal, { status: 'ok', llm_source: llm.source, world_model_used: true });
      if (!proposal) {
        reason = 'llm_json_parse_failed';
        proposal = emptyObjectiveGeneratorProposal({ status: 'parse_error', llm_source: llm.source, llm_error: 'invalid_proposal_shape' });
        proposal.world_model_used = true;
      }
    } else if (llm?.error) {
      reason = llm.error === 'invalid_json' ? 'llm_json_parse_failed' : 'llm_analysis_failed';
      proposal = emptyObjectiveGeneratorProposal({ status: llm.error === 'invalid_json' ? 'parse_error' : 'llm_error', llm_source: llm.source, llm_error: llm.error });
      proposal.world_model_used = true;
    } else {
      reason = 'heuristic_objective_proposal_written';
      proposal = fallbackObjectiveGeneratorProposal(graph, recommendations, transferPatterns);
    }
  }

  if (proposal?.status === 'ok' && (!Array.isArray(proposal.suggested_patterns) || !proposal.suggested_patterns.length)) {
    proposal.suggested_patterns = objectivePatternMatches(transferPatterns, proposal.proposed_objective);
  }

  if (execute && proposal?.status === 'ok' && Number(proposal.overall_score) > 7) {
    createdTask = createAutoObjectiveTask(proposal);
    proposal.created_task = createdTask.ok ? {
      id: createdTask.task_id || null,
      ref: createdTask.task_ref || null,
      title: createdTask.task?.title || proposal.proposed_objective,
      tag: createdTask.task?.tag || 'auto-objective',
      command: createdTask.command,
    } : {
      ok: false,
      command: createdTask.command,
      error: createdTask.error || createdTask.stderr || 'task_create_failed',
    };
  }

  const proposalsPath = objectiveGeneratorProposalsPath(root);
  if (execute) {
    fs.mkdirSync(path.dirname(proposalsPath), { recursive: true });
    fs.writeFileSync(proposalsPath, JSON.stringify(proposal, null, 2) + '\n', 'utf8');
  }

  const runsDir = path.join(root, 'atris', 'runs');
  fs.mkdirSync(runsDir, { recursive: true });
  const receiptPath = path.join(runsDir, `objective-generator-tick-${fileSafeStamp()}.json`);
  const receipt = {
    schema: 'atris.objective_generator_tick.v1',
    created_at: stampIso(),
    member: name,
    mode,
    executed: execute,
    ok: true,
    advisory_only: true,
    decision: 'generate_objective',
    reason,
    world_model_path: path.relative(root, wikiMinerGraphPath(root)),
    world_model_used: proposal.world_model_used,
    world_model_entities: graph.entities.length,
    world_model_relationships: graph.relationships.length,
    supervisor_recommendations_path: path.relative(root, supervisorRecommendationsPath(root)),
    supervisor_recommendation_count: Array.isArray(recommendations.recommendations) ? recommendations.recommendations.length : 0,
    transfer_patterns_path: path.relative(root, path.join(root, 'atris', 'wiki', '.patterns.json')),
    transfer_pattern_count: transferPatterns.length,
    llm_source: llm?.source || proposal.llm_source || null,
    llm_successful: Boolean(llm?.source && llm?.proposal && proposal.status === 'ok'),
    llm_error: llm?.error || proposal.llm_error || null,
    proposals_path: path.relative(root, proposalsPath),
    task_creation_threshold: 7,
    task_created: Boolean(createdTask?.ok),
    created_task: proposal.created_task,
    proposal,
  };
  fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n', 'utf8');
  const logPath = appendMemberGoalLog(paths.memberDir, name, 'Objective generator tick', {
    mode,
    reason,
    world_entities: graph.entities.length,
    world_relationships: graph.relationships.length,
    llm_source: receipt.llm_source || '',
    llm_error: receipt.llm_error || '',
    objective: proposal.proposed_objective || '',
    score: proposal.overall_score || '',
    task: proposal.created_task?.ref || '',
    receipt: path.relative(root, receiptPath),
    output: path.relative(root, proposalsPath),
  });

  return {
    ok: true,
    action: 'wake',
    member: name,
    mode,
    decision: 'generate_objective',
    reason,
    executed: execute,
    needs_user: false,
    ask: null,
    next_command: 'atris member objective-generator proposals',
    receipt_path: receiptPath,
    log_path: logPath,
    proposals_path: proposalsPath,
    objective_generator: receipt,
  };
}

function memberObjectiveGeneratorProposals(...args) {
  const asJson = hasFlag(args, '--json');
  const proposalsPath = objectiveGeneratorProposalsPath(process.cwd());
  let payload;
  if (fs.existsSync(proposalsPath)) {
    try {
      payload = JSON.parse(fs.readFileSync(proposalsPath, 'utf8'));
    } catch (error) {
      payload = emptyObjectiveGeneratorProposal({
        status: 'parse_error',
        llm_error: compactSentence(error instanceof Error ? error.message : String(error), 220),
      });
    }
  } else {
    payload = emptyObjectiveGeneratorProposal({ status: 'missing' });
  }
  const lines = payload.status === 'missing'
    ? ['No objective-generator proposals found. Run: atris member wake objective-generator --execute']
    : [
        `Objective proposal: ${payload.status}`,
        payload.proposed_objective ? `Objective: ${payload.proposed_objective}` : '',
        Number.isFinite(Number(payload.overall_score)) ? `Score: ${payload.overall_score} (impact ${payload.impact_score}, urgency ${payload.urgency_score}, alignment ${payload.alignment_score})` : '',
        payload.suggested_member ? `Suggested member: ${payload.suggested_member}` : '',
        Array.isArray(payload.suggested_patterns) && payload.suggested_patterns.length ? `Pattern: ${payload.suggested_patterns[0].pattern}` : '',
        payload.justification ? `Why: ${payload.justification}` : '',
        payload.created_task?.ref ? `Task: ${payload.created_task.ref}` : '',
      ].filter(Boolean);
  printJsonOrText({ ok: payload.status !== 'missing', action: 'objective_generator_proposals', proposals_path: proposalsPath, proposal: payload }, lines, asJson);
}

function memberObjectiveGeneratorCommand(command, ...args) {
  if (command === 'proposals') return memberObjectiveGeneratorProposals(...args);
  console.log('Usage: atris member objective-generator proposals [--json]');
}

const GENERALIST_CAPABILITIES = [
  'autonomous_problem_discovery',
  'world_model',
  'meta_cognition',
  'objective_setting',
  'causal_reasoning',
  'transfer_learning',
  'architecture_self_improvement',
  'emergent_capability_discovery',
];

function generalistProofsDir(root = process.cwd()) {
  return path.join(root, 'atris', 'team', 'generalist', 'proofs');
}

function generalistLatestProofPath(root = process.cwd()) {
  return path.join(generalistProofsDir(root), 'latest.json');
}

function crossDomainPatternsPath(root = process.cwd()) {
  return path.join(root, 'atris', 'wiki', '.cross_domain_patterns.json');
}

function generalistDomainSlug(value) {
  const slug = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 72);
  return slug || `domain-${slugHash(value)}`;
}

function crossDomainPatternKey(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function emptyCrossDomainPatternLibrary(extra = {}) {
  return {
    schema: 'atris.cross_domain_patterns.v1',
    updated_at: stampIso(),
    status: extra.status || 'empty',
    domains: [],
    patterns: [],
    metrics: {
      domains_solved_count: 0,
      pattern_count: 0,
      cross_domain_pattern_count: 0,
      total_runs: 0,
      successful_runs: 0,
      pattern_observations: 0,
      reused_pattern_observations: 0,
      pattern_reuse_rate: 0,
      cross_domain_applications: 0,
      cross_domain_successes: 0,
      cross_domain_success_rate: 0,
      average_pattern_success_rate: 0,
    },
    recent_runs: [],
  };
}

function normalizeCrossDomainPatternLibrary(raw) {
  const library = { ...emptyCrossDomainPatternLibrary(), ...(raw && typeof raw === 'object' ? raw : {}) };
  library.domains = (Array.isArray(library.domains) ? library.domains : [])
    .map((domain) => ({
      name: compactSentence(domain?.name || '', 120),
      first_seen_at: domain?.first_seen_at || null,
      last_seen_at: domain?.last_seen_at || null,
      runs: Number(domain?.runs) || 0,
      successes: Number(domain?.successes) || 0,
      proof_paths: Array.isArray(domain?.proof_paths) ? domain.proof_paths.filter(Boolean).slice(-10) : [],
      receipt_paths: Array.isArray(domain?.receipt_paths) ? domain.receipt_paths.filter(Boolean).slice(-10) : [],
      last_objective: compactSentence(domain?.last_objective || '', 260),
    }))
    .filter((domain) => domain.name);
  library.patterns = (Array.isArray(library.patterns) ? library.patterns : [])
    .map((pattern) => {
      const text = compactSentence(pattern?.pattern || pattern?.source_pattern || '', 260);
      const key = crossDomainPatternKey(pattern?.key || text);
      const uses = Math.max(0, Number(pattern?.uses) || 0);
      const successes = Math.max(0, Number(pattern?.successes) || 0);
      const domains = [...new Set((Array.isArray(pattern?.domains) ? pattern.domains : []).map((domain) => compactSentence(domain, 120)).filter(Boolean))].sort();
      const successRate = uses > 0 ? Number((successes / uses).toFixed(4)) : 0;
      const domainCount = domains.length;
      return {
        id: pattern?.id || `cross-domain:${slugHash(key || text)}`,
        key,
        pattern: text,
        first_seen_at: pattern?.first_seen_at || null,
        last_seen_at: pattern?.last_seen_at || null,
        last_reused_at: pattern?.last_reused_at || null,
        domains,
        domain_count: domainCount,
        uses,
        successes,
        success_rate: successRate,
        score: Number((successRate * 10 + Math.min(5, domainCount) * 2).toFixed(2)),
        evidence: Array.isArray(pattern?.evidence) ? pattern.evidence.slice(-20) : [],
      };
    })
    .filter((pattern) => pattern.pattern && pattern.key);
  library.recent_runs = Array.isArray(library.recent_runs) ? library.recent_runs.slice(-20) : [];
  library.metrics = { ...emptyCrossDomainPatternLibrary().metrics, ...(library.metrics && typeof library.metrics === 'object' ? library.metrics : {}) };
  library.status = library.patterns.length ? 'ok' : library.status || 'empty';
  return library;
}

function readCrossDomainPatternLibrary(root = process.cwd()) {
  const libraryPath = crossDomainPatternsPath(root);
  if (!fs.existsSync(libraryPath)) return emptyCrossDomainPatternLibrary({ status: 'missing' });
  try {
    return normalizeCrossDomainPatternLibrary(JSON.parse(fs.readFileSync(libraryPath, 'utf8')));
  } catch (error) {
    return {
      ...emptyCrossDomainPatternLibrary({ status: 'parse_error' }),
      error: compactSentence(error instanceof Error ? error.message : String(error), 220),
    };
  }
}

function crossDomainPatternText(pattern) {
  return compactSentence(pattern?.source_pattern || pattern?.pattern || pattern?.name || pattern?.application || '', 260);
}

function crossDomainPatternMatches(library, domainName = '', objectiveOrDescription = '', limit = 3) {
  const domainKey = lowerCompact(domainName);
  const terms = new Set(String(`${domainName} ${objectiveOrDescription}`)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length >= 4));
  return (Array.isArray(library?.patterns) ? library.patterns : [])
    .map((pattern) => {
      const text = [pattern.pattern, ...(pattern.domains || [])].join(' ').toLowerCase();
      let overlap = 0;
      for (const term of terms) if (text.includes(term)) overlap += 1;
      const seenInSameDomain = (pattern.domains || []).some((domain) => lowerCompact(domain) === domainKey);
      const crossDomainBonus = seenInSameDomain ? 0 : 6;
      const matchScore = (Number(pattern.score) || 0)
        + (Number(pattern.success_rate) || 0) * 10
        + (Number(pattern.domain_count) || 0) * 3
        + overlap * 2
        + crossDomainBonus;
      return {
        ...pattern,
        match_score: Number(matchScore.toFixed(2)),
        seen_in_same_domain: seenInSameDomain,
        reason: seenInSameDomain
          ? 'Pattern already seen in this domain'
          : `Reusable pattern from ${Math.max(1, Number(pattern.domain_count) || 0)} prior domain(s)`,
      };
    })
    .filter((pattern) => pattern.pattern)
    .sort((a, b) => b.match_score - a.match_score || b.success_rate - a.success_rate || a.pattern.localeCompare(b.pattern))
    .slice(0, limit);
}

function crossDomainPatternInputs(libraryMatches = [], transferPatterns = []) {
  const fromLibrary = (Array.isArray(libraryMatches) ? libraryMatches : []).map((pattern) => ({
    id: pattern.id,
    pattern: pattern.pattern,
    from_domain: (pattern.domains || []).join(', '),
    transfer_score: pattern.match_score || pattern.score || 0,
    success_rate: pattern.success_rate,
    domain_count: pattern.domain_count,
    cross_domain_pattern: true,
    suggested_for: ['generalist'],
    reason: pattern.reason,
  }));
  return [...fromLibrary, ...(Array.isArray(transferPatterns) ? transferPatterns : [])];
}

function recomputeCrossDomainPatternMetrics(library, beforeMetrics = {}, delta = {}) {
  const patterns = Array.isArray(library.patterns) ? library.patterns : [];
  const domains = Array.isArray(library.domains) ? library.domains : [];
  const totalRuns = (Number(beforeMetrics.total_runs) || 0) + (Number(delta.runs) || 0);
  const successfulRuns = (Number(beforeMetrics.successful_runs) || 0) + (Number(delta.successes) || 0);
  const patternObservations = (Number(beforeMetrics.pattern_observations) || 0) + (Number(delta.pattern_observations) || 0);
  const reusedPatternObservations = (Number(beforeMetrics.reused_pattern_observations) || 0) + (Number(delta.reused_pattern_observations) || 0);
  const crossDomainApplications = (Number(beforeMetrics.cross_domain_applications) || 0) + (Number(delta.cross_domain_applications) || 0);
  const crossDomainSuccesses = (Number(beforeMetrics.cross_domain_successes) || 0) + (Number(delta.cross_domain_successes) || 0);
  const averagePatternSuccessRate = patterns.length
    ? Number((patterns.reduce((sum, pattern) => sum + (Number(pattern.success_rate) || 0), 0) / patterns.length).toFixed(4))
    : 0;
  return {
    domains_solved_count: domains.length,
    pattern_count: patterns.length,
    cross_domain_pattern_count: patterns.filter((pattern) => Number(pattern.domain_count) > 1).length,
    total_runs: totalRuns,
    successful_runs: successfulRuns,
    pattern_observations: patternObservations,
    reused_pattern_observations: reusedPatternObservations,
    pattern_reuse_rate: patternObservations > 0 ? Number((reusedPatternObservations / patternObservations).toFixed(4)) : 0,
    cross_domain_applications: crossDomainApplications,
    cross_domain_successes: crossDomainSuccesses,
    cross_domain_success_rate: crossDomainApplications > 0 ? Number((crossDomainSuccesses / crossDomainApplications).toFixed(4)) : 0,
    average_pattern_success_rate: averagePatternSuccessRate,
  };
}

function learnCrossDomainPatterns(root, proof, { execute = false, record = true, libraryBefore = null, receiptPath = null, proofPath = null } = {}) {
  const before = normalizeCrossDomainPatternLibrary(libraryBefore || readCrossDomainPatternLibrary(root));
  if (!record) {
    return {
      library_path: crossDomainPatternsPath(root),
      executed: false,
      before_metrics: before.metrics,
      after_metrics: before.metrics,
      run: {
        at: stampIso(),
        domain: compactSentence(proof?.domain?.name || 'external domain', 120),
        status: proof?.status || 'unknown',
        skipped: true,
        reason: 'proof_not_successful',
      },
      reused_pattern_count: 0,
      reused_patterns: [],
      observed_pattern_count: 0,
      learning_improved: false,
    };
  }
  const library = normalizeCrossDomainPatternLibrary(JSON.parse(JSON.stringify(before)));
  const beforeMetrics = { ...before.metrics };
  const now = stampIso();
  const domainName = compactSentence(proof?.domain?.name || 'external domain', 120);
  const objective = proof?.objectives?.[0] || null;
  const proofPathRel = proofPath ? path.relative(root, proofPath) : null;
  const receiptPathRel = receiptPath ? path.relative(root, receiptPath) : null;
  const successful = proof?.status === 'ok';
  const existingPatternKeys = new Set((before.patterns || []).map((pattern) => pattern.key));
  const transferPatterns = (Array.isArray(proof?.transfer_patterns) ? proof.transfer_patterns : [])
    .map((pattern) => ({
      ...pattern,
      pattern_text: crossDomainPatternText(pattern),
    }))
    .filter((pattern) => pattern.pattern_text);
  let reusedPatternCount = 0;
  const reusedPatterns = [];

  let domainEntry = library.domains.find((domain) => lowerCompact(domain.name) === lowerCompact(domainName));
  if (!domainEntry) {
    domainEntry = {
      name: domainName,
      first_seen_at: now,
      last_seen_at: now,
      runs: 0,
      successes: 0,
      proof_paths: [],
      receipt_paths: [],
      last_objective: '',
    };
    library.domains.push(domainEntry);
  }
  domainEntry.last_seen_at = now;
  domainEntry.runs += 1;
  if (successful) domainEntry.successes += 1;
  if (proofPathRel && !domainEntry.proof_paths.includes(proofPathRel)) domainEntry.proof_paths.push(proofPathRel);
  if (receiptPathRel && !domainEntry.receipt_paths.includes(receiptPathRel)) domainEntry.receipt_paths.push(receiptPathRel);
  domainEntry.proof_paths = domainEntry.proof_paths.slice(-10);
  domainEntry.receipt_paths = domainEntry.receipt_paths.slice(-10);
  domainEntry.last_objective = objective?.objective || '';

  for (const transferPattern of transferPatterns) {
    const key = crossDomainPatternKey(transferPattern.pattern_text);
    const existedBefore = existingPatternKeys.has(key);
    let patternEntry = library.patterns.find((pattern) => pattern.key === key);
    if (!patternEntry) {
      patternEntry = {
        id: `cross-domain:${slugHash(key)}`,
        key,
        pattern: transferPattern.pattern_text,
        first_seen_at: now,
        last_seen_at: now,
        last_reused_at: null,
        domains: [],
        domain_count: 0,
        uses: 0,
        successes: 0,
        success_rate: 0,
        score: 0,
        evidence: [],
      };
      library.patterns.push(patternEntry);
    }
    if (existedBefore) {
      reusedPatternCount += 1;
      patternEntry.last_reused_at = now;
      reusedPatterns.push({
        id: patternEntry.id,
        pattern: patternEntry.pattern,
        domains_before: before.patterns.find((pattern) => pattern.key === key)?.domains || [],
        success_rate_before: before.patterns.find((pattern) => pattern.key === key)?.success_rate || 0,
      });
    }
    patternEntry.last_seen_at = now;
    if (!patternEntry.domains.includes(domainName)) patternEntry.domains.push(domainName);
    patternEntry.domains.sort();
    patternEntry.domain_count = patternEntry.domains.length;
    patternEntry.uses += 1;
    if (successful) patternEntry.successes += 1;
    patternEntry.success_rate = patternEntry.uses > 0 ? Number((patternEntry.successes / patternEntry.uses).toFixed(4)) : 0;
    patternEntry.score = Number((patternEntry.success_rate * 10 + Math.min(5, patternEntry.domain_count) * 2).toFixed(2));
    const evidenceKey = `${domainName}|${receiptPathRel || ''}|${proofPathRel || ''}`;
    if (!patternEntry.evidence.some((entry) => entry.evidence_key === evidenceKey)) {
      patternEntry.evidence.push({
        evidence_key: evidenceKey,
        domain: domainName,
        status: proof?.status || 'unknown',
        proof_path: proofPathRel,
        receipt_path: receiptPathRel,
        objective: objective?.objective || '',
        objective_score: objective?.overall_score || null,
        application: compactSentence(transferPattern.application || '', 420),
        reason: compactSentence(transferPattern.reason || '', 320),
        observed_at: now,
      });
    }
    patternEntry.evidence = patternEntry.evidence.slice(-20);
  }

  library.domains.sort((a, b) => a.name.localeCompare(b.name));
  library.patterns.sort((a, b) => b.score - a.score || b.domain_count - a.domain_count || a.pattern.localeCompare(b.pattern));
  const delta = {
    runs: 1,
    successes: successful ? 1 : 0,
    pattern_observations: transferPatterns.length,
    reused_pattern_observations: reusedPatternCount,
    cross_domain_applications: reusedPatternCount,
    cross_domain_successes: successful ? reusedPatternCount : 0,
  };
  library.metrics = recomputeCrossDomainPatternMetrics(library, beforeMetrics, delta);
  library.updated_at = now;
  library.status = 'ok';
  const afterMetrics = library.metrics;
  const learningImproved = afterMetrics.cross_domain_pattern_count > (Number(beforeMetrics.cross_domain_pattern_count) || 0)
    || afterMetrics.pattern_reuse_rate > (Number(beforeMetrics.pattern_reuse_rate) || 0)
    || afterMetrics.cross_domain_success_rate > (Number(beforeMetrics.cross_domain_success_rate) || 0);
  const runSummary = {
    at: now,
    domain: domainName,
    status: proof?.status || 'unknown',
    proof_path: proofPathRel,
    receipt_path: receiptPathRel,
    pattern_observations: transferPatterns.length,
    reused_pattern_count: reusedPatternCount,
    domains_solved_before: Number(beforeMetrics.domains_solved_count) || before.domains.length || 0,
    domains_solved_after: afterMetrics.domains_solved_count,
    pattern_count_before: Number(beforeMetrics.pattern_count) || before.patterns.length || 0,
    pattern_count_after: afterMetrics.pattern_count,
    pattern_reuse_rate_before: Number(beforeMetrics.pattern_reuse_rate) || 0,
    pattern_reuse_rate_after: afterMetrics.pattern_reuse_rate,
    cross_domain_success_rate_before: Number(beforeMetrics.cross_domain_success_rate) || 0,
    cross_domain_success_rate_after: afterMetrics.cross_domain_success_rate,
    learning_improved: learningImproved,
  };
  library.recent_runs = [...(library.recent_runs || []), runSummary].slice(-20);

  if (execute) {
    const libraryPath = crossDomainPatternsPath(root);
    fs.mkdirSync(path.dirname(libraryPath), { recursive: true });
    fs.writeFileSync(libraryPath, JSON.stringify(library, null, 2) + '\n', 'utf8');
  }

  return {
    library_path: crossDomainPatternsPath(root),
    executed: execute,
    before_metrics: beforeMetrics,
    after_metrics: afterMetrics,
    run: runSummary,
    reused_pattern_count: reusedPatternCount,
    reused_patterns: reusedPatterns,
    observed_pattern_count: transferPatterns.length,
    learning_improved: learningImproved,
  };
}

function resolveGeneralistDomainInput(root, domainInput = {}) {
  const fileFlag = domainInput.file || process.env.ATRIS_GENERALIST_DOMAIN_FILE || '';
  const textFlag = domainInput.text || process.env.ATRIS_GENERALIST_DOMAIN || '';
  const nameFlag = domainInput.name || process.env.ATRIS_GENERALIST_DOMAIN_NAME || '';
  let description = '';
  let source = 'missing';
  let sourcePath = null;
  let error = null;

  if (fileFlag) {
    const fullPath = path.isAbsolute(fileFlag) ? fileFlag : path.join(root, fileFlag);
    sourcePath = fullPath;
    try {
      description = fs.readFileSync(fullPath, 'utf8');
      source = 'file';
    } catch (readError) {
      error = compactSentence(readError instanceof Error ? readError.message : String(readError), 220);
    }
  }

  if (!description && textFlag) {
    description = textFlag;
    source = 'flag_text';
  }

  const heading = String(description).match(/^#\s+(.+)$/m)?.[1] || '';
  const domainLine = String(description).match(/^\s*(?:domain|context)\s*:\s*(.+)$/im)?.[1] || '';
  const firstLine = firstUsefulLine(description);
  const name = compactSentence(nameFlag || domainLine || heading || firstLine || 'external domain', 120);

  return {
    ok: Boolean(description.trim()),
    name,
    slug: generalistDomainSlug(name),
    description,
    description_excerpt: compactSentence(description, 800),
    source,
    source_path: sourcePath ? path.relative(root, sourcePath) : null,
    error: description.trim() ? null : (error || 'missing_domain_input'),
  };
}

function generalistDomainsDir(root = process.cwd()) {
  return path.join(root, 'atris', 'team', 'generalist', 'domains');
}

function normalizeRelativeProofPath(root, value) {
  if (!value) return '';
  const fullPath = path.isAbsolute(value) ? value : path.join(root, value);
  return path.relative(root, path.normalize(fullPath)).split(path.sep).join('/');
}

function listGeneralistDomainFiles(root = process.cwd()) {
  const domainsDir = generalistDomainsDir(root);
  if (!fs.existsSync(domainsDir)) return [];
  return fs.readdirSync(domainsDir)
    .filter((entry) => !entry.startsWith('.') && /\.(md|markdown|txt|json)$/i.test(entry))
    .map((entry) => {
      const fullPath = path.join(domainsDir, entry);
      try {
        const stat = fs.statSync(fullPath);
        if (!stat.isFile()) return null;
        return {
          full_path: fullPath,
          path: normalizeRelativeProofPath(root, fullPath),
          mtime_ms: stat.mtimeMs,
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => a.path.localeCompare(b.path));
}

function readGeneralistProofIndex(root = process.cwd()) {
  const proofsDir = generalistProofsDir(root);
  const bySourcePath = new Map();
  if (!fs.existsSync(proofsDir)) return bySourcePath;
  for (const entry of fs.readdirSync(proofsDir)) {
    if (!entry.endsWith('.json')) continue;
    const proofPath = path.join(proofsDir, entry);
    try {
      const stat = fs.statSync(proofPath);
      if (!stat.isFile()) continue;
      const proof = JSON.parse(fs.readFileSync(proofPath, 'utf8'));
      const sourcePath = normalizeRelativeProofPath(root, proof?.domain?.source_path || proof?.source_path || '');
      if (!sourcePath) continue;
      const processedAt = Date.parse(proof.updated_at || proof.created_at || proof.generated_at || '') || stat.mtimeMs;
      const existing = bySourcePath.get(sourcePath);
      if (!existing || processedAt > existing.processed_at_ms) {
        bySourcePath.set(sourcePath, {
          source_path: sourcePath,
          processed_at_ms: processedAt,
          processed_at: new Date(processedAt).toISOString(),
          proof_path: normalizeRelativeProofPath(root, proofPath),
        });
      }
    } catch {
      // Ignore malformed proof files; the scanner will simply treat the domain as due.
    }
  }
  return bySourcePath;
}

function findUnprocessedGeneralistDomainFile(root = process.cwd(), { windowMs = 60 * 60 * 1000, nowMs = Date.now() } = {}) {
  const files = listGeneralistDomainFiles(root);
  if (!files.length) return null;
  const proofIndex = readGeneralistProofIndex(root);
  const cutoff = nowMs - windowMs;
  return files
    .map((file) => {
      const lastProof = proofIndex.get(file.path) || null;
      return {
        ...file,
        status: lastProof ? 'stale' : 'new',
        last_processed_at: lastProof?.processed_at || null,
        last_proof_path: lastProof?.proof_path || null,
        due: !lastProof || lastProof.processed_at_ms < cutoff,
      };
    })
    .filter((file) => file.due)
    .sort((a, b) => {
      if (a.status !== b.status) return a.status === 'new' ? -1 : 1;
      return b.mtime_ms - a.mtime_ms || a.path.localeCompare(b.path);
    })[0] || null;
}

function emptyGeneralistProof(extra = {}) {
  return {
    schema: 'atris.generalist_domain_proof.v1',
    updated_at: stampIso(),
    status: extra.status || 'empty',
    domain: {
      name: extra.domain_name || 'external domain',
      source: extra.domain_source || null,
      source_path: extra.domain_source_path || null,
      description_excerpt: extra.description_excerpt || '',
    },
    domain_agnostic: true,
    atris_specific_code_required: false,
    capabilities_used: GENERALIST_CAPABILITIES,
    llm_source: extra.llm_source || null,
    llm_error: extra.llm_error || null,
    world_model: {
      entities: [],
      relationships: [],
    },
    problems: [],
    objectives: [],
    causal_patterns: [],
    transfer_patterns: [],
    solution_plan: [],
    meta_cognition: {
      assumptions: [],
      risks: [],
      missing_data: [],
    },
    architecture_improvement: '',
    emergent_capability: '',
    proof: '',
  };
}

function normalizeGeneralistEntity(entity) {
  const name = compactSentence(entity?.name || entity?.entity || entity, 120);
  if (!name) return null;
  const type = compactSentence(String(entity?.type || 'concept').toLowerCase(), 40).replace(/[^a-z0-9_-]/g, '-') || 'concept';
  return { type, name };
}

function normalizeGeneralistRelationship(relationship) {
  const from = compactSentence(relationship?.from || relationship?.source || '', 120);
  const to = compactSentence(relationship?.to || relationship?.target || '', 120);
  if (!from || !to) return null;
  const type = compactSentence(String(relationship?.type || relationship?.relationship || 'affects').toLowerCase(), 60).replace(/[^a-z0-9_-]/g, '-') || 'affects';
  return { from, to, type };
}

function normalizeGeneralistAnalysis(raw, extra = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const proof = emptyGeneralistProof(extra);
  const worldModel = raw.world_model && typeof raw.world_model === 'object' ? raw.world_model : raw;
  const domainName = compactSentence(raw.domain?.name || raw.domain_name || extra.domain_name || proof.domain.name, 120);
  proof.status = extra.status || raw.status || 'ok';
  proof.domain = {
    name: domainName,
    source: extra.domain_source || proof.domain.source,
    source_path: extra.domain_source_path || proof.domain.source_path,
    description_excerpt: compactSentence(raw.domain?.summary || raw.domain_summary || extra.description_excerpt || proof.domain.description_excerpt, 800),
  };
  proof.llm_source = extra.llm_source || raw.llm_source || null;
  proof.llm_error = extra.llm_error || raw.llm_error || null;

  const entities = (Array.isArray(worldModel.entities) ? worldModel.entities : [])
    .map(normalizeGeneralistEntity)
    .filter(Boolean);
  const relationships = (Array.isArray(worldModel.relationships) ? worldModel.relationships : [])
    .map(normalizeGeneralistRelationship)
    .filter(Boolean);
  proof.world_model = { entities, relationships };

  proof.problems = (Array.isArray(raw.problems) ? raw.problems : [])
    .map((problem) => ({
      problem: compactSentence(problem?.problem || problem?.name || problem?.title || '', 240),
      evidence: compactSentence(problem?.evidence || problem?.reason || '', 420),
      impact_score: score1to10(problem?.impact_score || problem?.score) || 7,
    }))
    .filter((problem) => problem.problem);

  const rawObjectives = Array.isArray(raw.objectives) ? raw.objectives : [];
  if (raw.proposed_objective || raw.objective) rawObjectives.unshift(raw);
  proof.objectives = rawObjectives
    .map((objective) => {
      const impact = score1to10(objective?.impact_score) || 7;
      const urgency = score1to10(objective?.urgency_score) || 7;
      const alignment = score1to10(objective?.alignment_score) || 7;
      return {
        objective: compactSentence(objective?.objective || objective?.proposed_objective || objective?.title || '', 260),
        impact_score: impact,
        urgency_score: urgency,
        alignment_score: alignment,
        overall_score: Number(((impact + urgency + alignment) / 3).toFixed(2)),
        justification: compactSentence(objective?.justification || objective?.reason || '', 520),
        suggested_owner: compactSentence(objective?.suggested_owner || objective?.suggested_member || '', 100),
      };
    })
    .filter((objective) => objective.objective);

  proof.causal_patterns = (Array.isArray(raw.causal_patterns) ? raw.causal_patterns : [])
    .map((pattern) => ({
      action: compactSentence(pattern?.action || pattern?.cause || '', 220),
      outcome: compactSentence(pattern?.outcome || pattern?.effect || '', 260),
      confidence: score1to10(pattern?.confidence) || 6,
      counterevidence: compactSentence(pattern?.counterevidence || '', 260),
    }))
    .filter((pattern) => pattern.action && pattern.outcome);

  proof.transfer_patterns = (Array.isArray(raw.transfer_patterns) ? raw.transfer_patterns : [])
    .map((pattern) => ({
      source_pattern: compactSentence(pattern?.source_pattern || pattern?.pattern || pattern?.name || '', 260),
      application: compactSentence(pattern?.application || pattern?.target_application || '', 420),
      reason: compactSentence(pattern?.reason || '', 320),
    }))
    .filter((pattern) => pattern.source_pattern || pattern.application);

  proof.solution_plan = (Array.isArray(raw.solution_plan) ? raw.solution_plan : [])
    .map((step, index) => ({
      step: compactSentence(step?.step || step?.action || step, 260),
      owner: compactSentence(step?.owner || step?.role || '', 120),
      expected_outcome: compactSentence(step?.expected_outcome || step?.outcome || '', 300),
      order: Number.isFinite(Number(step?.order)) ? Number(step.order) : index + 1,
    }))
    .filter((step) => step.step);

  const meta = raw.meta_cognition && typeof raw.meta_cognition === 'object' ? raw.meta_cognition : {};
  proof.meta_cognition = {
    assumptions: (Array.isArray(meta.assumptions) ? meta.assumptions : []).map((item) => compactSentence(item, 240)).filter(Boolean),
    risks: (Array.isArray(meta.risks) ? meta.risks : []).map((item) => compactSentence(item, 240)).filter(Boolean),
    missing_data: (Array.isArray(meta.missing_data) ? meta.missing_data : []).map((item) => compactSentence(item, 240)).filter(Boolean),
  };
  proof.architecture_improvement = compactSentence(raw.architecture_improvement || '', 500);
  proof.emergent_capability = compactSentence(raw.emergent_capability || raw.emergent_capability_discovery || '', 500);
  proof.proof = compactSentence(raw.proof || '', 700);

  if (!proof.world_model.entities.length || !proof.world_model.relationships.length || !proof.objectives.length) return null;
  return proof;
}

function generalistReusablePatterns(transferPatterns = [], domainName = '', objective = '') {
  const nonProjectPatterns = (Array.isArray(transferPatterns) ? transferPatterns : [])
    .filter((pattern) => pattern?.cross_domain_pattern || !/\batris\b|signal-scout|obelisk|wiki-miner|objective-generator/i.test(JSON.stringify(pattern || {})));
  const matches = objectivePatternMatches(nonProjectPatterns, `${domainName} ${objective}`, 3)
    .map((pattern) => ({
      source_pattern: pattern.pattern || pattern.source_pattern,
      application: `Apply to ${domainName} by turning the bottleneck into a small measured intervention.`,
      reason: pattern.cross_domain_pattern
        ? `Reused cross-domain pattern with success rate ${Number(pattern.success_rate || 0).toFixed(2)} across ${pattern.domain_count || 1} domain(s).`
        : pattern.reason || 'Reusable pattern matched the domain objective.',
      pattern_id: pattern.id || null,
    }));
  if (matches.length) return matches;
  return [{
    source_pattern: 'bottleneck signal -> small controlled intervention -> outcome receipt -> next objective',
    application: `Apply to ${domainName} by measuring one operational bottleneck, changing one lever, and reviewing the outcome before scaling.`,
    reason: 'Generic transfer pattern applies across operational domains without project-specific assumptions.',
  }];
}

function fallbackGeneralistAnalysis(domain, transferPatterns = []) {
  const text = String(domain.description || '');
  const isRestaurant = /restaurant|kitchen|dining|reservation|table|menu|server|host|guest|chef/i.test(text);
  const domainName = domain.name || (isRestaurant ? 'restaurant operations' : 'external domain');
  const customerName = isRestaurant ? 'guests' : 'customers';
  const frontRole = isRestaurant ? 'front-of-house staff' : 'operators';
  const deliveryRole = isRestaurant ? 'kitchen staff' : 'delivery team';
  const intakeFlow = isRestaurant ? 'reservation and seating flow' : 'intake flow';
  const throughputFlow = isRestaurant ? 'table turnover and order throughput' : 'service throughput';
  const capacityResource = isRestaurant ? 'tables, prep capacity, and inventory' : 'available capacity';
  const qualityMetric = isRestaurant ? 'peak wait time and guest satisfaction' : 'lead time and customer satisfaction';
  const objective = isRestaurant
    ? 'Reduce peak-service wait time by aligning reservations, seating, kitchen capacity, and staffing to demand'
    : `Reduce the main ${domainName} service bottleneck by aligning demand, capacity, and feedback loops`;

  const transferMatches = generalistReusablePatterns(transferPatterns, domainName, objective);
  return normalizeGeneralistAnalysis({
    domain: {
      name: domainName,
      summary: domain.description_excerpt,
    },
    world_model: {
      entities: [
        { type: 'system', name: domainName },
        { type: 'role', name: frontRole },
        { type: 'role', name: deliveryRole },
        { type: 'customer', name: customerName },
        { type: 'process', name: intakeFlow },
        { type: 'process', name: throughputFlow },
        { type: 'resource', name: capacityResource },
        { type: 'metric', name: qualityMetric },
      ],
      relationships: [
        { from: frontRole, to: intakeFlow, type: 'owns' },
        { from: intakeFlow, to: throughputFlow, type: 'depends-on' },
        { from: deliveryRole, to: throughputFlow, type: 'owns' },
        { from: capacityResource, to: throughputFlow, type: 'constrains' },
        { from: throughputFlow, to: qualityMetric, type: 'causes' },
        { from: qualityMetric, to: customerName, type: 'affects' },
      ],
    },
    problems: [
      {
        problem: isRestaurant ? 'Peak demand creates seating and kitchen bottlenecks that raise wait time' : 'Demand and capacity are not aligned tightly enough to protect service quality',
        evidence: 'The domain description names operating roles, queues, resources, and service outcomes that can be modeled as a throughput system.',
        impact_score: 9,
      },
      {
        problem: isRestaurant ? 'Prep and inventory mismatch can create stockouts or waste' : 'Resource planning likely lags real demand signals',
        evidence: 'Capacity resources directly constrain the throughput process.',
        impact_score: 8,
      },
    ],
    objectives: [
      {
        objective,
        impact_score: 9,
        urgency_score: 8,
        alignment_score: 9,
        justification: `The world model links ${intakeFlow}, ${throughputFlow}, ${capacityResource}, and ${qualityMetric}; improving that path should improve the domain outcome directly.`,
        suggested_owner: isRestaurant ? 'general manager' : 'domain operator',
      },
    ],
    causal_patterns: [
      {
        action: isRestaurant ? 'Stagger reservations and hold surge capacity during peak windows' : 'Smooth demand arrival and reserve capacity for peak windows',
        outcome: isRestaurant ? 'Lower host stand queue and fewer kitchen spikes' : 'Lower queue depth and fewer service spikes',
        confidence: 7,
        counterevidence: 'Needs baseline wait-time and throughput data before claiming outcome.',
      },
      {
        action: isRestaurant ? 'Set prep par levels from recent covers and menu mix' : 'Set resource levels from recent demand mix',
        outcome: isRestaurant ? 'Fewer stockouts and less waste' : 'Fewer missed requests and less idle capacity',
        confidence: 6,
        counterevidence: 'Demand volatility may require daily adjustment.',
      },
    ],
    transfer_patterns: transferMatches,
    solution_plan: [
      { step: 'Instrument the current bottleneck with one week of timestamps, volume, capacity, and outcome metrics', owner: isRestaurant ? 'general manager' : 'domain operator', expected_outcome: 'Baseline identifies the highest-leverage constraint' },
      { step: isRestaurant ? 'Pilot reservation staggering, table-turn targets, and prep par adjustments in one peak service window' : 'Pilot one demand-smoothing and capacity-alignment change in one operating window', owner: frontRole, expected_outcome: 'Smaller queue spikes with limited operational risk' },
      { step: 'Review the outcome receipt and either scale, revert, or pick the next bottleneck', owner: deliveryRole, expected_outcome: 'Causal evidence updates the next objective' },
    ],
    meta_cognition: {
      assumptions: ['The domain description is accurate enough to build an initial world model.', 'The highest-value first step is local measurement plus a reversible pilot.'],
      risks: ['Optimizing one metric could harm quality if the review misses secondary effects.', 'External constraints may change during the pilot.'],
      missing_data: [isRestaurant ? 'Hourly covers, wait times, table turns, stockouts, labor schedule, and guest complaints' : 'Arrival rate, service time, capacity, quality outcomes, and exception logs'],
    },
    architecture_improvement: 'Keep each domain proof in its own world model so the same reasoning loop can be reused without hardcoded project entities.',
    emergent_capability: 'Domain translation: convert unfamiliar operating text into entities, constraints, objectives, causal tests, and transfer candidates.',
    proof: 'The proof was generated from the supplied domain description and generic transfer patterns, without reading the project wiki graph or relying on project-specific entities.',
  }, {
    status: 'ok',
    domain_name: domainName,
    domain_source: domain.source,
    domain_source_path: domain.source_path,
    description_excerpt: domain.description_excerpt,
    llm_error: 'llm_not_configured',
  });
}

function generalistPrompt(domain, transferPatterns = []) {
  return `Analyze this domain description with the same eight AGI capabilities:
1. autonomous problem discovery
2. world model
3. meta-cognition
4. objective setting
5. causal reasoning
6. transfer learning
7. architecture self-improvement
8. emergent capability discovery

Build the model from this domain only. Do not assume Atris-specific entities, software workflows, or project wiki knowledge.

Return JSON:
{
  "domain": {"name": "...", "summary": "..."},
  "world_model": {
    "entities": [{"type": "person|system|concept|role|process|resource|metric", "name": "..."}],
    "relationships": [{"from": "...", "to": "...", "type": "uses|depends-on|owns|causes|affects|constrains"}]
  },
  "problems": [{"problem": "...", "evidence": "...", "impact_score": 1-10}],
  "objectives": [{"objective": "...", "impact_score": 1-10, "urgency_score": 1-10, "alignment_score": 1-10, "justification": "...", "suggested_owner": "..."}],
  "causal_patterns": [{"action": "...", "outcome": "...", "confidence": 1-10, "counterevidence": "..."}],
  "transfer_patterns": [{"source_pattern": "...", "application": "...", "reason": "..."}],
  "solution_plan": [{"step": "...", "owner": "...", "expected_outcome": "..."}],
  "meta_cognition": {"assumptions": ["..."], "risks": ["..."], "missing_data": ["..."]},
  "architecture_improvement": "How this improves the general AGI loop",
  "emergent_capability": "New reusable capability discovered",
  "proof": "Why this is cross-domain and not project-specific"
}

Domain name: ${domain.name}
Domain source: ${domain.source}
Domain content:
${domain.description.slice(0, 12000)}

Reusable non-project transfer patterns:
${JSON.stringify((transferPatterns || []).slice(0, 20))}`;
}

function injectedGeneralistAnalysis() {
  if (!process.env.ATRIS_GENERALIST_LLM_JSON) return null;
  const parsed = parseJsonObjectFromText(process.env.ATRIS_GENERALIST_LLM_JSON);
  return parsed
    ? { source: 'env_json', analysis: parsed }
    : { source: 'env_json', error: 'invalid_json' };
}

async function callGeneralistLlm(domain, transferPatterns = []) {
  const injected = injectedGeneralistAnalysis();
  if (injected) return injected;
  if (process.env.ATRIS_GENERALIST_LLM !== '1') return null;
  try {
    const { postTurn } = require('../ax');
    const output = { isTTY: false, write() { return true; } };
    const result = await postTurn(generalistPrompt(domain, transferPatterns), {
      mode: process.env.ATRIS_GENERALIST_LLM_MODE || 'fast',
      route: 'local',
      cwd: process.cwd(),
      output,
      color: false,
    });
    const parsed = parseJsonObjectFromText(result?.output || '');
    return parsed
      ? { source: 'atris2_backend', analysis: parsed }
      : { source: 'atris2_backend', error: 'missing_json_response' };
  } catch (error) {
    return {
      source: 'atris2_backend',
      error: compactSentence(error instanceof Error ? error.message : String(error), 220),
    };
  }
}

async function runGeneralistWake(name, paths, { execute = false, domainInput = {} } = {}) {
  const mode = execute ? 'execute' : 'dry_run';
  const root = process.cwd();
  const domain = resolveGeneralistDomainInput(root, domainInput);
  const transferPatterns = readTransferPatterns(root);
  const crossDomainLibraryBefore = readCrossDomainPatternLibrary(root);
  const crossDomainMatches = crossDomainPatternMatches(crossDomainLibraryBefore, domain.name, domain.description, 5);
  const reusablePatterns = crossDomainPatternInputs(crossDomainMatches, transferPatterns);
  let llm = null;
  let proof = null;
  let learning = null;
  let reason = execute ? 'cross_domain_proof_written' : 'cross_domain_proof_dry_run';

  if (!domain.ok) {
    reason = 'missing_domain_input';
    proof = emptyGeneralistProof({
      status: 'missing_domain_input',
      domain_name: domain.name,
      domain_source: domain.source,
      domain_source_path: domain.source_path,
      description_excerpt: domain.description_excerpt,
      llm_error: domain.error,
    });
    proof.proof = 'No domain description was provided. Pass --domain-file, --domain, or ATRIS_GENERALIST_DOMAIN.';
  } else {
    llm = await callGeneralistLlm(domain, reusablePatterns);
    if (llm?.analysis) {
      proof = normalizeGeneralistAnalysis(llm.analysis, {
        status: 'ok',
        domain_name: domain.name,
        domain_source: domain.source,
        domain_source_path: domain.source_path,
        description_excerpt: domain.description_excerpt,
        llm_source: llm.source,
      });
      if (!proof) {
        reason = 'llm_json_parse_failed_heuristic_used';
        proof = fallbackGeneralistAnalysis(domain, reusablePatterns);
        proof.llm_source = llm.source;
        proof.llm_error = 'invalid_analysis_shape';
      }
    } else if (llm?.error) {
      reason = llm.error === 'invalid_json' ? 'llm_json_parse_failed_heuristic_used' : 'llm_analysis_failed_heuristic_used';
      proof = fallbackGeneralistAnalysis(domain, reusablePatterns);
      proof.llm_source = llm.source || null;
      proof.llm_error = llm.error;
    } else {
      reason = 'heuristic_cross_domain_proof_written';
      proof = fallbackGeneralistAnalysis(domain, reusablePatterns);
    }
  }

  const proofsDir = generalistProofsDir(root);
  fs.mkdirSync(proofsDir, { recursive: true });
  const proofPath = path.join(proofsDir, `${domain.slug}-${fileSafeStamp()}.json`);
  const latestProofPath = generalistLatestProofPath(root);
  const runsDir = path.join(root, 'atris', 'runs');
  fs.mkdirSync(runsDir, { recursive: true });
  const receiptPath = path.join(runsDir, `generalist-tick-${fileSafeStamp()}.json`);
  learning = learnCrossDomainPatterns(root, proof, {
    execute: execute && domain.ok && proof.status === 'ok',
    record: domain.ok && proof.status === 'ok',
    libraryBefore: crossDomainLibraryBefore,
    receiptPath,
    proofPath,
  });
  proof.learning = {
    library_path: path.relative(root, learning.library_path),
    reused_pattern_count: learning.reused_pattern_count,
    observed_pattern_count: learning.observed_pattern_count,
    learning_improved: learning.learning_improved,
    before_metrics: learning.before_metrics,
    after_metrics: learning.after_metrics,
    reused_patterns: learning.reused_patterns,
  };
  if (execute) {
    fs.writeFileSync(proofPath, JSON.stringify(proof, null, 2) + '\n', 'utf8');
    fs.writeFileSync(latestProofPath, JSON.stringify(proof, null, 2) + '\n', 'utf8');
  }

  const receipt = {
    schema: 'atris.generalist_tick.v1',
    created_at: stampIso(),
    member: name,
    mode,
    executed: execute,
    ok: domain.ok && proof.status === 'ok',
    advisory_only: true,
    decision: 'cross_domain_generalize',
    reason,
    domain_name: proof.domain.name,
    domain_source: domain.source,
    domain_source_path: domain.source_path,
    domain_agnostic: true,
    atris_specific_code_required: false,
    capabilities_used: GENERALIST_CAPABILITIES,
    world_model_entities: proof.world_model.entities.length,
    world_model_relationships: proof.world_model.relationships.length,
    problem_count: proof.problems.length,
    objective_count: proof.objectives.length,
    causal_pattern_count: proof.causal_patterns.length,
    transfer_pattern_count: proof.transfer_patterns.length,
    transfer_patterns_scanned: transferPatterns.length,
    cross_domain_patterns_path: path.relative(root, crossDomainPatternsPath(root)),
    cross_domain_patterns_scanned: Array.isArray(crossDomainLibraryBefore.patterns) ? crossDomainLibraryBefore.patterns.length : 0,
    cross_domain_pattern_matches: crossDomainMatches.map((pattern) => ({
      id: pattern.id,
      pattern: pattern.pattern,
      domains: pattern.domains,
      success_rate: pattern.success_rate,
      domain_count: pattern.domain_count,
      match_score: pattern.match_score,
      reason: pattern.reason,
    })),
    cross_domain_learning: {
      library_path: path.relative(root, learning.library_path),
      reused_pattern_count: learning.reused_pattern_count,
      observed_pattern_count: learning.observed_pattern_count,
      learning_improved: learning.learning_improved,
      before_metrics: learning.before_metrics,
      after_metrics: learning.after_metrics,
      reused_patterns: learning.reused_patterns,
      run: learning.run,
    },
    llm_source: llm?.source || proof.llm_source || null,
    llm_successful: Boolean(llm?.source && llm?.analysis && proof.status === 'ok' && !proof.llm_error),
    llm_error: llm?.error || proof.llm_error || null,
    proof_path: execute ? path.relative(root, proofPath) : null,
    latest_proof_path: execute ? path.relative(root, latestProofPath) : null,
    top_objective: proof.objectives[0] || null,
    proof,
  };
  fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n', 'utf8');
  const logPath = appendMemberGoalLog(paths.memberDir, name, 'Generalist cross-domain tick', {
    mode,
    reason,
    domain: proof.domain.name,
    capabilities: GENERALIST_CAPABILITIES.length,
    world_entities: receipt.world_model_entities,
    world_relationships: receipt.world_model_relationships,
    objective: proof.objectives[0]?.objective || '',
    llm_source: receipt.llm_source || '',
    llm_error: receipt.llm_error || '',
    pattern_library: receipt.cross_domain_patterns_path,
    reused_patterns: learning.reused_pattern_count,
    reuse_rate: learning.after_metrics.pattern_reuse_rate,
    cross_domain_success_rate: learning.after_metrics.cross_domain_success_rate,
    receipt: path.relative(root, receiptPath),
    proof: receipt.proof_path || '',
  });

  return {
    ok: true,
    action: 'wake',
    member: name,
    mode,
    decision: 'cross_domain_generalize',
    reason,
    executed: execute,
    needs_user: !domain.ok,
    ask: domain.ok ? null : 'Pass --domain-file <path> or --domain "<description>".',
    next_command: 'atris member generalist proof',
    receipt_path: receiptPath,
    log_path: logPath,
    proof_path: execute ? proofPath : null,
    latest_proof_path: execute ? latestProofPath : null,
    generalist: receipt,
  };
}

async function processDomainFile(domainPath, { name = 'generalist', paths = null, execute = false } = {}) {
  const root = process.cwd();
  const resolvedPaths = paths || memberPaths(name);
  const fullPath = path.isAbsolute(domainPath) ? domainPath : path.join(root, domainPath);
  return runGeneralistWake(name, resolvedPaths, {
    execute,
    domainInput: {
      file: normalizeRelativeProofPath(root, fullPath),
    },
  });
}

function memberGeneralistProof(...args) {
  const asJson = hasFlag(args, '--json');
  const latestPath = generalistLatestProofPath(process.cwd());
  let payload;
  if (fs.existsSync(latestPath)) {
    try {
      payload = JSON.parse(fs.readFileSync(latestPath, 'utf8'));
    } catch (error) {
      payload = emptyGeneralistProof({
        status: 'parse_error',
        llm_error: compactSentence(error instanceof Error ? error.message : String(error), 220),
      });
    }
  } else {
    payload = emptyGeneralistProof({ status: 'missing' });
  }
  const objective = payload.objectives?.[0] || null;
  const lines = payload.status === 'missing'
    ? ['No generalist proof found. Run: atris member wake generalist --execute --domain-file <path>']
    : [
        `Generalist proof: ${payload.status}`,
        `Domain: ${payload.domain?.name || 'external domain'}`,
        objective?.objective ? `Objective: ${objective.objective}` : '',
        Number.isFinite(Number(objective?.overall_score)) ? `Score: ${objective.overall_score}` : '',
        `Capabilities: ${Array.isArray(payload.capabilities_used) ? payload.capabilities_used.length : 0}`,
        payload.proof ? `Proof: ${payload.proof}` : '',
      ].filter(Boolean);
  printJsonOrText({ ok: payload.status !== 'missing', action: 'generalist_proof', proof_path: latestPath, proof: payload }, lines, asJson);
}

function memberGeneralistPatterns(...args) {
  const asJson = hasFlag(args, '--json');
  const libraryPath = crossDomainPatternsPath(process.cwd());
  const library = readCrossDomainPatternLibrary(process.cwd());
  const lines = library.status === 'missing'
    ? ['No cross-domain pattern library found. Run: atris member wake generalist --execute --domain-file <path>']
    : [
        `Cross-domain patterns: ${library.patterns.length}`,
        `Domains solved: ${library.metrics.domains_solved_count}`,
        `Reuse rate: ${library.metrics.pattern_reuse_rate}`,
        `Cross-domain success rate: ${library.metrics.cross_domain_success_rate}`,
        ...(library.patterns || []).slice(0, 5).map((pattern) => `Pattern: ${pattern.pattern} (${pattern.domain_count} domains, success ${pattern.success_rate})`),
      ];
  printJsonOrText({ ok: library.status !== 'missing', action: 'generalist_patterns', patterns_path: libraryPath, library }, lines, asJson);
}

function memberGeneralistCommand(command, ...args) {
  if (command === 'proof') return memberGeneralistProof(...args);
  if (command === 'patterns') return memberGeneralistPatterns(...args);
  console.log('Usage: atris member generalist <proof|patterns> [--json]');
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

function wakeDecision(name, paths, { force = false, runtimeKind = memberRuntimeKind(name) } = {}) {
  const purpose = missionPurpose(paths);
  const steering = readSteeringMemory(paths, name);
  const state = loadMemberGoals(name, paths);
  const goal = activeGoal(state);
  const current = memberOpenExperiment(state);
  const isGeneralist = lowerCompact(name) === 'generalist';
  if (isGeneralist && purpose.meaningful) {
    const domainFile = findUnprocessedGeneralistDomainFile(process.cwd());
    if (domainFile) {
      return {
        decision: 'process_domain_file',
        reason: `generalist_domain_scan:${domainFile.status}`,
        needs_user: false,
        ask: null,
        next_command: `atris member wake ${name} --execute --domain-file ${domainFile.path} --json`,
        state,
        goal: goal || null,
        current_experiment: current || null,
        checks: {
          has_member: true,
          has_mission: true,
          mission_meaningful: true,
          has_goal: Boolean(goal),
          has_open_experiment: Boolean(current),
          has_unprocessed_domain_file: true,
          domain_scan_window_minutes: 60,
          checked_existing_tasks: false,
        },
        mission: {
          north_star: purpose.northStar || null,
          runtime_id: purpose.runtimeMission.id || null,
          runtime_status: purpose.runtimeMission.status || null,
          runtime_next: purpose.runtimeMission.next || null,
        },
        steering,
        evidence: {
          generalist_domain_scan: domainFile,
          task_projection: null,
          nearest_open_loop: null,
        },
        workspace: null,
        domain_file: domainFile,
      };
    }
  }
  const rawDirective = steeringWakeDirective(steering, name, goal);
  const directiveClosure = rawDirective ? steeringDirectiveClosure(rawDirective) : null;
  const directive = directiveClosure?.all_closed ? null : rawDirective;
  const evidence = collectWakeEvidence(name, goal, purpose, runtimeKind);
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

async function runMemberWake(name, { execute = false, confirmed = false, force = false, domainInput = {} } = {}) {
  const paths = requireMemberDir(name);
  const runtimeKind = paths.runtimeKind || memberRuntimeKind(name);
  if (runtimeKind === 'auto-improver') {
    return runAutoImproverWake(name, paths, { execute, confirmed });
  }
  const isGeneralist = runtimeKind === 'generalist';
  const hasGeneralistDomainInput = Boolean(
    domainInput.file
    || domainInput.text
    || process.env.ATRIS_GENERALIST_DOMAIN_FILE
    || process.env.ATRIS_GENERALIST_DOMAIN,
  );
  if (isGeneralist && hasGeneralistDomainInput) {
    return runGeneralistWake(name, paths, { execute, domainInput });
  }
  if (runtimeKind === 'objective-generator') {
    return runObjectiveGeneratorWake(name, paths, { execute });
  }
  if (runtimeKind === 'supervisor') {
    return runSupervisorWake(name, paths, { execute });
  }
  if (runtimeKind === 'wiki-miner') {
    return runWikiMinerWake(name, paths, { execute });
  }
  const planned = wakeDecision(name, paths, { force, runtimeKind });
  if (isGeneralist && planned.decision === 'process_domain_file' && planned.domain_file?.path) {
    return processDomainFile(planned.domain_file.path, { name, paths, execute });
  }
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
  const domainInput = {
    text: readFlag(args, '--domain', ''),
    file: readFlag(args, '--domain-file', ''),
    name: readFlag(args, '--domain-name', ''),
  };
  const result = await runMemberWake(name, { execute, confirmed, force, domainInput });
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
  const agentFlag = String(readFlag(args, '--agent', '') || '').trim().toLowerCase();
  const agent = agentFlag === 'claude' ? 'claude' : agentFlag === 'codex' ? 'codex' : undefined;
  const model = String(readFlag(args, '--model', '') || '').trim() || undefined;
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
  // Stop spinning: if the member can do no real work for this many ticks in a row (waiting on a
  // human review, blocked, or no goal), break early and surface a clear handoff instead of
  // burning every remaining tick on the same no-op decision.
  let earlyExit = null;
  let consecutiveIdle = 0;
  const idleBreakThreshold = 2;

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
            agent,
            model,
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
            productive: alive.status === 'completed',
            blocked_on_human: alive.blocked_on_human === true,
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
          productive: wake.executed === true
            || /executed/.test(wake.reason || '')
            || ['tick', 'close_loop', 'report_proof', 'create_missing_task', 'create_task', 'set_objective'].includes(wake.decision),
          blocked_on_human: wake.needs_user === true || /^open_experiment_/.test(wake.reason || ''),
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
      if (execute) {
        const last = tickResults[tickResults.length - 1];
        if (last && last.productive) {
          consecutiveIdle = 0;
        } else if (last) {
          consecutiveIdle += 1;
          if (consecutiveIdle >= idleBreakThreshold) {
            earlyExit = {
              after_tick: last.tick,
              decision: last.decision || null,
              reason: last.reason || 'idle',
              needs_user: last.needs_user === true,
              blocked_on_human: last.blocked_on_human === true || last.needs_user === true,
              next_command: last.next_command || null,
            };
            break;
          }
        }
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
    status: failed ? 'failed' : stopped ? 'stopped' : earlyExit ? (earlyExit.blocked_on_human ? 'blocked_on_human' : 'idle') : 'completed',
    mode: execute ? 'execute' : 'dry_run',
    run_id: runId,
    ticks_requested: ticks,
    ticks: tickResults.length,
    interval_ms: intervalMs,
    duration_ms_requested: durationMs,
    duration_ms_actual: Date.parse(finishedAt) - Date.parse(startedAt),
    decisions,
    early_exit: earlyExit,
    blocked_on_human: earlyExit?.blocked_on_human === true,
    needs_user: earlyExit?.needs_user === true,
    next_command: earlyExit?.next_command || null,
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
  const evidence = collectWakeEvidence(name, goal, null, paths.runtimeKind || memberRuntimeKind(name));
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

function memberHistory(name, ...args) {
  const { spawnSync } = require('child_process');

  const paths = requireMemberDir(name);
  const asJson = hasFlag(args, '--json');
  const limitArg = readNumberFlag(args, '--limit', null);
  const limit = limitArg !== null ? Math.max(1, limitArg) : null;

  // resolve files to track: MEMBER.md + SOUL.md if present
  const filesToTrack = [];
  if (fs.existsSync(paths.memberFile)) {
    filesToTrack.push(paths.memberFile);
  }
  const soulPath = path.join(paths.memberDir, 'SOUL.md');
  if (fs.existsSync(soulPath)) {
    filesToTrack.push(soulPath);
  }

  if (filesToTrack.length === 0) {
    // no files exist yet (unborn member); empty history ok
    const payload = {
      ok: true,
      action: 'history',
      member: name,
      files: [],
    };
    printJsonOrText(payload, [`identity history: ${name}`, '(no files found)'], asJson);
    return;
  }

  // run git log for each file
  const cwd = process.cwd();
  const fileHistories = [];

  for (const filePath of filesToTrack) {
    const relativePath = path.relative(cwd, filePath);
    const result = spawnSync('git', ['log', '--follow', '--pretty=format:%h|%ai|%s', '--', relativePath], {
      cwd,
      encoding: 'utf8',
    });

    let commits = [];
    if (result.status === 0 && result.stdout) {
      const lines = result.stdout.trim().split('\n').filter(Boolean);
      commits = lines.map((line) => {
        const [hash, date, subject] = line.split('|');
        return { hash: hash || '', date: date || '', subject: subject || '' };
      });

      // apply limit if specified
      if (limit !== null) {
        commits = commits.slice(0, limit);
      }
    }

    fileHistories.push({
      path: relativePath,
      commits,
    });
  }

  // render output
  if (asJson) {
    const payload = {
      ok: true,
      action: 'history',
      member: name,
      files: fileHistories,
    };
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log('');
    console.log(`identity history: ${name}`);
    console.log('');
    for (const fileHist of fileHistories) {
      console.log(`${fileHist.path}:`);
      if (fileHist.commits.length === 0) {
        console.log('  (no git history)');
      } else {
        for (const commit of fileHist.commits) {
          console.log(`  ${commit.hash} ${commit.date} ${commit.subject}`);
        }
      }
      console.log('');
    }
  }
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
    case 'history':
      return memberHistory(args[0], ...args.slice(1));
    case 'supervisor':
      return memberSupervisorCommand(args[0], ...args.slice(1));
    case 'objective-generator':
      return memberObjectiveGeneratorCommand(args[0], ...args.slice(1));
    case 'generalist':
      return memberGeneralistCommand(args[0], ...args.slice(1));
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
      console.log('  history <name>      Show git history of member identity files (MEMBER.md, SOUL.md)');
      console.log('  supervisor recommendations  Show advisory supervisor recommendations');
      console.log('  objective-generator proposals  Show autonomous objective proposal');
      console.log('  generalist proof    Show latest cross-domain generalist proof');
      console.log('  generalist patterns Show learned cross-domain pattern library');
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
      console.log('  atris member supervisor recommendations --json');
      console.log('  atris member objective-generator proposals --json');
      console.log('  atris member generalist proof --json');
      console.log('  atris member generalist patterns --json');
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
