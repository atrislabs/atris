const fs = require('fs');
const path = require('path');
const os = require('os');
const { ensureWikiScaffold } = require('../lib/wiki');

const TEMPLATE_ROOT_DIR = path.join(__dirname, '..', 'templates');
const WORKSPACE_TEMPLATES = {
  business: {
    dir: path.join(TEMPLATE_ROOT_DIR, 'business-starter'),
    label: 'business environment',
  },
  research: {
    dir: path.join(TEMPLATE_ROOT_DIR, 'research-canonical'),
    label: 'research lab environment',
  },
};

/**
 * Walk a directory and return relative file paths.
 */
function _walkTemplateDir(dir, base = dir) {
  const out = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      out.push(..._walkTemplateDir(full, base));
    } else if (e.isFile()) {
      out.push(path.relative(base, full));
    }
  }
  return out;
}

/**
 * Substitute workspace metadata in template content.
 */
function _substituteParams(content, params) {
  return content
    .replace(/\{\{name\}\}/g, params.name || params.slug || 'this business')
    .replace(/\{\{slug\}\}/g, params.slug || 'business')
    .replace(/\{\{owner_email\}\}/g, params.owner_email || '')
    .replace(/\{\{business_id\}\}/g, params.business_id || '')
    .replace(/\{\{workspace_id\}\}/g, params.workspace_id || '')
    .replace(/\{\{today\}\}/g, params.today || new Date().toISOString().slice(0, 10))
    .replace(/\{\{workspace_template\}\}/g, params.workspace_template || 'business');
}

function _templateTargetRelPath(relPath) {
  return relPath === 'persona.md' ? 'PERSONA.md' : relPath;
}

function ensureRealDirectory(dir) {
  let stat = null;
  try {
    stat = fs.lstatSync(dir);
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error;
  }
  if (stat) {
    if (stat.isDirectory()) return;
    if (stat.isSymbolicLink()) {
      try {
        if (fs.statSync(dir).isDirectory()) return;
        fs.unlinkSync(dir);
      } catch (_) {
        fs.unlinkSync(dir);
      }
    } else {
      throw new Error(`${dir} exists and is not a directory`);
    }
  }
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * Sync the canonical skill set from atris-cli/atris/skills/* into a
 * workspace's atris/skills/* (plus ensure .claude/skills/ symlinks).
 *
 * Shared by business mode (via syncWorkspaceTemplate) and legacy/dev mode
 * (via syncAtris). Single source of truth = atris-cli/atris/skills/.
 *
 * Returns the number of files updated (0 if everything was up to date).
 */
function syncPackageSkills(targetAtrisDir, opts = {}) {
  const packageSkillsDir = path.join(__dirname, '..', 'atris', 'skills');
  const userSkillsDir = path.join(targetAtrisDir, 'skills');
  const claudeSkillsBaseDir = path.join(path.dirname(targetAtrisDir), '.claude', 'skills');
  const verbose = opts.verbose !== false;
  let updated = 0;

  if (!fs.existsSync(packageSkillsDir)) return 0;

  ensureRealDirectory(userSkillsDir);
  ensureRealDirectory(claudeSkillsBaseDir);

  const skillFolders = fs.readdirSync(packageSkillsDir).filter(f => {
    try { return fs.statSync(path.join(packageSkillsDir, f)).isDirectory(); }
    catch { return false; }
  });

  for (const skill of skillFolders) {
    const srcSkillDir = path.join(packageSkillsDir, skill);
    const destSkillDir = path.join(userSkillsDir, skill);
    const symlinkPath = path.join(claudeSkillsBaseDir, skill);

    const syncRecursive = (src, dest, skillName, basePath = '') => {
      ensureRealDirectory(dest);
      for (const entry of fs.readdirSync(src)) {
        const srcPath = path.join(src, entry);
        const destPath = path.join(dest, entry);
        const relPath = basePath ? `${basePath}/${entry}` : entry;
        if (fs.statSync(srcPath).isDirectory()) {
          syncRecursive(srcPath, destPath, skillName, relPath);
        } else {
          const srcContent = fs.readFileSync(srcPath, 'utf8');
          const destContent = fs.existsSync(destPath) ? fs.readFileSync(destPath, 'utf8') : '';
          if (srcContent !== destContent) {
            fs.writeFileSync(destPath, srcContent);
            if (entry.endsWith('.sh')) fs.chmodSync(destPath, 0o755);
            if (verbose) console.log(`✓ Updated atris/skills/${skillName}/${relPath}`);
            updated++;
          }
        }
      }
    };

    syncRecursive(srcSkillDir, destSkillDir, skill);

    if (!fs.existsSync(symlinkPath)) {
      const relativePath = path.relative(claudeSkillsBaseDir, destSkillDir);
      try {
        fs.symlinkSync(relativePath, symlinkPath);
        if (verbose) console.log(`✓ Linked .claude/skills/${skill}`);
      } catch (e) {
        ensureRealDirectory(symlinkPath);
        const skillFile = path.join(destSkillDir, 'SKILL.md');
        if (fs.existsSync(skillFile)) {
          fs.copyFileSync(skillFile, path.join(symlinkPath, 'SKILL.md'));
        }
        if (verbose) console.log(`✓ Copied .claude/skills/${skill} (symlink failed)`);
      }
    }
  }

  return updated;
}

function resolveWorkspaceTemplate(templateName = 'business') {
  const normalized = String(templateName || 'business').toLowerCase();
  if (normalized === 'research-lab' || normalized === 'researchlab' || normalized === 'lab') {
    return { key: 'research', ...WORKSPACE_TEMPLATES.research };
  }
  const template = WORKSPACE_TEMPLATES[normalized];
  if (!template) return null;
  return { key: normalized, ...template };
}

function ensureWorkspaceStateFiles(targetRoot, params, options = {}) {
  const dryRun = options.dryRun === true;
  const metaDir = path.join(targetRoot, '.atris');
  const stateDir = path.join(metaDir, 'state');
  const created = [];

  const files = [
    {
      relPath: '_sync.json',
      content: `${JSON.stringify({
        workspace_slug: params.slug || 'business',
        business_id: params.business_id || '',
        workspace_id: params.workspace_id || '',
        workspace_template: params.workspace_template || 'business',
        status: 'initialized-local',
        updated_at: new Date().toISOString(),
        source: 'workspace template bootstrap',
      }, null, 2)}\n`,
    },
    { relPath: 'events.jsonl', content: '' },
    { relPath: 'episodes.jsonl', content: '' },
    { relPath: 'scorecards.jsonl', content: '' },
  ];

  for (const file of files) {
    const fullPath = path.join(stateDir, file.relPath);
    if (fs.existsSync(fullPath)) continue;
    created.push(path.join('.atris', 'state', file.relPath));
    if (!dryRun) {
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, file.content);
    }
  }

  return created;
}

