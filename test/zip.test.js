'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createZipBuffer,
  readZipBuffer,
  ZIP_LIMITS,
} = require('../lib/zip');

const CENTRAL_DIRECTORY_HEADER = Buffer.from([0x50, 0x4b, 0x01, 0x02]);

test('zip reader returns valid stored content', () => {
  const zip = createZipBuffer([{ name: 'README.md', data: Buffer.from('# hello\n') }]);
  const entries = readZipBuffer(zip);

  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, 'README.md');
  assert.equal(entries[0].data.toString('utf8'), '# hello\n');
});

test('zip reader rejects the compressed archive limit before parsing', () => {
  assert.throws(
    () => readZipBuffer(Buffer.alloc(ZIP_LIMITS.maxZipBytes + 1)),
    /archive size .* exceeds .* byte limit/,
  );
});

test('zip reader rejects too many entries before inflating any content', () => {
  const entries = Array.from({ length: ZIP_LIMITS.maxEntries + 1 }, (_, index) => ({
    name: `files/${index}.txt`,
    data: Buffer.from('x'),
  }));
  const zip = createZipBuffer(entries);

  assert.throws(
    () => readZipBuffer(zip),
    /501 entries exceeds 500 entry limit/,
  );
});

test('zip reader rejects declared unpacked bytes before inflation', () => {
  const zip = createZipBuffer([{
    name: 'bomb.txt',
    data: Buffer.alloc(ZIP_LIMITS.maxUnpackedBytes + 1),
  }]);

  assert.ok(zip.length < ZIP_LIMITS.maxZipBytes, 'fixture should be highly compressed');
  assert.throws(
    () => readZipBuffer(zip),
    /entry bomb\.txt declares .* exceeding .* byte entry limit/,
  );
});

test('zip reader bounds inflation when actual output exceeds the declaration', () => {
  const zip = createZipBuffer([{
    name: 'false-size.txt',
    data: Buffer.alloc(1024 * 1024),
  }]);
  const centralOffset = zip.indexOf(CENTRAL_DIRECTORY_HEADER);
  assert.notEqual(centralOffset, -1);
  zip.writeUInt32LE(1, centralOffset + 24);

  assert.throws(
    () => readZipBuffer(zip),
    /inflated data exceeds declared size for false-size\.txt/,
  );
});

test('zip reader verifies checksums after inflation', () => {
  const zip = createZipBuffer([{ name: 'changed.txt', data: Buffer.from('content') }]);
  const centralOffset = zip.indexOf(CENTRAL_DIRECTORY_HEADER);
  assert.notEqual(centralOffset, -1);
  zip.writeUInt32LE((zip.readUInt32LE(centralOffset + 16) ^ 1) >>> 0, centralOffset + 16);

  assert.throws(
    () => readZipBuffer(zip),
    /checksum mismatch for changed\.txt/,
  );
});
