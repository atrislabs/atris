/**
 * Atris Soul — The persona as a living artifact
 *
 * Every atris project has a soul: persona + policies + learnings + context.
 * This command lets you see it, evolve it, fork it.
 *
 *   atris soul              — Show your project's soul state
 *   atris soul snapshot      — Export full soul to JSON
 *   atris soul distill       — Compress learnings into persona
 *   atris soul fork <target> — Copy soul to another project
 */

const fs = require('fs');
const path = require('path');

function findAtrisDir() {
  let dir = process.cwd();
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'atris'))) return path.join(dir, 'atris');
    dir = path.dirname(dir);
  }
  return null;
}

function readFile(filePath) {
  try { return fs.readFileSync(filePath, 'utf8'); } catch { return null; }
}

function readJson(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return null; }
}

function countFiles(dir) {
  try { return fs.readdirSync(dir, { recursive: true }).filter(f => !f.startsWith('.')).length; } catch { return 0; }
}

// ── Soul snapshot ──────────────────────────────────────

function snapshotSoul(atrisDir) {
  const soul = {
    timestamp: new Date().toISOString(),
    project: path.basename(path.dirname(atrisDir)),
    identity: {},
    knowledge: {},
    learned: {},
    stats: {},
  };

  // Identity
  const persona = readFile(path.join(atrisDir, 'PERSONA.md'));
  if (persona) soul.identity['PERSONA.md'] = persona;

  const map = readFile(path.join(atrisDir, 'MAP.md'));
  if (map) soul.identity['MAP.md'] = map;

  // Team members
  const teamDir = path.join(atrisDir, 'team');
  if (fs.existsSync(teamDir)) {
    const members = fs.readdirSync(teamDir).filter(f => {
      const memberPath = path.join(teamDir, f, 'MEMBER.md');
      return fs.existsSync(memberPath);
    });
    soul.identity.team = members;
  }

  // Knowledge — features
  const featuresDir = path.join(atrisDir, 'features');
  if (fs.existsSync(featuresDir)) {
    const features = fs.readdirSync(featuresDir).filter(f => {
      return !f.startsWith('_') && fs.existsSync(path.join(featuresDir, f, 'idea.md'));
    });
    soul.knowledge.features = features;
    soul.knowledge.feature_count = features.length;
  }

  // Knowledge — research
  const researchDir = path.join(atrisDir, 'research');
  if (fs.existsSync(researchDir)) {
    soul.knowledge.research_files = countFiles(researchDir);
  }

  // Knowledge — refs
  const refsDir = path.join(atrisDir, 'refs');
  if (fs.existsSync(refsDir)) {
    soul.knowledge.refs = fs.readdirSync(refsDir).filter(f => f.endsWith('.md'));
  }

  // Learned — policies
  const policiesDir = path.join(atrisDir, 'policies');
  if (fs.existsSync(policiesDir)) {
    soul.learned.policies = fs.readdirSync(policiesDir).filter(f => f.endsWith('.md'));
  }

  // Learned — logs (journal depth)
  const logsDir = path.join(atrisDir, 'logs');
  if (fs.existsSync(logsDir)) {
    soul.learned.journal_entries = countFiles(logsDir);
  }

  // Learned — lessons
  const lessons = readFile(path.join(atrisDir, 'lessons.md'));
  if (lessons) {
    const lessonCount = (lessons.match(/^-/gm) || []).length;
    soul.learned.lessons = lessonCount;
  }

  // Stats
  const todo = readFile(path.join(atrisDir, 'TODO.md'));
  if (todo) {
    const tasks = (todo.match(/^- /gm) || []).length;
    soul.stats.open_tasks = tasks;
  }

  soul.stats.identity_files = Object.keys(soul.identity).length;
  soul.stats.knowledge_items = (soul.knowledge.feature_count || 0) + (soul.knowledge.research_files || 0);
  soul.stats.learned_items = (soul.learned.journal_entries || 0) + (soul.learned.lessons || 0);

  return soul;
}

// ── Display ────────────────────────────────────────────

