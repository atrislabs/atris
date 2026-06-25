'use strict';

// Proves the loop reads ROADMAP.md and ADVANCES, without a live runner. ROADMAP
// state is the single source of truth: the loop claims an item with `- [~]` in
// the Open loop items section, and the work gate (hasWork via pickRoadmapSeed)
// and the seed picker both read that state through one shared, section-scoped,
// today's-file extractor, so they can never disagree and the loop can't spin.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const nm = require('../lib/next-moves');
const {
  pickRoadmapSeed, seedInboxFromMove, latestInboxItems, recordDecision,
  moveId, claimRoadmapItem, todayLogFile, readRoadmapOpenItems,
} = nm;
const run = require('../commands/run');

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-run-roadmap-'));
}
function writeRoadmap(root, items) {
  fs.writeFileSync(path.join(root, 'ROADMAP.md'), `# R\n\n## Open loop items\n\n${items.join('\n')}\n\n## Other\n\ntext\n`, 'utf8');
}
function clearInbox(root) {
  const { file } = todayLogFile(root);
  fs.writeFileSync(file, '# x\n\n## Inbox\n\n## Notes\n', 'utf8');
}

test('roadmapOpenCount counts open ROADMAP items (raw utility)', () => {
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
    assert.equal(run.hasInboxOrBacklogWork(atrisDir), false);
    assert.equal(run.hasWork(atrisDir), true, 'a seedable roadmap item is work');
    const pick = pickRoadmapSeed(process.cwd());
    seedInboxFromMove(process.cwd(), { title: pick.title, source: 'roadmap' });
    claimRoadmapItem(process.cwd(), pick.title);
    assert.equal(run.hasInboxOrBacklogWork(atrisDir), true, 'seed must land where the gate reads');
  } finally {
    process.chdir(cwd);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the loop ADVANCES: a handled item is marked [x] and not re-pulled', () => {
  const root = tmp();
  try {
    writeRoadmap(root, ['- [ ] ship the thing', '- [ ] second thing']);
    const p1 = pickRoadmapSeed(root);
    assert.equal(p1.title, 'ship the thing');
    seedInboxFromMove(root, { title: p1.title, source: 'roadmap' });
    claimRoadmapItem(root, p1.title);
    assert.match(fs.readFileSync(path.join(root, 'ROADMAP.md'), 'utf8'), /- \[~\] ship the thing/);
    clearInbox(root);
    assert.equal(latestInboxItems(root).length, 0);
    const p2 = pickRoadmapSeed(root);
    assert.equal(p2.title, 'second thing', 'must advance via [x], not re-pull');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('hasWork stops the loop once every roadmap item is handled (no empty-inbox spin)', () => {
  const root = tmp();
  const cwd = process.cwd();
  try {
    writeRoadmap(root, ['- [ ] only item']);
    fs.mkdirSync(path.join(root, 'atris'), { recursive: true });
    process.chdir(root);
    const atrisDir = path.join(process.cwd(), 'atris');
    assert.equal(run.hasWork(atrisDir), true);
    claimRoadmapItem(process.cwd(), 'only item');
    assert.equal(run.hasWork(atrisDir), false, 'all handled -> the loop breaks deterministically');
  } finally {
    process.chdir(cwd);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a killed roadmap item does not keep the loop awake', () => {
  const root = tmp();
  const cwd = process.cwd();
  try {
    writeRoadmap(root, ['- [ ] kill this']);
    fs.mkdirSync(path.join(root, 'atris'), { recursive: true });
    recordDecision(root, { id: moveId('roadmap', 'kill this'), title: 'kill this', source: 'roadmap' }, 'kill', 's');
    process.chdir(root);
    assert.equal(run.hasWork(path.join(process.cwd(), 'atris')), false, 'killed item is not seedable');
  } finally {
    process.chdir(cwd);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an approved roadmap item is not re-seeded by the idle loop', () => {
  const root = tmp();
  try {
    writeRoadmap(root, ['- [ ] approve me', '- [ ] next one']);
    recordDecision(root, { id: moveId('roadmap', 'approve me'), title: 'approve me', source: 'roadmap' }, 'approve', 's');
    assert.equal(pickRoadmapSeed(root).title, 'next one', 'approved item is skipped');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('seedInboxFromMove inserts a $-laden title literally (no replacement injection)', () => {
  const root = tmp();
  try {
    const r = seedInboxFromMove(root, { title: 'cost is $1 and $$ and $& done', source: 'roadmap' });
    assert.match(fs.readFileSync(r.file, 'utf8'), /- \*\*I1:\*\* cost is \$1 and \$\$ and \$& done/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('claimRoadmapItem only flips the in-section line; a same-title line elsewhere is untouched', () => {
  const root = tmp();
  try {
    fs.writeFileSync(path.join(root, 'ROADMAP.md'),
      '# R\n\n## Big jobs\n\n- [ ] alpha\n\n## Open loop items\n\n- [ ] alpha\n\n## Other\n\nx\n', 'utf8');
    const p1 = pickRoadmapSeed(root);
    assert.equal(p1.title, 'alpha');
    claimRoadmapItem(root, p1.title);
    const text = fs.readFileSync(path.join(root, 'ROADMAP.md'), 'utf8');
    // the Big jobs copy stays [ ]; the Open loop items copy is claimed [~]
    assert.match(text, /## Big jobs\n\n- \[ \] alpha/);
    assert.match(text, /## Open loop items\n\n- \[~\] alpha/);
    // and the loop advances (no re-seed of the same item)
    assert.equal(pickRoadmapSeed(root), null, 'the only open-loop item is now claimed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('pickRoadmapSeed ignores a PRIOR-day inbox duplicate (no premature stop)', () => {
  const root = tmp();
  const cwd = process.cwd();
  try {
    writeRoadmap(root, ['- [ ] only item']);
    fs.mkdirSync(path.join(root, 'atris', 'logs', '2020'), { recursive: true });
    // an old journal lists it; today's file does not exist (date-independent)
    fs.writeFileSync(path.join(root, 'atris', 'logs', '2020', '2020-01-01.md'),
      '# x\n\n## Inbox\n\n- **I1:** only item\n\n## Notes\n', 'utf8');
    assert.equal(pickRoadmapSeed(root).title, 'only item', 'a prior-day inbox copy must not suppress today');
    process.chdir(root);
    assert.equal(run.hasWork(path.join(process.cwd(), 'atris')), true);
  } finally {
    process.chdir(cwd);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the work gate sees an inbox item under a ### subheading (gate matches the picker boundary)', () => {
  const root = tmp();
  const cwd = process.cwd();
  try {
    fs.mkdirSync(path.join(root, 'atris'), { recursive: true });
    const { file } = todayLogFile(root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '# x\n\n## Inbox\n\n### sub\n\n- **I1:** item under sub\n\n## Notes\n', 'utf8');
    process.chdir(root);
    assert.equal(run.hasInboxOrBacklogWork(path.join(process.cwd(), 'atris')), true);
  } finally {
    process.chdir(cwd);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('seedInboxFromMove is idempotent by title (no duplicate inbox line)', () => {
  const root = tmp();
  try {
    const r1 = seedInboxFromMove(root, { title: 'do the thing', source: 'roadmap' });
    assert.equal(r1.nextId, 1);
    const r2 = seedInboxFromMove(root, { title: 'DO the thing', source: 'roadmap' });
    assert.equal(r2.alreadyPresent, true, 'a case-variant duplicate is not appended');
    const lines = fs.readFileSync(r1.file, 'utf8').split('\n').filter((l) => /do the thing/i.test(l));
    assert.equal(lines.length, 1, 'exactly one inbox line');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readRoadmapOpenItems keeps items under a ### subheading inside the section', () => {
  const root = tmp();
  try {
    fs.writeFileSync(path.join(root, 'ROADMAP.md'),
      '# R\n\n## Open loop items\n\n- [ ] alpha\n\n### sub\n\n- [ ] beta\n\n## Big jobs\n\n- [ ] not this\n', 'utf8');
    assert.deepEqual(readRoadmapOpenItems(root).map((i) => i.title), ['alpha', 'beta']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a seed into a "## Inbox (raw ideas)" header is still seen by the work gate', () => {
  const root = tmp();
  const cwd = process.cwd();
  try {
    fs.mkdirSync(path.join(root, 'atris'), { recursive: true });
    const { file } = todayLogFile(root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '# x\n\n## Inbox (raw ideas)\n\n## Notes\n', 'utf8');
    seedInboxFromMove(root, { title: 'seeded item', source: 'roadmap' });
    process.chdir(root);
    assert.equal(run.hasInboxOrBacklogWork(path.join(process.cwd(), 'atris')), true);
  } finally {
    process.chdir(cwd);
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
    seedInboxFromMove(root, { title: 'ship the thing', source: 'roadmap' });
    assert.equal(pickRoadmapSeed(root).title, 'second thing');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
