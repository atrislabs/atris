'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { memberReport } = require('../lib/member-report');

test('members with more completed work rank ahead of alphabetically earlier names', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'team-ranking-'));
  const home = process.env.HOME;
  process.env.HOME = root;
  try {
    for (const [member, titles] of [['ada', ['Update guide']], ['zoe', ['Fix import', 'Ship export']]]) {
      const logs = path.join(root, 'atris', 'team', member, 'logs');
      fs.mkdirSync(logs, { recursive: true });
      fs.writeFileSync(path.join(root, 'atris', 'team', member, 'MEMBER.md'), `# ${member}\n`);
      fs.writeFileSync(path.join(logs, '2020-06-15.md'), titles.map((title, i) =>
        `## ${String(8 + i).padStart(2, '0')}:00 · Task completed\n- title: ${title}\n`
      ).join('\n'));
    }
    const report = memberReport(root, { since: 'today', now: new Date(2020, 5, 15, 12), tasks: [], merges: [] });
    assert.strictEqual(report.members[0].member, 'zoe');
  } finally {
    if (home === undefined) delete process.env.HOME;
    else process.env.HOME = home;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
