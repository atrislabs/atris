const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseLiveOptions } = require('../commands/live');

test('saved workspace slug takes priority over its canonical alias', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'slug-priority-'));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  try {
    fs.mkdirSync(path.join(home, '.atris'));
    fs.writeFileSync(path.join(home, '.atris', 'business.json'), JSON.stringify({
      business_id: 'biz-acme',
      slug: 'old-acme',
      canonical_slug: 'acme',
      name: 'Acme Co',
    }));
    assert.strictEqual(parseLiveOptions(['--once'], home).slug, 'old-acme');
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});
