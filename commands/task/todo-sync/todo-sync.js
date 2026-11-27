'use strict';

// commands/task/todo-sync/todo-sync.js: Moving tasks between the task store and files: import,
// export, events, lineage, setup, where, render to TODO.md and sync.
// Owner: unassigned. Moved out of commands/task.js on 2026-11-16 by lib/split-file.js; read
// README.md first.

// Names borrowed from commands/task.js and other feature folders, set by bindMain().
let fs, path, hasFlag, escapeRegExp, writeFileAtomic, DEFAULT_OWNER, getTaskDb, flag,
  taskScopeEverywhere, scopedWorkspaceRoot, wantsJson, printJson, failTask, positional, taskRef,
  writeDefaultProjection, readLocalBusinessBinding, enrichTaskProjection, syncPlanForProjection,
  formatTaskEventCompact, requireTaskId, RENDERED_TODO_BULLET_REF;
function bindMain(deps) {
  ({
    fs, path, hasFlag, escapeRegExp, writeFileAtomic, DEFAULT_OWNER, getTaskDb, flag,
    taskScopeEverywhere, scopedWorkspaceRoot, wantsJson, printJson, failTask, positional, taskRef,
    writeDefaultProjection, readLocalBusinessBinding, enrichTaskProjection, syncPlanForProjection,
    formatTaskEventCompact, requireTaskId, RENDERED_TODO_BULLET_REF,
  } = deps);
}

function importTodoFile(taskDb, db, target) {
  const filePath = path.resolve(target);
  if (!fs.existsSync(filePath)) {
    return { ok: false, reason: 'not_found', filePath };
  }
  const { parseTodoFile } = require('../../../lib/todo-fallback');
  const parsed = parseTodoFile(filePath);
  const ws = taskDb.workspaceRoot();
  const all = [
    ...parsed.backlog.map(t => ({ ...t, importStatus: 'open', sourceFile: filePath })),
    ...parsed.inProgress.map(t => ({ ...t, importStatus: 'claimed', sourceFile: filePath })),
    ...(parsed.review || []).map(t => ({ ...t, importStatus: 'review', sourceFile: filePath })),
  ];
  const knownTitles = new Set(
    taskDb.listTasks(db, { workspaceRoot: ws, limit: 500 }).map((row) => taskDb.normalizeTitle(row.title))
  );
  let inserted = 0;
  let skipped = 0;
  for (const t of all) {
    if (!t.title) continue;
    const normalized = taskDb.normalizeTitle(t.title);
    if (knownTitles.has(normalized)) {
      skipped++;
      continue;
    }
    const sk = taskDb.sourceKey(t.sourceFile || filePath, t.title);
    const result = taskDb.addTask(db, {
      title: t.title,
      tag: t.tag || null,
      workspaceRoot: ws,
      sourceKey: sk,
      status: t.importStatus,
      claimedBy: t.claimed || null,
      metadata: { todo_id: t.id, todo_tags: t.tags || [], claimed: t.claimed, stage: t.stage, verify: t.verify },
    });
    if (result.inserted) {
      inserted++;
      knownTitles.add(normalized);
    } else {
      skipped++;
    }
  }
  return { ok: true, inserted, skipped, filePath, knownTitles };
}

function importJournalFile(taskDb, db, journalPath, knownTitles = null) {
  const filePath = path.resolve(journalPath);
  if (!fs.existsSync(filePath)) {
    return { ok: false, reason: 'not_found', filePath, inserted: 0, skipped: 0 };
  }
  const { parseSection } = require('../../../lib/todo-fallback');
  const { parseInboxItems } = require('../../../lib/file-ops');
  const content = fs.readFileSync(filePath, 'utf8');
  const ws = taskDb.workspaceRoot();
  const titles = knownTitles || new Set(
    taskDb.listTasks(db, { workspaceRoot: ws, limit: 500 }).map((row) => taskDb.normalizeTitle(row.title))
  );
  const all = [
    ...parseSection(content, 'Backlog').map((t) => ({ ...t, importStatus: 'open' })),
    ...parseSection(content, 'In Progress').map((t) => ({ ...t, importStatus: 'claimed' })),
    ...parseInboxItems(content).map((item) => ({
      id: `I${item.id}`,
      title: item.text,
      tag: 'inbox',
      importStatus: 'open',
    })),
  ];
  let inserted = 0;
  let skipped = 0;
  for (const t of all) {
    if (!t.title) continue;
    const normalized = taskDb.normalizeTitle(t.title);
    if (titles.has(normalized)) {
      skipped++;
      continue;
    }
    const sk = taskDb.sourceKey(filePath, t.title);
    const result = taskDb.addTask(db, {
      title: t.title,
      tag: t.tag || null,
      workspaceRoot: ws,
      sourceKey: sk,
      status: t.importStatus,
      claimedBy: t.claimed || null,
      metadata: { todo_id: t.id, source: 'journal_import' },
    });
    if (result.inserted) {
      inserted++;
      titles.add(normalized);
    } else {
      skipped++;
    }
  }
  return { ok: true, inserted, skipped, filePath };
}

