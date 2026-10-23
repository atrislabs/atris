const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const api = require('../utils/api');

test('signup submits a proof with twenty leading zero bits', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'signup-proof-'));
  const oldHome = process.env.HOME;
  const oldCwd = process.cwd();
  const originalHash = crypto.createHash;
  const originalRequest = api.apiRequestJson;
  const originalLog = console.log;
  const originalError = console.error;
  let proofInput;
  let submittedDigest;
  process.env.HOME = home;
  process.chdir(home);
  try {
    // Observe the real hash input so the test does not assume a clock bucket.
    crypto.createHash = function (...args) {
      const hash = originalHash.apply(this, args);
      const update = hash.update;
      hash.update = function (input, ...rest) {
        proofInput = input;
        return update.call(this, input, ...rest);
      };
      return hash;
    };
    api.apiRequestJson = async (endpoint, options) => {
      const prefix = proofInput.slice(0, proofInput.lastIndexOf(':') + 1);
      submittedDigest = originalHash('sha256')
        .update(prefix + options.body.pow).digest();
      return { status: 400, body: { error: 'test rejection' } };
    };
    console.log = () => {};
    console.error = () => {};
    const { signupCommand } = require('../commands/signup');
    await signupCommand(['robot7']);
    assert.equal(submittedDigest.readUIntBE(0, 3) >>> 4, 0);
  } finally {
    crypto.createHash = originalHash;
    api.apiRequestJson = originalRequest;
    console.log = originalLog;
    console.error = originalError;
    process.chdir(oldCwd);
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
  }
});
