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
const { validateDetector, appendLedgerEntry, readLedger } = require('../lib/lesson-ledger');

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
      /(\*\*\[\d{4}-\d{2}-\d{2}\]\s+[\w-]+\*\*\s*[\u2014-]\s*(?:pass|fail)?\s*[\u2014-]?\s*)/,
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
 * detector) and `observed` process rules are never auto-resolved, they have
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
    for (const slug of resolved) {
      appendLedgerEntry(cwd, {
        action: 'resolve',
        slug,
        evidence: `detector passed: ${metadata[slug].detector}`,
        outcome: `status resolved, resolved_at ${today}`,
      });
    }
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

/**
 * Strip the `[resolved]` tag from a lesson's line in atris/lessons.md.
 * Inverse of tagLessonResolvedInMd; used by revert.
 * @returns {boolean} true if the file was changed.
 */
function untagLessonResolvedInMd(cwd, slug) {
  const lessonsPath = path.join(cwd, 'atris', 'lessons.md');
  if (!fs.existsSync(lessonsPath)) return false;
  const lines = fs.readFileSync(lessonsPath, 'utf8').split('\n');
  let changed = false;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/\*\*\[\d{4}-\d{2}-\d{2}\]\s+([\w-]+)\*\*/);
    if (!m || m[1] !== slug) continue;
    if (!/\[resolved\]/i.test(lines[i])) continue;
    lines[i] = lines[i].replace(/\[resolved\]\s*/i, '');
    changed = true;
  }
  if (changed) fs.writeFileSync(lessonsPath, lines.join('\n'));
  return changed;
}

/**
 * Add a lesson as a validated contract in one step: prose line in lessons.md,
 * typed entry in the lessons.json sidecar, and a ledger record with evidence.
 *
 * When a detector is given it must actually run (see validateDetector):
 * a lesson whose falsifier is a typo would sit unresolvable forever and rot
 * trust in the whole file. Detector-less adds are still allowed (process
 * notes), they just never self-retire.
 *
 * @param {string} cwd
 * @param {string} slug kebab-case
 * @param {'pass'|'fail'} status
 * @param {string} explanation
 * @param {{ detector?: string, scope?: string }} [opts]
 * @returns {{ ok: boolean, error?: string, ledger?: object }}
 */
function addLesson(cwd, slug, status, explanation, opts = {}) {
  let evidence = 'prose-only (no detector)';
  if (opts.detector !== undefined) {
    const check = validateDetector(opts.detector, cwd);
    if (!check.ok) {
      return { ok: false, error: `detector rejected: ${check.reason}` };
    }
    evidence = `detector validated (exit ${check.exitCode}): ${opts.detector}`;
  }

  writeLesson(cwd, slug, status, explanation);

  if (opts.detector !== undefined || opts.scope !== undefined) {
    const metadata = loadLessonMetadata(cwd);
    metadata[slug] = {
      ...(metadata[slug] || {}),
      ...(opts.detector !== undefined ? { detector: opts.detector } : {}),
      ...(opts.scope !== undefined ? { scope: opts.scope } : {}),
      status: (metadata[slug] && metadata[slug].status) || 'open',
    };
    fs.writeFileSync(
      path.join(cwd, 'atris', 'lessons.json'),
      JSON.stringify(metadata, null, 2) + '\n'
    );
  }

  const ledger = appendLedgerEntry(cwd, {
    action: 'add',
    slug,
    evidence,
    outcome: `${status} lesson written`,
  });
  return { ok: true, ledger };
}

/**
 * Reopen a resolved lesson: sidecar back to open, [resolved] tag stripped,
 * revert recorded in the ledger. The rollback half of auto-resolve: a
 * detector that passed for the wrong reason (deleted call site, gamed check)
 * must be reversible without hand-editing two files.
 * @returns {{ ok: boolean, error?: string, ledger?: object }}
 */
