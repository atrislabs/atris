const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseLiveOptions } = require('../commands/live');

test('an explicit business overrides the current workspace business', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'business-override-'));
  const previousHome = process.env.HOME;
  process.env.HOME = dir;
  try {
    fs.mkdirSync(path.join(dir, '.atris'));
    fs.writeFileSync(path.join(dir, '.atris', 'business.json'), JSON.stringify({ slug: 'current-business' }));
    const options = parseLiveOptions(['requested-business', '--once'], dir);
    assert.equal(options.slug, 'requested-business');
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});
