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
    .replace(/\{\{workspace_template\}\}/g, params.workspace_template || 'business');
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
    const templatePath = path.join(template.dir, relPath);
    const targetPath = path.join(targetAtrisDir, relPath);
    let templateContent;
    try { templateContent = fs.readFileSync(templatePath, 'utf-8'); } catch { continue; }
    const finalContent = _substituteParams(templateContent, params);

    if (!fs.existsSync(targetPath)) {
      addedList.push(relPath); added++;
      if (!dryRun) {
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        fs.writeFileSync(targetPath, finalContent);
      }
    } else {
      const existing = fs.readFileSync(targetPath, 'utf-8');
      if (existing === finalContent) {
        skipped++;
      } else if (force) {
        updatedList.push(relPath); updated++;
        if (!dryRun) fs.writeFileSync(targetPath, finalContent);
      } else {
        preservedList.push(relPath); preserved++;
      }
    }
  }

  console.log(`  Added:     ${added}`);
  console.log(`  Updated:   ${updated} ${force ? '' : '(--force to enable)'}`);
  console.log(`  Preserved: ${preserved} (existing customizations kept)`);
  console.log(`  Skipped:   ${skipped} (already match template)`);
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

  if (dryRun) {
    console.log('  (--dry-run, no changes made)');
  } else if (added === 0 && updated === 0) {
    ensureWikiScaffold(targetRoot);
    console.log('  ✓ Already up to date');
  } else {
    ensureWikiScaffold(targetRoot);
    console.log(`  ✓ Local workspace updated. Run \`atris align ${params.slug} --fix\` to push to EC2.`);
  }
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
    { source: 'atris/atrisDev.md', target: 'atrisDev.md' },
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

  // Sync all skills from package to user's project
  const packageSkillsDir = path.join(__dirname, '..', 'atris', 'skills');
  const userSkillsDir = path.join(targetDir, 'skills');
  const claudeSkillsBaseDir = path.join(process.cwd(), '.claude', 'skills');

  if (fs.existsSync(packageSkillsDir)) {
    // Ensure directories exist
    if (!fs.existsSync(userSkillsDir)) {
      fs.mkdirSync(userSkillsDir, { recursive: true });
    }
    if (!fs.existsSync(claudeSkillsBaseDir)) {
      fs.mkdirSync(claudeSkillsBaseDir, { recursive: true });
    }

    // Get all skill folders from package
    const skillFolders = fs.readdirSync(packageSkillsDir).filter(f => {
      const skillPath = path.join(packageSkillsDir, f);
      return fs.statSync(skillPath).isDirectory();
    });

    for (const skill of skillFolders) {
      const srcSkillDir = path.join(packageSkillsDir, skill);
      const destSkillDir = path.join(userSkillsDir, skill);
      const symlinkPath = path.join(claudeSkillsBaseDir, skill);

      // Recursive sync function for skills (handles subdirs like hooks/)
      const syncRecursive = (src, dest, skillName, basePath = '') => {
        if (!fs.existsSync(dest)) {
          fs.mkdirSync(dest, { recursive: true });
        }
        const entries = fs.readdirSync(src);
        for (const entry of entries) {
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
              // Preserve executable permission for shell scripts
              if (entry.endsWith('.sh')) {
                fs.chmodSync(destPath, 0o755);
              }
              console.log(`✓ Updated atris/skills/${skillName}/${relPath}`);
              updated++;
            }
          }
        }
      };

      syncRecursive(srcSkillDir, destSkillDir, skill);

      // Create symlink if doesn't exist
      if (!fs.existsSync(symlinkPath)) {
        const relativePath = path.join('..', '..', 'atris', 'skills', skill);
        try {
          fs.symlinkSync(relativePath, symlinkPath);
          console.log(`✓ Linked .claude/skills/${skill}`);
        } catch (e) {
          // Fallback: copy instead of symlink
          fs.mkdirSync(symlinkPath, { recursive: true });
          const skillFile = path.join(destSkillDir, 'SKILL.md');
          if (fs.existsSync(skillFile)) {
            fs.copyFileSync(skillFile, path.join(symlinkPath, 'SKILL.md'));
          }
          console.log(`✓ Copied .claude/skills/${skill} (symlink failed)`);
        }
      }
    }
  }

  // Update .claude/skills/atris/SKILL.md (legacy - now handled above, keeping for compatibility)
  const claudeSkillsDir = path.join(process.cwd(), '.claude', 'skills', 'atris');
  const claudeSkillFile = path.join(claudeSkillsDir, 'SKILL.md');
  const skillContent = `---
name: atris
description: Atris workspace navigation. Triggers on: atris, TODO, tasks, MAP.md, backlog, "where is X?"
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
- Update TODO.md (claim tasks, delete when done)`;

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
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }
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

    if (!fs.existsSync(userSkillsDir)) {
      fs.mkdirSync(userSkillsDir, { recursive: true });
    }
    if (!fs.existsSync(claudeSkillsBaseDir)) {
      fs.mkdirSync(claudeSkillsBaseDir, { recursive: true });
    }

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
          fs.mkdirSync(symlinkPath, { recursive: true });
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

module.exports = {
  syncAtris,
  syncSkills,
  syncBusinessCanonical,
  syncWorkspaceTemplate,
  resolveWorkspaceTemplate,
};
