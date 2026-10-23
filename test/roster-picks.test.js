'use strict';

// The owner's short list: a "## picks" section in ROSTER.md. With it, the
// swap list is the Atris engines first, then the picks in file order, then
// one "more models" entry with the full list. Without it, the full list as
// before. `atris engine roster --available` and the phone's engine card read
// the same list. Every test gets a scratch HOME and a fixture ROSTER.md.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CLI = path.join(__dirname, '..', 'bin', 'atris.js');

const PICKS = `
## picks
- atris fast · atris fast
- claude · fable 5.1
- codex · gpt-6.1-sol
- claude · haiku 5.5
- codex · gpt-6.2-new
- devin · swe-2-max
`;

const ROSTER = `# roster

## build
- claude code, model: opus 5.5

## search
- claude code, model: haiku 5.5

## team
- researcher: claude code, model: haiku 5.5
`;

const ENV_KEYS = [
  'HOME', 'ATRIS_MACHINE_ROSTER_PATH', 'ATRIS_MACHINE_ROSTER_MD_PATH', 'ATRIS_ROSTER_SESSION', 'ATRIS_ROSTER_SESSIONS_DIR',
  'ATRIS_CODEX_MODELS_CACHE_PATH', 'ATRIS_CODEX_CONFIG_PATH', 'ATRIS_RUNNER_PROFILE', 'ATRIS_RUNNER_MODEL', 'ATRIS_ROUTER_EXPLAIN',
];

