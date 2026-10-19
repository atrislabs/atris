'use strict';

const { checkZen } = require('../lib/zen');

function showZenHelp() {
  console.log('usage: atris zen [--no-fetch] [--json]');
  console.log('');
  console.log('Checks whether this repo is in zen state. It changes nothing.');
  console.log('Zen: code matches origin, no stray code edits, no old stashes,');
  console.log('no idle side copies, no merged branches. Team notes in atris/');
  console.log('and agent config stay as they are.');
  console.log('');
  console.log('  --no-fetch   Compare against the last fetched origin instead of fetching.');
  console.log('  --json       Print machine-readable results.');
  console.log('');
  console.log('Add more team-state paths in .atris/zen.json: {"team_state": ["logs/"]}');
}

function zenCommand(args = [], cwd = process.cwd()) {
  if (args.includes('--help') || args.includes('-h') || args[0] === 'help') {
    showZenHelp();
    return 0;
  }

  const result = checkZen({ cwd, fetch: !args.includes('--no-fetch') });

  if (args.includes('--json')) {
    console.log(JSON.stringify(result, null, 2));
    return result.ok ? (result.zen ? 0 : 1) : 2;
  }

  if (!result.ok) {
    console.log(`zen: can't check, ${result.error}.`);
    return 2;
  }

  const kept = result.team_files
    ? `${result.team_files} team ${result.team_files === 1 ? 'file' : 'files'} kept as they are`
    : 'no team files changed';
  const stale = result.fetched === false ? ' (could not reach origin, using last fetch)' : '';

  if (result.zen) {
    console.log('zen: yes');
    console.log(`  code matches ${result.upstream}${stale}`);
    console.log(`  ${kept}`);
  } else {
    const n = result.problems.length;
    console.log(`zen: no, ${n} ${n === 1 ? 'thing is' : 'things are'} out of place${stale}`);
    for (const problem of result.problems) console.log(`  - ${problem.text}`);
    console.log(`  ${kept}`);
  }

  const busy = result.worktrees_with_work.length;
  if (busy) {
    console.log(`  ${busy} side ${busy === 1 ? 'copy has' : 'copies have'} unsaved work, left for ${busy === 1 ? 'its owner' : 'their owners'}`);
  }

  return result.zen ? 0 : 1;
}

module.exports = { zenCommand, showZenHelp };
