const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, spawnSync } = require('child_process');
const readline = require('readline');
const { resolveRunnerBin } = require('../lib/runner-command');

// ── Context Gathering ──────────────────────────────────────────────

function gatherAtrisContext(workspaceDir) {
  const atrisDir = path.join(workspaceDir, 'atris');
  const ctx = {
    hasAtris: fs.existsSync(atrisDir),
    skills: [],
    teamMembers: [],
    backlogCount: 0,
    todayJournal: null,
    persona: null,
  };

  if (!ctx.hasAtris) return ctx;

  // Skills — scan atris/skills/ and .claude/skills/
  for (const skillsRoot of [
    path.join(atrisDir, 'skills'),
    path.join(workspaceDir, '.claude', 'skills'),
  ]) {
    if (!fs.existsSync(skillsRoot)) continue;
    for (const name of fs.readdirSync(skillsRoot)) {
      const skillMd = path.join(skillsRoot, name, 'SKILL.md');
      // Resolve symlinks
      let resolvedPath = skillMd;
      try {
        const fullDir = path.join(skillsRoot, name);
        const stat = fs.lstatSync(fullDir);
        if (stat.isSymbolicLink()) {
          resolvedPath = path.join(fs.realpathSync(fullDir), 'SKILL.md');
        }
      } catch {}
      if (!fs.existsSync(resolvedPath)) continue;

      // Extract name + description from frontmatter
      try {
        const raw = fs.readFileSync(resolvedPath, 'utf8');
        const fmMatch = raw.match(/^---\n([\s\S]*?)\n---/);
        let desc = name;
        if (fmMatch) {
          const descLine = fmMatch[1].match(/description:\s*(.+)/);
          if (descLine) desc = descLine[1].trim();
        }
        ctx.skills.push({ name, description: desc, path: resolvedPath });
      } catch {
        ctx.skills.push({ name, description: name, path: resolvedPath });
      }
    }
  }
  // Dedupe by name
  const seen = new Set();
  ctx.skills = ctx.skills.filter(s => {
    if (seen.has(s.name)) return false;
    seen.add(s.name);
    return true;
  });

  // Team members — scan atris/team/
  const teamDir = path.join(atrisDir, 'team');
  if (fs.existsSync(teamDir)) {
    for (const name of fs.readdirSync(teamDir)) {
      if (name.startsWith('_')) continue;
      const memberMd = path.join(teamDir, name, 'MEMBER.md');
      if (fs.existsSync(memberMd)) {
        ctx.teamMembers.push(name);
      }
    }
  }

  // Backlog count from TODO.md
  const todoFile = path.join(atrisDir, 'TODO.md');
  if (fs.existsSync(todoFile)) {
    const content = fs.readFileSync(todoFile, 'utf8');
    const backlogMatch = content.match(/## Backlog\n([\s\S]*?)(?=\n## |$)/);
    if (backlogMatch) {
      ctx.backlogCount = (backlogMatch[1].match(/^- /gm) || []).length;
    }
  }

  // Today's journal
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const journalPath = path.join(atrisDir, 'logs', String(y), `${y}-${m}-${d}.md`);
  if (fs.existsSync(journalPath)) {
    ctx.todayJournal = journalPath;
  }

  // Persona
  const personaPath = path.join(atrisDir, 'PERSONA.md');
  if (fs.existsSync(personaPath)) {
    ctx.persona = fs.readFileSync(personaPath, 'utf8').slice(0, 2000);
  }

  return ctx;
}

function buildSystemPrompt(ctx) {
  const lines = [];

  lines.push('# Atris Console');
  lines.push('You are running inside the Atris Console — an AI workspace operating system.');
  lines.push('');

  if (ctx.persona) {
    lines.push('## Persona');
    lines.push(ctx.persona);
    lines.push('');
  }

  if (ctx.teamMembers.length > 0) {
    lines.push('## Team Members');
    lines.push(`Available: ${ctx.teamMembers.join(', ')}`);
    lines.push('Each has a MEMBER.md in atris/team/<name>/ defining their role.');
    lines.push('');
  }

  if (ctx.skills.length > 0) {
    lines.push('## Skills');
    lines.push('Before replying, scan these skills. If one applies, read its SKILL.md then follow it.');
    lines.push('');
    for (const s of ctx.skills) {
      lines.push(`- **${s.name}**: ${s.description} (${s.path})`);
    }
    lines.push('');
  }

  if (ctx.backlogCount > 0) {
    lines.push(`## Current Work`);
    lines.push(`${ctx.backlogCount} task${ctx.backlogCount > 1 ? 's' : ''} in backlog. Check atris/TODO.md for details.`);
    lines.push('');
  }

  if (ctx.todayJournal) {
    lines.push(`## Journal`);
    lines.push(`Today's journal: ${ctx.todayJournal}`);
    lines.push('');
  }

  return lines.join('\n');
}

// ── TUI Rendering ──────────────────────────────────────────────────

const COLORS = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  magenta: '\x1b[35m',
  white: '\x1b[37m',
  bgBlack: '\x1b[40m',
  gray: '\x1b[90m',
};