// claude, codex, atris fast, and the mercury test model are ready; devin is not.
function withRoom(fn, { picks = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-roster-picks-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-roster-picks-home-'));
  const saved = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  const rosterFile = path.join(home, '.atris', 'ROSTER.md');
  const cache = path.join(home, '.codex', 'models_cache.json');
  fs.mkdirSync(path.dirname(rosterFile), { recursive: true });
  fs.mkdirSync(path.dirname(cache), { recursive: true });
  fs.writeFileSync(rosterFile, picks ? `${ROSTER}${PICKS}` : ROSTER);
  fs.writeFileSync(cache, JSON.stringify({ models: [{ slug: 'gpt-6.1-sol' }, { slug: 'gpt-6-astra' }] }));
  for (const name of ['builder', 'researcher']) {
    fs.mkdirSync(path.join(root, 'atris', 'team', name), { recursive: true });
    fs.writeFileSync(path.join(root, 'atris', 'team', name, 'MEMBER.md'), `---\nname: ${name}\nrole: ${name}\n---\n`);
  }
  const checked = new Date().toISOString();
  const ready = ['claude', 'codex', 'atris-fast', 'mercury'];
  const engines = Object.keys(require('../lib/runner-command').RUNNER_PROFILE_DEFS).map((id) => (ready.includes(id)
    ? { id, health: { status: 'ready', checked_at: checked } }
    : { id, installed: false, health: { status: 'not_installed', checked_at: checked } }));
  fs.mkdirSync(path.join(root, '.atris', 'state'), { recursive: true });
  fs.writeFileSync(path.join(root, '.atris', 'state', 'engines.json'), `${JSON.stringify({ engines })}\n`);
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.HOME = home;
  process.env.ATRIS_MACHINE_ROSTER_MD_PATH = rosterFile;
  process.env.ATRIS_CODEX_MODELS_CACHE_PATH = cache;
  process.env.ATRIS_ROUTER_EXPLAIN = '0';
  const env = { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1', NO_COLOR: '1' };
  const cli = (...args) => {
    const res = spawnSync(process.execPath, [CLI, 'engine', 'roster', ...args], { cwd: root, env, encoding: 'utf8' });
    return { exit: res.status, out: res.stdout.trim(), err: res.stderr.trim() };
  };
  try {
    return fn({ root, rosterFile, cli, text: () => fs.readFileSync(rosterFile, 'utf8') });
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
}

const brief = (option) => (option.more ? ['more models'] : [option.tool, option.label, option.atris ? 'atris' : option.pick ? 'pick' : '']);

test('with picks: atris engines first (no test models), then the picks in file order, then more models with the full list', () => withRoom(({ root }) => {
  const { swapList } = require('../lib/roster-swap');
  const list = swapList(root);
  assert.equal(list.picked, true);
  assert.deepEqual(list.options.map(brief), [
    ['atris fast', 'atris fast', 'atris'],
    ['claude code', 'fable 5.1', 'pick'],
    ['codex', 'gpt-6.1-sol', 'pick'],
    ['claude code', 'haiku 5.5', 'pick'],
    ['codex', 'gpt-6.2-new', 'pick'],
    ['more models'],
  ]);
  // a pick for a tool not on this machine is left out; the atris fast pick is already on top
  assert.ok(!list.options.some((o) => o.engine === 'devin'));
  // more models carries every model on this machine, the test model included
  const more = list.options[list.options.length - 1];
  assert.deepEqual(more.options, list.full);
  assert.ok(list.full.some((o) => o.engine === 'mercury'));
  assert.ok(list.full.some((o) => o.engine === 'claude' && o.label === 'opus 5.5'));
}));

test('with no picks: the full list as before, and no more models entry', () => withRoom(({ root }) => {
  const { swapList } = require('../lib/roster-swap');
  const list = swapList(root);
  assert.equal(list.picked, false);
  assert.deepEqual(list.options, list.full);
  assert.ok(!list.options.some((o) => o.more));
}, { picks: false }));

test('claude code known names are the current family, in order', () => {
  const { availableModels } = require('../lib/roster-models');
  assert.deepEqual(availableModels([{ id: 'claude' }])[0].models, ['fable 5.1', 'opus 5.5', 'sonnet 5.5', 'haiku 5.5']);
});

test('the picks section is not read as a job and warns about nothing', () => withRoom(({ root }) => {
  const { readRosterState } = require('../lib/engine-registry');
  const machine = readRosterState(root).machine;
  assert.deepEqual(Object.keys(machine.picks).sort(), ['executor', 'navigator']);
  assert.deepEqual(machine.warnings, []);
  assert.deepEqual(machine.shortlist.map((p) => [p.engine, p.model]), [
    ['atris-fast', 'atris fast'], ['claude', 'fable 5.1'], ['codex', 'gpt-6.1-sol'], ['claude', 'haiku 5.5'], ['codex', 'gpt-6.2-new'], ['devin', 'swe-2-max'],
  ]);
}));

test('--available prints the same ordered list, and --json carries it', () => withRoom(({ root, cli }) => {
  const res = cli('--available');
  assert.equal(res.exit, 0, res.err);
  const lines = res.out.split('\n');
  assert.equal(lines[0], 'on this machine');
  assert.match(lines[1], /^atris fast\s+atris fast\s+atris$/);
  assert.match(lines[2], /^claude code\s+fable 5\.1\s+pick$/);
  assert.match(lines[3], /^codex\s+gpt-6\.1-sol\s+pick$/);
  assert.match(lines[4], /^claude code\s+haiku 5\.5\s+pick$/);
  assert.match(lines[5], /^codex\s+gpt-6\.2-new\s+pick$/);
  assert.equal(lines[6], '');
  assert.equal(lines[7], 'more models');
  assert.match(res.out, /^claude code\s+fable 5\.1, opus 5\.5, sonnet 5\.5, haiku 5\.5\s+\(known names\)$/m);
  const json = JSON.parse(cli('--available', '--json').out);
  const { swapList } = require('../lib/roster-swap');
  assert.deepEqual(json.list, JSON.parse(JSON.stringify(swapList(root).options)));
}));

test('the engine card reads the same list, keeping only what the member can do', () => withRoom(({ root }) => {
  const { swapList, memberEngineChoices } = require('../lib/roster-swap');
  const card = memberEngineChoices(root, 'researcher');
  // researcher searches: codex cannot, so its picks are left out; the order is the swap list's
  assert.deepEqual(card.options.map(brief), [
    ['atris fast', 'atris fast', 'atris'],
    ['claude code', 'fable 5.1', 'pick'],
    ['claude code', 'haiku 5.5', 'pick'],
    ['more models'],
  ]);
  assert.equal(card.options.find((o) => o.label === 'haiku 5.5').current, true);
  const order = swapList(root).options.filter((o) => !o.more).map((o) => `${o.engine}/${o.label}`);
  const shown = card.options.filter((o) => !o.more).map((o) => `${o.engine}/${o.label}`);
  assert.deepEqual(shown, order.filter((key) => shown.includes(key)));
  assert.ok(card.options[card.options.length - 1].options.some((o) => o.label === 'opus 5.5'));
}));

test('a model named only in picks can be swapped to', () => withRoom(({ cli, text }) => {
  const res = cli('set', 'build', 'codex', 'gpt-6.2-new');
  assert.equal(res.exit, 0, res.err);
  assert.match(text(), /^- codex, model: gpt-6\.2-new$/m);
  assert.equal(cli('set', 'build', 'codex', 'gpt-made-up').exit, 2);
}));
