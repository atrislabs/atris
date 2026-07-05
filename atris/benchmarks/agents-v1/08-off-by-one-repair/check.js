'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');

module.exports = {
  id: 'off-by-one-repair',
  title: 'Repair an off-by-one pagination bug',
  category: 'edit',
  async check(ctx) {
    const testResult = ctx.run('npm', ['test']);
    assert.equal(testResult.status, 0, testResult.stderr || testResult.stdout);

    const storePath = path.join(ctx.workspace, 'store.js');
    const script = `
      const { paginate } = require(${JSON.stringify(storePath)});
      const items = Array.from({ length: 7 }, (_, i) => String.fromCharCode(97 + i));
      let collected = [];
      for (let page = 1; page <= 4; page += 1) {
        const chunk = paginate(items, page, 2);
        if (chunk.length > 2) { console.error('page ' + page + ' too long: ' + JSON.stringify(chunk)); process.exit(1); }
        collected = collected.concat(chunk);
      }
      if (JSON.stringify(collected) !== JSON.stringify(items)) {
        console.error('mismatch: ' + JSON.stringify(collected));
        process.exit(1);
      }
      process.exit(0);
    `;
    const hidden = ctx.run(process.execPath, ['-e', script]);
    assert.equal(hidden.status, 0, hidden.stderr || hidden.stdout);
  },
};
