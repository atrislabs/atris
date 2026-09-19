'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { scrubAgentEnv } = require('./helpers/agent-env');
const { collectDocHealth } = require('../commands/doc-health');

const cli = path.resolve(__dirname, '../bin/atris.js');

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-doc-health-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function write(root, file, content) {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), content);
  // Feature activity is the newer of the written date and the file's own time, so a
  // seeded idea file must not look freshly touched: pin its time to its written date.
  if (/atris\/features\/.*idea\.md$/.test(file)) {
    const dates = [...String(content).matchAll(/(?:Created|Last Updated)\*{0,2}:\*{0,2}\s*([^\r\n]+)/g)]
      .map(m => Date.parse(m[1].replace(/\*\*/g, '').trim())).filter(Number.isFinite);
    if (dates.length) { const when = new Date(Math.max(...dates)); fs.utimesSync(path.join(root, file), when, when); }
  }
}

function run(root, args = []) {
  const result = spawnSync(process.execPath, [cli, 'doc-health', ...args], {
    cwd: root, encoding: 'utf8', timeout: 15000,
    env: { ...scrubAgentEnv(), ATRIS_SKIP_UPDATE_CHECK: '1' },
  });
  if (result.error) throw result.error;
  return result;
}

test('missing atris folder exits 1 with a plain message and JSON error', t => {
  const root = workspace(t);
  const text = run(root);
  assert.equal(text.status, 1, text.stderr);
  assert.equal(text.stdout.trim(), 'no atris/ folder in this workspace.');
  const json = run(root, ['--json']);
  assert.equal(json.status, 1, json.stderr);
  assert.equal(JSON.parse(json.stdout).ok, false);
});

test('boot load reports all files, missing files, and oversized files', t => {
  const root = workspace(t);
  write(root, 'atris/atris.md', '');
  write(root, 'AGENTS.md', 'x'.repeat(20001));
  const result = run(root, ['--json']);
  assert.equal(result.status, 0, result.stderr);
  const { boot_load } = JSON.parse(result.stdout);
  assert.equal(boot_load.files.length, 11);
  assert.equal(boot_load.total_chars, 20001);
  assert.equal(boot_load.approximate_tokens, 5000.25);
  assert.equal(boot_load.files.find(file => file.path === 'AGENTS.md').oversized, true);
  assert.equal(boot_load.files.find(file => file.path === 'CLAUDE.md').missing, true);
  const text = run(root);
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /approximate tokens = chars divided by 4/);
  assert.match(text.stdout, /over 20,000 chars/);
  assert.match(text.stdout, /CLAUDE\.md\s+0\s+0\s+missing/);
  assert.doesNotMatch(text.stdout, /\u2014/);
});

test('map coverage counts routing rows, unique paths, line references, and exact folder mentions', t => {
  const root = workspace(t);
  write(root, 'atris/atris.md', '');
  write(root, 'commands/task.js', '');
  write(root, 'atris/wiki/guide.md', '');
  write(root, 'atris/features/alpha/idea.md', '');
  write(root, 'atris/features/alpha-more/idea.md', '');
  write(root, 'atris/team/alice/MEMBER.md', '');
  write(root, 'atris/team/bob/MEMBER.md', '');
  write(root, 'atris/MAP.md', [
    'route | paths | note', '--- | --- | ---',
    '| tasks | `commands/task.js:12-20`, `atris/wiki/guide.md:5#intro` | use them |',
    'repeats | `commands/task.js:99` and `missing.js` | missing path',
    '| `ignored.md` | no path | `also-ignored.md` |',
    '', 'a prose `id|title` example with `not-a-routing-path.md`',
    '```md', '| example | `also-not-a-routing-path.md` |', '```',
    'feature: atris/features/alpha-more/idea.md', 'member: `atris/team/alice/MEMBER.md`',
  ].join('\n'));
  const result = run(root, ['--json']);
  assert.equal(result.status, 0, result.stderr);
  const map = JSON.parse(result.stdout).map_coverage;
  assert.equal(map.rows, 2);
  assert.equal(map.paths, 3);
  assert.equal(map.existing, 2);
  assert.equal(map.score, 2 / 3);
  assert.deepEqual(map.features, { total: 2, mentioned: 1, missing: ['alpha'] });
  assert.deepEqual(map.members, { total: 2, mentioned: 1, missing: ['bob'] });
});

