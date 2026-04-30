const fs = require('fs');
const path = require('path');

const NOW_PATH = path.join('atris', 'now.md');

function todayIso() {
  return new Date().toISOString().split('T')[0];
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
  const backlogCount = countMatches(todoPath, /^-\s+\*\*.+?\*\*/gm);
  const inboxCount = countMatches(journalPath, /^-\s+\*\*I\d+:/gm);
  const completedCount = countMatches(journalPath, /^-\s+\*\*C\d+:/gm);
  const generated = todayIso();

  return `# now

> Current operating truth for this workspace.
> Read this first. Follow links only when needed.

Last updated: ${generated}

## What Matters Now

- Decide the next useful move before opening more context.

## Current Priority

- Keep the workspace coherent and useful for the next human or agent.

## Signals

- Map: ${mapHeading}
- TODO items visible: ${backlogCount}
- Inbox items today: ${inboxCount}
- Completed receipts today: ${completedCount}

## Watchouts

- Do not treat old logs as current truth unless this file links to them.
- Do not create motion for its own sake.
- If facts conflict, surface the conflict and cite the receipts.

## Next Move

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
    const todoCount = countMatches(workspace.todoPath, /^-\s+\*\*.+?\*\*/gm);
    const nowState = fs.existsSync(workspace.nowPath) ? 'has now.md' : 'needs now.md';
    return `- ${workspace.slug}: ${heading}; ${todoCount} visible TODO item${todoCount === 1 ? '' : 's'}; ${nowState}.`;
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

function refreshNowFile(root = process.cwd()) {
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
  const content = isWorkspace ? renderDefaultNow(root) : renderPortfolioNow(root);
  fs.writeFileSync(nowPath, content, 'utf8');
  return { path: nowPath };
}

function nowAtris(args = process.argv.slice(3), root = process.cwd()) {
  const help = args.includes('--help') || args.includes('-h');
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
  ensureNowFile,
  findChildWorkspaces,
  nowAtris,
  refreshNowFile,
  renderDefaultNow,
  renderPortfolioNow,
};
