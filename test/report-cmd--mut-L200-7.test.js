const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildWeekReportData } = require('../commands/report');

test('career xp receipt title takes precedence over its goal', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-report-title-'));
  try {
    const stateDir = path.join(dir, '.atris', 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'career_xp_receipts.jsonl'), `${JSON.stringify({
      receipt_id: 'task_review:title-priority',
      outcome: 'accepted',
      xp: 8,
      title: 'Ship the weekly report',
      goal: 'Improve reporting',
      accepted_at: '2026-07-04T12:00:00Z',
    })}\n`, 'utf8');

    const data = buildWeekReportData(dir, {
      days: 7,
      now: Date.parse('2026-07-05T12:00:00Z'),
    });

    assert.deepEqual(data.xp.receipts.map(receipt => receipt.title), ['Ship the weekly report']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
