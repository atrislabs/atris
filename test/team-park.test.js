'use strict';

// Parking hides a member from the team views (atris team, the roster team
// block, the boot lineup, owner inference) and never from a run by name.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');

const { teamCommand } = require('../commands/team');
const { isMemberParked, setMemberParked } = require('../lib/member-park');
const { teamRosterView } = require('../lib/member-engine');
const { readLineupSafe } = require('../lib/team-lineup');
const { resolveFunctionalOwner } = require('../lib/functional-owner');

const cli = path.resolve(__dirname, '..', 'bin', 'atris.js');
const NOW = () => new Date(2026, 8, 27, 12, 0, 0).getTime();
const ROOM_ENV = ['ATRIS_MACHINE_ROSTER_PATH', 'ATRIS_MACHINE_ROSTER_MD_PATH', 'ATRIS_ROSTER_SESSION', 'ATRIS_ROSTER_SESSIONS_DIR', 'ATRIS_CODEX_CONFIG_PATH', 'ATRIS_ROUTER_EXPLAIN', 'ATRIS_RUNNER_MODEL'];

function card(name, role, extra = '') {
  return `---\nname: ${name}\nrole: ${role}\nversion: 1.0.0\n${extra}---\n\n# ${name}\n\nbody stays put.\n`;
}

