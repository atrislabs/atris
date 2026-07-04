'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const taskDb = require('../lib/task-db');
const {
  buildRunnerAvailabilityCommand,
  buildRunnerCommand,
  runnerAvailabilityFailureMessage,
} = require('../lib/runner-command');

const UNKNOWN_KINDS = new Set(['known_unknown', 'unknown_known', 'unknown_unknown']);
const STAKES = new Set(['reversible', 'costly', 'burnable_once']);
const MODEL_TIMEOUT_MS = 180000;
const READ_LIMIT = 12000;

const UNKNOWN_SCHEMA = `
CREATE TABLE IF NOT EXISTS unknowns (
  id              TEXT PRIMARY KEY,
  created_at      TEXT NOT NULL,
  workspace_root  TEXT NOT NULL,
  problem         TEXT NOT NULL,
  kind            TEXT NOT NULL,
  text            TEXT NOT NULL,
  stakes          TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'open',
  resolution      TEXT,
  resolved_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_unknowns_workspace_status ON unknowns(workspace_root, status, created_at);
CREATE INDEX IF NOT EXISTS idx_unknowns_status ON unknowns(status, created_at);
`;

function showHelp() {
  console.log('');
  console.log('Usage: atris unknowns "<problem statement>"');
  console.log('       atris unknowns list [--all]');
  console.log('       atris unknowns resolve <id> "<what we learned>"');
  console.log('');
  console.log('Runs a blindspot pass, writes unknowns to the global task DB, and renders .atris/state/unknowns.md.');
  console.log('');
}

function ensureUnknownsSchema(db) {
  db.exec(UNKNOWN_SCHEMA);
}

function clip(value, max = READ_LIMIT) {
  const text = String(value || '');
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 24)).trim()}\n[...truncated]`;
}

function clipLine(value, max = 160) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 3)).trim()}...`;
}

function readFileBestEffort(file, options = {}) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    if (options.lines) return text.split(/\r?\n/).slice(0, options.lines).join('\n');
    return clip(text, options.maxChars || READ_LIMIT);
  } catch {
    return '';
  }
}

function section(title, content) {
  const body = String(content || '').trim();
  return `## ${title}\n${body || '(missing)'}`;
}

