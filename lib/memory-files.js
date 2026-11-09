'use strict';

// Real files in an Atris memory folder: photos, PDFs, recordings, anything
// under files/. The bytes go straight between this laptop and the private
// bucket, on short-lived links the Atris server signs for one file at a time.
// They never pass through the server, and no file is ever held whole in
// memory here: hashing, sending and fetching all stream in 1 MB pieces.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { Transform, pipeline } = require('stream');

// Pages the server writes and reads as text, up to its 1 MB write limit.
// Everything else (any other type, or bigger) goes as a file.
const TEXT_ENDINGS = ['.md', '.txt', '.json', '.jsonl', '.csv', '.yaml', '.yml'];
const TEXT_MAX_BYTES = 1000000;
const LARGE_BYTES = 4 * 1024 * 1024; // files this big move one at a time, with a progress line
const PIECE = 1024 * 1024;
const IDLE_MS = 60000;

function goesAsFile(rel, size) {
  const lower = String(rel).toLowerCase();
  return !(Number(size) <= TEXT_MAX_BYTES) || !TEXT_ENDINGS.some((ending) => lower.endsWith(ending));
}

function printOf(buffer) {
  return {
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
    md5: crypto.createHash('md5').update(buffer).digest('hex'),
    bytes: buffer.length,
  };
}

// The fingerprints of a file on disk, read 1 MB at a time.
function hashFileSync(abs) {
  const sha = crypto.createHash('sha256');
  const md5 = crypto.createHash('md5');
  const piece = Buffer.allocUnsafe(PIECE);
  const fd = fs.openSync(abs, 'r');
  let bytes = 0;
  try {
    for (;;) {
      const n = fs.readSync(fd, piece, 0, PIECE, null);
      if (!n) break;
      sha.update(piece.subarray(0, n));
      md5.update(piece.subarray(0, n));
      bytes += n;
    }
  } finally {
    fs.closeSync(fd);
  }
  return { sha256: sha.digest('hex'), md5: md5.digest('hex'), bytes };
}

function size(n) {
  const units = [['GB', 1024 ** 3], ['MB', 1024 ** 2], ['KB', 1024]];
  for (const [unit, step] of units) {
    if (n >= step) return `${(n / step).toFixed(n % step === 0 || n >= 10 * step ? 0 : 1)} ${unit}`;
  }
  return `${n} bytes`;
}

// Links come from the Atris server. Only https, or plain http to this machine (tests, a local server).
function transportFor(url) {
  const parsed = new URL(url);
  if (parsed.protocol === 'https:') return { parsed, transport: https };
  if (parsed.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) {
    return { parsed, transport: http };
  }
  throw new Error('the Atris server sent a link that is not https');
}

// What S3 said, without the link (it carries a signature).
function s3Said(status, body) {
  const code = /<Code>([^<]{1,80})<\/Code>/.exec(body);
  const message = /<Message>([^<]{1,200})<\/Message>/.exec(body);
  if (code) return `storage refused it (${code[1]}${message ? `: ${message[1]}` : ''})`;
  return `storage answered ${status}`;
}

function readSmall(res, done) {
  const chunks = [];
  let kept = 0;
  res.on('data', (chunk) => { if (kept < 16384) { chunks.push(chunk); kept += chunk.length; } });
  res.on('end', () => done(Buffer.concat(chunks).toString('utf8')));
  res.on('error', () => done(''));
}

