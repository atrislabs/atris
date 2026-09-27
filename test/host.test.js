'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { hostAction } = require('../lib/host');
const { hostCommand, parse } = require('../commands/host');

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
function hostOutput(root, ...args) {
  const originalLog = console.log;
  let output;
  console.log = (line) => { output = line; };
  try { hostCommand(args, root); }
  finally { console.log = originalLog; }
  return output;
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
function introFile(root) { return path.join(root, 'atris', 'team', 'host', 'private', 'intros', introFiles(root)[0]); }
function introData(root) {
  return Object.fromEntries(fs.readFileSync(introFile(root), 'utf8').split('\n---\n')[0].slice(4).split('\n').map((line) => { const i = line.indexOf(': '); return [line.slice(0, i), JSON.parse(line.slice(i + 2))]; }));
}
function future(iso, days) { return new Date(Date.parse(iso) + days * 86400000).toISOString(); }
function propose(root, a, b) { return hostAction(root, 'propose', { a, b, reason: 'Ada has a new coffee event and Cora wants a welcoming place for her poetry group.', activity: 'a fifteen minute tasting', text: 'Ada, meet Cora. Try a tasting together.' }); }
function importRows(root, name, entries) {
  const file = path.join(root, name);
  fs.writeFileSync(file, entries.map((entry) => typeof entry === 'string' ? entry : JSON.stringify(entry)).join('\n') + '\n');
  return file;
}

test('host flag parser maps every supported option and rejects invalid flags', () => {
  const flags = [
    ['id', 'id'], ['name', 'name'], ['team', 'team'], ['manager', 'manager'], ['door', 'door'],
    ['now', 'now'], ['started', 'started'], ['question', 'question'], ['event-id', 'eventId'],
    ['from', 'from'], ['text', 'text'], ['reply-to', 'replyTo'], ['reply-to-ref', 'replyToRef'],
    ['ref', 'ref'], ['decision', 'decision'], ['patch', 'patch'],
    ['expected-revision', 'expectedRevision'], ['source', 'source'], ['evidence', 'evidence'],
    ['reason', 'reason'], ['activity', 'activity'], ['as', 'as'], ['when', 'when'],
    ['at', 'at'], ['room', 'room'],
  ];
  const argv = ['people.jsonl', ...flags.flatMap(([flag]) => [`--${flag}`, flag]), '--json'];
  assert.deepEqual(parse(argv), {
    options: { ...Object.fromEntries(flags.map(([flag, key]) => [key, flag])), json: true },
    positionals: ['people.jsonl'],
  });
  assert.throws(() => parse(['--unknown', 'value']), /invalid --unknown value/);
  assert.throws(() => parse(['--id']), /invalid --id value/);
  assert.throws(() => parse(['--name', '--json']), /invalid --name value/);
});

test('host CLI help and JSON output smoke', (t) => {
  const root = workspace(t);
  assert.match(run(root, 'host', '--help'), /usage: atris host setup\|join\|import/);
  assert.deepEqual(JSON.parse(run(root, 'host', 'setup', '--room', 'personal', '--json')), { room: 'personal' });
});

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

test('host install update refreshes the skill and leaves room files alone', (t) => {
  const root = workspace(t);
  const target = path.join(root, 'atris', 'team', 'host');
  const skill = path.join(target, 'skills', 'host', 'SKILL.md');
  run(root, 'member', 'install', 'host');
  fs.writeFileSync(skill, 'old host judgment\n');
  fs.writeFileSync(path.join(target, 'SOUL.md'), 'room soul\n');
  fs.rmSync(path.join(target, 'MISSION.md'));

  const first = run(root, 'member', 'install', 'host', '--update');
  assert.equal(first, 'atris/team/host/skills/host/SKILL.md\n');
  assert.equal(fs.readFileSync(skill, 'utf8'), fs.readFileSync(path.join(__dirname, '..', 'templates', 'members', 'host', 'skills', 'host', 'SKILL.md'), 'utf8'));
  assert.equal(fs.readFileSync(path.join(target, 'SOUL.md'), 'utf8'), 'room soul\n');
  assert.equal(fs.existsSync(path.join(target, 'MISSION.md')), false);
  assert.equal(run(root, 'member', 'install', 'host', '--update'), 'MEMBER host already up to date\n');
});

test('joining creates an ignore file inside the private folder', (t) => {
  const root = workspace(t);
  hostAction(root, 'join', { id: 'A1', name: 'Ann' });
  const ignore = path.join(root, 'atris', 'team', 'host', 'private', '.gitignore');
  assert.equal(fs.readFileSync(ignore, 'utf8'), '*\n');
});

test('personal joins and imports leave people uncontacted', (t) => {
  const root = workspace(t);
  assert.deepEqual(hostAction(root, 'setup', { room: 'personal' }), { room: 'personal' });
  hostAction(root, 'join', { id: 'friend:maya', name: 'Maya' });
  const file = importRows(root, 'friends.jsonl', [
    { person: { id: 'friend:dev', name: 'Dev' } },
    { person: { id: 'friend:eli', name: 'Eli' } },
  ]);
  assert.equal(hostAction(root, 'import', { file }).added, 2);
  for (const id of ['friend:maya', 'friend:dev', 'friend:eli']) assert.equal(privateData(root, id).told_host_sees_at, null);
  assert.deepEqual(outbox(root), []);
});

test('switching to personal removes queued welcomes and drafts existing messages', (t) => {
  const root = workspace(t);
  hostAction(root, 'join', { id: 'maya', name: 'Maya' });
  const asked = hostAction(root, 'ask', { id: 'maya', question: "What's Maya obsessed with lately?" });
  assert.equal(outbox(root).length, 2);
  hostAction(root, 'setup', { room: 'personal' });
  const messages = outbox(root);
  assert.deepEqual(messages.map((message) => message.id), [asked.message_id]);
  assert.equal(messages[0].draft, true);
  const saved = JSON.parse(fs.readFileSync(path.join(root, 'atris', 'team', 'host', 'private', 'outbox', `${asked.message_id}.json`), 'utf8'));
  assert.equal(saved.draft, true);
});

test('personal outbox messages are drafts across questions and introductions', (t) => {
  const root = workspace(t);
  const now = '2026-09-27T12:00:00.000Z';
  hostAction(root, 'setup', { room: 'personal' });
  hostAction(root, 'join', { id: 'maya', name: 'Maya', now });
  hostAction(root, 'join', { id: 'dev', name: 'Dev', now });
  hostAction(root, 'ask', { id: 'maya', question: "What's Maya obsessed with lately?", now });
  hostAction(root, 'propose', { a: 'maya', b: 'dev', reason: 'They could help each other.', activity: 'coffee', text: 'Maya, meet Dev.', now });
  hostAction(root, 'receive', { eventId: 'maya-yes', from: 'maya', text: 'yes', now });
  hostAction(root, 'receive', { eventId: 'dev-yes', from: 'dev', text: 'yes', now });
  const early = hostAction(root, 'outbox', { now });
  hostAction(root, 'outbox', { now: future(now, 4) });
  const messages = [...early, ...hostAction(root, 'outbox', { now: future(now, 15) })];
  for (const kind of ['question', 'intro_ask', 'intro', 'nudge', 'followup']) assert.ok(messages.some((message) => message.kind === kind), kind);
  assert.ok(messages.every((message) => message.draft === true));
  for (const message of hostAction(root, 'outbox', { now: future(now, 15) })) {
    const saved = JSON.parse(fs.readFileSync(path.join(root, 'atris', 'team', 'host', 'private', 'outbox', `${message.id}.json`), 'utf8'));
    assert.equal(saved.draft, true);
  }
});

test('the owner can answer a personal question for one person', (t) => {
  const root = workspace(t);
  hostAction(root, 'setup', { room: 'personal' });
  hostAction(root, 'join', { id: 'maya', name: 'Maya' });
  hostAction(root, 'join', { id: 'dev', name: 'Dev' });
  hostAction(root, 'ask', { id: 'maya', question: "What's Maya obsessed with lately?" });
  const reply = hostAction(root, 'receive', { eventId: 'owner-maya-1', from: 'maya', text: 'Ceramics.' });
  assert.deepEqual({ id: reply.id, kind: reply.kind }, { id: 'maya', kind: 'answer' });
  assert.match(fs.readFileSync(privateFile(root, 'maya'), 'utf8'), /Q: What's Maya obsessed with lately\?\n\nA: Ceramics\./);
  assert.doesNotMatch(fs.readFileSync(privateFile(root, 'dev'), 'utf8'), /Ceramics/);
});

test('setup rejects unknown rooms and preserves legacy numeric validation', (t) => {
  const root = workspace(t);
  hostAction(root, 'join', { id: 'ann', name: 'Ann' });
  const file = path.join(root, 'atris', 'team', 'host', 'private', 'config.json');
  const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete settings.room;
  fs.writeFileSync(file, JSON.stringify(settings));
  hostAction(root, 'join', { id: 'ben', name: 'Ben' });
  assert.equal(outbox(root).filter((message) => message.kind === 'welcome').length, 2);
  assert.throws(() => hostAction(root, 'setup', { room: 'unknown' }), /room must be personal or group/);
  assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(file, 'utf8')), 'room'), false);
  fs.writeFileSync(file, JSON.stringify({ ...settings, room: 'unknown' }));
  assert.throws(() => hostAction(root, 'due'), /malformed config/);
  fs.writeFileSync(file, JSON.stringify({ ...settings, cadence_days: 1.5 }));
  assert.throws(() => hostAction(root, 'due'), /malformed config/);
  fs.writeFileSync(file, JSON.stringify(settings));
  assert.deepEqual(hostAction(root, 'setup', { room: 'group' }), { room: 'group' });
});

