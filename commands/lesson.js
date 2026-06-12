const fs = require('fs');
const path = require('path');
const { writeLesson } = require('./autopilot');
const { detectLessonContradictions } = require('../lib/lesson-contradiction');
const taskDb = require('../lib/task-db');

function sweepLessons(args) {
  const cwd = process.cwd();
  const json = args.includes('--json');
  const dryRun = args.includes('--dry-run');

  const contradictions = detectLessonContradictions(cwd);

  if (json) {
    console.log(JSON.stringify({
      ok: true,
      action: 'lesson_sweep',
      dry_run: dryRun,
      contradictions_found: contradictions.length,
      tasks_created: dryRun ? 0 : contradictions.length,
      contradictions: contradictions.map(c => ({
        type: c.type,
        slug: c.slug,
        evidence: c.evidence,
      })),
    }, null, 2));
    return;
  }

  if (dryRun) {
    console.log(`found ${contradictions.length} lesson contradiction(s):`);
    for (const c of contradictions) {
      console.log(`- [${c.type}] ${c.slug}: ${c.evidence}`);
    }
    console.log('(dry-run: no tasks created)');
    return;
  }

  // Create idempotent dissolve tasks for each contradiction
  let created = 0;
  const db = taskDb.open();
  try {
    const workspaceRoot = taskDb.workspaceRoot(cwd);
    for (const contradiction of contradictions) {
      const sourceKey = `lesson-contradiction-${contradiction.slug}`;
      const title = `dissolve lesson: ${contradiction.slug} (${contradiction.type})`;

      const result = db.prepare(
        'SELECT id FROM tasks WHERE workspace_root = ? AND source_key = ?'
      ).get(workspaceRoot, sourceKey);

      if (!result) {
        taskDb.addTask(db, {
          title,
          tag: 'lesson-contradiction',
          workspaceRoot,
          sourceKey,
          metadata: {
            lesson_slug: contradiction.slug,
            contradiction_type: contradiction.type,
            evidence: contradiction.evidence,
          },
          status: 'open',
        });
        created++;
      }
    }
  } finally {
    db.close();
  }

  console.log(`created ${created} idempotent dissolve task(s) from ${contradictions.length} contradiction(s)`);
}

function mineLessons(args) {
  const { loadHistory, mineProofPolicy, writePolicyLessons, syncLessonsMd } = require('../lib/policy-lessons');
  const root = process.cwd();
  const json = args.includes('--json');
  const dryRun = args.includes('--dry-run');
  const history = loadHistory(root);
  const mined = mineProofPolicy(history);
  let statePath = null;
  let lessonsMd = { path: null, written: [] };
  if (!dryRun) {
    statePath = writePolicyLessons(root, mined);
    lessonsMd = syncLessonsMd(root, mined);
  }
  if (json) {
    console.log(JSON.stringify({
      ok: true,
      action: 'lesson_mine',
      dry_run: dryRun,
      state_path: statePath,
      lessons_md_path: lessonsMd.path,
      lessons_md_written: lessonsMd.written,
      ...mined,
    }, null, 2));
    return;
  }
  const { sources } = mined;
  console.log(`mined ${mined.lessons.length} policy lesson(s) from ${sources.career_xp_receipts} receipts / ${sources.task_episodes} episodes / ${sources.scorecards} scorecards (${sources.human_reviewed_episodes} human-reviewed)`);
  for (const lesson of mined.lessons) {
    console.log(`- policy-${lesson.id}: ${lesson.lesson}`);
  }
  if (dryRun) {
    console.log('(dry-run: nothing written)');
  } else {
    console.log(`state: ${statePath}`);
    console.log(`lessons.md: ${lessonsMd.written.length ? lessonsMd.written.map((id) => `policy-${id}`).join(', ') : 'no entries written'}`);
  }
}

function lessonAtris(subcommand, ...args) {
  const atrisDir = path.join(process.cwd(), 'atris');
  if (!fs.existsSync(atrisDir)) {
    console.error('  ✗ atris/ folder not found. Run "atris init" first.');
    process.exit(1);
  }

  if (subcommand === 'mine') {
    mineLessons(args);
    return;
  }

  if (subcommand === 'sweep') {
    sweepLessons(args);
    return;
  }

  if (subcommand !== 'add') {
    console.log('');
    console.log('  Usage: atris lesson add <slug> <pass|fail> "<text>"');
    console.log('         atris lesson mine [--json] [--dry-run]');
    console.log('         atris lesson sweep [--json] [--dry-run]');
    console.log('');
    process.exit(subcommand ? 1 : 0);
  }

  const [slug, status, ...messageParts] = args;
  const explanation = messageParts.join(' ').trim();

  if (!slug || !/^[a-z0-9-]+$/.test(slug)) {
    console.error('  ✗ slug must be kebab-case');
    process.exit(1);
  }

  if (!['pass', 'fail'].includes(status)) {
    console.error('  ✗ status must be "pass" or "fail"');
    process.exit(1);
  }

  if (!explanation) {
    console.error('  ✗ explanation is required');
    process.exit(1);
  }

  writeLesson(process.cwd(), slug, status, explanation);
  console.log(`✓ lesson added: ${slug} (${status})`);
}

module.exports = lessonAtris;
