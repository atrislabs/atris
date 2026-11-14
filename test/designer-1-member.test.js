'use strict';

// Designer-1 ships in the package as a ready-made member. These checks pin the
// install, the free and pro boundary, and the member's own
// never list (no em dashes, no slop tells, no personal paths).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repo = path.join(__dirname, '..');
const cli = path.join(repo, 'bin', 'atris.js');
const template = path.join(repo, 'templates', 'members', 'designer-1');
const skillDir = path.join(template, 'skills', 'designer-1');
const FILES = [
  'MEMBER.md',
  'SOUL.md',
  'MISSION.md',
  'goals.md',
  'goals.json',
  'context/why.md',
  'skills/designer-1/SKILL.md',
];

function tempProject(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-designer-1-'));
  fs.mkdirSync(path.join(root, 'atris'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function run(cwd, ...args) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1' },
  });
}

function shippedFiles(dir = template, relative = '') {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const rel = path.join(relative, entry.name);
    return entry.isDirectory() ? shippedFiles(path.join(dir, entry.name), rel) : [rel];
  });
}

function skillText() {
  return fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8');
}

// The body of the "## <n>. <title>" section, up to the next "## ".
function section(title) {
  const text = skillText();
  const start = text.search(new RegExp(`^## \\d+\\. ${title}\\b`, 'm'));
  assert.ok(start >= 0, `section ${title}`);
  const rest = text.slice(start + 3);
  const end = rest.search(/^## /m);
  return end < 0 ? rest : rest.slice(0, end);
}

function budgetRows() {
  const rows = new Map();
  const lines = section('never').split('\n');
  const header = lines.findIndex((line) => /^\| region \| max words \|$/.test(line));
  assert.ok(header >= 0, 'word budget table');
  for (const line of lines.slice(header + 2)) {
    if (!line.startsWith('|')) break;
    const match = line.match(/^\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|$/);
    assert.ok(match, line);
    rows.set(match[1], match[2]);
  }
  return rows;
}

test('the list comes first and names every state', () => {
  const text = skillText();
  const list = section('the list');
  assert.ok(text.indexOf('## 1. the list') < text.indexOf('reuse first'), 'the list comes before reuse');
  for (const state of ['empty', 'error', 'pending', 'done', 'undo']) assert.match(list, new RegExp(`\\b${state}\\b`), state);
  assert.match(list, /Nothing on the list is cut to save words/);
});

test('every self-check step has a line in the report', () => {
  const steps = [...section('self-check').matchAll(/^\d+\. \*\*([a-z ]+)\*\*:/gm)].map((m) => m[1]);
  assert.ok(steps.length >= 8, steps.join(', '));
  for (const step of ['list', 'failure path', 'flow by name', 'truth', 'targets', 'edges']) assert.ok(steps.includes(step), step);
  const report = section('report').match(/```\n([\s\S]*?)```/)[1];
  const keys = report.split('\n').filter(Boolean).map((line) => line.split(':')[0]);
  for (const step of steps) assert.ok(keys.includes(step), `report shows ${step}`);
  assert.ok(keys.includes('reused') && keys.includes('new'));
});

test('the consequence example has numbers and the explanation example trips the detector', () => {
  const words = section('words');
  const consequence = words.match(/^- consequence:.*Example: "([^"]+)"/m)[1];
  const explanation = words.match(/^- explanation:.*Example: "([^"]+)"/m)[1];
  const detector = section('never').match(/^\| explanation text \| (.*) \|$/m)[1];
  const phrases = [...detector.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(phrases.length >= 5);
  assert.ok(phrases.some((p) => explanation.includes(p)), `explanation example "${explanation}" is caught`);
  assert.ok(!phrases.some((p) => consequence.includes(p)), `consequence example "${consequence}" is not caught`);
  assert.match(consequence, /\d/);
  assert.match(words, /"anyone with the link", not "anyone"/);
});