function walkFiles(dir, predicate, out = []) {
  if (!fs.existsSync(dir)) return out;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(full, predicate, out);
    } else if (predicate(full, entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function readRecentJournals(root) {
  const logsDir = path.join(root, 'atris', 'logs');
  const files = walkFiles(logsDir, (_full, name) => /^\d{4}-\d{2}-\d{2}\.md$/.test(name))
    .map(file => {
      let mtime = 0;
      try { mtime = fs.statSync(file).mtimeMs; } catch {}
      return { file, mtime, name: path.basename(file) };
    })
    .sort((a, b) => b.name.localeCompare(a.name) || b.mtime - a.mtime)
    .slice(0, 3);

  if (!files.length) return '';
  return files.map(({ file }) => {
    const rel = path.relative(root, file);
    return `### ${rel}\n${readFileBestEffort(file, { maxChars: 6000 })}`;
  }).join('\n\n');
}

function runGitLog(root) {
  const result = spawnSync('git', ['log', '--oneline', '-15'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 15000,
  });
  if (result.status !== 0) return '';
  return String(result.stdout || '').trim();
}

function parsePayload(payload) {
  try { return JSON.parse(payload); } catch { return payload; }
}

function readTaskEvents(db, workspaceRoot) {
  try {
    const stmt = db.prepare(`
      SELECT event_id, task_id, version, workspace_root, actor, event_type, payload, created_at
        FROM task_events
       WHERE workspace_root = ?
       ORDER BY created_at DESC
       LIMIT 20
    `);
    return stmt.all(workspaceRoot);
  } catch {
    // If the schema exists but the workspace filter cannot run for any reason,
    // keep the context best-effort by falling back to the recent global ledger.
  }

  try {
    return db.prepare(`
      SELECT event_id, task_id, version, workspace_root, actor, event_type, payload, created_at
        FROM task_events
       ORDER BY created_at DESC
       LIMIT 20
    `).all();
  } catch {
    return '';
  }
}

function formatTaskEvents(rows) {
  if (!Array.isArray(rows) || !rows.length) return '';
  return rows.map(row => {
    const at = Number(row.created_at || 0) ? new Date(Number(row.created_at)).toISOString() : String(row.created_at || '');
    const payload = parsePayload(row.payload || '');
    const payloadText = typeof payload === 'string' ? payload : JSON.stringify(payload);
    return [
      `- ${at} ${row.event_type || 'event'} task=${row.task_id || '?'} actor=${row.actor || '?'}`,
      `  ${clipLine(payloadText, 220)}`,
    ].join('\n');
  }).join('\n');
}

function gatherTerritoryContext(root, db) {
  const map = readFileBestEffort(path.join(root, 'atris', 'MAP.md'), { lines: 100 });
  const lessonsMd = readFileBestEffort(path.join(root, 'atris', 'lessons.md'), { maxChars: READ_LIMIT });
  const lessonsJson = readFileBestEffort(path.join(root, 'atris', 'lessons.json'), { maxChars: READ_LIMIT });
  const journals = readRecentJournals(root);
  const gitLog = runGitLog(root);
  const taskEvents = formatTaskEvents(readTaskEvents(db, root));

  return [
    section('workspace_root', root),
    section('atris/MAP.md first 100 lines', map),
    section('atris/lessons.md', lessonsMd),
    section('atris/lessons.json', lessonsJson),
    section('last 3 daily journals', journals),
    section('git log --oneline -15', gitLog),
    section('last 20 task_events', taskEvents),
  ].join('\n\n');
}

function buildUnknownsPrompt(problem, territoryContext) {
  return `You are the Atris blindspot-pass engine.

Problem statement:
${problem}

Territory context:
${territoryContext}

Enumerate the blindspots that matter before the operator plans work:
- known_unknown: something the operator already knows they do not know.
- unknown_known: something likely present in the territory that the operator would recognize on sight if named.
- unknown_unknown: a likely blindspot inferred from weak signals, missing evidence, or failure modes.

Then choose the TOP 3 highest-leverage questions whose answers would most change the plan. For each question, include one concrete confirm test and one concrete kill test.

Output STRICT JSON ONLY. No prose, no markdown, no code fences. Use exactly this shape:
{
  "unknowns": [
    {
      "kind": "known_unknown|unknown_known|unknown_unknown",
      "text": "specific unknown",
      "stakes": "reversible|costly|burnable_once"
    }
  ],
  "top_questions": [
    {
      "question": "highest leverage question",
      "confirm_test": "concrete test that would confirm the risk/opportunity",
      "kill_test": "concrete test that would kill or deprioritize it"
    }
  ]
}

Rules:
- Return at least one unknown when the context is thin.
- top_questions must contain exactly 3 items.
- stakes must be one of: reversible, costly, burnable_once.
- kind must be one of: known_unknown, unknown_known, unknown_unknown.
- Do not invent source facts. Mark uncertainty in the text when evidence is thin.`;
}

function runRunnerPrompt(root, prompt) {
  let availabilityCommand;
  try {
    availabilityCommand = buildRunnerAvailabilityCommand();
  } catch (err) {
    return { ok: false, reason: runnerAvailabilityFailureMessage(err) };
  }

  const availability = spawnSync(availabilityCommand, [], {
    cwd: root,
    encoding: 'utf8',
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10000,
  });
  if (availability.error || availability.status !== 0) {
    return {
      ok: false,
      reason: runnerAvailabilityFailureMessage(availability.error || new Error(availability.stderr || 'runner unavailable')),
    };
  }

  const stateDir = path.join(root, '.atris', 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const promptFile = path.join(stateDir, 'unknowns-prompt.tmp');
  fs.writeFileSync(promptFile, prompt, 'utf8');

  try {
    const cmd = buildRunnerCommand({ promptFile });
    const env = { ...process.env };
    delete env.CLAUDECODE;
    const result = spawnSync(cmd, [], {
      cwd: root,
      encoding: 'utf8',
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: MODEL_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
      env,
    });
    if (result.error) return { ok: false, reason: result.error.message || 'runner failed' };
    if (result.status !== 0) {
      return { ok: false, reason: clipLine(result.stderr || result.stdout || `runner exited ${result.status}`, 300) };
    }
    return { ok: true, output: String(result.stdout || '').trim() };
  } finally {
    try { fs.unlinkSync(promptFile); } catch {}
  }
}

function stripJsonFence(text) {
  return String(text || '')
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();
}

function parseModelJson(output) {
  const stripped = stripJsonFence(output);
  try {
    return JSON.parse(stripped);
  } catch {}

  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  if (start !== -1 && end > start) {
    return JSON.parse(stripped.slice(start, end + 1));
  }
  throw new Error('runner returned no parseable JSON object');
}

function normalizeKind(value, fallback) {
  const normalized = String(value || '').toLowerCase().replace(/[\s-]+/g, '_');
  return UNKNOWN_KINDS.has(normalized) ? normalized : fallback;
}

function normalizeStakes(value) {
  const normalized = String(value || '').toLowerCase().replace(/[\s-]+/g, '_');
  return STAKES.has(normalized) ? normalized : 'costly';
}

function collectCategorizedUnknowns(payload) {
  const pairs = [
    ['known_unknown', payload.known_unknowns],
    ['known_unknown', payload.knownUnknowns],
    ['unknown_known', payload.unknown_knowns],
    ['unknown_known', payload.unknownKnowns],
    ['unknown_unknown', payload.unknown_unknowns],
    ['unknown_unknown', payload.unknownUnknowns],
  ];
  const rows = [];
  for (const [kind, value] of pairs) {
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      if (typeof item === 'string') rows.push({ kind, text: item, stakes: 'costly' });
      else if (item && typeof item === 'object') rows.push({ kind, ...item });
    }
  }
  return rows;
}

function normalizeUnknowns(payload) {
  const raw = Array.isArray(payload.unknowns) ? payload.unknowns : collectCategorizedUnknowns(payload);
  return raw.map((item) => {
    const value = typeof item === 'string' ? { text: item } : (item || {});
    const text = String(value.text || value.unknown || value.question || '').replace(/\s+/g, ' ').trim();
    if (!text) return null;
    return {
      kind: normalizeKind(value.kind, 'unknown_unknown'),
      text,
      stakes: normalizeStakes(value.stakes),
    };
  }).filter(Boolean);
}

function normalizeQuestions(payload, problem) {
  const raw = payload.top_questions || payload.topQuestions || payload.questions || [];
  const questions = Array.isArray(raw) ? raw.map(item => {
    const value = typeof item === 'string' ? { question: item } : (item || {});
    const question = String(value.question || value.text || '').replace(/\s+/g, ' ').trim();
    if (!question) return null;
    return {
      question,
      confirm_test: String(value.confirm_test || value.confirmTest || value.confirm || '').replace(/\s+/g, ' ').trim() || 'Find a concrete receipt that answers this before planning.',
      kill_test: String(value.kill_test || value.killTest || value.kill || '').replace(/\s+/g, ' ').trim() || 'Fail to find the receipt in the current workspace evidence.',
    };
  }).filter(Boolean) : [];

  const fallback = fallbackQuestions(problem);
  while (questions.length < 3) questions.push(fallback[questions.length]);
  return questions.slice(0, 3);
}

function fallbackQuestions(problem) {
  const subject = (clipLine(problem, 90) || 'this problem').replace(/[?!.]+$/, '');
  return [
    {
      question: `What existing code path already owns "${subject}"?`,
      confirm_test: 'Find one current command, helper, or task event that already implements the closest version of the behavior.',
      kill_test: 'No owner path appears in MAP.md, git history, or task events after a focused search.',
    },
    {
      question: 'What would make this change costly to reverse after one use?',
      confirm_test: 'Identify a persisted state write, schema change, external side effect, or user-facing contract that cannot be rolled back cleanly.',
      kill_test: 'All effects are local, idempotent, or behind an existing reversible command path.',
    },
    {
      question: 'What proof would change the plan before implementation starts?',
      confirm_test: 'A dry run, fixture, or smoke command exposes a failing assumption in the proposed path.',
      kill_test: 'The dry run exercises the main path and no assumption changes.',
    },
  ];
}

function fallbackPayload(problem, reason) {
  return {
    model_unavailable: true,
    unavailable_reason: reason,
    unknowns: [{
      kind: 'unknown_unknown',
      text: `Model unavailable for blindspot pass. Re-run after configuring the shared runner/API key. Reason: ${clipLine(reason || 'unknown', 220)}`,
      stakes: 'costly',
    }],
    top_questions: fallbackQuestions(problem),
  };
}

function analyzeWithModel(root, problem, territoryContext) {
  const prompt = buildUnknownsPrompt(problem, territoryContext);
  const model = runRunnerPrompt(root, prompt);
  if (!model.ok) return fallbackPayload(problem, model.reason);

  try {
    const parsed = parseModelJson(model.output);
    const unknowns = normalizeUnknowns(parsed);
    if (!unknowns.length) return fallbackPayload(problem, 'runner returned no unknown rows');
    return {
      unknowns,
      top_questions: normalizeQuestions(parsed, problem),
    };
  } catch (err) {
    return fallbackPayload(problem, err.message || 'runner JSON parse failed');
  }
}

function insertUnknowns(db, { workspaceRoot, problem, unknowns }) {
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT INTO unknowns (id, created_at, workspace_root, problem, kind, text, stakes, status, resolution, resolved_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'open', NULL, NULL)
  `);
  const rows = [];
  for (const unknown of unknowns) {
    const row = {
      id: taskDb.newId(),
      created_at: now,
      workspace_root: workspaceRoot,
      problem,
      kind: normalizeKind(unknown.kind, 'unknown_unknown'),
      text: String(unknown.text || '').replace(/\s+/g, ' ').trim(),
      stakes: normalizeStakes(unknown.stakes),
      status: 'open',
      resolution: null,
      resolved_at: null,
    };
    if (!row.text) continue;
    stmt.run(row.id, row.created_at, row.workspace_root, row.problem, row.kind, row.text, row.stakes);
    rows.push(row);
  }
  return rows;
}

function listUnknownRows(db, { workspaceRoot, all = false, status, limit = 500 } = {}) {
  const where = [];
  const args = [];
  if (!all && workspaceRoot) {
    where.push('workspace_root = ?');
    args.push(workspaceRoot);
  }
  if (status) {
    where.push('status = ?');
    args.push(status);
  }
  args.push(Number(limit) || 500);
  return db.prepare(`
    SELECT id, created_at, workspace_root, problem, kind, text, stakes, status, resolution, resolved_at
      FROM unknowns
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END, created_at DESC
     LIMIT ?
  `).all(...args);
}

function renderUnknownsMarkdown(db, workspaceRoot) {
  const rows = listUnknownRows(db, { workspaceRoot, status: null, limit: 1000 });
  const lines = [
    '# Unknowns Ledger',
    '',
    '> Rendered from SQLite. Do not edit this file as source of truth.',
    '',
    `Generated: ${new Date().toISOString()}`,
    `Workspace: ${workspaceRoot}`,
    '',
  ];

  for (const status of ['open', 'resolved']) {
    const group = rows.filter(row => row.status === status);
    lines.push(`## ${status === 'open' ? 'Open' : 'Resolved'}`, '');
    if (!group.length) {
      lines.push('(none)', '');
      continue;
    }
    for (const row of group) {
      lines.push(`- **${row.id}** [${row.kind}/${row.stakes}] ${row.text}`);
      lines.push(`  Problem: ${clipLine(row.problem, 180)}`);
      if (row.resolution) lines.push(`  Resolution: ${clipLine(row.resolution, 220)}`);
      lines.push('');
    }
  }

  const out = path.join(workspaceRoot, '.atris', 'state', 'unknowns.md');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, lines.join('\n').replace(/\n{3,}/g, '\n\n'), 'utf8');
  return out;
}