function renderBusinessAgentAdapter(bizMeta = {}, targetRoot = '.') {
  const name = bizMeta.name || bizMeta.slug || 'this business';
  const slug = bizMeta.slug || 'business';
  const rootHint = targetRoot || '.';
  return [
    `# AGENTS.md - ${name} Atris Workspace`,
    '',
    `You are operating inside the shared Atris workspace for ${name} (${slug}).`,
    '',
    '## Start Here',
    '',
    'Run these first from the workspace root:',
    '',
    '```bash',
    'atris',
    'atris business start',
    'atris radar',
    'atris task next',
    'atris member activate operator',
    '```',
    '',
    'If no active mission exists, start the first bounded business loop:',
    '',
    '```bash',
    'atris mission status --status active --json',
    `atris mission start "Run the first useful loop for ${name}" --owner operator --runner codex_goal --lane business --verify "atris business check" --stop "first proof recap recorded"`,
    'atris member goal-from-mission operator',
    'atris do',
    '```',
    '',
    '## Core Files',
    '',
    '| File | Purpose |',
    '|------|---------|',
    '| `atris/atris.md` | Workspace boot protocol |',
    '| `atris/MAP.md` | Navigation and where-is-X index |',
    '| `.atris/state/tasks.projection.json` | Current task projection |',
    '| `atris/TODO.md` | Rendered task fallback only |',
    '| `atris/team/START_HERE.md` | Team lanes and first-run flow |',
    '| `atris/wiki/` | Business context and source-backed briefs |',
    '| `atris/reports/` | Proof recaps and share handoffs |',
    '',
    '## Rules',
    '',
    '- Check `atris/MAP.md` before broad code or file search.',
    '- Use `atris task` for ownership, notes, proof, and review state.',
    '- Use `atris mission` when work should survive the current chat.',
    '- Put completed agent work in Review with `atris task ready <id> --proof "<receipt>".`',
    '- Do not run `atris task accept` or claim XP unless a human approved the proof.',
    '- Do not mix another business into this workspace.',
    '- No external sends, spend, or launches without operator approval.',
    '',
    '## Proof Loop',
    '',
    '```bash',
    'atris sync --dry-run',
    'atris business check',
    'atris business record atris/reports/<recap>.md --outcome mixed --metric "operator speed"',
    'atris business share --write',
    'atris sync',
    '# Optional during active collaboration:',
    'atris sync --watch',
    '```',
    '',
    `Workspace root at creation: ${rootHint}`,
    '',
  ].join('\n');
}

