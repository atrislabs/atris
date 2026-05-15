const fs = require('fs');
const path = require('path');
const os = require('os');
const { loadCredentials } = require('../utils/auth');
const { apiRequestJson } = require('../utils/api');

async function forkAtris() {
  const template = process.argv[3];
  const targetArg = process.argv[4];

  if (!template || template === '--help' || template === '-h' || template === 'help') {
    console.log('Usage: atris fork <template> [target-dir]');
    console.log('');
    console.log('  atris fork music-artist          Fork the music-artist template');
    console.log('  atris fork event-promoter myband  Fork into ./myband/');
    console.log('  atris fork acme                   Fork from a business slug');
    console.log('');
    console.log('Templates can be a name, business slug, or URL.');
    process.exit(0);
  }

  const creds = loadCredentials();
  if (!creds || !creds.token) {
    console.error('Not logged in. Run: atris login');
    process.exit(1);
  }

  // Resolve target directory
  const targetName = targetArg && !targetArg.startsWith('-') ? targetArg : template;
  const targetDir = path.resolve(process.cwd(), targetName);

  if (fs.existsSync(targetDir) && fs.readdirSync(targetDir).length > 0) {
    console.error(`Directory "${targetName}" already exists and is not empty.`);
    process.exit(1);
  }

  console.log('');
  console.log(`Forking template "${template}"...`);

  // Try API first
  let files = null;
  const downloadResult = await apiRequestJson(
    `/workspace/templates/${encodeURIComponent(template)}/download`,
    { method: 'GET', token: creds.token }
  );

  if (downloadResult.ok && downloadResult.data && downloadResult.data.files) {
    files = downloadResult.data.files;
  } else {
    // Fall back to local template at ~/.atris/templates/{template}/
    const localTemplatePath = path.join(os.homedir(), '.atris', 'templates', template);
    if (fs.existsSync(localTemplatePath)) {
      console.log('  API unavailable, using local template...');
      files = readLocalTemplate(localTemplatePath, localTemplatePath);
    } else {
      const msg = downloadResult.errorMessage || downloadResult.error || `HTTP ${downloadResult.status}`;
      console.error(`\n  Template "${template}" not found. ${msg}`);
      console.error('  Check available templates or provide a valid business slug.');
      process.exit(1);
    }
  }

  if (!files || files.length === 0) {
    console.error(`\n  Template "${template}" is empty.`);
    process.exit(1);
  }

  // Create target directory and .atris metadata
  const atrisDir = path.join(targetDir, '.atris');
  fs.mkdirSync(atrisDir, { recursive: true });

  // Write .atris/business.json pointing to template source
  fs.writeFileSync(path.join(atrisDir, 'business.json'), JSON.stringify({
    slug: targetName,
    forked_from: template,
  }, null, 2));

  // Write .atris/fork.json with metadata
  fs.writeFileSync(path.join(atrisDir, 'fork.json'), JSON.stringify({
    forked_from: template,
    forked_at: new Date().toISOString(),
    version: '1.0.0',
  }, null, 2));

  // Write all template files to disk
  let written = 0;
  console.log('');
  for (const file of files) {
    if (!file.path || file.content === null || file.content === undefined) continue;
    const relPath = file.path.replace(/^\//, '');
    const filePath = path.join(targetDir, relPath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, file.content);
    console.log(`  + ${relPath}`);
    written++;
  }

  // Summary
  console.log('');
  console.log(`  ${written} file${written !== 1 ? 's' : ''} written to ${targetName}/`);
  console.log('');
  console.log('  Next steps:');
  console.log('    1. Customize your context files');
  console.log('    2. Run: atris push to go live');
  console.log('');
}

function readLocalTemplate(baseDir, currentDir) {
  const files = [];
  const entries = fs.readdirSync(currentDir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      files.push(...readLocalTemplate(baseDir, fullPath));
    } else {
      try {
        const content = fs.readFileSync(fullPath, 'utf8');
        const relPath = '/' + path.relative(baseDir, fullPath);
        files.push({ path: relPath, content });
      } catch {}
    }
  }
  return files;
}

module.exports = { forkAtris };
