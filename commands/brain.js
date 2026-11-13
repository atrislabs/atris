const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { refreshNowFile } = require('./now');
const { buildActivationSummary } = require('./activate');
const { ownerIdentity } = require('../utils/owner-identity');
const escapeRegExp = require('../lib/escape-regexp');
const { hasRenderedSections, isOpenSection, isDoneSection } = require('../lib/todo-sections');
const { isNonInteractive } = require('../lib/noninteractive');
const {
  renderVoiceCardBlock,
  upsertCursorVoiceCard,
  voiceCardForRoot,
} = require('../lib/voice-card');

const GENERATED_START = '<!-- ATRIS_BRAIN_COMPILE:START -->';
const GENERATED_END = '<!-- ATRIS_BRAIN_COMPILE:END -->';
const GENERATED_LOAD_ORDER_FILES = [
  'atris/now.md',
  'atris/brain/STATUS.md',
  'atris/brain/self_improvement_ledger.md',
];
const OPTIONAL_STATE_LOAD_ORDER_FILES = [
  '.atris/state/chat_scan.latest.json',
];
const OPTIONAL_LOAD_ORDER_FILES = [
  'atris/wiki/concepts/agent-activation-contract.md',
  'atris/skills/atris/SKILL.md',
  'atris/PERSONA.md',
  // A few lines an agent wrote about its own nights (`atris morning` saves
  // them). Tiny on purpose: at most 12 short lines.
  'atris/learned.md',
  'atris/MAP.md',
  'atris/TODO.md',
  'atris/wiki/index.md',
];
const CORE_STATE_FILES = [
  'events.jsonl',
  'episodes.jsonl',
  'task_episodes.jsonl',
  'scorecards.jsonl',
  'agent_tasks.jsonl',
  'agent_mail.jsonl',
  'agent_inboxes.jsonl',
  'agents.jsonl',
  'approvals.jsonl',
];
// Loop health measures loops that actually emit receipts. Channels with no writer
// anywhere in the codebase were dropped so the dashboard reports real failures, not
// never-built aspirations: "Overnight RL" duplicated the active Pulse AGI loop, and
// "Company YC" had no data source. "Master loop" is now emitted by `atris run`.
const LOOP_HEALTH_CHANNELS = [
  { label: 'Task plane', files: ['task_events.jsonl', 'tasks.projection.json'] },
  { label: 'Career XP', files: ['career_xp_receipts.jsonl', 'career_xp.projection.json', 'gm_xp.projection.json'] },
  { label: 'Master loop', files: ['master_loop_events.jsonl'] },
  { label: 'Missions', files: ['mission_events.jsonl', 'missions.jsonl'] },
  { label: 'Codex goal', files: ['codex_goal.json'] },
  { label: 'Pulse AGI', files: ['pulse_agi_loop_receipts.jsonl'] },
];
const TIMESTAMP_KEYS = new Set([
  'at',
  'created_at',
  'date',
  'generated_at',
  'last_checked_at',
  'started_at',
  'synced_at',
  'timestamp',
  'ts',
  'updated_at',
]);

function parseArgs(args) {
  const options = {
    root: process.cwd(),
    verify: false,
    json: false,
    yes: false,
    rating: null,
    recommendation: null,
    note: '',
    member: null,
    mode: null,
  };

  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--root' && args[i + 1]) {
      options.root = args[++i];
    } else if (arg.startsWith('--root=')) {
      options.root = arg.slice('--root='.length);
    } else if (arg === '--verify') {
      options.verify = true;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--yes' || arg === '-y') {
      options.yes = true;
    } else if (arg === '--rating' && args[i + 1]) {
      options.rating = args[++i];
    } else if (arg.startsWith('--rating=')) {
      options.rating = arg.slice('--rating='.length);
    } else if (arg === '--recommendation' && args[i + 1]) {
      options.recommendation = args[++i];
    } else if (arg.startsWith('--recommendation=')) {
      options.recommendation = arg.slice('--recommendation='.length);
    } else if (arg === '--note' && args[i + 1]) {
      options.note = args[++i];
    } else if (arg.startsWith('--note=')) {
      options.note = arg.slice('--note='.length);
    } else if (arg === '--member' && args[i + 1]) {
      options.member = args[++i];
    } else if (arg.startsWith('--member=')) {
      options.member = arg.slice('--member='.length);
    } else if (arg === '--mode' && args[i + 1]) {
      options.mode = args[++i];
    } else if (arg.startsWith('--mode=')) {
      options.mode = arg.slice('--mode='.length);
    } else if (!arg.startsWith('-')) {
      positional.push(arg);
    }
  }

  const subcommand = positional[0] || 'activate';
  if (!options.note && ['yes', 'no', 'edit', 'go', 'hold'].includes(subcommand) && positional.length > 1) {
    options.note = positional.slice(1).join(' ');
  }
  if (subcommand === 'approval' || subcommand === 'approve') {
    options.decision = positional[1] || null;
    if (!options.note && positional.length > 2) {
      options.note = positional.slice(2).join(' ');
    }
  }

  return {
    subcommand,
    options: {
      ...options,
      root: path.resolve(options.root),
    },
  };
}

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function appendJsonl(filePath, row) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, JSON.stringify(row) + '\n', 'utf8');
}

function sha256Text(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function shortHash(value) {
  return sha256Text(value).slice(0, 12);
}

function readJsonlStats(filePath) {
  const text = readText(filePath);
  const lines = text.split('\n').filter(line => line.trim());
  let valid = 0;
  let latestTs = null;

  for (const line of lines) {
    try {
      const row = JSON.parse(line);
      valid += 1;
      const ts = row.ts || row.timestamp || row.created_at || row.updated_at || row.sent_at || row.date;
      if (ts && (!latestTs || String(ts) > String(latestTs))) latestTs = String(ts);
    } catch {
      // Keep the raw count honest but do not fail compilation on one bad line.
    }
  }

  return {
    path: filePath,
    exists: fs.existsSync(filePath),
    rows: lines.length,
    validRows: valid,
    latestTs,
  };
}

function latestTimestampFromValue(value, depth = 0) {
  if (depth > 5 || value == null) return null;
  if (Array.isArray(value)) {
    return value
      .map(item => latestTimestampFromValue(item, depth + 1))
      .filter(Boolean)
      .sort()
      .pop() || null;
  }
  if (typeof value !== 'object') return null;

  let latest = null;
  for (const [key, child] of Object.entries(value)) {
    if (TIMESTAMP_KEYS.has(key) && (typeof child === 'string' || typeof child === 'number')) {
      const ts = String(child);
      if (!latest || ts > latest) latest = ts;
      continue;
    }
    const childTs = latestTimestampFromValue(child, depth + 1);
    if (childTs && (!latest || childTs > latest)) latest = childTs;
  }
  return latest;
}

function readJsonStats(filePath) {
  if (!fs.existsSync(filePath)) {
    return { path: filePath, exists: false, rows: 0, validRows: 0, latestTs: null };
  }
  const parsed = readJson(filePath);
  return {
    path: filePath,
    exists: true,
    rows: 1,
    validRows: parsed === null ? 0 : 1,
    latestTs: latestTimestampFromValue(parsed),
  };
}

function readStateFileStats(filePath) {
  if (filePath.endsWith('.jsonl')) return readJsonlStats(filePath);
  if (filePath.endsWith('.json')) return readJsonStats(filePath);
  return { path: filePath, exists: fs.existsSync(filePath), rows: 0, validRows: 0, latestTs: null };
}

function collectStateFileStats(stateDir) {
  const names = new Set(CORE_STATE_FILES);
  if (fs.existsSync(stateDir)) {
    for (const name of fs.readdirSync(stateDir).sort()) {
      // usage.jsonl is command telemetry written by every dispatch, not brain
      // state; counting it makes compile stats drift with invocation count.
      if (name === 'usage.jsonl') continue;
      if (name.endsWith('.json') || name.endsWith('.jsonl')) names.add(name);
    }
  }
  return Array.from(names).map(name => readStateFileStats(path.join(stateDir, name)));
}

function readJsonlRows(filePath) {
  const text = readText(filePath);
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      // Bad rows stay visible in stats; callers only use valid rows.
    }
  }
  return rows;
}

