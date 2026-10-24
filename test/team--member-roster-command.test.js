'use strict';
require('./helpers/clean-temp');

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-roster-home-'));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;
for (const key of Object.keys(process.env)) {
  if (key.startsWith('ATRIS_')) delete process.env[key];
}

const { memberRosterCommand } = require('../commands/team');

const NO_MEMBERS_TEXT = 'no team members yet. create one with: atris member create <name> --role="..."\n';

function makeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-roster-root-'));
}

// Runs the command with every outside input injected: no lineup file read,
// no process scan, no real stdout.
function run(args, deps) {
  let out = '';
  const code = memberRosterCommand(args, {
    root: tmpHome,
    lineup: null,
    liveRuns: [],
    termWidth: 100,
    ...deps,
    write: (text) => { out += text; },
  });
  return { code, out };
}

function sampleMembers() {
  return [
    { name: 'alpha', role: 'Alpha - writes the release notes. A second sentence.', frontmatter: {}, format: 'file', version: '1.2' },
    { name: 'bravo', role: '(no role)', description: '', frontmatter: { status: 'Parked' }, format: 'directory', skillCount: 3, contextCount: 2 },
    { name: 'charlie', role: 'reviews diffs', frontmatter: {}, format: 'file' },
    { name: '<name>', dir: path.join(tmpHome, '<name>'), role: 'template', frontmatter: {} },
  ];
}

const LINEUP = { ok: true, team: [{ member: 'Alpha', job: 'build', engine: 'devin', model: 'swe-2-max', source: 'file' }] };
const LIVE_RUNS = [{ member: 'CHARLIE', engine: 'grok', model: 'grok-4.1', pid: 4242 }];

test('text view sorts working first, shows engines, and hides parked members', () => {
  const { code, out } = run([], { members: sampleMembers(), lineup: LINEUP, liveRuns: LIVE_RUNS });
  assert.strictEqual(code, 0);
  assert.strictEqual(out, [
    'MEMBER   STATUS   ENGINE             WHAT IT DOES',
    'charlie  working  grok · grok 4.1    reviews diffs',
    'alpha    idle     devin · swe-2-max  writes the release notes',
    '',
    '2 members, 1 working now.',
    'parked (1): bravo · atris member roster --all to show them',
    '',
  ].join('\n'));
});

test('--all lists parked members in place and drops the parked footer', () => {
  const { code, out } = run(['--all'], { members: sampleMembers(), lineup: LINEUP, liveRuns: LIVE_RUNS });
  assert.strictEqual(code, 0);
  assert.match(out, /^bravo {4}parked {3}not set {12}no role written yet$/m);
  assert.match(out, /3 members, 1 working now\./);
  assert.doesNotMatch(out, /parked \(\d+\)/);
});

test('--json reports every member with parked flag, counts, and null fields for file members', () => {
  const { code, out } = run(['--json'], { members: sampleMembers(), lineup: LINEUP, liveRuns: LIVE_RUNS });
  assert.strictEqual(code, 0);
  assert.ok(out.endsWith('\n'));
  const data = JSON.parse(out);
  assert.strictEqual(data.ok, true);
  assert.strictEqual(data.count, 3);
  assert.deepStrictEqual(data.members, [
    {
      name: 'alpha',
      state: 'idle',
      engine: 'devin · swe-2-max',
      does: 'writes the release notes',
      role: 'Alpha - writes the release notes. A second sentence.',
      format: 'file',
      skills: null,
      context: null,
      version: '1.2',
    },
    {
      name: 'bravo',
      parked: true,
      state: 'parked',
      engine: 'not set',
      does: 'no role written yet',
      role: '(no role)',
      format: 'directory',
      skills: 3,
      context: 2,
      version: null,
    },
    {
      name: 'charlie',
      state: 'working',
      engine: 'grok · grok 4.1',
      does: 'reviews diffs',
      role: 'reviews diffs',
      format: 'file',
      skills: null,
      context: null,
      version: null,
    },
  ]);
});

test('no members prints the empty-team hint, and --json returns an empty list', () => {
  const text = run([], { members: [] });
  assert.strictEqual(text.code, 0);
  assert.strictEqual(text.out, NO_MEMBERS_TEXT);

  const json = run(['--json'], { members: [] });
  assert.strictEqual(json.code, 0);
  assert.deepStrictEqual(JSON.parse(json.out), { ok: true, count: 0, members: [] });
});

