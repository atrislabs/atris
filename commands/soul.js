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
    const max = W - 15;
    const text = preview.length > max ? preview.slice(0, max - 1) + '…' : preview;
    console.log(`  │   persona: ${text.padEnd(W - 14)}│`);
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

// ── Distill ────────────────────────────────────────────

function distillSoul(atrisDir) {
  const personaPath = path.join(atrisDir, 'PERSONA.md');
  const lessonsPath = path.join(atrisDir, 'lessons.md');
  const policiesDir = path.join(atrisDir, 'policies');

  // Gather learnings
  const lessons = readFile(lessonsPath);
  const persona = readFile(personaPath);

  let policyRules = [];
  if (fs.existsSync(policiesDir)) {
    for (const f of fs.readdirSync(policiesDir).filter(f => f.endsWith('.md'))) {
      const content = readFile(path.join(policiesDir, f));
      if (content) {
        // Extract bullet points as rules
        const bullets = content.match(/^[-*]\s+.+$/gm) || [];
        policyRules.push(...bullets.map(b => b.replace(/^[-*]\s+/, '').trim()));
      }
    }
  }

  // Extract lesson patterns
  let lessonItems = [];
  if (lessons) {
    lessonItems = (lessons.match(/^[-*]\s+.+$/gm) || []).map(l => l.replace(/^[-*]\s+/, '').trim());
  }

  // Count journal entries for depth stat
  const logsDir = path.join(atrisDir, 'logs');
  let journalCount = 0;
  if (fs.existsSync(logsDir)) {
    journalCount = countFiles(logsDir);
  }

  // Build distilled section
  const distilled = [];
  if (lessonItems.length > 0) {
    distilled.push('## Learned (distilled from lessons.md)');
    distilled.push('');
    // Deduplicate and take top 10 by recency (last in list = most recent)
    const unique = [...new Set(lessonItems)].slice(-10);
    for (const item of unique) {
      distilled.push(`- ${item}`);
    }
    distilled.push('');
  }

  if (policyRules.length > 0) {
    distilled.push('## Policies (distilled from policies/)');
    distilled.push('');
    const unique = [...new Set(policyRules)].slice(0, 10);
    for (const rule of unique) {
      distilled.push(`- ${rule}`);
    }
    distilled.push('');
  }

  if (distilled.length === 0) {
    return { status: 'nothing', reason: 'No lessons or policies to distill' };
  }

  // Archive current persona
  if (persona) {
    const archiveDir = path.join(atrisDir, 'persona-history');
    if (!fs.existsSync(archiveDir)) fs.mkdirSync(archiveDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    fs.writeFileSync(path.join(archiveDir, `${ts}.md`), persona);
  }

  // Append distilled section to persona
  const separator = '\n\n---\n\n';
  const distilledBlock = `<!-- Distilled ${new Date().toISOString().slice(0, 10)} | ${journalCount} journal entries, ${lessonItems.length} lessons, ${policyRules.length} policy rules -->\n\n` + distilled.join('\n');

  if (persona) {
    // Check if already has a distilled section, replace it
    if (persona.includes('<!-- Distilled')) {
      const updated = persona.replace(/<!-- Distilled[\s\S]*$/, distilledBlock);
      fs.writeFileSync(personaPath, updated);
    } else {
      fs.appendFileSync(personaPath, separator + distilledBlock);
    }
  } else {
    fs.writeFileSync(personaPath, `# Persona\n\n${distilledBlock}`);
  }

  return {
    status: 'distilled',
    lessons: lessonItems.length,
    policies: policyRules.length,
    archived: !!persona,
  };
}

// ── Main ───────────────────────────────────────────────

function showSoulHelp() {
  console.log('');
  console.log('  atris soul — see what your project has learned');
  console.log('');
  console.log('  soul              show identity, knowledge, learnings');
  console.log('  soul snapshot     export full soul to JSON (auto-gitignored)');
  console.log('  soul distill      compress lessons + policies into PERSONA.md');
  console.log('  soul fork <path>  copy persona + policies to another project');
  console.log('');
}

async function soul(args = []) {
  const subcommand = (args[0] || 'status').toLowerCase();
  if (subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
    showSoulHelp();
    return;
  }

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
    case 'distill':
    case 'compress': {
      const result = distillSoul(atrisDir);
      if (result.status === 'nothing') {
        console.log(`✗ ${result.reason}`);
      } else {
        console.log(`✓ Soul distilled`);
        console.log(`  ${result.lessons} lessons + ${result.policies} policy rules → PERSONA.md`);
        if (result.archived) console.log(`  Previous persona archived to persona-history/`);
      }
      break;
    }
    default:
      const s = snapshotSoul(atrisDir);
      displaySoul(s);
  }
}

module.exports = { soul, snapshotSoul };
