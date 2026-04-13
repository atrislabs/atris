const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const { findAllSkills, parseFrontmatter } = require('./skill');

// --- Recursive Copy Helper ---

/**
 * Recursively copy a directory, skipping .DS_Store and .git.
 * @param {string} src - Source directory path
 * @param {string} dest - Destination directory path
 */
function copyRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src);
  for (const entry of entries) {
    if (entry === '.DS_Store' || entry === '.git') continue;
    const srcPath = path.join(src, entry);
    const destPath = path.join(dest, entry);
    if (fs.statSync(srcPath).isDirectory()) {
      copyRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

// --- Generate plugin.json manifest ---

/**
 * Generate plugin.json manifest from discovered skills.
 * @param {Array} skills - Array of skill objects
 * @param {string} projectDir - Project root directory
 * @returns {Object} Plugin manifest object
 */
function generateManifest(skills, projectDir) {
  let pkg = {};
  const pkgPath = path.join(projectDir, 'package.json');
  if (fs.existsSync(pkgPath)) {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  }

  return {
    name: 'atris-workspace',
    version: pkg.version || '1.0.0',
    description: `Atris workspace skills for Cowork — ${skills.length} integrations (email, calendar, slack, drive, notion, and more)`,
    author: {
      name: typeof pkg.author === 'string' ? pkg.author : (pkg.author?.name || 'Atris Labs')
    },
    homepage: pkg.homepage || 'https://github.com/atrislabs/atris',
    keywords: ['atris', 'workspace', 'integrations', 'email', 'calendar', 'slack', 'notion', 'drive']
  };
}

// --- Generate /atris-setup command ---

/**
 * Generate the /atris-setup skill markdown for workspace bootstrapping.
 * @returns {string} Skill markdown content
 */
function generateSetupCommand() {
  return `---
description: Set up Atris authentication and connect integrations (Gmail, Calendar, Slack, Notion, Drive)
allowed-tools: Bash, Read
---

# Atris Setup

Run the following steps to bootstrap Atris for this workspace.

## Step 1: Check if Atris CLI is installed

\`\`\`bash
command -v atris || npm install -g atris
\`\`\`

If the install fails, tell the user to run \`npm install -g atris\` manually.

## Step 2: Authenticate with AtrisOS

\`\`\`bash
atris whoami
\`\`\`

If not logged in, run:

\`\`\`bash
atris login
\`\`\`

This is interactive — the user will need to complete OAuth in their browser and paste the CLI code. Guide them through it.

## Step 3: Check integration status

After login, check which integrations are connected:

\`\`\`bash
TOKEN=$(node -e "console.log(require('$HOME/.atris/credentials.json').token)")

echo "=== Gmail ==="
curl -s "https://api.atris.ai/api/integrations/gmail/status" -H "Authorization: Bearer $TOKEN"

echo "\\n=== Google Calendar ==="
curl -s "https://api.atris.ai/api/integrations/google-calendar/status" -H "Authorization: Bearer $TOKEN"

echo "\\n=== Slack ==="
curl -s "https://api.atris.ai/api/integrations/slack/status" -H "Authorization: Bearer $TOKEN"

echo "\\n=== Notion ==="
curl -s "https://api.atris.ai/api/integrations/notion/status" -H "Authorization: Bearer $TOKEN"

echo "\\n=== Google Drive ==="
curl -s "https://api.atris.ai/api/integrations/google-drive/status" -H "Authorization: Bearer $TOKEN"
\`\`\`

## Step 4: Connect missing integrations

For any integration that shows \`"connected": false\`, guide the user through the OAuth flow:

1. Call the integration's \`/start\` endpoint to get an auth URL
2. Have the user open the URL in their browser
3. After authorizing, confirm the connection by re-checking status

Tell the user which integrations are connected and which still need setup. They can connect more later by running \`/atris-setup\` again.
`;
}

// --- Generate README.md ---

/**
 * Generate README.md for the plugin package.
 * @param {Array} skills - Array of discovered skills
 * @returns {string} README markdown content
 */
function generateREADME(skills) {
  const skillList = skills.map(s => {
    const fm = s.frontmatter || {};
    const name = fm.name || s.folder || 'unknown';
    const desc = (fm.description || '').split('.')[0] || 'No description';
    return `- **${name}**: ${desc}`;
  }).join('\n');

  return `# Atris Workspace Plugin

Brings Atris CLI skills into the Cowork desktop app.

## Setup

1. Install this plugin in Cowork
2. Run \`/atris-setup\` to authenticate and connect integrations
3. Start using skills — they trigger automatically based on your requests

## Included Skills (${skills.length})

${skillList}

## Requirements

- [Atris CLI](https://www.npmjs.com/package/atris) (\`npm install -g atris\`)
- AtrisOS account (free at https://atris.ai)

## Learn More

- Docs: https://github.com/atrislabs/atris
- CLI help: \`atris help\`
`;
}

// --- BUILD subcommand ---

/**
 * Build the plugin package from atris/skills into dist/.
 * @param {...string} args - CLI arguments
 */
function buildPlugin(...args) {
  const projectDir = process.cwd();
  const atrisDir = path.join(projectDir, 'atris');
  const skillsDir = path.join(atrisDir, 'skills');

  // 1. Validate
  if (!fs.existsSync(atrisDir)) {
    console.error('✗ Error: atris/ folder not found. Run "atris init" first.');
    process.exit(1);
  }
  if (!fs.existsSync(skillsDir)) {
    console.error('✗ Error: atris/skills/ folder not found.');
    process.exit(1);
  }

  // 2. Discover skills
  const allSkills = findAllSkills(skillsDir);
  if (allSkills.length === 0) {
    console.warn('⚠ No skills found in atris/skills/. Plugin will be empty.');
  }

  console.log(`\n📦 Building Atris plugin (${allSkills.length} skills)...\n`);

  // 3. Create temp dir
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-plugin-'));

  try {
    // 4. Create .claude-plugin/plugin.json
    const pluginMetaDir = path.join(tempDir, '.claude-plugin');
    fs.mkdirSync(pluginMetaDir, { recursive: true });
    const manifest = generateManifest(allSkills, projectDir);
    fs.writeFileSync(
      path.join(pluginMetaDir, 'plugin.json'),
      JSON.stringify(manifest, null, 2)
    );
    console.log('  ✓ Created plugin.json manifest');

    // 5. Copy all skills
    const pluginSkillsDir = path.join(tempDir, 'skills');
    fs.mkdirSync(pluginSkillsDir, { recursive: true });

    for (const skill of allSkills) {
      // skill object from findAllSkills has .dir (full path) and we need folder name
      const skillFolder = skill.folder || path.basename(skill.dir || skill.path || '');
      if (!skillFolder) continue;

      const srcPath = path.join(skillsDir, skillFolder);
      const destPath = path.join(pluginSkillsDir, skillFolder);

      if (fs.existsSync(srcPath) && fs.statSync(srcPath).isDirectory()) {
        copyRecursive(srcPath, destPath);
        const fm = skill.frontmatter || {};
        console.log(`  ✓ ${fm.name || skillFolder}`);
      }
    }

    // 6. Create commands/atris-setup.md
    const commandsDir = path.join(tempDir, 'commands');
    fs.mkdirSync(commandsDir, { recursive: true });
    fs.writeFileSync(path.join(commandsDir, 'atris-setup.md'), generateSetupCommand());
    console.log('  ✓ Created /atris-setup command');

    // 7. Create README.md
    fs.writeFileSync(path.join(tempDir, 'README.md'), generateREADME(allSkills));
    console.log('  ✓ Created README.md');

    // 8. Parse --output flag
    let outputFile = path.join(projectDir, 'atris-workspace.plugin');
    for (const arg of args) {
      if (typeof arg === 'string' && arg.startsWith('--output=')) {
        outputFile = path.resolve(arg.split('=')[1]);
      }
    }

    // 9. ZIP it
    try {
      // Create zip in /tmp first (Cowork best practice)
      const tmpZip = path.join(os.tmpdir(), 'atris-workspace.plugin');
      if (fs.existsSync(tmpZip)) fs.unlinkSync(tmpZip);

      execSync(`cd "${tempDir}" && zip -r "${tmpZip}" . -x "*.DS_Store" "*.git*"`, {
        stdio: 'pipe'
      });

      // Copy to final destination
      fs.copyFileSync(tmpZip, outputFile);
      fs.unlinkSync(tmpZip);
    } catch (e) {
      console.error('✗ ZIP failed. Ensure "zip" command is available.');
      console.error(`  Temp dir preserved at: ${tempDir}`);
      process.exit(1);
    }

    // 10. Summary
    const stats = fs.statSync(outputFile);
    const sizeKB = (stats.size / 1024).toFixed(1);
    console.log('');
    console.log(`✓ Plugin built: ${path.basename(outputFile)} (${allSkills.length} skills, ${sizeKB}KB)`);
    console.log(`  Location: ${outputFile}`);
    console.log('');
    console.log('Install in Cowork:');
    console.log('  Open the .plugin file or drag it into the Cowork app.');
    console.log('  Then run /atris-setup to authenticate.');
    console.log('');

  } finally {
    // Clean up temp dir (only if ZIP succeeded — we skip cleanup on error above)
    if (fs.existsSync(tempDir)) {
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    }
  }
}

// --- INFO subcommand ---

function showPluginInfo() {
  const skillsDir = path.join(process.cwd(), 'atris', 'skills');

  if (!fs.existsSync(skillsDir)) {
    console.error('✗ atris/skills/ not found. Run "atris init" first.');
    process.exit(1);
  }

  const allSkills = findAllSkills(skillsDir);

  let pkg = {};
  const pkgPath = path.join(process.cwd(), 'package.json');
  if (fs.existsSync(pkgPath)) {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  }

  console.log('');
  console.log('Atris Plugin Preview');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  Name:    atris-workspace`);
  console.log(`  Version: ${pkg.version || '1.0.0'}`);
  console.log(`  Skills:  ${allSkills.length}`);
  console.log('');

  if (allSkills.length > 0) {
    console.log('Included skills:');
    for (const skill of allSkills) {
      const fm = skill.frontmatter || {};
      const name = fm.name || skill.folder || 'unknown';
      const desc = (fm.description || 'No description').substring(0, 65);
      console.log(`  • ${name.padEnd(16)} ${desc}`);
    }
    console.log('');
  }

  console.log('Components:');
  console.log(`  Skills:   ${allSkills.length}`);
  console.log('  Commands: 1 (/atris-setup)');
  console.log('');
  console.log('Run "atris plugin build" to package.');
  console.log('');
}

// --- PUBLISH subcommand ---

function publishPlugin(...args) {
  const projectDir = process.cwd();
  const skillsDir = path.join(projectDir, 'atris', 'skills');

  if (!fs.existsSync(skillsDir)) {
    console.error('✗ atris/skills/ not found. Run "atris init" first.');
    process.exit(1);
  }

  // Find the marketplace repo — check sibling dir or --repo flag
  let marketplaceDir = null;
  for (const arg of args) {
    if (typeof arg === 'string' && arg.startsWith('--repo=')) {
      marketplaceDir = path.resolve(arg.split('=')[1]);
    }
  }
  if (!marketplaceDir) {
    // Default: look for atris-plugins as a sibling directory
    const siblingDir = path.join(path.dirname(projectDir), 'atris-plugins');
    if (fs.existsSync(siblingDir)) {
      marketplaceDir = siblingDir;
    }
  }
  if (!marketplaceDir || !fs.existsSync(marketplaceDir)) {
    console.error('✗ Marketplace repo not found.');
    console.error('  Expected at: ../atris-plugins/');
    console.error('  Or specify:  atris plugin publish --repo=/path/to/atris-plugins');
    process.exit(1);
  }

  const pluginDir = path.join(marketplaceDir, 'plugins', 'atris-workspace');
  const destSkillsDir = path.join(pluginDir, 'skills');
  const destCommandsDir = path.join(pluginDir, 'commands');

  console.log(`\n📡 Publishing to ${path.basename(marketplaceDir)}...\n`);

  // 1. Clear old skills and re-copy
  if (fs.existsSync(destSkillsDir)) {
    fs.rmSync(destSkillsDir, { recursive: true, force: true });
  }
  fs.mkdirSync(destSkillsDir, { recursive: true });

  const allSkills = findAllSkills(skillsDir);
  for (const skill of allSkills) {
    const skillFolder = skill.folder || path.basename(skill.dir || skill.path || '');
    if (!skillFolder) continue;
    const srcPath = path.join(skillsDir, skillFolder);
    const destPath = path.join(destSkillsDir, skillFolder);
    if (fs.existsSync(srcPath) && fs.statSync(srcPath).isDirectory()) {
      copyRecursive(srcPath, destPath);
      const fm = skill.frontmatter || {};
      console.log(`  ✓ ${fm.name || skillFolder}`);
    }
  }

  // 2. Update commands
  fs.mkdirSync(destCommandsDir, { recursive: true });
  fs.writeFileSync(path.join(destCommandsDir, 'atris-setup.md'), generateSetupCommand());
  console.log('  ✓ /atris-setup command');

  // 3. Update plugin.json version
  let pkg = {};
  const pkgPath = path.join(projectDir, 'package.json');
  if (fs.existsSync(pkgPath)) {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  }
  const pluginJsonPath = path.join(pluginDir, '.claude-plugin', 'plugin.json');
  if (fs.existsSync(pluginJsonPath)) {
    const pluginJson = JSON.parse(fs.readFileSync(pluginJsonPath, 'utf8'));
    pluginJson.version = pkg.version || pluginJson.version;
    fs.writeFileSync(pluginJsonPath, JSON.stringify(pluginJson, null, 2) + '\n');
  }

  // 4. Update marketplace.json version
  const marketplaceJsonPath = path.join(marketplaceDir, '.claude-plugin', 'marketplace.json');
  if (fs.existsSync(marketplaceJsonPath)) {
    const mkt = JSON.parse(fs.readFileSync(marketplaceJsonPath, 'utf8'));
    const entry = (mkt.plugins || []).find(p => p.name === 'atris-workspace');
    if (entry) {
      entry.version = pkg.version || entry.version;
    }
    fs.writeFileSync(marketplaceJsonPath, JSON.stringify(mkt, null, 2) + '\n');
  }

  // 5. Update README
  fs.writeFileSync(path.join(pluginDir, 'README.md'), generateREADME(allSkills));
  console.log('  ✓ README.md');

  // 6. Git commit + push
  console.log('');
  const version = pkg.version || 'latest';
  try {
    execSync('git add -A', { cwd: marketplaceDir, stdio: 'pipe' });
    const status = execSync('git status --porcelain', { cwd: marketplaceDir, encoding: 'utf8' }).trim();
    if (!status) {
      console.log('✓ No changes — marketplace already up to date.');
      return;
    }
    execSync(`git commit -m "chore: Update atris-workspace plugin to v${version}"`, {
      cwd: marketplaceDir, stdio: 'pipe'
    });
    execSync('git push', { cwd: marketplaceDir, stdio: 'pipe' });
    console.log(`✓ Published v${version} (${allSkills.length} skills) → pushed to remote`);
  } catch (e) {
    console.error('⚠ Skills synced but git push failed. Commit manually:');
    console.error(`  cd ${marketplaceDir} && git add -A && git commit -m "update" && git push`);
  }
  console.log('');
}

// --- Main Dispatcher ---

function pluginCommand(subcommand, ...args) {
  switch (subcommand) {
    case 'build':
      buildPlugin(...args);
      break;
    case 'info':
    case 'preview':
      showPluginInfo();
      break;
    case 'publish':
    case 'sync':
      publishPlugin(...args);
      break;
    default:
      console.log('');
      console.log('Usage: atris plugin <subcommand>');
      console.log('');
      console.log('Subcommands:');
      console.log('  build [--output=path]  - Package skills into .plugin for Cowork');
      console.log('  publish [--repo=path]  - Sync skills to marketplace repo and push');
      console.log('  info                   - Preview what will be included');
      console.log('');
      break;
  }
}

module.exports = { pluginCommand };
