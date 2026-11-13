'use strict';

// atris agent pull | push | snapshot | spawn against a local fake of the
// /api/agents/{id}/home routes: repeat pulls move nothing, adapters carry the
// soul and mission, the agent cannot rewrite MEMBER.md, spawn keys are 0600
// and never printed, and a server without agent homes gets one plain sentence.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const { isHomeCommand, movesForward } = require('../commands/agent-home');
const { withBlock, BLOCK_START, BLOCK_END, homeRel } = require('../lib/agent-home');

const cliPath = path.join(__dirname, '..', 'bin', 'atris.js');
const TOKEN = 'agent-tok-1a2b3c4d5e6f';
const AGENT = '11111111-2222-3333-4444-555555555555';
const PRIVATE_KEY = 'cHJpdmF0ZS1rZXktbmV2ZXItcHJpbnQtdGhpcw==';

const MEMBER = `---\nname: scout\nrole: Market Scout\nmember_id: ${AGENT}\nparent: null\nformat: 1\n---\n\n# Scout\n\nFinds new signal for the team.\n`;
const SOUL = '---\nname: scout-soul\n---\n\n# Soul\n\nCuriosity before certainty. Leaves a trail.\n';
const MISSION = '# Mission\n\n<!-- durable -->\n\nFind three new customers who answer email.\n';

function etag(text) {
  return crypto.createHash('md5').update(text).digest('hex');
}

// A fake home store: one page per bundle answer so `next` is exercised.
function fakeServer({ files, homes = true } = {}) {
  const store = new Map(Object.entries(files || {}));
  const seen = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : null;
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
      const send = (code, data) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
      if (req.url === '/api/auth/validate') return send(200, { valid: true, user: { id: 'u1' } });
      if (!homes) return send(404, { detail: 'Not Found' });
      const base = `/api/agents/${AGENT}`;
      if (req.method === 'POST' && req.url === `${base}/home/bundle`) {
        const names = [...store.keys()].sort();
        const after = body.after || '';
        const gone = after ? [] : Object.keys(body.have).filter((p) => !store.has(p));
        const pages = [];
        let unchanged = 0;
        let next = null;
        for (const name of names.filter((n) => n > after)) {
          const text = store.get(name);
          if (body.have[name] === etag(text)) { unchanged += 1; continue; }
          if (pages.length) { next = pages[pages.length - 1].path; break; }
          pages.push({ path: name, etag: etag(text), text });
        }
        return send(200, { pages, unchanged, gone, skipped: [], next });
      }
      if (req.method === 'PUT' && req.url === `${base}/home/files`) {
        const written = [];
        const rejected = [];
        for (const f of body.files) {
          if (f.path === 'MEMBER.md') { rejected.push({ path: f.path, reason: 'The agent may not rewrite MEMBER.md.' }); continue; }
          store.set(f.path, f.text);
          written.push({ path: f.path, etag: etag(f.text) });
        }
        for (const p of body.delete) store.delete(p);
        return send(200, { written, rejected });
      }
      if (req.method === 'POST' && req.url === `${base}/home/snapshots`) return send(200, { snapshot_id: 'snap-20261113' });
      if (req.method === 'POST' && req.url === `${base}/spawn`) {
        return send(200, { agent_id: '99999999-0000-0000-0000-000000000001', name: body.name, public_key: 'cHVibGlj', private_key: PRIVATE_KEY });
      }
      return send(404, { detail: 'Not Found' });
    });
  });
  return { server, store, seen };
}

async function listen(server) {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${server.address().port}/api`;
}

function runCli(args, { cwd, env }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd,
      env: { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1', ATRIS_AGENT: '', ATRIS_BUSINESS: '', ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

function tmp(t, label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `agent-home-${label}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return fs.realpathSync(dir);
}

