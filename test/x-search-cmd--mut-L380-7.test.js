'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { xSearchCommand } = require('../commands/x-search');

test('expired login wall surfaces the token mint failure reason', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-mut380-'));
  const output = [];
  let apiCalls = 0;
  try {
    const status = await xSearchCommand(['agents'], {
      cwd,
      output: (line) => output.push(line),
      ensureValidCredentials: async () => ({ error: 'token_invalid', detail: 'Token expired' }),
      loadCredentials: () => ({ token: 'old-jwt', refresh_token: 'rt' }),
      apiRequestJson: async () => {
        apiCalls += 1;
        return { ok: false, status: 403, error: 'mint_denied' };
      },
    });

    assert.equal(status, 1);
    assert.equal(apiCalls, 1);
    assert.match(output.join('\n'), /mint_denied/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
