'use strict';

// CLOUD_FEATURES is the list the backend reads (atris campaign features --json)
// before it starts a cloud run on this computer. It is a plain array, so these
// tests pin its contents and the shapes the CLI prints from it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-cloud-features-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
for (const key of Object.keys(process.env)) {
  if (key.startsWith('ATRIS_')) delete process.env[key];
}

const sync = require('../lib/campaign-sync');
const { CLOUD_FEATURES } = sync;

test.after(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

test('CLOUD_FEATURES lists exactly what the backend checks for, in order', () => {
  assert.ok(Array.isArray(CLOUD_FEATURES));
  assert.deepEqual(CLOUD_FEATURES, ['cloud_pull', 'campaign_token_file']);
  assert.equal(CLOUD_FEATURES.length, 2);
  assert.ok(CLOUD_FEATURES.includes('cloud_pull'));
  assert.ok(CLOUD_FEATURES.includes('campaign_token_file'));
});

test('CLOUD_FEATURES entries are unique, non-empty snake_case strings', () => {
  for (const name of CLOUD_FEATURES) {
    assert.equal(typeof name, 'string');
    assert.match(name, /^[a-z]+(_[a-z]+)*$/);
  }
  assert.equal(new Set(CLOUD_FEATURES).size, CLOUD_FEATURES.length);
});

test('CLOUD_FEATURES survives the JSON round trip the features command sends', () => {
  const payload = JSON.parse(JSON.stringify({ ok: true, features: CLOUD_FEATURES }));
  assert.deepEqual(payload, { ok: true, features: ['cloud_pull', 'campaign_token_file'] });
  assert.equal(`this atris CLI can: ${CLOUD_FEATURES.join(', ')}`, 'this atris CLI can: cloud_pull, campaign_token_file');
});

test('CLOUD_FEATURES does not claim features this CLI lacks', () => {
  assert.equal(CLOUD_FEATURES.includes('cloud_push_all'), false);
  assert.equal(CLOUD_FEATURES.includes(''), false);
  assert.equal(CLOUD_FEATURES.includes(undefined), false);
  assert.equal(CLOUD_FEATURES.indexOf('time_travel'), -1);
});

test('CLOUD_FEATURES backs the functions it advertises', () => {
  assert.equal(typeof sync.takeCampaignToken, 'function');
  assert.equal(typeof sync.syncCampaign, 'function');
  assert.equal(typeof sync.CAMPAIGN_TOKEN_ENV, 'string');
  assert.ok(sync.CAMPAIGN_TOKEN_ENV.length > 0);
});

test('requiring the module again hands back the same list', () => {
  assert.equal(require('../lib/campaign-sync').CLOUD_FEATURES, CLOUD_FEATURES);
});
