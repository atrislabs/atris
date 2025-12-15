const fs = require('fs');
const path = require('path');

function syncAtris() {
  const targetDir = path.join(process.cwd(), 'atris');
  const agentTeamDir = path.join(targetDir, 'agent_team');

  if (!fs.existsSync(targetDir)) {
    console.error('✗ Error: atris/ folder not found. Run "atris init" first.');
    process.exit(1);
  }

  if (!fs.existsSync(agentTeamDir)) {
    fs.mkdirSync(agentTeamDir, { recursive: true });
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
    { source: 'atris/agent_team/navigator.md', target: 'agent_team/navigator.md' },
    { source: 'atris/agent_team/executor.md', target: 'agent_team/executor.md' },
    { source: 'atris/agent_team/validator.md', target: 'agent_team/validator.md' },
    { source: 'atris/agent_team/launcher.md', target: 'agent_team/launcher.md' },
    { source: 'atris/agent_team/brainstormer.md', target: 'agent_team/brainstormer.md' },
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

  // Update .claude/skills/atris/SKILL.md
  const claudeSkillsDir = path.join(process.cwd(), '.claude', 'skills', 'atris');
  const claudeSkillFile = path.join(claudeSkillsDir, 'SKILL.md');
  const skillContent = `---
name: atris
description: ATRIS workspace navigation. Triggers on: atris, TODO, tasks, MAP.md, backlog, "where is X?"
allowed-tools: Read, Bash, Glob, Grep, Write, Edit
---

# ATRIS Skill

## IMPORTANT: First Interaction

**On your FIRST message in any ATRIS project, IMMEDIATELY run:**

\`\`\`bash
atris atris.md
\`\`\`

Show the full ASCII output to the user. This displays the ATRIS welcome visualization with workspace stats. Do this BEFORE responding to whatever the user said.

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

  if (updated === 0) {
    console.log('✓ Already up to date');
  } else {
    console.log(`\n✓ Updated ${updated} file(s), ${skipped} unchanged`);
    console.log('\nRun your AI agent again to use the latest specs and agent templates.');
  }
}

module.exports = { syncAtris };