test('real CLI reports one-hop, two-hop, and unresolved questions with JSON score parts', t => {
  const root = workspace(t);
  write(root, 'atris/atris.md', '');
  write(root, 'atris/MAP.md', '| tasks | `commands/task.js` | task ownership |\nSee `atris/wiki/guide.md:5`.\n');
  write(root, 'commands/task.js', '');
  write(root, 'atris/wiki/guide.md', 'Mission state is in lib/mission-root.js.\n');
  const questions = [
    { q: 'Where is TASK ownership?', expect: 'commands/task.js' },
    { q: 'Where is mission state?', expect: 'lib/mission-root.js' },
    { q: 'Where is payment processing?', expect: 'commands/payment.js' },
  ];
  write(root, 'atris/doc-health/questions.jsonl', questions.map(q => JSON.stringify(q)).join('\n'));
  const result = run(root, ['--json']);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(payload).sort(), ['ok', 'action', 'root', 'boot_load', 'map_coverage', 'lookup_hops', 'staleness', 'near_duplicates', 'overall'].sort());
  assert.equal(payload.ok, true);
  assert.equal(payload.action, 'doc-health');
  assert.deepEqual(payload.lookup_hops.questions.map(q => q.hops), [1, 2, null]);
  assert.equal(payload.lookup_hops.questions[1].via, 'atris/wiki/guide.md');
  assert.equal(payload.lookup_hops.score, 1 / 3);
  assert.equal(payload.lookup_hops.one_hop, 1);
  assert.equal(payload.lookup_hops.two_hops, 1);
  assert.equal(payload.lookup_hops.unresolved, 1);
  assert.deepEqual(payload.overall.parts, {
    lookup_hops: { points: 10, max: 30 }, map_coverage: { points: 25, max: 25 },
    boot_load: { points: 20, max: 20 }, feature_freshness: { points: 15, max: 15 }, member_freshness: { points: 10, max: 10 },
  });
  assert.equal(payload.overall.total, 80);
  const text = run(root);
  assert.match(text.stdout, /Where is TASK ownership\?\s+1/);
  assert.match(text.stdout, /Where is mission state\?\s+2/);
  assert.match(text.stdout, /Where is payment processing\?\s+unresolved/);
});

test('one hop requires a keyword on the same line and drops stop words and short words', t => {
  const root = workspace(t);
  write(root, 'atris/atris.md', '');
  write(root, 'atris/MAP.md', 'WHERE it is: `lib/secret.js`\nZEBRA\n');
  write(root, 'atris/doc-health/questions.jsonl', [
    { q: 'Where is it?', expect: 'lib/secret.js' },
    { q: 'Where is zebra?', expect: 'lib/secret.js' },
  ].map(q => JSON.stringify(q)).join('\n'));
  const payload = JSON.parse(run(root, ['--json']).stdout);
  assert.deepEqual(payload.lookup_hops.questions.map(q => q.hops), [null, null]);
  assert.equal(payload.lookup_hops.score, 0);
});

test('missing and empty question files skip scoring and explain how to add questions', t => {
  const root = workspace(t);
  write(root, 'atris/atris.md', '');
  const text = run(root);
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /create atris\/doc-health\/questions.jsonl with one object per line/);
  assert.match(text.stdout, /lookup score: null/);
  const payload = JSON.parse(run(root, ['--json']).stdout);
  assert.equal(payload.lookup_hops.missing, true);
  assert.equal(payload.lookup_hops.score, null);
  assert.equal(payload.overall.lookup_skipped, true);
  assert.equal(payload.overall.total, 45);
  write(root, 'atris/doc-health/questions.jsonl', '\n');
  const empty = JSON.parse(run(root, ['--json']).stdout);
  assert.equal(empty.lookup_hops.missing, false);
  assert.equal(empty.lookup_hops.score, null);
});

