const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { upsertAgentsOpeningLines } = require('../lib/opening-lines');

test('an opening marker without a closing marker does not duplicate project notes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-unfinished-block-'));
  const file = path.join(dir, 'AGENTS.md');
  fs.writeFileSync(file, '## Project notes\n\nThese are the project notes: keep the deployment instructions here\n<!-- ATRIS_OPERATING_RULES:START -->\n');
  upsertAgentsOpeningLines(file, '- **Accuracy.** Check the result.');
  assert.equal(fs.readFileSync(file, 'utf8').split('keep the deployment instructions here').length - 1, 1);
});
