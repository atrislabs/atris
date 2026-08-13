'use strict';

const { parseRunnerArgs, runCiRunner } = require('../lib/ci-runner');

function showCiHelp() {
  console.log('atris ci runs github actions jobs on this machine with a warm local work folder.');
  console.log('change runs-on: ubuntu-latest to runs-on: atris.');
  console.log('a GITHUB_TOKEN or an authenticated gh cli is required.');
  console.log('usage: atris ci runner --repo <owner/name> [--label <name>] [--once]');
}

async function ciCommand(argv, dependencies) {
  if (argv.length === 0 || argv[0] === 'help' || argv.includes('--help') || argv.includes('-h')) {
    showCiHelp();
    return 0;
  }
  if (argv[0] !== 'runner') throw new Error(`unknown ci subcommand: ${argv[0]}`);
  await runCiRunner(parseRunnerArgs(argv.slice(1)), dependencies);
  return 0;
}

module.exports = { ciCommand, showCiHelp };