// A scratch project with a scratch home, so the real ~/.atris is never read.
function withRoom(fn, members = [['coder', 'builder'], ['navigator', 'navigator'], ['wiki-miner', 'wiki keeper'], ['signal-scout', 'scout']]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'team-park-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'team-park-home-'));
  const saved = new Map(ROOM_ENV.map((key) => [key, process.env[key]]));
  for (const key of ROOM_ENV) delete process.env[key];
  process.env.ATRIS_MACHINE_ROSTER_PATH = path.join(home, '.atris', 'roster.json');
  process.env.ATRIS_ROUTER_EXPLAIN = '0';
  try {
    for (const [name, role] of members) {
      fs.mkdirSync(path.join(root, 'atris', 'team', name), { recursive: true });
      fs.writeFileSync(path.join(root, 'atris', 'team', name, 'MEMBER.md'), card(name, role));
    }
    return fn(root);
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function cardText(root, name) {
  return fs.readFileSync(path.join(root, 'atris', 'team', name, 'MEMBER.md'), 'utf8');
}

function team(root, args) {
  let out = '';
  let err = '';
  const code = teamCommand(args, {
    root,
    missions: [],
    presence: { members: [] },
    lineup: { ok: true, jobs: [], team: [] },
    termWidth: 200,
    now: NOW,
    write: (s) => { out += s; },
    error: (s) => { err += s; },
  });
  return { code, out, err };
}

test('park and unpark edit only the status and parked_note lines, and the note carries the date', () => withRoom((root) => {
  const before = cardText(root, 'coder');
  const parked = team(root, ['park', 'coder', '--note', 'no logged work since 2026-06']);
  assert.equal(parked.code, 0, parked.err);
  assert.equal(parked.out, 'parked coder\n');
  const after = cardText(root, 'coder');
  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');
  assert.equal(afterLines.length, beforeLines.length + 2);
  assert.equal(afterLines[2], 'status: parked');
  assert.equal(afterLines[3], 'parked_note: 2026-09-27 no logged work since 2026-06; unpark with atris team unpark coder');
  assert.deepEqual([...afterLines.slice(0, 2), ...afterLines.slice(4)], beforeLines);
  assert.equal(isMemberParked(root, 'coder'), true);

  const unparked = team(root, ['unpark', 'coder']);
  assert.equal(unparked.code, 0, unparked.err);
  assert.equal(unparked.out, 'unparked coder\n');
  assert.equal(cardText(root, 'coder'), before, 'unpark gives back the file byte for byte');
}));

test('park keeps crlf cards crlf and replaces an existing status line in place', () => withRoom((root) => {
  const file = path.join(root, 'atris', 'team', 'coder', 'MEMBER.md');
  fs.writeFileSync(file, '---\r\nname: coder\r\nstatus: active\r\nrole: builder\r\n---\r\nbody\r\n');
  const result = setMemberParked(root, 'coder', { parked: true, note: 'resting', now: new Date(NOW()) });
  assert.equal(result.changed, true);
  assert.equal(fs.readFileSync(file, 'utf8'), '---\r\nname: coder\r\nstatus: parked\r\nparked_note: 2026-09-27 resting; unpark with atris team unpark coder\r\nrole: builder\r\n---\r\nbody\r\n');
}));

test('unknown members error plainly and already-parked is a no-op', () => withRoom((root) => {
  const unknown = team(root, ['park', 'ghost']);
  assert.equal(unknown.code, 1);
  assert.equal(unknown.err, 'no team member named ghost. see the team with: atris team --all\n');
  assert.equal(team(root, ['unpark', 'ghost']).code, 1);

  assert.equal(team(root, ['park', 'coder']).code, 0);
  const once = cardText(root, 'coder');
  const again = team(root, ['park', 'coder', '--note', 'other']);
  assert.equal(again.code, 0);
  assert.equal(again.out, 'coder is already parked\n');
  assert.equal(cardText(root, 'coder'), once);

  const notParked = team(root, ['unpark', 'navigator']);
  assert.equal(notParked.code, 0);
  assert.equal(notParked.out, 'navigator is not parked\n');

  const usage = team(root, ['park']);
  assert.equal(usage.code, 2);
  assert.match(usage.err, /usage: atris team park <name>/);
}));

test('atris team folds parked members into one line, --all lists them in place, json says parked', () => withRoom((root) => {
  team(root, ['park', 'wiki-miner']);
  team(root, ['park', 'signal-scout']);

  const plain = team(root, []);
  assert.equal(plain.code, 0, plain.err);
  assert.match(plain.out, /^parked \(2\): signal-scout, wiki-miner · atris team --all to show them$/m);
  const rest = plain.out.split('\n').filter((line) => !line.startsWith('parked ('));
  assert.ok(!rest.some((line) => /wiki-miner|signal-scout/.test(line)), plain.out);
  assert.match(plain.out, /coder/);

  const all = team(root, ['--all']);
  assert.equal(all.code, 0, all.err);
  assert.match(all.out, /signal-scout \(parked\)/);
  assert.match(all.out, /wiki-miner \(parked\)/);
  assert.ok(!all.out.includes('parked (2)'));

  const json = JSON.parse(team(root, ['--json']).out);
  const by = Object.fromEntries(json.map((entry) => [entry.name, entry]));
  assert.equal(by['wiki-miner'].parked, true);
  assert.equal(by.coder.parked, false);
}));

test('the roster team block and the lineup skip parked members', () => withRoom((root) => {
  team(root, ['park', 'wiki-miner']);
  const names = teamRosterView(root, { now: new Date(NOW()) }).rows.map((row) => row.member);
  assert.ok(names.includes('coder'));
  assert.ok(!names.includes('wiki-miner'), names.join(','));
  const lineup = readLineupSafe(root, new Date(NOW()));
  assert.equal(lineup.ok, true, lineup.error);
  assert.ok(!lineup.team.some((row) => row.member === 'wiki-miner'));
  assert.ok(lineup.team.some((row) => row.member === 'coder'));
}));

test('owner inference skips parked members, an explicit owner still reaches them', () => withRoom((root) => {
  const before = resolveFunctionalOwner({ title: 'refresh the wiki knowledge docs', root });
  assert.equal(before.owner, 'wiki-miner');
  team(root, ['park', 'wiki-miner']);
  const after = resolveFunctionalOwner({ title: 'refresh the wiki knowledge docs', root });
  assert.notEqual(after.owner, 'wiki-miner');
  const named = resolveFunctionalOwner({ title: 'mention wiki-miner by name', root });
  assert.notEqual(named.owner, 'wiki-miner');
  const explicit = resolveFunctionalOwner({ requestedOwner: 'wiki-miner', title: 'x', root });
  assert.equal(explicit.owner, 'wiki-miner');
  assert.equal(explicit.reason, 'explicit_member_owner');
}));

function fakeClaude(root) {
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  const executable = path.join(bin, 'claude');
  fs.writeFileSync(executable, [
    '#!/bin/sh',
    'if [ "$1" = "--help" ]; then',
    '  echo "--output-format --permission-mode --resume --session-id --include-partial-messages"',
    '  exit 0',
    'fi',
    'echo \'{"type":"result","is_error":false,"result":"finished the bounded task"}\'',
    '',
  ].join('\n'));
  fs.chmodSync(executable, 0o755);
  return bin;
}

function memberRun(root, name) {
  const bin = fakeClaude(root);
  const result = spawnSync(process.execPath, [cli, 'member', 'run', name, 'bounded work', '--runner', 'claude', '--max-ticks', '1', '--minutes', '1', '--shared-checkout', '--json'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 90000,
    env: { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1', PATH: `${bin}${path.delimiter}${process.env.PATH}` },
  });
  if (result.error) throw result.error;
  return result;
}

test('running a parked member by name prints one notice and still runs', () => withRoom((root) => {
  team(root, ['park', 'coder']);
  const result = memberRun(root, 'coder');
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stderr.split('\n').filter((line) => line === 'coder is parked; running anyway').length, 1, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.started, true);
}, [['coder', 'builder']]));

test('a parked runtime folder still answers to its alias name', () => withRoom((root) => {
  // problem-solver runs as generalist; parking generalist changes no routing.
  team(root, ['park', 'generalist']);
  const result = memberRun(root, 'problem-solver');
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stderr, /^problem-solver is parked; running anyway$/m);
  assert.equal(JSON.parse(result.stdout).started, true);
}, [['generalist', 'generalist']]));

test('team prune leaves parked members out of the quiet list', () => withRoom((root) => {
  const { collectTeamPrune } = require('../commands/team');
  setMemberParked(root, 'wiki-miner', { parked: true, note: 'set aside' });
  // Age every card so each member reads as quiet; only parking should differ.
  const old = new Date(NOW() - 90 * 24 * 60 * 60 * 1000);
  for (const name of ['coder', 'navigator', 'wiki-miner', 'signal-scout']) {
    const dir = path.join(root, 'atris', 'team', name);
    for (const file of fs.readdirSync(dir)) fs.utimesSync(path.join(dir, file), old, old);
    fs.utimesSync(dir, old, old);
  }
  const report = collectTeamPrune({ root, now: NOW, missions: [] });
  const quiet = report.quiet.map((row) => row.name);
  assert.ok(quiet.includes('coder'), 'an unparked quiet member is still flagged');
  assert.ok(!quiet.includes('wiki-miner'), 'a parked member is not flagged again');
}));

test('member list marks parked members in text and json', () => withRoom((root) => {
  setMemberParked(root, 'signal-scout', { parked: true, note: 'set aside' });
  const json = spawnSync(process.execPath, [cli, 'member', 'list', '--json'], { cwd: root, encoding: 'utf8' });
  assert.equal(json.status, 0, json.stderr);
  const rows = JSON.parse(json.stdout).members;
  assert.equal(rows.find((row) => row.name === 'signal-scout').parked, true);
  assert.equal(rows.find((row) => row.name === 'coder').parked, undefined);
  const text = spawnSync(process.execPath, [cli, 'member', 'list'], { cwd: root, encoding: 'utf8' });
  assert.match(text.stdout, /signal-scout .* parked\n/);
  assert.match(text.stdout, /\(1 parked; unpark with atris team unpark <name>\)/);
}));

test('park and unpark leave the body and mixed line endings byte for byte', () => withRoom((root) => {
  const write = (name, text) => {
    fs.mkdirSync(path.join(root, 'atris', 'team', name), { recursive: true });
    fs.writeFileSync(path.join(root, 'atris', 'team', name, 'MEMBER.md'), text);
  };
  const read = (name) => fs.readFileSync(path.join(root, 'atris', 'team', name, 'MEMBER.md'), 'utf8');
  // An empty header block, with a body that looks like another header.
  write('empty-head', '---\n---\n# body\n\n---\nstatus: body text\n');
  // A header that mixes CRLF and LF lines.
  write('mixed-ends', '---\r\nname: mixed-ends\nrole: x\r\n---\r\nbody\n');
  for (const name of ['empty-head', 'mixed-ends']) {
    const before = read(name);
    setMemberParked(root, name, { parked: true, note: 'set aside', now: new Date(2026, 8, 27) });
    assert.equal(isMemberParked(root, name), true);
    assert.ok(read(name).includes('status: body text\n') || name !== 'empty-head', 'the body line is untouched');
    setMemberParked(root, name, { parked: false });
    assert.equal(read(name), before, `${name} comes back byte for byte`);
  }
}));
