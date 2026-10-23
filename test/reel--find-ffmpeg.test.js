const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { findFfmpeg } = require('../commands/reel');

const candidates = [
  '/opt/homebrew/bin/ffmpeg',
  '/usr/local/bin/ffmpeg',
  '/usr/bin/ffmpeg',
];

function sandbox(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-find-ffmpeg-'));
  const previousPath = process.env.PATH;
  process.env.PATH = dir;
  const existsSync = fs.existsSync;
  // Redirect only the fixed system probes to real files in our sandbox.
  // PATH lookup still uses the real shell and real executable permissions.
  t.mock.method(fs, 'existsSync', (file) => {
    const index = candidates.indexOf(file);
    return existsSync(index < 0 ? file : path.join(dir, `candidate-${index}`));
  });
  t.after(() => {
    t.mock.restoreAll();
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

test('findFfmpeg prefers fixed locations in order over PATH', (t) => {
  const dir = sandbox(t);
  for (let index = 0; index < candidates.length; index++) {
    fs.writeFileSync(path.join(dir, `candidate-${index}`), '');
  }
  fs.writeFileSync(path.join(dir, 'ffmpeg'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  for (let index = 0; index < candidates.length; index++) {
    assert.strictEqual(findFfmpeg(), candidates[index]);
    fs.unlinkSync(path.join(dir, `candidate-${index}`));
  }
});

test('findFfmpeg finds a real executable on PATH', (t) => {
  const dir = sandbox(t);
  const binary = path.join(dir, 'ffmpeg');
  fs.writeFileSync(binary, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  assert.strictEqual(findFfmpeg(), binary);
});

test('findFfmpeg returns null when no candidate or PATH executable exists', (t) => {
  sandbox(t);
  assert.strictEqual(findFfmpeg(), null);
});
