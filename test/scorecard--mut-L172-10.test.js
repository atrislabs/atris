const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildScorecardData } = require('../lib/scorecard');

test('scorecard counts lessons dated on or after the picked date', () => {
  const atrisDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scorecard-lessons-'));
  try {
    fs.writeFileSync(path.join(atrisDir, 'TODO.md'), '# Tasks\n');
    fs.writeFileSync(path.join(atrisDir, 'lessons.md'), [
      '# Lessons',
      '- **[2001-02-02] older lesson**',
      '- **[2001-02-03] same-day lesson**',
      '- **[2001-02-04] later lesson**',
      '- unrelated note',
      '',
    ].join('\n'));

    const scorecard = buildScorecardData(atrisDir, {
      slug: 'lesson-count',
      pickedAt: '2001-02-03 12:00',
    });

    assert.equal(scorecard.lessonsGenerated, 2);
  } finally {
    fs.rmSync(atrisDir, { recursive: true, force: true });
  }
});