function todayJournalPath() {
  const { getLogPath } = require('../../../lib/file-ops');
  return getLogPath().logFile;
}

function cmdImport(args) {
  const pos = positional(args);
  const target = pos[0] || 'atris/TODO.md';
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const result = importTodoFile(taskDb, db, target);
  if (!result.ok) {
    console.error(`atris task import: file not found: ${result.filePath}`);
    process.exit(2);
  }
  const journalResult = importJournalFile(taskDb, db, todayJournalPath(), result.knownTitles);
  const inserted = result.inserted + (journalResult.ok ? journalResult.inserted : 0);
  const skipped = result.skipped + (journalResult.ok ? journalResult.skipped : 0);
  const { outPath } = writeDefaultProjection(taskDb, db);
  if (wantsJson(args)) {
    printJson({
      ok: true,
      action: 'imported',
      inserted,
      skipped,
      source: result.filePath,
      journal: journalResult.ok ? journalResult.filePath : null,
      projection_path: outPath,
    });
    return;
  }
  console.log(`imported ${inserted} new, skipped ${skipped} (already imported), source=${result.filePath}`);
  if (journalResult.ok && journalResult.inserted > 0) {
    console.log(`journal imported ${journalResult.inserted} from ${journalResult.filePath}`);
  }
}

function cmdWhere(args) {
  const taskDb = getTaskDb();
  if (wantsJson(args)) {
    printJson({
      ok: true,
      db: taskDb.getDbPath(),
      workspace: taskDb.workspaceRoot(),
      owner: DEFAULT_OWNER,
    });
    return;
  }
  console.log(`db:        ${taskDb.getDbPath()}`);
  console.log(`workspace: ${taskDb.workspaceRoot()}`);
  console.log(`owner:     ${DEFAULT_OWNER}`);
}

function cmdEvents(args) {
  const pos = positional(args);
  let taskId = pos[0] || null;
  const all = hasFlag(args, '--all');
  const everywhere = taskScopeEverywhere(args);
  const hasLimitFlag = hasFlag(args, '--limit') || args.some(a => String(a).startsWith('--limit='));
  const rawLimit = flag(args, '--limit');
  let explicitLimit = null;
  if (hasLimitFlag) {
    const trimmed = typeof rawLimit === 'string' ? rawLimit.trim() : '';
    const parsed = Number(trimmed);
    if (!trimmed || !/^\d+$/.test(trimmed) || !Number.isSafeInteger(parsed) || parsed <= 0) {
      failTask('atris task events', 'invalid_limit', '--limit must be a positive integer');
    }
    explicitLimit = parsed;
  }
  const defaultRecentLimit = 24;
  const limit = explicitLimit || (taskId ? 500 : (all || everywhere ? null : defaultRecentLimit));
  const taskDb = getTaskDb();
  const db = taskDb.open();
  if (taskId) taskId = requireTaskId(taskDb, db, taskId, 'atris task events');
  const workspaceRoot = scopedWorkspaceRoot(taskDb, args, { everywhere });
  const events = taskDb.listTaskEvents(db, {
    taskId,
    workspaceRoot: taskId ? null : workspaceRoot,
    limit,
    order: taskId || all || everywhere ? 'asc' : 'desc',
  });
  const refRows = taskDb.listTasks(db, {
    workspaceRoot: everywhere ? null : (taskId ? (taskDb.getTask(db, taskId) || {}).workspace_root : workspaceRoot),
  });
  const refById = taskDb.taskDisplayRefMap(refRows);
  if (wantsJson(args)) {
    printJson({
      ok: true,
      action: 'events',
      task_id: taskId,
      mode: taskId ? 'task' : (everywhere ? 'ledger_everywhere' : (all ? 'ledger' : 'recent')),
      limit,
      events,
    });
    return;
  }
  if (events.length === 0) {
    console.log('(no task events)');
    return;
  }
  if (!taskId && !all && !everywhere) {
    console.log('TASK EVENTS');
    console.log(`recent ${events.length} event${events.length === 1 ? '' : 's'} (use --all for the full ledger, --limit N to adjust)`);
    console.log('');
    for (const e of events) console.log(formatTaskEventCompact(e, refById));
    return;
  }
  for (const e of events) {
    const actor = e.actor ? ` actor=${e.actor}` : '';
    console.log(`${e.version}\t${e.event_type}\t${refById.get(e.task_id) || taskRef(e.task_id)}${actor}\t${JSON.stringify(e.payload || {})}`);
  }
}

