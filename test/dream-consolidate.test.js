'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { dreamCommand } = require('../commands/dream');
const { runDreamConsolidate } = require('../lib/dream-consolidate');
const { memoryCorePrompt, MEMORY_CORE_PATH } = require('../lib/member-context');
const { buildTickPrompt } = require('../commands/mission');
const { proposalPromptForGoal } = require('../commands/member');
const { runCli } = require('./helpers/cli-command');

function seedDreamWorkspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-dream-consolidate-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.mkdirSync(path.join(root, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(root, 'lib', 'real.js'), 'module.exports = true;\n');
  fs.mkdirSync(path.join(root, 'atris', 'team', 'builder'), { recursive: true });
  fs.mkdirSync(path.join(root, 'atris', 'wiki', 'concepts'), { recursive: true });
  fs.mkdirSync(path.join(root, '.atris', 'state'), { recursive: true });

  fs.writeFileSync(path.join(root, 'atris', 'MAP.md'), '# Map\n');
  fs.writeFileSync(path.join(root, 'atris', 'TODO.md'), '# TODO\n\n## Backlog\n\n- [ ] **Check:** one thing\n');
  fs.writeFileSync(path.join(root, 'atris', 'team', 'builder', 'MEMBER.md'), '---\nname: builder\nrole: Builder\n---\n# Builder\n');
  fs.writeFileSync(path.join(root, 'atris', 'team', 'builder', 'now.md'), `# Builder now\n\n${'stale line\n'.repeat(1800)}`);

  fs.writeFileSync(path.join(root, 'atris', 'lessons.md'), [
    '# lessons.md',
    '',
    '- **[2026-11-12] bare-verify-rule** - fail - [resolved] piping tests hides failures. detector: node --test. rule: always run checks bare without piping into tail or grep.',
    '- **[2026-10-01] bare-verify-rule** - fail - older duplicate line for bare verify.',
    '- **[2026-11-01] ghost-file-poison** - fail - edit lib/deleted-old-module.js before running tests. rule: touch lib/deleted-old-module.js first.',
    '- **[2026-11-05] loop-trap-suspect** - fail - trust stale cache in lib/real.js without checking.',
    '- **[2026-11-10] experiment-noise** - pass - Daily experiment noise kept (superset).',
    '',
  ].join('\n'));

  fs.writeFileSync(path.join(root, 'atris', 'learned.md'), [
    'Notes',
    '',
    '- 2026-11-10, "ship", 80 of 99 (night 1): keep diffs small',
    '- 2026-11-10, "ship", 80 of 99 (night 1): keep diffs small',
    '',
  ].join('\n'));

  fs.writeFileSync(path.join(root, '.atris', 'state', 'task_episodes.jsonl'), [
    JSON.stringify({ ts: '2026-11-06T00:00:00Z', status: 'failed', reward: { value: -1 }, lesson: 'hit loop-trap-suspect again' }),
    JSON.stringify({ ts: '2026-11-07T00:00:00Z', status: 'failed', reward: { value: -1 }, lesson: 'loop-trap-suspect broke retry' }),
  ].join('\n') + '\n');

  fs.writeFileSync(path.join(root, 'atris', 'wiki', 'index.md'), [
    '# wiki index',
    '',
    '- [[atris/wiki/concepts/missing-page.md]]: broken link',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(root, 'atris', 'wiki', 'concepts', 'orphan-note.md'), [
    '---',
    'type: concept',
    'slug: orphan-note',
    'title: Orphan Note',
    'sources: [lib/real.js]',
    'last_compiled: 2026-11-12',
    'last_verified: 2026-11-12',
    'confidence: 0.9',
    'dependencies: []',
    'actionability: "Open when checking orphan wiki indexing."',
    '---',
    '# Orphan Note',
    '',
  ].join('\n'));

  return root;
}

test('dream consolidate audits poisoned notes, duplicates, bloat, and wiki gaps without writing on dry run', (t) => {
  const root = seedDreamWorkspace(t);
  const dry = runDreamConsolidate(root, { apply: false, stamp: '2026-11-26T00:00:00.000Z' });
  assert.equal(dry.applied, false);
  assert.equal(dry.lessons.duplicates.length, 1);
  assert.equal(dry.lessons.duplicates[0].slug, 'bare-verify-rule');
  assert.ok(dry.lessons.poisoned.some((p) => p.slug === 'ghost-file-poison' && p.action === 'quarantine'));
  assert.ok(dry.lessons.poisoned.some((p) => p.slug === 'loop-trap-suspect' && p.action === 'flag'));
  assert.equal(dry.learned_duplicates, 1);
  assert.equal(dry.bloated_now_files.length, 1);
  assert.equal(dry.wiki.orphan_count, 1);
  assert.deepEqual(dry.wiki.broken_links, ['atris/wiki/concepts/missing-page.md']);
  assert.equal(fs.existsSync(path.join(root, MEMORY_CORE_PATH)), false);
  // Quarantined poison and superset experiment noise stay out of core memory.
  const promotedSlugs = dry.memory_core.items.map((i) => i.slug);
  assert.ok(promotedSlugs.includes('bare-verify-rule'));
  assert.equal(promotedSlugs.includes('ghost-file-poison'), false);
  assert.equal(promotedSlugs.includes('experiment-noise'), false);
});

test('dream consolidate --apply archives poison, trims bloated now.md, patches wiki index, and promotes MEMORY_CORE.md into member prompts', async (t) => {
  const root = seedDreamWorkspace(t);
  const out = [];
  const code = await dreamCommand(['consolidate', '--apply', '--json'], root, {
    stamp: '2026-11-26T01:00:00.000Z',
    log: (line) => out.push(line),
  });
  assert.equal(code, 0);
  const res = JSON.parse(out.join('\n'));
  assert.equal(res.applied, true);
  assert.equal(res.changes.lessons_deduped, 1);
  assert.equal(res.changes.lessons_quarantined, 1);
  assert.equal(res.changes.learned_deduped, 1);
  assert.equal(res.changes.now_files_trimmed.length, 1);
  assert.deepEqual(res.changes.wiki_orphans_indexed, ['atris/wiki/concepts/orphan-note.md']);
  assert.equal(res.changes.memory_core_written, true);

  // Poisoned + duplicate entries moved to reversible archive and removed from active lessons.md.
  const lessonsAfter = fs.readFileSync(path.join(root, 'atris', 'lessons.md'), 'utf8');
  assert.equal(lessonsAfter.includes('ghost-file-poison'), false);
  assert.equal(lessonsAfter.includes('older duplicate line'), false);
  assert.ok(lessonsAfter.includes('always run checks bare'));
  const archive = fs.readFileSync(path.join(root, '.atris', 'state', 'dream_archive.jsonl'), 'utf8');
  assert.match(archive, /ghost-file-poison/);
  assert.match(archive, /duplicate_lesson/);

  // Bloated now.md trimmed and original archived.
  assert.ok(fs.statSync(path.join(root, 'atris', 'team', 'builder', 'now.md')).size < 6 * 1024);

  // Orphan page indexed in wiki/index.md.
  const indexText = fs.readFileSync(path.join(root, 'atris', 'wiki', 'index.md'), 'utf8');
  assert.ok(indexText.includes('[[atris/wiki/concepts/orphan-note.md]]'));

  // Promoted MEMORY_CORE.md loads into memberContext, mission tick prompt, member wake prompt, and brain compile load order.
  const coreBlock = memoryCorePrompt(root);
  assert.match(coreBlock, /## Core verified memory/);
  assert.match(coreBlock, /bare-verify-rule/);

  const missionPrompt = buildTickPrompt(
    { id: 'm1', objective: 'Check memory injection', owner: 'builder', cadence: 'manual', status: 'running' },
    1, 1, { lane: 'workspace', verifier: 'node -e 0' }, [], root
  );
  assert.match(missionPrompt, /## Core verified memory/);
  assert.match(missionPrompt, /bare-verify-rule/);

  const wakePrompt = proposalPromptForGoal({ title: 'Keep moving' }, {}, root);
  assert.match(wakePrompt, /## Core verified memory/);

  const brainRes = runCli(['brain', 'compile', '--depoison', '--yes', '--root', root, '--json'], { cwd: root });
  assert.equal(brainRes.status, 0, brainRes.stderr);
  const brainPayload = JSON.parse(brainRes.stdout);
  assert.equal(brainPayload.ok, true);
  assert.ok(brainPayload.dream_consolidation);
  const agentsMd = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
  assert.match(agentsMd, /atris\/MEMORY_CORE\.md/);
});

test('dream consolidate preserves .atris/ path lessons, prunes lessons.json on quarantine, and ranks negative rewards as failed', (t) => {
  const root = seedDreamWorkspace(t);
  fs.appendFileSync(path.join(root, 'atris', 'lessons.md'), [
    '- **[2026-05-04] dot-atris-lesson** - pass - `.atris/state/tasks.projection.json` and `other-repo/lib/foo.js` are external or hidden paths.',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(root, 'atris', 'lessons.json'), JSON.stringify({
    _schema: 'atris.lessons.v1',
    'bare-verify-rule': { status: 'resolved' },
    'ghost-file-poison': { status: 'active' },
    'dot-atris-lesson': { status: 'active' },
  }, null, 2));
  fs.writeFileSync(path.join(root, '.atris', 'state', 'coordination_trace.jsonl'), `${JSON.stringify({
    ts: '2026-11-26T00:00:00Z',
    id: 'rt-neg',
    intent: 'Bad done episode',
    tier: 1,
    seat: 'builder',
    task_key: 't-neg',
    outcome: 'pending',
  })}\n`);
  fs.writeFileSync(path.join(root, '.atris', 'state', 'task_episodes.jsonl'), `${JSON.stringify({
    ts: '2026-11-26T00:05:00Z',
    task_id: 't-neg',
    status: 'done',
    reward: { value: -1 },
  })}\n`);

  const res = runDreamConsolidate(root, { apply: true, stamp: '2026-11-26T02:00:00.000Z' });
  assert.equal(res.lessons.poisoned.some((p) => p.slug === 'dot-atris-lesson'), false);
  const lessonsAfter = fs.readFileSync(path.join(root, 'atris', 'lessons.md'), 'utf8');
  assert.ok(lessonsAfter.includes('dot-atris-lesson'));

  // Quarantined ghost-file-poison must also be pruned from lessons.json for slug consistency.
  const metaAfter = JSON.parse(fs.readFileSync(path.join(root, 'atris', 'lessons.json'), 'utf8'));
  assert.equal(Object.prototype.hasOwnProperty.call(metaAfter, 'ghost-file-poison'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(metaAfter, 'dot-atris-lesson'), true);
  assert.equal(res.coordination_trace.failed, 1);
  assert.equal(res.coordination_trace.accepted, 0);
});

test('dream consolidate respects 40-entry wiki index cap and joins swarm_loop.jsonl outcomes', (t) => {
  const root = seedDreamWorkspace(t);
  // Fill index.md to 40 bullets so orphan-note.md MUST be deferred instead of overflowing budget.
  const forty = Array.from({ length: 40 }, (_, i) => `- [[atris/wiki/concepts/p-${i}.md]]: rule ${i}`).join('\n');
  fs.writeFileSync(path.join(root, 'atris', 'wiki', 'index.md'), `# wiki index\n\n${forty}\n`);

  fs.writeFileSync(path.join(root, '.atris', 'state', 'coordination_trace.jsonl'), [
    JSON.stringify({ ts: '2026-11-26T00:00:00Z', id: 'rt-s1', intent: 'Swarm task fail', tier: 1, seat: 'builder', task_key: 'sw-fail', outcome: 'pending' }),
    JSON.stringify({ ts: '2026-11-26T00:00:01Z', id: 'rt-s2', intent: 'Swarm task reviewed', tier: 1, seat: 'builder', task_key: 'sw-ok', outcome: 'pending' }),
  ].join('\n') + '\n');
  fs.writeFileSync(path.join(root, '.atris', 'state', 'swarm_loop.jsonl'), [
    JSON.stringify({
      ts: '2026-11-26T00:02:00Z',
      cycle: 1,
      frozen_ok: true,
      steps: [{ ran: true, task_key: 'sw-ok', ok: false, error: 'old transient failure' }],
    }),
    JSON.stringify({
      ts: '2026-11-26T00:05:00Z',
      cycle: 2,
      frozen_ok: true,
      steps: [
        { ran: true, task_key: 'sw-fail', ok: false, error: 'boom' },
        { ran: true, task_key: 'sw-ok', ok: true, reviewed: true },
      ],
    }),
  ].join('\n') + '\n');

  const res = runDreamConsolidate(root, { apply: true, stamp: '2026-11-26T03:00:00.000Z' });
  assert.deepEqual(res.changes.wiki_orphans_indexed, []);
  assert.deepEqual(res.changes.wiki_orphans_deferred, ['atris/wiki/concepts/orphan-note.md']);
  const indexBullets = fs.readFileSync(path.join(root, 'atris', 'wiki', 'index.md'), 'utf8')
    .split(/\r?\n/).filter((l) => /^\s*-\s+/.test(l)).length;
  assert.equal(indexBullets, 40);
  assert.equal(res.coordination_trace.joined, 2);
  assert.equal(res.coordination_trace.failed, 1);
  assert.equal(res.coordination_trace.accepted, 1);
});
