const fs = require('fs');
const path = require('path');
const os = require('os');
const { loadCredentials } = require('../utils/auth');
const { apiRequestJson } = require('../utils/api');

async function publishAtris() {
  const firstArg = process.argv[3];
  if (firstArg === '--help' || firstArg === '-h' || firstArg === 'help') {
    console.log('Usage: atris publish [--name <name>] [--description <desc>]');
    console.log('');
    console.log('  atris publish                         Publish current workspace as a template');
    console.log('  atris publish --name "CRM Starter"    Publish with a specific name');
    console.log('  atris publish --name crm --description "Sales CRM template"');
    process.exit(0);
  }

  const creds = loadCredentials();
  if (!creds || !creds.token) {
    console.error('Not logged in. Run: atris login');
    process.exit(1);
  }

  // Parse --name
  let name = null;
  const nameEq = process.argv.find(a => a.startsWith('--name='));
  if (nameEq) { name = nameEq.slice(7); }
  else {
    const ni = process.argv.indexOf('--name');
    if (ni !== -1 && process.argv[ni + 1] && !process.argv[ni + 1].startsWith('-')) name = process.argv[ni + 1];
  }

  // Parse --description
  let description = null;
  const descEq = process.argv.find(a => a.startsWith('--description='));
  if (descEq) { description = descEq.slice(14); }
  else {
    const di = process.argv.indexOf('--description');
    if (di !== -1 && process.argv[di + 1] && !process.argv[di + 1].startsWith('-')) description = process.argv[di + 1];
  }

  // Resolve name from .atris/business.json or directory name
  if (!name) {
    const bizFile = path.join(process.cwd(), '.atris', 'business.json');
    if (fs.existsSync(bizFile)) {
      try {
        const biz = JSON.parse(fs.readFileSync(bizFile, 'utf8'));
        name = biz.name || biz.slug;
      } catch {}
    }
    if (!name) name = path.basename(process.cwd());
  }

  // Collect files from atris/ directory
  const atrisDir = path.join(process.cwd(), 'atris');
  if (!fs.existsSync(atrisDir)) {
    console.error('No atris/ directory found. Run from a workspace root.');
    process.exit(1);
  }

  const EXCLUDE = ['logs', '.env', 'secrets'];
  const files = [];

  function collectFiles(dir, prefix) {
    const entries = fs.readdirSync(dir);
    for (const entry of entries) {
      if (EXCLUDE.includes(entry)) continue;
      if (entry.startsWith('.env') || entry === 'secrets') continue;
      const full = path.join(dir, entry);
      const rel = prefix ? `${prefix}/${entry}` : entry;
      const stat = fs.statSync(full);
      if (stat.isDirectory()) {
        collectFiles(full, rel);
      } else if (stat.isFile() && stat.size < 512 * 1024) {
        try {
          const content = fs.readFileSync(full, 'utf8');
          files.push({ path: `/${rel}`, content });
        } catch {}
      }
    }
  }

  collectFiles(atrisDir, '');

  if (files.length === 0) {
    console.error('No publishable files found in atris/.');
    process.exit(1);
  }

  console.log('');
  console.log(`Publishing "${name}" (${files.length} files)...`);

  // POST to API
  const body = { name, description: description || '', files };
  const result = await apiRequestJson('/workspace/templates', {
    method: 'POST',
    token: creds.token,
    body,
  });

  if (!result.ok) {
    console.error(`\n  Publish failed: ${result.errorMessage || result.error || result.status}`);
    process.exit(1);
  }

  // Save local copy
  const localDir = path.join(os.homedir(), '.atris', 'templates', name.toLowerCase().replace(/[^a-z0-9-]/g, '-'));
  fs.mkdirSync(localDir, { recursive: true });

  for (const f of files) {
    const filePath = path.join(localDir, f.path.replace(/^\//, ''));
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, f.content);
  }

  // Save metadata
  fs.writeFileSync(path.join(localDir, 'template.json'), JSON.stringify({
    name,
    description: description || '',
    file_count: files.length,
    published_at: new Date().toISOString(),
  }, null, 2));

  console.log('');
  console.log(`  Published as '${name}'. Others can fork with: atris fork ${name}`);
  console.log(`  Local copy saved to ${localDir}`);
  console.log('');
}

module.exports = { publishAtris };
