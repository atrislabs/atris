const { createOfficialCliCommand } = require('../lib/official-cli-integration');

const linearCommand = createOfficialCliCommand({
  name: 'linear',
  binary: 'linear',
  versionArgs: ['--version'],
  authArgs: ['auth', 'status'],
  installHint: 'install the linear cli and ensure `linear` is on PATH',
  loginHint: 'linear auth login',
  commands: [
    {
      usage: 'issue list',
      match: ['issue', 'list'],
      forward: ['issue', 'list'],
      description: 'list issues',
    },
    {
      usage: 'issue create',
      match: ['issue', 'create'],
      forward: ['issue', 'create'],
      description: 'create an issue',
    },
    {
      usage: 'issue view',
      match: ['issue', 'view'],
      forward: ['issue', 'view'],
      description: 'show issue details',
    },
    {
      usage: 'issue update',
      match: ['issue', 'update'],
      forward: ['issue', 'update'],
      description: 'update an issue',
    },
  ],
});

module.exports = { linearCommand };
