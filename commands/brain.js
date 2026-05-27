const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { refreshNowFile } = require('./now');

const GENERATED_START = '<!-- ATRIS_BRAIN_COMPILE:START -->';
const GENERATED_END = '<!-- ATRIS_BRAIN_COMPILE:END -->';
const GENERATED_LOAD_ORDER_FILES = [
  'atris/now.md',
  'atris/brain/STATUS.md',
  'atris/brain/self_improvement_ledger.md',
];
const OPTIONAL_LOAD_ORDER_FILES = [
  'atris/wiki/concepts/agent-activation-contract.md',
  'atris/skills/atris/SKILL.md',
  'atris/PERSONA.md',
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
const LOOP_HEALTH_CHANNELS = [
  { label: 'Task plane', files: ['task_events.jsonl', 'tasks.projection.json'] },
  { label: 'Overnight RL', files: ['overnight_rl_self_heal.jsonl'] },
  { label: 'Career XP', files: ['career_xp_receipts.jsonl', 'career_xp.projection.json', 'gm_xp.projection.json'] },
  { label: 'Master loop', files: ['master_loop_events.jsonl'] },
  { label: 'Missions', files: ['mission_events.jsonl', 'missions.jsonl'] },
  { label: 'Company YC', files: ['company_yc_wow_events.jsonl', 'company_yc_wow_latest.json'] },
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

  const subcommand = positional[0] || 'compile';
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

function countTodoItems(todoText) {
  const text = String(todoText || '');
  const hasRenderedSections = /^##\s+(Backlog|In Progress|Blocked|Completed)\s*$/m.test(text);
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
    if (!hasRenderedSections && (isUnchecked || (isTitled && !isChecked))) legacyOpen += 1;
    if (!isTitled) continue;

    titled += 1;
    if (hasRenderedSections && ['Backlog', 'In Progress'].includes(section)) renderedOpen += 1;
    if (hasRenderedSections && section === 'Completed') renderedDone += 1;
  }

  return {
    open: hasRenderedSections ? renderedOpen : legacyOpen,
    checked,
    titled,
    done: hasRenderedSections ? renderedDone : checked + (text.match(/~~|DONE|✅/g) || []).length,
  };
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

function summarizeTaskProjection(root) {
  const tasks = readTaskProjectionTasks(root);
  if (!tasks) return null;

  const counts = {};
  const certifiedReviewTasks = [];
  for (const task of tasks) {
    const status = String(task?.status || '').toLowerCase();
    counts[status] = (counts[status] || 0) + 1;
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
  const stateDir = path.join(root, '.atris', 'state');
  const business = readJson(path.join(root, '.atris', 'business.json')) || {};
  const todoText = readText(path.join(atrisDir, 'TODO.md'));
  const mapText = readText(path.join(atrisDir, 'MAP.md'));
  const nowText = readText(path.join(atrisDir, 'now.md'));
  const wikiStatus = readText(path.join(atrisDir, 'wiki', 'STATUS.md'));
  const status = readText(path.join(atrisDir, 'STATUS.md'));

  const stateFiles = collectStateFileStats(stateDir);

  const totalRows = stateFiles.reduce((sum, item) => sum + item.rows, 0);
  const validRows = stateFiles.reduce((sum, item) => sum + item.validRows, 0);
  const latestScorecard = readJsonlRows(path.join(stateDir, 'scorecards.jsonl'))
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
    name: business.name || business.slug || firstHeading(status || mapText, path.basename(root)),
    slug: business.slug || path.basename(root),
    business,
    todo: countWorkItems(root, todoText),
    taskProjection: summarizeTaskProjection(root),
    hasNow: nowText.length > 0,
    nowHeading: firstHeading(nowText, null),
    hasMap: mapText.length > 0,
    hasWikiStatus: wikiStatus.length > 0,
    mapLineCount: mapText ? mapText.split('\n').length : 0,
    wikiPages: listMarkdown(root, 'atris/wiki', 20),
    stateFiles,
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
  const mail = countStateRows(state, 'agent_mail.jsonl');
  const tasks = countStateRows(state, 'agent_tasks.jsonl');
  const scorecards = countStateRows(state, 'scorecards.jsonl');
  const episodes = countStateRows(state, ['episodes.jsonl', 'task_episodes.jsonl']);
  const activeLoops = (state.loopHealth || buildLoopHealth(state.stateFiles || []))
    .filter(channel => channel.active);
  const loopSuffix = activeLoops.length > 0
    ? ` Loop health sees ${activeLoops.length} active channel(s): ${activeLoops.map(channel => channel.label).join(', ')}.`
    : '';
  if (scorecards > 0 && episodes > 0) return `${scorecards} scorecard row(s) and ${episodes} episode row(s) are available for feedback-driven learning.${loopSuffix}`;
  if (scorecards > 0) return `${scorecards} scorecard row(s) are available for outcome scoring.${loopSuffix}`;
  if (episodes > 0) return `${episodes} episode row(s) are available; compile them into scorecards and next-action memory.${loopSuffix}`;
  if (activeLoops.length > 0) return `Loop health sees ${activeLoops.length} active channel(s): ${activeLoops.map(channel => channel.label).join(', ')}.`;
  if (mail > 0) return `${mail} agent-mail row(s) are available; compile them into decisions, follow-ups, and CRM memory.`;
  if (tasks > 0) return `${tasks} agent-task row(s) are available; use them to choose the next action.`;
  return 'Workspace has structure, but little scored state yet; first improvement is to create scorecards and episodes.';
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
  return `Run \`atris brain activate --member <name> --root ${state.root} --verify\` to bind the operator and get a concrete work block.`;
}

function nextMove(state) {
  const scorecards = countStateRows(state, 'scorecards.jsonl');
  const episodes = countStateRows(state, ['episodes.jsonl', 'task_episodes.jsonl']);
  if (state.totalRows > 0 && scorecards === 0) {
    if (episodes > 0) return 'Turn existing episode rows into the first scorecard so the next run has reward, not just traces.';
    return 'Turn existing state rows into the first scorecard so the next run has a reward signal, not just memory.';
  }
  if (episodes === 0) {
    return 'Capture one operator approval, edit, or rejection as an episode so the brain has a learning trace.';
  }
  if (state.todo.open > 0) return 'Pick the highest-leverage open TODO item and leave a scorecard when done.';
  if (state.latestScorecard && isActionableScorecardNextMove(state.latestScorecard.next_task_suggestion)) {
    return state.latestScorecard.next_task_suggestion;
  }
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

function loadBrainState(root) {
  return readJson(path.join(root, 'atris', 'brain', 'state.json')) || collectState(root);
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
  const memberSections = sections.filter(section => new RegExp(`^##\\s+${firstName}\\b`, 'i').test(section.trim()));
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
  const name = member.name || member.slug;
  const context = `${member.startHere}\n${member.goals}`;
  const identity = `${member.slug}\n${member.name}`;
  const certifiedReview = state?.taskProjection?.certifiedReviewTasks?.[0] || null;
  const certifiedReviewMove = certifiedReview
    ? `${name}: hand off certified review ${certifiedReview.ref} to the operator: run ` +
      `\`atris task accept ${certifiedReview.ref}\` if approved or ` +
      `\`atris task revise ${certifiedReview.ref} --note "<what must change>"\` if not; do not create new work until this checkpoint is clear.`
    : null;
  if (member.slug === 'justin' || /justin/i.test(member.name || '')) {
    return `${name}: run one customer-moving GTM rep, update the relevant workspace state within 10 minutes, and leave a scorecard.`;
  }
  if (member.slug === 'keshav' || /keshav/i.test(member.name || '')) {
    return `${name}: act as Customer 0: choose one allocation, narrative, system, or talent leverage move; leave proof and route the next owner.`;
  }
  if (/opus|overnight/i.test(identity)) {
    return `${name}: run the next zero-spend ` +
      '`rl-exp2` tick, land one artifact, name the 1% delta, and record the mission receipt.';
  }
  if (/mission[- ]lead|mission lead/i.test(identity)) {
    return `${name}: choose or create one bounded mission step, run its verifier, and close it with proof, a scorecard, and the next move.`;
  }
  if (/validator|reviewer/i.test(identity)) {
    if (certifiedReviewMove) return certifiedReviewMove;
    if ((state?.todo?.open || 0) === 0 && (state?.todo?.done || 0) === 0) {
      return `${name}: wait for one concrete artifact or ask Navigator to create a reviewable task with verifier, proof target, and residual-risk checklist.`;
    }
    return `${name}: review the highest-risk open or recently completed task, run its verifier, name residual risk, and approve or block with proof.`;
  }
  if (/executor|builder/i.test(identity)) {
    if ((state?.todo?.open || 0) === 0) {
      if (certifiedReviewMove) return certifiedReviewMove;
      return `${name}: ask Navigator to create one bounded task with files, verifier, and stop rule before making a patch.`;
    }
    return `${name}: execute the highest-leverage claimed task one scoped step at a time, run the verifier after the patch, and hand off proof for review.`;
  }
  if (/navigator|planner/i.test(identity)) {
    return `${name}: turn one messy or unclaimed intent into a MAP-backed plan with ASCII visualization, exact files, verifier, rollback, and a review-ready task.`;
  }
  if (/launcher|closer/i.test(identity)) {
    if (certifiedReviewMove) return certifiedReviewMove;
    if ((state?.todo?.done || 0) === 0) {
      return `${name}: wait for one validated task receipt before closeout, or ask Validator to produce a review decision with proof.`;
    }
    return `${name}: close one validated task into release-ready proof: summarize the shipped change, capture the lesson, update MAP or journal if needed, and name the publish step.`;
  }
  if (/brainstormer|idea shaper|reality shaper/i.test(identity)) {
    return `${name}: shape one raw idea into a concise vision: current reality, 1-2 options, constraints, success criteria, and a navigator-ready next step.`;
  }
  if (/researcher|research/i.test(identity)) {
    return `${name}: answer one explicit research question with primary sources, source-backed findings, unverified gaps, and a short So What handoff.`;
  }
  if (/gtm|forward deployed/i.test(identity) || /gtm|forward deployed|customer-moving|customer move/i.test(context)) {
    return `${name}: run one customer-moving GTM rep, update the relevant workspace state within 10 minutes, and leave a scorecard.`;
  }
  if (/ceo|lab/i.test(identity) || /ceo|lab|synthesis loop|decision queue|building|closing|investor/i.test(context)) {
    return `${name}: make one high-leverage CEO move: ship product, close a strategic loop, or make a queued decision; leave proof and a scorecard.`;
  }
  if (/rl-exp2|zero-spend|zero spend|tick-prefixed|1%/i.test(context)) {
    return `${name}: run the next zero-spend ` +
      '`rl-exp2` tick, land one artifact, name the 1% delta, and record the mission receipt.';
  }
  if (/validation checklist|signoff|reject|falsifiable|residual risk|anti-slop|review/i.test(context)) {
    return `${name}: review the highest-risk open or recently completed task, run its verifier, name residual risk, and approve or block with proof.`;
  }
  if (/bounded mission|mission step|proof target|verifier/i.test(context)) {
    return `${name}: choose or create one bounded mission step, run its verifier, and close it with proof, a scorecard, and the next move.`;
  }
  return `${name}: use your START_HERE, complete the first concrete work block, and leave a scorecard.`;
}

function modeNextMove(member, mode) {
  if (!member || !mode) return null;
  const normalized = String(mode).toLowerCase().replace(/[_-]+/g, ' ').trim();
  const name = member.name || member.slug;
  if (/founder|lab|idea|strategy/.test(normalized)) {
    return {
      label: 'founder lab',
      move: `${name}: think through one crazy company idea, turn it into a customer wedge hypothesis, then route execution to Justin or Build.`,
      proof: 'one idea note, one customer target, one delegated next action, and one scorecard',
    };
  }
  if (/build|builder|product|backend|code/.test(normalized)) {
    return {
      label: 'builder',
      move: `${name}: ship one product or system improvement that makes Atris easier to sell, operate, or self-improve.`,
      proof: 'one shipped diff or artifact, verification output, and one scorecard',
    };
  }
  if (/close|closer|whale|investor|customer/.test(normalized)) {
    return {
      label: 'closer',
      move: `${name}: advance one whale, investor, or strategic customer conversation with a concrete next step.`,
      proof: 'one drafted or sent message, one relationship update, one next step, and one scorecard',
    };
  }
  if (/decision|queue|approve|approval/.test(normalized)) {
    return {
      label: 'decision queue',
      move: `${name}: clear one high-leverage yes/no decision that only you should make, then delegate the follow-through.`,
      proof: 'one decision recorded, one owner assigned, one follow-up path, and one scorecard',
    };
  }
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

function renderMissingMemberCard(state, memberSlug) {
  const slug = normalizeMemberSlug(memberSlug) || '<name>';
  const members = listMemberSlugs(state.root);
  const available = members.length > 0 ? members.join(', ') : 'none';
  return `CONTEXT: ${state.name} Brain
OPERATOR: ${slug} (missing)
NEXT MOVE: Create atris/team/${slug}/MEMBER.md or rerun with an existing member.
WHY: Activation can only route by operator after the member profile exists locally.
PROOF: Re-run atris brain activate --member ${slug} --root ${state.root} --verify and get an operator-specific work block.
AVAILABLE MEMBERS: ${available}
FEEDBACK: yes / edit / no`;
}

function renderPlaceholderMemberCard(state, member, issues) {
  const slug = member.slug || '<name>';
  return `CONTEXT: ${state.name} Brain
OPERATOR: ${member.name || slug} (not ready)
NEXT MOVE: Replace placeholder sections in atris/team/${slug}/MEMBER.md with the member's real workflow, rules, and proof standard.
WHY: Activation should not turn template text into fake operator work.
PROOF: Re-run atris brain activate --member ${slug} --root ${state.root} --verify and get an operator-specific work block.
PROFILE ISSUES: ${issues.join('; ')}
FEEDBACK: yes / edit / no`;
}

function renderMissingStartHereCard(state, member) {
  const slug = member.slug || '<name>';
  return `CONTEXT: ${state.name} Brain
OPERATOR: ${member.name || slug} (not ready)
NEXT MOVE: Create atris/team/${slug}/START_HERE.md with the member's first concrete work block, verifier, and proof target.
WHY: Activation should not tell an operator to use START_HERE until that local contract exists.
PROOF: Re-run atris brain activate --member ${slug} --root ${state.root} --verify and get an operator-specific work block.
FEEDBACK: yes / edit / no`;
}

function renderActivationCard(state, options = {}) {
  const requestedMember = options.member || readRememberedOperator(state.root);
  const member = readMemberContext(state.root, requestedMember);
  if (!member && requestedMember) {
    return renderMissingMemberCard(state, requestedMember);
  }
  if (!member && !options.member) {
    return `CONTEXT: ${state.name} Brain
OPERATOR: unknown
NEXT MOVE: Tell Atris who is operating: atris brain activate --member <name> --root ${state.root}
WHY: The brain should route work by operator, customer, and proof path before it assigns the next move.
PROOF: Activation re-runs with a known operator and produces a specific work block.
FEEDBACK: yes / edit / no`;
  }
  const profileIssues = memberProfileIssues(member);
  if (profileIssues.length > 0) {
    return renderPlaceholderMemberCard(state, member, profileIssues);
  }
  if (!String(member.startHere || '').trim()) {
    return renderMissingStartHereCard(state, member);
  }
  if (options.remember !== false) rememberOperator(state.root, member);
  const modeMove = modeNextMove(member, options.mode);
  const next = modeMove?.move || memberNextMove(member, state) || nextMove(state);
  const scoreContext = memberScoreContext(state.root, member);
  const proof = modeMove?.proof || scoreContext?.proofNeeded || scoreContext?.nextRep || `After the move, record feedback and recompile: atris brain yes|edit|no "note" --root ${state.root} --verify && atris brain compile --root ${state.root} --verify`;
  const scoreLines = scoreContext
    ? `${scoreContext.score ? `\nSCORE: ${scoreContext.score}` : ''}${scoreContext.nextRep ? `\nNEXT REP: ${scoreContext.nextRep}` : ''}`
    : '';
  return `CONTEXT: ${state.name} Brain${member ? `\nOPERATOR: ${member.name}` : ''}${modeMove ? `\nMODE: ${modeMove.label}` : ''}
NEXT MOVE: ${next}
WHY: This is the next business workflow to improve from atris/now.md, the compiled brain, MAP, TODO, wiki, state rows, and reward history.
PROOF: ${proof}${scoreLines}
FEEDBACK: yes / edit / no`;
}

function renderActivationGallery(state) {
  const slugs = listMemberSlugs(state.root);
  if (slugs.length === 0) {
    return `CONTEXT: ${state.name} Brain
TEAM: no members found
NEXT MOVE: Add a member under atris/team/<name>/MEMBER.md, then run activation again.`;
  }

  return slugs.map(slug => renderActivationCard(state, { member: slug, remember: false })).join('\n\n---\n\n');
}

function galleryReadinessIssues(gallery) {
  return String(gallery || '')
    .split(/\n---\n/)
    .flatMap(card => activationCardReadinessIssues(card));
}

function activationCardReadinessIssues(card) {
  const operator = (String(card || '').match(/^OPERATOR:\s*(.+)$/m) || [null, 'unknown member'])[1];
  if (/\((missing|not ready)\)/.test(operator)) return [operator];
  return [];
}

function verifyActivationGallery(gallery) {
  const issues = galleryReadinessIssues(gallery);
  if (issues.length > 0) {
    throw new Error(`brain gallery not-ready member activation cards: ${issues.join(', ')}`);
  }
}

function verifyActivationCard(card) {
  const issues = activationCardReadinessIssues(card);
  if (issues.length > 0) {
    throw new Error(`brain activate non-executable member activation card: ${issues.join(', ')}`);
  }
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
    reward: Number.isFinite(reward) ? reward : 0,
    reward_source: episode.reward && episode.reward.source || 'task_review',
    lesson: episode.lesson || '',
    proof: episode.proof || '',
    next_task_suggestion: episode.next_task_suggestion || null,
    episode_created_at: episode.created_at || episode.ts || null,
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
  const stateDir = path.join(root, '.atris', 'state');
  const taskEpisodesPath = path.join(stateDir, 'task_episodes.jsonl');
  const scorecardsPath = path.join(stateDir, 'scorecards.jsonl');
  const workspace = readJson(path.join(root, '.atris', 'business.json')) || {};
  const taskEpisodes = readJsonlRows(taskEpisodesPath)
    .filter(row => row && row.schema === 'atris.task_episode.v1');
  const scoreableEpisodes = latestTaskEpisodes(taskEpisodes);
  const existing = readJsonlRows(scorecardsPath);
  const seenEpisodeIds = new Set(existing
    .map(row => row.source_episode_id)
    .filter(Boolean));

  const written = [];
  for (const episode of scoreableEpisodes) {
    const episodeId = episode.episode_id;
    if (seenEpisodeIds.has(episodeId)) continue;
    const scorecard = taskEpisodeScorecard(root, episode, workspace);
    appendJsonl(scorecardsPath, scorecard);
    seenEpisodeIds.add(episodeId);
    written.push(scorecard);
  }

  return {
    taskEpisodes: taskEpisodes.length,
    written: written.length,
    scorecards: written,
  };
}

function verifyTaskEpisodeScorecards(root) {
  const stateDir = path.join(root, '.atris', 'state');
  const taskEpisodes = readJsonlRows(path.join(stateDir, 'task_episodes.jsonl'))
    .filter(row => row && row.schema === 'atris.task_episode.v1');
  const scoreableEpisodes = latestTaskEpisodes(taskEpisodes);
  const scorecards = readJsonlRows(path.join(stateDir, 'scorecards.jsonl'));
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
  const existing = OPTIONAL_LOAD_ORDER_FILES
    .filter(rel => fs.existsSync(path.join(root, rel)));
  return [...GENERATED_LOAD_ORDER_FILES, ...existing];
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
  return `# Atris Brain Status

- Generated: ${state.generatedAt}
- Workspace: ${state.name}
- Slug: ${state.slug}
- Root: ${state.root}
- Now loaded: ${state.hasNow ? `yes (${state.nowHeading || 'no heading'})` : 'no'}
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

First-message rule: lead with the move before writing to the operator.
Purpose: optimize for decision-speed; lead with the move, then use descriptions only when they help the operator act.
Shape: \`<operator>, today is about <move>\` -> \`I picked this because <why now>\` -> \`Ready: <draft/proof/context>\` -> \`Go deeper: <paths>\`.
Definitions: operator = current person or agent; move = one concrete high-leverage workflow; why now = business reason; ready = prepared action or proof; paths = 2-4 optional deeper views.
`;
}

function renderLedger(state) {
  const rows = state.stateFiles.map(item => {
    const rel = path.relative(state.root, item.path).replace(/\\/g, '/');
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

function generatedBootBlock(state) {
  return `${GENERATED_START}
## Atris Brain Compile

This workspace has a compiled agent brain.

On session start, activate it first:
\`atris brain activate --root ${state.root} --verify\`

Load these first:
${renderBulletedLoadOrder(state)}

First-message rule: lead with the move before writing to the operator.
Purpose: optimize for decision-speed; lead with the move, then use descriptions only when they help the operator act.
Shape: \`<operator>, today is about <move>\` -> \`I picked this because <why now>\` -> \`Ready: <draft/proof/context>\` -> \`Go deeper: <paths>\`.
Definitions: operator = current person or agent; move = one concrete high-leverage workflow; why now = business reason; ready = prepared action or proof; paths = 2-4 optional deeper views.

Re-run after meaningful work:
\`atris brain compile --root ${state.root}\`
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

function writeBrain(state) {
  const brainDir = path.join(state.root, 'atris', 'brain');
  fs.mkdirSync(brainDir, { recursive: true });

  const statusPath = path.join(brainDir, 'STATUS.md');
  const ledgerPath = path.join(brainDir, 'self_improvement_ledger.md');
  const jsonPath = path.join(brainDir, 'state.json');

  fs.writeFileSync(statusPath, renderStatus(state), 'utf8');
  fs.writeFileSync(ledgerPath, renderLedger(state), 'utf8');
  fs.writeFileSync(jsonPath, JSON.stringify(state, null, 2) + '\n', 'utf8');

  const bootBlock = generatedBootBlock(state);
  for (const fileName of ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md']) {
    upsertGeneratedBlock(path.join(state.root, fileName), fileName.replace(/\.md$/, ''), bootBlock);
  }

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

  return { statusPath, ledgerPath, jsonPath };
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
    throw new Error(`brain compile missing: ${missing.join(', ')}`);
  }
  const status = readText(path.join(root, 'atris', 'brain', 'STATUS.md'));
  const ledger = readText(path.join(root, 'atris', 'brain', 'self_improvement_ledger.md'));
  if (!status.includes('## Next Move') || !ledger.includes('## Run N -> Run N+1 Mechanism')) {
    throw new Error('brain compile artifacts are missing required sections');
  }
}

function brainUsageLines() {
  return [
    'Usage: atris brain compile [--root <workspace>] [--verify] [--json]',
    '       atris brain activate [--member <slug>] [--root <workspace>] [--verify] [--json]',
    '       atris brain gallery [--root <workspace>] [--verify] [--json]',
    '       atris brain go|hold [note] [--recommendation <text>] [--root <workspace>] [--verify]',
    '       atris brain approval go|edit|hold [note] [--recommendation <text>] [--root <workspace>] [--verify]',
    '       atris brain scorecard [--root <workspace>] [--verify] [--json]',
    '       atris brain feedback --rating approve|edit|reject [--recommendation <text>] [--note <text>] [--root <workspace>] [--verify]',
    '       atris brain yes|edit|no [note] [--root <workspace>] [--verify]',
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
    console.log('');
    console.log('Atris brain approval recorded.');
    console.log(`  Approval: ${approval.approval_id}`);
    console.log(`  Decision: ${approval.human_decision}`);
    console.log(`  Status: ${approval.status}`);
    console.log('  Wrote: .atris/state/approvals.jsonl');
    console.log('  Next: proceed only if decision is go; otherwise edit or hold.');
    if (options.verify) console.log('  Verify: passed');
    console.log('');
    return;
  }

  if (subcommand === 'feedback' || ['yes', 'no', 'edit'].includes(subcommand)) {
    const result = recordFeedback(options);
    if (options.verify) verifyFeedback(options.root, result.scorecard.decision_id);
    if (options.json) {
      console.log(JSON.stringify({ ok: true, ...result }, null, 2));
      return;
    }
    console.log('');
    console.log('Atris brain feedback recorded.');
    console.log(`  Decision: ${result.scorecard.decision_id}`);
    console.log(`  Rating: ${result.scorecard.human_rating}`);
    console.log(`  Reward: ${result.scorecard.reward}`);
    console.log('  Wrote: .atris/state/scorecards.jsonl');
    console.log('  Wrote: .atris/state/episodes.jsonl');
    console.log('  Next: atris brain compile');
    if (options.verify) console.log('  Verify: passed');
    console.log('');
    return;
  }

  if (subcommand === 'scorecard' || subcommand === 'scorecards') {
    const result = recordTaskEpisodeScorecards(options);
    if (options.verify) verifyTaskEpisodeScorecards(options.root);
    if (options.json) {
      console.log(JSON.stringify({ ok: true, ...result }, null, 2));
      return;
    }
    console.log('');
    console.log('Atris brain scorecards recorded.');
    console.log(`  Task episodes: ${result.taskEpisodes}`);
    console.log(`  New scorecards: ${result.written}`);
    console.log('  Wrote: .atris/state/scorecards.jsonl');
    console.log('  Next: atris brain compile');
    if (options.verify) console.log('  Verify: passed');
    console.log('');
    return;
  }

  if (subcommand === 'activate') {
    const state = prepareBrainState(options.root);
    writeBrain(state);
    if (options.verify) verifyBrain(options.root);
    const card = renderActivationCard(state, options);
    if (options.json) {
      if (options.verify) {
        try {
          verifyActivationCard(card);
        } catch (error) {
          console.log(JSON.stringify({
            ok: false,
            error: error && error.message ? error.message : String(error),
            state,
            card,
          }, null, 2));
          process.exit(1);
        }
      }
      console.log(JSON.stringify({ ok: true, state, card }, null, 2));
      return;
    }
    console.log('');
    console.log(card);
    if (options.verify) {
      try {
        verifyActivationCard(card);
      } catch (error) {
        printVerifyFailure(error);
        return;
      }
      const operator = (card.match(/^OPERATOR:\s*(.+)$/m) || [null, 'unknown'])[1];
      if (operator === 'unknown') {
        console.log('VERIFY: brain artifacts present');
      } else {
        console.log('VERIFY: brain artifacts and member activation executable');
      }
    }
    console.log('');
    return;
  }
  if (subcommand === 'gallery') {
    const state = prepareBrainState(options.root);
    writeBrain(state);
    if (options.verify) verifyBrain(options.root);
    const gallery = renderActivationGallery(state);
    if (options.verify) {
      try {
        verifyActivationGallery(gallery);
      } catch (error) {
        if (options.json) {
          console.log(JSON.stringify({
            ok: false,
            error: error && error.message ? error.message : String(error),
            members: listMemberSlugs(options.root),
            gallery,
          }, null, 2));
          process.exit(1);
        }
        printVerifyFailure(error);
        return;
      }
    }
    if (options.json) {
      console.log(JSON.stringify({ ok: true, members: listMemberSlugs(options.root), gallery }, null, 2));
      return;
    }
    console.log('');
    console.log(gallery);
    if (options.verify) console.log('\nVERIFY: brain artifacts and member readiness present');
    console.log('');
    return;
  }
  if (subcommand !== 'compile' && subcommand !== 'status') {
    if (options.json) {
      console.log(JSON.stringify({
        ok: false,
        error: `unknown brain subcommand: ${subcommand}`,
        usage: brainUsageLines(),
      }, null, 2));
      process.exit(1);
    }
    printBrainUsage(console.error);
    process.exit(1);
  }

  const state = prepareBrainState(options.root);
  const written = writeBrain(state);
  if (options.verify) verifyBrain(options.root);

  if (options.json) {
    console.log(JSON.stringify({ ok: true, state, written }, null, 2));
    return;
  }

  console.log('');
  console.log('Atris brain compiled.');
  console.log(`  Workspace: ${state.name}`);
  console.log(`  State rows: ${state.totalRows} raw / ${state.validRows} valid`);
  console.log(`  Status: ${path.relative(options.root, written.statusPath).replace(/\\/g, '/')}`);
  console.log(`  Ledger: ${path.relative(options.root, written.ledgerPath).replace(/\\/g, '/')}`);
  console.log(`  Next: ${nextMove(state)}`);
  if (options.verify) console.log('  Verify: passed');
  console.log('');
}

module.exports = {
  brainCommand,
  collectState,
  prepareBrainState,
  renderStatus,
  renderLedger,
  renderActivationCard,
  renderActivationGallery,
  recordTaskEpisodeScorecards,
  recordFeedback,
  recordApproval,
  verifyActivationCard,
  verifyActivationGallery,
  verifyBrain,
};
