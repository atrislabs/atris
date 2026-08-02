'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const LOCAL_FILE_HEADER = 0x04034b50;
const CENTRAL_DIRECTORY_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const UTF8_FLAG = 0x0800;
const DEFLATE = 8;
const STORE = 0;

const ZIP_LIMITS = Object.freeze({
  maxZipBytes: 5 * 1024 * 1024,
  maxUnpackedBytes: 20 * 1024 * 1024,
  maxEntryBytes: 20 * 1024 * 1024,
  maxEntries: 500,
});

let crcTable = null;

function getCrcTable() {
  if (crcTable) return crcTable;
  crcTable = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let j = 0; j < 8; j += 1) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    crcTable[i] = c >>> 0;
  }
  return crcTable;
}

function crc32(data) {
  const table = getCrcTable();
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data || '');
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(dateValue) {
  const date = dateValue instanceof Date && Number.isFinite(dateValue.getTime())
    ? dateValue
    : new Date();
  const year = Math.max(1980, Math.min(2107, date.getFullYear()));
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const hours = date.getHours();
  const minutes = date.getMinutes();
  const seconds = Math.floor(date.getSeconds() / 2);
  return {
    date: ((year - 1980) << 9) | (month << 5) | day,
    time: (hours << 11) | (minutes << 5) | seconds,
  };
}

function normalizeEntryName(name) {
  return String(name || '').replace(/\\/g, '/');
}

function assertUInt32(value, label) {
  if (!Number.isFinite(value) || value < 0 || value > 0xffffffff) {
    throw new Error(`zip ${label} is too large`);
  }
}

function createZipBuffer(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const name = normalizeEntryName(entry.name);
    if (!name) throw new Error('zip entry name is required');
    const nameBuffer = Buffer.from(name, 'utf8');
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data || '');
    const compressed = zlib.deflateRawSync(data);
    const crc = crc32(data);
    const { date, time } = dosDateTime(entry.mtime);

    assertUInt32(data.length, 'entry');
    assertUInt32(compressed.length, 'compressed entry');
    assertUInt32(offset, 'offset');

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(LOCAL_FILE_HEADER, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(UTF8_FLAG, 6);
    localHeader.writeUInt16LE(DEFLATE, 8);
    localHeader.writeUInt16LE(time, 10);
    localHeader.writeUInt16LE(date, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(nameBuffer.length, 26);
    localHeader.writeUInt16LE(0, 28);
    localParts.push(localHeader, nameBuffer, compressed);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(CENTRAL_DIRECTORY_HEADER, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(UTF8_FLAG, 8);
    centralHeader.writeUInt16LE(DEFLATE, 10);
    centralHeader.writeUInt16LE(time, 12);
    centralHeader.writeUInt16LE(date, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(nameBuffer.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    centralParts.push(centralHeader, nameBuffer);

    offset += localHeader.length + nameBuffer.length + compressed.length;
  }

  const centralOffset = offset;
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  assertUInt32(centralOffset, 'central directory offset');
  assertUInt32(centralSize, 'central directory');
  if (entries.length > 0xffff) throw new Error('zip has too many entries');

  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_OF_CENTRAL_DIRECTORY, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralOffset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, ...centralParts, end]);
}

function writeZipFile(filePath, entries) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, createZipBuffer(entries));
}

function findEndOfCentralDirectory(buffer) {
  const start = Math.max(0, buffer.length - 22 - 0xffff);
  for (let i = buffer.length - 22; i >= start; i -= 1) {
    if (buffer.readUInt32LE(i) === END_OF_CENTRAL_DIRECTORY) return i;
  }
  throw new Error('invalid zip: missing central directory');
}

function assertReadable(buffer, offset, length, label) {
  if (offset < 0 || length < 0 || offset + length > buffer.length) {
    throw new Error(`invalid zip: truncated ${label}`);
  }
}

function readLimits(options = {}) {
  return {
    maxZipBytes: options.maxZipBytes ?? ZIP_LIMITS.maxZipBytes,
    maxUnpackedBytes: options.maxUnpackedBytes ?? ZIP_LIMITS.maxUnpackedBytes,
    maxEntryBytes: options.maxEntryBytes ?? ZIP_LIMITS.maxEntryBytes,
    maxEntries: options.maxEntries ?? ZIP_LIMITS.maxEntries,
  };
}

