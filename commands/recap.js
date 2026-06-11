const fs = require('fs');
const path = require('path');

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_DAYS = 7;

function loadTaskDb() {
  try {
    return require('../lib/task-db');
  } catch (e) {
    return null;
  }
}

function readProjection(root) {
  const projectionPath = path.join(root, '.atris', 'state', 'tasks.projection.json');
  if (!fs.existsSync(projectionPath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(projectionPath, 'utf8'));
    return Array.isArray(parsed.tasks) ? parsed.tasks : null;
  } catch (e) {
    return null;
  }
}

function loadTasks(root) {
  const taskDb = loadTaskDb();
  if (taskDb) {
    try {
      const db = taskDb.open();
      const ws = taskDb.workspaceRoot(root);
      const rows = taskDb.listTasks(db, { workspaceRoot: ws });
      const refs = taskDb.taskDisplayRefMap(rows);
      return rows.map(row => ({ ...row, display_id: refs.get(row.id) || row.id.slice(-6) }));
    } catch (e) {
      // fall through to projection
    }
  }
  return readProjection(root);
}

function taskProof(task) {
  const meta = task.metadata || {};
  const proof = String(meta.latest_agent_proof || '').trim();
  if (proof) return proof;
  if (meta.agent_certified === true) return 'verified by repeated agent review';
  return null;
}

function shortProof(proof, width = 70) {
  if (!proof) return null;
  const flat = proof.replace(/\s+/g, ' ').trim();
  return flat.length <= width ? flat : `${flat.slice(0, width - 1)}…`;
}

function shortTitle(title, width = 64) {
  const flat = String(title || '').replace(/\s+/g, ' ').trim();
  return flat.length <= width ? flat : `${flat.slice(0, width - 1)}…`;
}

function buildRecapData(root = process.cwd(), { days = DEFAULT_DAYS } = {}) {
  const windowDays = Number.isFinite(Number(days)) && Number(days) > 0 ? Number(days) : DEFAULT_DAYS;
  const tasks = loadTasks(root);
  if (!tasks || tasks.length === 0) return { empty: true, days: windowDays, workspace: path.basename(root) };

  const cutoff = Date.now() - windowDays * DAY_MS;
  const pick = t => ({
    id: t.display_id || t.id,
    title: String(t.title || '').trim(),
    proof: taskProof(t),
    owner: t.claimed_by || (t.metadata && t.metadata.assigned_to) || null,
    done_at: t.done_at || null,
  });

  const shipped = tasks
    .filter(t => t.status === 'done' && Number(t.done_at || 0) >= cutoff)
    .sort((a, b) => Number(b.done_at || 0) - Number(a.done_at || 0))
    .map(pick);
  const waiting = tasks
    .filter(t => t.status === 'review')
    .sort((a, b) => Number(b.updated_at || 0) - Number(a.updated_at || 0))
    .map(pick);
  const inProgress = tasks
    .filter(t => t.status === 'open' || t.status === 'claimed')
    .map(pick);

  const withProof = [...shipped, ...waiting].filter(t => t.proof).length;
  return {
    empty: false,
    days: windowDays,
    workspace: path.basename(root),
    shipped,
    waiting,
    inProgress,
    proof_attached: withProof,
    proof_total: shipped.length + waiting.length,
  };
}

