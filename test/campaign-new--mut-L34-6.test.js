'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { draftAndStart } = require('../lib/campaign-new');

test('empty team folders are not suggested as available members', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'member-roster-'));
  const cwd = process.cwd();
  const previousHome = process.env.HOME;
  const log = console.log;
  const error = console.error;
  const exit = process.exit;
  const prompts = [];
  fs.mkdirSync(path.join(home, 'atris', 'team', 'unfinished-member'), { recursive: true });
  fs.mkdirSync(path.join(home, 'atris', 'team', 'builder'), { recursive: true });
  fs.writeFileSync(path.join(home, 'atris', 'team', 'builder', 'MEMBER.md'), '# builder\n');
  process.env.HOME = home;
  process.chdir(home);
  console.log = () => {};
  console.error = () => {};
  process.exit = (code) => { throw new Error(`unexpected exit ${code}`); };
  try {
    await draftAndStart(['new', 'finish the interface', '--json'], { fail: () => 1 }, {
      goal: 'finish the interface',
      ask: async (root, view, prompt) => {
        prompts.push(prompt);
        return { ok: true, text: 'invalid draft' };
      },
    });
    assert.ok(prompts.some((prompt) => /Members who can work on it:.*builder/.test(prompt)));
    assert.equal(prompts.some((prompt) => prompt.includes('unfinished-member')), false);
  } finally {
    process.chdir(cwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    console.log = log;
    console.error = error;
    process.exit = exit;
  }
});