function parseGitWorktrees(text) {
  const out = [];
  let current = {};
  for (const raw of `${text || ''}\n`.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) {
      if (current.worktree) out.push(path.resolve(current.worktree));
      current = {};
      continue;
    }
    const idx = line.indexOf(' ');
    if (idx === -1) {
      current[line] = true;
    } else {
      current[line.slice(0, idx)] = line.slice(idx + 1);
    }
  }
  return out;
}

function primaryWorktreeRoot(root) {
  const result = spawnSync('git', ['worktree', 'list', '--porcelain'], {
    cwd: root,
    encoding: 'utf8',
  });
  if (result.status !== 0) return null;
  const [primary] = parseGitWorktrees(result.stdout);
  return primary || null;
}

function stateRowCount(stateDir) {
  return collectStateFileStats(stateDir)
    .reduce((sum, item) => sum + item.rows, 0);
}

function resolveStateRoots(root) {
  const primary = primaryWorktreeRoot(root);
  if (!primary || path.resolve(primary) === path.resolve(root)) return [root];

  const primaryStateDir = path.join(primary, '.atris', 'state');
  if (!fs.existsSync(primaryStateDir)) return [root];

  return stateRowCount(primaryStateDir) > 0 ? [root, primary] : [root];
}

function resolveStateRoot(root) {
  const roots = resolveStateRoots(root);
  return roots[roots.length - 1] || root;
}

function countTodoItems(todoText) {
  const text = String(todoText || '');
  // Section classification (incl. emoji-decorated headings) lives in lib/todo-sections.
  const rendered = hasRenderedSections(text);
  let section = null;
  let unchecked = 0;
  let checked = 0;
  let titled = 0;
  let legacyOpen = 0;
  let renderedOpen = 0;
  let renderedDone = 0;

  for (const line of text.split(/\r?\n/)) {
    const heading = line.match(/^##\s+(.+?)\s*$/);
    if (heading) {
      section = heading[1];
      continue;
    }

    const isUnchecked = /^\s*-\s+\[[ ]\]/.test(line);
    const isChecked = /^\s*-\s+\[[xX]\]/.test(line);
    const isTitled = /^\s*-\s+(?:\[[ xX]\]\s+)?\*\*[^*]+:?\*\*/.test(line);
    if (isUnchecked) unchecked += 1;
    if (isChecked) checked += 1;
    if (!rendered && (isUnchecked || (isTitled && !isChecked))) legacyOpen += 1;
    if (!isTitled) continue;

    titled += 1;
    if (rendered && isOpenSection(section)) renderedOpen += 1;
    if (rendered && isDoneSection(section)) renderedDone += 1;
  }

  return {
    open: rendered ? renderedOpen : legacyOpen,
    checked,
    titled,
    done: rendered ? renderedDone : checked + (text.match(/~~|DONE|✅/g) || []).length,
  };
}

function parseTodoEndgame(todoText) {
  const text = String(todoText || '');
  const fields = {};
  let inEndgame = false;

  for (const line of text.split(/\r?\n/)) {
    const heading = line.match(/^##\s+(.+?)\s*$/);
    if (heading) {
      inEndgame = heading[1].trim().toLowerCase() === 'endgame';
      continue;
    }
    if (!inEndgame) continue;

    const field = line.match(/^\*\*(Slug|Horizon|Source):\*\*\s*(.*?)\s*$/i);
    if (field) fields[field[1].toLowerCase()] = field[2].trim();
  }

  const slug = fields.slug || null;
  const horizon = fields.horizon || null;
  const source = fields.source || null;
  if (!slug && !horizon && !source) return null;
  return { slug, horizon, source };
}

const EXECUTABLE_TASK_STATUSES = new Set(['open', 'claimed']);
const COMPLETED_TASK_STATUSES = new Set(['done', 'completed', 'accepted']);

function readTaskProjectionTasks(root) {
  const projection = readJson(path.join(root, '.atris', 'state', 'tasks.projection.json'));
  const tasks = Array.isArray(projection?.tasks) ? projection.tasks : null;
  return tasks || null;
}

function isCertifiedReviewTask(task) {
  if (String(task?.status || '').toLowerCase() !== 'review') return false;
  const metadata = task.metadata || {};
  const review = task.review || {};
  const passCount = Number(metadata.agent_review_pass_count || review.agent_review_pass_count || 0);
  return Boolean(metadata.agent_certified || review.agent_certified || passCount >= 2);
}

function isAgentNeededReviewTask(task) {
  if (String(task?.status || '').toLowerCase() !== 'review') return false;
  if (isCertifiedReviewTask(task)) return false;
  const metadata = task.metadata || {};
  const review = task.review || {};
  const approvalStatus = String(metadata.approval_status || review.approval_status || 'pending').toLowerCase();
  if (approvalStatus && approvalStatus !== 'pending') return false;
  const passCount = Number(metadata.agent_review_pass_count || review.agent_review_pass_count || 0);
  return passCount < 2;
}

function summarizeTaskProjection(root) {
  const tasks = readTaskProjectionTasks(root);
  if (!tasks) return null;

  const counts = {};
  const certifiedReviewTasks = [];
  const agentNeededReviewTasks = [];
  for (const task of tasks) {
    const status = String(task?.status || '').toLowerCase();
    counts[status] = (counts[status] || 0) + 1;
    if (isAgentNeededReviewTask(task)) {
      agentNeededReviewTasks.push({
        ref: task.display_id || task.legacy_ref || task.id,
        title: task.title || 'Untitled task',
      });
    }
    if (isCertifiedReviewTask(task)) {
      certifiedReviewTasks.push({
        ref: task.display_id || task.legacy_ref || task.id,
        title: task.title || 'Untitled task',
      });
    }
  }

  return {
    tasks,
    counts,
    agentNeededReviewTasks,
    certifiedReviewTasks,
  };
}

function countTaskProjectionItems(root) {
  const summary = summarizeTaskProjection(root);
  if (!summary) return null;

  let open = 0;
  let done = 0;
  for (const [status, count] of Object.entries(summary.counts)) {
    if (EXECUTABLE_TASK_STATUSES.has(status)) open += count;
    if (COMPLETED_TASK_STATUSES.has(status)) done += count;
  }

  return {
    open,
    checked: done,
    titled: summary.tasks.length,
    done,
  };
}

function countWorkItems(root, todoText) {
  return countTaskProjectionItems(root) || countTodoItems(todoText);
}

function listMarkdown(root, relDir, limit = 12) {
  const dir = path.join(root, relDir);
  if (!fs.existsSync(dir)) return [];
  const out = [];

  function walk(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (out.length >= limit) return;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        out.push(path.relative(root, full).replace(/\\/g, '/'));
      }
    }
  }

  walk(dir);
  return out;
}

function firstHeading(text, fallback) {
  const match = String(text || '').match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : fallback;
}

function scorecardTs(row) {
  return String(row?.ts || row?.episode_created_at || '');
}

function isNextMoveScorecard(row) {
  if (!row) return false;
  if (row.type === 'scorecard') return true;
  return row.schema === 'atris.brain.scorecard.v1' && row.source === 'operator_feedback';
}

