const fs = require('fs');
const path = require('path');
const { loadCredentials } = require('../utils/auth');
const { apiRequestJson } = require('../utils/api');
const { loadBusinesses, saveBusinesses } = require('./business');

async function pushAtris() {
  const slug = process.argv[3];

  if (!slug || slug === '--help') {
    console.log('Usage: atris push <business-slug> [--from <path>]');
    console.log('');
    console.log('Push local files to a Business Computer.');
    console.log('');
    console.log('Examples:');
    console.log('  atris push pallet                    Push from atris/pallet/ or ./pallet/');
    console.log('  atris push pallet --from ./my-dir/   Push from a custom directory');
    process.exit(0);
  }

  const creds = loadCredentials();
  if (!creds || !creds.token) {
    console.error('Not logged in. Run: atris login');
    process.exit(1);
  }

  // Determine source directory
  const fromIdx = process.argv.indexOf('--from');
  let sourceDir;
  if (fromIdx !== -1 && process.argv[fromIdx + 1]) {
    sourceDir = path.resolve(process.argv[fromIdx + 1]);
  } else {
    const atrisDir = path.join(process.cwd(), 'atris', slug);
    const cwdDir = path.join(process.cwd(), slug);
    if (fs.existsSync(atrisDir)) {
      sourceDir = atrisDir;
    } else if (fs.existsSync(cwdDir)) {
      sourceDir = cwdDir;
    } else {
      console.error(`No local folder found for "${slug}".`);
      console.error(`Expected: atris/${slug}/ or ./${slug}/`);
      console.error('Or specify: atris push pallet --from ./path/to/folder');
      process.exit(1);
    }
  }

  if (!fs.existsSync(sourceDir)) {
    console.error(`Source directory not found: ${sourceDir}`);
    process.exit(1);
  }

  // Resolve business ID
  let businessId, workspaceId, businessName;
  const businesses = loadBusinesses();

  if (businesses[slug]) {
    businessId = businesses[slug].business_id;
    workspaceId = businesses[slug].workspace_id;
    businessName = businesses[slug].name || slug;
  } else {
    // Try to find by slug via API
    const listResult = await apiRequestJson('/businesses/', { method: 'GET', token: creds.token });
    if (!listResult.ok) {
      console.error(`Failed to fetch businesses: ${listResult.errorMessage || listResult.status}`);
      process.exit(1);
    }
    const match = (listResult.data || []).find(
      b => b.slug === slug || b.name.toLowerCase() === slug.toLowerCase()
    );
    if (!match) {
      console.error(`Business "${slug}" not found.`);
      process.exit(1);
    }
    businessId = match.id;
    workspaceId = match.workspace_id;
    businessName = match.name;

    // Auto-save
    businesses[slug] = {
      business_id: businessId,
      workspace_id: workspaceId,
      name: businessName,
      slug: match.slug,
      added_at: new Date().toISOString(),
    };
    saveBusinesses(businesses);
  }

  if (!workspaceId) {
    console.error(`Business "${slug}" has no workspace.`);
    process.exit(1);
  }

  // Walk local directory and collect files
  const files = [];
  const SKIP_DIRS = new Set(['node_modules', '__pycache__', '.git', 'venv', '.venv', 'lost+found', '.cache']);

  function walkDir(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walkDir(fullPath);
      } else if (entry.isFile()) {
        const relPath = '/' + path.relative(sourceDir, fullPath);
        try {
          const content = fs.readFileSync(fullPath, 'utf8');
          files.push({ path: relPath, content });
        } catch {
          // Skip binary files
        }
      }
    }
  }

  walkDir(sourceDir);

  if (files.length === 0) {
    console.log(`\nNo files to push from ${sourceDir}`);
    return;
  }

  console.log('');
  console.log(`Pushing ${files.length} files to ${businessName}...`);

  // Sync — one API call pushes everything
  const result = await apiRequestJson(
    `/businesses/${businessId}/workspaces/${workspaceId}/sync`,
    {
      method: 'POST',
      token: creds.token,
      body: { files },
    }
  );

  if (!result.ok) {
    const msg = result.errorMessage || `HTTP ${result.status}`;
    if (result.status === 409) {
      console.error(`\nComputer is sleeping. Wake it first, then push.`);
    } else if (result.status === 403) {
      console.error(`\nAccess denied: ${msg}`);
    } else {
      console.error(`\nPush failed: ${msg}`);
    }
    process.exit(1);
  }

  const data = result.data;
  console.log('');
  if (data.written > 0) {
    console.log(`  ${data.written} file${data.written > 1 ? 's' : ''} written`);
  }
  if (data.unchanged > 0) {
    console.log(`  ${data.unchanged} unchanged`);
  }
  if (data.errors > 0) {
    console.log(`  ${data.errors} error${data.errors > 1 ? 's' : ''}`);
    for (const r of (data.results || [])) {
      if (r.status === 'error') {
        console.log(`    ${r.path}: ${r.error}`);
      }
    }
  }
  console.log(`\n  Synced to ${businessName}.`);
}

module.exports = { pushAtris };
