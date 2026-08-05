'use strict';

// The pruning pass keeps the team lean: atris team prune flags members with
// no recent signal (MEMBER.md mtime, logs/*.md mtime, or an owned mission
// still active/running) and never deletes anything. Contract: plain lowercase
// sentences, no ids, and a stable --json shape.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { collectTeamPrune, renderTeamPrune, teamCommand } = require('../commands/team');

const DAY_MS = 24 * 60 * 60 * 1000;

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-team-prune-'));
  fs.mkdirSync(path.join(root, 'atris', 'team'), { recursive: true });
  return root;
}

function addMember(root, name, { memberAgeDays, logAgeDays } = {}) {
  const dir = path.join(root, 'atris', 'team', name);
  fs.mkdirSync(dir, { recursive: true });
  const memberFile = path.join(dir, 'MEMBER.md');
  fs.writeFileSync(memberFile, `# ${name}\n`);
  if (Number.isFinite(memberAgeDays)) {
    const when = new Date(Date.now() - memberAgeDays * DAY_MS);
    fs.utimesSync(memberFile, when, when);
  }
  if (Number.isFinite(logAgeDays)) {
    const logsDir = path.join(dir, 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    const logFile = path.join(logsDir, 'work.md');
    fs.writeFileSync(logFile, 'did a thing\n');
    const when = new Date(Date.now() - logAgeDays * DAY_MS);
    fs.utimesSync(logFile, when, when);
  }
  return dir;
}

test('quiet member is flagged, recently active member is not', (t) => {
  const root = makeRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  addMember(root, 'ghost', { memberAgeDays: 90 });
  addMember(root, 'worker', { memberAgeDays: 90, logAgeDays: 2 });

  const report = collectTeamPrune({ root, missions: [] });
  assert.deepEqual(report.quiet.map((m) => m.name), ['ghost']);
  assert.equal(report.active_count, 1);
  const ghost = report.quiet[0];
  assert.ok(ghost.days_quiet >= 89 && ghost.days_quiet <= 90, `days_quiet near 90, got ${ghost.days_quiet}`);
  assert.ok(!Number.isNaN(Date.parse(ghost.last_signal)), 'last_signal is a parseable timestamp');

  const rendered = renderTeamPrune(report, 30);
  assert.match(rendered, /^ghost has been quiet for \d+ days; keep, hand off, or retire\.$/m);
  assert.ok(!/worker/.test(rendered), 'active member is not flagged');
  assert.match(rendered, /nothing was deleted/);
  assert.equal(rendered, rendered.toLowerCase(), 'output stays lowercase');
  assert.ok(!rendered.includes('—'), 'no em dashes in output');
});

test('a member with an active mission is not flagged even with old files', (t) => {
  const root = makeRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  addMember(root, 'pilot', { memberAgeDays: 120, logAgeDays: 120 });

  const missions = [{ id: 'm1', owner: 'pilot', status: 'running' }];
  const report = collectTeamPrune({ root, missions });
  assert.equal(report.quiet.length, 0);
  assert.equal(report.active_count, 1);

  // A finished mission is not a signal.
  const done = collectTeamPrune({ root, missions: [{ id: 'm2', owner: 'pilot', status: 'complete' }] });
  assert.deepEqual(done.quiet.map((m) => m.name), ['pilot']);
});

test('--days widens or narrows the window', (t) => {
  const root = makeRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  addMember(root, 'drifter', { memberAgeDays: 10 });

  assert.equal(collectTeamPrune({ root, missions: [], days: 30 }).quiet.length, 0);
  assert.deepEqual(collectTeamPrune({ root, missions: [], days: 5 }).quiet.map((m) => m.name), ['drifter']);
});

test('team prune --json returns the report shape through the command', (t) => {
  const root = makeRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  addMember(root, 'ghost', { memberAgeDays: 60 });
  addMember(root, 'worker', { logAgeDays: 1 });

  let out = '';
  const code = teamCommand(['prune', '--days', '30', '--json'], { root, missions: [], write: (s) => { out += s; } });
  assert.equal(code, 0);
  const parsed = JSON.parse(out);
  assert.deepEqual(Object.keys(parsed).sort(), ['active_count', 'quiet']);
  assert.equal(parsed.active_count, 1);
  assert.equal(parsed.quiet.length, 1);
  assert.deepEqual(Object.keys(parsed.quiet[0]).sort(), ['days_quiet', 'last_signal', 'name']);
  assert.equal(parsed.quiet[0].name, 'ghost');
});

test('empty team renders the create hint and prune deletes nothing', (t) => {
  const root = makeRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const before = fs.readdirSync(path.join(root, 'atris', 'team'));

  let out = '';
  const code = teamCommand(['prune'], { root, missions: [], write: (s) => { out += s; } });
  assert.equal(code, 0);
  assert.match(out, /no team members yet/);
  assert.deepEqual(fs.readdirSync(path.join(root, 'atris', 'team')), before, 'prune touched nothing on disk');
});

test('bad --days values fail with usage', () => {
  let err = '';
  const code = teamCommand(['prune', '--days', 'soon'], { error: (s) => { err += s; } });
  assert.equal(code, 2);
  assert.match(err, /usage: atris team prune/);
});
