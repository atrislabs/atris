const fs = require('fs');
const path = require('path');
const { ensureExperimentsFramework } = require('./experiments');
const { ensureWikiScaffold } = require('../lib/wiki');

/**
 * Detect project context by scanning project structure
 * @param {string} projectRoot - Root directory of the project
 * @returns {Object} Detected project context
 */
function detectProjectContext(projectRoot = process.cwd()) {
  const detected = {
    type: 'unknown',
    framework: 'none',
    hasCode: false,
    testCommand: 'none',
    fileStructure: [],
    conventions: {}
  };

  // Check for package files
  const packageFiles = {
    'package.json': 'nodejs',
    'requirements.txt': 'python',
    'pyproject.toml': 'python',
    'Gemfile': 'ruby',
    'go.mod': 'go',
    'Cargo.toml': 'rust',
    'pom.xml': 'java',
    'composer.json': 'php',
    'mix.exs': 'elixir',
    'dub.json': 'd',
    'Podfile': 'ios'
  };

  // Detect primary type from package files
  for (const [file, type] of Object.entries(packageFiles)) {
    if (fs.existsSync(path.join(projectRoot, file))) {
      detected.type = type;
      detected.hasCode = true;
      break;
    }
  }

  // Check for framework indicators
  const frameworks = {
    'package.json': () => {
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        // Check meta-frameworks first (they include base frameworks as deps)
        if (deps.next) return 'next';
        if (deps.nuxt) return 'nuxt';
        if (deps.angular || deps['@angular/core']) return 'angular';
        // Then base frameworks
        if (deps.react || deps['react-dom']) return 'react';
        if (deps.vue) return 'vue';
        if (deps['express']) return 'express';
        if (deps['fastify']) return 'fastify';
        return 'nodejs';
      } catch (e) {
        return 'nodejs';
      }
    },
    'requirements.txt': () => {
      try {
        const req = fs.readFileSync(path.join(projectRoot, 'requirements.txt'), 'utf8');
        if (req.includes('django')) return 'django';
        if (req.includes('flask')) return 'flask';
        if (req.includes('fastapi')) return 'fastapi';
        return 'python';
      } catch (e) {
        return 'python';
      }
    },
    'Gemfile': () => {
      try {
        const gemfile = fs.readFileSync(path.join(projectRoot, 'Gemfile'), 'utf8');
        if (gemfile.includes('rails')) return 'rails';
        if (gemfile.includes('sinatra')) return 'sinatra';
        return 'ruby';
      } catch (e) {
        return 'ruby';
      }
    }
  };

  // Detect framework if we found a package file
  if (detected.type !== 'unknown') {
    const frameworkDetector = frameworks[Object.keys(packageFiles).find(f => 
      fs.existsSync(path.join(projectRoot, f)) && packageFiles[f] === detected.type
    )];
    if (frameworkDetector) {
      detected.framework = frameworkDetector();
    } else {
      detected.framework = detected.type;
    }
  }

  // Check for file structure
  const dirs = ['src', 'app', 'lib', 'docs', 'config', 'test', 'tests', '__tests__', 'spec'];
  for (const dir of dirs) {
    const dirPath = path.join(projectRoot, dir);
    if (fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory()) {
      detected.fileStructure.push(dir + '/');
    }
  }

  // Detect test command based on type
  const testCommands = {
    'nodejs': 'npm test',
    'python': 'pytest',
    'ruby': 'rspec',
    'go': 'go test ./...',
    'rust': 'cargo test',
    'java': 'mvn test',
    'php': 'phpunit',
    'elixir': 'mix test'
  };
  if (detected.type !== 'unknown' && testCommands[detected.type]) {
    detected.testCommand = testCommands[detected.type];
  }

  // Check if it's a knowledge base (only markdown files, no code)
  if (detected.type === 'unknown' && detected.fileStructure.length === 0) {
    const files = fs.readdirSync(projectRoot);
    const hasCodeFiles = files.some(f => {
      const ext = path.extname(f);
      return ['.js', '.ts', '.py', '.rb', '.go', '.rs', '.java', '.php', '.tsx', '.jsx', '.vue'].includes(ext);
    });
    const hasMdFiles = files.some(f => path.extname(f) === '.md');
    
    if (!hasCodeFiles && hasMdFiles) {
      detected.type = 'knowledge-base';
      detected.hasCode = false;
      detected.testCommand = 'none';
      detected.framework = 'none';
    }
  }

  // Check for test directories to confirm test command
  const testDirs = ['test', 'tests', '__tests__', 'spec'];
  const hasTestDir = testDirs.some(dir => 
    fs.existsSync(path.join(projectRoot, dir)) && 
    fs.statSync(path.join(projectRoot, dir)).isDirectory()
  );
  
  // If no test dir and we're a codebase, testCommand might be custom
  if (!hasTestDir && detected.hasCode && detected.testCommand !== 'none') {
    // Keep detected test command but note it might be custom
  }

  return detected;
}

