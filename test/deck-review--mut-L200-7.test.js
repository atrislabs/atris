const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('an oversized bullet list is reported as a truncation error', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bullet-overflow-'));
  const savedHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const { lintSpec } = require('../lib/deck-review');
    const findings = lintSpec({
      slides: [{
        type: 'bullets',
        heading: 'Next steps',
        items: Array.from({ length: 8 }, (_, i) => `Step ${i + 1}`),
      }],
    });
    assert.strictEqual(
      findings.find((finding) => finding.rule === 'content-truncated')?.severity,
      'error',
    );
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  }
});
