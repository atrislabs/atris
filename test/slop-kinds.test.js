const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const tempDirs = [];
test.after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});
function tmpDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

// A small stand-in design library so the screen report never depends on this Mac.
const design = tmpDir('slop-design-');
fs.mkdirSync(path.join(design, 'components'), { recursive: true });
fs.mkdirSync(path.join(design, 'tokens'), { recursive: true });
fs.writeFileSync(path.join(design, 'components', 'catalog.json'), JSON.stringify({ version: 1, components: [
  { id: 'insight-card', react: 'InsightCard', web: 'atris-insight-card' },
  { id: 'selection-actions', react: 'SelectionActions', web: 'atris-selection-actions' },
  { id: 'prompt-composer', react: 'PromptComposer', web: 'atris-prompt-composer' },
] }));
fs.writeFileSync(path.join(design, 'tokens', 'atris-tokens.css'), ':root { --ink: #111; }\n');
process.env.ATRIS_DESIGN_DIR = design;

const { KIND_RULES, scanText } = require('../lib/slop-kinds');
const { slopCommand } = require('../commands/slop');
const BIN = path.join(__dirname, '..', 'bin', 'atris.js');

const GOOD_EMAIL = [
  'Subject: Your January studio intake',
  '',
  'Hey Maria,',
  '',
  'Your site says the January cohort opens on the 6th at $180 a month. Two studios like yours filled theirs by sending one short note to past students. Want me to draft that note for you?',
  '',
].join('\n');

// Swap one sentence of the good email for another, keeping the shape.
const withBody = (body) => `Subject: Your January studio intake\n\nHey Maria,\n\n${body}\n`;
const FACT = 'Your site says the January cohort opens on the 6th at $180 a month.';
const ASK = 'Want me to draft that note for you?';

const rules = (text, kind, label = 'x.txt', opts) => scanText(text, label, kind, opts).findings.map((f) => f.rule);

// One failing and one passing sample per rule: [rule, kind, fails, passes, label].
const CASES = [
  ['cc-banned-words', 'customer-copy', 'Our AI agents automate your follow-ups.', 'It works with the AI tools you already have.'],
  ['cc-em-dash', 'customer-copy', 'One note — one reply.', 'One note. One reply.'],
  ['cc-not-x-but-y', 'customer-copy', 'It is not a tool but a team.', 'It is a team.'],
  ['cc-comma-and-but', 'customer-copy', 'Your note goes out, and the reply comes back.', 'Your note goes out and the reply comes back.'],
  ['cc-stacked-questions', 'customer-copy', 'Is January full? Do you want help?', 'Is January full yet?'],
  ['cc-hype', 'customer-copy', 'Supercharge your studio.', 'Fill your January class.'],
  ['cc-all-caps', 'customer-copy', 'This is HUGE news.', 'The HVAC visit is on the CEO list.'],
  ['cc-overclaim', 'customer-copy', 'We fix every hole.', 'We found three holes and fixed them.'],
  ['email-hey-name', 'email', 'Subject: January intake\n\nHi Maria,\n\n' + FACT + ' ' + ASK, GOOD_EMAIL],
  ['email-sign-off', 'email', GOOD_EMAIL + '\nBest,\nSam\n', GOOD_EMAIL],
  ['email-greeting-paragraph', 'email', withBody('Hope you are well. ' + FACT + ' ' + ASK), GOOD_EMAIL],
  ['email-asks-for-call', 'email', withBody(FACT + ' Can we hop on for 15 minutes?'), GOOD_EMAIL],
  ['email-opens-on-us', 'email', withBody('We help studios fill classes. ' + ASK), GOOD_EMAIL],
  ['email-one-question', 'email', withBody(FACT + ' I can draft the note.'), GOOD_EMAIL],
  ['email-length', 'email', withBody(FACT + ' ' + 'Past students reply to short notes. '.repeat(14) + ASK), GOOD_EMAIL],
  ['email-subject', 'email', GOOD_EMAIL.replace('Your January studio intake', 'FREE offer for your studio this January!'), GOOD_EMAIL],
  ['screen-subtitle', 'screen', '<Header title="Leads" subtitle="Everything you need in one place" />', '<Header title="Leads" />', 'Page.tsx'],
  ['screen-explanatory', 'screen', '<p>Here you can see every lead.</p>', '<p>Maria Lopez, Austin</p>', 'Page.tsx'],
  ['screen-all-caps', 'screen', '<span className="text-xs uppercase">New</span>', '<span className="text-xs">New</span>', 'Page.tsx'],
  ['screen-left-bar', 'screen', '<div className="card rounded-lg border-l-4 p-4">x</div>', '<div className="card rounded-lg border p-4">x</div>', 'Page.tsx'],
  ['screen-raw-colour', 'screen', '.card { color: #1a73e8; }', '.card { color: var(--ink); }', 'page.css'],
  ['screen-components', 'screen', '<button>Save</button>', '<SelectionActions actions={actions} />', 'Page.tsx'],
];

