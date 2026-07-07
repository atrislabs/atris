#!/usr/bin/env node
// det/hash.js — deterministic encode / hash. The "base64 this" and "give me the
// sha256" asks an LLM fakes or does wrong. Reads stdin, writes stdout.
//
// Usage:
//   printf 'hi' | node hash.js b64          # base64 encode
//   node hash.js b64d   < encoded.txt        # base64 decode
//   node hash.js sha256 < file.txt           # hex sha256 of the bytes
//   node hash.js sha1   < file.txt
//   node hash.js md5    < file.txt
//   node hash.js hexenc < file.txt           # raw -> hex
//   node hash.js hexdec < hex.txt            # hex -> raw
//
// Modes: b64 | b64d | sha256 | sha1 | md5 | hexenc | hexdec
// Input's trailing newline is stripped before encoding/hashing so
// `printf 'hi'` and `echo hi` give the same result. Exit 2 on bad mode/input.

'use strict';

const crypto = require('crypto');

const DIGESTS = { sha256: 'sha256', sha1: 'sha1', md5: 'md5' };

// Pure core: returns { text } or { error }. Unit-testable.
function run(mode, input) {
  // Strip a single trailing newline so shell echo vs printf agree.
  const raw = input.replace(/\n$/, '');
  if (DIGESTS[mode]) {
    return { text: crypto.createHash(DIGESTS[mode]).update(raw, 'utf8').digest('hex') };
  }
  switch (mode) {
    case 'b64':
      return { text: Buffer.from(raw, 'utf8').toString('base64') };
    case 'b64d':
      return { text: Buffer.from(raw, 'base64').toString('utf8') };
    case 'hexenc':
      return { text: Buffer.from(raw, 'utf8').toString('hex') };
    case 'hexdec':
      if (!/^[0-9a-fA-F]*$/.test(raw) || raw.length % 2 !== 0) {
        return { error: 'hexdec needs an even-length hex string' };
      }
      return { text: Buffer.from(raw, 'hex').toString('utf8') };
    default:
      return { error: `unknown mode: ${mode}` };
  }
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
    if (process.stdin.isTTY) resolve('');
  });
}

const MODES = ['b64', 'b64d', 'sha256', 'sha1', 'md5', 'hexenc', 'hexdec'];

async function main() {
  const mode = process.argv.slice(2).find((a) => !a.startsWith('-'));
  if (!mode || !MODES.includes(mode)) {
    process.stderr.write(`unknown mode: ${mode || '(none)'}\nmodes: ${MODES.join(' | ')}\n`);
    process.exit(2);
  }
  const input = await readStdin();
  const res = run(mode, input);
  if (res.error) {
    process.stderr.write(res.error + '\n');
    process.exit(2);
  }
  if (res.text.length) process.stdout.write(res.text + '\n');
}

if (require.main === module) {
  main();
}

module.exports = { run, MODES };
