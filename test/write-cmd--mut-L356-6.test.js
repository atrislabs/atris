'use strict';

const test = require('node:test');
const assert = require('node:assert').strict;
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { start, coach } = require('../commands/write');

// Runs coach with console output captured and PATH pointed at a stub engine,
// restoring everything when the test ends.
function runCoach(t, argv, root, engineBody) {
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(
    path.join(bin, 'claude'),
    `#!/bin/sh\n[ "$1" = "--version" ] && { echo 1.0; exit 0; }\n${engineBody}\n`,
    { mode: 0o755 }
  );
  const savedPath = process.env.PATH;
  process.env.PATH = bin + path.delimiter + (savedPath || '/usr/bin:/bin');
  const out = [];
  const err = [];
  const log = console.log;
  const error = console.error;
  console.log = (...parts) => out.push(parts.join(' '));
  console.error = (...parts) => err.push(parts.join(' '));
  t.after(() => {
    console.log = log;
    console.error = error;
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
  });
  try {
    const code = coach(argv, root);
    return { code, out: out.join('\n'), err: err.join('\n') };
  } finally {
    console.log = log;
    console.error = error;
  }
}

test('a failed engine answer is not trusted just because it printed a question marker', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-write-mut-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'atris'));
  fs.writeFileSync(path.join(root, 'atris', 'ROSTER.md'), '# roster\n\n## build\n- claude\n');
  assert.equal(start(['Probe', '--beats', 'Open | Close'], root), 0);

  // The engine dies with a nonzero status after printing its answer block.
  const r = runCoach(t, ['probe'], root, 'printf "QUESTION: leaked marker qqq\\nLESSON: marker lll\\n"\nexit 7\n');

  assert.equal(r.code, 0);
  assert.match(r.out, /falling back to the offline coach/);
  assert.ok(!r.out.includes('leaked marker qqq'), 'a dead engine answer must not reach the writer');
});
