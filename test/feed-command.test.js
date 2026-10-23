'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseSince, authorLabel, findBusiness, loadAuthorAliases } = require('../commands/feed');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feed-command-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('parseSince accepts trimmed day and hour windows and rejects invalid forms', () => {
  for (const [input, duration] of [[' 7d ', 7 * 86400000], ['48h', 48 * 3600000], ['0h', 0]]) {
    const before = Date.now();
    const result = parseSince(input);
    const after = Date.now();
    assert.ok(result >= before - duration && result <= after - duration);
  }
  for (const input of [undefined, '', '7', '1w', '-2h', '1.5d', '7D', '7d trailing']) {
    assert.strictEqual(parseSince(input), null);
  }
});

test('authorLabel uses agent and display names before aliases and self fallbacks', () => {
  const aliases = { 'user-123456789': 'Alias' };
  assert.strictEqual(authorLabel({ post_type: 'agent_post', agent_name: 'Builder', author_display_name: 'Display' }, aliases), 'Builder');
  assert.strictEqual(authorLabel({ post_type: 'agent_post', author_display_name: 'Display' }, aliases), 'Display');
  assert.strictEqual(authorLabel({ post_type: 'agent_post' }, aliases), 'agent');
  assert.strictEqual(authorLabel({ author_id: 'user-123456789', author_display_name: 'Display' }, aliases), 'Display');
  assert.strictEqual(authorLabel({ author_id: 'user-123456789' }, aliases, 'user-123456789', 'self@example.com'), 'Alias');
  assert.strictEqual(authorLabel({ author_id: 'self' }, aliases, 'self', 'alex@example.com'), 'alex');
  assert.strictEqual(authorLabel({ author_id: 'self' }, aliases, 'self'), 'me');
  assert.strictEqual(authorLabel({ author_id: 'abcdefghijk' }, aliases), 'abcdefgh');
  assert.strictEqual(authorLabel({}, aliases), '?');
});

test('findBusiness selects the nearest valid binding and skips malformed or unbound files', (t) => {
  const root = fixture(t);
  const child = path.join(root, 'child');
  const leaf = path.join(child, 'leaf');
  for (const dir of [root, child, leaf]) fs.mkdirSync(path.join(dir, '.atris'), { recursive: true });
  fs.writeFileSync(path.join(root, '.atris', 'business.json'), JSON.stringify({ business_id: 'parent', name: 'Parent' }));
  const childFile = path.join(child, '.atris', 'business.json');
  fs.writeFileSync(childFile, '{broken');
  fs.writeFileSync(path.join(leaf, '.atris', 'business.json'), JSON.stringify({ name: 'Unbound' }));
  assert.deepStrictEqual(findBusiness(leaf), { businessId: 'parent', name: 'Parent', root });
  fs.writeFileSync(childFile, JSON.stringify({ business_id: 'nearest', slug: 'child-slug' }));
  assert.deepStrictEqual(findBusiness(leaf), { businessId: 'nearest', name: 'child-slug', root: child });
});

test('loadAuthorAliases reads local aliases and tolerates missing or malformed files', (t) => {
  const root = fixture(t);
  assert.deepStrictEqual(loadAuthorAliases(root), {});
  fs.mkdirSync(path.join(root, '.atris'));
  const file = path.join(root, '.atris', 'feed_authors.json');
  fs.writeFileSync(file, JSON.stringify({ user1: 'Alex', user2: 'Sam' }));
  assert.deepStrictEqual(loadAuthorAliases(root), { user1: 'Alex', user2: 'Sam' });
  fs.writeFileSync(file, '{broken');
  assert.deepStrictEqual(loadAuthorAliases(root), {});
});
