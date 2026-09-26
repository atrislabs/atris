'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { hostAction } = require('../lib/host');

const cli = path.join(__dirname, '..', 'bin', 'atris.js');
function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-host-'));
  fs.mkdirSync(path.join(root, 'atris'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function run(root, ...args) {
  const result = spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1' } });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
function people(root) {
  const names = ['Ada', 'Ben', 'Cora', 'Dev', 'Eli', 'Fern', 'Gio', 'Hana', 'Ivy', 'Jules'];
  for (const [index, name] of names.entries()) hostAction(root, 'join', { id: `slack:U${index + 1}`, name, team: index < 5 ? 'Northwind Coffee' : 'Northwind Friends', manager: index === 1 ? 'slack:U1' : undefined, door: `slack:U${index + 1}` });
  return names.map((_, index) => `slack:U${index + 1}`);
}
function privateFile(root, id) { return path.join(root, 'atris', 'team', 'host', 'private', 'people', `${encodeURIComponent(id)}.md`); }
function privateData(root, id) {
  const text = fs.readFileSync(privateFile(root, id), 'utf8');
  const front = text.split('\n---\n')[0].slice(4).split('\n');
  return Object.fromEntries(front.map((line) => { const i = line.indexOf(': '); return [line.slice(0, i), JSON.parse(line.slice(i + 2))]; }));
}
function outbox(root) { return hostAction(root, 'outbox'); }
function introFiles(root) { return fs.readdirSync(path.join(root, 'atris', 'team', 'host', 'private', 'intros')).filter((name) => name.endsWith('.md')); }
function future(iso, days) { return new Date(Date.parse(iso) + days * 86400000).toISOString(); }
function propose(root, a, b) { return hostAction(root, 'propose', { a, b, reason: 'Ada has a new coffee event and Cora wants a welcoming place for her poetry group.', activity: 'a fifteen minute tasting', text: 'Ada, meet Cora. Try a tasting together.' }); }

test('install copies the packaged host and preserves local edits', (t) => {
  const root = workspace(t);
  const target = path.join(root, 'atris', 'team', 'host');
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'SOUL.md'), 'local soul\n');
  run(root, 'member', 'install', 'host');
  for (const file of ['MEMBER.md', 'SOUL.md', 'MISSION.md', 'goals.md', 'goals.json', 'context/why.md', 'skills/host/SKILL.md']) assert.ok(fs.existsSync(path.join(target, file)), file);
  assert.equal(fs.readFileSync(path.join(target, 'SOUL.md'), 'utf8'), 'local soul\n');
  assert.match(fs.readFileSync(path.join(target, 'MEMBER.md'), 'utf8'), /two private yeses/);
  run(root, 'member', 'install', 'host');
  assert.equal(fs.readFileSync(path.join(target, 'SOUL.md'), 'utf8'), 'local soul\n');
});

test('questions, event dedupe, expiry, and a quiet pause', (t) => {
  const root = workspace(t);
  const [ada, ben] = people(root);
  const t0 = privateData(root, ada).joined_at;
  assert.ok(hostAction(root, 'due', { now: t0 }).some((entry) => entry.id === ada));
  hostAction(root, 'ask', { id: ada, question: 'What tiny adventure would make this week better?', now: t0 });
  assert.equal(outbox(root).filter((message) => message.to === ada && message.kind === 'question').length, 1);
  const answer = hostAction(root, 'receive', { eventId: 'event-1', from: ada, text: 'A sunrise coffee walk.' });
  assert.equal(answer.kind, 'answer');
  assert.equal(hostAction(root, 'receive', { eventId: 'event-1', from: ada, text: 'different' }).duplicate, true);
  assert.match(fs.readFileSync(privateFile(root, ada), 'utf8'), /sunrise coffee walk/);
  assert.doesNotMatch(fs.readFileSync(privateFile(root, ada), 'utf8'), /different/);
  hostAction(root, 'ask', { id: ben, question: 'What are you excited to try?', now: privateData(root, ben).joined_at });
  const t8 = future(t0, 8);
  assert.ok(hostAction(root, 'due', { now: t8 }).some((entry) => entry.id === ben));
  assert.equal(privateData(root, ben).unanswered_count, 1);
  hostAction(root, 'ask', { id: ben, question: 'What is a perfect Saturday?', now: t8 });
  hostAction(root, 'due', { now: future(t0, 16) });
  assert.equal(privateData(root, ben).status, 'paused');
  assert.equal(outbox(root).filter((message) => message.to === ben).length, 0);
});

test('cards reject operations and stale model work; views hide other answers', (t) => {
  const root = workspace(t);
  const [ada, , cora] = people(root);
  hostAction(root, 'receive', { eventId: 'note-1', from: ada, text: 'My private cinnamon secret.' });
  const patch = path.join(root, 'patch.json');
  fs.writeFileSync(patch, JSON.stringify({ into_lately: 'Learning latte art', status: 'active' }));
  assert.throws(() => hostAction(root, 'card', { id: ada, patch, expectedRevision: privateData(root, ada).revision }), /five text fields/);
  fs.writeFileSync(patch, JSON.stringify({ into_lately: 'Learning latte art', worth_celebrating: 'Opened a new cafe' }));
  const revision = privateData(root, ada).revision;
  hostAction(root, 'card', { id: ada, patch, expectedRevision: revision });
  assert.throws(() => hostAction(root, 'card', { id: ada, patch, expectedRevision: revision }), /stale/);
  const view = hostAction(root, 'view', { as: cora });
  assert.equal(view.cards.length, 10);
  assert.doesNotMatch(JSON.stringify(view), /cinnamon secret/);
  assert.match(JSON.stringify(hostAction(root, 'view', { as: ada })), /cinnamon secret/);
  assert.equal(hostAction(root, 'view', { team: 'Northwind Coffee' }).cards.length, 5);
});

test('links, manager relationship, two yeses, and one private no', (t) => {
  const root = workspace(t);
  const ids = people(root);
  assert.throws(() => propose(root, ids[0], ids[1]), /manager and report/);
  hostAction(root, 'link', { a: ids[0], b: ids[2], source: 'answer', evidence: 'They already meet every Friday.' });
  assert.throws(() => propose(root, ids[0], ids[2]), /already linked/);
  const first = propose(root, ids[0], ids[3]);
  assert.equal(first.state, 'pending');
  assert.throws(() => propose(root, ids[0], ids[4]), /cadence reached/);
  assert.equal(hostAction(root, 'receive', { eventId: 'intro-yes-1', from: ids[0], text: 'yeah' }).kind, 'intro_yes');
  assert.equal(outbox(root).filter((message) => message.kind === 'intro').length, 0);
  assert.equal(hostAction(root, 'receive', { eventId: 'intro-yes-2', from: ids[3], text: 'sure' }).kind, 'introduced');
  assert.equal(outbox(root).filter((message) => message.kind === 'intro' && message.to === ids[0]).length, 1);
  assert.equal(outbox(root).filter((message) => message.kind === 'intro' && message.to === ids[3]).length, 1);
  assert.match(fs.readFileSync(path.join(root, 'atris', 'team', 'host', 'private', 'intros', introFiles(root)[0]), 'utf8'), /"introduced"/);
  propose(root, ids[4], ids[5]);
  assert.equal(hostAction(root, 'receive', { eventId: 'intro-no', from: ids[4], text: 'pass' }).kind, 'intro_closed');
  assert.equal(outbox(root).filter((message) => message.to === ids[5] && message.kind !== 'welcome').length, 0);
  assert.equal(outbox(root).filter((message) => message.to === ids[5] && message.kind === 'intro').length, 0);
  assert.throws(() => propose(root, ids[4], ids[5]), /declined before/);
  assert.doesNotMatch(hostAction(root, 'room').text, /declin|pass|intro-no/i);
});

test('expired introductions disappear from the outbox and sent messages stay recorded', (t) => {
  const root = workspace(t);
  const [ada, , cora] = people(root);
  propose(root, ada, cora);
  const ask = outbox(root).find((message) => message.to === ada && message.kind === 'intro_ask');
  hostAction(root, 'sent', { id: ask.id });
  assert.equal(outbox(root).some((message) => message.id === ask.id), false);
  const when = future(privateData(root, ada).joined_at, 8);
  hostAction(root, 'room', { now: when });
  assert.equal(outbox(root).filter((message) => message.kind === 'intro_ask').length, 0);
  assert.match(fs.readFileSync(path.join(root, 'atris', 'team', 'host', 'private', 'intros', introFiles(root)[0]), 'utf8'), /"expired"/);
});

test('malformed private frontmatter is an error, not a reset', (t) => {
  const root = workspace(t);
  const [ada] = people(root);
  fs.writeFileSync(privateFile(root, ada), 'broken\n');
  const result = spawnSync(process.execPath, [cli, 'host', 'due', '--json'], { cwd: root, encoding: 'utf8', env: { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1' } });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /malformed record/);
  assert.equal(fs.readFileSync(privateFile(root, ada), 'utf8'), 'broken\n');
});

test('forget removes records, links, introductions, and messages; room stays kind', (t) => {
  const root = workspace(t);
  const ids = people(root);
  hostAction(root, 'link', { a: ids[0], b: ids[2], source: 'channel', evidence: 'community picnic' });
  propose(root, ids[0], ids[3]);
  hostAction(root, 'ask', { id: ids[0], question: 'What have you enjoyed lately?' });
  const patch = path.join(root, 'patch.json');
  fs.writeFileSync(patch, JSON.stringify({ worth_celebrating: 'Finished a marathon' }));
  hostAction(root, 'card', { id: ids[0], patch, expectedRevision: privateData(root, ids[0]).revision });
  const room = hostAction(root, 'room').text;
  assert.match(room, /No connections recorded/);
  assert.match(room, /Finished a marathon/);
  assert.doesNotMatch(room, /unanswered|declin|nonrespond|score/i);
  hostAction(root, 'forget', { id: ids[0] });
  assert.equal(fs.existsSync(privateFile(root, ids[0])), false);
  assert.equal(fs.existsSync(path.join(root, 'atris', 'wiki', 'people', `${encodeURIComponent(ids[0])}.md`)), false);
  assert.equal(introFiles(root).length, 0);
  assert.doesNotMatch(fs.readFileSync(path.join(root, 'atris', 'team', 'host', 'private', 'links.jsonl'), 'utf8'), /slack:U1/);
  assert.ok(outbox(root).every((message) => message.to !== ids[0] && !message.text.includes('Ada')));
  assert.equal(fs.existsSync(path.join(root, 'atris', 'team', 'host', 'private', 'room.md')), false);
  assert.throws(() => hostAction(root, 'join', { id: ids[0], name: 'Ada' }), /forgotten/);
});

test('two child processes can receive at once without losing either reply', async (t) => {
  const root = workspace(t);
  const [ada, ben] = people(root);
  hostAction(root, 'ask', { id: ada, question: 'What made you smile?' });
  hostAction(root, 'ask', { id: ben, question: 'What made you smile?' });
  const child = (id, event, answer) => new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [cli, 'host', 'receive', '--event-id', event, '--from', id, '--text', answer, '--json'], { cwd: root, env: { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1' } });
    let error = '';
    proc.stderr.on('data', (chunk) => { error += chunk; });
    proc.on('error', reject);
    proc.on('close', (code) => code === 0 ? resolve() : reject(new Error(`${code}: ${error}`)));
  });
  await Promise.all([child(ada, 'concurrent-1', 'The sunrise.'), child(ben, 'concurrent-2', 'The rain.')]);
  assert.match(fs.readFileSync(privateFile(root, ada), 'utf8'), /The sunrise/);
  assert.match(fs.readFileSync(privateFile(root, ben), 'utf8'), /The rain/);
  assert.equal(privateData(root, ada).processed_events.includes('concurrent-1'), true);
  assert.equal(privateData(root, ben).processed_events.includes('concurrent-2'), true);
});