function cmdLineage(args) {
  const pos = positional(args);
  const id = pos[0];
  if (!id) {
    failTask('atris task lineage', 'missing_id', 'id required');
  }
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const taskId = requireTaskId(taskDb, db, id, 'atris task lineage');
  const enriched = enrichTaskProjection(taskDb.taskProjection(db, { workspaceRoot: taskDb.workspaceRoot(), limit: 1000 }));
  const byId = new Map();
  for (const t of enriched.tasks) byId.set(t.id, t);
  const target = byId.get(taskId);
  if (!target) {
    console.error(`task not found: ${id}`);
    process.exit(1);
  }

  const parents = [];
  let cursor = target;
  const seen = new Set();
  while (cursor) {
    const parentId = cursor.lineage && cursor.lineage.parent_task_id;
    if (!parentId || seen.has(parentId)) break;
    seen.add(parentId);
    const parent = byId.get(parentId);
    if (!parent) break;
    parents.unshift(parent);
    cursor = parent;
  }

  const childIds = target.lineage && target.lineage.child_task_ids || [];
  const children = childIds.map(cid => byId.get(cid)).filter(Boolean);

  const chain = [...parents, target, ...children];

  let commits = [];
  try {
    const { spawnSync: sp } = require('child_process');
    const displayRefs = chain.map(t => taskRef(t)).filter(Boolean);
    const pattern = displayRefs.join('\\|');
    const result = sp('git', ['log', '--oneline', '--all', `--grep=${pattern}`], {
      encoding: 'utf8',
      timeout: 5000,
    });
    if (result.status === 0 && result.stdout) {
      commits = result.stdout.trim().split('\n').filter(Boolean);
    }
  } catch (_) {
    commits = [];
  }

  if (wantsJson(args)) {
    printJson({
      ok: true,
      action: 'lineage',
      chain: {
        endgame: parents.length ? parents[0] : null,
        parents: parents.slice(1),
        target,
        children,
        commits,
      },
    });
    return;
  }

  if (parents.length) {
    for (let i = 0; i < parents.length; i += 1) {
      const p = parents[i];
      console.log(`${'  '.repeat(i)}${taskRef(p)} ${p.title} [${p.status}]`);
    }
  }
  const indent = '  '.repeat(parents.length);
  console.log(`${indent}${taskRef(target)} ${target.title} [${target.status}]`);
  for (const child of children) {
    console.log(`${'  '.repeat(parents.length + 1)}${taskRef(child)} ${child.title} [${child.status}]`);
  }
  if (commits.length) {
    console.log('');
    console.log('commits:');
    for (const c of commits) console.log(`  ${c}`);
  }
}

function cmdExport(args) {
  const hasOutFlag = hasFlag(args, '--out') || args.some(a => String(a).startsWith('--out='));
  const rawOut = flag(args, '--out');
  if (hasOutFlag && (typeof rawOut !== 'string' || !rawOut.trim() || rawOut.trim().startsWith('-'))) {
    failTask('atris task export', 'invalid_out', '--out requires a file path');
  }
  const out = rawOut || path.join('.atris', 'state', 'tasks.projection.json');
  const all = hasFlag(args, '--all');
  const everywhere = taskScopeEverywhere(args);
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const outPath = path.resolve(String(out));
  const projection = enrichTaskProjection(taskDb.taskProjection(db, {
    workspaceRoot: scopedWorkspaceRoot(taskDb, args, { everywhere }),
    limit: all ? null : 500,
  }));
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(projection, null, 2) + '\n', 'utf8');
  if (wantsJson(args)) {
    printJson({
      ok: true,
      action: 'exported',
      count: projection.tasks.length,
      projection_path: outPath,
      projection,
    });
    return;
  }
  console.log(`exported ${projection.tasks.length} task${projection.tasks.length === 1 ? '' : 's'} -> ${outPath}`);
}