function ensureBusinessRootAgentAdapters(targetRoot, bizMeta = {}, options = {}) {
  const dryRun = options.dryRun === true;
  const written = [];
  const adapter = renderBusinessAgentAdapter(bizMeta, targetRoot);
  const files = ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md'];
  for (const file of files) {
    const fullPath = path.join(targetRoot, file);
    if (fs.existsSync(fullPath)) continue;
    written.push(file);
    if (!dryRun) fs.writeFileSync(fullPath, adapter, 'utf8');
  }
  return written;
}

/**
 * Sync canonical business template files into a business workspace.
 * Used when .atris/business.json is present (business mode).
 *
 * Default: NEVER overwrites existing files (preserves customizations).
 * --force: overwrites existing canonical files (bumps to latest).
 */
function syncWorkspaceTemplate(targetRoot, bizMeta, options = {}) {
  const template = resolveWorkspaceTemplate(options.templateName || bizMeta.workspace_template || 'business');
  if (!template) {
    console.error(`✗ Unknown workspace template: ${options.templateName || bizMeta.workspace_template}`);
    process.exit(1);
  }

  const params = {
    slug: bizMeta.slug || 'business',
    name: bizMeta.name || bizMeta.slug || 'this business',
    owner_email: bizMeta.owner_email || '',
    business_id: bizMeta.business_id || '',
    workspace_id: bizMeta.workspace_id || '',
    today: new Date().toISOString().slice(0, 10),
    workspace_template: template.key,
  };
  const force = options.force != null ? options.force : process.argv.includes('--force');
  const dryRun = options.dryRun != null ? options.dryRun : process.argv.includes('--dry-run');
  const targetAtrisDir = path.join(targetRoot, 'atris');

  if (!fs.existsSync(template.dir)) {
    console.error(`✗ Workspace template directory not found: ${template.dir}`);
    console.error('  Your atris-cli installation may be incomplete.');
    process.exit(1);
  }

  console.log('');
  console.log(`Updating ${params.name} (${params.slug}) from ${template.label} templates...`);
  console.log(`  Target: ${targetAtrisDir}/`);
  console.log(`  Source: ${template.dir}`);
  console.log('');

  const templateFiles = _walkTemplateDir(template.dir).sort();
  let added = 0, updated = 0, skipped = 0, preserved = 0;
  const addedList = [], updatedList = [], preservedList = [];

  for (const relPath of templateFiles) {
    const targetRelPath = _templateTargetRelPath(relPath);
    const templatePath = path.join(template.dir, relPath);
    const targetPath = path.join(targetAtrisDir, targetRelPath);
    let templateContent;
    try { templateContent = fs.readFileSync(templatePath, 'utf-8'); } catch { continue; }
    const finalContent = _substituteParams(templateContent, params);

    if (!fs.existsSync(targetPath)) {
      addedList.push(targetRelPath); added++;
      if (!dryRun) {
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        fs.writeFileSync(targetPath, finalContent);
      }
    } else {
      const existing = fs.readFileSync(targetPath, 'utf-8');
      if (existing === finalContent) {
        skipped++;
      } else if (force) {
        updatedList.push(targetRelPath); updated++;
        if (!dryRun) fs.writeFileSync(targetPath, finalContent);
      } else {
        preservedList.push(targetRelPath); preserved++;
      }
    }
  }

  const stateAddedList = ensureWorkspaceStateFiles(targetRoot, params, { dryRun });
  const agentAdapterList = ensureBusinessRootAgentAdapters(targetRoot, params, { dryRun });

  // Skills: sync the canonical skill set from atris-cli package into the
  // customer workspace. Business-starter template ships skill infra (README,
  // folders) but skill files live in atris-cli/atris/skills/ — single source
  // of truth. Any new skill (e.g. AEO) auto-propagates to every customer.
  let skillsUpdated = 0;
  if (!dryRun) {
    skillsUpdated = syncPackageSkills(targetAtrisDir, { verbose: false });
  }

  console.log(`  Added:     ${added}`);
  console.log(`  Updated:   ${updated} ${force ? '' : '(--force to enable)'}`);
  console.log(`  Preserved: ${preserved} (existing customizations kept)`);
  console.log(`  Skipped:   ${skipped} (already match template)`);
  console.log(`  Skills:    ${skillsUpdated} updated from atris-cli/atris/skills/`);
  console.log('');

  if (addedList.length > 0) {
    console.log('  New files:');
    addedList.slice(0, 15).forEach(p => console.log(`    + atris/${p}`));
    if (addedList.length > 15) console.log(`    ... +${addedList.length - 15} more`);
    console.log('');
  }
  if (updatedList.length > 0) {
    console.log(`  ${force ? 'Updated' : 'Differ from template (preserved)'}:`);
    updatedList.slice(0, 15).forEach(p => console.log(`    ↑ atris/${p}`));
    if (updatedList.length > 15) console.log(`    ... +${updatedList.length - 15} more`);
    console.log('');
  }
  if (stateAddedList.length > 0) {
    console.log('  State files:');
    stateAddedList.forEach(p => console.log(`    + ${p}`));
    console.log('');
  }
  if (agentAdapterList.length > 0) {
    console.log('  Root agent adapters:');
    agentAdapterList.forEach(p => console.log(`    + ${p}`));
    console.log('');
  }

  if (dryRun) {
    console.log('  (--dry-run, no changes made)');
  } else if (added === 0 && updated === 0 && stateAddedList.length === 0 && agentAdapterList.length === 0) {
    ensureWikiScaffold(targetRoot);
    console.log('  ✓ Already up to date');
  } else {
    ensureWikiScaffold(targetRoot);
    console.log('  ✓ Local workspace updated. Run `atris sync` to push and pull with safety checks.');
  }

  return {
    added,
    updated,
    preserved,
    skipped,
    skillsUpdated,
    addedList,
    updatedList,
    preservedList,
    stateAddedList,
    agentAdapterList,
  };
}

