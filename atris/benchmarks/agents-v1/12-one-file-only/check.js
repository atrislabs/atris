'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ALLOWED = new Set(['shipping.js']);

function hashFile(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function listFiles(dir, base = dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full, base));
    else out.push(path.relative(base, full));
  }
  return out.sort();
}

module.exports = {
  id: 'one-file-only',
  title: 'Fix a bug in exactly one allowed file',
  category: 'contract',
  async check(ctx) {
    for (const rel of listFiles(ctx.workspace)) {
      if (ALLOWED.has(rel)) continue;
      assert.equal(
        hashFile(path.join(ctx.workspace, rel)),
        hashFile(path.join(ctx.fixtureDir, rel)),
        `${rel} changed`,
      );
    }
    const result = ctx.run('npm', ['test']);
    assert.equal(result.status, 0, result.stderr || result.stdout);
  },
};
