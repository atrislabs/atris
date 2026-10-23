'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { searchCommand } = require('../commands/search');

test('search prints the wiki page that matched the query', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-search-wiki-'));
  try {
    fs.mkdirSync(path.join(root, 'atris', 'wiki'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'atris', 'wiki', 'quill-notes.md'),
      '# notes\n\nthe quizzlestick lives here\n'
    );

    const logs = [];
    const originalLog = console.log;
    console.log = (...args) => logs.push(args.join(' '));
    let code;
    try {
      code = searchCommand(['quizzlestick'], { root });
    } finally {
      console.log = originalLog;
    }

    assert.strictEqual(code, 0);
    const wikiLine = logs.join('\n').split('\n').find(line => line.startsWith('Wiki:'));
    assert.ok(wikiLine, 'expected a Wiki result line');
    assert.ok(wikiLine.includes('atris/wiki/quill-notes.md'), `Wiki line was: ${wikiLine}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
