'use strict';

// Proves the loop reads ROADMAP.md and ADVANCES, without needing a live runner.
// It exercises the exact cwd-relative sequence the cycle loop uses (run.js), and
// the seed ledger that stops the loop re-pulling the same item forever.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  pickRoadmapSeed,
  seedInboxFromMove,
  latestInboxItems,
  recordDecision,
  moveId,
  todayLogFile,
} = require('../lib/next-moves');
const run = require('../commands/run');

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-run-roadmap-'));
}
function writeRoadmap(root, items) {
  const body = items.join('\n');
  fs.writeFileSync(path.join(root, 'ROADMAP.md'), `# R\n\n## Open loop items\n\n${body}\n\n## Other\n\ntext\n`, 'utf8');
}
// Simulate the DO phase clearing the seeded item out of the inbox.
function clearInbox(root) {
  const { file } = todayLogFile(root);
  fs.writeFileSync(file, '# x\n\n## Inbox\n\n## Notes\n', 'utf8');
}

test('roadmapOpenCount counts open ROADMAP items (the hasWork term)', () => {
  const root = tmp();
  try {
    writeRoadmap(root, ['- [ ] alpha', '- [x] done', '- [ ] beta']);
    fs.mkdirSync(path.join(root, 'atris'), { recursive: true });
    assert.equal(run.roadmapOpenCount(path.join(root, 'atris')), 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the real cwd-bound idle seed lands where the loop gate reads (hasWork flips true)', () => {
  const root = tmp();
  const cwd = process.cwd();
  try {
    writeRoadmap(root, ['- [ ] only item']);
    fs.mkdirSync(path.join(root, 'atris'), { recursive: true });
    process.chdir(root);
    const atrisDir = path.join(process.cwd(), 'atris');

    // Idle: no inbox, no backlog. This is the gate the loop checks before seeding.
    assert.equal(run.hasInboxOrBacklogWork(atrisDir), false);

    // The exact sequence run.js runs when idle (cwd-relative, not root-explicit).
    const pick = pickRoadmapSeed(process.cwd());
    assert.equal(pick.title, 'only item');
    seedInboxFromMove(process.cwd(), { title: pick.title, source: 'roadmap' });

    // The seed must land where the gate looks, or the loop never sees its own work.
    assert.equal(run.hasInboxOrBacklogWork(atrisDir), true);
    assert.equal(run.hasWork(atrisDir), true);
  } finally {
    process.chdir(cwd);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the loop ADVANCES: a seeded item is not re-pulled once the inbox is cleared', () => {
  const root = tmp();
  try {
    writeRoadmap(root, ['- [ ] ship the thing', '- [ ] second thing']);

    // Cycle 1: pull the top item, seed it, and record the seed (what run.js does).
    const p1 = pickRoadmapSeed(root);
    assert.equal(p1.title, 'ship the thing');
    seedInboxFromMove(root, { title: p1.title, source: 'roadmap' });
    recordDecision(root, { id: moveId('roadmap', p1.title), title: p1.title, source: 'roadmap' }, 'seeded', '2026-06-25T00:00:00Z');

    // DO phase completes and clears it from the inbox.
    clearInbox(root);
    assert.equal(latestInboxItems(root).length, 0);

    // Cycle 2: the seed ledger blocks re-pulling item 1, so the loop advances.
    const p2 = pickRoadmapSeed(root);
    assert.equal(p2.title, 'second thing', 'must advance, not re-pull the same item forever');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('pickRoadmapSeed returns null when ROADMAP has no open items', () => {
  const root = tmp();
  try {
    fs.writeFileSync(path.join(root, 'ROADMAP.md'), '# R\n\n## Open loop items\n\n- [x] all done\n', 'utf8');
    assert.equal(pickRoadmapSeed(root), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('pickRoadmapSeed is case-insensitive against the inbox (no case-variant duplicate)', () => {
  const root = tmp();
  try {
    writeRoadmap(root, ['- [ ] Ship The Thing', '- [ ] second thing']);
    seedInboxFromMove(root, { title: 'ship the thing', source: 'roadmap' }); // different case already queued
    const pick = pickRoadmapSeed(root);
    assert.equal(pick.title, 'second thing', 'must skip the case-variant already in the inbox');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
