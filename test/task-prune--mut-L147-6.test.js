'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { folderGone } = require('../lib/task-prune');

test('an unresolvable symlink loop does not prove a project folder is gone', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-folder-loop-'));
  try {
    const link = path.join(dir, 'loop');
    fs.symlinkSync('loop', link);
    assert.equal(folderGone(path.join(link, 'project')), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
