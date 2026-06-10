const fs = require('fs');
const path = require('path');
const { buildLatestCheck, buildPacket, writeLatestPacket } = require('./zero-shot');

const NOW_PATH = path.join('atris', 'now.md');
const TASK_EPISODES_PATH = path.join('.atris', 'state', 'task_episodes.jsonl');
const CAREER_XP_RECEIPTS_PATH = path.join('.atris', 'state', 'career_xp_receipts.jsonl');
const EXECUTABLE_TASK_STATUSES = new Set(['open', 'claimed']);
const TASK_RECEIPT_EVENTS = new Set(['proof_ready', 'reviewed', 'completed']);

function zeroShotFreshnessLabel(exists, fresh) {
  if (fresh) return 'fresh';
  if (exists) return 'stale';
  return 'missing';
}

function zeroShotGroupFreshnessLabel(fresh) {
  if (fresh === true) return 'fresh';
  if (fresh === false) return 'stale_or_missing';
  return 'unknown';
}

function zeroShotFirstRouteText(route) {
  if (!route) return 'none';
  const ref = route.ref || route.lane || 'workspace';
  return `${ref}/${route.model_tier || 'unknown'}`;
}

function zeroShotFirstByHorizonText(firstRoutes = {}) {
  return [
    `now=${zeroShotFirstRouteText(firstRoutes.now)}`,
    `review=${zeroShotFirstRouteText(firstRoutes.immediate_review)}`,
    `long=${zeroShotFirstRouteText(firstRoutes.long_term)}`,
    `blocked=${zeroShotFirstRouteText(firstRoutes.blocked)}`,
    `orient=${zeroShotFirstRouteText(firstRoutes.orient)}`,
  ].join(' ');
}

