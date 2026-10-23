const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildWeekReportData } = require('../commands/report');

test('buildWeekReportData includes career xp receipts at exact cutoff timestamp', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-report-cutoff-'));
  try {
    const days = 7;
    const dayMs = 24 * 60 * 60 * 1000;
    const now = 1700000000000;
    const cutoff = now - days * dayMs;

    const stateDir = path.join(tmpDir, '.atris', 'state');
    fs.mkdirSync(stateDir, { recursive: true });

    const receipt = {
      outcome: 'accepted',
      xp: 25,
      timestamp: cutoff,
    };

    fs.writeFileSync(
      path.join(stateDir, 'career_xp_receipts.jsonl'),
      JSON.stringify(receipt) + '\n',
      'utf8'
    );

    const data = buildWeekReportData(tmpDir, { days, now });

    assert.equal(data.xp.total, 25);
    assert.equal(data.xp.receipts.length, 1);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
