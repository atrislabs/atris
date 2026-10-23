'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('signup sends the first valid 20-bit proof even when its third byte is nonzero', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'signup-pow-boundary-'));
  const previousHome = process.env.HOME;
  const previousCwd = process.cwd();
  process.env.HOME = home;
  process.chdir(home);
  try {
    const api = require('../utils/api');
    let submittedPow;
    t.mock.method(api, 'apiRequestJson', async (_route, options) => {
      submittedPow = options.body.pow;
      return { ok: false, status: 409 };
    });
    t.mock.method(console, 'log', () => {});
    t.mock.method(console, 'error', () => {});

    // Controlled hash results keep the proof search short. Nonce zero has
    // exactly 20 leading zero bits; nonce one also satisfies 24 bits.
    // These are ordinary 32-byte SHA-256 digest shapes, selected by input,
    // so an overstrict solver can finish and expose the wrong submitted proof.
    t.mock.method(crypto, 'createHash', (algorithm) => {
      assert.equal(algorithm, 'sha256');
      let input;
      return {
        update(value) { input = value; return this; },
        digest() {
          const nonce = input.split(':').at(-1);
          const digest = Buffer.alloc(32, 0xff);
          digest[0] = 0;
          digest[1] = 0;
          digest[2] = nonce === '0' ? 0x0f : 0;
          return digest;
        },
      };
    });
    const { signupCommand } = require('../commands/signup');
    await signupCommand(['boundaryagent']);
    assert.equal(submittedPow, '0', 'a valid 20-bit proof must not be skipped for a 24-bit proof');
  } finally {
    t.mock.restoreAll();
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});