function cmdSetup(args) {
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const ws = taskDb.workspaceRoot();
  let importResult = null;
  let journalResult = null;
  if (hasFlag(args, '--import-todo')) {
    importResult = importTodoFile(taskDb, db, flag(args, '--todo') || 'atris/TODO.md');
    if (!importResult.ok && flag(args, '--todo')) {
      console.error(`atris task setup: TODO file not found: ${importResult.filePath}`);
      process.exit(2);
    }
    if (importResult.ok) {
      journalResult = importJournalFile(taskDb, db, todayJournalPath(), importResult.knownTitles);
      importResult = {
        ...importResult,
        inserted: importResult.inserted + (journalResult.ok ? journalResult.inserted : 0),
        skipped: importResult.skipped + (journalResult.ok ? journalResult.skipped : 0),
        journal: journalResult.ok ? journalResult.filePath : null,
      };
    }
  }
  const { projection, outPath } = writeDefaultProjection(taskDb, db);
  if (wantsJson(args)) {
    printJson({
      ok: true,
      action: 'setup',
      count: projection.tasks.length,
      projection_path: outPath,
      import: importResult && importResult.ok ? {
        inserted: importResult.inserted,
        skipped: importResult.skipped,
        source: importResult.filePath,
        journal: importResult.journal || null,
      } : null,
      projection,
    });
    return;
  }
  console.log(`tasks ready: ${projection.tasks.length} task${projection.tasks.length === 1 ? '' : 's'}`);
  console.log(`projection: ${outPath}`);
  if (importResult && importResult.ok) {
    console.log(`imported ${importResult.inserted} new, skipped ${importResult.skipped}`);
  }
}

function extractTodoSectionMarkdown(content, sectionName) {
  const escaped = escapeRegExp(sectionName || '');
  const match = String(content || '').match(new RegExp(`(?:^|\\n)(##\\s+${escaped}[^\\n]*\\n[\\s\\S]*?)(?=\\n##(?!#)\\s+|$)`, 'i'));
  return match ? match[1].trimEnd() : null;
}

function normalizeRenderedTaskRef(value) {
  return String(value || '').replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
}

function renderedTaskRefSet(taskDb, rows, refRows) {
  const byId = new Map();
  for (const row of [...(Array.isArray(rows) ? rows : []), ...(Array.isArray(refRows) ? refRows : [])]) {
    if (row && row.id && !byId.has(row.id)) byId.set(row.id, row);
  }
  const displayRows = taskDb.withTaskDisplayRefs([...byId.values()]);
  const refs = new Set();
  for (const row of displayRows) {
    for (const value of [row.id, row.display_id, row.legacy_ref]) {
      const ref = normalizeRenderedTaskRef(value);
      if (ref) refs.add(ref);
    }
  }
  return refs;
}

