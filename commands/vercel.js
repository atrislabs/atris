const { createOfficialCliCommand } = require('../lib/official-cli-integration');

const vercelCommand = createOfficialCliCommand({
  name: 'vercel',
  binary: 'vercel',
  versionArgs: ['--version'],
  authArgs: ['whoami'],
  installHint: 'https://vercel.com/docs/cli',
  loginHint: 'vercel login',
  commands: [
    {
      usage: 'deploy',
      match: ['deploy'],
      forward: ['deploy'],
      description: 'deploy the current project',
    },
    {
      usage: 'ls',
      match: ['ls'],
      forward: ['ls'],
      description: 'list deployments',
    },
    {
      usage: 'logs',
      match: ['logs'],
      forward: ['logs'],
      description: 'stream or inspect deployment logs',
    },
    {
      usage: 'inspect',
      match: ['inspect'],
      forward: ['inspect'],
      description: 'inspect a deployment',
    },
  ],
});

module.exports = { vercelCommand };