test('import adds people before links and skips existing, forgotten, and repeated records', (t) => {
  const root = workspace(t);
  hostAction(root, 'join', { id: 'existing:a', name: 'Ada' });
  hostAction(root, 'join', { id: 'existing:b', name: 'Ben' });
  hostAction(root, 'join', { id: 'forgotten:c', name: 'Cora' });
  hostAction(root, 'forget', { id: 'forgotten:c' });
  hostAction(root, 'link', { a: 'existing:a', b: 'existing:b', source: 'channel', evidence: 'Team room' });
  const file = importRows(root, 'team.jsonl', [
    { person: { id: 'new:d', name: 'Dev', team: 'Coffee', started: '2024-01-10', door: 'slack:dev' } },
    { link: { a: 'new:d', b: 'new:e', source: 'answer', evidence: 'Worked together' } },
    { person: { id: 'existing:a', name: 'Ada' } },
    { person: { id: 'forgotten:c', name: 'Cora' } },
    { person: { id: 'new:e', name: 'Eli', manager: 'new:d' } },
    { link: { a: 'existing:b', b: 'existing:a', source: 'channel', evidence: 'Team room' } },
    { link: { a: 'new:e', b: 'existing:a', source: 'card', evidence: 'They already know each other' } },
    { link: { a: 'new:e', b: 'new:d', source: 'answer', evidence: 'Worked together' } },
    '',
  ]);
  const first = { added: 2, skipped: 1, refused: 1, links_added: 2, links_skipped: 2 };
  assert.deepEqual(hostAction(root, 'import', { file }), first);
  assert.equal(privateData(root, 'new:d').started_at, '2024-01-10T00:00:00.000Z');
  assert.equal(privateData(root, 'new:e').manager_id, 'new:d');
  assert.equal(fs.existsSync(privateFile(root, 'forgotten:c')), false);
  assert.deepEqual(outbox(root).filter((message) => message.kind === 'welcome' && message.to.startsWith('new:')).map((message) => message.to).sort(), ['new:d', 'new:e']);
  assert.match(hostOutput(root, 'import', file), /import complete: 0 added, 3 skipped, 1 refused, 0 links added, 4 links skipped/);
  assert.deepEqual(hostAction(root, 'import', { file }), { added: 0, skipped: 3, refused: 1, links_added: 0, links_skipped: 4 });
  assert.equal(fs.readFileSync(path.join(root, 'atris', 'team', 'host', 'private', 'links.jsonl'), 'utf8').trim().split('\n').length, 3);
  assert.equal(outbox(root).filter((message) => message.kind === 'welcome' && message.to.startsWith('new:')).length, 2);
});

test('import saves 1,000 links with one write and skips repeated links', (t) => {
  const root = workspace(t);
  hostAction(root, 'join', { id: 'A1', name: 'Ann' });
  hostAction(root, 'join', { id: 'B1', name: 'Bo' });
  hostAction(root, 'link', { a: 'A1', b: 'B1', source: 'channel', evidence: 'existing' });
  const link = (evidence) => ({ link: { a: 'B1', b: 'A1', source: 'channel', evidence } });
  const file = importRows(root, 'links.jsonl', [link('existing'), ...Array.from({ length: 998 }, (_, index) => link(`connection ${index}`)), link('connection 0')]);
  const linksFile = path.join(root, 'atris', 'team', 'host', 'private', 'links.jsonl');
  const originalRename = fs.renameSync;
  let writes = 0;
  fs.renameSync = function (from, to) { if (to === linksFile) writes += 1; return originalRename.call(this, from, to); };
  let counts;
  try { counts = hostAction(root, 'import', { file }); }
  finally { fs.renameSync = originalRename; }
  assert.deepEqual(counts, { added: 0, skipped: 0, refused: 0, links_added: 998, links_skipped: 2 });
  assert.equal(writes, 1);
  assert.equal(fs.readFileSync(linksFile, 'utf8').trim().split('\n').length, 999);
});

test('an invalid import line leaves every host record unchanged', (t) => {
  const root = workspace(t);
  hostAction(root, 'join', { id: 'existing:a', name: 'Ada' });
  const privateRoot = path.join(root, 'atris', 'team', 'host', 'private');
  const snapshot = (dir) => fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).map((entry) => [entry.name, entry.isDirectory() ? snapshot(path.join(dir, entry.name)) : fs.readFileSync(path.join(dir, entry.name), 'utf8')]) : null;
  const beforePrivate = snapshot(privateRoot);
  const beforeCards = snapshot(path.join(root, 'atris', 'wiki', 'people'));
  const file = importRows(root, 'invalid.jsonl', [
    { person: { id: 'new:b', name: 'Ben' } },
    '',
    { link: { a: 'existing:a', b: 'new:b', source: 'channel', evidence: 'Team room' } },
    { link: { a: 'existing:a', b: 'new:b', source: 'unknown', evidence: 'Bad source' } },
  ]);
  assert.throws(() => hostAction(root, 'import', { file }), /line 4: invalid link source/);
  assert.deepEqual(snapshot(privateRoot), beforePrivate);
  assert.deepEqual(snapshot(path.join(root, 'atris', 'wiki', 'people')), beforeCards);
  const malformed = importRows(root, 'malformed.jsonl', [{ person: { id: 'new:b', name: 'Ben' } }, '{']);
  assert.throws(() => hostAction(root, 'import', { file: malformed }), /line 2: malformed json/);
  assert.deepEqual(snapshot(privateRoot), beforePrivate);
});

