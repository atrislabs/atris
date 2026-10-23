const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { collectWorkspaceContext } = require('../commands/visualize');

test('workspace context includes a document matched by a four-letter prompt word', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-visualize-four-letter-'));
  try {
    const contextDir = path.join(root, 'atris', 'context');
    fs.mkdirSync(contextDir, { recursive: true });
    fs.writeFileSync(path.join(contextDir, 'risk.md'), 'Review access before release.');
    fs.writeFileSync(path.join(contextDir, 'other.md'), 'Unrelated information.');

    assert.equal(
      collectWorkspaceContext('RISK', root),
      `${path.join('atris', 'context', 'risk.md')}:\nReview access before release.`
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
