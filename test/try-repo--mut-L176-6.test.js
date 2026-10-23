'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildRepoMap } = require('../lib/try-repo');

test('installed dependencies do not contribute Python to the repository languages', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-map-excluded-'));
  try {
    fs.mkdirSync(path.join(root, 'node_modules', 'dependency'), { recursive: true });
    fs.writeFileSync(path.join(root, 'node_modules', 'dependency', 'worker.py'), 'def dependency_worker():\n    pass\n');
    const map = buildRepoMap(root);
    assert.equal(map.languages.some((language) => language.name === 'Python'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