test('pull copies the whole home, writes adapters with soul and mission, and a repeat pull moves nothing', async (t) => {
  const { server, seen } = fakeServer({ files: {
    'MEMBER.md': MEMBER, 'SOUL.md': SOUL, 'MISSION.md': MISSION, 'goals.md': '# Goals\n\n- land one customer\n',
    'memory/MEMORY.md': '# Lessons\n\n- short emails win\n', 'skills/outreach/SKILL.md': '# outreach\n',
  } });
  const api = await listen(server);
  t.after(() => server.close());
  const homeDir = tmp(t, 'home');
  const work = tmp(t, 'work');
  const env = { HOME: homeDir, ATRIS_API_URL: api, ATRIS_TOKEN: TOKEN };

  const first = await runCli(['agent', 'pull', AGENT, '--dir', 'scout'], { cwd: work, env });
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /Pulled .* into scout: 6 new, 0 updated, 0 unchanged\./);
  const dir = path.join(work, 'scout');
  assert.equal(fs.readFileSync(path.join(dir, 'memory', 'MEMORY.md'), 'utf8'), '# Lessons\n\n- short emails win\n');
  assert.ok(seen.filter((s) => s.url.endsWith('/home/bundle')).length >= 6, 'follows next until the end');

  for (const adapter of ['AGENTS.md', 'CLAUDE.md']) {
    const text = fs.readFileSync(path.join(dir, adapter), 'utf8');
    assert.match(text, /# You are scout, Market Scout/);
    assert.match(text, /Curiosity before certainty/);
    assert.match(text, /Find three new customers who answer email/);
    assert.match(text, /land one customer/);
    assert.match(text, /Finds new signal for the team/);
    assert.doesNotMatch(text, /durable -->/, 'comments are dropped, text is kept');
  }

  seen.length = 0;
  const again = await runCli(['agent', 'pull'], { cwd: dir, env });
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /nothing changed, 6 files already here/);
  const bundles = seen.filter((s) => s.url.endsWith('/home/bundle'));
  assert.equal(bundles.length, 1);
  assert.equal(Object.keys(bundles[0].body.have).length, 6);
  for (const s of seen) assert.equal(s.auth, `Bearer ${TOKEN}`);
  for (const r of [first, again]) assert.ok(!(r.stdout + r.stderr).includes(TOKEN));
});

test('push sends only what changed, says plainly that MEMBER.md was refused, and snapshot saves a version', async (t) => {
  const { server, store, seen } = fakeServer({ files: { 'MEMBER.md': MEMBER, 'SOUL.md': SOUL, 'MISSION.md': MISSION, 'old.md': 'old\n' } });
  const api = await listen(server);
  t.after(() => server.close());
  const homeDir = tmp(t, 'home');
  const work = tmp(t, 'work');
  const env = { HOME: homeDir, ATRIS_API_URL: api, ATRIS_TOKEN: TOKEN };
  const dir = path.join(work, 'scout');
  assert.equal((await runCli(['agent', 'pull', AGENT, '--dir', dir], { cwd: work, env })).status, 0);

  const quiet = await runCli(['agent', 'push'], { cwd: dir, env });
  assert.equal(quiet.status, 0, quiet.stderr);
  assert.match(quiet.stdout, /Nothing to push/);

  fs.mkdirSync(path.join(dir, 'memory', 'notes'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'memory', 'notes', '20261113T0600Z-s1.md'), 'learned a thing\n');
  fs.writeFileSync(path.join(dir, 'MEMBER.md'), MEMBER.replace('Finds new signal', 'Rules everything'));
  fs.writeFileSync(path.join(dir, '.env'), 'SECRET=1\n');
  fs.mkdirSync(path.join(dir, 'secrets'));
  fs.writeFileSync(path.join(dir, 'secrets', 'k.md'), 'no\n');
  fs.rmSync(path.join(dir, 'old.md'));

  seen.length = 0;
  const pushed = await runCli(['agent', 'push'], { cwd: dir, env });
  assert.equal(pushed.status, 1, 'a refused file makes the push exit non-zero');
  assert.match(pushed.stdout, /Pushed scout: 1 file saved, 1 removed\./);
  assert.match(pushed.stderr, /Not saved: MEMBER\.md\. The agent may not rewrite MEMBER\.md\./);
  assert.doesNotMatch(pushed.stderr, /at .*\.js:\d+/, 'no stack trace');
  const put = seen.find((s) => s.method === 'PUT');
  assert.deepEqual(put.body.files.map((f) => f.path).sort(), ['MEMBER.md', 'memory/notes/20261113T0600Z-s1.md']);
  assert.deepEqual(put.body.delete, ['old.md']);
  assert.equal(store.get('memory/notes/20261113T0600Z-s1.md'), 'learned a thing\n');
  assert.equal(store.has('old.md'), false);
  assert.equal(store.get('MEMBER.md'), MEMBER);

  const snap = await runCli(['agent', 'snapshot', '--reason', 'before a big change'], { cwd: dir, env });
  assert.equal(snap.status, 0, snap.stderr);
  assert.match(snap.stdout, /Saved a snapshot of scout: snap-20261113/);
  assert.deepEqual(seen.find((s) => s.url.endsWith('/home/snapshots')).body, { reason: 'before a big change' });
});