function printSummary(questions, count) {
  console.log('Top questions:');
  questions.slice(0, 3).forEach((item, index) => {
    console.log(`${index + 1}. ${item.question}`);
    console.log(`   Confirm: ${item.confirm_test}`);
    console.log(`   Kill: ${item.kill_test}`);
  });
  console.log('');
  console.log(`${count} unknown${count === 1 ? '' : 's'} written to ledger`);
}

function printList(rows, { all = false } = {}) {
  if (!rows.length) {
    console.log('No open unknowns.');
    return;
  }
  for (const row of rows) {
    const ws = all ? ` ${row.workspace_root}` : '';
    console.log(`${row.id} ${row.kind} ${row.stakes}${ws}`);
    console.log(`  ${row.text}`);
  }
}

function findUnknownByRef(db, id, workspaceRoot) {
  const ref = String(id || '').trim();
  if (!ref) return [];
  const scoped = db.prepare(`
    SELECT id, created_at, workspace_root, problem, kind, text, stakes, status, resolution, resolved_at
      FROM unknowns
     WHERE workspace_root = ?
       AND (id = ? OR id LIKE ?)
     ORDER BY created_at DESC
  `).all(workspaceRoot, ref, `${ref}%`);
  if (scoped.length) return scoped;
  return db.prepare(`
    SELECT id, created_at, workspace_root, problem, kind, text, stakes, status, resolution, resolved_at
      FROM unknowns
     WHERE id = ? OR id LIKE ?
     ORDER BY created_at DESC
  `).all(ref, `${ref}%`);
}