test('every built-in kind rule has a test case, a why and the words it came from', () => {
  const covered = new Set(CASES.map((c) => c[0]));
  for (const rule of KIND_RULES) {
    assert.ok(covered.has(rule.id), `${rule.id} has a case`);
    assert.ok(rule.why && rule.said, `${rule.id} has why and said`);
    assert.ok(['error', 'warn'].includes(rule.level));
    assert.ok(rule.re instanceof RegExp || typeof rule.check === 'string');
  }
});

for (const [rule, kind, fails, passes, label] of CASES) {
  test(`${kind} ${rule}: fails the bad sample, passes the good one`, () => {
    assert.ok(rules(fails, kind, label).includes(rule), `${rule} fires on: ${fails}`);
    assert.ok(!rules(passes, kind, label).includes(rule), `${rule} stays quiet on: ${passes}`);
  });
}

test('a real-looking first email passes every email rule', () => {
  assert.deepEqual(scanText(GOOD_EMAIL, 'note.txt', 'email').findings, []);
});

test('--subject stands in for a Subject line', () => {
  const body = 'Hey Maria,\n\n' + FACT + ' ' + ASK + '\n';
  assert.ok(rules(body, 'email').includes('email-subject'), 'no subject at all fails');
  assert.ok(!rules(body, 'email', 'x.txt', { subject: 'Your January intake' }).includes('email-subject'));
});

test('an empty composition subtitle and page metadata are not visible copy', () => {
  const json = '{ "componentID": "insight-card", "data": { "title": "Leads", "subtitle": "" } }';
  assert.deepEqual(rules(json, 'screen', 'page.json'), []);
  const meta = "export const metadata = {\n  title: 'Pricing',\n  description: 'Simple pricing for your studio plans.',\n};";
  assert.ok(!rules(meta, 'screen', 'layout.tsx').includes('screen-subtitle'));
});

test('a heading followed by a muted paragraph is subtitle text', () => {
  const tsx = '<h1 className="text-2xl">Leads</h1>\n<p className="text-muted-foreground">People worth a note today.</p>';
  assert.ok(rules(tsx, 'screen', 'Page.tsx').includes('screen-subtitle'));
  assert.ok(!rules('<h1 className="text-2xl">Leads</h1>\n<LeadList />', 'screen', 'Page.tsx').includes('screen-subtitle'));
});

test('the component report names the catalog components that replace hand-rolled ones', () => {
  const res = scanText('<button>Save</button>\n<div className="card p-4">x</div>\n<InsightCard />', 'Page.tsx', 'screen');
  assert.deepEqual(res.components.raw, { button: 1, input: 0, card: 1 });
  assert.deepEqual(res.components.used, ['insight-card']);
  const line = res.findings.find((f) => f.rule === 'screen-components');
  assert.equal(line.level, 'warn');
  assert.match(line.text, /SelectionActions/);
  assert.match(line.text, /InsightCard/);
});

function run(args, input, cwd) {
  return spawnSync(process.execPath, [BIN, 'slop', ...args], { input, cwd, encoding: 'utf8', env: { ...process.env, ATRIS_DESIGN_DIR: design } });
}