test('custom questions resolve from the workspace root even when invoked in a subfolder', t => {
  const root = workspace(t);
  write(root, 'atris/atris.md', '');
  write(root, 'atris/MAP.md', 'task: `commands/task.js`\n');
  write(root, 'checks/questions.jsonl', '{bad json}\nnull\n{"q":"where","expect":2}\n{"q":"where is task","expect":"commands/task.js"}\n');
  for (const args of [['--questions', 'checks/questions.jsonl'], ['--questions=checks/questions.jsonl']]) {
    const result = run(path.join(root, 'checks'), [...args, '--json']);
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(fs.realpathSync(payload.root), fs.realpathSync(root));
    assert.deepEqual(payload.lookup_hops.invalid_lines, [1, 2, 3]);
    assert.equal(payload.lookup_hops.score, 1);
  }
});

test('staleness flags old active features and members with no logs or old nested logs', t => {
  const root = workspace(t);
  const now = Date.now();
  const daysAgo = days => new Date(now - days * 86400000);
  write(root, 'atris/atris.md', '');
  write(root, 'atris/features/old/idea.md', '**Created:** 2000-01-01\n**Last Updated:** 2001-01-01\n**Status:** building\n');
  write(root, 'atris/features/recent/idea.md', `Created: 2000-01-01\nLast Updated: ${daysAgo(2).toISOString()}\nStatus: active\n`);
  write(root, 'atris/features/undated/idea.md', 'Status: active\n');
  for (const status of ['complete', 'shipped', 'live', 'archived', 'parked']) {
    write(root, `atris/features/${status}/idea.md`, `Created: 2000-01-01\nStatus: ${status}\n`);
  }
  for (const name of ['no-logs', 'old', 'recent']) write(root, `atris/team/${name}/MEMBER.md`, '# member\n');
  for (const name of ['old', 'recent']) {
    const file = `atris/team/${name}/logs/2020/entry.md`;
    write(root, file, 'old log\n');
    fs.utimesSync(path.join(root, file), daysAgo(40), daysAgo(40));
  }
  write(root, 'atris/team/recent/logs/latest.md', 'new log\n');
  // A log directory without MEMBER.md is not a member.
  write(root, 'atris/team/not-a-member/logs/entry.md', '');
  const result = run(root, ['--json']);
  assert.equal(result.status, 0, result.stderr);
  const { staleness, overall } = JSON.parse(result.stdout);
  assert.equal(staleness.features.total, 8);
  assert.equal(staleness.features.flagged, 1);
  assert.equal(staleness.features.oldest[0].name, 'old');
  assert.equal(staleness.features.oldest[0].date, '2001-01-01');
  assert.equal(staleness.members.total, 3);
  assert.equal(staleness.members.flagged, 2);
  assert.equal(staleness.members.oldest[0].name, 'no-logs');
  assert.equal(staleness.members.oldest[1].name, 'old');
  assert.equal(staleness.members.oldest[1].age_days, 40);
  assert.equal(overall.parts.feature_freshness.points, 13.13);
  assert.equal(overall.parts.member_freshness.points, 3.33);
  const text = run(root).stdout;
  assert.match(text, /no-logs\s+no logs/);
});

test('freshness thresholds are strictly older than 60 and 30 days and oldest lists stop at ten', t => {
  const root = workspace(t);
  const now = Date.parse('2026-09-15T00:00:00Z');
  write(root, 'atris/atris.md', '');
  for (let i = 0; i < 12; i++) {
    write(root, `atris/features/old-${i}/idea.md`, `Created: ${new Date(now - (61 + i) * 86400000).toISOString()}\nStatus: active`);
  }
  write(root, 'atris/features/boundary/idea.md', `Created: ${new Date(now - 60 * 86400000).toISOString()}`);
  write(root, 'atris/team/boundary/MEMBER.md', '');
  write(root, 'atris/team/boundary/logs/entry.md', '');
  const boundary = new Date(now - 30 * 86400000);
  fs.utimesSync(path.join(root, 'atris/team/boundary/logs/entry.md'), boundary, boundary);
  const payload = collectDocHealth({ cwd: root, now });
  assert.equal(payload.staleness.features.flagged, 12);
  assert.equal(payload.staleness.features.oldest.length, 10);
  assert.equal(payload.staleness.features.oldest[0].name, 'old-11');
  assert.equal(payload.staleness.features.items.find(item => item.name === 'boundary').stale, false);
  assert.equal(payload.staleness.members.flagged, 0);
});

