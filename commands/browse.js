const fs = require('fs');
const path = require('path');
const os = require('os');
const { loadCredentials } = require('../utils/auth');
const { apiRequestJson } = require('../utils/api');

async function browseAtris() {
  const query = process.argv[3] && !process.argv[3].startsWith('-') ? process.argv[3] : null;

  if (process.argv[3] === '--help') {
    console.log('Usage: atris browse [query]');
    console.log('');
    console.log('  atris browse             List all workspace templates');
    console.log('  atris browse crm         Search for templates matching "crm"');
    process.exit(0);
  }

  const creds = loadCredentials();
  if (!creds || !creds.token) {
    console.error('Not logged in. Run: atris login');
    process.exit(1);
  }

  console.log('');
  const label = query ? `Searching templates for "${query}"...` : 'Browsing workspace templates...';
  console.log(label);

  const endpoint = query
    ? `/workspace/templates?q=${encodeURIComponent(query)}`
    : '/workspace/templates';

  const result = await apiRequestJson(endpoint, { method: 'GET', token: creds.token });

  if (!result.ok) {
    // API failed — try local templates
    console.log('  API unavailable, checking local templates...');
    const localDir = path.join(os.homedir(), '.atris', 'templates');
    if (!fs.existsSync(localDir)) {
      console.error('  No templates found locally or from API.');
      process.exit(1);
    }

    const dirs = fs.readdirSync(localDir).filter(d => {
      return fs.statSync(path.join(localDir, d)).isDirectory();
    });

    if (dirs.length === 0) {
      console.log('  No local templates found.');
      return;
    }

    console.log('');
    console.log(`  ${dirs.length} local template${dirs.length > 1 ? 's' : ''}:`);
    console.log('');
    for (const name of dirs) {
      const metaFile = path.join(localDir, name, 'template.json');
      let desc = '';
      if (fs.existsSync(metaFile)) {
        try {
          const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
          desc = meta.description || '';
        } catch {}
      }
      console.log(`  ${name}${desc ? '  —  ' + desc : ''}`);
    }
    console.log('');
    return;
  }

  const templates = result.data || [];

  if (templates.length === 0) {
    console.log('');
    console.log(query ? `  No templates found for "${query}".` : '  No templates available.');
    return;
  }

  console.log('');
  console.log(`  ${templates.length} template${templates.length > 1 ? 's' : ''} found:`);
  console.log('');

  for (const t of templates) {
    const name = t.name || 'untitled';
    const desc = t.description || '';
    const agents = typeof t.agent_count === 'number' ? `${t.agent_count} agents` : '';
    const forks = typeof t.fork_count === 'number' ? `${t.fork_count} forks` : '';
    const author = t.author || '';

    const meta = [agents, forks, author].filter(Boolean).join('  |  ');
    console.log(`  ${name}`);
    if (desc) console.log(`    ${desc}`);
    if (meta) console.log(`    ${meta}`);
    console.log('');
  }

  console.log(`  Fork any template with: atris fork <name>`);
  console.log('');
}

module.exports = { browseAtris };