function zeroShotFirstByModelText(models = {}) {
  return ['fast', 'pro', 'validator', 'human']
    .map(tier => `${tier}=${zeroShotFirstRouteText(models[tier] && models[tier].first)}`)
    .join(' ');
}

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
  const hasRenderedSections = /^##\s+(Backlog|In Progress|Blocked|Completed)\s*$/m.test(content);
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
    if (!hasRenderedSections || ['Backlog', 'In Progress'].includes(section)) {
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

function zeroShotNowSummary(root = process.cwd()) {
  try {
    const packet = buildPacket({ cwd: root });
    const check = buildLatestCheck({ cwd: root });
    const decision = packet.decision || {};
    const routes = packet.routes || {};
    const horizons = routes.horizons || {};
    const models = routes.models || {};
    const command = packet.commands?.first_command || decision.first_command || 'atris 0-shot --prompt';
    const focus = decision.selected_ref ? ` ${decision.selected_ref}` : '';
    return {
      route: `${decision.lane || 'unknown'}${focus}`,
      command,
      menu: packet.commands?.zero_shot_all || 'atris 0-shot --all',
      prompt: packet.commands?.zero_shot_prompt || 'atris 0-shot --prompt',
      json: packet.commands?.zero_shot_json || 'atris 0-shot --json',
      check: check.check_command || 'atris 0-shot --check',
      write: check.refresh_command || 'atris 0-shot --write',
      menuFile: check.menu_txt || '.atris/state/zero-shot.menu.txt',
      promptFile: check.prompt_txt || '.atris/state/zero-shot.prompt.txt',
      durable: `status=${check.status} prompt=${zeroShotFreshnessLabel(check.prompt_exists, check.prompt_fresh)} menu=${zeroShotFreshnessLabel(check.menu_exists, check.menu_fresh)} model=${zeroShotGroupFreshnessLabel(check.model_prompts_fresh)} horizon=${zeroShotGroupFreshnessLabel(check.horizon_prompts_fresh)}`,
      inventory: `routes total=${routes.total || 0} compact=${routes.shown || 0} hidden=${routes.hidden_count || 0} full=routes.all_options`,
      buckets: `horizons now=${horizons.now || 0} review=${horizons.immediate_review || 0} long=${horizons.long_term || 0} blocked=${horizons.blocked || 0}; models fast=${models.fast?.count || 0} pro=${models.pro?.count || 0} validator=${models.validator?.count || 0} human=${models.human?.count || 0}`,
      firstByHorizon: zeroShotFirstByHorizonText(routes.horizon_first || {}),
      firstByModel: zeroShotFirstByModelText(models),
    };
  } catch {
    return {
      route: 'unavailable',
      command: 'atris 0-shot --prompt',
      menu: 'atris 0-shot --all',
      prompt: 'atris 0-shot --prompt',
      json: 'atris 0-shot --json',
      check: 'atris 0-shot --check',
      write: 'atris 0-shot --write',
      menuFile: '.atris/state/zero-shot.menu.txt',
      promptFile: '.atris/state/zero-shot.prompt.txt',
      durable: 'status=unavailable prompt=unknown menu=unknown model=unknown horizon=unknown',
      inventory: 'routes total=0 compact=0 hidden=0 full=routes.all_options',
      buckets: 'horizons now=0 review=0 long=0 blocked=0; models fast=0 pro=0 validator=0 human=0',
      firstByHorizon: 'now=none review=none long=none blocked=none orient=none',
      firstByModel: 'fast=none pro=none validator=none human=none',
    };
  }
}

function refreshZeroShotDurable(root = process.cwd()) {
  try {
    writeLatestPacket(buildPacket({ cwd: root }));
    return true;
  } catch {
    return false;
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
  const zeroShot = zeroShotNowSummary(root);
  const generated = todayIso();

  return `# now

> Current operating truth for this workspace.
> Read this first. Follow links only when needed.

Last updated: ${generated}

## What Matters Now

- Decide the next useful move before opening more context.
- 0-shot route: ${zeroShot.route} -> \`${zeroShot.command}\`
- 0-shot menu: \`${zeroShot.menu}\`
- 0-shot durable: ${zeroShot.durable}
- 0-shot files: \`${zeroShot.menuFile}\`, \`${zeroShot.promptFile}\`
- 0-shot inventory: ${zeroShot.inventory}
- 0-shot buckets: ${zeroShot.buckets}
- 0-shot first by horizon: ${zeroShot.firstByHorizon}
- 0-shot first by model: ${zeroShot.firstByModel}

## Current Priority

- Keep the workspace coherent and useful for the next human or agent.

## Signals

- Map: ${mapHeading}
- Open TODO items: ${openTodoCount}
- Inbox items today: ${inboxCount}
- Completed receipts today: ${completedCount}

## Watchouts

- Do not treat old logs as current truth unless this file links to them.
- Do not create motion for its own sake.
- If facts conflict, surface the conflict and cite the receipts.

## Next Move

- Run \`${zeroShot.menu}\` to inspect every 0-shot route before choosing work.
- Trust \`${zeroShot.menuFile}\` and prompt files only when \`${zeroShot.check}\` reports fresh; otherwise run \`${zeroShot.write}\`.
- Run \`${zeroShot.command}\` only when you are already following the selected 0-shot lane, or \`${zeroShot.prompt}\` for a copy-paste handoff.
- Use \`atris 0-shot --horizon now|review|long|blocked|orient --prompt\`, or fresh \`.atris/state/zero-shot.<now|review|long|blocked|orient>.prompt.txt\`, for a horizon-specific handoff.
- Read \`atris/MAP.md\`, \`atris/TODO.md\`, and today's journal only as needed for the task in front of you.

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
    if (isWorkspace) refreshZeroShotDurable(root);
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
  if (isWorkspace) refreshZeroShotDurable(root);
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
  findChildWorkspaces,
  isGeneratedNowFile,
  nowAtris,
  refreshNowFile,
  renderDefaultNow,
  renderPortfolioNow,
};
