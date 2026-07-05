'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const OLD_NAME = /\btoMeters\b/;

function walk(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, files);
    else if (entry.name.endsWith('.js')) files.push(full);
  }
  return files;
}

module.exports = {
  id: 'rename-symbol',
  title: 'Rename a function across source and tests',
  category: 'edit',
  async check(ctx) {
    const testResult = ctx.run('npm', ['test']);
    assert.equal(testResult.status, 0, testResult.stderr || testResult.stdout);

    for (const file of walk(ctx.workspace)) {
      const text = fs.readFileSync(file, 'utf8');
      assert.equal(OLD_NAME.test(text), false, `${path.relative(ctx.workspace, file)} still mentions toMeters`);
    }

    const script = `
      const mod = require(${JSON.stringify(path.join(ctx.workspace, 'convert.js'))});
      if (typeof mod.toBaseUnits !== 'function') { console.error('toBaseUnits missing'); process.exit(1); }
      if (mod.toBaseUnits(2, 'km') !== 2000) { console.error('wrong result'); process.exit(1); }
      process.exit(0);
    `;
    const probe = ctx.run(process.execPath, ['-e', script]);
    assert.equal(probe.status, 0, probe.stderr || probe.stdout);
  },
};