function renderHeader(ctx, backend) {
  const c = COLORS;
  const width = Math.min(process.stdout.columns || 60, 70);
  const line = '─'.repeat(width);

  console.log('');
  console.log(`${c.cyan}${c.bold}  ┌${line}┐${c.reset}`);
  console.log(`${c.cyan}${c.bold}  │${''.padEnd(width)}│${c.reset}`);

  // Title
  const title = 'A T R I S   C O N S O L E';
  const pad = Math.max(0, Math.floor((width - title.length) / 2));
  console.log(`${c.cyan}${c.bold}  │${' '.repeat(pad)}${c.white}${title}${' '.repeat(width - pad - title.length)}${c.cyan}│${c.reset}`);

  console.log(`${c.cyan}${c.bold}  │${''.padEnd(width)}│${c.reset}`);
  console.log(`${c.cyan}  ├${line}┤${c.reset}`);

  // Status row
  const engine = `Engine: ${backend}`;
  const skills = `Skills: ${ctx.skills.length}`;
  const team = `Team: ${ctx.teamMembers.length}`;
  const tasks = `Tasks: ${ctx.backlogCount}`;
  const statusItems = [engine, skills, team, tasks].join('  │  ');
  const statusPad = Math.max(0, Math.floor((width - statusItems.length) / 2));
  console.log(`${c.cyan}  │${c.reset}${' '.repeat(statusPad)}${c.dim}${statusItems}${' '.repeat(Math.max(0, width - statusPad - statusItems.length))}${c.cyan}│${c.reset}`);

  console.log(`${c.cyan}  └${line}┘${c.reset}`);
  console.log('');
}

function renderSkillsBar(ctx) {
  if (ctx.skills.length === 0) return;
  const c = COLORS;
  const names = ctx.skills.map(s => s.name).slice(0, 8);
  console.log(`${c.dim}  Skills: ${names.map(n => `${c.magenta}/${n}${c.dim}`).join('  ')}${c.reset}`);
  if (ctx.skills.length > 8) {
    console.log(`${c.dim}  ... and ${ctx.skills.length - 8} more${c.reset}`);
  }
  console.log('');
}

// ── Backend Detection & Auth ───────────────────────────────────────

function detectBackend(requested) {
  const claudeBin = resolveRunnerBin();
  const hasClaude = claudeBin.includes(path.sep)
    ? fs.existsSync(claudeBin)
    : spawnSync('which', [claudeBin], { stdio: 'pipe' }).status === 0;
  const hasCodex = spawnSync('which', ['codex'], { stdio: 'pipe' }).status === 0;

  if (requested) {
    const installed = requested === 'claude' ? hasClaude : hasCodex;
    if (!installed) return { backend: requested, installed: false, hasClaude, hasCodex };
    return { backend: requested, installed: true, hasClaude, hasCodex };
  }

  if (hasClaude) return { backend: 'claude', installed: true, hasClaude, hasCodex };
  if (hasCodex) return { backend: 'codex', installed: true, hasClaude, hasCodex };
  return { backend: null, installed: false, hasClaude, hasCodex };
}

