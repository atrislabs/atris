'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { planKeep, removeKeep } = require('../lib/campaign-keep');

test('removing a launch agent targets the current user login session', { skip: typeof process.getuid !== 'function' }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-remove-user-'));
  const plan = planKeep({ root: home, home, homeDir: home, platform: 'darwin' });
  let target;
  removeKeep(plan, {
    spawn(command, args) {
      if (command === 'launchctl' && args[0] === 'bootout') target = args[1];
      return { status: 0 };
    },
  });
  assert.equal(target, `gui/${process.getuid()}/${plan.label}`);
});
