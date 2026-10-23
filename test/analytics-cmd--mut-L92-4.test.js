const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { analyticsAtris } = require('../commands/analytics');

test('equally busy hours report the earliest hour', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-hour-tie-'));
  const cwd = process.cwd();
  const home = process.env.HOME;
  const log = console.log;
  const exit = process.exit;
  const lines = [];
  try {
    process.env.HOME = root;
    process.chdir(root);
    // Give every day in the reporting window the same tied activity.
    // Extra days keep the fixture valid across a midnight boundary.
    const anchor = new Date();
    for (let offset = -14; offset <= 1; offset++) {
      const day = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() + offset, 12);
      const year = String(day.getFullYear());
      const month = String(day.getMonth() + 1).padStart(2, '0');
      const date = String(day.getDate()).padStart(2, '0');
      const dir = path.join(root, 'atris', 'logs', year);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${year}-${month}-${date}.md`), '**09:15**\n**14:30**\n');
    }
    console.log = (...args) => lines.push(args.join(' '));
    process.exit = (code) => { throw new Error(`unexpected exit: ${code}`); };
    analyticsAtris();
    const hour = lines.find(line => /Most active hour:/.test(line));
    assert.match(hour || '', /Most active hour:\s*9:00\s*-/);
  } finally {
    console.log = log;
    process.exit = exit;
    process.chdir(cwd);
    if (home === undefined) delete process.env.HOME;
    else process.env.HOME = home;
  }
});