test('import handles 500 people in one call', (t) => {
  const root = workspace(t);
  const file = importRows(root, 'large.jsonl', Array.from({ length: 500 }, (_, index) => ({ person: { id: `bulk:${index}`, name: `Person ${index}` } })));
  assert.deepEqual(hostAction(root, 'import', { file }), { added: 500, skipped: 0, refused: 0, links_added: 0, links_skipped: 0 });
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

test('question answers and standalone replies are each saved once', (t) => {
  const root = workspace(t);
  const [ada] = people(root);
  hostAction(root, 'ask', { id: ada, question: 'What made you smile?' });
  assert.equal(hostAction(root, 'receive', { eventId: 'once-answer', from: ada, text: 'A sunrise coffee walk.' }).kind, 'answer');
  let body = fs.readFileSync(privateFile(root, ada), 'utf8');
  assert.match(body, /Q: What made you smile\?\n\nA: A sunrise coffee walk\./);
  assert.equal(body.split('A sunrise coffee walk.').length - 1, 1);
  assert.doesNotMatch(body, /Note: A sunrise coffee walk\./);
  assert.equal(hostAction(root, 'receive', { eventId: 'once-note', from: ada, text: 'The team picnic.' }).kind, 'note');
  body = fs.readFileSync(privateFile(root, ada), 'utf8');
  assert.match(body, /Note: The team picnic\./);
  assert.equal(body.split('The team picnic.').length - 1, 1);
  assert.equal(hostAction(root, 'receive', { eventId: 'once-answer', from: ada, text: 'Different' }).duplicate, true);
  assert.equal(fs.readFileSync(privateFile(root, ada), 'utf8'), body);
});

test('an unclear intro reply is saved as a question answer or a note', (t) => {
  const root = workspace(t);
  const [ada, ben, cora, dev] = people(root);
  propose(root, ada, cora);
  hostAction(root, 'ask', { id: ada, question: 'What made you smile?' });
  assert.equal(hostAction(root, 'receive', { eventId: 'unclear-answer', from: ada, text: 'A coffee walk.' }).kind, 'answer');
  assert.match(fs.readFileSync(privateFile(root, ada), 'utf8'), /Q: What made you smile\?\n\nA: A coffee walk\./);
  assert.equal(privateData(root, ada).pending_question_id, null);
  assert.equal(outbox(root).filter((message) => message.to === ada && message.kind === 'clarify').length, 0);
  propose(root, ben, dev);
  assert.equal(hostAction(root, 'receive', { eventId: 'unclear-note', from: ben, text: 'The team picnic.' }).kind, 'clarify');
  assert.match(fs.readFileSync(privateFile(root, ben), 'utf8'), /Note: The team picnic\./);
  assert.equal(outbox(root).filter((message) => message.to === ben && message.kind === 'clarify').length, 1);
});

test('without reply-to a pending question takes a bare yes or no when no intro is open', (t) => {
  const root = workspace(t);
  const [ada, ben] = people(root);
  for (const [id, reply] of [[ada, 'yes'], [ben, 'no']]) {
    hostAction(root, 'ask', { id, question: 'What made you smile?' });
    const pending = privateData(root, id).pending_question_id;
    assert.equal(hostAction(root, 'receive', { eventId: `late-${reply}`, from: id, text: reply }).kind, 'answer');
    assert.notEqual(privateData(root, id).pending_question_id, pending);
    assert.equal(privateData(root, id).pending_question_id, null);
    assert.match(fs.readFileSync(privateFile(root, id), 'utf8'), new RegExp(`A: ${reply}`));
  }
});

test('reply-to routes a fun answer to its question while an intro ask is open', (t) => {
  const root = workspace(t);
  const [ada, , cora] = people(root);
  const asked = hostAction(root, 'ask', { id: ada, question: 'What made you smile?' });
  propose(root, ada, cora);
  const reply = hostAction(root, 'receive', { eventId: 'threaded-answer', from: ada, text: 'A tiny concert.', replyTo: asked.message_id });
  assert.equal(reply.kind, 'answer');
  assert.equal(privateData(root, ada).pending_question_id, null);
  assert.equal(introData(root).a_said, null);
  assert.match(fs.readFileSync(privateFile(root, ada), 'utf8'), /A: A tiny concert\./);
});

test('sent stores an optional provider reference and validates its size', (t) => {
  const root = workspace(t);
  const [ada, ben] = people(root);
  const adaMessage = outbox(root).find((message) => message.to === ada);
  const benMessage = outbox(root).find((message) => message.to === ben);
  const ref = 'x'.repeat(200);
  assert.deepEqual(hostAction(root, 'sent', { id: adaMessage.id, ref }), { id: adaMessage.id, state: 'sent' });
  const saved = JSON.parse(fs.readFileSync(path.join(root, 'atris', 'team', 'host', 'private', 'outbox', `${adaMessage.id}.json`), 'utf8'));
  assert.equal(saved.ref, ref);
  assert.equal(saved.state, 'sent');
  hostAction(root, 'sent', { id: benMessage.id });
  const withoutRef = JSON.parse(fs.readFileSync(path.join(root, 'atris', 'team', 'host', 'private', 'outbox', `${benMessage.id}.json`), 'utf8'));
  assert.equal(Object.hasOwn(withoutRef, 'ref'), false);
  assert.throws(() => hostAction(root, 'sent', { id: benMessage.id, ref: 'x\ny' }), /ref must be one line/);
  assert.throws(() => hostAction(root, 'sent', { id: benMessage.id, ref: 'x'.repeat(201) }), /ref must be at most 200 characters/);
});

test('reply-to-ref routes by provider reference and sender, with unknown refs unthreaded', (t) => {
  const root = workspace(t);
  const [ada, ben, cora] = people(root);
  const ref = '1712345678.123456';
  const benQuestion = hostAction(root, 'ask', { id: ben, question: 'What made you smile?' });
  hostAction(root, 'sent', { id: benQuestion.message_id, ref });
  const adaQuestion = hostAction(root, 'ask', { id: ada, question: 'What made you smile?' });
  hostAction(root, 'sent', { id: adaQuestion.message_id, ref });
  propose(root, ada, cora);
  const reply = hostAction(root, 'receive', { eventId: 'provider-answer', from: ada, text: 'A tiny concert.', replyToRef: ref });
  assert.equal(reply.kind, 'answer');
  assert.equal(privateData(root, ada).pending_question_id, null);
  assert.ok(privateData(root, ben).pending_question_id);
  assert.equal(introData(root).a_said, null);
  const unknown = hostAction(root, 'receive', { eventId: 'unknown-provider-ref', from: ada, text: 'Yes!', replyToRef: 'missing' });
  assert.equal(unknown.kind, 'intro_yes');
  assert.throws(() => hostAction(root, 'receive', { eventId: 'conflicting-refs', from: ada, text: 'Yes!', replyTo: adaQuestion.message_id, replyToRef: ref }), /choose --reply-to or --reply-to-ref/);
});

test('an unknown reply-to stays a note instead of answering another open prompt', (t) => {
  const root = workspace(t);
  const [ada, , cora] = people(root);
  hostAction(root, 'ask', { id: ada, question: 'What made you smile?' });
  propose(root, ada, cora);
  assert.equal(hostAction(root, 'receive', { eventId: 'unknown-thread', from: ada, text: 'Yes!', replyTo: 'missing-message' }).kind, 'note');
  assert.ok(privateData(root, ada).pending_question_id);
  assert.equal(introData(root).a_said, null);
});

test('first-word consent accepts a friendly yes and keeps the full note', (t) => {
  const root = workspace(t);
  const [ada, , cora] = people(root);
  propose(root, ada, cora);
  const ask = outbox(root).find((message) => message.to === ada && message.kind === 'intro_ask');
  assert.equal(hostAction(root, 'receive', { eventId: 'friendly-yes', from: ada, text: 'Yes! who is it?', replyTo: ask.id }).kind, 'intro_yes');
  assert.equal(introData(root).a_said, 'yes');
  assert.match(fs.readFileSync(privateFile(root, ada), 'utf8'), /Note: Yes! who is it\?/);
});

test('without reply-to a first-word yes goes to the open intro before the question', (t) => {
  const root = workspace(t);
  const [ada, , cora] = people(root);
  hostAction(root, 'ask', { id: ada, question: 'What made you smile?' });
  propose(root, ada, cora);
  assert.equal(hostAction(root, 'receive', { eventId: 'bare-intro-yes', from: ada, text: '🤝 Yep, sounds good.' }).kind, 'intro_yes');
  assert.ok(privateData(root, ada).pending_question_id);
  assert.equal(introData(root).a_said, 'yes');
});

test('unclear consent gets a private restatement of the specific offer', (t) => {
  const root = workspace(t);
  const [ada, , cora] = people(root);
  propose(root, ada, cora);
  assert.equal(hostAction(root, 'receive', { eventId: 'unclear-offer', from: ada, text: 'Tell me more.' }).kind, 'clarify');
  const clarify = outbox(root).find((message) => message.to === ada && message.kind === 'clarify');
  assert.equal(clarify.text, 'Quick check on the intro with Cora (a fifteen minute tasting): would you like it? Reply yes or no.');
  assert.equal(hostAction(root, 'receive', { eventId: 'clarified-yes', from: ada, text: 'Absolutely, sounds great.', replyTo: clarify.id }).kind, 'intro_yes');
});

test('due skips people awaiting an intro answer', (t) => {
  const root = workspace(t);
  const [ada, , cora] = people(root);
  propose(root, ada, cora);
  const due = hostAction(root, 'due');
  assert.equal(due.some((entry) => entry.id === ada || entry.id === cora), false);
});

test('people exposes only published cards and introduction availability', (t) => {
  const root = workspace(t);
  const [ada, , cora] = people(root);
  hostAction(root, 'receive', { eventId: 'private-note', from: ada, text: 'My secret answer.' });
  propose(root, ada, cora);
  const roster = hostAction(root, 'people');
  assert.equal(roster.length, 10);
  assert.equal(roster.find((entry) => entry.id === ada).can_be_introduced, false);
  assert.equal(roster.find((entry) => entry.id === cora).can_be_introduced, false);
  assert.equal(roster.find((entry) => entry.name === 'Eli').can_be_introduced, true);
  assert.deepEqual(Object.keys(roster[0]).sort(), ['id', 'name', 'team', 'manager_id', 'status', 'can_be_introduced', 'into_lately', 'going_for', 'great_at', 'wants_to_meet', 'worth_celebrating'].sort());
  assert.doesNotMatch(JSON.stringify(roster), /secret answer|declin|response_rate/i);
  assert.match(hostOutput(root, 'people'), /can be introduced: no/);
});

test('newcomers can have three sequential introductions while older people honor a saved cap of one', (t) => {
  const root = workspace(t);
  const [ada, , cora, dev, eli, fern, gio] = people(root);
  const settingsFile = path.join(root, 'atris', 'team', 'host', 'private', 'config.json');
  const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  delete settings.newcomer_intros_first_30d;
  settings.intros_per_person_per_30d = 1;
  fs.writeFileSync(settingsFile, JSON.stringify(settings));
  const available = (id) => hostAction(root, 'people').find((entry) => entry.id === id).can_be_introduced;
  const finish = (a, b, label) => {
    hostAction(root, 'receive', { eventId: `${label}-a`, from: a, text: 'yes' });
    hostAction(root, 'receive', { eventId: `${label}-b`, from: b, text: 'yes' });
  };
  propose(root, ada, cora);
  assert.equal(available(ada), false);
  assert.throws(() => propose(root, ada, dev), /person already has an introduction in flight/);
  finish(ada, cora, 'welcome-1');
  assert.equal(available(ada), true);
  propose(root, ada, dev);
  finish(ada, dev, 'welcome-2');
  settings.newcomer_intros_first_30d = 2;
  fs.writeFileSync(settingsFile, JSON.stringify(settings));
  assert.equal(available(ada), false);
  assert.throws(() => propose(root, ada, eli), /cadence reached/);
  delete settings.newcomer_intros_first_30d;
  fs.writeFileSync(settingsFile, JSON.stringify(settings));
  assert.equal(available(ada), true);
  propose(root, ada, eli);
  finish(ada, eli, 'welcome-3');
  assert.equal(available(ada), false);
  assert.throws(() => propose(root, ada, fern), /cadence reached/);
  const older = 'slack:older';
  hostAction(root, 'join', { id: older, name: 'Older', now: future(privateData(root, ada).joined_at, -31) });
  propose(root, older, fern);
  finish(older, fern, 'older-1');
  assert.equal(available(older), false);
  assert.throws(() => propose(root, older, gio), /cadence reached/);
});

test('older people get two introductions by default', (t) => {
  const root = workspace(t);
  const [, , cora, dev, eli] = people(root);
  const older = 'slack:older';
  hostAction(root, 'join', { id: older, name: 'Older', now: future(privateData(root, cora).joined_at, -31) });
  const finish = (other, label) => {
    propose(root, older, other);
    hostAction(root, 'receive', { eventId: `${label}-older`, from: older, text: 'yes' });
    hostAction(root, 'receive', { eventId: `${label}-other`, from: other, text: 'yes' });
  };
  finish(cora, 'first');
  assert.equal(hostAction(root, 'people').find((entry) => entry.id === older).can_be_introduced, true);
  finish(dev, 'second');
  assert.equal(hostAction(root, 'people').find((entry) => entry.id === older).can_be_introduced, false);
  assert.throws(() => propose(root, older, eli), /cadence reached/);
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
  assert.throws(() => propose(root, ids[0], ids[4]), /person already has an introduction in flight/);
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

test('an introduced pair gets a confirmed link and cannot be proposed again', (t) => {
  const root = workspace(t);
  const [ada, ben, cora, dev] = people(root);
  propose(root, ada, cora);
  hostAction(root, 'receive', { eventId: 'link-yes-1', from: ada, text: 'yes' });
  assert.equal(hostAction(root, 'receive', { eventId: 'link-yes-2', from: cora, text: 'yes' }).kind, 'introduced');
  const links = fs.readFileSync(path.join(root, 'atris', 'team', 'host', 'private', 'links.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(links.map(({ a, b, source, evidence }) => ({ a, b, source, evidence })), [{ a: ada, b: cora, source: 'intro', evidence: 'introduced by the Host' }]);
  assert.ok(Number.isFinite(Date.parse(links[0].at)));
  assert.throws(() => hostAction(root, 'propose', { a: ada, b: cora, reason: 'Meet again', activity: 'coffee', text: 'Hello', now: future(links[0].at, 31) }), /already linked/);
  assert.equal(hostAction(root, 'link', { a: ben, b: dev, source: 'intro', evidence: 'Introduced before tracking started.' }).linked, true);
});

test('followups queue once and two confirmations create one met link', (t) => {
  const root = workspace(t);
  const [ada, , cora] = people(root);
  const settingsFile = path.join(root, 'atris', 'team', 'host', 'private', 'config.json');
  const oldSettings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  delete oldSettings.followup_days;
  fs.writeFileSync(settingsFile, JSON.stringify(oldSettings));
  propose(root, ada, cora);
  hostAction(root, 'receive', { eventId: 'followup-intro-a', from: ada, text: 'Yes!' });
  hostAction(root, 'receive', { eventId: 'followup-intro-b', from: cora, text: 'Yep.' });
  const introduced = introData(root);
  assert.equal(introduced.followup_at, future(introduced.introduced_at, 14));
  const when = introduced.followup_at;
  const first = hostAction(root, 'outbox', { now: when }).filter((message) => message.kind === 'followup');
  assert.equal(first.length, 2);
  assert.equal(hostAction(root, 'outbox', { now: when }).filter((message) => message.kind === 'followup').length, 2);
  assert.match(first.find((message) => message.to === ada).text, /Did you and Cora end up doing a fifteen minute tasting\? Worth doing again\? Reply yes or no\./);
  assert.equal(hostAction(root, 'receive', { eventId: 'met-a', from: ada, text: 'Yes, and it was lovely.', replyTo: first.find((message) => message.to === ada).id, now: when }).kind, 'followup');
  assert.equal(hostAction(root, 'receive', { eventId: 'met-b', from: cora, text: 'Absolutely!', replyTo: first.find((message) => message.to === cora).id, now: when }).kind, 'followup');
  assert.equal(introData(root).a_met, 'yes');
  assert.equal(introData(root).b_met, 'yes');
  const links = fs.readFileSync(path.join(root, 'atris', 'team', 'host', 'private', 'links.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(links.filter((link) => link.source === 'met').length, 1);
  assert.match(hostAction(root, 'room', { now: when }).text, /## Introductions that happened\n\n1/);
});

test('a booked calendar time moves an unsent followup until after the meeting', (t) => {
  const root = workspace(t);
  const [ada, , cora, dev, eli] = people(root);
  const attempt = propose(root, ada, cora).attempt_id;
  hostAction(root, 'receive', { eventId: 'calendar-yes-a', from: ada, text: 'yes' });
  hostAction(root, 'receive', { eventId: 'calendar-yes-b', from: cora, text: 'yes' });
  const introduced = introData(root).introduced_at;
  const bookingAt = future(introduced, 20);
  const meetingAt = future(introduced, 21);
  const booked = hostAction(root, 'scheduled', { id: attempt, when: 'Tuesday at 2 pm', at: meetingAt, now: bookingAt });
  assert.equal(booked.scheduled_for, 'Tuesday at 2 pm');
  assert.equal(introData(root).scheduled_at, meetingAt);
  assert.equal(introData(root).followup_at, future(meetingAt, 1));
  assert.equal(introData(root).followup_sent, null);
  assert.equal(hostAction(root, 'outbox', { now: meetingAt }).filter((message) => message.kind === 'followup').length, 0);
  assert.equal(hostAction(root, 'outbox', { now: future(meetingAt, 1) }).filter((message) => message.kind === 'followup').length, 2);
  const second = propose(root, dev, eli).attempt_id;
  hostAction(root, 'receive', { eventId: 'calendar-yes-dev', from: dev, text: 'yes' });
  hostAction(root, 'receive', { eventId: 'calendar-yes-eli', from: eli, text: 'yes' });
  hostAction(root, 'scheduled', { id: second, when: 'Already met', at: future(introduced, 18), now: bookingAt });
  const secondFile = path.join(root, 'atris', 'team', 'host', 'private', 'intros', introFiles(root).find((name) => name.includes(second)));
  assert.equal(JSON.parse(fs.readFileSync(secondFile, 'utf8').match(/^followup_at: (.+)$/m)[1]), bookingAt);
});

test('a model decision overrides the first word for routed intro, clarify, and followup replies', (t) => {
  const root = workspace(t);
  const [ada, , cora] = people(root);
  propose(root, ada, cora);
  const ask = outbox(root).find((message) => message.to === ada && message.kind === 'intro_ask');
  assert.throws(() => hostAction(root, 'receive', { eventId: 'bad-decision', from: ada, text: 'Maybe', decision: 'maybe' }), /decision must be yes or no/);
  assert.equal(introData(root).a_said, null);
  assert.equal(hostAction(root, 'receive', { eventId: 'model-intro', from: ada, text: 'No, wait, I would love to', replyTo: ask.id, decision: 'yes' }).kind, 'intro_yes');
  assert.equal(introData(root).a_said, 'yes');
  assert.equal(hostAction(root, 'receive', { eventId: 'need-clarity', from: cora, text: 'Tell me more.' }).kind, 'clarify');
  const clarify = outbox(root).find((message) => message.to === cora && message.kind === 'clarify');
  assert.equal(hostAction(root, 'receive', { eventId: 'model-clarify', from: cora, text: 'Sounds like a plan', replyTo: clarify.id, decision: 'yes' }).kind, 'introduced');
  const when = introData(root).followup_at;
  const followup = hostAction(root, 'outbox', { now: when }).find((message) => message.to === ada && message.kind === 'followup');
  assert.equal(hostAction(root, 'receive', { eventId: 'model-followup', from: ada, text: 'Honestly, we did a quick coffee', replyTo: followup.id, decision: 'yes', now: when }).kind, 'followup');
  assert.equal(introData(root).a_met, 'yes');
});

test('one nudge per person can request a time and booking closes the schedule request', (t) => {
  const root = workspace(t);
  const [ada, , cora] = people(root);
  const settingsFile = path.join(root, 'atris', 'team', 'host', 'private', 'config.json');
  const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  delete settings.nudge_days;
  fs.writeFileSync(settingsFile, JSON.stringify(settings));
  const attempt = propose(root, ada, cora).attempt_id;
  const file = introFile(root);
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/^(nudge_at|nudge_sent|schedule_requested|scheduled_for): .*\n/gm, ''));
  hostAction(root, 'receive', { eventId: 'nudge-intro-a', from: ada, text: 'yes' });
  hostAction(root, 'receive', { eventId: 'nudge-intro-b', from: cora, text: 'yes' });
  const intro = introData(root);
  assert.equal(intro.nudge_at, future(intro.introduced_at, 3));
  assert.equal(hostAction(root, 'outbox', { now: future(intro.introduced_at, 2) }).filter((message) => message.kind === 'nudge').length, 0);
  const nudges = hostAction(root, 'outbox', { now: intro.nudge_at }).filter((message) => message.kind === 'nudge');
  assert.equal(nudges.length, 2);
  assert.equal(hostAction(root, 'outbox', { now: intro.nudge_at }).filter((message) => message.kind === 'nudge').length, 2);
  assert.equal(nudges.find((message) => message.to === ada).text, 'Want me to find a time for you and Cora to do a fifteen minute tasting? Say yes and I\'ll set it up.');
  assert.equal(hostAction(root, 'receive', { eventId: 'nudge-no', from: cora, text: 'Maybe later', decision: 'no', replyTo: nudges.find((message) => message.to === cora).id, now: intro.nudge_at }).kind, 'nudge');
  assert.equal(hostAction(root, 'schedule', { now: intro.nudge_at }).length, 0);
  assert.equal(hostAction(root, 'receive', { eventId: 'nudge-yes', from: ada, text: 'yes', now: intro.nudge_at }).kind, 'nudge');
  const requested = hostAction(root, 'schedule');
  assert.deepEqual(requested, [{ attempt_id: attempt, a: ada, b: cora, names: { a: 'Ada', b: 'Cora' }, activity: 'a fifteen minute tasting' }]);
  assert.match(hostOutput(root, 'schedule'), /Ada .* Cora/);
  const booked = hostAction(root, 'scheduled', { id: attempt, when: 'Friday at 2 pm' });
  assert.equal(booked.scheduled_for, 'Friday at 2 pm');
  assert.equal(introData(root).scheduled_at, null);
  assert.equal(introData(root).followup_at, intro.followup_at);
  assert.equal(introData(root).schedule_requested, false);
  assert.equal(hostAction(root, 'schedule').length, 0);
  assert.equal(outbox(root).filter((message) => message.kind === 'booked').length, 2);
  assert.equal(outbox(root).find((message) => message.kind === 'booked' && message.to === ada).text, 'Booked: a fifteen minute tasting with Cora, Friday at 2 pm. Have fun.');
  assert.throws(() => hostAction(root, 'scheduled', { id: attempt, when: 'Saturday' }), /already scheduled/);
});

test('unanswered questions cause a timed rest while an explicit pause stays paused', (t) => {
  const root = workspace(t);
  const [ada] = people(root);
  const file = privateFile(root, ada);
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/^rest_until: .*\n/m, ''));
  const settingsFile = path.join(root, 'atris', 'team', 'host', 'private', 'config.json');
  const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  delete settings.rest_days;
  fs.writeFileSync(settingsFile, JSON.stringify(settings));
  const patch = path.join(root, 'milestone.json');
  fs.writeFileSync(patch, JSON.stringify({ worth_celebrating: 'A private milestone' }));
  hostAction(root, 'card', { id: ada, patch, expectedRevision: privateData(root, ada).revision });
  const start = privateData(root, ada).joined_at;
  hostAction(root, 'ask', { id: ada, question: 'First question?', now: start });
  hostAction(root, 'due', { now: future(start, 8) });
  hostAction(root, 'ask', { id: ada, question: 'Second question?', now: future(start, 8) });
  const rested = future(start, 16);
  hostAction(root, 'due', { now: rested });
  assert.equal(privateData(root, ada).status, 'paused');
  assert.equal(privateData(root, ada).rest_until, future(rested, 21));
  assert.doesNotMatch(hostAction(root, 'room', { now: rested }).text, /rest|paused|private milestone/i);
  assert.equal(hostAction(root, 'due', { now: future(rested, 20) }).some((entry) => entry.id === ada), false);
  assert.equal(hostAction(root, 'due', { now: future(rested, 21) }).some((entry) => entry.id === ada), true);
  assert.equal(privateData(root, ada).unanswered_count, 0);
  assert.equal(privateData(root, ada).rest_until, null);
  hostAction(root, 'pause', { id: ada, now: future(rested, 21) });
  hostAction(root, 'due', { now: future(rested, 100) });
  assert.equal(privateData(root, ada).status, 'paused');
  assert.equal(privateData(root, ada).rest_until, null);
});

test('a late reply wakes a resting person while a self-paused reply stays a note', (t) => {
  const root = workspace(t);
  const now = '2026-09-27T12:00:00.000Z';
  for (const id of ['ada', 'ben', 'cora']) hostAction(root, 'join', { id, name: id, now });
  hostAction(root, 'ask', { id: 'ada', question: 'What made you smile?', now });
  const file = privateFile(root, 'ada');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8')
    .replace(/^status: .*$/m, 'status: "paused"')
    .replace(/^unanswered_count: .*$/m, 'unanswered_count: 2')
    .replace(/^rest_until: .*$/m, `rest_until: "${future(now, 21)}"`));
  const repliedAt = future(now, 1);
  assert.equal(hostAction(root, 'receive', { eventId: 'late-answer', from: 'ada', text: 'A sunrise walk.', now: repliedAt }).kind, 'answer');
  const awake = privateData(root, 'ada');
  assert.equal(awake.status, 'active');
  assert.equal(awake.unanswered_count, 0);
  assert.equal(awake.rest_until, null);
  assert.equal(awake.next_question_at, repliedAt);
  assert.match(fs.readFileSync(file, 'utf8'), /Q: What made you smile\?\n\nA: A sunrise walk\./);
  assert.equal(hostAction(root, 'receive', { eventId: 'late-answer', from: 'ada', text: 'Different', now: repliedAt }).duplicate, true);

  hostAction(root, 'ask', { id: 'ben', question: 'What made you smile?', now });
  hostAction(root, 'pause', { id: 'ben', now });
  assert.equal(hostAction(root, 'receive', { eventId: 'paused-note', from: 'ben', text: 'The team picnic.', now: repliedAt }).kind, 'note');
  assert.equal(privateData(root, 'ben').status, 'paused');
  assert.equal(privateData(root, 'ben').rest_until, null);
  assert.ok(privateData(root, 'ben').pending_question_id);
  assert.match(fs.readFileSync(privateFile(root, 'ben'), 'utf8'), /Note: The team picnic\./);

  hostAction(root, 'leave', { id: 'cora', now });
  assert.throws(() => hostAction(root, 'receive', { eventId: 'left-reply', from: 'cora', text: 'Hello.', now: repliedAt }), /person is not active/);
  assert.doesNotMatch(fs.readFileSync(privateFile(root, 'cora'), 'utf8'), /Hello\./);
});

test('old sent messages archive once per UTC day while recent and queued messages stay', (t) => {
  const root = workspace(t);
  const start = '2026-07-01T12:00:00.000Z';
  const now = '2026-09-27T12:00:00.000Z';
  hostAction(root, 'join', { id: 'ada', name: 'Ada', now: start });
  const dir = path.join(root, 'atris', 'team', 'host', 'private', 'outbox');
  const write = (suffix, created, state) => {
    const id = `00000000-0000-4000-8000-${suffix}`;
    const file = path.join(dir, `${id}.json`);
    fs.writeFileSync(file, JSON.stringify({ id, to: 'ada', door: 'ada', kind: 'question', text: 'Hello?', created_at: created, state }));
    return { id, file };
  };
  const july = write('000000000001', start, 'sent');
  const august = write('000000000002', '2026-08-01T12:00:00.000Z', 'sent');
  const recent = write('000000000003', '2026-09-01T12:00:00.000Z', 'sent');
  const queued = write('000000000004', start, 'queued');
  hostAction(root, 'outbox', { now });
  const archive = path.join(dir, 'archive');
  const readArchive = (month) => fs.readFileSync(path.join(archive, `${month}.jsonl`), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(readArchive('2026-07').map((message) => message.id), [july.id]);
  assert.deepEqual(readArchive('2026-08').map((message) => message.id), [august.id]);
  assert.equal(fs.existsSync(july.file), false);
  assert.equal(fs.existsSync(august.file), false);
  assert.equal(fs.existsSync(recent.file), true);
  assert.equal(fs.existsSync(queued.file), true);
  const marker = path.join(root, 'atris', 'team', 'host', 'private', 'outbox-archived-on');
  assert.equal(fs.readFileSync(marker, 'utf8'), '2026-09-27\n');
  assert.equal(hostAction(root, 'receive', { eventId: 'archived-reply', from: 'ada', text: 'Hello.', replyTo: july.id, now }).kind, 'note');
  const late = write('000000000005', start, 'sent');
  hostAction(root, 'outbox', { now });
  assert.equal(fs.existsSync(late.file), true);
  assert.deepEqual(readArchive('2026-07').map((message) => message.id), [july.id]);
  assert.equal(fs.readFileSync(marker, 'utf8'), '2026-09-27\n');
  hostAction(root, 'outbox', { now: future(now, 1) });
  assert.equal(fs.existsSync(late.file), false);
  assert.deepEqual(readArchive('2026-07').map((message) => message.id), [july.id, late.id]);
});

test('an introduction saved before followup fields existed still loads and gains them on write', (t) => {
  const root = workspace(t);
  const [ada, , cora] = people(root);
  propose(root, ada, cora);
  const file = introFile(root);
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/^(introduced_at|followup_at|followup_sent|a_met|b_met|scheduled_at): .*\n/gm, ''));
  assert.equal(hostAction(root, 'receive', { eventId: 'old-intro-yes', from: ada, text: 'Yes.' }).kind, 'intro_yes');
  assert.equal(introData(root).a_met, null);
  assert.equal(introData(root).followup_at, null);
  assert.equal(introData(root).scheduled_at, null);
  assert.ok(fs.readFileSync(file, 'utf8').includes('followup_sent: null'));
});

test('room reports first-month connections for a completed cohort', (t) => {
  const root = workspace(t);
  const ids = people(root);
  const joined = privateData(root, ids[0]).joined_at;
  const reportAt = future(joined, 60);
  hostAction(root, 'leave', { id: ids[9] });
  const small = hostAction(root, 'room', { now: reportAt }).text.split('## New people finding their people\n\n')[1].split('\n\n##')[0];
  assert.equal(small, 'Not enough people have finished their first month yet to report this (need 10).\nIn their first month now: 0');
  hostAction(root, 'resume', { id: ids[9] });
  hostAction(root, 'link', { a: ids[0], b: ids[2], source: 'met', evidence: 'Both confirmed coffee.', now: future(joined, 20) });
  hostAction(root, 'link', { a: ids[0], b: ids[2], source: 'met', evidence: 'Both confirmed lunch.', now: future(joined, 21) });
  hostAction(root, 'link', { a: ids[0], b: ids[3], source: 'met', evidence: 'Both confirmed a walk.', now: future(joined, 31) });
  hostAction(root, 'link', { a: ids[0], b: ids[4], source: 'answer', evidence: 'They know each other.', now: future(joined, 10) });
  const before = hostAction(root, 'room', { now: reportAt }).text;
  assert.match(before, /0 of 10 people who joined in the last few months found at least two people in their first 30 days\./);
  hostAction(root, 'link', { a: ids[0], b: ids[5], source: 'met', evidence: 'Both confirmed a tasting.', now: future(joined, 30) });
  hostAction(root, 'join', { id: 'slack:new', name: 'New', now: future(joined, 45) });
  const coverage = hostAction(root, 'room', { now: reportAt }).text.split('## New people finding their people\n\n')[1].split('\n\n##')[0];
  assert.equal(coverage, '1 of 10 people who joined in the last few months found at least two people in their first 30 days.\nIn their first month now: 1');
  assert.doesNotMatch(coverage, /Ada|Cora|Dev|New/);
});

test('imported staff use company start dates for welcomes and first-month coverage', (t) => {
  const root = workspace(t);
  const now = '2026-09-26T12:00:00.000Z';
  const oldStart = '2024-09-26';
  const cohortStart = future(now, -60);
  const old = ['Old One', 'Old Two', 'Old Three'].map((name, index) => {
    const id = `old:${index}`;
    hostAction(root, 'join', { id, name, now, started: oldStart });
    assert.equal(privateData(root, id).joined_at, now);
    assert.equal(privateData(root, id).started_at, '2024-09-26T00:00:00.000Z');
    return id;
  });
  const cohort = Array.from({ length: 10 }, (_, index) => {
    const id = `cohort:${index}`;
    hostAction(root, 'join', { id, name: `Cohort ${index}`, now, started: cohortStart });
    return id;
  });
  const fresh = 'fresh:1';
  hostAction(root, 'join', { id: fresh, name: 'Fresh', now });
  assert.equal(privateData(root, fresh).started_at, now);
  assert.throws(() => hostAction(root, 'join', { id: 'invalid:1', name: 'Invalid', now, started: 'yesterday' }), /started must be an ISO date or time/);

  const settingsFile = path.join(root, 'atris', 'team', 'host', 'private', 'config.json');
  const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  settings.intros_per_person_per_30d = 1;
  fs.writeFileSync(settingsFile, JSON.stringify(settings));
  for (const [index, id] of [...old, fresh].entries()) {
    hostAction(root, 'propose', { a: id, b: cohort[index], reason: 'A shared project.', activity: 'coffee', text: 'Meet for coffee.', now });
    hostAction(root, 'receive', { eventId: `yes-${index}-a`, from: id, text: 'yes', now });
    hostAction(root, 'receive', { eventId: `yes-${index}-b`, from: cohort[index], text: 'yes', now });
  }
  const available = hostAction(root, 'people', { now });
  for (const id of old) assert.equal(available.find((entry) => entry.id === id).can_be_introduced, false);
  assert.equal(available.find((entry) => entry.id === fresh).can_be_introduced, true);

  const oldRecord = privateFile(root, fresh);
  fs.writeFileSync(oldRecord, fs.readFileSync(oldRecord, 'utf8').replace(/^started_at: .*\n/m, ''));
  assert.equal(hostAction(root, 'view', { as: fresh }).own.started_at, null);
  assert.equal(hostAction(root, 'people', { now }).find((entry) => entry.id === fresh).can_be_introduced, true);
  const room = hostAction(root, 'room', { now }).text;
  assert.match(room, /0 of 10 people who joined in the last few months/);
  assert.match(room, /In their first month now: 1/);
  assert.equal(room.split('## Suggested welcomes\n\n')[1].trim(), 'Fresh');

  hostAction(root, 'link', { a: cohort[4], b: cohort[5], source: 'met', evidence: 'Met after install.', now });
  hostAction(root, 'link', { a: cohort[4], b: cohort[6], source: 'met', evidence: 'Met after install.', now });
  assert.match(hostAction(root, 'room', { now }).text, /0 of 10 people who joined in the last few months/);
  hostAction(root, 'link', { a: cohort[7], b: cohort[8], source: 'met', evidence: 'Met in the first month.', now: future(cohortStart, 20) });
  hostAction(root, 'link', { a: cohort[7], b: cohort[9], source: 'met', evidence: 'Met in the first month.', now: future(cohortStart, 20) });
  assert.match(hostAction(root, 'room', { now }).text, /1 of 10 people who joined in the last few months/);
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
  assert.throws(() => hostAction(root, 'due'), /malformed record/);
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

test('forget removes matching archived messages and deletes an empty archive', (t) => {
  const root = workspace(t);
  const january = '2026-01-01T12:00:00.000Z';
  const february = '2026-02-01T12:00:00.000Z';
  const march = '2026-03-10T12:00:00.000Z';
  for (const name of ['Ada', 'Ben', 'Cora']) hostAction(root, 'join', { id: name.toLowerCase(), name, now: january });
  const welcome = hostAction(root, 'outbox', { now: january }).find((message) => message.to === 'ada' && message.kind === 'welcome');
  hostAction(root, 'sent', { id: welcome.id, now: january });

  const intro = hostAction(root, 'propose', { a: 'ada', b: 'ben', reason: 'They both enjoy coffee.', activity: 'a coffee tasting', text: 'Ada, meet Ben.', now: february });
  const introMessages = hostAction(root, 'outbox', { now: february }).filter((message) => message.attempt_id === intro.attempt_id);
  assert.deepEqual(introMessages.map((message) => message.to).sort(), ['ada', 'ben']);
  for (const message of introMessages) hostAction(root, 'sent', { id: message.id, now: february });
  const question = hostAction(root, 'ask', { id: 'cora', question: 'What made you smile?', now: february });
  hostAction(root, 'sent', { id: question.message_id, now: february });

  hostAction(root, 'outbox', { now: march });
  const archive = path.join(root, 'atris', 'team', 'host', 'private', 'outbox', 'archive');
  const januaryFile = path.join(archive, '2026-01.jsonl');
  const februaryFile = path.join(archive, '2026-02.jsonl');
  const archived = (file) => fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(archived(januaryFile).map((message) => message.id), [welcome.id]);
  assert.deepEqual(archived(februaryFile).map((message) => message.id).sort(), [...introMessages.map((message) => message.id), question.message_id].sort());
  assert.ok(archived(februaryFile).some((message) => message.to === 'ben' && message.attempt_id === intro.attempt_id));

  hostAction(root, 'forget', { id: 'ada', now: march });
  assert.equal(fs.existsSync(januaryFile), false);
  assert.deepEqual(archived(februaryFile).map((message) => message.id), [question.message_id]);
});

test('forget clears the forgotten manager from other people', (t) => {
  const root = workspace(t);
  const [ada, ben] = people(root);
  const revision = privateData(root, ben).revision;
  assert.equal(privateData(root, ben).manager_id, ada);
  hostAction(root, 'forget', { id: ada });
  assert.equal(privateData(root, ben).manager_id, null);
  assert.equal(privateData(root, ben).revision, revision + 1);
});

test('resume clears the unanswered question count', (t) => {
  const root = workspace(t);
  const [ada] = people(root);
  const joined = privateData(root, ada).joined_at;
  hostAction(root, 'ask', { id: ada, question: 'What made you smile?', now: joined });
  hostAction(root, 'due', { now: future(joined, 8) });
  assert.equal(privateData(root, ada).unanswered_count, 1);
  hostAction(root, 'pause', { id: ada, now: future(joined, 8) });
  hostAction(root, 'resume', { id: ada, now: future(joined, 9) });
  assert.equal(privateData(root, ada).status, 'active');
  assert.equal(privateData(root, ada).unanswered_count, 0);
});

test('left people are absent from card views and room celebrations', (t) => {
  const root = workspace(t);
  const [ada, , cora] = people(root);
  const patch = path.join(root, 'patch.json');
  fs.writeFileSync(patch, JSON.stringify({ worth_celebrating: 'Opened a new cafe' }));
  hostAction(root, 'card', { id: ada, patch, expectedRevision: privateData(root, ada).revision });
  hostAction(root, 'leave', { id: ada });
  assert.equal(hostAction(root, 'view', { as: cora }).cards.some((card) => card.id === ada), false);
  assert.equal(hostAction(root, 'view', { team: 'Northwind Coffee' }).cards.some((card) => card.id === ada), false);
  assert.doesNotMatch(hostAction(root, 'room').text, /Opened a new cafe/);
});

test('the host skill limits links and intro reasons to published facts', () => {
  const skill = fs.readFileSync(path.join(__dirname, '..', 'templates', 'members', 'host', 'skills', 'host', 'SKILL.md'), 'utf8');
  assert.match(skill, /Record a link only when two people already know each other/);
  assert.match(skill, /"Wants to meet" belongs on the card, not in links\./);
  assert.match(skill, /Use only what is on both published cards, never private answers\./);
  assert.match(skill, /never read anyone's messages/);
  assert.match(skill, /^## In a personal room$/m);
  assert.match(skill, /^## The morning read$/m);
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

test('host activity reads naturally mid-sentence', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'host-activity-'));
  fs.mkdirSync(path.join(root, 'atris'));
  hostAction(root, 'join', { id: 'A1', name: 'Ann', now: '2026-10-01T00:00:00.000Z' });
  hostAction(root, 'join', { id: 'B1', name: 'Bo', now: '2026-10-01T00:00:00.000Z' });
  hostAction(root, 'propose', { a: 'A1', b: 'B1', reason: 'Both want it.', activity: 'A 30-minute coffee on the roof.', text: 'Meet!', now: '2026-10-01T00:00:00.000Z' });
  const ask = hostAction(root, 'outbox', { now: '2026-10-01T00:00:00.000Z' }).find((message) => message.kind === 'intro_ask');
  assert.match(ask.text, /enjoy a 30-minute coffee on the roof\. Both want it\./);
});

test('housekeeping and room share each private record read', (t) => {
  const root = workspace(t);
  const now = '2026-10-01T09:00:00.000Z';
  hostAction(root, 'join', { id: 'A1', name: 'Ann', now });
  hostAction(root, 'join', { id: 'B1', name: 'Bo', now });
  hostAction(root, 'link', { a: 'A1', b: 'B1', source: 'card', evidence: 'Both like coffee', now });
  hostAction(root, 'propose', { a: 'A1', b: 'B1', reason: 'Both like coffee.', activity: 'coffee', text: 'Meet!', now });
  hostAction(root, 'ask', { id: 'A1', question: 'Coffee?', now });
  const reads = new Map(), writes = [];
  const originalRead = fs.readFileSync, originalRename = fs.renameSync;
  fs.readFileSync = function (file, ...args) {
    if (typeof file === 'string' && file.startsWith(path.join(root, 'atris', 'team', 'host', 'private'))) reads.set(file, (reads.get(file) || 0) + 1);
    return originalRead.call(this, file, ...args);
  };
  fs.renameSync = function (from, to) { writes.push(to); return originalRename.call(this, from, to); };
  try { hostAction(root, 'room', { now: future(now, 8) }); }
  finally { fs.readFileSync = originalRead; fs.renameSync = originalRename; }
  assert.ok([...reads.keys()].some((file) => file.endsWith('links.jsonl')));
  assert.ok([...reads.keys()].some((file) => file.includes('/intros/')));
  assert.ok([...reads.keys()].some((file) => file.includes('/outbox/')));
  assert.ok([...reads.keys()].every((file) => reads.get(file) === 1), [...reads].filter(([, count]) => count > 1));
  assert.equal(writes.includes(privateFile(root, 'B1')), false);
});
