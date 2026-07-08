const fs = require('fs');
const path = require('path');
const { hasRenderedSections, isOpenSection } = require('../lib/todo-sections');

const NOW_PATH = path.join('atris', 'now.md');
const TASK_EPISODES_PATH = path.join('.atris', 'state', 'task_episodes.jsonl');
const CAREER_XP_RECEIPTS_PATH = path.join('.atris', 'state', 'career_xp_receipts.jsonl');
const EXECUTABLE_TASK_STATUSES = new Set(['open', 'claimed']);
const TASK_RECEIPT_EVENTS = new Set(['proof_ready', 'reviewed', 'completed']);

function formatLocalDate(date = new Date()) {
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function todayIso() {
  return formatLocalDate(new Date());
}

function ensureAtrisDir(root = process.cwd()) {
  const atrisDir = path.join(root, 'atris');
  if (!fs.existsSync(atrisDir)) {
    throw new Error('atris/ folder not found. Run "atris init" first.');
  }
  return atrisDir;
}

function hasWorkspaceMarkers(atrisDir) {
  return fs.existsSync(path.join(atrisDir, 'MAP.md')) || fs.existsSync(path.join(atrisDir, 'TODO.md'));
}

function findChildWorkspaces(root = process.cwd()) {
  if (!fs.existsSync(root)) return [];

  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => {
      const workspaceRoot = path.join(root, entry.name);
      const atrisDir = path.join(workspaceRoot, 'atris');
      if (!fs.existsSync(atrisDir) || !hasWorkspaceMarkers(atrisDir)) return null;
      const mapPath = path.join(atrisDir, 'MAP.md');
      const todoPath = path.join(atrisDir, 'TODO.md');
      return {
        slug: entry.name,
        root: workspaceRoot,
        atrisDir,
        mapPath,
        todoPath,
        nowPath: path.join(atrisDir, 'now.md'),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

function readFirstHeading(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const content = fs.readFileSync(filePath, 'utf8');
  const line = content.split(/\r?\n/).find((l) => l.trim().startsWith('#'));
  return line ? line.replace(/^#+\s*/, '').trim() : null;
}

function countMatches(filePath, pattern) {
  if (!fs.existsSync(filePath)) return 0;
  const content = fs.readFileSync(filePath, 'utf8');
  return (content.match(pattern) || []).length;
}

function countOpenTodoItems(filePath) {
  if (!fs.existsSync(filePath)) return 0;
  const content = fs.readFileSync(filePath, 'utf8');
  // Emoji-decorated headings ("## In Progress 🔄") handled by lib/todo-sections.
  const rendered = hasRenderedSections(content);
  let section = null;
  let count = 0;

  for (const line of content.split(/\r?\n/)) {
    const heading = line.match(/^##\s+(.+?)\s*$/);
    if (heading) {
      section = heading[1];
      continue;
    }
    const isTaskBullet = /^-\s+(?:\[[ ]\]\s+)?\*\*.+?\*\*/.test(line);
    if (!isTaskBullet) continue;
    if (!rendered || isOpenSection(section)) {
      count += 1;
    }
  }

  return count;
}

function countTaskProjectionItems(root = process.cwd()) {
  const projectionPath = path.join(root, '.atris', 'state', 'tasks.projection.json');
  if (!fs.existsSync(projectionPath)) return null;
  try {
    const projection = JSON.parse(fs.readFileSync(projectionPath, 'utf8'));
    const tasks = Array.isArray(projection?.tasks) ? projection.tasks : null;
    if (!tasks) return null;
    return tasks.filter(task => EXECUTABLE_TASK_STATUSES.has(String(task?.status || '').toLowerCase())).length;
  } catch {
    return null;
  }
}

function countOpenWorkItems(root = process.cwd(), todoPath = path.join(root, 'atris', 'TODO.md')) {
  const projectionCount = countTaskProjectionItems(root);
  if (projectionCount !== null) return projectionCount;
  return countOpenTodoItems(todoPath);
}

function countJournalCompletedReceipts(filePath) {
  if (!fs.existsSync(filePath)) return 0;
  const content = fs.readFileSync(filePath, 'utf8');
  const proofReceipts = content.match(/^\s*Proof:\s+\S/gm) || [];
  if (proofReceipts.length > 0) return proofReceipts.length;
  return countMatches(filePath, /^-\s+\*\*C\d+:/gm);
}

function readJsonlRows(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .map(line => line.trim())
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

function localDateKey(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return formatLocalDate(date);
}

function normalizeRoot(value) {
  if (!value) return null;
  try {
    return fs.realpathSync(value);
  } catch {
    return path.resolve(String(value));
  }
}

function rowMatchesWorkspace(rowRoot, root) {
  if (!rowRoot) return true;
  return normalizeRoot(rowRoot) === normalizeRoot(root);
}

function taskReceiptProof(row) {
  return String(
    row?.proof
    || row?.proof_ref
    || row?.review?.proof
    || row?.state?.metadata?.latest_agent_proof
    || '',
  ).trim();
}

function taskReceiptKey(row, fallback) {
  const episodeId = row?.episode_id || row?.source_episode_id;
  if (episodeId) return `episode:${episodeId}`;
  if (row?.receipt_id) return `receipt:${row.receipt_id}`;
  if (row?.task_id || row?.source_task_id) return `task:${row.task_id || row.source_task_id}:${fallback}`;
  return `row:${fallback}`;
}

function countTaskReceiptsToday(root = process.cwd(), date = new Date()) {
  const targetDay = formatLocalDate(date);
  const stateDir = path.join(root, '.atris', 'state');
  const seen = new Set();

  for (const row of readJsonlRows(path.join(stateDir, 'task_episodes.jsonl'))) {
    if (localDateKey(row?.created_at) !== targetDay) continue;
    if (!rowMatchesWorkspace(row?.workspace_root, root)) continue;
    if (!taskReceiptProof(row)) continue;
    const eventType = String(row?.action?.event_type || '').toLowerCase();
    if (eventType && !TASK_RECEIPT_EVENTS.has(eventType)) continue;
    seen.add(taskReceiptKey(row, seen.size));
  }

  for (const row of readJsonlRows(path.join(stateDir, 'career_xp_receipts.jsonl'))) {
    if (localDateKey(row?.accepted_at || row?.created_at || row?.ts) !== targetDay) continue;
    if (!rowMatchesWorkspace(row?.workspace_root, root)) continue;
    if (!taskReceiptProof(row)) continue;
    const source = String(row?.source_type || row?.receipt_id || row?.source || '').toLowerCase();
    if (!source.includes('task')) continue;
    seen.add(taskReceiptKey(row, seen.size));
  }

  return seen.size;
}

function compactLine(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function truncateLine(value, max) {
  const s = compactLine(value);
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1).trimEnd()}…`;
}

function taskReceiptTitle(row) {
  return compactLine(row?.state?.title || row?.title || row?.task_id || 'untitled work');
}

// The receipts behind "Completed receipts today", as lines a human can read:
// one per task, latest event wins, title + proof.
function todayTaskReceiptLines(root = process.cwd(), date = new Date(), limit = 6) {
  const targetDay = formatLocalDate(date);
  const byTask = new Map();
  for (const row of readJsonlRows(path.join(root, '.atris', 'state', 'task_episodes.jsonl'))) {
    if (localDateKey(row?.created_at) !== targetDay) continue;
    if (!rowMatchesWorkspace(row?.workspace_root, root)) continue;
    const proof = taskReceiptProof(row);
    if (!proof) continue;
    const eventType = String(row?.action?.event_type || '').toLowerCase();
    if (eventType && !TASK_RECEIPT_EVENTS.has(eventType)) continue;
    byTask.set(row?.task_id || row?.episode_id || byTask.size, {
      title: taskReceiptTitle(row),
      proof,
    });
  }
  return Array.from(byTask.values())
    .slice(-limit)
    .reverse()
    .map((r) => `- ✓ ${truncateLine(r.title, 90)} — ${truncateLine(r.proof, 70)}`);
}

// What actually landed on this branch in the last day — the fleet's overnight
// merges are the strongest "the computer worked while you were away" evidence.
function landedCommitLines(root = process.cwd(), limit = 5) {
  try {
    const { execFileSync } = require('node:child_process');
    const out = execFileSync(
      'git',
      ['log', '--since=24 hours ago', '--no-merges', '--format=%s', '-n', '40'],
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const seen = new Set();
    const lines = [];
    for (const subject of out.split('\n')) {
      const s = compactLine(subject);
      if (!s || seen.has(s)) continue;
      seen.add(s);
      lines.push(`- ↑ ${truncateLine(s, 90)}`);
      if (lines.length >= limit) break;
    }
    return lines;
  } catch {
    return [];
  }
}

// The one thing only the owner can answer. Prefers an explicit owner action;
// falls back to a blocked loop's open question (needs_human). Loops ask here —
// they never invent the answer themselves.
function nextOwnerActionLine(root = process.cwd()) {
  const statusPath = path.join(root, 'atris', 'status', 'master-loop.md');
  if (!fs.existsSync(statusPath)) return null;
  const lines = fs.readFileSync(statusPath, 'utf8').split(/\r?\n/);
  for (const prefix of ['- next_owner_action:', '- needs_human:']) {
    const line = lines.find((l) => l.startsWith(prefix));
    if (line) {
      const action = truncateLine(line.replace(prefix, ''), 220);
      if (action) return action;
    }
  }
  return null;
}

function currentMissionMoveLine(root = process.cwd()) {
  try {
    const { selectCodexGoalMission, codexGoalNextCommand } = require('./mission');
    const selected = selectCodexGoalMission(root);
    const mission = selected?.mission || null;
    if (!mission) return null;
    // Truncated hard: a raw mission objective + raw command once made the whole
    // card unreadable. The card states the move; the mission file has the rest.
    const objective = truncateLine(mission.objective, 140);
    const next = truncateLine(codexGoalNextCommand(mission), 110);
    if (!objective || !next) return null;
    return `The move: ${objective} — next: ${next}`;
  } catch {
    return null;
  }
}

function currentJournalPath(root = process.cwd()) {
  const now = new Date();
  const year = String(now.getFullYear());
  const date = todayIso();
  return path.join(root, 'atris', 'logs', year, `${date}.md`);
}

function renderDefaultNow(root = process.cwd()) {
  const atrisDir = ensureAtrisDir(root);
  const mapHeading = readFirstHeading(path.join(atrisDir, 'MAP.md')) || 'MAP not filled yet';
  const todoPath = path.join(atrisDir, 'TODO.md');
  const journalPath = currentJournalPath(root);
  const openTodoCount = countOpenWorkItems(root, todoPath);
  const inboxCount = countMatches(journalPath, /^-\s+\*\*I\d+:/gm);
  const taskReceiptCount = countTaskReceiptsToday(root);
  const completedCount = taskReceiptCount || countJournalCompletedReceipts(journalPath);
  const generated = todayIso();
  const moveLine = currentMissionMoveLine(root);
  const whatMattersNow = moveLine
    ? `${moveLine}\n\n- Decide the next useful move before opening more context.`
    : '- Decide the next useful move before opening more context.';
  const receiptLines = todayTaskReceiptLines(root);
  const commitLines = landedCommitLines(root);
  const awayLines = [...receiptLines, ...commitLines];
  const whileAway = awayLines.length
    ? awayLines.join('\n')
    : '- Nothing has landed yet today.';
  const ownerAction = nextOwnerActionLine(root);
  const needsYou = ownerAction ? `\n## Needs You\n\n- ${ownerAction}\n` : '';

  return `# now

> Current operating truth for this workspace.
> Read this first. Follow links only when needed.

Last updated: ${generated}

## What Matters Now

${whatMattersNow}

## While You Were Away

${whileAway}
${needsYou}
## Current Priority

- Keep the workspace coherent and useful for the next human or agent.

## Signals

- Map: ${mapHeading}
- Open TODO items: ${openTodoCount}
- Inbox items today: ${inboxCount}
- Completed receipts today: ${completedCount}

## Receipts

- \`atris/MAP.md\`
- \`atris/TODO.md\`
- \`${path.relative(root, journalPath)}\`
`;
}

function renderPortfolioNow(root = process.cwd()) {
  const workspaces = findChildWorkspaces(root);
  if (workspaces.length === 0) {
    throw new Error('atris/ folder not found. Run "atris init" first.');
  }

  const generated = todayIso();
  const lines = workspaces.map((workspace) => {
    const heading = readFirstHeading(workspace.mapPath) || workspace.slug;
    const todoCount = countOpenWorkItems(workspace.root, workspace.todoPath);
    const nowState = fs.existsSync(workspace.nowPath) ? 'has now.md' : 'needs now.md';
    return `- ${workspace.slug}: ${heading}; ${todoCount} open TODO item${todoCount === 1 ? '' : 's'}; ${nowState}.`;
  });

  return `# now

> Current operating truth for this portfolio of Atris workspaces.
> Read this first. Then enter the specific workspace that matters.

Last updated: ${generated}

## What Matters Now

- Keep the active business workspaces easy to scan, update, and hand off.

## Current Priority

- Use the child workspace with the right slug; avoid creating duplicate business brains.

## Workspace Signals

${lines.join('\n')}

## Watchouts

- Parent status is a map, not the source of truth for each business.
- Each active workspace should own its own \`atris/now.md\`.
- If slugs conflict, resolve the workspace identity before pushing or pulling.

## Next Move

- Run \`atris now\` inside the workspace you are about to operate.

## Receipts

${workspaces.map((workspace) => `- \`${workspace.slug}/atris/MAP.md\``).join('\n')}
`;
}

function isGeneratedNowFile(content) {
  const text = String(content || '');
  const hasGeneratedSignature = (
    text.includes('> Current operating truth for this workspace.') ||
    text.includes('> Current operating truth for this portfolio of Atris workspaces.')
  ) && text.includes('## Receipts');
  const hasLegacyGeneratedCounters = /^#\s+now\s*$/m.test(text)
    && /Open TODO items:\s*\d+/m.test(text)
    && /Completed receipts today:\s*\d+/m.test(text);
  return hasGeneratedSignature || hasLegacyGeneratedCounters;
}

function ensureNowFile(root = process.cwd()) {
  let atrisDir = path.join(root, 'atris');
  const isWorkspace = fs.existsSync(atrisDir) && hasWorkspaceMarkers(atrisDir);
  const childWorkspaces = isWorkspace ? [] : findChildWorkspaces(root);
  if (!isWorkspace && childWorkspaces.length === 0) {
    ensureAtrisDir(root);
  }
  if (!isWorkspace && childWorkspaces.length > 0) {
    fs.mkdirSync(atrisDir, { recursive: true });
  }
  const nowPath = path.join(atrisDir, 'now.md');
  if (!fs.existsSync(nowPath)) {
    const content = isWorkspace ? renderDefaultNow(root) : renderPortfolioNow(root);
    fs.writeFileSync(nowPath, content, 'utf8');
    return { created: true, path: nowPath };
  }
  return { created: false, path: nowPath };
}

function refreshNowFile(root = process.cwd(), options = {}) {
  const atrisDir = path.join(root, 'atris');
  const isWorkspace = fs.existsSync(atrisDir) && hasWorkspaceMarkers(atrisDir);
  const childWorkspaces = isWorkspace ? [] : findChildWorkspaces(root);
  if (!isWorkspace && childWorkspaces.length === 0) {
    ensureAtrisDir(root);
  }
  if (!isWorkspace && childWorkspaces.length > 0) {
    fs.mkdirSync(atrisDir, { recursive: true });
  }
  const nowPath = path.join(atrisDir, 'now.md');
  if (options.preserveCustom && fs.existsSync(nowPath)) {
    const current = fs.readFileSync(nowPath, 'utf8');
    if (!isGeneratedNowFile(current)) {
      return { path: nowPath, preserved: true };
    }
  }
  const content = isWorkspace ? renderDefaultNow(root) : renderPortfolioNow(root);
  fs.writeFileSync(nowPath, content, 'utf8');
  return { path: nowPath, preserved: false };
}

function nowAtris(args = process.argv.slice(3), root = process.cwd()) {
  const help = args.includes('--help') || args.includes('-h') || args[0] === 'help';
  if (help) {
    console.log('Usage: atris now [--init|--refresh|--all|--path]');
    console.log('');
    console.log('Show the current operating truth for this workspace.');
    console.log('');
    console.log('  atris now           Show atris/now.md');
    console.log('  atris now --init    Create atris/now.md if missing');
    console.log('  atris now --refresh Regenerate a small local now.md');
    console.log('  atris now --all     Refresh this parent and every child Atris workspace');
    console.log('  atris now --path    Print the file path only');
    return;
  }

  const init = args.includes('--init');
  const refresh = args.includes('--refresh');
  const all = args.includes('--all');
  const pathOnly = args.includes('--path');

  let result;
  if (all) {
    const workspaces = findChildWorkspaces(root);
    for (const workspace of workspaces) {
      refreshNowFile(workspace.root);
    }
    result = refreshNowFile(root);
    if (!pathOnly) {
      console.log(`Refreshed ${workspaces.length} child workspace${workspaces.length === 1 ? '' : 's'}.`);
      console.log('');
    }
  } else if (refresh) {
    result = refreshNowFile(root);
  } else if (init) {
    result = ensureNowFile(root);
  } else {
    result = ensureNowFile(root);
  }

  const rel = path.relative(root, result.path);
  if (pathOnly) {
    console.log(rel);
    return;
  }

  if (result.created) {
    console.log(`Created ${rel}`);
    console.log('');
  }

  const content = fs.readFileSync(result.path, 'utf8').trimEnd();
  console.log(content);
}

module.exports = {
  NOW_PATH,
  TASK_EPISODES_PATH,
  CAREER_XP_RECEIPTS_PATH,
  ensureNowFile,
  formatLocalDate,
  countJournalCompletedReceipts,
  countOpenWorkItems,
  countOpenTodoItems,
  countTaskReceiptsToday,
  currentMissionMoveLine,
  landedCommitLines,
  nextOwnerActionLine,
  todayTaskReceiptLines,
  truncateLine,
  findChildWorkspaces,
  isGeneratedNowFile,
  nowAtris,
  refreshNowFile,
  renderDefaultNow,
  renderPortfolioNow,
};
