const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { start, review, pass, readPlan, draftWordCounts, syncStates, slugify, listSessions } = require('../commands/write');

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-write-'));
}

function draftPath(root, slug) {
  return path.join(root, 'atris', 'writing', slug, 'draft.md');
}

test('start creates a plan with beats and a human-only draft scaffold', () => {
  const root = tmpRoot();
  const code = start(['My First Essay', '--dump', 'idea one. idea two.'], root);
  assert.equal(code, 0);
  const slug = slugify('My First Essay');
  const plan = readPlan(slug, root);
  assert.equal(plan.topic, 'My First Essay');
  assert.equal(plan.beats.length, 5);
  assert.ok(plan.beats.every((b) => b.state === ' '), 'all beats start empty');
  assert.match(plan.text, /- idea one\./);
  const draft = fs.readFileSync(draftPath(root, slug), 'utf8');
  assert.match(draft, /## Hook/);
  assert.match(draft, /## Landing/);
});

test('custom beats via --beats', () => {
  const root = tmpRoot();
  start(['Post', '--beats', 'Open | Middle | Close'], root);
  const plan = readPlan('post', root);
  assert.deepEqual(plan.beats.map((b) => b.title), ['Open', 'Middle', 'Close']);
});

test('start refuses to clobber an existing session', () => {
  const root = tmpRoot();
  assert.equal(start(['Same Topic'], root), 0);
  assert.equal(start(['Same Topic'], root), 2);
});

test('syncStates promotes a beat to drafted when the human writes words', () => {
  const root = tmpRoot();
  start(['Flow'], root);
  const file = draftPath(root, 'flow');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('## Hook\n', '## Hook\nThe first sentence I typed myself.\n'));
  const { beats, counts } = syncStates('flow', root);
  assert.equal(beats[0].state, '~');
  assert.equal(counts.get(1), 6);
  assert.equal(beats[1].state, ' ');
});

test('pass marks a drafted beat passed and refuses an empty one', () => {
  const root = tmpRoot();
  start(['Gate'], root);
  const file = draftPath(root, 'gate');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('## Hook\n', '## Hook\nWords are here now.\n'));
  syncStates('gate', root);
  assert.equal(pass(['1', 'gate'], root), 0);
  assert.equal(readPlan('gate', root).beats[0].state, 'x');
  assert.equal(pass(['2', 'gate'], root), 2, 'empty beat cannot pass');
});

test('sync never downgrades a passed beat', () => {
  const root = tmpRoot();
  start(['Keep'], root);
  const file = draftPath(root, 'keep');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('## Hook\n', '## Hook\nSolid opener here.\n'));
  syncStates('keep', root);
  pass(['1', 'keep'], root);
  const { beats } = syncStates('keep', root);
  assert.equal(beats[0].state, 'x');
});

test('review flags slop in the draft and exits 1; clean full draft exits 0', () => {
  const root = tmpRoot();
  start(['Taste', '--beats', 'Only'], root);
  const file = draftPath(root, 'taste');
  fs.writeFileSync(file, '# Taste\n\n## Only\nThis will seamlessly revolutionize writing.\n');
  assert.equal(review(['taste'], root), 1);
  fs.writeFileSync(file, '# Taste\n\n## Only\nA plain sentence in my own voice.\n');
  assert.equal(review(['taste'], root), 0);
});

test('review counts an empty beat as a gate failure', () => {
  const root = tmpRoot();
  start(['Holes', '--beats', 'A | B'], root);
  const file = draftPath(root, 'holes');
  fs.writeFileSync(file, '# Holes\n\n## A\nWritten.\n\n## B\n');
  assert.equal(review(['holes'], root), 1);
});

test('draft word counts ignore text outside known beats', () => {
  const root = tmpRoot();
  start(['Strays', '--beats', 'Known'], root);
  fs.writeFileSync(draftPath(root, 'strays'), '# Strays\nintro text before any beat\n\n## Known\ntwo words\n\n## Unknown Section\nnot counted\n');
  const counts = draftWordCounts('strays', readPlan('strays', root).beats, root);
  assert.equal(counts.get(1), 2);
});

test('listSessions finds sessions newest-first', () => {
  const root = tmpRoot();
  start(['First'], root);
  start(['Second'], root);
  const slugs = listSessions(root).map((s) => s.slug);
  assert.ok(slugs.includes('first') && slugs.includes('second'));
});

const { coach, dumpSeeds } = require('../commands/write');

test('offline coach asks a beat question and surfaces dump seeds, never edits the draft', () => {
  const root = tmpRoot();
  start(['Coach Me', '--dump', 'the seed with heat. another idea.'], root);
  const before = fs.readFileSync(draftPath(root, 'coach-me'), 'utf8');
  const code = coach(['coach-me', '--offline'], root);
  assert.equal(code, 0);
  assert.equal(fs.readFileSync(draftPath(root, 'coach-me'), 'utf8'), before, 'coach never touches the draft');
});

test('dumpSeeds extracts raw dump lines from the plan', () => {
  const root = tmpRoot();
  start(['Seeds', '--dump', 'first idea. second idea.'], root);
  const plan = readPlan('seeds', root);
  assert.deepEqual(dumpSeeds(plan.text), ['first idea.', 'second idea.']);
});