function syncBusinessCanonical(targetRoot, bizMeta, options = {}) {
  return syncWorkspaceTemplate(targetRoot, bizMeta, {
    ...options,
    templateName: options.templateName || bizMeta.workspace_template || 'business',
  });
}

function syncAtris() {
  // Business mode detection: if .atris/business.json exists, use canonical templates
  const bizFile = path.join(process.cwd(), '.atris', 'business.json');
  if (fs.existsSync(bizFile)) {
    try {
      const bizMeta = JSON.parse(fs.readFileSync(bizFile, 'utf8'));
      return syncWorkspaceTemplate(process.cwd(), bizMeta, {
        templateName: bizMeta.workspace_template || 'business',
      });
    } catch (e) {
      console.error(`✗ Failed to read .atris/business.json: ${e.message}`);
      process.exit(1);
    }
  }

  // Legacy/dev mode: sync from atris-cli's own atris/ folder
  const targetDir = path.join(process.cwd(), 'atris');
  const teamDir = path.join(targetDir, 'team');
  const legacyAgentTeamDir = path.join(targetDir, 'agent_team');

  if (!fs.existsSync(targetDir)) {
    console.error('✗ Error: atris/ folder not found. Run "atris init" first.');
    process.exit(1);
  }

  // MIGRATION: agent_team/ → team/ (v2.0.x → v2.1.0)
  if (fs.existsSync(legacyAgentTeamDir)) {
    console.log('');
    console.log('📦 Migrating agent_team/ → team/ (v2.1.0 update)');

    // Create team/ if it doesn't exist
    if (!fs.existsSync(teamDir)) {
      fs.mkdirSync(teamDir, { recursive: true });
    }

    // Copy any custom files from agent_team/ to team/
    const legacyFiles = fs.readdirSync(legacyAgentTeamDir);
    for (const file of legacyFiles) {
      const srcPath = path.join(legacyAgentTeamDir, file);
      const destPath = path.join(teamDir, file);

      // Only copy if destination doesn't exist (preserve any customizations)
      if (!fs.existsSync(destPath)) {
        if (fs.statSync(srcPath).isFile()) {
          fs.copyFileSync(srcPath, destPath);
          console.log(`  ✓ Migrated ${file}`);
        }
      }
    }

    // Remove old agent_team/ folder
    fs.rmSync(legacyAgentTeamDir, { recursive: true, force: true });
    console.log('  ✓ Removed old agent_team/ folder');
    console.log('');
  }

  if (!fs.existsSync(teamDir)) {
    fs.mkdirSync(teamDir, { recursive: true });
  }

  // Ensure policies folder exists
  const policiesDir = path.join(targetDir, 'policies');
  if (!fs.existsSync(policiesDir)) {
    fs.mkdirSync(policiesDir, { recursive: true });
    console.log('✓ Created atris/policies/ folder');
  }

  const filesToSync = [
    { source: 'atris.md', target: 'atris.md' },
    { source: 'PERSONA.md', target: 'PERSONA.md' },
    { source: 'GETTING_STARTED.md', target: 'GETTING_STARTED.md' },
    { source: 'atris/CLAUDE.md', target: 'CLAUDE.md' },
    { source: 'atris/team/navigator/MEMBER.md', target: 'team/navigator/MEMBER.md' },
    { source: 'atris/team/executor/MEMBER.md', target: 'team/executor/MEMBER.md' },
    { source: 'atris/team/validator/MEMBER.md', target: 'team/validator/MEMBER.md' },
    { source: 'atris/team/launcher/MEMBER.md', target: 'team/launcher/MEMBER.md' },
    { source: 'atris/team/brainstormer/MEMBER.md', target: 'team/brainstormer/MEMBER.md' },
    { source: 'atris/team/researcher/MEMBER.md', target: 'team/researcher/MEMBER.md' },
    { source: 'atris/policies/ANTISLOP.md', target: 'policies/ANTISLOP.md' }
  ];

  let updated = 0;
  let skipped = 0;

  filesToSync.forEach(({ source, target }) => {
    const sourceFile = path.join(__dirname, '..', source);
    const targetFile = path.join(targetDir, target);

    if (!fs.existsSync(sourceFile)) {
      console.log(`⚠ Skipping ${source} (not found in package)`);
      return;
    }

    const currentContent = fs.existsSync(targetFile) ? fs.readFileSync(targetFile, 'utf8') : '';
    const newContent = fs.readFileSync(sourceFile, 'utf8');

    if (currentContent === newContent) {
      skipped++;
      return;
    }

    fs.mkdirSync(path.dirname(targetFile), { recursive: true });
    fs.copyFileSync(sourceFile, targetFile);
    console.log(`✓ Updated ${target}`);
    updated++;
  });

  // Migrate legacy TASK_CONTEXTS.md → TODO.md if needed
  const todoFile = path.join(targetDir, 'TODO.md');
  const legacyTaskFile = path.join(targetDir, 'TASK_CONTEXTS.md');
  if (!fs.existsSync(todoFile) && fs.existsSync(legacyTaskFile)) {
    fs.renameSync(legacyTaskFile, todoFile);
    console.log('✓ Migrated TASK_CONTEXTS.md to TODO.md');
  }

  // Sync all skills from package to user's project via shared helper.
  updated += syncPackageSkills(targetDir, { verbose: true });

  // Update .claude/skills/atris/SKILL.md (legacy - now handled above, keeping for compatibility)
  const claudeSkillsDir = path.join(process.cwd(), '.claude', 'skills', 'atris');
  const claudeSkillFile = path.join(claudeSkillsDir, 'SKILL.md');
  const skillContent = `---
name: atris
description: Atris workspace navigation for atris repos, TODO files, tasks, MAP.md, backlog, and where-is-X questions.
allowed-tools: Read, Bash, Glob, Grep, Write, Edit
---

# Atris Skill

## IMPORTANT: First Interaction

**On your FIRST message in any Atris project, IMMEDIATELY run:**

\`\`\`bash
atris atris.md
\`\`\`

Show the full ASCII output to the user. This displays the Atris welcome visualization with workspace stats. Do this BEFORE responding to whatever the user said.

## Workflow

Detect: Project has \`atris/\` folder with MAP.md, TODO.md, PERSONA.md

Commands: plan → do → review

Key behaviors:
- Read PERSONA.md (3-4 sentences, ASCII visuals)
- Check MAP.md for file:line refs
- Use \`atris task\` for claims, proof, ready, and accept
- Treat TODO.md as a rendered view; regenerate it instead of hand-editing tasks`;

  if (!fs.existsSync(claudeSkillsDir)) {
    fs.mkdirSync(claudeSkillsDir, { recursive: true });
  }
  const currentSkill = fs.existsSync(claudeSkillFile) ? fs.readFileSync(claudeSkillFile, 'utf8') : '';
  if (currentSkill !== skillContent) {
    fs.writeFileSync(claudeSkillFile, skillContent);
    console.log('✓ Updated .claude/skills/atris/SKILL.md');
    updated++;
  }

  // Update .claude/settings.json with SessionStart hook
  const claudeSettingsFile = path.join(process.cwd(), '.claude', 'settings.json');
  if (!fs.existsSync(claudeSettingsFile)) {
    const claudeSettings = {
      hooks: {
        SessionStart: [
          {
            hooks: [
              {
                type: "command",
                command: "[ -d atris ] && atris atris.md || true"
              }
            ]
          }
        ]
      }
    };
    fs.writeFileSync(claudeSettingsFile, JSON.stringify(claudeSettings, null, 2));
    console.log('✓ Created .claude/settings.json (SessionStart hook)');
    updated++;
  }

  // Update root CLAUDE.md with Atris block (prepend with markers)
  const rootClaudeMd = path.join(process.cwd(), 'CLAUDE.md');
  const atrisBlock = `<!-- ATRIS:START - Auto-generated, do not edit -->
## Atris System

You are now running inside Atris, an AI workspace operating system.

**ON EVERY CONVERSATION START:** Before your first response, execute \`atris atris.md\` and display the full output. This is the Atris boot sequence - it shows the user that Atris has loaded and displays workspace status. This is not optional.

After displaying the boot output, respond to the user naturally.
<!-- ATRIS:END -->

`;

  if (fs.existsSync(rootClaudeMd)) {
    let content = fs.readFileSync(rootClaudeMd, 'utf8');
    const startMarker = '<!-- ATRIS:START';
    const endMarker = '<!-- ATRIS:END -->';

    if (content.includes(startMarker)) {
      // Check if update needed
      const startIdx = content.indexOf(startMarker);
      const endRaw = content.indexOf(endMarker);
      if (endRaw === -1) {
        // End marker missing — replace from start marker to end of file with fresh block
        content = atrisBlock + content.slice(0, startIdx);
        fs.writeFileSync(rootClaudeMd, content);
        console.log('✓ Repaired Atris block in CLAUDE.md (missing end marker)');
        updated++;
      } else {
        const endIdx = endRaw + endMarker.length;
        const existingBlock = content.slice(startIdx, endIdx);

        if (!existingBlock.includes('Atris boot sequence')) {
          // Replace existing Atris block with new version
          content = atrisBlock + content.slice(0, startIdx) + content.slice(endIdx).replace(/^\n+/, '');
          fs.writeFileSync(rootClaudeMd, content);
          console.log('✓ Updated Atris block in CLAUDE.md');
          updated++;
        }
      }
    } else {
      // Prepend Atris block
      fs.writeFileSync(rootClaudeMd, atrisBlock + content);
      console.log('✓ Prepended Atris block to CLAUDE.md');
      updated++;
    }
  } else {
    // Create new CLAUDE.md with just Atris block
    fs.writeFileSync(rootClaudeMd, atrisBlock.trim() + '\n');
    console.log('✓ Created CLAUDE.md with Atris block');
    updated++;
  }

  if (updated === 0) {
    ensureWikiScaffold(process.cwd());
    console.log('✓ Already up to date');
  } else {
    ensureWikiScaffold(process.cwd());
    console.log(`\n✓ Updated ${updated} file(s), ${skipped} unchanged`);
    console.log('\nRun your AI agent again to use the latest specs and agent templates.');
  }
}