function offerInstall(target, callback) {
  const pkg = target === 'claude'
    ? '@anthropic-ai/claude-code'
    : '@openai/codex';

  console.log(`  ${target} is not installed.\n`);
  if (target === 'claude') {
    console.log('  Install: npm install -g @anthropic-ai/claude-code');
    console.log('  Auth:    claude (follow login prompts)\n');
  } else {
    console.log('  Install: npm install -g @openai/codex');
    console.log('  Auth:    export OPENAI_API_KEY=sk-...\n');
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question(`  Install ${target} now? (y/N) `, (answer) => {
    rl.close();
    if (answer.trim().toLowerCase() === 'y') {
      console.log(`\n  Installing ${pkg}...\n`);
      const install = spawnSync('npm', ['install', '-g', pkg], {
        stdio: 'inherit',
        env: process.env,
      });
      if (install.status !== 0) {
        console.error(`\n✗ Install failed. Try: npm install -g ${pkg}`);
        process.exit(1);
      }
      console.log(`\n✓ ${target} installed.\n`);
      callback();
    } else {
      process.exit(0);
    }
  });
}

function checkAuth(backend) {
  if (backend === 'claude') {
    // Claude handles its own auth interactively — always allow
    return true;
  }
  if (backend === 'codex') {
    if (!process.env.OPENAI_API_KEY) {
      console.error('\n  ✗ OPENAI_API_KEY not set.\n');
      console.error('  Codex requires an OpenAI API key:');
      console.error('    export OPENAI_API_KEY=sk-...\n');
      console.error('  Get one at: https://platform.openai.com/api-keys\n');
      process.exit(1);
      return false;
    }
    return true;
  }
  return true;
}

// ── Launch ──────────────────────────────────────────────────────────

function launchClaude(systemPrompt, extraArgs) {
  const runnerBin = resolveRunnerBin();
  const args = [
    '--dangerously-skip-permissions',
    '--append-system-prompt', systemPrompt,
    ...extraArgs,
  ];

  const child = spawnSync(runnerBin, args, {
    cwd: process.cwd(),
    stdio: 'inherit',
    env: { ...process.env, CLAUDECODE: undefined },
  });

  if (child.error) {
    console.error(`✗ Failed to start ${runnerBin}: ${child.error.message}`);
    process.exit(1);
  }
  process.exit(child.status ?? 0);
}

function launchCodex(systemPrompt, extraArgs) {
  // Codex uses ~/.codex/instructions.md for system instructions
  // Write a temporary instructions file and point to it
  const codexDir = path.join(os.homedir(), '.codex');
  const instructionsPath = path.join(codexDir, 'instructions.md');

  // Preserve existing instructions
  let existingInstructions = '';
  if (fs.existsSync(instructionsPath)) {
    existingInstructions = fs.readFileSync(instructionsPath, 'utf8');
  }

  // Prepend Atris context
  const combined = systemPrompt + '\n\n---\n\n' + existingInstructions;

  // Write combined, launch, restore
  if (!fs.existsSync(codexDir)) fs.mkdirSync(codexDir, { recursive: true });
  fs.writeFileSync(instructionsPath, combined, 'utf8');

  const child = spawnSync('codex', ['--full-auto', ...extraArgs], {
    cwd: process.cwd(),
    stdio: 'inherit',
    env: process.env,
  });

  // Restore original
  if (existingInstructions) {
    fs.writeFileSync(instructionsPath, existingInstructions, 'utf8');
  } else {
    try { fs.unlinkSync(instructionsPath); } catch {}
  }

  if (child.error) {
    console.error(`✗ Failed to start codex: ${child.error.message}`);
    process.exit(1);
  }
  process.exit(child.status ?? 0);
}

// ── Main ────────────────────────────────────────────────────────────

function consoleCommand() {
  const args = process.argv.slice(3);
  let requested = args[0];

  if (requested === '--help' || requested === 'help') {
    console.log('Usage: atris console [claude|codex] [...args]\n');
    console.log('Launch a coding agent wrapped in Atris context.\n');
    console.log('The console injects your team, skills, tasks, and persona');
    console.log('into the agent session. Everything Atris knows, it knows.\n');
    console.log('Examples:');
    console.log('  atris console              Auto-detect and launch');
    console.log('  atris console claude       Launch with Claude Code');
    console.log('  atris console codex        Launch with Codex');
    process.exit(0);
  }

  if (requested && !['claude', 'codex'].includes(requested)) {
    console.error(`✗ Unknown backend: ${requested}`);
    console.error('  Usage: atris console [claude|codex]');
    process.exit(1);
  }

  const detection = detectBackend(requested);

  function boot() {
    const backend = detection.backend || 'claude';
    checkAuth(backend);

    // Gather Atris context
    const ctx = gatherAtrisContext(process.cwd());

    // Render TUI header
    renderHeader(ctx, backend);
    renderSkillsBar(ctx);

    // Build system prompt
    const systemPrompt = buildSystemPrompt(ctx);

    // Extra args (skip backend name if it was first arg)
    const extraArgs = requested === args[0] ? args.slice(1) : args;

    // Launch
    if (backend === 'claude') {
      launchClaude(systemPrompt, extraArgs);
    } else {
      launchCodex(systemPrompt, extraArgs);
    }
  }

  if (!detection.installed) {
    const target = detection.backend || 'claude';
    offerInstall(target, boot);
  } else {
    boot();
  }
}

module.exports = { consoleCommand, gatherAtrisContext, buildSystemPrompt };
