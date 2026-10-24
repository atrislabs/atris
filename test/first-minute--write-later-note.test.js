const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { writeLaterNote } = require('../lib/first-minute');

function makeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-write-later-note-'));
}

function notePath(root) {
  return path.join(root, '.atris-later');
}

function removeRoot(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

test('writeLaterNote saves a cleaned sentence and replaces the previous note', () => {
  const root = makeRoot();
  try {
    const first = writeLaterNote(root, '  Ship   the\nnotes!!!  ');
    assert.strictEqual(first, 'Ship the notes');
    assert.strictEqual(fs.readFileSync(notePath(root), 'utf8'), 'Ship the notes\n');

    const second = writeLaterNote(root, 'finish the notes app.');
    assert.strictEqual(second, 'finish the notes app');
    assert.strictEqual(fs.readFileSync(notePath(root), 'utf8'), 'finish the notes app\n');
  } finally {
    removeRoot(root);
  }
});

test('writeLaterNote clips a long sentence on a word boundary', () => {
  const root = makeRoot();
  try {
    const sentence = 'finish the notes before the friday demo and then send the written recap to the whole team';
    const saved = writeLaterNote(root, sentence);
    assert.strictEqual(
      saved,
      'finish the notes before the friday demo and then send the written...',
    );
    assert.strictEqual(saved.length <= 72, true);
    assert.strictEqual(fs.readFileSync(notePath(root), 'utf8'), `${saved}\n`);
  } finally {
    removeRoot(root);
  }
});

test('writeLaterNote writes nothing for an empty or punctuation-only sentence', () => {
  const root = makeRoot();
  try {
    assert.strictEqual(writeLaterNote(root, ''), '');
    assert.strictEqual(writeLaterNote(root, '   \n\t  '), '');
    assert.strictEqual(writeLaterNote(root, '???'), '');
    assert.strictEqual(fs.existsSync(notePath(root)), false);
  } finally {
    removeRoot(root);
  }
});

test('writeLaterNote throws when the folder does not exist and leaves no note', () => {
  const root = makeRoot();
  try {
    const missing = path.join(root, 'missing-room');
    assert.throws(
      () => writeLaterNote(missing, 'finish the notes app'),
      (err) => err && err.code === 'ENOENT',
    );
    assert.strictEqual(fs.existsSync(path.join(missing, '.atris-later')), false);
    assert.strictEqual(fs.existsSync(notePath(root)), false);
  } finally {
    removeRoot(root);
  }
});
