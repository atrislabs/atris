'use strict';

// atris rsi - read the Dream-RSI attempt ledger in plain words.
//
// Prints trees and attempts by lane, the most recent day's attempts and
// outcomes, the live policy id, and the last dream receipt. Read-only: it
// never touches record.py, never writes state, and exits 0 even when the
// workspace has no ledger yet.

const fs = require('fs');
const rsi = require('../lib/rsi-record');

function readJsonl(file) {
  try {
    return fs.readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function dayOf(node) {
  return String((node && node.created_at) || '').slice(0, 10);
}

function collectStatus(root) {
  const nodes = rsi.latestNodes(root);
  const lanes = new Map();
  for (const n of nodes) {
    const lane = String(n.lane || 'unknown');
    if (!lanes.has(lane)) {
      lanes.set(lane, { trees: new Set(), nodes: 0, shipped: 0, failed: 0, nothing: 0, open: 0 });
    }
    const l = lanes.get(lane);
    l.trees.add(String(n.tree_id || ''));
    l.nodes += 1;
    const st = n.outcome && n.outcome.status;
    if (st === 'shipped') l.shipped += 1;
    else if (st === 'failed') l.failed += 1;
    else if (st === 'nothing') l.nothing += 1;
    else l.open += 1; // running / waiting / unlabeled
  }
  const days = [...new Set(nodes.map(dayOf).filter(Boolean))].sort();
  const lastDay = days.length ? days[days.length - 1] : null;
  const lastAttempts = lastDay ? nodes.filter((n) => dayOf(n) === lastDay) : [];
  const policyFile = `${root}/atris/rsi/policy.current`;
  const policy = fs.existsSync(policyFile) ? rsi.currentPolicyId(root) : 'p-0001 (default)';
  const dreams = readJsonl(rsi.dreamsPath(root));
  return {
    lanes,
    lastDay,
    lastAttempts,
    policy,
    lastDream: dreams.length ? dreams[dreams.length - 1] : null,
    totalNodes: nodes.length,
    ledger: rsi.attemptsPath(root),
  };
}

function outcomeWord(status, verify) {
  if (status === 'shipped') return verify === 'pass' ? 'shipped, verify passed' : 'shipped';
  if (status === 'failed') return 'failed';
  if (status === 'nothing') return 'found nothing to do';
  return 'still open';
}

function formatStatus(s) {
  const lines = ['rsi attempts ledger', `  ${s.ledger}`, ''];
  if (!s.totalNodes) {
    lines.push('  no attempts recorded yet.');
    lines.push('');
    lines.push(`  policy: ${s.policy}`);
    if (s.lastDream) lines.push(`  last dream: ${dreamLine(s.lastDream)}`);
    else lines.push('  no dreams yet.');
    return lines.join('\n');
  }
  const totalTrees = [...s.lanes.values()].reduce((a, l) => a + l.trees.size, 0);
  lines.push(`  ${totalTrees} tree${totalTrees === 1 ? '' : 's'}, ${s.totalNodes} attempt${s.totalNodes === 1 ? '' : 's'} across ${s.lanes.size} lane${s.lanes.size === 1 ? '' : 's'}:`);
  for (const [lane, l] of [...s.lanes.entries()].sort()) {
    const parts = [];
    if (l.shipped) parts.push(`${l.shipped} shipped`);
    if (l.failed) parts.push(`${l.failed} failed`);
    if (l.nothing) parts.push(`${l.nothing} nothing`);
    if (l.open) parts.push(`${l.open} open`);
    lines.push(`    ${lane}: ${l.trees.size} tree${l.trees.size === 1 ? '' : 's'}, ${l.nodes} attempt${l.nodes === 1 ? '' : 's'}${parts.length ? ` (${parts.join(', ')})` : ''}`);
  }
  lines.push('');
  lines.push(`  last night (${s.lastDay}): ${s.lastAttempts.length} attempt${s.lastAttempts.length === 1 ? '' : 's'}`);
  for (const n of s.lastAttempts.slice(0, 10)) {
    const reason = String((n.outcome && n.outcome.reason) || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    lines.push(`    ${n.id}: ${outcomeWord(n.outcome && n.outcome.status, n.outcome && n.outcome.verify)}${reason ? ` - ${reason}` : ''}`);
  }
  if (s.lastAttempts.length > 10) lines.push(`    ...and ${s.lastAttempts.length - 10} more`);
  lines.push('');
  lines.push(`  policy: ${s.policy}`);
  lines.push(s.lastDream ? `  last dream: ${dreamLine(s.lastDream)}` : '  no dreams yet.');
  return lines.join('\n');
}

function dreamLine(receipt) {
  const deployed = receipt.deployed ? `deployed ${receipt.deployed}` : `kept ${receipt.current || 'current policy'}`;
  const reason = String(receipt.reason || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  return `${receipt.at || '(no date)'} · ${deployed}${reason ? ` · ${reason}` : ''}`;
}

function showHelp() {
  console.log(`atris rsi - read the Dream-RSI attempt ledger

Usage:
  atris rsi            same as status
  atris rsi status     trees + attempts by lane, last night's outcomes, policy, last dream
  atris rsi status --json   machine-readable status

Read-only. State lives in .atris/state/rsi/ (or $ATRIS_RSI_STATE).`);
}

function run(argv = []) {
  const args = Array.isArray(argv) ? argv : [];
  if (args.includes('--help') || args.includes('-h') || args[0] === 'help') {
    showHelp();
    return 0;
  }
  const sub = args[0] && !args[0].startsWith('-') ? args[0] : 'status';
  if (sub !== 'status') {
    console.log(`unknown rsi subcommand: ${sub}`);
    showHelp();
    return 2;
  }
  const root = process.cwd();
  const s = collectStatus(root);
  if (args.includes('--json')) {
    const lanes = {};
    for (const [lane, l] of s.lanes.entries()) {
      lanes[lane] = { trees: l.trees.size, nodes: l.nodes, shipped: l.shipped, failed: l.failed, nothing: l.nothing, open: l.open };
    }
    console.log(JSON.stringify({
      ok: true,
      ledger: s.ledger,
      total_nodes: s.totalNodes,
      lanes,
      last_day: s.lastDay,
      last_day_attempts: s.lastAttempts.length,
      policy: s.policy,
      last_dream: s.lastDream,
    }));
    return 0;
  }
  console.log(formatStatus(s));
  return 0;
}

module.exports = { run, collectStatus, formatStatus };