// Rows in TODO.md that the database does not know. In a hand-written TODO they are rendered
// from the markdown, as before. In a rendered TODO (it has the "Regenerated" marker) a bullet
// the renderer wrote whose job is gone stays gone, but a bullet a person or a command added by
// hand (no bracketed ref, like `atris business` writing `- **Onboard:** ...`) is imported into
// the database when `db` is given, so the next render keeps it instead of dropping it. Imported
// rows are pushed onto `rows` and `refRows`, so the caller renders them with the rest.
function markdownRowsForRender(taskDb, existingTodoPath, rows, refRows, { db = null, workspaceRoot: wsOption = null } = {}) {
  if (!existingTodoPath || !fs.existsSync(existingTodoPath)) return [];
  const { parseTodoFile } = require('../../../lib/todo-fallback');
  const existingTodo = fs.readFileSync(existingTodoPath, 'utf8');
  const generatedTodo = existingTodo.includes('Regenerated from durable Atris task state');
  const parsed = parseTodoFile(existingTodoPath);
  const ws = wsOption || taskDb.workspaceRoot();
  const renderedBulletRefs = new Set();
  if (generatedTodo) {
    for (const line of existingTodo.split('\n')) {
      const match = line.match(RENDERED_TODO_BULLET_REF);
      if (match) renderedBulletRefs.add(normalizeRenderedTaskRef(match[1]));
    }
  }
  const existingRefs = renderedTaskRefSet(taskDb, rows, refRows);
  const existingSourceKeys = new Set(
    (Array.isArray(refRows) ? refRows : [])
      .map(row => row && row.source_key)
      .filter(Boolean)
  );
  const existingTitles = new Set(
    [...(Array.isArray(rows) ? rows : []), ...(Array.isArray(refRows) ? refRows : [])]
      .map(row => taskDb.normalizeTitle(row && row.title))
      .filter(Boolean)
  );
  const sections = [
    ['backlog', 'open'],
    ['inProgress', 'claimed'],
    ['review', 'review'],
    ['completed', 'done'],
  ];
  const out = [];
  let index = 0;
  for (const [bucket, status] of sections) {
    for (const task of parsed[bucket] || []) {
      if (!task.title) continue;
      const sk = taskDb.sourceKey(existingTodoPath, task.title);
      const normalizedTitle = taskDb.normalizeTitle(task.title);
      const renderedRef = normalizeRenderedTaskRef(task.id);
      if (
        (renderedRef && existingRefs.has(renderedRef)) ||
        (sk && existingSourceKeys.has(sk)) ||
        existingTitles.has(normalizedTitle)
      ) continue;
      if (generatedTodo) {
        // Written by the renderer and no longer in the database: leave it out.
        // Only open and in-progress bullets are imported: a hand-written line under Review or
        // Completed has no history to stand on.
        if (!db || (renderedRef && renderedBulletRefs.has(renderedRef)) || (status !== 'open' && status !== 'claimed')) continue;
        const claimer = status === 'claimed' ? (task.claimed || null) : null;
        const added = taskDb.addTask(db, {
          title: task.title,
          tag: task.tag || null,
          workspaceRoot: ws,
          sourceKey: sk,
          status: status === 'claimed' && !claimer ? 'open' : status,
          claimedBy: claimer,
          metadata: {
            source: 'todo_markdown_import',
            todo_id: task.id || null,
            todo_tags: task.tags || [],
            ...(task.verify ? { verify: task.verify } : {}),
          },
        });
        const imported = added && added.id ? taskDb.getTask(db, added.id) : null;
        if (imported) {
          if (Array.isArray(rows)) rows.push(imported);
          if (Array.isArray(refRows) && refRows !== rows) refRows.push(imported);
          existingRefs.add(normalizeRenderedTaskRef(imported.id));
        }
        if (sk) existingSourceKeys.add(sk);
        existingTitles.add(normalizedTitle);
        continue;
      }
      out.push({
        id: `markdown:${status}:${task.id || index}:${sk ? sk.slice(0, 10) : index}`,
        title: task.title,
        status,
        tag: task.tag || null,
        workspace_root: ws,
        claimed_by: status === 'claimed' ? (task.claimed || null) : null,
        created_at: index,
        updated_at: index,
        done_at: null,
        metadata: {
          todo_id: task.id || null,
          todo_tags: task.tags || [],
          claimed: task.claimed || null,
          stage: task.stage || null,
          verify: task.verify || null,
          markdown_source: existingTodoPath,
        },
      });
      if (sk) existingSourceKeys.add(sk);
      existingTitles.add(normalizedTitle);
      index += 1;
    }
  }
  return out;
}

function taskRenderStatusCounts(rows) {
  const counts = {
    backlog: 0,
    in_progress: 0,
    review: 0,
    blocked: 0,
    done: 0,
    total: 0,
  };
  for (const row of Array.isArray(rows) ? rows : []) {
    counts.total += 1;
    if (row.status === 'open') counts.backlog += 1;
    else if (row.status === 'claimed') counts.in_progress += 1;
    else if (row.status === 'review') counts.review += 1;
    else if (row.status === 'failed') counts.blocked += 1;
    else if (row.status === 'done') counts.done += 1;
  }
  return counts;
}

function taskRenderCountLabel(count) {
  return count === 0 ? 'empty' : String(count);
}

function taskRenderSummaryLine(counts) {
  return [
    `Backlog: ${taskRenderCountLabel(counts.backlog)}`,
    `In Progress: ${taskRenderCountLabel(counts.in_progress)}`,
    `Review: ${taskRenderCountLabel(counts.review)}`,
    `Blocked: ${taskRenderCountLabel(counts.blocked)}`,
    `Done saved: ${taskRenderCountLabel(counts.done)}`,
  ].join('; ');
}