// POST one file to a signed S3 upload form: every field the server gave, the file last.
// Resolves with the fingerprints of exactly the bytes sent.
function sendFile({ url, fields, abs, bytes: expected, onProgress = null }) {
  const { parsed, transport } = transportFor(url);
  const boundary = `----atris-${crypto.randomBytes(16).toString('hex')}`;
  let head = '';
  for (const [name, value] of Object.entries(fields || {})) {
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(name)) throw new Error('the upload form has a field this tool does not send');
    head += `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
  }
  head += `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="file"\r\n`
    + 'Content-Type: application/octet-stream\r\n\r\n';
  const start = Buffer.from(head, 'utf8');
  const end = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');

  return new Promise((resolve, reject) => {
    let settled = false;
    let sent = null;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (error) reject(error); else resolve(value);
    };
    const req = transport.request(parsed, {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': start.length + expected + end.length,
      },
    });
    req.setTimeout(IDLE_MS, () => req.destroy(new Error('the upload stalled for a minute')));
    req.on('error', (error) => finish(error));
    req.on('response', (res) => readSmall(res, (body) => {
      if (res.statusCode >= 200 && res.statusCode < 300 && sent) finish(null, sent);
      else finish(new Error(s3Said(res.statusCode, body)));
    }));
    const drained = () => new Promise((go) => {
      const on = () => { req.off('drain', on); req.off('close', on); go(); };
      req.on('drain', on);
      req.on('close', on);
    });
    (async () => {
      const sha = crypto.createHash('sha256');
      const md5 = crypto.createHash('md5');
      let count = 0;
      const stream = fs.createReadStream(abs, { highWaterMark: PIECE });
      req.write(start);
      try {
        for await (const chunk of stream) {
          if (settled || req.destroyed) return;
          count += chunk.length;
          if (count > expected) throw new Error('the file changed while it was being sent');
          sha.update(chunk);
          md5.update(chunk);
          if (onProgress) onProgress(count, expected);
          if (!req.write(chunk)) await drained();
        }
      } finally {
        stream.destroy();
      }
      if (count !== expected) throw new Error('the file changed while it was being sent');
      sent = { sha256: sha.digest('hex'), md5: md5.digest('hex'), bytes: count };
      req.end(end);
    })().catch((error) => req.destroy(error));
  });
}

// GET a signed download link into `temp`, streaming. Resolves with the fingerprints of what arrived.
function fetchFile({ url, temp, bytes: expected = 0, onProgress = null }) {
  const { parsed, transport } = transportFor(url);
  return new Promise((resolve, reject) => {
    const req = transport.get(parsed, (res) => {
      if (res.statusCode !== 200) {
        readSmall(res, (body) => reject(new Error(s3Said(res.statusCode, body))));
        return;
      }
      const sha = crypto.createHash('sha256');
      const md5 = crypto.createHash('md5');
      let count = 0;
      const tap = new Transform({
        transform(chunk, _encoding, next) {
          count += chunk.length;
          sha.update(chunk);
          md5.update(chunk);
          if (onProgress) onProgress(count, expected);
          next(null, chunk);
        },
      });
      pipeline(res, tap, fs.createWriteStream(temp, { flags: 'wx' }), (error) => {
        if (error) reject(error);
        else resolve({ sha256: sha.digest('hex'), md5: md5.digest('hex'), bytes: count });
      });
    });
    req.setTimeout(IDLE_MS, () => req.destroy(new Error('the download stalled for a minute')));
    req.on('error', reject);
  });
}

// A hidden name beside the target, so a half-fetched file is never mistaken for the real one.
function tempBeside(abs) {
  return path.join(path.dirname(abs), `.${path.basename(abs)}.atris-tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
}

// One line per large file. On a terminal it updates in place with a percent;
// otherwise it is printed once, when the file starts moving.
function progressPrinter({ log, tty = null }) {
  const shown = new Map();
  return ({ rel, verb, done, total, finished = false }) => {
    if (total < LARGE_BYTES) return;
    const label = `${verb} ${rel} (${size(total)})`;
    if (!tty) {
      if (!shown.has(rel)) { shown.set(rel, true); log(`${label}...`); }
      return;
    }
    if (finished) {
      if (shown.has(rel)) tty.write('\n');
      return;
    }
    const percent = Math.floor((done * 100) / Math.max(1, total));
    if (shown.get(rel) === percent) return;
    shown.set(rel, percent);
    tty.write(`\r${label} ${percent}%`);
  };
}

module.exports = {
  LARGE_BYTES,
  fetchFile,
  goesAsFile,
  hashFileSync,
  printOf,
  progressPrinter,
  sendFile,
  tempBeside,
};
