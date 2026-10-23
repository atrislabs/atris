const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildSyncAllPlan } = require('../commands/sync');

test('a boot protocol document without business metadata stays a regular project', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-regular-boot-'));
  const previousHome = process.env.HOME;
  process.env.HOME = root;
  try {
    const projectRoot = path.join(root, 'project');
    fs.mkdirSync(path.join(projectRoot, 'atris'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'atris', 'atris.md'),
      '# Atris Boot Protocol\n\nProject instructions.\n');
    const { plan } = buildSyncAllPlan({ root, pkgRoot: path.resolve(__dirname, '..') });
    const entry = plan.find((item) => item.projectRoot === projectRoot);
    assert.strictEqual(entry.isBusiness, false);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
