const { createOfficialCliCommand } = require('../lib/official-cli-integration');

const githubCommand = createOfficialCliCommand({
  name: 'github',
  binary: 'gh',
  versionArgs: ['--version'],
  authArgs: ['auth', 'status'],
  installHint: 'https://cli.github.com/',
  loginHint: 'gh auth login',
  commands: [
    {
      usage: 'pr list',
      match: ['pr', 'list'],
      forward: ['pr', 'list'],
      description: 'list pull requests',
    },
    {
      usage: 'pr create',
      match: ['pr', 'create'],
      forward: ['pr', 'create'],
      description: 'create a pull request',
    },
    {
      usage: 'pr checks',
      match: ['pr', 'checks'],
      forward: ['pr', 'checks'],
      description: 'show pull request checks',
    },
    {
      usage: 'pr view',
      match: ['pr', 'view'],
      forward: ['pr', 'view'],
      description: 'show pull request details',
    },
  ],
});

module.exports = { githubCommand };