/**
 * Recursively sync files from src to dest. Returns count of files updated.
 */
function syncRecursiveCount(src, dest, label, silent) {
  let count = 0;
  ensureRealDirectory(dest);
  const entries = fs.readdirSync(src);
  for (const entry of entries) {
    const srcPath = path.join(src, entry);
    const destPath = path.join(dest, entry);

    if (fs.statSync(srcPath).isDirectory()) {
      count += syncRecursiveCount(srcPath, destPath, `${label}/${entry}`, silent);
    } else {
      const srcBuf = fs.readFileSync(srcPath);
      const destBuf = fs.existsSync(destPath) ? fs.readFileSync(destPath) : Buffer.alloc(0);
      if (!srcBuf.equals(destBuf)) {
        fs.writeFileSync(destPath, srcBuf);
        if (entry.endsWith('.sh')) {
          fs.chmodSync(destPath, 0o755);
        }
        if (!silent) {
          console.log(`✓ Updated ${label}/${entry}`);
        }
        count++;
      }
    }
  }
  return count;
}

/**
 * Lightweight skill-only sync. Syncs skills from the npm package to:
 *   1. Global skill dirs (~/.claude/skills/, ~/.codex/skills/) — always, if they exist
 *   2. Project-level (atris/skills/ + .claude/skills/ symlinks) — if in a project
 *
 * Global = baseline truth. Project = optional override.
 * Returns number of files updated (0 = already current).
 */