function collectState(root) {
  const atrisDir = path.join(root, 'atris');
  const stateRoot = resolveStateRoot(root);
  const stateRoots = resolveStateRoots(root);
  const stateDirs = stateRoots.map(item => path.join(item, '.atris', 'state'));
  const business = readJson(path.join(root, '.atris', 'business.json')) || {};
  const todoText = readText(path.join(atrisDir, 'TODO.md'));
  const mapText = readText(path.join(atrisDir, 'MAP.md'));
  const nowText = readText(path.join(atrisDir, 'now.md'));
  const wikiStatus = readText(path.join(atrisDir, 'wiki', 'STATUS.md'));
  const status = readText(path.join(atrisDir, 'STATUS.md'));

  const stateFiles = stateDirs.flatMap(stateDir => collectStateFileStats(stateDir));

  const totalRows = stateFiles.reduce((sum, item) => sum + item.rows, 0);
  const validRows = stateFiles.reduce((sum, item) => sum + item.validRows, 0);
  const latestScorecard = stateDirs.flatMap(stateDir => readJsonlRows(path.join(stateDir, 'scorecards.jsonl')))
    .filter(isNextMoveScorecard)
    .sort((a, b) => scorecardTs(a).localeCompare(scorecardTs(b)))
    .pop() || null;
  const latestStateTs = stateFiles
    .map(item => item.latestTs)
    .filter(Boolean)
    .sort()
    .pop() || null;

  return {
    generatedAt: new Date().toISOString(),
    root,
    name: (business.business_id && (business.name || business.slug)) || path.basename(root),
    slug: business.slug || path.basename(root),
    business,
    todo: countWorkItems(root, todoText),
    endgame: parseTodoEndgame(todoText),
    taskProjection: summarizeTaskProjection(root),
    hasNow: nowText.length > 0,
    nowHeading: firstHeading(nowText, null),
    hasMap: mapText.length > 0,
    hasWikiStatus: wikiStatus.length > 0,
    mapLineCount: mapText ? mapText.split('\n').length : 0,
    wikiPages: listMarkdown(root, 'atris/wiki', 20),
    stateFiles,
    stateRoot,
    stateRoots,
    loopHealth: buildLoopHealth(stateFiles),
    totalRows,
    validRows,
    latestScorecard: latestScorecard ? {
      task_title: latestScorecard.task_title || latestScorecard.recommendation || null,
      reward: latestScorecard.reward,
      next_task_suggestion: latestScorecard.next_task_suggestion || null,
      ts: scorecardTs(latestScorecard) || null,
    } : null,
    latestStateTs,
  };
}

function prepareBrainState(root) {
  refreshNowFile(root, { preserveCustom: true });
  return collectState(root);
}

function countStateRows(state, names) {
  const wanted = new Set(Array.isArray(names) ? names : [names]);
  return state.stateFiles
    .filter(item => wanted.has(path.basename(item.path)))
    .reduce((sum, item) => sum + item.rows, 0);
}

function stateFilesForNames(stateFiles, names) {
  const wanted = new Set(names);
  return stateFiles.filter(item => wanted.has(path.basename(item.path)));
}

function buildLoopHealth(stateFiles) {
  return LOOP_HEALTH_CHANNELS.map(channel => {
    const files = stateFilesForNames(stateFiles, channel.files);
    const rows = files.reduce((sum, item) => sum + item.rows, 0);
    const validRows = files.reduce((sum, item) => sum + item.validRows, 0);
    const latestTs = files
      .map(item => item.latestTs)
      .filter(Boolean)
      .sort()
      .pop() || null;
    return {
      label: channel.label,
      files: channel.files,
      rows,
      validRows,
      latestTs,
      active: validRows > 0,
    };
  });
}

function strongestSignal(state) {
  const scores = countStateRows(state, 'scorecards.jsonl');
  const finished = countStateRows(state, ['episodes.jsonl', 'task_episodes.jsonl']);
  const active = (state.loopHealth || buildLoopHealth(state.stateFiles || [])).filter(channel => channel.active);
  const activity = active.length ? ` recent activity comes from ${active.length} sources: ${active.map(channel => channel.label).join(', ')}.` : '';
  if (scores && finished) return `${scores} scores and ${finished} finished work records are available to guide the next step.${activity}`;
  if (scores) return `${scores} scores from past work are available to guide the next step.${activity}`;
  if (finished) return `${finished} finished work records are available to score.${activity}`;
  if (active.length) return `recent activity comes from ${active.length} sources: ${active.map(channel => channel.label).join(', ')}.`;
  const mail = countStateRows(state, 'agent_mail.jsonl');
  if (mail) return `${mail} team messages are available to guide decisions and follow-ups.`;
  const tasks = countStateRows(state, 'agent_tasks.jsonl');
  if (tasks) return `${tasks} team tasks are available to guide the next step.`;
  return 'there is little scored work yet. record feedback after the next task.';
}

function isActionableScorecardNextMove(value) {
  const text = String(value || '').trim();
  if (text.length < 12) return false;

  const metaPatterns = [
    /\bcompiled business reward\b/i,
    /\bcompleted business loop\b/i,
    /\bfallback\b/i,
    /\binstead of\b/i,
    /\bbrain\s+(scorecard|compile|feedback|approval|yes|edit|no)\b/i,
    /\bcompile the brain\b/i,
    /\bcompletion audit\b/i,
    /\bnext (move|task|action|operator loop)\b/i,
    /\bonly when there is\b/i,
    /\bprocess work\b/i,
    /\bbefore taking new work\b/i,
    /\brepeating? the completed\b/i,
    /\bscorecard suggestion\b/i,
  ];
  if (metaPatterns.some(pattern => pattern.test(text))) return false;

  return /\b(add|answer|archive|assign|build|call|choose|claim|clean|clear|close|compile|create|debug|delete|draft|edit|finish|fix|implement|ingest|open|patch|pick|pull|push|record|replace|resolve|retire|review|run|ship|sync|test|triage|update|validate|verify|write)\b/i.test(text);
}

function operatorActivationNextMove(state) {
  return `pick a team member to get a specific next step: atris brain activate --member <name> --root ${state.root}`;
}

function nextMove(state) {
  const scores = countStateRows(state, 'scorecards.jsonl');
  const finished = countStateRows(state, ['episodes.jsonl', 'task_episodes.jsonl']);
  if (state.totalRows > 0 && scores === 0) {
    if (finished > 0) return 'score finished work to help choose the next step: atris brain scorecard';
    return 'record feedback on the work so the next suggestion can improve.';
  }
  if (finished === 0) return 'record whether a suggestion was useful: atris brain yes, atris brain edit or atris brain no';
  if (state.todo.open > 0) return 'pick the most useful open task and record how it went when done.';
  if (state.latestScorecard && isActionableScorecardNextMove(state.latestScorecard.next_task_suggestion)) return state.latestScorecard.next_task_suggestion;
  return operatorActivationNextMove(state);
}

function rewardForRating(rating) {
  const normalized = String(rating || '').toLowerCase();
  if (normalized === 'approve' || normalized === 'approved' || normalized === 'send' || normalized === 'sent') return 1;
  if (normalized === 'edit' || normalized === 'edited') return 0.5;
  if (normalized === 'reject' || normalized === 'rejected' || normalized === 'no') return -1;
  throw new Error('rating must be approve, edit, or reject');
}

function latestRecommendation(root) {
  const brainState = readJson(path.join(root, 'atris', 'brain', 'state.json'));
  if (brainState) return nextMove(brainState);
  return nextMove(collectState(root));
}

function normalizeMemberSlug(memberSlug) {
  return String(memberSlug || '').toLowerCase().replace(/[^a-z0-9_-]/g, '');
}

function readMemberContext(root, memberSlug) {
  const slug = normalizeMemberSlug(memberSlug);
  if (!slug) return null;
  const memberDir = path.join(root, 'atris', 'team', slug);
  const memberText = readText(path.join(memberDir, 'MEMBER.md'));
  if (!memberText) return null;
  return {
    slug,
    name: firstHeading(memberText, slug),
    profile: memberText,
    startHere: readText(path.join(memberDir, 'START_HERE.md')),
    goals: readText(path.join(memberDir, 'goals.md')),
  };
}