function resolveUnknown(db, { id, resolution, workspaceRoot }) {
  const rows = findUnknownByRef(db, id, workspaceRoot);
  if (!rows.length) return { ok: false, reason: 'not_found' };
  if (rows.length > 1) return { ok: false, reason: 'ambiguous', rows };

  const row = rows[0];
  const now = new Date().toISOString();
  const text = String(resolution || '').trim();
  const appended = row.resolution
    ? `${row.resolution}\n\n${now} ${text}`
    : `${now} ${text}`;
  db.prepare(`
    UPDATE unknowns
       SET status = 'resolved',
           resolution = ?,
           resolved_at = ?
     WHERE id = ?
  `).run(appended, now, row.id);
  renderUnknownsMarkdown(db, row.workspace_root);
  return { ok: true, row: { ...row, status: 'resolved', resolution: appended, resolved_at: now } };
}

async function unknownsCommand(args = []) {
  if (args.includes('--help') || args.includes('-h') || args[0] === 'help') {
    showHelp();
    return 0;
  }

  const root = taskDb.workspaceRoot(process.cwd());
  const db = taskDb.open();
  ensureUnknownsSchema(db);

  const sub = args[0];
  if (sub === 'list') {
    const all = args.includes('--all');
    const rows = listUnknownRows(db, { workspaceRoot: root, all, status: 'open' });
    printList(rows, { all });
    return 0;
  }

  if (sub === 'resolve') {
    const id = args[1];
    const resolution = args.slice(2).join(' ').trim();
    if (!id || !resolution) {
      console.error('Usage: atris unknowns resolve <id> "<what we learned>"');
      return 1;
    }
    const result = resolveUnknown(db, { id, resolution, workspaceRoot: root });
    if (!result.ok) {
      if (result.reason === 'ambiguous') {
        console.error(`Ambiguous unknown id "${id}". Matches: ${result.rows.map(row => row.id).join(', ')}`);
      } else {
        console.error(`Unknown not found: ${id}`);
      }
      return 1;
    }
    console.log(`resolved ${result.row.id}`);
    return 0;
  }

  const problem = args.join(' ').trim();
  if (!problem) {
    showHelp();
    return 1;
  }

  const territoryContext = gatherTerritoryContext(root, db);
  const analysis = analyzeWithModel(root, problem, territoryContext);
  const unknowns = normalizeUnknowns(analysis);
  const questions = normalizeQuestions(analysis, problem);
  const rows = insertUnknowns(db, { workspaceRoot: root, problem, unknowns });
  renderUnknownsMarkdown(db, root);
  printSummary(questions, rows.length);
  return 0;
}

module.exports = {
  unknownsCommand,
  showHelp,
  ensureUnknownsSchema,
  gatherTerritoryContext,
  buildUnknownsPrompt,
  analyzeWithModel,
  normalizeUnknowns,
  normalizeQuestions,
  fallbackPayload,
  insertUnknowns,
  listUnknownRows,
  renderUnknownsMarkdown,
  resolveUnknown,
};
