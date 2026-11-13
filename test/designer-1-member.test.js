'use strict';

// Designer-1 ships in the package as a ready-made member. These checks pin the
// install, the parts table against the design catalog, and the member's own
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
  'skills/designer-1/parts.md',
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

// Rows of the reference table: | `Button` | job | needs | props | callbacks |
function tableRows() {
  const text = fs.readFileSync(path.join(skillDir, 'parts.md'), 'utf8');
  const rows = new Map();
  for (const line of text.split('\n')) {
    const match = line.match(/^\|\s*`([A-Z][A-Za-z]+)`\s*\|(.*)\|\s*$/);
    if (match) rows.set(match[1], match[2]);
  }
  return rows;
}

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

test('install --update refreshes the skill and the parts table only', (t) => {
  const root = tempProject(t);
  assert.equal(run(root, 'member', 'install', 'designer-1').status, 0);
  const target = path.join(root, 'atris', 'team', 'designer-1');
  fs.writeFileSync(path.join(target, 'skills', 'designer-1', 'parts.md'), 'stale\n');
  fs.writeFileSync(path.join(target, 'SOUL.md'), 'local soul\n');
  const result = run(root, 'member', 'install', 'designer-1', '--update');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'atris/team/designer-1/skills/designer-1/parts.md\n');
  assert.equal(fs.readFileSync(path.join(target, 'SOUL.md'), 'utf8'), 'local soul\n');
});

test('the parts table has 18 rows and the skill names every one of them', () => {
  const rows = tableRows();
  assert.equal(rows.size, 18, [...rows.keys()].join(', '));
  const skill = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8');
  for (const name of rows.keys()) assert.match(skill, new RegExp(`\\b${name}\\b`), name);
  assert.match(skill, /parts\.md/);
});

test('the parts table matches the design catalog parts list', (t) => {
  const catalogPath = process.env.ATRIS_DESIGN_CATALOG;
  if (!catalogPath || !fs.existsSync(catalogPath)) {
    t.skip('set ATRIS_DESIGN_CATALOG to the atris-design components/catalog.json to compare the parts table with the catalog');
    return;
  }
  const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
  assert.ok(Array.isArray(catalog.parts), 'catalog has a parts list');
  const rows = tableRows();
  assert.deepEqual([...rows.keys()].sort(), catalog.parts.map((part) => part.react).sort());
  const skill = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8');
  for (const part of catalog.parts) {
    assert.match(skill, new RegExp(`\\b${part.react}\\b`), `skill names ${part.react}`);
    const cells = rows.get(part.react).split('|').map((cell) => cell.trim());
    const [job, needs, props] = cells;
    assert.equal(job, part.job, `${part.react} job`);
    for (const need of part.needs) assert.match(needs, new RegExp(`\`${need}\``), `${part.react} needs ${need}`);
    for (const prop of part.remix) assert.match(props, new RegExp(`\`${prop}\``), `${part.react} prop ${prop}`);
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