/**
 * Inject project-specific patterns into agent specs
 * @param {string} agentTeamDir - Directory containing team specs
 * @param {Object} profile - Project profile from detectProjectContext()
 */
function injectProjectPatterns(agentTeamDir, profile) {
  const executorFile = path.join(agentTeamDir, 'executor', 'MEMBER.md');
  const navigatorFile = path.join(agentTeamDir, 'navigator', 'MEMBER.md');
  const validatorFile = path.join(agentTeamDir, 'validator', 'MEMBER.md');

  // Inject into executor.md
  if (fs.existsSync(executorFile)) {
    let executorContent = fs.readFileSync(executorFile, 'utf8');
    
    // Add project-specific test command section
    const testSection = `## Project Context

This is a **${profile.type}** project${profile.framework !== 'none' ? ` using **${profile.framework}**` : ''}.

**Test Command:** ${profile.hasCode ? `\`${profile.testCommand}\`` : 'None (knowledge base)'}

${profile.hasCode ? `**Validation:** Run \`${profile.testCommand}\` before marking tasks complete.` : '**Validation:** Ensure markdown structure and formatting is correct. No code execution needed.'}

**File Structure:** ${profile.fileStructure.length > 0 ? profile.fileStructure.join(', ') : 'Standard project structure'}

---

`;
    
    // Insert after the Activation Prompt section
    if (executorContent.includes('---\n\n## Workflow')) {
      executorContent = executorContent.replace('---\n\n## Workflow', `${testSection}## Workflow`);
      fs.writeFileSync(executorFile, executorContent);
    }
  }

  // Inject into navigator.md
  if (fs.existsSync(navigatorFile)) {
    let navigatorContent = fs.readFileSync(navigatorFile, 'utf8');
    
    const projectNote = `## Project Context

**Project Type:** ${profile.type}${profile.framework !== 'none' ? ` (${profile.framework})` : ''}

**Structure:** ${profile.fileStructure.length > 0 ? profile.fileStructure.join(', ') : 'Standard structure'}

When planning tasks, consider the project structure and conventions above.

---

`;
    
    if (navigatorContent.includes('---\n\n## Workflow')) {
      navigatorContent = navigatorContent.replace('---\n\n## Workflow', `${projectNote}## Workflow`);
      fs.writeFileSync(navigatorFile, navigatorContent);
    }
  }

  // Inject into validator.md
  if (fs.existsSync(validatorFile)) {
    let validatorContent = fs.readFileSync(validatorFile, 'utf8');
    
    const validationNote = `## Project Context

**Project Type:** ${profile.type}${profile.framework !== 'none' ? ` (${profile.framework})` : ''}

${profile.hasCode ? `**Validation:** Run \`${profile.testCommand}\` to verify changes work correctly.` : '**Validation:** Verify markdown formatting, structure, and completeness. No code execution needed.'}

---

`;
    
    if (validatorContent.includes('---\n\n## ')) {
      validatorContent = validatorContent.replace('---\n\n## ', `${validationNote}## `);
      fs.writeFileSync(validatorFile, validatorContent);
    }
  }
}