test('spawn saves the private key 0600 under ~/.atris/agents and never prints it', async (t) => {
  const { server, seen } = fakeServer({ files: {} });
  const api = await listen(server);
  t.after(() => server.close());
  const homeDir = tmp(t, 'home');
  const work = tmp(t, 'work');
  const env = { HOME: homeDir, ATRIS_API_URL: api, ATRIS_TOKEN: TOKEN };

  const res = await runCli(['agent', 'spawn', AGENT, '--name', 'Scout Two', '--budget', '20', '--mission', 'find leads'], { cwd: work, env });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /Spawned Scout Two \(99999999-0000-0000-0000-000000000001\) .* with 20 credits\./);
  assert.ok(!(res.stdout + res.stderr).includes(PRIVATE_KEY), 'the key is never printed');
  const file = path.join(homeDir, '.atris', 'agents', 'scout-two.json');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.private_key, PRIVATE_KEY);
  assert.equal(saved.agent_id, '99999999-0000-0000-0000-000000000001');
  const sent = seen.find((s) => s.url.endsWith('/spawn')).body;
  assert.equal(sent.budget_credits, 20);
  assert.equal(sent.mission, 'find leads');
  assert.match(sent.idempotency_key, /^[0-9a-f-]{36}$/);

  const json = await runCli(['agent', 'spawn', AGENT, '--name', 'other', '--budget', '0', '--json'], { cwd: work, env });
  assert.equal(json.status, 0, json.stderr);
  assert.ok(!json.stdout.includes(PRIVATE_KEY));
  assert.equal(JSON.parse(json.stdout).key_saved, true);

  const twice = await runCli(['agent', 'spawn', AGENT, '--name', 'Scout Two', '--budget', '5'], { cwd: work, env });
  assert.equal(twice.status, 1);
  assert.match(twice.stderr, /already have an agent saved as scout-two/);
});

test('a server without agent homes gets one plain sentence, never a stack trace', async (t) => {
  const { server } = fakeServer({ homes: false });
  const api = await listen(server);
  t.after(() => server.close());
  const homeDir = tmp(t, 'home');
  const work = tmp(t, 'work');
  const env = { HOME: homeDir, ATRIS_API_URL: api, ATRIS_TOKEN: TOKEN };
  for (const args of [['agent', 'pull', AGENT], ['agent', 'snapshot', AGENT], ['agent', 'spawn', AGENT, '--name', 'x', '--budget', '1']]) {
    const res = await runCli(args, { cwd: work, env });
    assert.equal(res.status, 1, args.join(' '));
    const lines = res.stderr.trim().split('\n');
    assert.equal(lines.length, 1, res.stderr);
    assert.match(lines[0], /not turned on there yet, or this sign-in cannot see that agent/);
  }
  assert.equal(fs.existsSync(path.join(homeDir, '.atris', 'agents', 'x.json')), false, 'a refused spawn leaves no key file');
});

test('help lists the new verbs and worker spawn still routes to the local request', async (t) => {
  const work = tmp(t, 'work');
  const help = await runCli(['agent', '--help'], { cwd: work, env: {} });
  assert.equal(help.status, 0);
  for (const verb of ['pull', 'push', 'snapshot']) assert.match(help.stdout, new RegExp(`atris agent ${verb}`));
  assert.match(help.stdout, /--budget <credits>/);
  const home = await runCli(['agent', 'pull', '--help'], { cwd: work, env: {} });
  assert.equal(home.status, 0);
  assert.match(home.stdout, /atris agent spawn \[<parent>\] --name <name> --budget <credits>/);
  assert.equal(isHomeCommand(['spawn', 'worker', '--task', 'x']), false);
  assert.equal(isHomeCommand(['spawn', 'p', '--budget=3']), true);
});

test('folder rules and the adapter block', () => {
  for (const bad of ['/etc/x', '../x', '.env', 'a/.git/x', 'secrets/a.md', 'k.pem', 'id.key', '.atris/x']) assert.equal(homeRel(bad), null, bad);
  assert.equal(homeRel('memory/notes/20261113T0600Z-s1.md'), 'memory/notes/20261113T0600Z-s1.md');
  const block = `${BLOCK_START}\nnew\n${BLOCK_END}`;
  assert.equal(withBlock(null, block), `${block}\n`);
  const mine = '# My repo\n\nkeep me\n';
  const once = withBlock(mine, block);
  assert.ok(once.startsWith(mine.trimEnd()));
  assert.equal(withBlock(once, block), once, 'rewriting the block is stable');
  assert.match(withBlock(once, `${BLOCK_START}\nnewer\n${BLOCK_END}`), /keep me[\s\S]*newer/);
  assert.equal(movesForward('a', 'b'), true);
  assert.equal(movesForward('b', 'b'), false);
  assert.equal(movesForward('b', 'a'), false);
});
