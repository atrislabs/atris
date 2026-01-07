const fs = require('fs');
const path = require('path');

function syncAtris() {
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
    { source: 'atris/team/navigator.md', target: 'team/navigator.md' },
    { source: 'atris/team/executor.md', target: 'team/executor.md' },
    { source: 'atris/team/validator.md', target: 'team/validator.md' },
    { source: 'atris/team/launcher.md', target: 'team/launcher.md' },
    { source: 'atris/team/brainstormer.md', target: 'team/brainstormer.md' },
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
          if (fs.existsSync(destSkillFile)) {
            fs.copyFileSync(destSkillFile, path.join(symlinkPath, 'SKILL.md'));
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
      const endIdx = content.indexOf(endMarker) + endMarker.length;
      const existingBlock = content.slice(startIdx, endIdx);
      const newBlockTrimmed = atrisBlock.trim().slice(0, -1); // Remove trailing newline for comparison

      if (!existingBlock.includes('Atris boot sequence')) {
        // Replace existing Atris block with new version
        content = atrisBlock + content.slice(0, startIdx) + content.slice(endIdx).replace(/^\n+/, '');
        fs.writeFileSync(rootClaudeMd, content);
        console.log('✓ Updated Atris block in CLAUDE.md');
        updated++;
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
    console.log('✓ Already up to date');
  } else {
    console.log(`\n✓ Updated ${updated} file(s), ${skipped} unchanged`);
    console.log('\nRun your AI agent again to use the latest specs and agent templates.');
  }
}

module.exports = { syncAtris };
