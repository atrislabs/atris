const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { addLesson } = require('../commands/lesson');

test('updating a lesson scope preserves its existing detector metadata', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lesson-metadata-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'atris'));
  const metadataPath = path.join(dir, 'atris', 'lessons.json');
  fs.writeFileSync(metadataPath, JSON.stringify({
    'preserve-detector': {
      detector: 'exit 1',
      scope: 'old-scope',
      status: 'open',
    },
  }));

  const result = addLesson(dir, 'preserve-detector', 'fail',
    'Keep the existing detector when updating scope.', { scope: 'new-scope' });

  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(metadataPath, 'utf8')), {
    'preserve-detector': {
      detector: 'exit 1',
      scope: 'new-scope',
      status: 'open',
    },
  });
});
