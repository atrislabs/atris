'use strict';

const { abandonedDaysFromEnv, checkZen, sideCopyLines } = require('../lib/zen');
const { applyZen } = require('../lib/zen-apply');
const { workspaceZen } = require('../lib/zen-workspace');

function showZenHelp() {
  console.log('usage: atris zen [--check] [--no-fetch] [--json]');
  console.log('');
  console.log('Brings this repo to zen: code matches origin, nothing left lying around.');
  console.log('Old stashes are archived, idle side copies put away, finished branches');
  console.log('cleared, stray code edits saved to a zen-backup/ branch, and the main');
  console.log('branch caught up. Only branches already on origin are cleared, so nothing');
  console.log('is lost, and everything else can be brought back. Team notes');
  console.log('in atris/ and agent config stay as they are. Anything touched in the last');
  console.log('30 minutes is left alone. A side copy with unsaved work nobody has touched in');
  console.log('3 days is saved to a zen-backup/ branch and put away. A side copy locked with git worktree lock');
  console.log('always stays. Then the workspace is tidied with atris clean, and');
  console.log('anything only you can do is listed with the one command that does it.');
  console.log('');
  console.log('  --check      Only look. Report what is out of place and change nothing.');
  console.log('  --no-fetch   Use the last fetched origin instead of fetching.');
  console.log('  --json       Print machine-readable results.');
  console.log('');
  console.log('Add more team-state paths in .atris/zen.json: {"team_state": ["logs/"]}');
}

function pause(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function makeOut(calm) {
  const dim = (text) => (calm ? `\x1b[2m${text}\x1b[0m` : text);
  const line = (text = '', ms = 110) => {
    console.log(text);
    if (calm && text) pause(ms);
  };
  // One raked line, drawn left to right.
  const rake = (width = 34) => {
    if (!calm) {
      console.log(`  ${'─'.repeat(width)}`);
      return;
    }
    process.stdout.write('  ');
    for (let i = 0; i < width; i += 1) {
      process.stdout.write(dim('─'));
      pause(14);
    }
    process.stdout.write('\n');
    pause(160);
  };
  return { dim, line, rake };
}

function teamLine(n) {
  if (!n) return 'no team notes changed.';
  return n === 1 ? '1 team note kept as it is.' : `${n} team notes kept as they are.`;
}

function printYours(yours, line, dim) {
  const width = Math.max(...yours.map((item) => item.text.length));
  for (const item of yours) line(`  ${item.text.padEnd(width)}   ${dim(item.cmd)}`);
}

function printCheck(result, workspace) {
  const kept = result.team_files
    ? (result.team_files === 1 ? '1 team file kept as it is' : `${result.team_files} team files kept as they are`)
    : 'no team files changed';
  const stale = result.fetched === false ? ' (could not reach origin, using last fetch)' : '';
  const tidy = workspace?.todo.length || 0;
  if (result.zen && tidy) {
    console.log(`zen: almost, the code is calm and the workspace has ${tidy} ${tidy === 1 ? 'thing' : 'things'} to tidy`);
    console.log(`  code matches ${result.upstream}${stale}`);
    console.log(`  ${kept}`);
    console.log('  run atris zen to make it zen');
  } else if (result.zen) {
    console.log('zen: yes');
    console.log(`  code matches ${result.upstream}${stale}`);
    console.log(`  ${kept}`);
  } else {
    const n = result.problems.length;
    console.log(`zen: no, ${n} ${n === 1 ? 'thing is' : 'things are'} out of place${stale}`);
    for (const problem of result.problems) console.log(`  - ${problem.text}`);
    console.log(`  ${kept}`);
    console.log('  run atris zen to make it zen');
  }
  if (result.worktrees_with_work.length) {
    for (const text of sideCopyLines(result.worktrees_with_work, abandonedDaysFromEnv())) console.log(`  ${text}`);
  }
  const held = result.worktrees_locked?.length || 0;
  if (held) {
    console.log(`  ${held} side ${held === 1 ? 'copy is locked by its owner' : 'copies are locked by their owners'}, left alone`);
  }
  const live = result.worktrees_in_use?.length || 0;
  if (live) {
    const mins = result.fresh_minutes;
    console.log(`  ${live} side ${live === 1 ? 'copy was' : 'copies were'} used in the last ${mins} ${mins === 1 ? 'minute' : 'minutes'}, left alone`);
  }
  if (workspace?.todo.length) {
    console.log('workspace:');
    for (const text of workspace.todo) console.log(`  - ${text}`);
  }
  if (workspace?.yours.length) {
    console.log('for you:');
    printYours(workspace.yours, (text) => console.log(text), (text) => text);
  }
}

function printApply(result, out) {
  const { dim, line, rake } = out;
  line('');
  line('  atris zen', 200);
  line('');
  rake();
  line('');
  line(dim('  code'));
  if (!result.done.length && result.zen) line(`  matches ${result.upstream || 'origin'}`);
  for (const text of result.done) line(`  ${text}`);
  for (const text of [...result.left, ...result.notes]) line(dim(`  ${text}`));
  line('');
  const ws = result.workspace || { done: [], yours: [] };
  if (ws.ran) {
    line(dim('  workspace'));
    if (!ws.done.length) line('  tidy');
    for (const text of ws.done) line(`  ${text}`);
    line('');
  }
  if (ws.yours?.length) {
    line(dim('  for you'));
    printYours(ws.yours, line, dim);
    line('');
  }
  if (result.zen) {
    line(`  ${result.already ? 'already zen.' : 'zen.'}`, 260);
  } else {
    line('  almost zen. still out of place:');
    for (const text of result.remaining) line(dim(`  - ${text}`));
  }
  line(dim(`  ${teamLine(result.team_files)}`));
  if (result.saved.length) {
    line(dim('  everything is kept: git for-each-ref refs/archive refs/heads/zen-backup'));
  }
  line('');
}

function zenCommand(args = [], cwd = process.cwd()) {
  if (args.includes('--help') || args.includes('-h') || args[0] === 'help') {
    showZenHelp();
    return 0;
  }
  const fetch = !args.includes('--no-fetch');
  const json = args.includes('--json');

  if (args.includes('--check')) {
    const result = checkZen({ cwd, fetch });
    if (json) {
      console.log(JSON.stringify(result, null, 2));
      return result.ok ? (result.zen ? 0 : 1) : 2;
    }
    if (!result.ok) {
      console.log(`zen: can't check, ${result.error}.`);
      return 2;
    }
    const workspace = workspaceZen({ root: result.root, dryRun: true });
    printCheck(result, workspace);
    return result.zen && !workspace.todo.length ? 0 : 1;
  }

  const result = applyZen({ cwd, fetch });
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return result.ok ? (result.zen ? 0 : 1) : 2;
  }
  if (!result.ok) {
    console.log(`zen: can't start, ${result.error}.`);
    return 2;
  }
  const calm = Boolean(process.stdout.isTTY) && !process.env.CI;
  printApply(result, makeOut(calm));
  return result.zen ? 0 : 1;
}

module.exports = { zenCommand, showZenHelp };
