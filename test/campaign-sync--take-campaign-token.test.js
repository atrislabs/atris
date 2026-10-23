'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { takeCampaignToken } = require('../lib/campaign-sync');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'campaign-token-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'token.json');
}

test('reads a token file, trims whitespace, and consumes only its environment entry', (t) => {
  const file = fixture(t);
  fs.writeFileSync(file, JSON.stringify({ campaign_id: 'cmp-example', token: '  secret-token\n' }));
  const env = { ATRIS_CAMPAIGN_TOKEN_FILE: `  ${file}\n`, OTHER: 'preserved' };

  assert.deepStrictEqual(takeCampaignToken(env), { campaign_id: 'cmp-example', token: 'secret-token' });
  assert.deepStrictEqual(env, { OTHER: 'preserved' });
  assert.strictEqual(takeCampaignToken(env), null);
  assert.strictEqual(fs.existsSync(file), true);
});

test('returns null when no token file is supplied', () => {
  assert.strictEqual(takeCampaignToken({}), null);
  assert.strictEqual(takeCampaignToken(null), null);
  assert.strictEqual(takeCampaignToken({ ATRIS_CAMPAIGN_TOKEN_FILE: undefined }), null);
});

test('returns a plain error and consumes the entry for missing or malformed files', (t) => {
  const file = fixture(t);
  for (const content of [undefined, '{broken json']) {
    if (content !== undefined) fs.writeFileSync(file, content);
    const env = { ATRIS_CAMPAIGN_TOKEN_FILE: file };
    assert.deepStrictEqual(takeCampaignToken(env), {
      error: `the campaign token file ${file} could not be read`,
    });
    assert.deepStrictEqual(env, {});
    assert.strictEqual(takeCampaignToken(env), null);
  }
});

test('rejects empty tokens, non-string tokens, and invalid campaign ids', (t) => {
  const file = fixture(t);
  for (const body of [
    null,
    {},
    { campaign_id: 'cmp-example', token: ' \n' },
    { campaign_id: 'cmp-example', token: 123 },
    { campaign_id: 'invalid', token: 'secret' },
    { campaign_id: 'cmp-', token: 'secret' },
    { campaign_id: 'cmp-UPPER', token: 'secret' },
  ]) {
    fs.writeFileSync(file, JSON.stringify(body));
    const env = { ATRIS_CAMPAIGN_TOKEN_FILE: file };
    assert.deepStrictEqual(takeCampaignToken(env), {
      error: `the campaign token file ${file} could not be read`,
    });
    assert.deepStrictEqual(env, {});
  }
});