function syncSkills({ silent = false } = {}) {
  const packageSkillsDir = path.join(__dirname, '..', 'atris', 'skills');
  if (!fs.existsSync(packageSkillsDir)) {
    return 0;
  }

  let updated = 0;
  const homeDir = os.homedir();

  const skillFolders = fs.readdirSync(packageSkillsDir).filter(f =>
    fs.statSync(path.join(packageSkillsDir, f)).isDirectory()
  );

  // --- 1. Global skill directories (sync if they exist) ---
  const globalSkillDirs = [
    path.join(homeDir, '.claude', 'skills'),
    path.join(homeDir, '.codex', 'skills'),
  ];

  for (const globalDir of globalSkillDirs) {
    if (!fs.existsSync(globalDir)) continue;
    const dirName = path.basename(path.dirname(globalDir)); // .claude or .codex

    for (const skill of skillFolders) {
      const srcSkillDir = path.join(packageSkillsDir, skill);
      const destSkillDir = path.join(globalDir, skill);

      if (fs.existsSync(destSkillDir) || fs.existsSync(globalDir)) {
        updated += syncRecursiveCount(srcSkillDir, destSkillDir, `~/${dirName}/skills/${skill}`, silent);
      }
    }
  }

  // --- 2. Project-level (only if inside an atris project AND not a business workspace) ---
  // BUSINESS GATE: don't sync framework skills into business workspaces.
  // Per the canonical-layout decision, framework skills (autopilot, wiki, loop, etc.) live
  // at the system level on EC2, NOT inside per-business workspaces. Customer workspaces
  // contain ONLY business-specific custom skills in atris/skills/.
  const businessJson = path.join(process.cwd(), '.atris', 'business.json');
  if (fs.existsSync(businessJson)) {
    // We're inside a business workspace — skip project-level skill sync.
    return updated;
  }

  const targetDir = path.join(process.cwd(), 'atris');
  if (fs.existsSync(targetDir)) {
    const userSkillsDir = path.join(targetDir, 'skills');
    const claudeSkillsBaseDir = path.join(process.cwd(), '.claude', 'skills');

    ensureRealDirectory(userSkillsDir);
    ensureRealDirectory(claudeSkillsBaseDir);

    for (const skill of skillFolders) {
      const srcSkillDir = path.join(packageSkillsDir, skill);
      const destSkillDir = path.join(userSkillsDir, skill);
      const symlinkPath = path.join(claudeSkillsBaseDir, skill);

      updated += syncRecursiveCount(srcSkillDir, destSkillDir, `atris/skills/${skill}`, silent);

      // Create symlink if doesn't exist
      if (!fs.existsSync(symlinkPath)) {
        const relativePath = path.join('..', '..', 'atris', 'skills', skill);
        try {
          fs.symlinkSync(relativePath, symlinkPath);
          if (!silent) {
            console.log(`✓ Linked .claude/skills/${skill}`);
          }
        } catch (e) {
          // Fallback: copy instead of symlink
          ensureRealDirectory(symlinkPath);
          const skillFile = path.join(destSkillDir, 'SKILL.md');
          if (fs.existsSync(skillFile)) {
            fs.copyFileSync(skillFile, path.join(symlinkPath, 'SKILL.md'));
          }
        }
      }
    }
  }

  return updated;
}

