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
    lines.push(`     why: ${m.why}`);
    lines.push('');
  });
  lines.push('  approve N   seed move N into the loop      (atris moves --approve N)');
  lines.push('  kill N      stop suggesting move N         (atris moves --kill N)');
  lines.push('');
  return lines.join('\n');
}

function parseIndexes(value) {
  return String(value || '')
    .split(/[\s,]+/)
    .map((s) => parseInt(s, 10))
    .filter((n) => Number.isInteger(n) && n >= 1);
}

function applyDecision(root, moves, indexes, decision, stamp) {
  const acted = [];
  for (const idx of indexes) {
    const move = moves[idx - 1];
    if (!move) continue;
    recordDecision(root, move, decision, stamp);
    if (decision === 'approve') {
      const seeded = seedInboxFromMove(root, move);
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
    console.log('Usage: atris moves [--approve N] [--kill N] [--json] [--limit N]');
    console.log('');
    console.log('Show the next moves and steer them.');
    console.log('');
    console.log('  atris moves              Show the 3 next moves (prompts on a terminal)');
    console.log('  atris moves --approve N  Seed move N into the loop (writes it to the inbox)');
    console.log('  atris moves --kill N     Stop suggesting move N');
    console.log('  atris moves --json       Print the moves as JSON, no prompt');
    console.log('  atris moves --limit N    Show N moves (default 3)');
    console.log('');
    return 0;
  }

  const limitArg = readArgValue(args, '--limit');
  const limit = limitArg && !Number.isNaN(parseInt(limitArg, 10)) ? Math.max(1, parseInt(limitArg, 10)) : 3;
  const stamp = new Date().toISOString();

  const approveIdx = parseIndexes(readArgValue(args, '--approve'));
  const killIdx = parseIndexes(readArgValue(args, '--kill'));

  if (approveIdx.length || killIdx.length) {
    const moves = currentMoves(root, Math.max(limit, ...approveIdx, ...killIdx));
    const killed = applyDecision(root, moves, killIdx, 'kill', stamp);
    const approved = applyDecision(root, moves, approveIdx, 'approve', stamp);
    for (const a of approved) console.log(`approved: ${a.move.title}  ->  seeded into the loop (${a.seeded.line.trim()})`);
    for (const k of killed) console.log(`killed: ${k.move.title}  ->  will not suggest again`);
    if (!approved.length && !killed.length) console.log('no matching move for those numbers.');
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

  const killTokens = answer.match(/k\s*\d+/gi) || [];
  const killNums = killTokens.flatMap((t) => parseIndexes(t.replace(/k/i, '')));
  const approveNums = parseIndexes(answer.replace(/k\s*\d+/gi, ''));

  const killed = applyDecision(root, moves, killNums, 'kill', stamp);
  const approved = applyDecision(root, moves, approveNums, 'approve', stamp);
  for (const a of approved) console.log(`approved: ${a.move.title}  ->  seeded into the loop`);
  for (const k of killed) console.log(`killed: ${k.move.title}`);
  return 0;
}

module.exports = { movesCommand, renderMoves, currentMoves, parseIndexes };