test('template members are ignored, so a team of only templates counts as empty', () => {
  const members = [
    { name: '<name>', role: 'template', frontmatter: {} },
    { name: 'tmpl', dir: path.join(tmpHome, 'team', '<member>'), role: 'template', frontmatter: {} },
  ];
  const { out } = run([], { members });
  assert.strictEqual(out, NO_MEMBERS_TEXT);
});

test('a parked member that has a live run still shows as working', () => {
  const members = [{ name: 'bravo', role: 'night shift', frontmatter: { status: 'parked' } }];
  const { out } = run(['--json'], { members, liveRuns: [{ member: 'bravo', engine: 'grok', model: 'grok-4.1' }] });
  const [row] = JSON.parse(out).members;
  assert.strictEqual(row.state, 'working');
  assert.strictEqual(row.parked, true);

  const text = run([], { members, liveRuns: [{ member: 'bravo', engine: 'grok', model: 'grok-4.1' }] }).out;
  assert.match(text, /^bravo\s+working\s+grok · grok 4\.1\s+night shift$/m);
  assert.match(text, /1 member, 1 working now\./);
});

test('a member parked in its MEMBER.md on disk is hidden even without parsed frontmatter', () => {
  const root = makeRoot();
  const dir = path.join(root, 'atris', 'team', 'delta');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'MEMBER.md'), '---\nname: delta\nstatus: parked\n---\n\n# delta\n');
  const members = [
    { name: 'delta', role: 'sleeps a lot', frontmatter: {} },
    { name: 'echo', role: 'stays awake', frontmatter: {} },
  ];

  const text = run([], { root, members }).out;
  assert.match(text, /^echo\s+idle\s+not set\s+stays awake$/m);
  assert.doesNotMatch(text, /^delta /m);
  assert.match(text, /1 member, 0 working now\./);
  assert.match(text, /parked \(1\): delta · atris member roster --all to show them/);

  const json = JSON.parse(run(['--json'], { root, members }).out);
  assert.deepStrictEqual(json.members.map((m) => [m.name, m.state, m.parked === true]), [
    ['delta', 'parked', true],
    ['echo', 'idle', false],
  ]);
});

test('"what it does" comes from the first sentence of description, role, or the file opening', () => {
  const root = makeRoot();
  const filePath = path.join(root, 'MEMBER.md');
  fs.writeFileSync(filePath, '---\nname: foxtrot\n---\n\n# foxtrot\n\nrole: Triages inbound mail. Never replies.\n');
  const longRole = `${'word '.repeat(60)}end.`;
  const members = [
    { name: 'golf', role: 'something else', description: 'Golf: keeps the books — and the receipts. Extra.', frontmatter: {} },
    { name: 'foxtrot', role: '(no role)', description: '', path: filePath, frontmatter: {} },
    { name: 'hotel', role: longRole, frontmatter: {} },
    { name: 'india', role: '(no role)', frontmatter: {}, path: path.join(root, 'missing.md') },
  ];
  const rows = Object.fromEntries(JSON.parse(run(['--json'], { root, members }).out).members.map((m) => [m.name, m.does]));

  assert.strictEqual(rows.golf, 'keeps the books - and the receipts');
  assert.strictEqual(rows.foxtrot, 'triages inbound mail');
  assert.strictEqual(rows.india, 'no role written yet');
  assert.ok(rows.hotel.endsWith('…'));
  assert.ok(rows.hotel.length <= 141);
  assert.match(rows.hotel, /^(word )+word…$/);
});

test('a narrow terminal wraps the description column instead of overflowing', () => {
  const role = 'checks every pull request for missing tests and unclear names before anyone merges it';
  const members = [{ name: 'juliet', role, frontmatter: {} }];
  const { out } = run([], { members, termWidth: 60 });
  const lines = out.split('\n');
  const tableLines = lines.slice(0, lines.indexOf(''));

  assert.ok(tableLines.length > 2, 'description should wrap onto extra lines');
  for (const line of tableLines) assert.ok(line.length <= 60, `line too wide: ${line}`);
  const wrapped = tableLines.slice(1).map((line, i) => (i === 0 ? line.replace(/^juliet\s+idle\s+not set\s+/, '') : line.trim())).join(' ');
  assert.strictEqual(wrapped, role);
});

test('a lineup that names no engine for a member leaves its engine "not set"', () => {
  const lineup = { ok: true, team: [{ member: 'someone-else', engine: 'devin', model: 'swe-2-max' }] };
  const { out } = run(['--json'], { members: [{ name: 'kilo', role: 'tests things', frontmatter: {} }], lineup });
  assert.strictEqual(JSON.parse(out).members[0].engine, 'not set');
});
