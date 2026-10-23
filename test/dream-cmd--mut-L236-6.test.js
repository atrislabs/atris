'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dream = require('../commands/dream');

// The runner inside dreamCommand must spawn the haiku profile's bin string
// ('claude'). If bin is the profile object instead, path.basename throws
// before spawn, the run lands as 'could not finish dream', and no cards are
// written. A fake `claude` on PATH returns two valid cards so the real spawn
// path completes with no engine.
test('dreamCommand spawns the haiku bin string and writes cards', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dream-mut-l236-'));

  // Journal content is not date-filtered, so a fixed old date keeps this
  // test independent of the day it runs on.
  const logDir = path.join(root, 'atris', 'logs', '2020');
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(path.join(logDir, '2020-01-01.md'), '# Log\n\n- shipped a loop\n', 'utf8');

  const binDir = path.join(root, 'bin');
  fs.mkdirSync(binDir);
  fs.writeFileSync(
    path.join(binDir, 'claude'),
    '#!/bin/sh\n' +
      'printf \'%s\\n\' \'[{"title":"one two three","why":"first why","move":"first move"},' +
      '{"title":"two three four","why":"second why","move":"second move"}]\'\n',
    { mode: 0o755 },
  );

  const previousPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${previousPath || '/usr/bin:/bin'}`;

  const lines = [];
  let code;
  try {
    code = await dream.dreamCommand(['--yes'], root, {
      log: (line) => lines.push(String(line)),
      stamp: '2020-01-02T00:00:00.000Z',
      timeoutMs: 30000,
    });
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }

  try {
    assert.equal(code, 0);
    assert.match(lines.join('\n'), /Dreamed 2 cards\./);

    const rows = fs.readFileSync(path.join(root, '.atris', 'state', 'dreams.jsonl'), 'utf8')
      .trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    assert.deepEqual(rows, [
      { ts: '2020-01-02T00:00:00.000Z', title: 'one two three', why: 'first why', move: 'first move', source: 'dream' },
      { ts: '2020-01-02T00:00:00.000Z', title: 'two three four', why: 'second why', move: 'second move', source: 'dream' },
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