function initAtris() {
  // Print usage on -h / --help / help instead of running init (which scaffolds
  // many files, including atris/now.md and atris/team/). Asking for help
  // shouldn't have file-system side effects.
  const args = process.argv.slice(3);
  if (args[0] === '-h' || args[0] === '--help' || args[0] === 'help') {
    console.log('Usage: atris init [--force]');
    console.log('');
    console.log('  Scaffold the atris/ workspace in the current directory.');
    console.log('  Refuses to run inside an existing atris/ folder unless --force is passed.');
    return;
  }
  // GUARD: Refuse nested init.
  // Bug: running `atris init` inside an existing `atris/` folder creates
  // `atris/atris/` nesting hell. Cloud doordash had this exact problem.
  // Fix: detect three nesting conditions and refuse with a clear error.
  const cwd = process.cwd();
  const cwdBase = path.basename(cwd);
  const force = process.argv.includes('--force');

  if (cwdBase === 'atris' && !force) {
    console.error('✗ Cannot run atris init inside an atris/ directory.');
    console.error('  You appear to be inside the atris/ folder of an existing workspace.');
    console.error('  Run init from the parent directory, or use --force to proceed anyway.');
    process.exit(1);
  }

  // Check cwd itself for .atris/business.json — already a business workspace
  const cwdBusinessJson = path.join(cwd, '.atris', 'business.json');
  if (fs.existsSync(cwdBusinessJson) && !force) {
    console.error('✗ This directory is already a business workspace (found .atris/business.json).');
    console.error('  To update canonical files: atris update');
    console.error('  To re-init anyway: atris init --force');
    process.exit(1);
  }

  // Walk up to 6 parent dirs looking for an .atris/business.json — if found, we're inside a workspace
  let walker = path.dirname(cwd);
  for (let depth = 0; depth < 6; depth++) {
    const businessJson = path.join(walker, '.atris', 'business.json');
    if (fs.existsSync(businessJson)) {
      if (!force) {
        console.error(`✗ Cannot run atris init: parent directory ${walker} is already an atris workspace.`);
        console.error('  Found .atris/business.json in a parent directory.');
        console.error('  Run init from outside the workspace, or use --force to proceed anyway.');
        process.exit(1);
      }
    }
    const parent = path.dirname(walker);
    if (parent === walker) break;
    walker = parent;
  }

  const targetDir = path.join(cwd, 'atris');
  const teamDir = path.join(targetDir, 'team');
  const legacyAgentTeamDir = path.join(targetDir, 'agent_team');
  const sourceFile = path.join(__dirname, '..', 'atris.md');
  const targetFile = path.join(targetDir, 'atris.md');

  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
    console.log('✓ Created atris/ folder');
  } else {
    console.log('✓ atris/ folder already exists');
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
    console.log('✓ Created atris/team/ folder');
  }

  const gettingStartedFile = path.join(targetDir, 'GETTING_STARTED.md');
  const personaFile = path.join(targetDir, 'PERSONA.md');
  const mapFile = path.join(targetDir, 'MAP.md');
  const todoFile = path.join(targetDir, 'TODO.md');
  const navigatorFile = path.join(teamDir, 'navigator.md');
  const executorFile = path.join(teamDir, 'executor.md');
  const validatorFile = path.join(teamDir, 'validator.md');
  const launcherFile = path.join(teamDir, 'launcher.md');
  const brainstormerFile = path.join(teamDir, 'brainstormer.md');

  const gettingStartedSource = path.join(__dirname, '..', 'GETTING_STARTED.md');
  const personaSource = path.join(__dirname, '..', 'PERSONA.md');

  if (!fs.existsSync(gettingStartedFile) && fs.existsSync(gettingStartedSource)) {
    fs.copyFileSync(gettingStartedSource, gettingStartedFile);
    console.log('✓ Created GETTING_STARTED.md');
  }

  if (!fs.existsSync(personaFile) && fs.existsSync(personaSource)) {
    fs.copyFileSync(personaSource, personaFile);
    console.log('✓ Created PERSONA.md');
  }

  const wikiDir = path.join(targetDir, 'wiki');
  const wikiAlreadyExists = fs.existsSync(wikiDir);
  ensureWikiScaffold(process.cwd());
  if (!wikiAlreadyExists) {
    console.log('✓ Created wiki/ scaffold');
  }

  if (!fs.existsSync(mapFile)) {
    fs.writeFileSync(mapFile, '# MAP.md\n\n> Generated by your AI agent after reading atris.md\n\nRun your AI agent with atris.md to populate this file.\n');
    console.log('✓ Created MAP.md placeholder');
  }

  // Create INTUITION.md - captures learnings, preferences, dead ends
  const intuitionFile = path.join(targetDir, 'INTUITION.md');
  if (!fs.existsSync(intuitionFile)) {
    fs.writeFileSync(intuitionFile, `# INTUITION.md

> Accumulated learnings. Read before major decisions. Update after discoveries.

---

## Tripwires

*Things that seem obvious but break unexpectedly. Check these first when debugging.*

- (none yet — add when you hit surprising failures)

---

## Preferences

*Patterns this codebase prefers. Follow these over generic best practices.*

- (none yet — add as you discover the codebase style)

---

## Dead Ends

*Approaches tried and abandoned. Don't retry without new information.*

- (none yet — log failed approaches so future agents skip them)

---
`);
    console.log('✓ Created INTUITION.md');
  }

  if (!fs.existsSync(todoFile)) {
    fs.writeFileSync(todoFile, `# TODO.md

> Working task queue for this project. Target state = 0.
> Note: Daily tasks live in \`atris/logs/YYYY/YYYY-MM-DD.md\`

---

## Backlog

(See today's journal)

---

## In Progress

(See today's journal)

---

## Completed

(Validator deletes after verification)

---
`);
    console.log('✓ Created TODO.md placeholder');
  }

  const nowFile = path.join(targetDir, 'now.md');
  if (!fs.existsSync(nowFile)) {
    const { renderDefaultNow } = require('./now');
    fs.writeFileSync(nowFile, renderDefaultNow(cwd), 'utf8');
    console.log('✓ Created now.md');
  }

  // Create lessons.md (feedback loop for learning across features)
  const lessonsFile = path.join(targetDir, 'lessons.md');
  if (!fs.existsSync(lessonsFile)) {
    fs.writeFileSync(lessonsFile, `# lessons.md — What We Learned

> Append-only. One line per lesson. Harvested by validator after every feature.

---

`);
    console.log('✓ Created lessons.md');
  }

  // Create logs directory and today's journal with bootstrap tasks
  const logsDir = path.join(targetDir, 'logs');
  const yearDir = path.join(logsDir, new Date().getFullYear().toString());
  const today = new Date().toISOString().split('T')[0];
  const journalFile = path.join(yearDir, `${today}.md`);

  if (!fs.existsSync(yearDir)) {
    fs.mkdirSync(yearDir, { recursive: true });
    console.log(`✓ Created logs/${new Date().getFullYear()}/ folder`);
  }

  if (!fs.existsSync(journalFile)) {
    fs.writeFileSync(journalFile, `# Log — ${today}

## Completed ✅

---

## In Progress 🔄

---

## Backlog

- **T1:** Generate MAP.md — scan codebase, create navigation index with file:line refs

---

## Notes

**Bootstrap:** Say "atris next" to start. After MAP.md is generated, system will brainstorm ideas for your first build.

---

## Inbox

`);
    console.log(`✓ Created today's journal with bootstrap tasks`);
  }

  // Create features directory and README
  const featuresDir = path.join(targetDir, 'features');
  const templatesDir = path.join(featuresDir, '_templates');
  
  if (!fs.existsSync(featuresDir)) {
    fs.mkdirSync(featuresDir, { recursive: true });
    const featuresReadme = path.join(featuresDir, 'README.md');
    fs.writeFileSync(featuresReadme, '# Features\n\nThis directory tracks all features built using the atrisDev protocol.\n\nEach feature has:\n- `[feature-name]/idea.md` - Problem, solution, diagrams, success criteria\n- `[feature-name]/build.md` - Implementation plan, files changed, testing\n- `[feature-name]/validate.md` - End-to-end simulation script\n\n---\n\n## Features Built\n\n*Features will appear here as you build them.*\n');
    console.log('✓ Created features/ directory with README');
  }

  // Create feature templates (idea/build/validate)
  if (!fs.existsSync(templatesDir)) {
    fs.mkdirSync(templatesDir, { recursive: true });
  }

  const templateSpecs = [
    {
      name: 'idea.md.template',
      fallback: `# [Feature Name]\n\n> **Status:** planning | in-progress | complete\n> **Created:** YYYY-MM-DD\n> **Last Updated:** YYYY-MM-DD\n\n---\n\n## Problem Statement\n\n(2-3 sentences)\n\n---\n\n## Solution Design\n\n(3-4 sentences)\n\n---\n\n## ASCII Visualization\n\n\`\`\`\n[diagram]\n\`\`\`\n\n---\n\n## Success Criteria\n\n- [ ] Criterion 1\n- [ ] Criterion 2\n`,
    },
    {
      name: 'build.md.template',
      fallback: `# [Feature Name] — Build Plan\n\n> **For Executor Agent** — Follow these steps exactly.\n\n---\n\n## Overview\n\n(1-2 sentences)\n\n---\n\n## Files Touched\n\n**Created:**\n- \`path/to/new/file\` — Why\n\n**Modified:**\n- \`path/to/existing/file\` — What changes\n\n---\n\n## Build Steps\n\n### Step 1: [Action]\n\n**File:** \`path/to/file\`\n\n**What to do:**\n- Specific instruction\n\n**Validation:**\n- How to verify\n`,
    },
    {
      name: 'validate.md.template',
      fallback: `# Validation — [Feature Name]\n\n> **Role:** System Validation Script\n> **Executor:** Validator Agent\n> **Instructions:** Run these steps sequentially. If ANY step fails, the feature is broken.\n\n---\n\n## 1. Environment Check\n- [ ] **Pre-flight:**\n  - Command: \`npm test\` (or relevant)\n  - Expect: No errors\n\n## 2. Simulation Steps (The \"Real\" Test)\n\n### Step 1: [Name]\n- **Action:** [Exact command]\n- **Expect:** [Exact output regex]\n\n---\n\n**Status:** [Pending | Verified]\n`,
    },
  ];

  templateSpecs.forEach(({ name, fallback }) => {
    const target = path.join(templatesDir, name);
    if (fs.existsSync(target)) {
      return;
    }

    const source = path.join(__dirname, '..', 'atris', 'features', '_templates', name);
    if (fs.existsSync(source)) {
      fs.copyFileSync(source, target);
      console.log(`✓ Created features/_templates/${name}`);
      return;
    }

    fs.writeFileSync(target, fallback);
    console.log(`✓ Created features/_templates/${name} (fallback)`);
  });

  // Create experiments directory and packaged validation harness
  ensureExperimentsFramework(process.cwd(), { silent: false });


  // Copy team members (MEMBER.md format — directory per member with skills/tools/context)
  const members = ['navigator', 'executor', 'validator', 'launcher', 'brainstormer', 'researcher'];
  members.forEach(name => {
    const sourceFile = path.join(__dirname, '..', 'atris', 'team', name, 'MEMBER.md');
    const targetMemberDir = path.join(teamDir, name);
    const targetFile = path.join(targetMemberDir, 'MEMBER.md');
    const legacyFile = path.join(teamDir, `${name}.md`);

    // Skip if already exists (either format)
    if (fs.existsSync(targetFile) || fs.existsSync(legacyFile)) return;

    if (fs.existsSync(sourceFile)) {
      fs.mkdirSync(targetMemberDir, { recursive: true });
      fs.mkdirSync(path.join(targetMemberDir, 'skills'), { recursive: true });
      fs.mkdirSync(path.join(targetMemberDir, 'tools'), { recursive: true });
      fs.mkdirSync(path.join(targetMemberDir, 'context'), { recursive: true });
      fs.copyFileSync(sourceFile, targetFile);
      console.log(`✓ Created team/${name}/ (MEMBER.md + skills/ + tools/ + context/)`);
    }
  });

  // Copy MEMBER.md template for creating custom members
  const templateSourceDir = path.join(__dirname, '..', 'atris', 'team', '_template');
  const templateTargetDir = path.join(teamDir, '_template');
  if (!fs.existsSync(templateTargetDir)) {
    fs.mkdirSync(templateTargetDir, { recursive: true });
    const templateContent = `---
name: template-member
role: Replace with role title
description: Replace with one-line description of what this member does.
version: 1.0.0

skills: []

permissions:
  can-read: true
  approval-required: []

tools: []
---

# Insert persona, workflow, and rules below
`;
    fs.writeFileSync(path.join(templateTargetDir, 'MEMBER.md'), templateContent);
    console.log('✓ Created team/_template/MEMBER.md');
  }

  // Detect project context and generate profile
  const profile = detectProjectContext(process.cwd());
  const profileFile = path.join(targetDir, '.project-profile.json');
  fs.writeFileSync(profileFile, JSON.stringify(profile, null, 2));
  console.log(`✓ Generated .project-profile.json (detected: ${profile.type}${profile.framework !== 'none' ? '/' + profile.framework : ''})`);

  // Inject project patterns into agent specs
  injectProjectPatterns(teamDir, profile);
  console.log('✓ Injected project patterns into team specs');

  // Create agent instruction files for different tools
  const agentInstructions = `# AGENTS.md — Universal Agent Instructions

> Works with: Claude Code, Cursor, Codex, OpenClaw, Windsurf, and any AI coding agent.

## FIRST MESSAGE — Boot Sequence

**Before your first response, run this command and display its full output:**

\`\`\`bash
atris atris.md
\`\`\`

This is the Atris boot sequence. Show the output to the user, then respond naturally.
If the user did not provide a concrete task, run \`atris 0-shot --prompt\` and follow the handoff before picking work; if you know your tier, run \`atris 0-shot --model fast|pro|validator|human --prompt\`. Use \`atris 0-shot --json\` when you need structured route metadata.
Ambient agents may read \`.atris/state/zero-shot.prompt.txt\` or a tier prompt (\`.atris/state/zero-shot.fast.prompt.txt\`, \`.atris/state/zero-shot.pro.prompt.txt\`, \`.atris/state/zero-shot.validator.prompt.txt\`, \`.atris/state/zero-shot.human.prompt.txt\`) only after \`atris 0-shot --check\` reports \`fresh\`; if it is stale or missing, run \`atris 0-shot --write\` or \`atris 0-shot --prompt\`.

## Core Files

Atris is the source of truth. This file is only an adapter for tools that read
\`AGENTS.md\`; do not turn it into a parallel brain. Durable policy, workflow,
task truth, proof, review, and backend/cloud sync all flow through Atris.

| File | Purpose |
|------|---------|
| \`atris/atris.md\` | Protocol/backbone for this workspace |
| \`atris/PERSONA.md\` | Communication style (read first) |
| \`atris task\` | Current tasks, claims, dialogue, proof |
| \`.atris/state/tasks.projection.json\` | Readable task projection for UIs/agents |
| \`atris/TODO.md\` | Rendered/legacy task view only |
| \`atris/MAP.md\` | Navigation (where is X?) |

## Agent Contract

Every agent should leave four artifacts another agent can trust:

| Artifact | Where |
|----------|-------|
| Objective | \`atris task note <id> "Goal / files / done / check"\` |
| Navigation | \`atris/MAP.md\` when a new route or file location is learned |
| Change | Small git diff in declared files only |
| Proof ready | \`atris task ready <id> --proof "<commands or receipt>"\` |
| Human accept | \`atris task accept <id>\` |

Do not rely on chat context. Put the task, file pointers, and proof on disk.
Do not write new operating doctrine here first; add it to Atris policy, skills,
wiki, or \`atris/atris.md\`, then regenerate this adapter if needed.

Native goals and task approval are separate gates:

\`\`\`text
Agent proof ready -> native goal can complete
Human accept      -> task Done + AgentXP awarded
\`\`\`

Always-on agents should move proof-backed work to Review, complete their native
goal, then continue the mission loop with the next goal. They must not run
\`atris task accept\` or claim AgentXP unless a human approved the proof.

## Workflow

\`\`\`
PLAN  → atris plan   (break ideas into tasks)
BUILD → atris do     (execute tasks)
CHECK → atris review (verify + cleanup)
\`\`\`

## Mission Autonomy

Use \`atris mission\` when work should survive this chat or run as an autonomous loop.

\`\`\`
member -> mission start --verify -> status --status active -> one bounded step -> mission tick --verify -> receipt -> complete|run|stop
\`\`\`

- Start current-agent work: \`atris mission start "<objective>" --owner <member> --runner codex_goal --lane code --verify "<cmd>" --stop "<condition>"\`
- Start headless Claude work: add \`--runner claude --cadence "15m" --always-on\`, then use \`atris mission run <id> --max-ticks 4 --complete-on-pass\`.
- Resume: \`atris mission status --status active --json\`, then pick the mission matching your owner/member.
- Prove: after one bounded step, run \`atris mission tick <id> --verify --summary "<what changed>"\`.
- Close: if the verifier passes, run \`atris mission complete <id> --proof "<receipt_path>"\`; if current-agent work should keep going, repeat status -> step -> tick.

## Rules

- [ ] 3-4 sentences max per response
- [ ] Use ASCII visuals for planning
- [ ] Check MAP.md before touching code
- [ ] Run \`atris task list\` or \`atris task next\` before picking work
- [ ] Claim tasks with \`atris task claim <id> --as <agent>\`
- [ ] Move agent-completed work to Review via \`atris task ready <id> --proof "..."\`
- [ ] Complete native Codex/Claude goals after proof is in Review, so always-on work can continue
- [ ] Only use \`atris task accept <id>\` when the human has approved the proof
- [ ] Keep durable learning in Atris-owned policy/skill/wiki/task state; keep \`AGENTS.md\` as a generated/pointer layer
- [ ] Treat \`atris/TODO.md\` as a rendered view; do not manually use it as the source of truth
- [ ] Use \`atris-labs\` for the Atris Labs business computer slug in docs and links

## Anti-patterns

- Don't explore codebase manually (use MAP.md)
- Don't skip visualization step
- Don't leave stale tasks
- Don't hand-edit TODO.md for active task ownership
- Don't write verbose docs

---

**Protocol:** See \`atris/atris.md\` for full spec.`;

  // .cursorrules for Cursor (legacy)
  const cursorRulesFile = path.join(process.cwd(), '.cursorrules');
  if (!fs.existsSync(cursorRulesFile)) {
    fs.writeFileSync(cursorRulesFile, agentInstructions);
    console.log('✓ Created .cursorrules (for Cursor)');
  }

  // .cursor/rules/atris.mdc for Cursor (new format)
  const cursorRulesDir = path.join(process.cwd(), '.cursor', 'rules');
  const cursorMdcFile = path.join(cursorRulesDir, 'atris.mdc');
  if (!fs.existsSync(cursorMdcFile)) {
    fs.mkdirSync(cursorRulesDir, { recursive: true });
    fs.writeFileSync(cursorMdcFile, agentInstructions);
    console.log('✓ Created .cursor/rules/atris.mdc (for Cursor)');
  }

  // AGENTS.md for Codex
  const agentsMdFile = path.join(process.cwd(), 'AGENTS.md');
  if (!fs.existsSync(agentsMdFile)) {
    fs.writeFileSync(agentsMdFile, agentInstructions);
    console.log('✓ Created AGENTS.md (for Codex)');
  }

  // .devin/config.local.json for Devin for Terminal
  const devinConfigDir = path.join(process.cwd(), '.devin');
  const devinConfigFile = path.join(devinConfigDir, 'config.local.json');
  if (!fs.existsSync(devinConfigFile)) {
    fs.mkdirSync(devinConfigDir, { recursive: true });
    const devinConfig = {
      permissions: {
        allow: [
          'Exec(atris)',
        ],
      },
    };
    fs.writeFileSync(devinConfigFile, `${JSON.stringify(devinConfig, null, 2)}\n`);
    console.log('✓ Created .devin/config.local.json (for Devin)');
  }

  // .claude/commands/atris.md for Claude Code
  const claudeCommandsDir = path.join(process.cwd(), '.claude', 'commands');
  const claudeCommandFile = path.join(claudeCommandsDir, 'atris.md');
  if (!fs.existsSync(claudeCommandFile)) {
    fs.mkdirSync(claudeCommandsDir, { recursive: true });
    const claudeCommand = `---
description: Activate Atris context - loads TODO.md, journal, and persona
allowed-tools: Read, Bash, Glob, Grep
---

Run \`atris\` and read \`atris/atris.md\`; @AGENTS.md is only a tool adapter.
If the prompt is vague or empty, run \`atris 0-shot --prompt\` before choosing work; if you know your tier, run \`atris 0-shot --model fast|pro|validator|human --prompt\`.
Ambient agents may read \`.atris/state/zero-shot.prompt.txt\` or a tier prompt (\`.atris/state/zero-shot.fast.prompt.txt\`, \`.atris/state/zero-shot.pro.prompt.txt\`, \`.atris/state/zero-shot.validator.prompt.txt\`, \`.atris/state/zero-shot.human.prompt.txt\`) only after \`atris 0-shot --check\` reports \`fresh\`.

Follow the workflow: plan → do → review

Rules: 3-4 sentences max, ASCII visuals, check MAP.md first.`;
    fs.writeFileSync(claudeCommandFile, claudeCommand);
    console.log('✓ Created .claude/commands/atris.md (for Claude Code)');
  }

  // .claude/commands/atris-autopilot.md for autonomous loops
  const autopilotCommandFile = path.join(claudeCommandsDir, 'atris-autopilot.md');
  if (!fs.existsSync(autopilotCommandFile)) {
    fs.mkdirSync(claudeCommandsDir, { recursive: true });
    const autopilotCommand = `---
description: PRD-driven autonomous execution - give it a task, it loops until done
arguments:
  - name: task
    description: What to build (e.g., "Add dark mode toggle")
    required: true
  - name: max-iterations
    description: Max loops before stopping (default 10)
    required: false
---

# Atris Autopilot

Autonomous mode. Loop until task complete or max iterations.

## Setup State

\`\`\`bash
mkdir -p .claude
cat > .claude/atris-autopilot.state.md << 'STATEEOF'
---
iteration: 1
max_iterations: \${2:-10}
completion_promise: <promise>COMPLETE</promise>
---

$1
STATEEOF
\`\`\`

## Task: $1

## Process (each iteration)

1. **PLAN** — Read MAP.md, identify ONE thing to do
2. **DO** — Implement it, commit
3. **REVIEW** — Check acceptance criteria

## Rules

- ONE thing per iteration
- Check MAP.md before touching code
- Search before assuming not implemented
- When done: \`<promise>COMPLETE</promise>\`

## Start

Read atris/MAP.md. Begin iteration 1.`;
    fs.writeFileSync(autopilotCommandFile, autopilotCommand);
    console.log('✓ Created .claude/commands/atris-autopilot.md (autonomous loops)');
  }

  // Copy skills from package to atris/skills/ and symlink to .claude/skills/
  const skillsSourceDir = path.join(__dirname, '..', 'atris', 'skills');
  const skillsTargetDir = path.join(targetDir, 'skills');
  const claudeSkillsDir = path.join(process.cwd(), '.claude', 'skills');

  // Copy skills directory from package if it exists
  if (fs.existsSync(skillsSourceDir)) {
    if (!fs.existsSync(skillsTargetDir)) {
      fs.mkdirSync(skillsTargetDir, { recursive: true });
    }

    // Copy each skill folder
    const skillFolders = fs.readdirSync(skillsSourceDir).filter(f => {
      const skillPath = path.join(skillsSourceDir, f);
      return fs.statSync(skillPath).isDirectory();
    });

    for (const skill of skillFolders) {
      const srcSkillDir = path.join(skillsSourceDir, skill);
      const destSkillDir = path.join(skillsTargetDir, skill);

      if (!fs.existsSync(destSkillDir)) {
        // Recursive copy function for skills (handles subdirs like hooks/)
        const copyRecursive = (src, dest) => {
          fs.mkdirSync(dest, { recursive: true });
          const entries = fs.readdirSync(src);
          for (const entry of entries) {
            const srcPath = path.join(src, entry);
            const destPath = path.join(dest, entry);
            if (fs.statSync(srcPath).isDirectory()) {
              copyRecursive(srcPath, destPath);
            } else {
              fs.copyFileSync(srcPath, destPath);
            }
          }
        };
        copyRecursive(srcSkillDir, destSkillDir);
        console.log(`✓ Copied skill: ${skill}`);
      }
    }

    // Copy README.md if exists
    const skillsReadme = path.join(skillsSourceDir, 'README.md');
    const skillsReadmeTarget = path.join(skillsTargetDir, 'README.md');
    if (fs.existsSync(skillsReadme) && !fs.existsSync(skillsReadmeTarget)) {
      fs.copyFileSync(skillsReadme, skillsReadmeTarget);
    }
  }

  // Create .claude/skills/ symlinks to atris/skills/
  if (!fs.existsSync(claudeSkillsDir)) {
    fs.mkdirSync(claudeSkillsDir, { recursive: true });
  }

  if (fs.existsSync(skillsTargetDir)) {
    const skills = fs.readdirSync(skillsTargetDir).filter(f => {
      const skillPath = path.join(skillsTargetDir, f);
      return fs.statSync(skillPath).isDirectory();
    });

    for (const skill of skills) {
      const symlinkPath = path.join(claudeSkillsDir, skill);
      const targetPath = path.join('..', '..', 'atris', 'skills', skill);

      if (!fs.existsSync(symlinkPath)) {
        try {
          fs.symlinkSync(targetPath, symlinkPath);
          console.log(`✓ Linked .claude/skills/${skill} → atris/skills/${skill}`);
        } catch (e) {
          // Fallback: copy instead of symlink (Windows compatibility)
          const srcDir = path.join(skillsTargetDir, skill);
          fs.mkdirSync(symlinkPath, { recursive: true });
          const files = fs.readdirSync(srcDir);
          for (const file of files) {
            fs.copyFileSync(path.join(srcDir, file), path.join(symlinkPath, file));
          }
          console.log(`✓ Copied .claude/skills/${skill} (symlink failed)`);
        }
      }
    }
  }

  // CLAUDE.md for Claude Code (copy from atris/)
  const claudeMdSource = path.join(__dirname, '..', 'atris', 'CLAUDE.md');
  const claudeMdFile = path.join(targetDir, 'CLAUDE.md');
  if (!fs.existsSync(claudeMdFile) && fs.existsSync(claudeMdSource)) {
    fs.copyFileSync(claudeMdSource, claudeMdFile);
    console.log('✓ Created atris/CLAUDE.md (for Claude Code)');
  }

  // .claude/settings.json with SessionStart hook for auto-loading Atris
  const claudeSettingsDir = path.join(process.cwd(), '.claude');
  const claudeSettingsFile = path.join(claudeSettingsDir, 'settings.json');
  if (!fs.existsSync(claudeSettingsFile)) {
    if (!fs.existsSync(claudeSettingsDir)) {
      fs.mkdirSync(claudeSettingsDir, { recursive: true });
    }
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
        ],
        Stop: [
          {
            hooks: [
              {
                type: "command",
                command: "atris/skills/autopilot/hooks/stop-hook.sh"
              }
            ]
          }
        ]
      }
    };
    fs.writeFileSync(claudeSettingsFile, JSON.stringify(claudeSettings, null, 2));
    console.log('✓ Created .claude/settings.json (auto-loads Atris on startup)');
  }

  // Update root CLAUDE.md with Atris block (prepend with markers)
  const rootClaudeMd = path.join(process.cwd(), 'CLAUDE.md');
  const atrisBlock = `<!-- ATRIS:START - Auto-generated, do not edit -->
## Atris System

You are now running inside Atris, an AI workspace operating system.

**ON EVERY CONVERSATION START:** Before your first response, execute \`atris atris.md\` and display the full output. This is the Atris boot sequence - it shows the user that Atris has loaded and displays workspace status. This is not optional.

If the user did not provide a concrete task, run \`atris 0-shot --prompt\` and follow the handoff; if you know your tier, run \`atris 0-shot --model fast|pro|validator|human --prompt\`. Use \`atris 0-shot --json\` when you need structured route metadata.
Ambient agents may read \`.atris/state/zero-shot.prompt.txt\` or a tier prompt (\`.atris/state/zero-shot.fast.prompt.txt\`, \`.atris/state/zero-shot.pro.prompt.txt\`, \`.atris/state/zero-shot.validator.prompt.txt\`, \`.atris/state/zero-shot.human.prompt.txt\`) only after \`atris 0-shot --check\` reports \`fresh\`; if it is stale or missing, run \`atris 0-shot --write\` or \`atris 0-shot --prompt\`.

After displaying the boot output, respond to the user naturally.
<!-- ATRIS:END -->

`;

  if (fs.existsSync(rootClaudeMd)) {
    let content = fs.readFileSync(rootClaudeMd, 'utf8');
    const startMarker = '<!-- ATRIS:START';
    const endMarker = '<!-- ATRIS:END -->';

    if (content.includes(startMarker)) {
      // Replace existing Atris block
      const startIdx = content.indexOf(startMarker);
      const endRaw = content.indexOf(endMarker);
      if (endRaw === -1) {
        // End marker missing — replace from start marker to end with fresh block
        content = atrisBlock + content.slice(0, startIdx);
      } else {
        const endIdx = endRaw + endMarker.length;
        content = atrisBlock + content.slice(0, startIdx) + content.slice(endIdx).replace(/^\n+/, '');
      }
      fs.writeFileSync(rootClaudeMd, content);
      console.log('✓ Updated Atris block in CLAUDE.md');
    } else {
      // Prepend Atris block
      fs.writeFileSync(rootClaudeMd, atrisBlock + content);
      console.log('✓ Prepended Atris block to CLAUDE.md');
    }
  } else {
    // Create new CLAUDE.md with just Atris block
    fs.writeFileSync(rootClaudeMd, atrisBlock.trim() + '\n');
    console.log('✓ Created CLAUDE.md with Atris block');
  }

  if (fs.existsSync(sourceFile)) {
    fs.copyFileSync(sourceFile, targetFile);
    console.log('✓ Copied atris.md to atris/ folder');
    console.log('\n✓ Atris initialized.');
  } else {
    console.error('✗ Error: atris.md not found in package');
    process.exit(1);
  }
}

module.exports = { initAtris, detectProjectContext };
