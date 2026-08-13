'use strict';

const {
  formatUsageSummary,
  parseRunnerArgs,
  parseUsageArgs,
  readUsageRecords,
  runCiRunner,
  summarizeUsage,
  usageFilePath,
} = require('../lib/ci-runner');

function showCiHelp() {
  console.log('atris ci runs github actions jobs on this machine with a warm local work folder.');
  console.log('change runs-on: ubuntu-latest to runs-on: atris.');
  console.log('a GITHUB_TOKEN or an authenticated gh cli is required.');
  console.log('usage: atris ci runner --repo <owner/name> [--label <name>] [--once]');
  console.log('       atris ci usage [--repo <owner/name>]');
}

async function ciCommand(argv, dependencies = {}) {
  if (argv.length === 0 || argv[0] === 'help' || argv.includes('--help') || argv.includes('-h')) {
    showCiHelp();
    return 0;
  }
  if (argv[0] === 'usage') {
    const options = parseUsageArgs(argv.slice(1));
    const records = (dependencies.readUsageRecords || readUsageRecords)(
      dependencies.usagePath || usageFilePath(),
      dependencies.readFile,
    );
    const clock = dependencies.clock || (() => new Date());
    const log = dependencies.log || console.log;
    log(formatUsageSummary(summarizeUsage(records, { ...options, now: clock() })));
    return 0;
  }
  if (argv[0] === 'runner') {
    await runCiRunner(parseRunnerArgs(argv.slice(1)), dependencies);
    return 0;
  }
  throw new Error(`unknown ci subcommand: ${argv[0]}`);
}

module.exports = { ciCommand, showCiHelp };
