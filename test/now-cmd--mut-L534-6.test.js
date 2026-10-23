'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('preserving a custom note does not mistake a receipt count for generated content', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-custom-now-'));
  const previousHome = process.env.HOME;
  process.env.HOME = root;
  try {
    const { refreshNowFile } = require('../commands/now');
    const atrisDir = path.join(root, 'atris');
    fs.mkdirSync(atrisDir);
    fs.writeFileSync(path.join(atrisDir, 'MAP.md'), '# Team map\n');
    const notePath = path.join(atrisDir, 'now.md');
    fs.writeFileSync(notePath, [
      '# Team priorities',
      '',
      'Call the launch partner before publishing.',
      '',
      'Completed receipts today: 3',
      '',
    ].join('\n'));

    const result = refreshNowFile(root, { preserveCustom: true });

    assert.equal(result.preserved, true, 'a receipt count alone does not identify a generated note');
    assert.match(
      fs.readFileSync(notePath, 'utf8'),
      /Call the launch partner before publishing\./,
      'the author’s priority must survive the refresh',
    );
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});
