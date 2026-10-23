const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-whats-next-ask-'));
const savedHome = process.env.HOME;
process.env.HOME = tmpHome;
for (const key of Object.keys(process.env)) {
  if (key.startsWith('ATRIS_')) delete process.env[key];
}

const { renderWhatsNextAsk } = require('../lib/first-minute');

after(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

const ASK = 'say the next thing you want here, in your own words.';
const NEXT = 'next: atris "<the next thing you want>"';

test('names the shipped task, greets the person, and ends with the next command', () => {
  const out = renderWhatsNextAsk({
    person: 'maya',
    task: { title: 'Landing page for my bakery' },
    folder: 'bakery',
  });
  assert.strictEqual(
    out,
    `hey maya, Landing page for my bakery is shipped. ${ASK}\n\n${NEXT}`
  );
});

test('has the same three-part shape every time: line, blank line, next command', () => {
  const lines = renderWhatsNextAsk({ task: { title: 'Podcast intro' } }).split('\n');
  assert.strictEqual(lines.length, 3);
  assert.ok(lines[0].endsWith(`is shipped. ${ASK}`));
  assert.strictEqual(lines[1], '');
  assert.strictEqual(lines[2], NEXT);
});

test('no person means no greeting', () => {
  const out = renderWhatsNextAsk({ task: { title: 'Podcast intro' }, folder: 'studio' });
  assert.strictEqual(out.split('\n')[0], `Podcast intro is shipped. ${ASK}`);
  assert.ok(!out.includes('hey '));
});

test('no arguments falls back to "this folder" with no greeting', () => {
  assert.strictEqual(
    renderWhatsNextAsk(),
    `this folder is shipped. ${ASK}\n\n${NEXT}`
  );
});

test('missing, empty, or blank titles fall back to the folder name', () => {
  const folderLine = (task, folder) => renderWhatsNextAsk({ task, folder }).split('\n')[0];

  assert.strictEqual(folderLine(null, 'bakery'), `bakery is shipped. ${ASK}`);
  assert.strictEqual(folderLine({}, 'bakery'), `bakery is shipped. ${ASK}`);
  assert.strictEqual(folderLine({ title: '' }, 'bakery'), `bakery is shipped. ${ASK}`);
  assert.strictEqual(folderLine({ title: '   \n\t ' }, 'bakery'), `bakery is shipped. ${ASK}`);
});

test('an empty or null folder with no title becomes "this folder"', () => {
  assert.strictEqual(
    renderWhatsNextAsk({ task: null, folder: '' }).split('\n')[0],
    `this folder is shipped. ${ASK}`
  );
  assert.strictEqual(
    renderWhatsNextAsk({ task: { title: '' }, folder: null }).split('\n')[0],
    `this folder is shipped. ${ASK}`
  );
});

test('the folder is ignored when the task has a title', () => {
  const out = renderWhatsNextAsk({ task: { title: 'Tax notes' }, folder: 'some-room' });
  assert.ok(out.startsWith('Tax notes is shipped.'));
  assert.ok(!out.includes('some-room'));
});

test('title whitespace is collapsed and trailing punctuation is dropped', () => {
  const messy = renderWhatsNextAsk({ task: { title: '  spaced   out\n title!?  ' } });
  assert.strictEqual(messy.split('\n')[0], `spaced out title is shipped. ${ASK}`);

  const dotted = renderWhatsNextAsk({ task: { title: 'Landing page.' } });
  assert.strictEqual(dotted.split('\n')[0], `Landing page is shipped. ${ASK}`);
});

test('a long title is cut at a word boundary, under 80 characters', () => {
  const title = 'word '.repeat(30).trim();
  const first = renderWhatsNextAsk({ task: { title } }).split('\n')[0];
  const spoken = first.slice(0, first.indexOf(' is shipped.'));

  assert.strictEqual(spoken, Array(15).fill('word').join(' '));
  assert.ok(spoken.length < 80);
  assert.ok(first.endsWith(`is shipped. ${ASK}`));
});

test('a long title with no spaces is cut hard at 77 characters', () => {
  const first = renderWhatsNextAsk({ task: { title: 'x'.repeat(100) } }).split('\n')[0];
  assert.strictEqual(first, `${'x'.repeat(77)} is shipped. ${ASK}`);
});

test('a title of exactly 80 characters is left whole', () => {
  const title = 'y'.repeat(80);
  const first = renderWhatsNextAsk({ task: { title } }).split('\n')[0];
  assert.strictEqual(first, `${title} is shipped. ${ASK}`);
});

test('a non-string title is turned into text instead of throwing', () => {
  const first = renderWhatsNextAsk({ task: { title: 12345 } }).split('\n')[0];
  assert.strictEqual(first, `12345 is shipped. ${ASK}`);
});

test('does not change the task it is given', () => {
  const task = { title: 'Original title.', status: 'done' };
  const copy = JSON.parse(JSON.stringify(task));
  renderWhatsNextAsk({ person: 'sam', task, folder: 'room' });
  assert.deepStrictEqual(task, copy);
});
