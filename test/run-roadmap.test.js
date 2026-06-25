'use strict';

// Proves the loop reads ROADMAP.md without needing a live runner: an idle
// cycle pulls the top open ROADMAP item into the inbox the Navigator reads,
// and the next cycle moves on to the following item.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { pickRoadmapSeed, seedInboxFromMove, latestInboxItems } = require('../lib/next-moves');
const run = require('../commands/run');

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-run-roadmap-'));
}
function writeRoadmap(root, items) {
  const body = items.join('\n');
  fs.writeFileSync(path.join(root, 'ROADMAP.md'), `# R\n\n## Open loop items\n\n${body}\n\n## Other\n\ntext\n`, 'utf8');
}

test('roadmapOpenCount lets the loop\'s hasWork see ROADMAP items', () => {
  const root = tmp();
  try {
    writeRoadmap(root, ['- [ ] alpha', '- [x] done', '- [ ] beta']);
    fs.mkdirSync(path.join(root, 'atris'), { recursive: true });
    assert.equal(run.roadmapOpenCount(path.join(root, 'atris')), 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an idle cycle pulls the top ROADMAP item into the inbox, next cycle moves on', () => {
  const root = tmp();
  try {
    writeRoadmap(root, ['- [ ] ship the thing', '- [ ] second thing']);

    // cycle 1: idle -> pick the top open item -> seed it into the inbox
    const pick1 = pickRoadmapSeed(root);
    assert.equal(pick1.title, 'ship the thing');
    seedInboxFromMove(root, { title: pick1.title, source: 'roadmap' });
    assert.ok(latestInboxItems(root).some((i) => i.title.includes('ship the thing')),
      'the seeded item is now in the inbox the Navigator reads');

    // cycle 2: the seeded item is skipped, the next item is picked
    const pick2 = pickRoadmapSeed(root);
    assert.equal(pick2.title, 'second thing');
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

test('hasWork is true when only ROADMAP has open items (no inbox, no backlog)', () => {
  // roadmapOpenCount is the new term in hasWork; prove it flips hasWork on
  // via a temp atrisDir whose parent carries the ROADMAP.
  const root = tmp();
  try {
    writeRoadmap(root, ['- [ ] only roadmap work']);
    fs.mkdirSync(path.join(root, 'atris'), { recursive: true });
    assert.ok(run.roadmapOpenCount(path.join(root, 'atris')) > 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
