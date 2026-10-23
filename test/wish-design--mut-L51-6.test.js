const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { detectDesignContext } = require('../lib/wish-design');

test('unrelated package scripts do not advertise a design audit command', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-design-scripts-'));
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      scripts: { test: 'node --test' },
    }));

    assert.strictEqual(detectDesignContext(dir).auditCommand, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
