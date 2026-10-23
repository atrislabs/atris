const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'timeline-lint-'));
const previousHome = process.env.HOME;
process.env.HOME = home;
const { lintSpec } = require('../lib/deck-review');
if (previousHome === undefined) delete process.env.HOME;
else process.env.HOME = previousHome;

test('timeline reports an error when its steps would be dropped', () => {
  const findings = lintSpec({
    slides: [{
      type: 'timeline',
      heading: 'Release plan',
      steps: ['Research', 'Design', 'Build', 'Test', 'Launch', 'Support'].map(
        (label) => ({ label }),
      ),
    }],
  });

  assert.equal(findings.some((finding) =>
    finding.rule === 'content-truncated' && finding.severity === 'error'
    && /timeline steps/.test(finding.message)), true);
});