test('near duplicate feature groups require at least five shared prefix characters', t => {
  const root = workspace(t);
  write(root, 'atris/atris.md', '');
  for (const name of ['alpha-api', 'alpha-env', 'alpha', 'beta-api', 'aeo', 'aeo-anyone', 'rl-api', 'rl-environment']) {
    fs.mkdirSync(path.join(root, 'atris/features', name), { recursive: true });
  }
  const payload = JSON.parse(run(root, ['--json']).stdout);
  assert.deepEqual(payload.near_duplicates, [{ prefix: 'alpha', names: ['alpha', 'alpha-api', 'alpha-env'] }]);
});

test('boot scoring is linear between 80,000 and 200,000 chars and clamps outside', t => {
  const root = workspace(t);
  for (const [chars, points] of [[0, 20], [60000, 20], [80000, 20], [140000, 10], [200000, 0], [210000, 0]]) {
    write(root, 'atris/atris.md', 'x'.repeat(chars));
    const result = run(root, ['--json']);
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.overall.parts.boot_load.points, points);
    assert.ok(payload.overall.total >= 0 && payload.overall.total <= 100);
    assert.equal(payload.overall.total, Object.values(payload.overall.parts).reduce((sum, part) => sum + part.points, 0));
  }
});

test('help works outside a workspace and the repository ships ten questions with existing paths', t => {
  const root = workspace(t);
  const help = run(root, ['--help']);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /usage: atris doc-health \[--json\] \[--questions <path>\]/);
  const repo = path.resolve(__dirname, '..');
  const questions = fs.readFileSync(path.join(repo, 'atris/doc-health/questions.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(questions.length, 10);
  for (const question of questions) {
    assert.ok(question.q.trim());
    assert.ok(fs.statSync(path.join(repo, question.expect)).isFile(), question.expect);
  }
});

test('startup shows the direct document score after current work, with a missing-questions nudge', t => {
  const root = workspace(t);
  write(root, 'atris/atris.md', '');
  write(root, 'atris/TODO.md', '# TODO\n\n## Backlog\n- Read the guide\n');
  write(root, 'atris/MAP.md', '| guide | `atris/atris.md` | workspace guide |\n');
  const boot = () => spawnSync(process.execPath, [cli, 'atris.md'], {
    cwd: root, encoding: 'utf8', timeout: 15000,
    env: { ...scrubAgentEnv(), ATRIS_SKIP_UPDATE_CHECK: '1', ATRIS_TASKS_DB: path.join(root, 'missing.db') },
  });
  const missing = boot();
  assert.equal(missing.status, 0, missing.stderr);
  assert.match(missing.stdout, /docs\s+70\/100 · add atris\/doc-health\/questions\.jsonl/);
  write(root, 'atris/doc-health/questions.jsonl', JSON.stringify({ q: 'where is the guide', expect: 'atris/atris.md' }));
  const result = boot();
  assert.equal(result.status, 0, result.stderr);
  const health = require('../commands/doc-health').computeDocHealth(root);
  const expected = `${health.overall.total}/100 · 100% one hop · boot ${(health.boot_load.approximate_tokens / 1000).toFixed(1)}k tokens`;
  assert.ok(result.stdout.includes(expected), result.stdout);
  assert.ok(result.stdout.indexOf('Read the guide') < result.stdout.indexOf('docs '));
  assert.equal(fs.existsSync(path.join(root, 'missing.db')), false);
});

test('startup survives an exception from document health', t => {
  const root = workspace(t);
  write(root, 'atris/atris.md', '');
  const modulePath = require.resolve('../commands/doc-health');
  write(root, 'fail-health.cjs', `require(${JSON.stringify(modulePath)}).computeDocHealth = () => { throw new Error('unreadable docs'); };\n`);
  const result = spawnSync(process.execPath, ['--require', path.join(root, 'fail-health.cjs'), cli, 'atris.md'], {
    cwd: root, encoding: 'utf8', timeout: 15000,
    env: { ...scrubAgentEnv(), ATRIS_SKIP_UPDATE_CHECK: '1', ATRIS_TASKS_DB: path.join(root, 'missing.db') },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /next\s+atris plan/);
  assert.doesNotMatch(result.stdout + result.stderr, /unreadable docs/);
});

test('direct document health does not launch a child process', t => {
  const root = workspace(t);
  write(root, 'atris/atris.md', '');
  const childProcess = require('node:child_process');
  for (const method of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
    t.mock.method(childProcess, method, () => { throw new Error(`unexpected ${method}`); });
  }
  const { computeDocHealth } = require('../commands/doc-health');
  assert.equal(computeDocHealth(root).ok, true);
});

test('startup score matches the detailed report while skipping unneeded documents and log stats', t => {
  const root = workspace(t);
  write(root, 'atris/atris.md', '');
  write(root, 'atris/MAP.md', '| guide | `atris/atris.md` | guide |\nSee `atris/wiki/large.md`.\n');
  write(root, 'atris/wiki/large.md', 'details');
  write(root, 'atris/doc-health/questions.jsonl', '{"q":"guide","expect":"atris/atris.md"}\n');
  write(root, 'atris/team/active/MEMBER.md', '# active\n');
  for (let i = 0; i < 100; i++) write(root, `atris/team/active/logs/log-${i}.md`, 'recent\n');
  write(root, 'atris/team/stale/MEMBER.md', '# stale\n');
  write(root, 'atris/team/stale/logs/old.md', 'old\n');
  fs.utimesSync(path.join(root, 'atris/team/stale/logs/old.md'), new Date('2000-01-01'), new Date('2000-01-01'));
  const detailed = collectDocHealth({ cwd: root });
  const read = fs.readFileSync;
  const stat = fs.statSync;
  let logStats = 0;
  t.mock.method(fs, 'readFileSync', function(file, ...args) {
    assert.notEqual(String(file), path.join(root, 'atris/wiki/large.md'));
    return read.call(this, file, ...args);
  });
  t.mock.method(fs, 'statSync', function(file, ...args) {
    if (String(file).includes(`${path.sep}logs${path.sep}`)) logStats++;
    return stat.call(this, file, ...args);
  });
  const summary = require('../commands/doc-health').computeDocHealth(root);
  assert.deepEqual(summary.overall, detailed.overall);
  assert.equal(logStats, 2, 'one fresh log settles activity; stale logs are still inspected');
  assert.equal(summary.staleness, undefined, 'partial newest timestamps are not reported');
});

for (const status of ['retired', 'parked', 'archived']) {
  test(`member freshness excludes ${status} frontmatter from its denominator`, t => {
    const root = workspace(t);
    write(root, 'atris/atris.md', '');
    write(root, 'atris/team/active/MEMBER.md', '---\nstatus: active\n---\n');
    for (const [name, value] of [['plain', status], ['quoted', `"${status.toUpperCase()}" # inactive`], ['single', `'${status}'`]]) {
      write(root, `atris/team/${name}/MEMBER.md`, `---\r\nstatus: ${value}\r\n---\r\n# member\r\n`);
    }
    const payload = collectDocHealth({ cwd: root });
    assert.deepEqual(payload.staleness.members.items.map(item => item.name), ['active']);
    assert.equal(payload.staleness.members.total, 1);
    assert.equal(payload.staleness.members.flagged, 1);
    assert.equal(payload.overall.parts.member_freshness.points, 0);
    assert.equal(require('../commands/doc-health').computeDocHealth(root).overall.total, payload.overall.total);
  });
}

test('member exclusions read only an exact top-level frontmatter status', t => {
  const root = workspace(t);
  write(root, 'atris/atris.md', '');
  write(root, 'atris/team/body/MEMBER.md', '# member\nstatus: retired\n');
  write(root, 'atris/team/active/MEMBER.md', '---\nstatus: active\n---\nstatus: archived\n');
  write(root, 'atris/team/nested/MEMBER.md', '---\nprevious:\n  status: retired\n---\n');
  write(root, 'atris/team/not-exact/MEMBER.md', '---\nstatus: retired-soon\n---\n');
  write(root, 'atris/team/unclosed/MEMBER.md', '---\nstatus: retired\n');
  assert.equal(collectDocHealth({ cwd: root }).staleness.members.flagged, 5);
});

for (const status of ['parked', 'retired', 'superseded']) {
  test(`old features with ${status} in their status are not stale`, t => {
    const root = workspace(t);
    write(root, 'atris/atris.md', '');
    write(root, 'atris/features/exempt/idea.md', `Created: 2000-01-01\n**Status:** ${status.toUpperCase()} after review\n`);
    write(root, 'atris/features/active/idea.md', `Created: 2000-01-01\nStatus: active\nNotes: ${status}\n`);
    const payload = collectDocHealth({ cwd: root });
    assert.equal(payload.staleness.features.total, 2);
    assert.deepEqual(payload.staleness.features.oldest.map(item => item.name), ['active']);
    assert.equal(payload.overall.parts.feature_freshness.points, 7.5);
  });
}

for (const folder of ['_archive', '_templates']) {
  test(`${folder} and its children never count as features`, t => {
    const root = workspace(t);
    write(root, 'atris/atris.md', '');
    for (const name of [folder, `${folder}/alpha-old`, `${folder}/alpha-new`, `${folder}-active`]) {
      write(root, `atris/features/${name}/idea.md`, 'Created: 2000-01-01\nStatus: active\n');
    }
    const payload = collectDocHealth({ cwd: root });
    assert.deepEqual(payload.staleness.features.items.map(item => item.name), [`${folder}-active`]);
    assert.equal(payload.staleness.features.flagged, 1);
    assert.deepEqual(payload.map_coverage.features, { total: 1, mentioned: 0, missing: [`${folder}-active`] });
    assert.deepEqual(payload.near_duplicates, []);
  });
}

test('large document health JSON drains completely through a pipe', t => {
  const root = workspace(t);
  write(root, 'atris/atris.md', '');
  for (let i = 0; i < 40; i++) {
    write(root, `atris/team/member-${i}/MEMBER.md`, '# Active member\n');
  }
  const questions = Array.from({ length: 400 }, (_, i) => ({
    q: `Where is the documented workflow for member ${i % 40} and responsibility ${i}?`,
    expect: `atris/team/member-${i % 40}/MEMBER.md`,
  }));
  write(root, 'atris/doc-health/questions.jsonl', questions.map(q => JSON.stringify(q)).join('\n'));
  const result = spawnSync(process.execPath, [cli, 'doc-health', '--json'], {
    cwd: root, encoding: 'utf8', stdio: 'pipe', maxBuffer: 10 * 1024 * 1024, timeout: 15000,
    env: { ...scrubAgentEnv(), ATRIS_SKIP_UPDATE_CHECK: '1' },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.length > 70000, `expected large JSON, got ${result.stdout.length} chars`);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.staleness.members.total, 40);
  assert.equal(payload.lookup_hops.questions.length, 400);
});

test('underscore folders under team and features are scaffolding, not members or work', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-health-underscore-'));
  write(root, 'atris/MAP.md', '| Task | Path | Notes |\n|---|---|---|\n');
  write(root, 'atris/team/_template/MEMBER.md', '---\nname: _template\n---\n');
  write(root, 'atris/team/alice/MEMBER.md', '---\nname: alice\n---\n');
  write(root, 'atris/features/_drafts/idea.md', 'Created: 2000-01-01\nStatus: active\n');
  write(root, 'atris/features/real/idea.md', 'Created: 2000-01-01\nStatus: complete\n');
  const json = JSON.parse(run(root, ['--json']).stdout);
  assert.deepEqual(json.staleness.members.items.map(item => item.name), ['alice']);
  assert.deepEqual(json.staleness.features.items.map(item => item.name), ['real']);
});