test('every budget row is a number and the consequence budget says why', () => {
  const rows = budgetRows();
  for (const [region, max] of rows) assert.match(max, /^\d+$/, region);
  for (const region of ['consequence confirmation', 'option difference line', 'whole screen, without consequence and comparison text']) {
    assert.ok(rows.has(region), region);
  }
  const confirm = rows.get('consequence confirmation');
  assert.ok(Number(confirm) > Number(rows.get('dialog description')));
  assert.match(section('never'), new RegExp(`consequence confirmation gets ${confirm} because`));
});

// The body of one numbered self-check step.
function step(name) {
  const match = section('self-check').match(new RegExp(`^\\d+\\. \\*\\*${name}\\*\\*: (.*)$`, 'm'));
  assert.ok(match, name);
  return match[1];
}

test('targets and edges are measured in the running page at phone width', () => {
  assert.match(step('targets'), /390px/);
  assert.match(step('targets'), /measure every control's box in the running page/);
  assert.match(step('targets'), /under 44px/);
  assert.match(step('edges'), /390px, scroll to the bottom/);
  assert.match(step('edges'), /last control and its label are fully visible/);
  assert.match(section('spacing'), /^\d+\. Nothing fixed to a screen edge covers content: .*reserves its own height/m);
});

test('the page title outranks section headings by the stated ratio', () => {
  const spacing = section('spacing');
  const text = spacing.match(/^Text: .*$/m)[0];
  const factor = Number(text.match(/calc\(var\(--atris-part-text-title\) \* ([\d.]+)\)` \((\d+)\)/)[1]);
  const titlePx = Number(text.match(/page title `[^`]+` \((\d+)\)/)[1]);
  const headingPx = Number(text.match(/section headings `--atris-part-text-title` \((\d+)\)/)[1]);
  const stated = Number(text.match(/at least ([\d.]+) times a section heading/)[1]);
  assert.equal(factor, stated);
  assert.ok(stated >= 1.25, `ratio ${stated}`);
  assert.ok(titlePx / headingPx >= stated, `${titlePx} / ${headingPx}`);
});

test('words follow the truth and a later risky action withdraws a conflicting undo', () => {
  const words = section('words');
  assert.match(words, /^Words follow the truth\. Never promise what the screen does not do\. Two places never contradict\. Text tied to a state changes with the state/m);
  assert.match(words, /withdraw any earlier undo it would conflict with/);
  assert.match(step('truth'), /after each failure path and each risky action, read every sentence on the screen/);
  assert.match(step('truth'), /"words follow the truth"/i);
  assert.match(step('truth'), /try each undo still offered/);
});

test('the skill stays short and names no single screen or test run', () => {
  const words = skillText().split(/\s+/).filter(Boolean).length;
  assert.ok(words <= 1660, `${words} words`);
  assert.doesNotMatch(skillText(), /\btrial\b|plain build|billing screen/i);
});

test('the template ships every member file', () => {
  for (const file of FILES) assert.ok(fs.existsSync(path.join(template, file)), file);
  assert.deepEqual(shippedFiles().map((f) => f.split(path.sep).join('/')).sort(), [...FILES].sort());
  const goals = JSON.parse(fs.readFileSync(path.join(template, 'goals.json'), 'utf8'));
  assert.equal(goals.member, 'designer-1');
  assert.match(fs.readFileSync(path.join(template, 'MEMBER.md'), 'utf8'), /^---\nname: designer-1\n/);
});

test('member install designer-1 lands every file in a fresh project', (t) => {
  const root = tempProject(t);
  const result = run(root, 'member', 'install', 'designer-1');
  assert.equal(result.status, 0, result.stderr);
  const target = path.join(root, 'atris', 'team', 'designer-1');
  for (const file of FILES) {
    assert.ok(fs.existsSync(path.join(target, file)), file);
    assert.deepEqual(fs.readFileSync(path.join(target, file)), fs.readFileSync(path.join(template, file)), file);
    assert.match(result.stdout, new RegExp(`atris/team/designer-1/${file.replace(/[.]/g, '\\.')}\\n`));
  }
  assert.match(result.stdout, /MEMBER installed for designer-1\./);
  const again = run(root, 'member', 'install', 'designer-1');
  assert.equal(again.status, 0, again.stderr);
  assert.equal(again.stdout, 'MEMBER already installed for designer-1\n');
});

test('install --update refreshes the skill only', (t) => {
  const root = tempProject(t);
  assert.equal(run(root, 'member', 'install', 'designer-1').status, 0);
  const target = path.join(root, 'atris', 'team', 'designer-1');
  fs.writeFileSync(path.join(target, 'skills', 'designer-1', 'SKILL.md'), 'stale\n');
  fs.writeFileSync(path.join(target, 'SOUL.md'), 'local soul\n');
  const result = run(root, 'member', 'install', 'designer-1', '--update');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'atris/team/designer-1/skills/designer-1/SKILL.md\n');
  assert.equal(fs.readFileSync(path.join(target, 'skills', 'designer-1', 'SKILL.md'), 'utf8'), skillText());
  assert.equal(fs.readFileSync(path.join(target, 'SOUL.md'), 'utf8'), 'local soul\n');
});

test('free ships no parts catalog or required Atris component imports', () => {
  const parts = [
    'Button', 'Field', 'Input', 'Textarea', 'Checkbox', 'Switch', 'RadioGroup', 'Select',
    'Dialog', 'Popover', 'Menu', 'Tooltip', 'Toast', 'Tabs', 'Accordion',
    'SegmentedControl', 'Combobox', 'Slider', 'RowList',
  ];
  assert.ok(!fs.existsSync(path.join(skillDir, 'parts.md')));
  for (const file of shippedFiles()) {
    const text = fs.readFileSync(path.join(template, file), 'utf8');
    assert.doesNotMatch(text, /@atris\/design-react/, file);
    for (const statement of text.matchAll(/\bimport\s+[\s\S]*?\s+from\s+['"][^'"]+['"]|\b(?:const|let|var)\s+(?:\{[^}]*\}|\w+)\s*=\s*require\s*\([^)]+\)/g)) {
      for (const part of parts) assert.doesNotMatch(statement[0], new RegExp(`\\b${part}\\b`), `${file} imports ${part}`);
    }
  }
});