function assertWithinLimit(value, limit, message) {
  if (!Number.isFinite(limit) || limit < 0) {
    throw new Error('invalid zip read limit');
  }
  if (value > limit) throw new Error(message);
}

function readZipBuffer(input, options = {}) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const limits = readLimits(options);
  assertWithinLimit(
    buffer.length,
    limits.maxZipBytes,
    `refusing zip: archive size ${buffer.length} bytes exceeds ${limits.maxZipBytes} byte limit`,
  );
  const endOffset = findEndOfCentralDirectory(buffer);
  const entryCount = buffer.readUInt16LE(endOffset + 10);
  const centralSize = buffer.readUInt32LE(endOffset + 12);
  const centralOffset = buffer.readUInt32LE(endOffset + 16);
  assertWithinLimit(
    entryCount,
    limits.maxEntries,
    `refusing zip: ${entryCount} entries exceeds ${limits.maxEntries} entry limit`,
  );
  assertReadable(buffer, centralOffset, centralSize, 'central directory');

  const metadata = [];
  const centralEnd = centralOffset + centralSize;
  let declaredUnpackedBytes = 0;
  let cursor = centralOffset;
  for (let i = 0; i < entryCount; i += 1) {
    if (cursor + 46 > centralEnd) {
      throw new Error('invalid zip: truncated central directory entry');
    }
    if (buffer.readUInt32LE(cursor) !== CENTRAL_DIRECTORY_HEADER) {
      throw new Error('invalid zip: malformed central directory');
    }

    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const expectedCrc = buffer.readUInt32LE(cursor + 16);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const nameStart = cursor + 46;
    if (nameStart + nameLength + extraLength + commentLength > centralEnd) {
      throw new Error('invalid zip: truncated central directory name');
    }
    const name = buffer.slice(nameStart, nameStart + nameLength).toString('utf8');
    cursor = nameStart + nameLength + extraLength + commentLength;

    if (flags & 1) throw new Error(`invalid zip: encrypted entry ${name} is not supported`);
    if (![STORE, DEFLATE].includes(method)) {
      throw new Error(`invalid zip: unsupported compression method ${method} for ${name}`);
    }

    assertWithinLimit(
      uncompressedSize,
      limits.maxEntryBytes,
      `refusing zip: entry ${name} declares ${uncompressedSize} unpacked bytes, exceeding ${limits.maxEntryBytes} byte entry limit`,
    );
    declaredUnpackedBytes += uncompressedSize;
    assertWithinLimit(
      declaredUnpackedBytes,
      limits.maxUnpackedBytes,
      `refusing zip: declared unpacked size ${declaredUnpackedBytes} bytes exceeds ${limits.maxUnpackedBytes} byte limit`,
    );

    metadata.push({
      name,
      flags,
      method,
      expectedCrc,
      compressedSize,
      uncompressedSize,
      localOffset,
    });
  }

  const entries = [];
  for (const entry of metadata) {
    const {
      name,
      method,
      expectedCrc,
      compressedSize,
      uncompressedSize,
      localOffset,
    } = entry;
    assertReadable(buffer, localOffset, 30, 'local file header');
    if (buffer.readUInt32LE(localOffset) !== LOCAL_FILE_HEADER) {
      throw new Error(`invalid zip: missing local header for ${name}`);
    }
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    assertReadable(buffer, dataStart, compressedSize, `file data for ${name}`);
    const compressed = buffer.slice(dataStart, dataStart + compressedSize);
    let data;
    try {
      data = method === STORE
        ? Buffer.from(compressed)
        : zlib.inflateRawSync(compressed, { maxOutputLength: Math.max(1, uncompressedSize) });
    } catch (error) {
      if (error && error.code === 'ERR_BUFFER_TOO_LARGE') {
        throw new Error(`invalid zip: inflated data exceeds declared size for ${name}`);
      }
      throw new Error(`invalid zip: could not inflate ${name}: ${error.message}`);
    }
    if (data.length !== uncompressedSize) {
      throw new Error(`invalid zip: size mismatch for ${name}`);
    }
    if (crc32(data) !== expectedCrc) {
      throw new Error(`invalid zip: checksum mismatch for ${name}`);
    }
    entries.push({ name, data });
  }

  return entries;
}

function readZipFile(filePath, options = {}) {
  return readZipBuffer(fs.readFileSync(filePath), options);
}

module.exports = {
  createZipBuffer,
  writeZipFile,
  readZipBuffer,
  readZipFile,
  ZIP_LIMITS,
};
