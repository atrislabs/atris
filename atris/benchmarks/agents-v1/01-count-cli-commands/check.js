'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

module.exports = {
  id: 'count-cli-commands',
  title: 'Count the reachable CLI command registrations',
  category: 'navigate',
  async check(ctx) {
    const answersPath = path.join(ctx.workspace, 'answers.json');
    assert.equal(fs.existsSync(answersPath), true, 'answers.json missing');
    const answers = JSON.parse(fs.readFileSync(answersPath, 'utf8'));
    assert.deepEqual(answers, { count: 7 });
  },
};