test('pro names the API model and explains what it adds', () => {
  const pro = section('pro');
  for (const text of [pro, fs.readFileSync(path.join(template, 'MEMBER.md'), 'utf8'), fs.readFileSync(path.join(repo, 'README.md'), 'utf8')]) {
    assert.match(text, /designer-1 model on the Atris API|designer-1 is also a model on the Atris API/i);
    assert.match(text, /growing library of real component code and full screens/);
    assert.match(text, /house taste/);
    assert.match(text, /complete method/);
    assert.match(text, /model underneath improves without callers changing anything/);
  }
});

test('shipped files contain no em dashes and no personal paths', () => {
  for (const file of shippedFiles()) {
    const text = fs.readFileSync(path.join(template, file), 'utf8');
    assert.doesNotMatch(text, /—/, `${file} has an em dash`);
    assert.doesNotMatch(text, /\/Users\/|\/home\/[a-z]|~\/arena|keshav/i, `${file} has a personal path or name`);
    assert.doesNotMatch(text, /mini-agi/i, file);
  }
});

test('shipped files pass atris slop detect', (t) => {
  const cwd = tempProject(t);
  const result = run(cwd, 'slop', 'detect', template, '--json');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, true);
  assert.ok(report.scanned >= FILES.length - 1, `scanned ${report.scanned}`);
});

test('users can find designer-1 where shipped members are listed', () => {
  assert.match(fs.readFileSync(path.join(repo, 'README.md'), 'utf8'), /atris member install designer-1/);
  assert.match(fs.readFileSync(path.join(repo, 'atris', 'MAP.md'), 'utf8'), /templates\/members\/designer-1\//);
  const help = fs.readFileSync(cli, 'utf8');
  assert.match(help, /member install <n>.*designer-1/);
});