function refreshExistingTodoMarkdown(taskDb, db, workspaceRoot) {
  const ws = workspaceRoot || taskDb.workspaceRoot();
  const outPath = path.join(ws, 'atris', 'TODO.md');
  if (!fs.existsSync(outPath)) return null;
  const rows = taskDb.listTasks(db, { workspaceRoot: ws, limit: 500 });
  const refRows = taskDb.listTasks(db, { workspaceRoot: ws });
  const existingTodo = fs.readFileSync(outPath, 'utf8');
  const preservedSections = [];
  const endgameSection = extractTodoSectionMarkdown(existingTodo, 'Endgame');
  if (endgameSection) preservedSections.push(endgameSection);
  const markdownRows = markdownRowsForRender(taskDb, outPath, rows, refRows, { db, workspaceRoot: ws });
  const markdown = taskDb.renderTodoMarkdown([...rows, ...markdownRows], {
    refRows,
    preservedSections,
  });
  writeFileAtomic(outPath, markdown);
  return outPath;
}

// TODO.md is a projection of task-db state. Keep this best-effort and silent
// because it runs after every successful mutating task command.
function autoRenderTodoFromDb(cwd = process.cwd()) {
  try {
    const atrisDir = path.join(cwd, 'atris');
    if (!fs.existsSync(atrisDir)) return null;
    const taskDb = getTaskDb();
    const db = taskDb.open();
    const outPath = path.join(atrisDir, 'TODO.md');
    if (fs.existsSync(outPath)) return refreshExistingTodoMarkdown(taskDb, db, cwd);
    const rows = taskDb.listTasks(db, { workspaceRoot: cwd, limit: 500 });
    const refRows = taskDb.listTasks(db, { workspaceRoot: cwd });
    writeFileAtomic(outPath, taskDb.renderTodoMarkdown(rows, { refRows }));
    return outPath;
  } catch {
    return null;
  }
}

// The task behind a TODO bullet, finished the way `atris task done` finishes one: doneTask, then the
// projection and the rendered TODO. A rendered TODO.md is a view of the database, so marking its bullet
// means nothing until the job itself is done. `matches(title)` says whether a job's title is the one the
// caller named; only an open or claimed job in this workspace counts, an exact title wins over a partial
// one, and two partial matches are a refusal, not a guess. Returns { completed, id, reason }.
function completeTodoTaskByTitle(cwd, title, { matches, actor, proof } = {}) {
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const ws = taskDb.workspaceRoot(cwd);
  const wanted = taskDb.normalizeTitle(title);
  const candidates = taskDb.listTasks(db, { workspaceRoot: ws, limit: null })
    .filter((row) => row.status === 'open' || row.status === 'claimed');
  const exact = candidates.filter((row) => wanted && taskDb.normalizeTitle(row.title) === wanted);
  const partial = typeof matches === 'function' ? candidates.filter((row) => matches(row.title)) : [];
  const picked = exact.length === 1 ? exact : (exact.length ? [] : partial);
  if (picked.length !== 1) return { completed: false, id: null, reason: picked.length ? 'ambiguous' : 'no_match' };
  const id = picked[0].id;
  const done = taskDb.doneTask(db, {
    id,
    status: 'done',
    actor: actor || process.env.ATRIS_AGENT_ID || DEFAULT_OWNER,
    action: 'done',
    proof,
  });
  if (!done.updated) return { completed: false, id, reason: 'not_open_or_claimed' };
  try { writeDefaultProjection(taskDb, db, { root: cwd }); } catch { /* the view is rebuilt on the next write */ }
  autoRenderTodoFromDb(cwd);
  return { completed: true, id, reason: null };
}

