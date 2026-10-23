'use strict';

// Codex review round 6 on #1483: members woken by a handoff now depend on the
// yes-lock, so its older gaps are closed here.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { scrubAgentEnv } = require('./helpers/agent-env');
const yesLock = require('../lib/yes-lock');

const cli = path.resolve(__dirname, '..', 'bin', 'atris.js');

function tmp(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function git(cwd, args) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr || res.stdout);
  return String(res.stdout || '').trim();
}

// ---- 1: the seal is never read from text the handoff controls ------------------

test('1: mission start refuses a second --yes-lock, so text cannot replace the seal', (t) => {
  const root = tmp(t, 'atris-r6-seal-');
  const home = tmp(t, 'atris-r6-home-');
  const seal = JSON.stringify(yesLock.handoffSeal());
  const run = (args) => spawnSync(process.execPath, [cli, 'mission', 'start', ...args], {
    cwd: root, encoding: 'utf8', env: { ...scrubAgentEnv(process.env), HOME: home, ATRIS_SKIP_UPDATE_CHECK: '1' },
  });
  for (const args of [
    ['--yes-lock=[]', '--owner', 'validator', '--no-verify', '--yes-lock', seal, '--json'],
    ['check the page', '--owner', 'validator', '--no-verify', '--yes-lock', '[]', '--yes-lock', seal, '--json'],
  ]) {
    const res = run(args);
    assert.notEqual(res.status, 0, `started with ${args.join(' ')}: ${res.stdout}`);
    assert.match(res.stdout + res.stderr, /more than one --yes-lock|Usage: atris mission start/);
    assert.equal(fs.existsSync(path.join(root, '.atris', 'state', 'missions.jsonl')), false, 'no mission started');
  }
});

// ---- 2: first-party outward atris commands are held -----------------------------

test('2: atris verbs that spend, post, send, publish or deploy are held; unknown verbs are held', () => {
  const cats = (args) => yesLock.analyze('atris', args);
  assert.deepEqual(cats(['pay', 'vendor', '50']).cats, ['spend']);
  assert.deepEqual(cats(['buy', 'tickets']).cats, ['spend']);
  assert.deepEqual(cats(['topup', '20']).cats, ['spend']);
  assert.deepEqual(cats(['feed', 'post', 'we shipped']).cats, ['post']);
  assert.deepEqual(cats(['site', 'publish']).cats.sort(), ['deploy', 'publish']);
  assert.deepEqual(cats(['publish']).cats, ['publish']);
  assert.deepEqual(cats(['autoland']).cats, ['merge']);
  assert.deepEqual(cats(['msg', 'sam', 'hi']).cats, ['send']);
  assert.ok(cats(['frobnicate', 'everything']).refuse, 'an unknown verb is held');
  assert.ok(cats(['approve', '1']).refuse, 'answering owner asks from inside a held run is held');
  // the run's own machinery and reads still go
  for (const ok of [['mission', 'status'], ['member', 'handoff', 'a', 'b', 'x'], ['task', 'list'], ['log', 'did it'], ['feed'], ['site', 'status'], ['balance']]) {
    assert.deepEqual(cats(ok), { cats: [], refuse: null }, ok.join(' '));
  }
  // spending has its own kind, in owner steps and in the handoff seal
  assert.ok(yesLock.handoffSeal().some((s) => s.categories.includes('spend')));
  assert.ok(yesLock.sealFor([{ text: 'pay the hosting bill', who: 'you', public: false }]).some((s) => s.categories.includes('spend')));
});

// ---- 3: a stored git alias named after a built-in never applies -----------------