function revertLessonResolution(cwd, slug, reason) {
  const metadata = loadLessonMetadata(cwd);
  const meta = metadata[slug];
  if (!meta) return { ok: false, error: `no sidecar entry for "${slug}"` };
  if (meta.status !== 'resolved') {
    return { ok: false, error: `"${slug}" is not resolved (status: ${meta.status || 'open'})` };
  }
  const prevResolvedAt = meta.resolved_at;
  delete meta.resolved_at;
  meta.status = 'open';
  metadata[slug] = meta;
  fs.writeFileSync(
    path.join(cwd, 'atris', 'lessons.json'),
    JSON.stringify(metadata, null, 2) + '\n'
  );
  untagLessonResolvedInMd(cwd, slug);
  const ledger = appendLedgerEntry(cwd, {
    action: 'revert',
    slug,
    evidence: reason || 'manual revert',
    outcome: `reopened (was resolved ${prevResolvedAt || 'unknown'})`,
  });
  return { ok: true, ledger };
}

function showLedger(args) {
  const cwd = process.cwd();
  const json = args.includes('--json');
  const limitIdx = args.indexOf('--limit');
  const limit = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) || 20 : 20;
  const records = readLedger(cwd, { limit });

  if (json) {
    console.log(JSON.stringify({ ok: true, action: 'lesson_ledger', count: records.length, records }, null, 2));
    return;
  }
  if (!records.length) {
    console.log('ledger is empty (no lesson mutations recorded yet)');
    return;
  }
  for (const r of records) {
    console.log(`${(r.ts || '').slice(0, 16)} ${r.action.padEnd(7)} ${r.slug}: ${r.evidence || ''}`);
  }
}

function printLessonUsage() {
  console.log('');
  console.log('  Usage: atris lesson add <slug> <pass|fail> "<text>" [--detector "<cmd>"] [--scope <scope>]');
  console.log('         atris lesson mine [--json] [--dry-run]');
  console.log('         atris lesson sweep [--json] [--dry-run]');
  console.log('         atris lesson resolve [--json] [--dry-run]');
  console.log('         atris lesson revert <slug> ["<reason>"]');
  console.log('         atris lesson ledger [--json] [--limit N]');
  console.log('');
}

function lessonAtris(subcommand, ...args) {
  // -h/--help is an explicit help request: print usage and exit 0, before any
  // filesystem check, so `atris lesson --help` works everywhere.
  if (subcommand === '-h' || subcommand === '--help') {
    printLessonUsage();
    process.exit(0);
  }

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

  if (subcommand === 'ledger') {
    showLedger(args);
    return;
  }

  if (subcommand === 'revert') {
    const [slug, ...reasonParts] = args;
    if (!slug) {
      console.error('  ✗ usage: atris lesson revert <slug> ["<reason>"]');
      process.exit(1);
    }
    const res = revertLessonResolution(process.cwd(), slug, reasonParts.join(' ').trim() || undefined);
    if (!res.ok) {
      console.error(`  ✗ ${res.error}`);
      process.exit(1);
    }
    console.log(`✓ lesson reopened: ${slug} (ledger ${res.ledger.id})`);
    return;
  }

  if (subcommand !== 'add') {
    printLessonUsage();
    process.exit(subcommand ? 1 : 0);
  }

  // Pull --detector/--scope flag pairs out before positional parsing.
  const opts = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--detector') {
      opts.detector = args[++i];
    } else if (args[i] === '--scope') {
      opts.scope = args[++i];
    } else {
      positional.push(args[i]);
    }
  }
  const [slug, status, ...messageParts] = positional;
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

  const res = addLesson(process.cwd(), slug, status, explanation, opts);
  if (!res.ok) {
    console.error(`  ✗ ${res.error}`);
    process.exit(1);
  }
  const typed = opts.detector ? ' [detector validated]' : '';
  console.log(`✓ lesson added: ${slug} (${status})${typed}`);
}

module.exports = lessonAtris;
module.exports.autoResolveLessons = autoResolveLessons;
module.exports.addLesson = addLesson;
module.exports.revertLessonResolution = revertLessonResolution;