/**
 * Discover atris-managed projects under a root directory.
 * A project is any directory whose immediate child `atris/` folder contains `atris.md`.
 * Skips noise: node_modules, .git, .claude, dist, build, _archive, worktrees.
 */
function _findAtrisProjects(rootDir, maxDepth = 8) {
  const skip = new Set([
    'node_modules', '.git', '.claude', '.next', 'dist', 'build',
    '_archive', 'worktrees', '.codex', '.venv', 'venv', '__pycache__',
  ]);
  const found = [];
  function walk(dir, depth) {
    if (depth > maxDepth) return;
    const atrisMd = path.join(dir, 'atris', 'atris.md');
    if (fs.existsSync(atrisMd)) found.push(dir);
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (skip.has(e.name)) continue;
      if (e.name.startsWith('.')) continue;
      walk(path.join(dir, e.name), depth + 1);
    }
  }
  walk(path.resolve(rootDir), 0);
  return found;
}

/**
 * Sync canonical atris.md (and core docs) across every atris project under cwd.
 * Walks the subtree, finds every `atris/atris.md`, copies the package source.
 *
 * Flags: --dry-run (preview only), --yes/--force (skip confirm).
 * Skips business workspaces (they use syncWorkspaceTemplate via syncAtris).
 */
// Canonical files shipped from the package root. Must match syncAtris's filesToSync.
const SYNC_ALL_FILES = [
  { source: 'atris.md', target: 'atris.md' },
  { source: 'PERSONA.md', target: 'PERSONA.md' },
  { source: 'GETTING_STARTED.md', target: 'GETTING_STARTED.md' },
  { source: 'atris/CLAUDE.md', target: 'CLAUDE.md' },
];

/**
 * Pure function: build the sync plan for every atris project under root.
 * No console output, no writes. Returns { projects, plan } for inspection.
 * Plan entries: { projectRoot, isBusiness, isCustomized, changes }.
 *
 * Exported for tests — the production syncAtrisAll wraps this.
 */