function parseContributionCard(text, member) {
  if (!text || !member) return null;
  const firstName = String(member.name || member.slug || '').split(/\s+/)[0].toLowerCase();
  const sections = String(text).split(/\n(?=##\s+)/);
  const memberSections = sections.filter(section => new RegExp(`^##\\s+${escapeRegExp(firstName)}\\b`, 'i').test(section.trim()));
  const section = (
    memberSections.find(candidate => /current_score_signal\s*:/i.test(candidate))
    || memberSections[0]
    || ''
  );
  const fields = {};
  for (const line of section.split('\n')) {
    const match = line.match(/^\s*([a-z_]+):\s*(.+?)\s*$/i);
    if (match) fields[match[1].toLowerCase()] = match[2].trim();
  }

  const tableRow = text.split('\n').find(line => {
    if (!line.trim().startsWith('|')) return false;
    return line.toLowerCase().includes(`| ${firstName} |`);
  });
  if (tableRow) {
    const cells = tableRow.split('|').map(cell => cell.trim()).filter(Boolean);
    if (cells.length >= 5) {
      fields.operator ||= cells[0];
      fields.current_score_signal ||= cells[2];
      fields.current_signal ||= cells[3];
      fields.next_rep ||= cells[4];
    }
  }

  const score = fields.current_score_signal || fields.score_signal || fields.score;
  const nextRep = fields.next_rep || fields.proof_needed || fields.next_move;
  if (!score && !nextRep) return null;

  return {
    score,
    nextRep,
    proofNeeded: fields.proof_needed || '',
    why: fields.why || fields.current_signal || '',
  };
}

function memberScoreContext(root, member) {
  if (!member) return null;
  const contributionScore = readText(path.join(root, 'atris', 'state', 'contribution-score.md'));
  return parseContributionCard(contributionScore, member);
}

function listMemberSlugs(root) {
  const teamDir = path.join(root, 'atris', 'team');
  if (!fs.existsSync(teamDir)) return [];
  return fs.readdirSync(teamDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .filter(name => !name.startsWith('_'))
    .filter(name => fs.existsSync(path.join(teamDir, name, 'MEMBER.md')))
    .sort();
}

function operatorStatePath(root) {
  return path.join(root, '.atris', 'state', 'operator.json');
}

function readRememberedOperator(root) {
  const state = readJson(operatorStatePath(root));
  return state?.member || null;
}

function rememberOperator(root, member) {
  if (!member?.slug) return;
  const filePath = operatorStatePath(root);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({
    member: member.slug,
    name: member.name,
    remembered_at: new Date().toISOString(),
  }, null, 2) + '\n', 'utf8');
}

function memberNextMove(member, state = null) {
  if (!member) return null;
  const identity = `${member.slug}\n${member.name}`;
  const context = `${member.startHere}\n${member.goals}`;
  const review = state?.taskProjection?.agentNeededReviewTasks?.[0];
  const certified = state?.taskProjection?.certifiedReviewTasks?.[0];
  const reviewMove = review ? `review ${review.ref} using atris task review-chat ${review.ref} --as codex-review. run the check named in the review notes and approve or send it back without approving your own work.` : null;
  const handoff = certified ? `ask a person to review ${certified.ref}. if approved, they can run atris task accept ${certified.ref}. if changes are needed, they can run atris task revise ${certified.ref} --note "<what must change>". wait until this is settled before starting new work.` : null;
  const refs = (state?.taskProjection?.certifiedReviewTasks || []).map(task => task.ref).filter(Boolean);
  const nextGoal = refs.length && member.slug === 'codex-executor'
    ? `reviews ${refs.slice(0, 3).join(', ')} need a person to approve them. do not approve your own work. create the next task from the long-range goal ${state?.endgame?.slug || 'current goal'}: ${state?.endgame?.horizon || 'the most important gap'}. include the files, a way to check it and when to stop before editing.` : null;
  if (member.slug === 'justin' || /justin/i.test(member.name || '')) return 'take one step toward a customer, update the relevant notes within 10 minutes and record what happened.';
  if (ownerIdentity().names.includes(String(member.slug || '').toLowerCase()) || ownerIdentity().names.includes(String(member.name || '').toLowerCase())) return 'choose one important decision or improvement and name who will take the next step.';
  if (/opus|overnight/i.test(identity)) return 'run the next rl-exp2 experiment without spending money. finish one result, describe the improvement and record what happened.';
  if (/mission[- ]lead|mission lead/i.test(identity)) return 'choose or create one step, run its check, record the result and what comes next.';
  if (/validator|reviewer/i.test(identity)) return reviewMove || handoff || ((state?.todo?.open || 0) === 0 && (state?.todo?.done || 0) === 0 ? 'wait for work to review or ask the planner for a task with a way to check it, an expected result and a list of remaining risks.' : 'review the riskiest open or recently finished task, run its check, record any remaining risks and approve or block it with the result.');
  if (/executor|builder/i.test(identity)) return (state?.todo?.open || 0) === 0 ? (reviewMove || nextGoal || handoff || 'ask the planner for a task with exact files, a way to check it and when to stop before editing.') : 'work on the most useful assigned task, run its check and hand the result over for review.';
  if (/navigator|planner/i.test(identity)) return 'turn one messy request into a plan with exact files, a way to check it and a task ready for review.';
  if (/launcher|closer/i.test(identity)) return reviewMove || handoff || ((state?.todo?.done || 0) === 0 ? 'wait for a checked task or ask the reviewer for a decision.' : 'prepare one checked task for release, record what changed and the lesson, update the map or journal if needed and name the next step.');
  if (/brainstormer|idea shaper|reality shaper/i.test(identity)) return 'turn one idea into a clear goal, the current situation, one or two options, limits, success criteria and a next step for the planner.';
  if (/researcher|research/i.test(identity)) return 'answer one research question with original sources, supported findings, what remains uncertain and a short handoff.';
  if (/gtm|forward deployed/i.test(identity) || /gtm|forward deployed|customer-moving|customer move/i.test(context)) return 'take one step toward a customer, update the relevant notes within 10 minutes and record what happened.';
  if (/ceo|lab/i.test(identity) || /ceo|lab|synthesis loop|decision queue|building|closing|investor/i.test(context)) return 'make one important decision or product improvement and record the result.';
  if (/rl-exp2|zero-spend|zero spend|tick-prefixed|1%/i.test(context)) return 'run the next rl-exp2 experiment without spending money. finish one result, describe the improvement and record what happened.';
  if (/validation checklist|signoff|reject|falsifiable|residual risk|anti-slop|review/i.test(context)) return 'review the riskiest open or recently finished task, run its check, record any remaining risks and approve or block it with the result.';
  if (/bounded mission|mission step|proof target|verifier/i.test(context)) return 'choose or create one step, run its check, record the result and what comes next.';
  return 'follow your starting notes, finish the first task and record how it went.';
}

function modeNextMove(member, mode) {
  if (!member || !mode) return null;
  const text = String(mode).toLowerCase().replace(/[_-]+/g, ' ');
  if (/founder|lab|idea|strategy/.test(text)) return { label: 'founder lab', move: 'develop one company idea, identify a customer and assign the next step.', proof: 'an idea note, a customer target, an assigned next step and feedback are recorded.' };
  if (/build|builder|product|backend|code/.test(text)) return { label: 'builder', move: 'make one product or system improvement.', proof: 'the change is made, its check passes and feedback is recorded.' };
  if (/close|closer|whale|investor|customer/.test(text)) return { label: 'closer', move: 'advance one customer or investor conversation with a clear next step.', proof: 'a drafted or sent message, a relationship update, a next step and feedback are recorded.' };
  if (/decision|queue|approve|approval/.test(text)) return { label: 'decision queue', move: 'make one decision that needs you and assign the follow-up.', proof: 'the decision, person responsible, follow-up and feedback are recorded.' };
  return null;
}

function memberProfileIssues(member) {
  if (!member) return [];
  const profile = String(member.profile || '');
  const issues = [];
  if (/\(Define how this member communicates/i.test(profile)) issues.push('persona is still template text');
  if (/^\s*1\.\s+Step one\s*$/im.test(profile)) issues.push('workflow is still template text');
  if (/^\s*1\.\s+Rule one\s*$/im.test(profile)) issues.push('rules are still template text');
  return issues;
}

function notesInfo(root) {
  const saved = readJson(path.join(root, 'atris', 'brain', 'state.json'));
  const date = Date.parse(saved?.generatedAt);
  if (!Number.isFinite(date)) return { status: 'missing', age_days: null };
  const age = Math.max(0, Math.floor((Date.now() - date) / 86400000));
  return { status: age > 3 ? 'stale' : 'fresh', age_days: age };
}

function buildActivationCard(state, options = {}) {
  const requested = options.member || readRememberedOperator(state.root);
  const member = readMemberContext(state.root, requested);
  const readFirst = ['atris/now.md', 'atris/MAP.md', 'atris/PERSONA.md'].filter(file => fs.existsSync(path.join(state.root, file)));
  const notes = notesInfo(state.root);
  const summary = buildActivationSummary(state.root);
  if (!requested) {
    const lines = [`${state.name} is ready.`, '', ...summary.lines, ...(summary.today ? [summary.today] : [])];
    if (readFirst.length) lines.push('', 'read these first:', ...readFirst.map(file => `  ${file}`));
    if (notes.status === 'missing') lines.push('', 'start-up notes are not saved yet. save them: atris brain compile --root . --yes');
    if (notes.status === 'stale') lines.push('', `the saved start-up notes are ${notes.age_days} days old. refresh them: atris brain compile --root . --yes`);
    return { ready: true, member: null, text: lines.join('\n'), readFirst, notes, summary };
  }
  const slug = normalizeMemberSlug(requested);
  let reason = null;
  let fix = null;
  if (!member) { reason = 'there is no team member by that name'; const members = listMemberSlugs(state.root); fix = `create atris/team/${slug}/MEMBER.md${members.length ? `, or pick one of: ${members.join(', ')}` : ''}`; }
  else if (memberProfileIssues(member).length) { reason = `the team member details still contain placeholders: ${memberProfileIssues(member).join('; ')}`; fix = `fill in atris/team/${slug}/MEMBER.md`; }
  else if (!member.startHere.trim()) { reason = 'the starting instructions are missing'; fix = `create atris/team/${slug}/START_HERE.md with the first task, a way to check it and the expected result`;  }
  if (reason) return { ready: false, reason, member: slug, text: `${state.name} is not ready for ${slug}: ${reason}.\n\nnext: ${fix}`, readFirst, notes, summary };
  if (options.remember) rememberOperator(state.root, member);
  const mode = modeNextMove(member, options.mode);
  const score = memberScoreContext(state.root, member);
  const proof = mode?.proof || score?.proofNeeded || score?.nextRep || 'the task is finished and its result is recorded.';
  const lines = [`${state.name} is ready for ${slug}.`, '', `next: ${mode?.move || memberNextMove(member, state) || nextMove(state)}`, 'why: it is the next piece of work for this role, picked from the current notes, the task list and past feedback.', `done when: ${proof}`];
  if (mode?.label) lines.push(`mode: ${mode.label}`);
  if (score?.score) lines.push(`score: ${score.score}`);
  if (score?.nextRep) lines.push(`next rep: ${score.nextRep}`);
  lines.push('how did it go: atris brain yes, atris brain edit "what to change", or atris brain no');
  return { ready: true, member: slug, text: lines.join('\n'), readFirst, notes, summary };
}

function verifyActivationCard(card) {
  if (!card.ready) throw new Error(`${card.member}: ${card.reason}`);
}

function verifyActivationGallery(cards) {
  const issues = cards.filter(card => !card.ready);
  if (issues.length) throw new Error(issues.map(card => `${card.member}: ${card.reason}`).join(', '));
}

function printVerifyFailure(error) {
  console.error(error && error.message ? error.message : String(error));
  process.exit(1);
}

function recordFeedback(options) {
  const root = options.root;
  const rating = String(options.rating || '').toLowerCase();
  const reward = rewardForRating(rating);
  const recommendation = options.recommendation || latestRecommendation(root);
  if (!recommendation) throw new Error('recommendation is required');

  const beforeBrain = readText(path.join(root, 'atris', 'brain', 'state.json'));
  const beforeBrainHash = shortHash(beforeBrain);
  const ts = new Date().toISOString();
  const decisionId = `brain-${ts.replace(/[^0-9TZ]/g, '').toLowerCase()}-${shortHash(`${root}|${recommendation}|${rating}|${options.note}`)}`;
  const workspace = readJson(path.join(root, '.atris', 'business.json')) || {};

  const scorecard = {
    ts,
    schema: 'atris.brain.scorecard.v1',
    decision_id: decisionId,
    workspace: workspace.slug || path.basename(root),
    business_id: workspace.business_id || null,
    workspace_id: workspace.workspace_id || null,
    recommendation,
    human_rating: rating,
    human_note: options.note || '',
    reward,
    before_brain_hash: beforeBrainHash,
    source: 'operator_feedback',
  };

  const episode = {
    ts,
    schema: 'atris.brain.feedback_episode.v1',
    episode_id: decisionId,
    task_type: 'business_brain_feedback',
    state: {
      workspace: scorecard.workspace,
      before_brain_hash: beforeBrainHash,
      recommendation,
    },
    action: {
      recommendation,
    },
    feedback: {
      rating,
      note: options.note || '',
    },
    reward,
    training_example: {
      messages: [
        { role: 'system', content: 'Recommend the next business action from the compiled Atris brain.' },
        { role: 'assistant', content: recommendation },
        { role: 'user', content: `${rating}${options.note ? `: ${options.note}` : ''}` },
      ],
    },
  };

  const stateDir = path.join(root, '.atris', 'state');
  appendJsonl(path.join(stateDir, 'scorecards.jsonl'), scorecard);
  appendJsonl(path.join(stateDir, 'episodes.jsonl'), episode);

  return { scorecard, episode };
}

function normalizeApprovalDecision(decision) {
  const normalized = String(decision || '').toLowerCase();
  if (normalized === 'go') return 'go';
  if (normalized === 'edit') return 'edit';
  if (normalized === 'hold') return 'hold';
  throw new Error('decision must be go, edit, or hold');
}

function approvalStatus(decision) {
  if (decision === 'go') return 'approved_to_proceed';
  if (decision === 'edit') return 'needs_adjustment_before_action';
  return 'held_do_not_proceed';
}

function recordApproval(options) {
  const root = options.root;
  const decision = normalizeApprovalDecision(options.decision);
  const recommendation = options.recommendation || latestRecommendation(root);
  if (!recommendation) throw new Error('recommendation is required');

  const beforeBrain = readText(path.join(root, 'atris', 'brain', 'state.json'));
  const beforeBrainHash = shortHash(beforeBrain);
  const ts = new Date().toISOString();
  const approvalId = `approval-${ts.replace(/[^0-9TZ]/g, '').toLowerCase()}-${shortHash(`${root}|${recommendation}|${decision}|${options.note}`)}`;
  const workspace = readJson(path.join(root, '.atris', 'business.json')) || {};

  const approval = {
    ts,
    schema: 'atris.brain.approval.v1',
    approval_id: approvalId,
    workspace: workspace.slug || path.basename(root),
    business_id: workspace.business_id || null,
    workspace_id: workspace.workspace_id || null,
    recommendation,
    human_decision: decision,
    status: approvalStatus(decision),
    human_note: options.note || '',
    before_brain_hash: beforeBrainHash,
    source: 'operator_approval',
  };

  appendJsonl(path.join(root, '.atris', 'state', 'approvals.jsonl'), approval);
  return approval;
}

function taskEpisodeScorecard(root, episode, workspace, ts = new Date().toISOString()) {
  const episodeId = episode.episode_id || shortHash(JSON.stringify(episode));
  const reward = Number(episode.reward && episode.reward.value);
  return {
    ts,
    schema: 'atris.brain.task_scorecard.v1',
    type: 'scorecard',
    scorecard_id: `task-scorecard-${episodeId}`,
    source: 'task_review_episode',
    source_episode_id: episodeId,
    workspace: workspace.slug || path.basename(root),
    business_id: workspace.business_id || null,
    workspace_id: workspace.workspace_id || null,
    task_id: episode.task_id || null,
    task_title: episode.state && episode.state.title || null,
    task_tag: episode.state && episode.state.tag || null,
    actor: episode.action && episode.action.actor || null,
    // Who built the work. `actor` is the reviewer; trust is earned by the builder.
    builder: episode.state && episode.state.metadata && episode.state.metadata.built_by
      || episode.state && episode.state.claimed_by
      || null,
    reward: Number.isFinite(reward) ? reward : 0,
    reward_source: episode.reward && episode.reward.source || 'task_review',
    lesson: episode.lesson || '',
    proof: episode.proof || '',
    next_task_suggestion: episode.next_task_suggestion || null,
    review_landing: episode.review_landing || null,
    landing_quality: episode.landing_quality || null,
    human_feedback: episode.human_feedback || null,
    approval_status: episode.human_feedback && episode.human_feedback.approval_status || episode.rl && episode.rl.approval_status || null,
    rl_label: episode.rl && episode.rl.label || null,
    episode_created_at: episode.created_at || episode.ts || null,
  };
}

function landingQualityFromReviewLanding(landing) {
  const normalized = {
    happened: landing && landing.happened || null,
    checked: landing && landing.checked || null,
    tested: landing && landing.tested || null,
    decision: landing && landing.decision || null,
  };
  const present = Object.entries(normalized)
    .filter(([, value]) => Boolean(value))
    .map(([key]) => key);
  const missing = Object.keys(normalized).filter(key => !normalized[key]);
  return {
    present,
    missing,
    completeness: present.length / Object.keys(normalized).length,
    has_decision: Boolean(normalized.decision),
  };
}

function taskProjectionByEpisodeId(root) {
  const tasks = readTaskProjectionTasks(root) || [];
  const byId = new Map();
  for (const task of tasks) {
    for (const key of [task.id, task.display_id, task.legacy_ref, task.ref].filter(Boolean)) {
      byId.set(String(key), task);
    }
  }
  return byId;
}

function enrichTaskEpisodeFromProjection(episode, taskById) {
  if (episode.review_landing) return episode;
  const task = taskById.get(String(episode.task_id || ''));
  const landing = task?.review?.landing || null;
  if (!landing) return episode;
  const approvalStatus = task?.review?.approval_status || episode.human_feedback?.approval_status || episode.rl?.approval_status || null;
  return {
    ...episode,
    review_landing: landing,
    landing_quality: episode.landing_quality || landingQualityFromReviewLanding(landing),
    human_feedback: episode.human_feedback || {
      approval_status: approvalStatus,
      human_revision_count: Number(task?.review?.human_revision_count || 0),
      human_revision_note: task?.review?.human_revision_note || null,
    },
    rl: episode.rl ? {
      ...episode.rl,
      landing_completeness: episode.rl.landing_completeness ?? landingQualityFromReviewLanding(landing).completeness,
      approval_status: episode.rl.approval_status || approvalStatus,
    } : episode.rl,
  };
}

function latestTaskEpisodes(taskEpisodes) {
  const byTask = new Map();
  for (const episode of taskEpisodes) {
    const episodeId = episode.episode_id || shortHash(JSON.stringify(episode));
    const key = episode.task_id || episodeId;
    byTask.set(key, { ...episode, episode_id: episodeId });
  }
  return Array.from(byTask.values());
}

function recordTaskEpisodeScorecards(options) {
  const root = options.root;
  const stateRoot = resolveStateRoot(root);
  const stateDir = path.join(stateRoot, '.atris', 'state');
  const stateDirs = resolveStateRoots(root).map(item => path.join(item, '.atris', 'state'));
  const scorecardsPath = path.join(stateDir, 'scorecards.jsonl');
  const workspace =
    readJson(path.join(stateRoot, '.atris', 'business.json')) ||
    readJson(path.join(root, '.atris', 'business.json')) ||
    {};
  const taskEpisodes = stateDirs.flatMap(item => readJsonlRows(path.join(item, 'task_episodes.jsonl')))
    .filter(row => row && row.schema === 'atris.task_episode.v1');
  const taskById = taskProjectionByEpisodeId(stateRoot);
  if (stateRoot !== root) {
    for (const [key, task] of taskProjectionByEpisodeId(root)) taskById.set(key, task);
  }
  const scoreableEpisodes = latestTaskEpisodes(taskEpisodes)
    .map(episode => enrichTaskEpisodeFromProjection(episode, taskById));
  const existing = stateDirs.flatMap(item => readJsonlRows(path.join(item, 'scorecards.jsonl')));
  const existingByEpisodeId = new Map();
  for (const row of existing) {
    if (!row.source_episode_id) continue;
    const rows = existingByEpisodeId.get(row.source_episode_id) || [];
    rows.push(row);
    existingByEpisodeId.set(row.source_episode_id, rows);
  }

  const written = [];
  for (const episode of scoreableEpisodes) {
    const episodeId = episode.episode_id;
    const scorecard = taskEpisodeScorecard(root, episode, workspace);
    const existingRows = existingByEpisodeId.get(episodeId) || [];
    const existingHasLanding = existingRows.some(row => row.review_landing);
    if (existingRows.length && (!scorecard.review_landing || existingHasLanding)) continue;
    appendJsonl(scorecardsPath, scorecard);
    existingRows.push(scorecard);
    existingByEpisodeId.set(episodeId, existingRows);
    written.push(scorecard);
  }

  return {
    stateRoot,
    taskEpisodes: taskEpisodes.length,
    written: written.length,
    scorecards: written,
  };
}

function verifyTaskEpisodeScorecards(root) {
  const stateDirs = resolveStateRoots(root).map(item => path.join(item, '.atris', 'state'));
  const taskEpisodes = stateDirs.flatMap(item => readJsonlRows(path.join(item, 'task_episodes.jsonl')))
    .filter(row => row && row.schema === 'atris.task_episode.v1');
  const scoreableEpisodes = latestTaskEpisodes(taskEpisodes);
  const scorecards = stateDirs.flatMap(item => readJsonlRows(path.join(item, 'scorecards.jsonl')));
  const scorecardEpisodeIds = new Set(scorecards
    .map(row => row.source_episode_id)
    .filter(Boolean));
  const missing = scoreableEpisodes
    .map(row => row.episode_id)
    .filter(id => !scorecardEpisodeIds.has(id));
  if (missing.length > 0) {
    throw new Error(`task episode scorecards missing: ${missing.join(', ')}`);
  }
}

function verifyFeedback(root, decisionId) {
  const scorecards = readText(path.join(root, '.atris', 'state', 'scorecards.jsonl'));
  const episodes = readText(path.join(root, '.atris', 'state', 'episodes.jsonl'));
  if (!scorecards.includes(decisionId) || !episodes.includes(decisionId)) {
    throw new Error(`feedback rows missing decision_id ${decisionId}`);
  }
}

function verifyApproval(root, approvalId) {
  const approvals = readText(path.join(root, '.atris', 'state', 'approvals.jsonl'));
  if (!approvals.includes(approvalId)) {
    throw new Error(`approval row missing approval_id ${approvalId}`);
  }
}

function brainLoadOrderFiles(state) {
  const root = state.root;
  const lookupRoots = [root, ...(state.stateRoots || []), state.stateRoot]
    .filter(Boolean)
    .map(item => path.resolve(item));
  const seen = new Set();
  const uniqueRoots = lookupRoots.filter(item => {
    if (seen.has(item)) return false;
    seen.add(item);
    return true;
  });
  const loadOrderFileExists = rel => uniqueRoots.some(base => fs.existsSync(path.join(base, rel)));
  const existingState = OPTIONAL_STATE_LOAD_ORDER_FILES
    .filter(loadOrderFileExists);
  const existing = OPTIONAL_LOAD_ORDER_FILES
    .filter(rel => fs.existsSync(path.join(root, rel)));
  return [...GENERATED_LOAD_ORDER_FILES, ...existingState, ...existing];
}

function renderNumberedLoadOrder(state) {
  return brainLoadOrderFiles(state)
    .map((rel, index) => `${index + 1}. \`${rel}\``)
    .join('\n');
}

function renderBulletedLoadOrder(state) {
  return brainLoadOrderFiles(state)
    .map(rel => `- \`${rel}\``)
    .join('\n');
}

function renderLoopHealthPanel(state) {
  const rows = (state.loopHealth || []).map(channel => {
    const status = channel.active ? 'active' : 'missing';
    return `| ${channel.label} | ${status} | ${channel.rows} | ${channel.validRows} | ${channel.latestTs || ''} | \`${channel.files.join('`, `')}\` |`;
  }).join('\n');

  return `## Loop Health

| Channel | Status | Rows | Valid | Latest timestamp | Files |
|---|---|---:|---:|---|---|
${rows}`;
}

function renderStatus(state) {
  const stateRootLine = state.stateRoot && path.resolve(state.stateRoot) !== path.resolve(state.root)
    ? `- State root: ${state.stateRoot} (primary checkout)\n`
    : '';

  return `# Atris Brain Status

- Generated: ${state.generatedAt}
- Workspace: ${state.name}
- Slug: ${state.slug}
- Root: ${state.root}
${stateRootLine}- Now loaded: ${state.hasNow ? `yes (${state.nowHeading || 'no heading'})` : 'no'}
- MAP loaded: ${state.hasMap ? `yes (${state.mapLineCount} lines)` : 'no'}
- Wiki status loaded: ${state.hasWikiStatus ? 'yes' : 'no'}
- TODO open estimate: ${state.todo.open}
- State rows: ${state.totalRows} raw / ${state.validRows} valid state rows
- Latest state timestamp: ${state.latestStateTs || 'none found'}

${renderLoopHealthPanel(state)}

## What Improved

This run compiled scattered workspace state into one loadable brain:

- source map: \`atris/MAP.md\`
- current state front door: \`atris/now.md\`
- task queue: \`atris/TODO.md\`
- wiki status: \`atris/wiki/STATUS.md\`
- run state: \`.atris/state/*.jsonl\`
- self-improvement ledger: \`atris/brain/self_improvement_ledger.md\`

## Strongest Signal

${strongestSignal(state)}

## Next Move

${nextMove(state)}

## Load Order For Future Agents

${renderNumberedLoadOrder(state)}

First reply: open with the one thing most worth doing today. Then say why, what is already prepared and where to look for more.
Shape: \`<name>, today is about <the one thing>\` -> \`I picked this because <why now>\` -> \`Ready: <what is prepared>\` -> \`Go deeper: <2 to 4 paths>\`.
`;
}

function renderLedger(state) {
  const rows = state.stateFiles.map(item => {
    const rel = path.relative(state.stateRoot || state.root, item.path).replace(/\\/g, '/');
    return `| \`${rel}\` | ${item.exists ? 'yes' : 'no'} | ${item.rows} | ${item.validRows} | ${item.latestTs || ''} |`;
  }).join('\n');

  return `# Self-Improvement Ledger

Generated: ${state.generatedAt}

## Claim

Atris improves itself by improving the operating context future agents load: navigation, memory, task choice, proof, and reward signals.

This is not model-weight improvement yet. It is workspace-policy and context improvement.

## Current State Inputs

| Source | Exists | Rows | Valid JSON/JSONL | Latest timestamp |
|---|---:|---:|---:|---|
${rows}

## Run N -> Run N+1 Mechanism

1. Start from \`atris/now.md\`, then observe workspace state from \`.atris/state\`, TODO, MAP, wiki, and logs.
2. Compile it into \`atris/brain/STATUS.md\` and this ledger.
3. Point future agents at the compiled brain before they act.
4. After action, write scorecards, episodes, lessons, or state rows.
5. Re-run \`atris brain compile\`; the next agent starts with a better brain.

## Proof To Watch

- More valid state rows over time.
- More scorecards and episodes, not just prose.
- Fewer repeated stale TODOs.
- Faster correct next-action selection.
- Higher verified business-loop completion rate.

## Next Action

${nextMove(state)}
`;
}

function generatedBootBlock(state, voiceCard = voiceCardForRoot(state.root)) {
  return `${GENERATED_START}
## Atris start-up notes

This folder keeps notes that give every agent the same starting context.

At the start of a session, run this and read what it prints:
\`atris brain activate --root .\`

Then read these files in order:
${renderBulletedLoadOrder(state)}

First reply: open with the one thing most worth doing today. Then say why, what is already prepared and where to look for more.
Shape: \`<name>, today is about <the one thing>\` -> \`I picked this because <why now>\` -> \`Ready: <what is prepared>\` -> \`Go deeper: <2 to 4 paths>\`.

Keep this voice in every reply:
${renderVoiceCardBlock(voiceCard)}

After meaningful work, save fresh notes:
\`atris brain compile --root . --yes\`
${GENERATED_END}
`;
}

function upsertGeneratedBlock(filePath, title, block) {
  let current = readText(filePath);
  if (!current) current = `# ${title}\n\n`;

  const start = current.indexOf(GENERATED_START);
  const end = current.indexOf(GENERATED_END);
  if (start !== -1 && end !== -1 && end > start) {
    const before = current.slice(0, start).trimEnd();
    const after = current.slice(end + GENERATED_END.length).trimStart();
    fs.writeFileSync(filePath, `${before}\n\n${block}${after ? `\n${after}` : ''}`, 'utf8');
    return;
  }

  fs.writeFileSync(filePath, `${current.trimEnd()}\n\n${block}`, 'utf8');
}

function plannedBrainWrites(state) {
  const files = [
    'atris/brain/STATUS.md',
    'atris/brain/self_improvement_ledger.md',
    'atris/brain/state.json',
    'AGENTS.md',
    'CLAUDE.md',
    'GEMINI.md',
    '.cursor/rules/atris-voice.mdc',
  ];
  if (fs.existsSync(path.join(state.root, 'atris', 'wiki', 'STATUS.md'))) {
    files.push('atris/wiki/STATUS.md');
  }
  return files;
}

function refuseBrainWriteWithoutYes(state, options = {}) {
  const files = plannedBrainWrites(state);
  if (options.json) {
    console.log(JSON.stringify({
      ok: true,
      action: 'brain_plan',
      files,
      next_command: 'atris brain compile --yes',
    }, null, 2));
  } else {
    console.log('nothing saved yet. this would write:');
    for (const file of files) console.log(`  ${file}`);
    console.log('to save them: atris brain compile --root . --yes');
  }
  if (isNonInteractive()) process.exit(2);
  return { planned: true, files };
}

function writeBrain(state) {
  const brainDir = path.join(state.root, 'atris', 'brain');
  fs.mkdirSync(brainDir, { recursive: true });

  const statusPath = path.join(brainDir, 'STATUS.md');
  const ledgerPath = path.join(brainDir, 'self_improvement_ledger.md');
  const jsonPath = path.join(brainDir, 'state.json');

  fs.writeFileSync(statusPath, renderStatus(state), 'utf8');
  fs.writeFileSync(ledgerPath, renderLedger(state), 'utf8');
  fs.writeFileSync(jsonPath, JSON.stringify(state, null, 2) + '\n', 'utf8');

  const voiceCard = voiceCardForRoot(state.root);
  const bootBlock = generatedBootBlock(state, voiceCard);
  for (const fileName of ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md']) {
    upsertGeneratedBlock(path.join(state.root, fileName), fileName.replace(/\.md$/, ''), bootBlock);
  }
  const cursorVoicePath = path.join(state.root, '.cursor', 'rules', 'atris-voice.mdc');
  upsertCursorVoiceCard(cursorVoicePath, voiceCard);

  const wikiStatusPath = path.join(state.root, 'atris', 'wiki', 'STATUS.md');
  if (fs.existsSync(wikiStatusPath)) {
    upsertGeneratedBlock(wikiStatusPath, 'Atris Wiki Status', `<!-- ATRIS_BRAIN_COMPILE:START -->
## Brain Compile

- Last compile: ${state.generatedAt}
- State rows: ${state.totalRows} raw / ${state.validRows} valid JSONL
- Strongest signal: ${strongestSignal(state)}
- Next move: ${nextMove(state)}
- Brain status: \`atris/brain/STATUS.md\`
- Ledger: \`atris/brain/self_improvement_ledger.md\`
<!-- ATRIS_BRAIN_COMPILE:END -->
`);
  }

  return { statusPath, ledgerPath, jsonPath, cursorVoicePath };
}

function verifyBrain(root) {
  const required = [
    'atris/brain/STATUS.md',
    'atris/brain/self_improvement_ledger.md',
    'atris/brain/state.json',
    'AGENTS.md',
  ];
  const missing = required.filter(rel => !fs.existsSync(path.join(root, rel)));
  if (missing.length > 0) {
    throw new Error(`missing: ${missing.join(', ')}. save them: atris brain compile --root . --yes`);
  }
  const status = readText(path.join(root, 'atris', 'brain', 'STATUS.md'));
  const ledger = readText(path.join(root, 'atris', 'brain', 'self_improvement_ledger.md'));
  if (!status.includes('## Next Move') || !ledger.includes('## Run N -> Run N+1 Mechanism')) {
    throw new Error('saved notes are missing required sections. refresh them: atris brain compile --root . --yes');
  }
}

function brainUsageLines() {
  return [
    'atris brain: the notes every agent reads before it starts work in this folder.',
    '',
    '  atris brain activate                     show what is in progress, what is waiting and the next step',
    '  atris brain activate --member <name>     the same, for one team member',
    '  atris brain compile --yes                save fresh start-up notes into this folder',
    '  atris brain gallery                      show the next step for every team member',
    '  atris brain yes | edit | no ["note"]     say how the last suggestion went',
    '  atris brain go | hold ["note"]           approve or pause a piece of work',
    '  atris brain scorecard                    score finished tasks so later suggestions improve',
    '',
    'options: --root <folder>  --yes (allow saving files)  --verify (check the notes are in place)  --json',
  ];
}

function printBrainUsage(stream = console.log) {
  for (const line of brainUsageLines()) stream(line);
}

function brainCommand(args = process.argv.slice(3)) {
  const { subcommand, options } = parseArgs(args);
  if (subcommand === 'help' || subcommand === '--help' || subcommand === '-h' || args.includes('--help') || args.includes('-h')) {
    printBrainUsage();
    return;
  }
  if (subcommand === 'yes') {
    options.rating = 'approve';
  } else if (subcommand === 'no') {
    options.rating = 'reject';
  } else if (subcommand === 'edit') {
    options.rating = 'edit';
  }

  if (subcommand === 'go' || subcommand === 'hold' || subcommand === 'approval' || subcommand === 'approve') {
    if (subcommand === 'go' || subcommand === 'hold') options.decision = subcommand;
    const approval = recordApproval(options);
    if (options.verify) verifyApproval(options.root, approval.approval_id);
    if (options.json) {
      console.log(JSON.stringify({ ok: true, approval }, null, 2));
      return;
    }
    console.log(`approval recorded: ${approval.human_decision}. ${approval.human_decision === 'go' ? 'work can proceed.' : 'review the work before proceeding.'}`);
    if (options.verify) console.log('checked: the decision was saved.');
    return;
  }

  if (subcommand === 'feedback' || ['yes', 'no', 'edit'].includes(subcommand)) {
    const result = recordFeedback(options);
    if (options.verify) verifyFeedback(options.root, result.scorecard.decision_id);
    if (options.json) {
      console.log(JSON.stringify({ ok: true, ...result }, null, 2));
      return;
    }
    console.log('feedback recorded. refresh the notes: atris brain compile --root . --yes');
    if (options.verify) console.log('checked: the feedback was saved.');
    return;
  }

  if (subcommand === 'scorecard' || subcommand === 'scorecards') {
    const result = recordTaskEpisodeScorecards(options);
    if (options.verify) verifyTaskEpisodeScorecards(options.root);
    if (options.json) {
      console.log(JSON.stringify({ ok: true, ...result }, null, 2));
      return;
    }
    console.log(`finished work scored: ${result.written}. refresh the notes: atris brain compile --root . --yes`);
    if (options.verify) console.log('checked: the scores were saved.');
    return;
  }

  if (!fs.existsSync(path.join(options.root, 'atris'))) {
    throw new Error('this folder is not set up for atris yet. set it up: atris init');
  }
  if (['activate', 'status', 'gallery'].includes(subcommand)) {
    const state = options.yes && subcommand !== 'status' ? prepareBrainState(options.root) : collectState(options.root);
    const wrote = Boolean(options.yes && subcommand !== 'status');
    if (wrote) writeBrain(state);
    const cards = subcommand === 'gallery'
      ? listMemberSlugs(options.root).map(member => buildActivationCard(state, { member }))
      : [buildActivationCard(state, { ...options, remember: wrote })];
    const card = cards[0];
    const output = subcommand === 'gallery' ? (cards.map(item => item.text).join('\n\n---\n\n') || 'no team members found. create one in atris/team/<name>/MEMBER.md') : card.text;
    let error = null;
    if (options.verify) {
      try { verifyBrain(options.root); if (subcommand === 'gallery') verifyActivationGallery(cards); else verifyActivationCard(card); }
      catch (err) { error = err.message; }
    }
    if (options.json) {
      const data = subcommand === 'gallery' ? { members: listMemberSlugs(options.root), gallery: output } : { state, card: output, name: state.name, member: card.member, ready: card.ready, wrote, read_first: card.readFirst, notes: card.notes, summary: card.summary, ...card.summary };
      console.log(JSON.stringify({ ok: !error, ...data, ...(error ? { error } : {}) }, null, 2));
    } else {
      console.log(`\n${output}`);
      if (error) console.error(error);
      else if (options.verify) console.log('\nchecked: the saved notes are in place.');
      console.log('');
    }
    return error ? 1 : 0;
  }
  if (subcommand !== 'compile') {
    if (options.json) console.log(JSON.stringify({ ok: false, error: `unknown brain subcommand: ${subcommand}`, usage: brainUsageLines() }, null, 2));
    else printBrainUsage(console.error);
    return 1;
  }
  const state = options.yes ? prepareBrainState(options.root) : collectState(options.root);
  if (!options.yes) { refuseBrainWriteWithoutYes(state, options); return 0; }
  const written = writeBrain(state);
  if (options.verify) verifyBrain(options.root);
  if (options.json) { console.log(JSON.stringify({ ok: true, state, written }, null, 2)); return 0; }
  console.log(`start-up notes saved for ${state.name}.`);
  console.log(`  status: ${path.relative(options.root, written.statusPath)}`);
  console.log(`  history: ${path.relative(options.root, written.ledgerPath)}`);
  console.log(`  next: ${nextMove(state)}`);
  if (options.verify) console.log('  checked: the saved notes are in place.');
  return 0;
}

module.exports = {
  readText,
  brainCommand,
  collectState,
  renderStatus,
  recordTaskEpisodeScorecards,
  verifyActivationCard,
  verifyActivationGallery,
  parseContributionCard,
  escapeRegExp,
  countTodoItems,
};
