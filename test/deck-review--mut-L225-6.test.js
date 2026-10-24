require('./helpers/clean-temp');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('a short stack can carry a subtitle without a clipping warning', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'stack-subtitle-'));
  const savedHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const { lintSpec } = require('../lib/deck-review');
    const findings = lintSpec({ slides: [{
      type: 'stack',
      heading: 'Delivery flow',
      layers: [
        { title: 'Plan', sub: 'Choose the next step.' },
        { title: 'Build', sub: 'Deliver the change.' },
      ],
      sub: 'Each step has an owner.',
    }] });
    assert.equal(findings.some((finding) => finding.rule === 'stack-sub-clip'), false);
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  }
});
