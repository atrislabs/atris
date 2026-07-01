const fs = require('fs');
const path = require('path');
const {
  isGenericInboxPlaceholder,
  seedInboxFromMove,
} = require('../lib/next-moves');

function hasFlag(args, name) {
  return args.includes(name);
}

function safeRead(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

function walkFiles(dir, predicate, limit = 200) {
  const out = [];
  const visit = (current) => {
    if (out.length >= limit) return;
    let entries = [];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (out.length >= limit) break;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (!predicate || predicate(full)) out.push(full);
    }
  };
  visit(dir);
  return out.sort();
}

function clip(value, max = 140) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 3).trim()}...`;
}

function addAction(actions, title, source, reason, evidence = null) {
  const clean = clip(title, 180);
  if (!clean || isGenericInboxPlaceholder(clean)) return;
  const key = clean.toLowerCase();
  if (actions.some((action) => action.key === key)) return;
  actions.push({
    key,
    title: clean,
    source,
    reason: clip(reason, 220),
    evidence,
  });
}

function receiptActions(root, actions) {
  const runsDir = path.join(root, 'atris', 'runs');
  for (const file of walkFiles(runsDir, (full) => /\.json$/i.test(full), 300).slice(-80)) {
    let receipt = null;
    try { receipt = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { receipt = null; }
    if (!receipt || receipt.schema !== 'atris.mission_receipt.v1') continue;
    const rel = path.relative(root, file);
    const landing = receipt.result?.landing || {};
    const text = [
      receipt.objective,
      landing.changed,
      landing.reason,
      landing.checked,
      landing.tested,
      landing.next,
      receipt.result?.reason,
    ].filter(Boolean).join(' ');
    if (/no concrete follow-up|stop|placeholder|zero value score|near[- ]?miss/i.test(text)) {
      addAction(actions, 'Improve the next-mission chooser so it explains stopped work and better candidates', 'receipt', text, rel);
    }
    if (receipt.result?.verifier_result?.passed === false || /\b(verifier|test|check).{0,40}\b(fail|failed|error)\b/i.test(text)) {
      addAction(actions, `Fix failing verifier for ${receipt.objective || 'latest mission'}`, 'receipt', text, rel);
    }
    if (landing.reason && landing.proof && /receipt saved/i.test(landing.proof)) {
      addAction(actions, 'Surface buried result landing reasoning in the normal mission view', 'receipt', landing.reason, rel);
    }
    if (landing.proof == null || /proof:\s*null/i.test(text)) {
      addAction(actions, 'Repair proof mismatch where proof exists in metadata but renders as null', 'receipt', text, rel);
    }
  }
}

function runLogActions(root, actions) {
  const logsDir = path.join(root, 'atris', 'logs', 'runs');
  for (const file of walkFiles(logsDir, (full) => /\.(log|txt|md|json)$/i.test(full), 200).slice(-60)) {
    const rel = path.relative(root, file);
    const text = safeRead(file);
    if (!text) continue;
    if (/no concrete follow-up|placeholder|test idea|zero value score/i.test(text)) {
      addAction(actions, 'Harvest weak chooser traces into a concrete next-mission fix', 'runlog', text, rel);
    }
    if (/\b(error|failed|exception|traceback|unhandled)\b/i.test(text)) {
      addAction(actions, 'Turn recent run-log failures into a bounded fix task with proof', 'runlog', text, rel);
    }
  }
}

function thinkingActions(root, actions) {
  const rel = 'atris/thinking.md';
  const text = safeRead(path.join(root, rel));
  if (!text) return;
  if (/plain English|jargon|feynman|understand/i.test(text)) {
    addAction(actions, 'Make proof and task previews plain enough to understand without opening logs', 'thinking', text, rel);
  }
  if (/proof over motion|receipt|verified|checked/i.test(text)) {
    addAction(actions, 'Audit proof surfaces for null proof, hidden receipts, and vague verifier claims', 'thinking', text, rel);
  }
  if (/stop.*no concrete|no concrete.*stop|fake|busywork/i.test(text)) {
    addAction(actions, 'Make autonomous loops stop or ask instead of inventing fake work', 'thinking', text, rel);
  }
}

function harvestActions(root = process.cwd()) {
  const actions = [];
  receiptActions(root, actions);
  runLogActions(root, actions);
  thinkingActions(root, actions);
  return actions.slice(0, 12).map(({ key, ...action }, index) => ({
    id: `I${index + 1}`,
    ...action,
  }));
}

function harvestCommand(args = []) {
  const root = process.cwd();
  if (hasFlag(args, '--help') || hasFlag(args, '-h') || args[0] === 'help') {
    console.log('Usage: atris harvest [--write] [--json]');
    console.log('');
    console.log('Find plain next actions from mission receipts, run logs, and thinking.md.');
    console.log('Read-only by default. Use --write to append actions to today\'s Inbox.');
    return { ok: true, action: 'help' };
  }
  const asJson = hasFlag(args, '--json');
  const write = hasFlag(args, '--write');
  const actions = harvestActions(root);
  const writes = [];
  if (write) {
    for (const action of actions) {
      const written = seedInboxFromMove(root, { title: action.title, source: action.source });
      writes.push({
        title: action.title,
        file: written.file ? path.relative(root, written.file) : null,
        line: written.line,
        already_present: Boolean(written.alreadyPresent),
      });
    }
  }
  const payload = {
    ok: true,
    action: 'harvest',
    write,
    count: actions.length,
    actions,
    writes,
  };
  if (asJson) {
    console.log(JSON.stringify(payload, null, 2));
    return payload;
  }
  if (!actions.length) {
    console.log('No harvest actions found.');
    return payload;
  }
  for (const action of actions) {
    console.log(`- **${action.id}:** ${action.title}`);
    console.log(`  reason: ${action.reason}`);
    if (action.evidence) console.log(`  evidence: ${action.evidence}`);
  }
  if (write) console.log(`Wrote ${writes.filter((item) => item.line).length} inbox action(s).`);
  else console.log('Read-only. Add --write to append these to today\'s Inbox.');
  return payload;
}

module.exports = {
  harvestActions,
  harvestCommand,
};
