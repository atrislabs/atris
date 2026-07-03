const { createOfficialCliCommand } = require('../lib/official-cli-integration');

const supabaseCommand = createOfficialCliCommand({
  name: 'supabase',
  binary: 'supabase',
  versionArgs: ['--version'],
  authArgs: ['projects', 'list'],
  doctorAliases: ['doctor'],
  installHint: 'https://supabase.com/docs/guides/cli',
  loginHint: 'supabase login',
  commands: [
    {
      usage: 'status',
      match: ['status'],
      forward: ['status'],
      description: 'show local project status',
    },
    {
      usage: 'db push',
      match: ['db', 'push'],
      forward: ['db', 'push'],
      description: 'push local database migrations',
    },
    {
      usage: 'functions list',
      match: ['functions', 'list'],
      forward: ['functions', 'list'],
      description: 'list edge functions',
    },
    {
      usage: 'functions deploy',
      match: ['functions', 'deploy'],
      forward: ['functions', 'deploy'],
      description: 'deploy an edge function',
    },
  ],
});

module.exports = { supabaseCommand };
