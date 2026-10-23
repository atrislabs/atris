const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { stageWikiIngest } = require('../lib/wiki');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-stage-wiki-ingest-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const RealDate = Date;
  // Use fixed local components so the expected calendar day is timezone independent.
  t.mock.method(global, 'Date', class extends RealDate {
    constructor(...args) {
      super(...(args.length ? args : [2024, 0, 15, 12, 34, 0]));
    }
  });
  return root;
}

function assertManifest(root, result) {
  assert.deepStrictEqual(
    JSON.parse(fs.readFileSync(path.join(root, result.manifestPath), 'utf8')),
    result.manifest,
  );
  assert.strictEqual(result.manifest.ingested_at, '2024-01-15 12:34');
  assert.strictEqual(result.manifest.pack_path, result.packPath);
  assert.strictEqual(result.manifestPath, `${result.packPath}/manifest.json`);
}

test('stageWikiIngest copies a directory and records every nested source file', (t) => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, 'Source Pack', 'nested'), { recursive: true });
  fs.writeFileSync(path.join(root, 'Source Pack', 'notes.md'), '# Evidence\n');
  fs.writeFileSync(path.join(root, 'Source Pack', 'nested', 'data.txt'), 'raw data\n');

  const result = stageWikiIngest(root, '  Source Pack  ');
  const staged = 'atris/context/_ingest/2024-01-15-1234-source-pack/Source Pack';
  assert.strictEqual(result.contextDir, 'atris/context');
  assert.strictEqual(result.promptSource, staged);
  assert.strictEqual(result.manifest.source_input, 'Source Pack');
  assert.strictEqual(result.manifest.mode, 'public');
  assert.strictEqual(result.manifest.entries.length, 1);
  const entry = result.manifest.entries[0];
  assert.deepStrictEqual({ ...entry, files: [...entry.files].sort() }, {
    kind: 'directory', original: 'Source Pack', staged, file_count: 2,
    files: [`${staged}/nested/data.txt`, `${staged}/notes.md`],
  });
  assert.strictEqual(fs.readFileSync(path.join(root, staged, 'notes.md'), 'utf8'), '# Evidence\n');
  assert.strictEqual(fs.readFileSync(path.join(root, staged, 'nested/data.txt'), 'utf8'), 'raw data\n');
  fs.writeFileSync(path.join(root, staged, 'notes.md'), 'changed copy');
  assert.strictEqual(fs.readFileSync(path.join(root, 'Source Pack/notes.md'), 'utf8'), '# Evidence\n');
  assertManifest(root, result);
});

test('stageWikiIngest reuses a file already in private context without copying it', (t) => {
  const root = fixture(t);
  const source = '.atris/presidio/context/evidence.md';
  fs.mkdirSync(path.dirname(path.join(root, source)), { recursive: true });
  fs.writeFileSync(path.join(root, source), 'private evidence\n');

  const result = stageWikiIngest(root, source, 'private');
  assert.strictEqual(result.contextDir, '.atris/presidio/context');
  assert.strictEqual(result.manifest.mode, 'private');
  assert.strictEqual(result.promptSource, source);
  assert.deepStrictEqual(result.manifest.entries, [{
    kind: 'file', original: source, staged: source, file_count: 1, files: [source],
  }]);
  assert.deepStrictEqual(fs.readdirSync(path.join(root, result.packPath)), ['manifest.json']);
  assert.strictEqual(fs.readFileSync(path.join(root, source), 'utf8'), 'private evidence\n');
  assert.strictEqual(fs.existsSync(path.join(root, 'atris/context')), false);
  assertManifest(root, result);
});

test('stageWikiIngest records a URL as a local link without fetching it', (t) => {
  const root = fixture(t);
  const url = 'https://example.invalid/source';
  const result = stageWikiIngest(root, `  ${url}\n`);
  const staged = `${result.packPath}/links.txt`;
  assert.strictEqual(result.promptSource, staged);
  assert.strictEqual(result.manifest.source_input, url);
  assert.deepStrictEqual(result.manifest.entries, [{
    kind: 'url', original: url, staged, file_count: 1, files: [staged],
  }]);
  assert.strictEqual(fs.readFileSync(path.join(root, staged), 'utf8'), `${url}\n`);
  assertManifest(root, result);
});

test('stageWikiIngest preserves empty and missing sources as unresolved requests', (t) => {
  const root = fixture(t);
  for (const [input, raw, original] of [
    [undefined, '', '(empty)'],
    [' \n\t ', '', '(empty)'],
    [' missing.md ', 'missing.md', 'missing.md'],
  ]) {
    const result = stageWikiIngest(root, input);
    const staged = `${result.packPath}/request.txt`;
    assert.strictEqual(result.manifest.source_input, raw);
    assert.strictEqual(result.promptSource, staged);
    assert.deepStrictEqual(result.manifest.entries, [{
      kind: 'unresolved', original, staged, file_count: 1, files: [staged],
    }]);
    assert.strictEqual(fs.readFileSync(path.join(root, staged), 'utf8'), `${original}\n`);
    assertManifest(root, result);
  }
  assert.strictEqual(fs.existsSync(path.join(root, 'missing.md')), false);
});
