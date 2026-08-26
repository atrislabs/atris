const fs = require('fs');
const path = require('path');
const { isCertifiedReview, personName } = require('../lib/first-minute');
const { isRealTestRunnerProof, quoteVerifierCommand } = require('../lib/verifier-quality');

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
      if (Array.isArray(rows) && rows.length) {
        const refs = taskDb.taskDisplayRefMap(rows);
        return rows.map(row => ({ ...row, display_id: refs.get(row.id) || row.id.slice(-6) }));
      }
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

function plainCheck(proof, width = 70) {
  if (!proof) return null;
  const flat = proof.replace(/\s+/g, ' ').trim();
  const checks = [];
  const add = label => { if (!checks.includes(label)) checks.push(label); };

  const quoted = quoteVerifierCommand(flat);
  if (quoted) add(`ran \`${quoted}\``);

  if (/\b(PR|pull request)\b.*\b(merged|MERGED)\b|\bmerged\b.*\b(PR|pull request)\b/i.test(flat)) add('merged');
  // Only say "tests passed" when a real test runner appears in the proof.
  // A bare `test -f` / file-exists check must not claim tests ran.
  if (isRealTestRunnerProof(flat)) add('tests passed');
  if (/\b(node --check|git diff --check|git diff --exit-code|git diff --quiet)\b/i.test(flat)) add('code check passed');
  if (/\b(?:\brg\b|\bgrep\b)\b/i.test(flat) && !/\btest\s+-[efsd]\b/i.test(flat)) add('content check passed');
  if (/\b(bench|benchmark|measured|latency|speed)\b/i.test(flat)) add('measured improvement');
  if (/\brepeated agent review\b|\bagent review\b/i.test(flat)) add('reviewed repeatedly');
  if (/\batris\/runs\/[^\s]+\.json\b|receipt\b/i.test(flat)) add('record saved');
  if (/\b(human approved|accepted by|accepted_at|reward)\b/i.test(flat)) add('human accepted');
  if (/\btest\s+-[efsd]\b|\b\[\s+-[efsd]\b/i.test(flat) && !isRealTestRunnerProof(flat)) {
    add(quoted ? 'file check' : 'file check only');
  }

  if (checks.length) return checks.join(', ');
  return shortProof(proof, width);
}

function shortTitle(title, width = 64) {
  const flat = String(title || '')
    .replace(/\bproof\b/gi, 'checks')
    .replace(/\breceipts?\b/gi, 'records')
    .replace(/\bsign[- ]off\b/gi, 'approval')
    .replace(/\bpolicy\b/gi, 'rules')
    .replace(/\bAgentXP\b/g, 'reward')
    .replace(/\bcertified\b/gi, 'checked')
    .replace(/\s+/g, ' ')
    .trim();
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

  const newestFirst = (a, b) => (
    Number(b.updated_at || b.created_at || 0) - Number(a.updated_at || a.created_at || 0)
  );
  const shipped = tasks
    .filter(t => t.status === 'done' && Number(t.done_at || 0) >= cutoff)
    .sort((a, b) => Number(b.done_at || 0) - Number(a.done_at || 0))
    .map(pick);
  const reviewTasks = tasks.filter(t => t.status === 'review');
  const waiting = reviewTasks
    .filter(isCertifiedReview)
    .sort(newestFirst)
    .map(pick);
  const checking = reviewTasks
    .filter(t => !isCertifiedReview(t))
    .sort(newestFirst)
    .map(pick);
  const inProgress = tasks
    .filter(t => t.status === 'open' || t.status === 'claimed')
    .map(pick);

  const withProof = [...shipped, ...waiting, ...checking].filter(t => t.proof).length;
  return {
    empty: false,
    days: windowDays,
    workspace: path.basename(root),
    shipped,
    waiting,
    checking,
    inProgress,
    next: waiting.length ? `atris task accept ${waiting[0].id}` : null,
    proof_attached: withProof,
    proof_total: shipped.length + waiting.length + checking.length,
  };
}

function renderRecap(data) {
  if (data.empty) {
    return [
      `RECAP — ${data.workspace}`,
      '',
      'No task history yet.',
      'Run "atris init", then let Atris do one small job. Finished work will show up here with the checks that passed.',
    ].join('\n');
  }
  const lines = [];
  lines.push(`RECAP — ${data.workspace} — last ${data.days} day${data.days === 1 ? '' : 's'}`);
  lines.push('');
  lines.push('Plain English: what changed, how it was checked, and what still needs you.');
  const headline = [];
  if (data.shipped.length) headline.push(`${data.shipped.length} done`);
  if (data.waiting.length) headline.push(`${data.waiting.length} needs you`);
  if (data.checking.length) headline.push(`${data.checking.length} still being checked`);
  if (data.inProgress.length) headline.push(`${data.inProgress.length} still working`);
  lines.push(headline.length ? headline.join(' · ') : 'Quiet window. nothing moved in this period.');

  if (data.shipped.length) {
    lines.push('');
    lines.push(`DONE — ${data.shipped.length}`);
    for (const t of data.shipped.slice(0, 12)) {
      lines.push(`  ${t.id}  ${shortTitle(t.title)}`);
      const check = plainCheck(t.proof);
      if (check) lines.push(`          checked: ${check}`);
    }
    if (data.shipped.length > 12) lines.push(`  … and ${data.shipped.length - 12} more`);
  }

  if (data.waiting.length) {
    lines.push('');
    lines.push(`NEEDS YOU — ${data.waiting.length}`);
    for (const t of data.waiting.slice(0, 10)) {
      lines.push(`  ${t.id}  ${shortTitle(t.title)}`);
      const check = plainCheck(t.proof);
      if (check) lines.push(`          checked: ${check}`);
    }
    if (data.waiting.length > 10) lines.push(`  … and ${data.waiting.length - 10} more`);
    if (data.next) lines.push(`  next: ${data.next}`);
  }

  if (data.checking.length) {
    lines.push('');
    lines.push(`STILL BEING CHECKED — ${data.checking.length}`);
    for (const t of data.checking.slice(0, 10)) {
      lines.push(`  ${t.id}  ${shortTitle(t.title)}`);
    }
    if (data.checking.length > 10) lines.push(`  … and ${data.checking.length - 10} more`);
  }

  if (data.inProgress.length) {
    lines.push('');
    lines.push(`STILL WORKING — ${data.inProgress.length}`);
    for (const t of data.inProgress) {
      lines.push(`  ${t.id}  ${shortTitle(t.title)}${t.owner ? `  @${t.owner}` : ''}`);
    }
  }

  lines.push('');
  lines.push(`Checked: ${data.proof_attached}/${data.proof_total} finished items.`);
  lines.push('Share this: atris recap --share');
  return lines.join('\n');
}

function renderShare(data) {
  if (data.empty) return `Nothing to share yet on ${data.workspace} — no finished tasks on record.`;
  const lines = [];
  lines.push(`What got done on ${data.workspace} in the last ${data.days} day${data.days === 1 ? '' : 's'}:`);
  lines.push('');
  if (data.shipped.length) lines.push(`- ${data.shipped.length} done and accepted`);
  if (data.waiting.length) lines.push(`- ${data.waiting.length} ready for you to approve or send back`);
  if (data.checking.length) lines.push(`- ${data.checking.length} still being checked`);
  if (data.inProgress.length) lines.push(`- ${data.inProgress.length} still being worked on`);
  const highlights = [...data.shipped, ...data.waiting].filter(t => t.proof).slice(0, 5);
  if (highlights.length) {
    lines.push('');
    lines.push('Highlights:');
    for (const t of highlights) {
      lines.push(`- ${shortTitle(t.title, 80)} (${plainCheck(t.proof, 60)})`);
    }
  }
  lines.push('');
  lines.push('The finished items are backed by actual checks that ran, not a status update someone typed.');
  return lines.join('\n');
}

function recapSoftTitle(title, maxWords = 5) {
  const words = String(title || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  if (!words.length) return '';
  const text = words.slice(0, maxWords).join(' ').replace(/[.,;:!?]+$/g, '');
  return `"${text.toLowerCase()}"`;
}

function renderRecapMinute(data, { person } = {}) {
  const who = person != null ? person : personName();
  const greet = who ? `hey ${who}, ` : '';
  if (data.empty) {
    return [
      `${greet}no task history yet.`,
      '',
      'next: atris init --minimal',
    ].join('\n');
  }

  const waiting = Array.isArray(data.waiting) ? data.waiting : [];
  const checking = Array.isArray(data.checking) ? data.checking : [];
  const shipped = Array.isArray(data.shipped) ? data.shipped : [];
  const inProgress = Array.isArray(data.inProgress) ? data.inProgress : [];
  const certified = waiting[0] || null;
  const title = certified ? recapSoftTitle(certified.title) : '';

  if (certified) {
    const win = title
      ? `${greet}${title} is waiting for your ok.`
      : `${greet}one finished thing is waiting for your ok.`;
    const lines = [win];
    if (checking.length === 1) lines.push('1 still being checked.');
    if (checking.length > 1) lines.push(`${checking.length} still being checked.`);
    if (data.next) {
      lines.push('');
      lines.push(`next: ${data.next}`);
    }
    return lines.join('\n');
  }

  if (checking.length === 1) {
    const named = recapSoftTitle(checking[0] && checking[0].title);
    if (named) return `${greet}${named} is still being checked.`;
    return `${greet}1 finished thing is still being checked.`;
  }
  if (checking.length > 1) {
    return `${greet}${checking.length} finished things are still being checked.`;
  }

  if (shipped.length) {
    const named = recapSoftTitle(shipped[0].title);
    return named
      ? `${greet}you already shipped ${named}.`
      : `${greet}you already shipped the last finished thing.`;
  }

  if (inProgress.length) {
    const item = inProgress[0];
    const named = recapSoftTitle(item && item.title);
    if (item && item.owner && named) return `${greet}${named} is already yours.`;
    if (named) return `${greet}${named} is ready to claim.`;
  }

  return `${greet}quiet window. nothing moved in this period.`;
}

function printRecapHelp() {
  console.log(`
atris recap - what got done, in spoken lines

  atris recap              a few spoken lines: waiting for your ok, still being checked
  atris recap --verbose    the old report
  atris recap --days 30    widen the window
  atris recap --share      paste-ready summary for Slack, email, or a customer
  atris recap --json       structured output for agents and dashboards

certified work names atris task accept. uncertified stays still being checked.
use --verbose or --share for the old report.
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
  if (args.includes('--share')) {
    console.log(renderShare(data));
    return;
  }
  if (args.includes('--verbose') || args.includes('--full')) {
    console.log(renderRecap(data));
    return;
  }
  console.log(renderRecapMinute(data));
}

module.exports = { recapAtris, buildRecapData, renderRecap, renderRecapMinute, renderShare };