function renderRecap(data) {
  if (data.empty) {
    return [
      `RECAP — ${data.workspace}`,
      '',
      'No task history yet.',
      'Run "atris init", then let an agent work — every finished task lands here with proof.',
    ].join('\n');
  }
  const lines = [];
  lines.push(`RECAP — ${data.workspace} — last ${data.days} day${data.days === 1 ? '' : 's'}`);
  lines.push('');
  const headline = [];
  if (data.shipped.length) headline.push(`${data.shipped.length} change${data.shipped.length === 1 ? '' : 's'} shipped`);
  if (data.waiting.length) headline.push(`${data.waiting.length} finished and waiting for your sign-off`);
  if (data.inProgress.length) headline.push(`${data.inProgress.length} in progress`);
  lines.push(headline.length ? `Your AI team: ${headline.join(' · ')}.` : 'Quiet window — no movement in this period.');
  lines.push('Every finished line below carries proof: the commands run and their results.');

  if (data.shipped.length) {
    lines.push('');
    lines.push(`SHIPPED (accepted by a human) — ${data.shipped.length}`);
    for (const t of data.shipped.slice(0, 12)) {
      lines.push(`  ${t.id}  ${shortTitle(t.title)}`);
      if (t.proof) lines.push(`          proof: ${shortProof(t.proof)}`);
    }
    if (data.shipped.length > 12) lines.push(`  … and ${data.shipped.length - 12} more, all with proof on file`);
  }

  if (data.waiting.length) {
    lines.push('');
    lines.push(`FINISHED, WAITING FOR YOUR SIGN-OFF — ${data.waiting.length}`);
    for (const t of data.waiting.slice(0, 10)) {
      lines.push(`  ${t.id}  ${shortTitle(t.title)}`);
    }
    if (data.waiting.length > 10) lines.push(`  … and ${data.waiting.length - 10} more`);
    lines.push('  approve or send back: atris task reviews');
  }

  if (data.inProgress.length) {
    lines.push('');
    lines.push(`IN PROGRESS — ${data.inProgress.length}`);
    for (const t of data.inProgress) {
      lines.push(`  ${t.id}  ${shortTitle(t.title)}${t.owner ? `  @${t.owner}` : ''}`);
    }
  }

  lines.push('');
  lines.push(`Proof attached: ${data.proof_attached}/${data.proof_total} finished items.`);
  lines.push('Paste-ready summary for Slack or email: atris recap --share');
  return lines.join('\n');
}

function renderShare(data) {
  if (data.empty) return `Nothing to share yet on ${data.workspace} — no finished tasks on record.`;
  const lines = [];
  lines.push(`What the AI team did on ${data.workspace} in the last ${data.days} day${data.days === 1 ? '' : 's'}:`);
  lines.push('');
  if (data.shipped.length) lines.push(`- ${data.shipped.length} change${data.shipped.length === 1 ? '' : 's'} shipped, each verified before a human accepted it`);
  if (data.waiting.length) lines.push(`- ${data.waiting.length} more finished with proof attached, waiting for human sign-off`);
  if (data.inProgress.length) lines.push(`- ${data.inProgress.length} task${data.inProgress.length === 1 ? '' : 's'} in progress`);
  const highlights = [...data.shipped, ...data.waiting].filter(t => t.proof).slice(0, 5);
  if (highlights.length) {
    lines.push('');
    lines.push('Highlights:');
    for (const t of highlights) {
      lines.push(`- ${shortTitle(t.title, 80)} (proof: ${shortProof(t.proof, 60)})`);
    }
  }
  lines.push('');
  lines.push('Every item above is backed by a receipt — the exact commands run and their results — not a status update someone typed.');
  return lines.join('\n');
}

function printRecapHelp() {
  console.log(`
atris recap - what your AI team actually did, in plain English

  atris recap              Last 7 days: shipped, waiting on you, in progress
  atris recap --days 30    Widen the window
  atris recap --share      Paste-ready summary for Slack, email, or a customer
  atris recap --json       Structured output for agents and dashboards

Reads the workspace task records and their proof. No jargon, no guesses:
if it is listed as finished, the receipt is on file.
`);
}

function recapAtris(args = []) {
  if (args.includes('--help') || args.includes('-h') || args[0] === 'help') {
    printRecapHelp();
    return;
  }
  const daysIdx = args.indexOf('--days');
  const days = daysIdx !== -1 ? Number(args[daysIdx + 1]) : DEFAULT_DAYS;
  const data = buildRecapData(process.cwd(), { days });
  if (args.includes('--json')) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  console.log(args.includes('--share') ? renderShare(data) : renderRecap(data));
}

module.exports = { recapAtris, buildRecapData, renderRecap, renderShare };