test('detect --kind email reads stdin with -, and --json carries rule, file, line, text, why, said and level', () => {
  const good = run(['detect', '--kind', 'email', '-'], GOOD_EMAIL);
  assert.equal(good.status, 0, good.stdout + good.stderr);
  const bad = run(['detect', '--kind', 'email', '-', '--json'], withBody('We help studios. Can we hop on a call?') + '\nBest,\nSam\n');
  assert.equal(bad.status, 1);
  const out = JSON.parse(bad.stdout);
  assert.equal(out.kind, 'email');
  const f = out.findings[0];
  for (const key of ['rule', 'file', 'line', 'text', 'why', 'said', 'level']) assert.ok(key in f, key);
  assert.equal(f.file, '-');
});

test('warnings alone do not fail a screen; a bad kind is a usage error', () => {
  const dir = tmpDir('slop-screen-');
  fs.writeFileSync(path.join(dir, 'page.css'), '.row { color: #1a73e8; }\n');
  const warn = run(['detect', '--kind', 'screen', 'page.css', '--json'], '', dir);
  assert.equal(warn.status, 0, warn.stdout);
  assert.equal(JSON.parse(warn.stdout).warnings, 1);
  assert.equal(run(['detect', '--kind', 'poster', 'page.css'], '', dir).status, 2);
});

test('rules --add with --kind adds a precise rule that runs only under that kind', () => {
  const dir = tmpDir('slop-rules-');
  const add = run(['rules', '--add', 'no-synergy', 'synergy', 'say what it does', '--kind', 'customer-copy', '--said', 'no synergy (2026-11-25)'], '', dir);
  assert.equal(add.status, 0, add.stdout + add.stderr);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, '.atris', 'slop.rules.json'), 'utf8'));
  assert.deepEqual(saved[0], { id: 'no-synergy', pattern: 'synergy', why: 'say what it does', sev: 'error', kind: 'customer-copy', said: 'no synergy (2026-11-25)' });
  fs.writeFileSync(path.join(dir, 'copy.md'), 'Real synergy for your studio.\n');
  const kinded = run(['detect', '--kind', 'customer-copy', 'copy.md', '--json'], '', dir);
  assert.equal(kinded.status, 1);
  assert.ok(JSON.parse(kinded.stdout).findings.some((f) => f.rule === 'no-synergy' && f.said === 'no synergy (2026-11-25)'));
  const plain = run(['detect', 'copy.md', '--json'], '', dir);
  assert.ok(!JSON.parse(plain.stdout).findings.some((f) => f.rule === 'no-synergy'), 'plain detect is unchanged');
  const list = run(['rules', '--kind', 'email'], '', dir);
  assert.match(list.stdout, /email-hey-name/);
  assert.match(list.stdout, /no-synergy.*\(project\)/, 'email runs customer-copy rules too');
});

test('slop help names the kinds', () => {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try { slopCommand(['help']); } finally { console.log = orig; }
  assert.match(lines.join('\n'), /--kind email/);
});

test('an html page under the screen kind names what was not read and which rules are off', () => {
  const dir = tmpDir('slop-screen-page-');
  fs.mkdirSync(path.join(dir, '.atris'));
  fs.writeFileSync(path.join(dir, '.atris', 'slop.rules.json'), '{ "off": ["page-subtitle"] }');
  fs.writeFileSync(path.join(dir, 'drawn.html'), '<html><body><div id="app"></div><script>app.textContent = "Hi";</script></body></html>\n');
  const plain = run(['detect', '--kind', 'screen', 'drawn.html'], '', dir);
  assert.equal(plain.status, 0, plain.stdout + plain.stderr);
  assert.match(plain.stdout, /drawn\.html: not checked: a script draws this page/);
  assert.match(plain.stdout, /switched off in \.atris\/slop\.rules\.json: page-subtitle/);
  const json = JSON.parse(run(['detect', '--kind', 'screen', 'drawn.html', '--json'], '', dir).stdout);
  assert.deepEqual(json.off, ['page-subtitle']);
  assert.equal(json.not_checked[0].file, 'drawn.html');
});

test('the screen rule list marks the rules html pages skip and points html pages at atris site rules', () => {
  const list = run(['rules', '--kind', 'screen'], '', tmpDir('slop-screen-rules-')).stdout;
  assert.match(list, /screen-subtitle.*not run on \.html/);
  assert.doesNotMatch(list, /screen-raw-colour.*not run on \.html/);
  assert.match(list, /html pages: atris site rules lists the page rules/);
});
