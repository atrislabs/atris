const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('a title data panel contributes to the boxed slide fatigue warning', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'title-panel-lint-'));
  const savedHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const { lintSpec } = require('../lib/deck-review');
    const findings = lintSpec({
      slides: [
        { type: 'title', headline: 'Quarterly results', panel: { rows: [{ title: 'Revenue', value: '$2m' }] } },
        { type: 'receipt', heading: 'Evidence', fields: [{ k: 'Customers', v: '120' }] },
        { type: 'metricgrid', heading: 'Growth', metrics: [{ value: '20%', label: 'Revenue growth' }] },
        { type: 'chips', heading: 'Markets', chips: ['Retail', 'Healthcare'] },
      ],
    });
    assert.strictEqual(findings.some((finding) => finding.rule === 'template-fatigue'), true);
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  }
});