function displaySoul(soul) {
  const W = 50;
  const line = '─'.repeat(W);

  console.log(`\n  ┌${line}┐`);
  console.log(`  │ ${'◉ SOUL — ' + soul.project}${' '.repeat(Math.max(0, W - 10 - soul.project.length))}│`);
  console.log(`  ├${line}┤`);

  // Identity
  console.log(`  │ ${'IDENTITY'.padEnd(W - 1)}│`);
  if (soul.identity['PERSONA.md']) {
    const preview = soul.identity['PERSONA.md'].split('\n').find(l => l.trim() && !l.startsWith('#')) || '';
    console.log(`  │   persona: ${preview.slice(0, W - 15).padEnd(W - 14)}│`);
  }
  if (soul.identity.team) {
    console.log(`  │   team: ${soul.identity.team.length} members${' '.repeat(Math.max(0, W - 20 - String(soul.identity.team.length).length))}│`);
  }

  // Knowledge
  console.log(`  │ ${'KNOWLEDGE'.padEnd(W - 1)}│`);
  if (soul.knowledge.feature_count) {
    console.log(`  │   features: ${soul.knowledge.feature_count}${' '.repeat(Math.max(0, W - 16 - String(soul.knowledge.feature_count).length))}│`);
  }
  if (soul.knowledge.research_files) {
    console.log(`  │   research: ${soul.knowledge.research_files} files${' '.repeat(Math.max(0, W - 22 - String(soul.knowledge.research_files).length))}│`);
  }

  // Learned
  console.log(`  │ ${'LEARNED'.padEnd(W - 1)}│`);
  if (soul.learned.journal_entries) {
    console.log(`  │   journal: ${soul.learned.journal_entries} entries${' '.repeat(Math.max(0, W - 23 - String(soul.learned.journal_entries).length))}│`);
  }
  if (soul.learned.lessons) {
    console.log(`  │   lessons: ${soul.learned.lessons}${' '.repeat(Math.max(0, W - 15 - String(soul.learned.lessons).length))}│`);
  }
  if (soul.learned.policies) {
    console.log(`  │   policies: ${soul.learned.policies.length}${' '.repeat(Math.max(0, W - 16 - String(soul.learned.policies.length).length))}│`);
  }

  console.log(`  └${line}┘\n`);
}

// ── Fork ───────────────────────────────────────────────

function forkSoul(sourceDir, targetDir) {
  const toCopy = [
    'PERSONA.md',
    'policies',
    'refs',
  ];

  let copied = 0;
  for (const item of toCopy) {
    const src = path.join(sourceDir, item);
    const dst = path.join(targetDir, item);
    if (!fs.existsSync(src)) continue;

    const stat = fs.statSync(src);
    if (stat.isDirectory()) {
      fs.mkdirSync(dst, { recursive: true });
      for (const f of fs.readdirSync(src)) {
        fs.copyFileSync(path.join(src, f), path.join(dst, f));
        copied++;
      }
    } else {
      fs.copyFileSync(src, dst);
      copied++;
    }
  }

  // Write genealogy
  const genealogy = {
    forked_from: path.basename(path.dirname(sourceDir)),
    forked_at: new Date().toISOString(),
    files_copied: copied,
  };
  fs.writeFileSync(path.join(targetDir, 'genealogy.json'), JSON.stringify(genealogy, null, 2));

  return { copied, genealogy };
}

// ── Main ───────────────────────────────────────────────

async function soul(args = []) {
  const subcommand = (args[0] || 'status').toLowerCase();
  const atrisDir = findAtrisDir();

  if (!atrisDir) {
    console.error('✗ No atris/ folder found. Run "atris init" first.');
    process.exit(1);
  }

  switch (subcommand) {
    case 'status':
    case 'st': {
      const s = snapshotSoul(atrisDir);
      displaySoul(s);
      break;
    }
    case 'snapshot':
    case 'export': {
      const s = snapshotSoul(atrisDir);
      const outPath = path.join(atrisDir, 'soul-snapshot.json');
      fs.writeFileSync(outPath, JSON.stringify(s, null, 2));
      // Auto-add to .gitignore so it never gets committed
      const gitignorePath = path.join(path.dirname(atrisDir), '.gitignore');
      try {
        const existing = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf8') : '';
        if (!existing.includes('soul-snapshot.json')) {
          fs.appendFileSync(gitignorePath, '\n# Atris soul — private, never commit\natris/soul-snapshot.json\n');
        }
      } catch {}
      console.log(`✓ Soul snapshot saved to ${outPath}`);
      console.log(`  (auto-added to .gitignore — this stays private)`);
      break;
    }
    case 'fork': {
      const target = args[1];
      if (!target) {
        console.error('Usage: atris soul fork <target-project-path>');
        return;
      }
      const targetAtris = path.join(target, 'atris');
      if (!fs.existsSync(targetAtris)) {
        console.error(`✗ Target ${targetAtris} not found. Run "atris init" in that project first.`);
        return;
      }
      const result = forkSoul(atrisDir, targetAtris);
      console.log(`✓ Soul forked: ${result.copied} files copied`);
      console.log(`  From: ${path.basename(path.dirname(atrisDir))}`);
      console.log(`  To:   ${path.basename(target)}`);
      break;
    }
    default:
      const s = snapshotSoul(atrisDir);
      displaySoul(s);
  }
}

module.exports = { soul, snapshotSoul };