test('3: an alias named push is ignored, as git ignores it, and alias writes are held', (t) => {
  const root = tmp(t, 'atris-r6-alias-');
  git(root, ['init', '-q', '-b', 'master']);
  git(root, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'base']);
  git(root, ['config', 'alias.push', 'status']);
  const gitBin = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  const read = (args) => yesLock.analyze('git', args, yesLock.gitContext(gitBin, root));
  assert.deepEqual(read(['push', 'origin', 'master']).cats, ['merge'], 'push is push');
  assert.ok(read(['config', 'alias.ship', 'push origin master']).refuse, 'writing an alias is held');
  assert.ok(read(['config', '--global', 'alias.ship', '!git push']).refuse);
  assert.ok(read(['-c', 'alias.ship=push', 'ship']).refuse, 'an alias given with -c is held');
  assert.deepEqual(read(['config', '--get', 'alias.push']), { cats: [], refuse: null }, 'reading config still runs');
  assert.deepEqual(read(['status']), { cats: [], refuse: null });
});

// ---- 4: a yes releases only the command on the card that was answered ----------

const SEAL = [{ step: 2, text: 'release the package', categories: ['publish'] }];

function lockDir(t) {
  const dir = tmp(t, 'atris-r6-state-');
  yesLock.writeYesLocks(dir, 'm', { seal: SEAL });
  return dir;
}

const checkIn = (dir, tool, args) => yesLock.check({ stateDir: dir, missionId: 'm', seal: SEAL, tool, args, cwd: dir });

test('4: two held commands are two cards, and answering one releases only that one', (t) => {
  const dir = lockDir(t);
  assert.equal(checkIn(dir, 'npm', ['publish', './a']).hold, true);
  assert.equal(checkIn(dir, 'npm', ['publish', './b']).hold, true);
  const cards = yesLock.askedYesLocks(dir, 'm');
  assert.deepEqual(cards.map((c) => c.held_command), ['npm publish ./a', 'npm publish ./b'], 'B did not replace A');
  assert.equal(new Set(cards.map((c) => c.hash)).size, 2);
  const a = cards[0];
  assert.ok(yesLock.approveYesLock(dir, 'm', a.step, SEAL, undefined, { hash: a.hash }));
  assert.equal(checkIn(dir, 'npm', ['publish', './b']).hold, true, 'the yes for A never releases B');
  assert.ok(checkIn(dir, 'npm', ['publish', './a']).consume, 'A runs');
  assert.equal(yesLock.approveYesLock(dir, 'm', a.step, SEAL, undefined, { hash: 'nope' }), null, 'a card that matches nothing approves nothing');
  assert.deepEqual(yesLock.askedYesLocks(dir, 'm').map((c) => c.held_command), ['npm publish ./b'], 'B still waits on its own card');
});

// ---- 5: one yes is one attempt, used when the command starts --------------------

test('5: a yes is used when the command starts, so a failed run does not get another go', (t) => {
  const dir = lockDir(t);
  checkIn(dir, 'npm', ['publish', './a']);
  const [card] = yesLock.askedYesLocks(dir, 'm');
  yesLock.approveYesLock(dir, 'm', card.step, SEAL, undefined, { hash: card.hash });
  const first = checkIn(dir, 'npm', ['publish', './a']);
  assert.ok(first.consume, 'the first attempt runs');
  yesLock.consume(dir, 'm', SEAL, first.consume, { ok: false, claims: first.claims });
  assert.equal(checkIn(dir, 'npm', ['publish', './a']).hold, true, 'the failed attempt used the yes');
});

// ---- P2: a refused command is a card too ------------------------------------------

test('P2: a command the lock refuses outright becomes a yes card, not a silent 77', (t) => {
  const dir = lockDir(t);
  const held = checkIn(dir, 'npx', ['vercel', 'deploy']);
  assert.equal(held.hold, true);
  const [card] = yesLock.askedYesLocks(dir, 'm');
  assert.equal(card.held_command, 'npx vercel deploy');
  yesLock.approveYesLock(dir, 'm', card.step, SEAL, undefined, { hash: card.hash });
  assert.ok(checkIn(dir, 'npx', ['vercel', 'deploy']).consume, 'the yes lets that one command run');
  assert.equal(checkIn(dir, 'npx', ['vercel', 'deploy']).hold, true, 'once');
});
