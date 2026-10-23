'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildScorecardData: buildData } = require('../lib/scorecard');

const DATE = '2026-10-22';

function tickBlock(time, reward) {
  return [
    `- ${time}`,
    '  I ran an autopilot tick.',
    '  We are still on the x endgame.',
    '  Next tick will look for new work.',
    `  Reward: ${reward}`,
    '',
  ].join('\n');
}

test('an afternoon tick after a noon pick counts toward the reward', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-mut-L57-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const atrisDir = path.join(root, 'atris');
  fs.mkdirSync(path.join(atrisDir, 'logs', '2026'), { recursive: true });
  fs.writeFileSync(path.join(atrisDir, 'TODO.md'), '# TODO\n\n## Backlog\n\n## In Progress\n\n## Completed\n');
  fs.writeFileSync(path.join(atrisDir, 'lessons.md'), '# lessons\n');
  fs.writeFileSync(
    path.join(atrisDir, 'logs', '2026', `${DATE}.md`),
    `# Log, ${DATE}\n\n## Notes\n\n` + tickBlock('1:30 pm', 7) + '\n',
  );

  const data = buildData(atrisDir, { slug: 'x', pickedAt: `${DATE} 12:00` });
  assert.strictEqual(data.totalReward, 7);
});
