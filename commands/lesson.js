const fs = require('fs');
const path = require('path');
const {
  writeLesson,
  parseLessons,
  loadLessonMetadata,
  runLessonDetector,
} = require('./autopilot');
const { detectLessonContradictions } = require('../lib/lesson-contradiction');
const taskDb = require('../lib/task-db');

/**
 * Tag a lesson's line in atris/lessons.md with `[resolved]` (idempotent).
 * Inserts the marker right after the verdict separator so both the autopilot
 * parser (`resolvedTag`) and the memory view treat the lesson as retired.
 * @returns {boolean} true if the file was changed.
 */
function tagLessonResolvedInMd(cwd, slug) {
  const lessonsPath = path.join(cwd, 'atris', 'lessons.md');
  if (!fs.existsSync(lessonsPath)) return false;
  const lines = fs.readFileSync(lessonsPath, 'utf8').split('\n');
  let changed = false;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/\*\*\[\d{4}-\d{2}-\d{2}\]\s+([\w-]+)\*\*/);
    if (!m || m[1] !== slug) continue;
    if (/\[resolved\]/i.test(lines[i])) continue; // already tagged
    lines[i] = lines[i].replace(
      /(\*\*\[\d{4}-\d{2}-\d{2}\]\s+[\w-]+\*\*\s*[—-]\s*(?:pass|fail)?\s*[—-]?\s*)/,
      '$1[resolved] '
    );
    changed = true;
  }
  if (changed) fs.writeFileSync(lessonsPath, lines.join('\n'));
  return changed;
}

/**
 * Auto-resolve detector-backed fail lessons whose detector now passes.
 *
 * A `fail` lesson records a bug; its detector exits 0 once the bug is gone.
 * When that happens we retire the lesson: stamp `status: resolved` +
 * `resolved_at` in the atris/lessons.json sidecar and tag `[resolved]` in
 * atris/lessons.md. Retired lessons stop being re-picked by the self-heal
 * loop and drop out of the active memory view, keeping the lesson file small
 * and trustworthy.
 *
 * Only detector-backed `fail` lessons self-retire. Prose-only lessons (no
 * detector) and `observed` process rules are never auto-resolved — they have
 * no falsifiable pass state.
 *
 * @param {string} cwd
 * @param {object} [options] - { dryRun, detectorTimeout }
 * @returns {{ checked: string[], resolved: string[], dryRun: boolean }}
 */
function autoResolveLessons(cwd, options = {}) {
  const dryRun = !!options.dryRun;
  const lessons = parseLessons(cwd);
  const metadata = loadLessonMetadata(cwd);
  const today = new Date().toISOString().slice(0, 10);
  const checked = [];
  const resolved = [];

  for (const lesson of lessons) {
    const meta = lesson.meta;
    if (!meta || !meta.detector) continue;      // only detector-backed lessons self-retire
    if (lesson.verdict !== 'fail') continue;     // only bug lessons carry a resolve semantic
    if (meta.status === 'resolved') continue;    // already retired
    if (meta.status === 'observed') continue;    // process rule, never auto-resolve
    checked.push(lesson.id);
    if (!runLessonDetector(meta.detector, cwd, options.detectorTimeout)) continue;
    resolved.push(lesson.id);
    if (!dryRun) {
      metadata[lesson.id] = { ...meta, status: 'resolved', resolved_at: today };
      tagLessonResolvedInMd(cwd, lesson.id);
    }
  }

  if (!dryRun && resolved.length) {
    const metaPath = path.join(cwd, 'atris', 'lessons.json');
    fs.writeFileSync(metaPath, JSON.stringify(metadata, null, 2) + '\n');
  }

  return { checked, resolved, dryRun };
}

function resolveLessons(args) {
  const cwd = process.cwd();
  const json = args.includes('--json');
  const dryRun = args.includes('--dry-run');
  const { checked, resolved } = autoResolveLessons(cwd, { dryRun });

  if (json) {
    console.log(JSON.stringify({
      ok: true,
      action: 'lesson_resolve',
      dry_run: dryRun,
      detectors_checked: checked.length,
      resolved_count: resolved.length,
      resolved,
    }, null, 2));
    return;
  }

  const verb = dryRun ? 'would auto-resolve' : 'auto-resolved';
  const tail = resolved.length ? `: ${resolved.join(', ')}` : '';
  console.log(`ran ${checked.length} detector(s); ${verb} ${resolved.length} lesson(s)${tail}`);
  if (dryRun) console.log('(dry-run: nothing written)');
}

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

  if (subcommand === 'resolve') {
    resolveLessons(args);
    return;
  }

  if (subcommand !== 'add') {
    console.log('');
    console.log('  Usage: atris lesson add <slug> <pass|fail> "<text>"');
    console.log('         atris lesson mine [--json] [--dry-run]');
    console.log('         atris lesson sweep [--json] [--dry-run]');
    console.log('         atris lesson resolve [--json] [--dry-run]');
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
module.exports.autoResolveLessons = autoResolveLessons;
module.exports.tagLessonResolvedInMd = tagLessonResolvedInMd;
