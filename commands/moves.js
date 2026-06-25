'use strict';

// `atris moves`: alive onboarding. Shows the 3 highest-leverage next moves and
// lets you approve (seed it into the loop), kill (stop suggesting it), or skip.
// This is the seed of proactiveness: the workspace proposes, you steer.

const readline = require('readline');
const {
  nextMoves,
  recordDecision,
  seedInboxFromMove,
} = require('../lib/next-moves');

function currentMoves(root, limit) {
  return nextMoves(root, limit);
}

function renderMoves(moves) {
  if (!moves.length) {
    return [
      '',
      'your next moves',
      '',
      '  nothing queued. add an item to ROADMAP.md under "## Open loop items",',
      '  or jot an idea with `atris log`.',
      '',
    ].join('\n');
  }
  const lines = ['', 'your next moves', ''];
  moves.forEach((m, i) => {
    lines.push(`  ${i + 1}. ${m.title}`);
    lines.push(`     why: ${m.why}   id: ${m.id}`);
    lines.push('');
  });
  lines.push('  approve:  atris moves --approve <id|N>   seed it into the loop');
  lines.push('  kill:     atris moves --kill <id|N>      stop suggesting it');
  lines.push('  (use the id when you act later; the numbered order can shift)');
  lines.push('');
  return lines.join('\n');
}

function parseIndexes(value) {
  return String(value || '')
    .split(/[\s,]+/)
    .map((s) => parseInt(s, 10))
    .filter((n) => Number.isInteger(n) && n >= 1);
}

// Resolve --approve/--kill tokens to move objects. A token is either a stable
// move id (m_...) or a 1-based position. The id is preferred because the list
// can re-rank between viewing and acting, so a bare index can hit a different
// move than the one you saw.
function resolveSelection(moves, value) {
  const tokens = String(value || '').split(/[\s,]+/).filter(Boolean);
  const byId = new Map(moves.map((m) => [m.id, m]));
  const seen = new Set();
  const out = [];
  for (const tok of tokens) {
    let move = null;
    if (byId.has(tok)) move = byId.get(tok);
    else if (/^\d+$/.test(tok)) move = moves[parseInt(tok, 10) - 1];
    if (move && !seen.has(move.id)) { seen.add(move.id); out.push(move); }
  }
  return out;
}

function applyDecision(root, selectedMoves, decision, stamp) {
  const { claimRoadmapItem } = require('../lib/next-moves');
  const acted = [];
  for (const move of selectedMoves) {
    recordDecision(root, move, decision, stamp);
    if (decision === 'approve') {
      // Seed then claim, mirroring the loop. For a roadmap-sourced move, mark it
      // claimed in ROADMAP so the loop and the moves list agree it is handled.
      const seeded = seedInboxFromMove(root, move);
      if (move.source === 'roadmap') claimRoadmapItem(root, move.title);
      acted.push({ move, seeded });
    } else {
      acted.push({ move });
    }
  }
  return acted;
}

function readArgValue(args, name) {
  const i = args.indexOf(name);
  if (i === -1) return null;
  return args[i + 1] || '';
}

async function movesCommand(args = [], root = process.cwd()) {
  if (args.includes('--help') || args.includes('-h') || args[0] === 'help') {
    console.log('');
    console.log('Usage: atris moves [--approve <id|N>] [--kill <id|N>] [--json] [--limit N]');
    console.log('');
    console.log('Show the next moves and steer them. Each move has a stable id; prefer it');
    console.log('over the position number, which can shift between viewing and acting.');
    console.log('');
    console.log('  atris moves                  Show the 3 next moves (prompts on a terminal)');
    console.log('  atris moves --approve <id|N> Seed that move into the loop (writes the inbox)');
    console.log('  atris moves --kill <id|N>    Stop suggesting that move');
    console.log('  atris moves --json           Print the moves (with ids) as JSON, no prompt');
    console.log('  atris moves --limit N        Show N moves (default 3)');
    console.log('');
    return 0;
  }

  const limitArg = readArgValue(args, '--limit');
  const limit = limitArg && !Number.isNaN(parseInt(limitArg, 10)) ? Math.max(1, parseInt(limitArg, 10)) : 3;
  const stamp = new Date().toISOString();

  const approveVal = readArgValue(args, '--approve');
  const killVal = readArgValue(args, '--kill');

  if (approveVal !== null || killVal !== null) {
    const moves = currentMoves(root, limit);
    const killed = applyDecision(root, resolveSelection(moves, killVal), 'kill', stamp);
    const approved = applyDecision(root, resolveSelection(moves, approveVal), 'approve', stamp);
    for (const a of approved) {
      const note = a.seeded && a.seeded.alreadyPresent ? 'already in the inbox' : 'seeded into the loop';
      console.log(`approved: ${a.move.title}  ->  ${note}`);
    }
    for (const k of killed) console.log(`killed: ${k.move.title}  ->  will not suggest again`);
    if (!approved.length && !killed.length) console.log('no matching move for that id or number.');
    return 0;
  }

  const moves = currentMoves(root, limit);

  if (args.includes('--json')) {
    console.log(JSON.stringify({ moves }, null, 2));
    return 0;
  }

  console.log(renderMoves(moves));

  // Only prompt on a real terminal, so spawned/non-interactive runs never hang.
  if (!process.stdin.isTTY || !moves.length) return 0;

  const answer = await new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question('approve N, kill kN, or enter to skip: ', (a) => { rl.close(); resolve(a.trim()); });
  });
  if (!answer) return 0;

  const killTokens = (answer.match(/k\s*\d+/gi) || []).map((t) => t.replace(/k/i, '').trim());
  const approveTokens = answer.replace(/k\s*\d+/gi, '').trim();

  const killed = applyDecision(root, resolveSelection(moves, killTokens.join(' ')), 'kill', stamp);
  const approved = applyDecision(root, resolveSelection(moves, approveTokens), 'approve', stamp);
  for (const a of approved) console.log(`approved: ${a.move.title}  ->  seeded into the loop`);
  for (const k of killed) console.log(`killed: ${k.move.title}`);
  return 0;
}

module.exports = { movesCommand, renderMoves, currentMoves, parseIndexes, resolveSelection };