function cmdRender(args) {
  const hasOutFlag = hasFlag(args, '--out') || args.some(a => String(a).startsWith('--out='));
  const rawOut = flag(args, '--out');
  if (hasOutFlag && (typeof rawOut !== 'string' || !rawOut.trim() || rawOut.trim().startsWith('-'))) {
    failTask('atris task render', 'invalid_out', '--out requires a file path');
  }
  const out = rawOut || path.join('atris', 'TODO.md');
  const all = hasFlag(args, '--all');
  const everywhere = taskScopeEverywhere(args);
  const doneLimitRaw = flag(args, '--done-limit');
  const doneLimit = doneLimitRaw && doneLimitRaw !== true ? Number(doneLimitRaw) : undefined;
  const failedLimitRaw = flag(args, '--failed-limit');
  const failedLimit = failedLimitRaw && failedLimitRaw !== true ? Number(failedLimitRaw) : undefined;
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const workspaceRoot = scopedWorkspaceRoot(taskDb, args, { everywhere });
  const rows = taskDb.listTasks(db, {
    workspaceRoot,
    limit: all ? null : 500,
  });
  const refRows = taskDb.listTasks(db, {
    workspaceRoot,
  });
  const outPath = path.resolve(String(out));
  const existingTodo = fs.existsSync(outPath) ? fs.readFileSync(outPath, 'utf8') : '';
  const preservedSections = [];
  const endgameSection = extractTodoSectionMarkdown(existingTodo, 'Endgame');
  if (endgameSection) preservedSections.push(endgameSection);
  const markdownRows = markdownRowsForRender(taskDb, outPath, rows, refRows, workspaceRoot ? { db, workspaceRoot } : {});
  const rowsToRender = [...rows, ...markdownRows];
  const statusCounts = taskRenderStatusCounts(rowsToRender);
  const markdown = taskDb.renderTodoMarkdown(rowsToRender, { doneLimit, failedLimit, refRows, preservedSections });
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileAtomic(outPath, markdown);
  if (wantsJson(args)) {
    printJson({
      ok: true,
      action: 'rendered',
      count: rowsToRender.length,
      status_counts: statusCounts,
      backlog_empty: statusCounts.backlog === 0,
      path: outPath,
    });
    return;
  }
  console.log(`rendered TODO.md -> ${outPath}`);
  console.log(taskRenderSummaryLine(statusCounts));
}

function cmdSync(args) {
  const dryRun = hasFlag(args, '--dry-run');
  const businessIdFlag = flag(args, '--business-id');
  if (!dryRun) {
    console.error('atris task sync: only --dry-run is supported right now');
    process.exit(2);
  }

  const taskDb = getTaskDb();
  const db = taskDb.open();
  const binding = readLocalBusinessBinding(taskDb.workspaceRoot());
  const businessId = String(
    businessIdFlag && businessIdFlag !== true
      ? businessIdFlag
      : binding && (binding.business_id || binding.id) || ''
  ).trim();
  if (!businessId) {
    const detail = 'business id required: run inside a business workspace or pass --business-id <id>';
    if (wantsJson(args)) {
      printJson({ ok: false, action: 'sync_plan', reason: 'missing_business_id', detail });
      return;
    }
    console.error(`atris task sync: ${detail}`);
    process.exit(2);
  }

  const { projection, outPath } = writeDefaultProjection(taskDb, db);
  const plan = syncPlanForProjection(projection, businessId);
  if (wantsJson(args)) {
    printJson({
      ok: true,
      action: 'sync_plan',
      dry_run: true,
      business_id: businessId,
      workspace_root: projection.workspace_root,
      projection_path: outPath,
      planned_writes: plan.length,
      plan,
    });
    return;
  }

  console.log(`task sync dry-run: ${plan.length} planned write${plan.length === 1 ? '' : 's'}`);
  console.log(`business: ${businessId}`);
  const refById = taskDb.taskDisplayRefMap(projection.tasks || []);
  for (const item of plan) {
    console.log(`${item.method.padEnd(5)} ${item.endpoint} <= ${refById.get(item.local_task_id) || taskRef(item.local_task_id)} ${item.body.title}`);
    for (const followup of item.after_create || []) {
      console.log(`      then ${followup.method} ${followup.endpoint} state=${followup.body.state}`);
    }
  }
}

module.exports = {
  bindMain, importTodoFile, importJournalFile, todayJournalPath, cmdImport, cmdWhere, cmdEvents,
  cmdLineage, cmdExport, cmdSetup, extractTodoSectionMarkdown, normalizeRenderedTaskRef,
  renderedTaskRefSet, markdownRowsForRender, taskRenderStatusCounts, taskRenderCountLabel,
  taskRenderSummaryLine, refreshExistingTodoMarkdown, autoRenderTodoFromDb, completeTodoTaskByTitle,
  cmdRender, cmdSync,
};
