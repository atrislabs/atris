const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { checkPageStaleness } = require('../commands/clean');

function makeTempPage(sourceLines, compiledDate = '2026-04-20') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-stale-parse-'));
  fs.mkdirSync(path.join(dir, 'commands'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'commands', 'foo.js'), '// stub\n');
  const page = path.join(dir, 'page.md');
  const sources = sourceLines.map((s) => `  - ${s}`).join('\n');
  fs.writeFileSync(
    page,
    `---\nlast_compiled: ${compiledDate}\nsources:\n${sources}\n---\n\nbody\n`
  );
  return { dir, page };
}

test('staleness parser strips trailing (annotation) before stat', () => {
  const { dir, page } = makeTempPage([
    'commands/foo.js (foo function — inline annotation)'
  ]);
  try {
    const result = checkPageStaleness(dir, page);
    assert.equal(result, null, 'source exists, annotation should not break stat');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('staleness parser strips :line-range before stat', () => {
  const { dir, page } = makeTempPage(['commands/foo.js:10-42']);
  try {
    const result = checkPageStaleness(dir, page);
    assert.equal(result, null, ':10-42 should not be treated as part of filename');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('staleness parser strips :line and (annotation) together', () => {
  const { dir, page } = makeTempPage([
    'commands/foo.js:10-42 (fooHandler main entry)'
  ]);
  try {
    const result = checkPageStaleness(dir, page);
    assert.equal(result, null, 'both suffixes should strip cleanly');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('staleness still detects genuinely missing source', () => {
  const { dir, page } = makeTempPage(['commands/missing.js (does not exist)']);
  try {
    const result = checkPageStaleness(dir, page);
    assert.ok(result, 'truly-missing file should still be flagged');
    assert.match(result.staleSource, /\(missing\)/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('staleness still detects source mtime > last_compiled', () => {
  const { dir, page } = makeTempPage(
    ['commands/foo.js (stub)'],
    '2020-01-01'
  );
  try {
    const result = checkPageStaleness(dir, page);
    assert.ok(result, 'old last_compiled should flag');
    assert.equal(result.compiledDate, '2020-01-01');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
