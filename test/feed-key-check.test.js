'use strict';

// The precise key check for a person's own words (lib/feed-plain-words.js
// holdsKey). It must catch what is shaped like a credential and let through
// what real teams paste all day: commit hashes, document links, UUIDs.
// Every key below is fake and built at run time, so no scanner reads one here.

const test = require('node:test');
const assert = require('node:assert/strict');
const { holdsKey, secretLike } = require('../lib/feed-plain-words');

const fake = (prefix, body) => `${prefix}${body}`;
const MIXED = 'FAKEa1b2C3d4E5f6G7h8J9k0L1m2N3p4Q5r6';

const MUST_CATCH = [
  ['an OpenAI style key', `use ${fake('sk-proj-', MIXED)} for now`],
  ['a test-prefixed key', `the login is ${fake('sk-test-', '0123456789abcdef'.repeat(3))}`],
  ['an Anthropic style key', fake('sk-ant-', 'api03-FAKEfakeFAKEfakeFAKE0123')],
  ['a GitHub token', `token ${fake('ghp_', 'FAKE'.repeat(9))}`],
  ['a Slack token', fake('xoxb-', '1234567890-FAKEfakeFAKE')],
  ['an AWS access key id', `aws ${fake('AKIA', 'FAKEFAKEFAKE1234')}`],
  ['a Stripe live key', fake('sk_live_', 'FAKEfake0123456789FAKE')],
  ['a Google API key', fake('AIza', 'SyFAKE-fake_FAKEfakeFAKEfake0123456')],
  ['a private key block', '-----BEGIN RSA PRIVATE KEY----- MIIEFAKE'],
  ['an OpenSSH private key block', '-----BEGIN OPENSSH PRIVATE KEY-----'],
  ['password= assignment', 'set password=hunter22 on the staging box'],
  ['env style assignment', 'DB_PASSWORD=notreal99'],
  ['token= assignment', 'token=abcd1234efgh'],
  ['quoted password with a colon', 'password: "hunter2-not-real"'],
  ['secret: value with a digit', 'secret: Tr0ub4dor-fake'],
  ['a link with a login', 'https://admin:notreal99@db.example.com/shop'],
  ['a link with a token value', 'https://example.com/hook?token=FAKEfake0123456789'],
  ['a link with a signature', 'https://bucket.example.com/file.csv?X-Amz-Signature=fakefakefake0123456789'],
  ['a bearer token', `Bearer ${'FAKEfake0123'.repeat(3)}`],
  ['a JWT', `eyJ${'hbGciOiJIUzI1NiJ9'}.eyJzdWIiOiJmYWtlIn0.FAKEfakeFAKEfake`],
  ['a long random run', 'here it is wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY ok'],
  ['a base64 secret', 'Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZg'],
  ['a mixed random run', 'aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY'],
  ['a license key split with dashes', 'ABCD1-EFGH2-IJKL3-MNOP4-QRST5'],
  ['a Slack webhook', fake('https://hooks.slack.com/services/', 'T000FAKE/B000FAKE/FAKEfakeFAKEfake0123')],
];

const MUST_ALLOW = [
  ['a 40 character commit hash', 'Fixed in 523d8abeb1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6, see the change.'],
  ['a 64 character hash', `the file sum is ${'9f86d081884c7d659a2feaa0c55ad015'.repeat(2)}`],
  ['an uppercase hash', 'DA39A3EE5E6B4B0D3255BFEF95601890AFD80709'],
  ['a short commit', 'Fixed in 523d8abeb.'],
  ['a Google Doc link', 'https://docs.google.com/document/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/edit?usp=sharing'],
  ['a Google Drive link', 'see https://drive.google.com/file/d/1aB2cD3eF4gH5iJ6kL7mN8oP9qR0sT1uV/view'],
  ['a Notion link', 'https://www.notion.so/Team-Plan-1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d'],
  ['a Figma link', 'https://www.figma.com/file/AbCdEfGhIjKlMnOpQrStUv9x/Shop-Design?node-id=12-34&t=FAKEfake0123-1'],
  ['a GitHub pull request link', 'https://github.com/atrislabs/atris/pull/1995'],
  ['a GitHub commit link', 'https://github.com/atrislabs/atris/commit/4db12910a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6'],
  ['a link with plain query values', 'https://atris.ai/pricing?plan=pro&ref=feed'],
  ['a UUID', 'the order is 550e8400-e29b-41d4-a716-446655440000'],
  ['an uppercase UUID', '550E8400-E29B-41D4-A716-446655440000'],
  ['a long number', 'tracking 1234567890123456789012345678901234567890'],
  ['a base64-looking image name', 'attached Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZg.png'],
  ['a screenshot name', 'Screenshot_2026-11-17_at_9.41.22_PM.png'],
  ['words that name a key', 'The key point is speed, and the password reset page can wait.'],
  ['token: with words', 'token: remember to rotate it monthly'],
  ['a vault reminder', 'Our API key lives in the vault, never paste it here.'],
  ['a long slug', 'the post is how-we-grew-the-candle-shop-in-fremont-2026-edition'],
  ['a long file path', 'it lives in /Users/keshav/arena/atris/logs/2026/2026-11-17.md'],
  ['a mixed case path', 'Users/Keshav/Projects/App2/Source/Main'],
  ['a long camel name', 'ThisIsMyLongCamelCaseIdentifier2026Name'],
  ['a date and money', 'On 2026-11-17 we charged $50 for 24/7 help.'],
  ['nothing', ''],
];

test('holdsKey: catches every credential shape', () => {
  assert.ok(MUST_CATCH.length >= 15);
  for (const [name, text] of MUST_CATCH) assert.equal(holdsKey(text), true, `should catch ${name}`);
});

test('holdsKey: lets through hashes, ordinary links, UUIDs, numbers and file names', () => {
  assert.ok(MUST_ALLOW.length >= 15);
  for (const [name, text] of MUST_ALLOW) assert.equal(holdsKey(text), false, `should allow ${name}`);
});

test('secretLike stays eager for the plain-words check: a full hash and a long link id are still plumbing there', () => {
  assert.equal(secretLike('523d8abeb1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6'), true);
  assert.equal(secretLike('https://docs.google.com/document/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/edit'), true);
});