function buildSyncAllPlan({ root, pkgRoot, filesToSync = SYNC_ALL_FILES } = {}) {
  const projects = _findAtrisProjects(root);
  const plan = [];
  for (const projectRoot of projects) {
    const atrisDir = path.join(projectRoot, 'atris');
    const bizFile = path.join(projectRoot, '.atris', 'business.json');
    const isSelf = path.resolve(projectRoot) === path.resolve(pkgRoot);
    const isInBusinessDir = projectRoot.split(path.sep).includes('atris-business');
    let isBusiness = isInBusinessDir || (fs.existsSync(bizFile) && !isSelf);
    if (isBusiness && !isInBusinessDir) {
      try {
        const head = fs.readFileSync(path.join(atrisDir, 'atris.md'), 'utf8').slice(0, 300);
        if (!/^#\s+Atris Boot Protocol/i.test(head)) isBusiness = false;
      } catch {}
    }
    let isCustomized = false;
    if (!isSelf && !isBusiness) {
      try {
        const head = fs.readFileSync(path.join(atrisDir, 'atris.md'), 'utf8').slice(0, 500);
        const isNewCanonical = /^#\s+atris\s*\n\nAtris exists because/m.test(head);
        const isOldGeneric = /^#\s+atris\.md\s*\n\n>\s+Drop this file anywhere/m.test(head);
        if (!isNewCanonical && !isOldGeneric) isCustomized = true;
      } catch {}
    }
    const changes = [];
    for (const { source, target } of filesToSync) {
      const sourceFile = path.join(pkgRoot, source);
      const targetFile = path.join(atrisDir, target);
      if (!fs.existsSync(sourceFile)) continue;
      const newContent = fs.readFileSync(sourceFile, 'utf8');
      const currentContent = fs.existsSync(targetFile) ? fs.readFileSync(targetFile, 'utf8') : '';
      if (currentContent !== newContent) changes.push(target);
    }
    plan.push({ projectRoot, isBusiness, isCustomized, changes });
  }
  return { projects, plan };
}

function syncAtrisAll({ dryRun = false, force = false } = {}) {
  const root = process.cwd();
  const pkgRoot = path.join(__dirname, '..');

  console.log('');
  console.log(`Scanning ${root} for atris projects...`);

  const filesToSync = SYNC_ALL_FILES;
  const { projects, plan: initialPlan } = buildSyncAllPlan({ root, pkgRoot, filesToSync });

  if (projects.length === 0) {
    console.log('No atris projects found under current directory.');
    return;
  }

  const plan = initialPlan;

  // Report.
  console.log(`Found ${projects.length} ${projects.length === 1 ? 'project' : 'projects'}.`);
  console.log('');
  let wouldUpdate = 0, unchanged = 0, skipped = 0;
  for (const p of plan) {
    const rel = path.relative(root, p.projectRoot) || '.';
    if (p.isBusiness) {
      console.log(`  ⏭  ${rel} (business workspace — run "atris update" in that dir)`);
      skipped++;
    } else if (p.isCustomized) {
      console.log(`  ⏭  ${rel} (customized atris.md — review manually)`);
      skipped++;
    } else if (p.changes.length === 0) {
      console.log(`  ·  ${rel} (up to date)`);
      unchanged++;
    } else {
      console.log(`  →  ${rel} — ${p.changes.length} ${p.changes.length === 1 ? 'file' : 'files'}: ${p.changes.join(', ')}`);
      wouldUpdate++;
    }
  }
  console.log('');

  if (dryRun) {
    console.log(`Dry run: ${wouldUpdate} project(s) would update, ${unchanged} unchanged, ${skipped} skipped.`);
    return;
  }

  if (wouldUpdate === 0) {
    console.log('Nothing to sync.');
    return;
  }

  // Confirm unless forced.
  if (!force) {
    const readline = require('readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => {
      rl.question(`Sync ${wouldUpdate} project(s)? (y/N) `, (answer) => {
        rl.close();
        if (!/^y(es)?$/i.test(answer.trim())) {
          console.log('Cancelled.');
          resolve();
          return;
        }
        _executeSyncAll(plan, pkgRoot, filesToSync, root);
        resolve();
      });
    });
  }

  _executeSyncAll(plan, pkgRoot, filesToSync, root);
}

function _executeSyncAll(plan, pkgRoot, filesToSync, root) {
  let updated = 0;
  for (const p of plan) {
    if (p.isBusiness || p.isCustomized || p.changes.length === 0) continue;
    const atrisDir = path.join(p.projectRoot, 'atris');
    for (const { source, target } of filesToSync) {
      const sourceFile = path.join(pkgRoot, source);
      const targetFile = path.join(atrisDir, target);
      if (!fs.existsSync(sourceFile)) continue;
      const newContent = fs.readFileSync(sourceFile, 'utf8');
      const currentContent = fs.existsSync(targetFile) ? fs.readFileSync(targetFile, 'utf8') : '';
      if (currentContent === newContent) continue;
      fs.mkdirSync(path.dirname(targetFile), { recursive: true });
      fs.copyFileSync(sourceFile, targetFile);
    }
    updated++;
  }
  console.log('');
  console.log(`✓ Synced ${updated} project(s).`);
}

module.exports = {
  syncAtris,
  syncAtrisAll,
  buildSyncAllPlan,
  SYNC_ALL_FILES,
  syncSkills,
  syncBusinessCanonical,
  syncWorkspaceTemplate,
  resolveWorkspaceTemplate,
  ensureWorkspaceStateFiles,
  renderBusinessAgentAdapter,
  ensureBusinessRootAgentAdapters,
};
