'use strict';

// A job waits in Review under its builder's name while its pull request waits for a person to
// land it. `atris task sweep --held` credits the builder once that person merges the pull request,
// but nobody ran it: the first real one sat for hours with the builder rated 25. Now atris brief,
// atris rating, atris gm and both flights run the same sweep on their own, quietly:
//   - not again for an hour after a run that GitHub gave a readable answer in and that did not fail,
//     remembered in the CLI's state folder (never in the task store, never in the repository), and by
//     one command at a time (a small lock file),
//   - only when the workspace has a held job, and then with eight seconds to wait in, counted from the start, on
//     git and GitHub, each question with a short limit of its own (reading the task list is not cut short),
//   - saying one plain line on stderr for each job it credits or lets go, as that job is settled, and
//     nothing otherwise,
//   - never breaking the command it runs inside.
// These tests use a fake gh on the PATH (the seam the sweep's own tests use), the real task store,
// the real command line and the real rating. None of them reaches GitHub. The engine programs this
// computer happens to have are not read: the command line sees stand-ins for claude and codex and the
// system folders, so a machine without them (a CI runner) sees the same engines as one with them, and
// "says nothing" means an empty stderr everywhere.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const tasks = require('../lib/task-db');
const fleet = require('../lib/fleet');
const { loadSeason, rosterRows } = require('../lib/gm-season');
const { scrubAgentEnv } = require('./helpers/agent-env');

const CLI = path.resolve(__dirname, '..', 'bin', 'atris.js');
const COMMIT = '93b6d4bcf66276bbd6a53aebe72ab48bf9a7b136';
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const REPO = 'acme/widgets';
const ORIGIN = `git@github.com:${REPO}.git`;
const FIELDS = 'state,mergeCommit,mergedAt,mergedBy,number,url,headRefName,headRepository,headRepositoryOwner,baseRefName';
// gh prints a time to the second, in UTC. The desk's jobs were claimed three hours ago, and a person
// merged their pull requests an hour ago.
const ghTime = (ms) => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace('.000Z', 'Z');
const CLAIMED_AGO = 3 * HOUR;
const MERGED_AT = ghTime(Date.now() - HOUR);

const autosweep = () => require('../lib/held-autosweep');
const pullAt = (number, repo = REPO) => `https://github.com/${repo}/pull/${number}`;
const repoLink = (repo = REPO) => `https://github.com/${repo}`;
const askDefaultBranchCall = (repo = REPO) => `repo view ${repoLink(repo)} --json defaultBranchRef`;
const askPullRequestCall = (number, repo = REPO) => `pr view ${pullAt(number, repo)} --json ${FIELDS}`;
// The branch a dispatch flight builds a job on: the job's row id, lowercased, as one word.
const buildBranch = (id) => `codex/codex-dispatch-${String(id).toLowerCase()}-20261030-171500`;
const placed = (number) => ({ baseRefName: 'main', headRepository: { name: 'widgets' }, headRepositoryOwner: { login: 'acme' }, number, url: pullAt(number) });
const mergedPr = (number, extra = {}) => ({ state: 'MERGED', mergeCommit: { oid: COMMIT }, mergedAt: MERGED_AT, mergedBy: { login: 'harman', is_bot: false }, ...placed(number), ...extra });
const closedPr = (number, extra = {}) => ({ state: 'CLOSED', mergeCommit: null, mergedAt: null, mergedBy: null, ...placed(number), ...extra });
const openPr = (number, extra = {}) => ({ state: 'OPEN', mergeCommit: null, mergedAt: null, mergedBy: null, ...placed(number), ...extra });
// What gh 2.74.2 prints on its error output, and exits 1, when GitHub has no pull request with that number in a
// repository it can read (read from the real thing; gh ends it with a line break, left off here).
const notFoundFor = (number) => `GraphQL: Could not resolve to a PullRequest with the number of ${number}. (repository.pullRequest)`;

const real = (dir) => fs.realpathSync(dir);
const mkdtemp = (name) => real(fs.mkdtempSync(path.join(os.tmpdir(), name)));

// git in a folder, with none of the repository variables a hook or a parent git leaves behind.
function gitIn(dir, ...args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  const done = spawnSync('git', args, { cwd: dir, encoding: 'utf8', env });
  assert.equal(done.status, 0, `git ${args.join(' ')}: ${done.stderr}`);
}

// The programs standing in for the engines: they exist and do nothing, which is all the check for an installed engine asks.
const ENGINES = ['claude', 'codex'];
function standInEngines(dir) {
  for (const name of ENGINES) fs.writeFileSync(path.join(dir, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
}

// A PATH that has git, a shell (the check for an installed engine runs one) and the stand-in engines, and no gh at all.
function onlyGit(tools) {
  const dir = path.join(tools, 'only-git');
  fs.mkdirSync(dir);
  for (const entry of String(process.env.PATH || '').split(path.delimiter)) {
    const candidate = path.join(entry, 'git');
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      fs.symlinkSync(candidate, path.join(dir, 'git'));
      break;
    } catch { /* keep looking */ }
  }
  fs.symlinkSync('/bin/sh', path.join(dir, 'sh'));
  standInEngines(dir);
  return dir;
}

// ---------------------------------------------------------------------------
// A workspace with a real task store, a fake gh, a state folder of its own, and the real command line.
//
// The fake gh answers `pr view <url> --json <fields>` and `repo view <url> --json <fields>` from a
// file the test writes, prints only the fields it was asked for, and writes down every call. A url
// with a failure entry exits 1 and says that on stderr, as gh does; an exits entry exits with its code
// (4 is gh's "sign in first"). A raw entry prints that text and exits 0: a gh that says nothing, or something
// that is not a pull request. hangMs makes every call wait that long first (a gh that never answers),
// and rendezvous makes a call wait until that many calls have been made (so two commands that start
// together both ask before either one writes anything). kill makes a call end itself with that signal, as a gh
// does that something outside has killed.

function desk(t) {
  // The workspace sits alone in its own parent folder, as a checkout does, so a flight that looks at the
  // folders around it (to make room on a full disk) looks at none of the thousands in the temp folder.
  const parent = mkdtemp('auto-sweep-');
  const dir = path.join(parent, 'work');
  fs.mkdirSync(dir);
  const tools = mkdtemp('auto-sweep-tools-');
  const home = mkdtemp('auto-sweep-home-');
  fs.mkdirSync(path.join(dir, 'atris'));
  gitIn(dir, 'init', '-q');
  gitIn(dir, 'remote', 'add', 'origin', ORIGIN);
  // The task store lives outside the workspace, so the workspace holds only what a command writes into it.
  const dbPath = path.join(tools, 'tasks.db');
  const saved = process.env.ATRIS_TASKS_DB;
  process.env.ATRIS_TASKS_DB = dbPath;
  const db = tasks.open(dbPath);
  t.after(() => {
    tasks.close();
    if (saved === undefined) delete process.env.ATRIS_TASKS_DB; else process.env.ATRIS_TASKS_DB = saved;
    for (const folder of [parent, tools, home]) fs.rmSync(folder, { recursive: true, force: true });
  });
  assert.equal(tasks.workspaceRoot(dir), dir, 'the folder is its own workspace');

  const bin = path.join(tools, 'bin');
  fs.mkdirSync(bin);
  standInEngines(bin);
  const ghLog = path.join(tools, 'gh.log');
  const ghSetup = path.join(tools, 'gh.json');
  fs.writeFileSync(path.join(bin, 'gh'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(ghLog)}, args.join(' ') + '\\n');
const setup = fs.existsSync(${JSON.stringify(ghSetup)}) ? JSON.parse(fs.readFileSync(${JSON.stringify(ghSetup)}, 'utf8')) : {};
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
if (setup.kill) { process.kill(process.pid, setup.kill); sleep(10000); }
if (setup.hangMs) sleep(setup.hangMs);
if (setup.rendezvous) {
  const until = Date.now() + 20000;
  while (Date.now() < until && fs.readFileSync(${JSON.stringify(ghLog)}, 'utf8').split('\\n').filter(Boolean).length < setup.rendezvous) sleep(20);
}
const command = args.slice(0, 2).join(' ');
if (command !== 'pr view' && command !== 'repo view') { console.error('unexpected gh call: ' + args.join(' ')); process.exit(1); }
const url = args[2];
const fields = String(args[args.indexOf('--json') + 1] || '').split(',').filter(Boolean);
const failure = (setup.fail || {})[url];
if (failure) { console.error(failure); process.exit(1); }
const exit = (setup.exits || {})[url];
if (exit) { if (exit.say) console.error(exit.say); process.exit(exit.code); }
const raw = (setup.raw || {})[url];
if (raw !== undefined) { process.stdout.write(raw); process.exit(0); }
const known = command === 'pr view' ? (setup.prs || {})[url] : (setup.repos || {})[url];
if (!known) {
  // What gh says for a pull request GitHub does not have (it names the number), and for a repository it cannot read.
  const number = parseInt(String(url).split('/pull/')[1], 10);
  console.error(command === 'pr view' ? 'GraphQL: Could not resolve to a PullRequest with the number of ' + number + '. (repository.pullRequest)' : "GraphQL: Could not resolve to a Repository with the name 'acme/widgets'. (repository)");
  process.exit(1);
}
const shown = {};
for (const field of fields) if (field in known) shown[field] = known[field];
console.log(JSON.stringify(shown));
`, { mode: 0o755 });
  // GitHub reports a pull request on the branch the flight built it from, which carries the row id of the
  // job that named it, so a pull request the test gives no branch to is put on its job's branch.
  const namedBy = new Map();
  const setGh = (setup) => {
    const prs = {};
    for (const [url, pr] of Object.entries(setup.prs || {})) {
      prs[url] = pr && !('headRefName' in pr) && namedBy.has(url) ? { ...pr, headRefName: buildBranch(namedBy.get(url)) } : pr;
    }
    const repos = { [repoLink()]: { defaultBranchRef: { name: 'main' } }, ...(setup.repos || {}) };
    fs.writeFileSync(ghSetup, JSON.stringify({ ...setup, prs, repos }));
  };
  const ghCalls = () => (fs.existsSync(ghLog) ? fs.readFileSync(ghLog, 'utf8').split('\n').filter(Boolean) : []);
  const noGh = onlyGit(tools);

  // The usual PATH is the fake gh and the stand-in engines, then the system folders and nothing else this computer has
  // (git and sh are there). withoutGh runs the command on a PATH with no gh at all; fakeGhOnly on a PATH with only the
  // fake gh and git (so a fake that cannot be run is not stepped over for a real one further along the PATH). All three
  // have the stand-in engines.
  const envFor = ({ env = {}, withoutGh = false, fakeGhOnly = false } = {}) => ({
    ...scrubAgentEnv(),
    USER: 'pat',
    HOME: home,
    ATRIS_TASKS_DB: dbPath,
    ...env,
    PATH: withoutGh ? noGh : fakeGhOnly ? `${bin}${path.delimiter}${noGh}` : `${bin}${path.delimiter}/usr/bin${path.delimiter}/bin`,
    ATRIS_SKIP_UPDATE_CHECK: '1',
    NODE_NO_WARNINGS: '1',
  });
  const cli = (args, options = {}) => spawnSync(process.execPath, [CLI, ...args], { cwd: options.cwd || dir, encoding: 'utf8', timeout: 60000, env: envFor(options) });
  const cliAsync = (args, options = {}) => new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd: options.cwd || dir, env: envFor(options), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
  // The real command with its stderr connected to a pipe whose reader is already gone, so any write to stderr fails
  // with EPIPE. The reader is closed before the command has started, so every line it says is lost.
  const cliWithStderrClosed = (args, options = {}) => new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd: options.cwd || dir, env: envFor(options), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.destroy();
    child.on('close', (status, signal) => resolve({ status, signal, stdout }));
  });
  // The real command with its stderr connected to a pipe that is already full and that nobody reads. The pipe is a named
  // pipe (a FIFO) the test holds open for reading and never reads from. It is filled to the last byte through a second end
  // that does not wait, and the command gets a third end opened the ordinary way, so its descriptor 2 waits for room, as a
  // pipe handed down by a parent usually does until Node makes the stream (process.stderr) and sets it to not wait. A write
  // to it before that never returns; after that it fails at once with EAGAIN. A command still running at the limit is
  // killed and the run says so (timedOut), so a command held by the pipe is a failed test and not a suite that hangs.
  const cliWithStderrFull = (args, options = {}) => new Promise((resolve) => {
    const limit = options.limit || 8000;
    const fifo = path.join(tools, 'stderr.fifo');
    assert.equal(spawnSync('mkfifo', [fifo]).status, 0, 'a named pipe can be made');
    const open = [];
    const hold = (flags) => { const fd = fs.openSync(fifo, flags); open.push(fd); return fd; };
    const release = (fd) => { if (open.includes(fd)) { open.splice(open.indexOf(fd), 1); fs.closeSync(fd); } };
    t.after(() => { for (const fd of [...open]) release(fd); });
    const reader = hold(fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    const filler = hold(fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);
    // Large writes first, then smaller ones, until even one byte is refused: full to the last byte, on any system.
    let filled = 0;
    for (const size of [65536, 4096, 512, 1]) {
      const chunk = Buffer.alloc(size, 0x2e);
      for (;;) {
        try { filled += fs.writeSync(filler, chunk); } catch (err) { if (err.code === 'EAGAIN') break; throw err; }
      }
    }
    assert.ok(filled > 0, 'the pipe took some bytes before it was full');
    const handedDown = hold(fs.constants.O_WRONLY);
    const began = Date.now();
    const child = spawn(process.execPath, [CLI, ...args], { cwd: options.cwd || dir, env: envFor(options), stdio: ['ignore', 'pipe', handedDown] });
    release(handedDown);
    release(filler);
    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, limit);
    child.on('close', (status, signal) => {
      clearTimeout(timer);
      release(reader);
      resolve({ status, signal, stdout, timedOut, took: Date.now() - began, filled });
    });
  });

  // Move one job's whole attempt back in time: its claim, its rows and its events.
  const backdate = (id, ms) => {
    db.prepare('UPDATE tasks SET claimed_at = claimed_at - ?, created_at = created_at - ?, updated_at = updated_at - ? WHERE id = ?').run(ms, ms, ms, id);
    db.prepare('UPDATE task_events SET created_at = created_at - ? WHERE task_id = ?').run(ms, id);
  };
  // A job a flight built in a protected lane: claimed three hours ago, then sent to Review with its open
  // pull request and no merge commit.
  const heldJob = (title, number, { builder = 'fleet-codex', root = dir } = {}) => {
    const url = pullAt(number);
    const { id } = tasks.addTask(db, { title, tag: 'feedback', workspaceRoot: root });
    assert.equal(tasks.claimTask(db, { id, claimedBy: builder, leaseMinutes: 60, leasePid: process.pid }).claimed, true);
    const readied = tasks.readyTask(db, { id, actor: builder, proof: 'Built and verified; the pull request waits for a person to land it.', merge: { number: String(number), url } });
    assert.equal(readied.ready, true);
    if (!namedBy.has(url)) namedBy.set(url, id);
    backdate(id, CLAIMED_AGO);
    return id;
  };
  // The one small file this feature keeps, for a workspace: where it is, and what it says.
  const stateFolder = path.join(home, '.atris', 'state', 'held-sweep');
  const records = () => (fs.existsSync(stateFolder) ? fs.readdirSync(stateFolder).filter((name) => name.endsWith('.json')) : []);
  const recordFile = () => path.join(stateFolder, records()[0]);
  // The right to run the check is one more small file beside the time of the last run, there only while a run is under way.
  const locks = () => (fs.existsSync(stateFolder) ? fs.readdirSync(stateFolder).filter((name) => name.endsWith('.lock')) : []);
  const lockFile = () => recordFile().replace(/\.json$/, '.lock');
  const lastRun = () => JSON.parse(fs.readFileSync(recordFile(), 'utf8')).last_run_at;
  const ago = (ms) => {
    const file = recordFile();
    const body = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({ ...body, last_run_at: Date.now() - ms }));
  };
  return { dir, dbPath, db, home, tools, bin, setGh, ghCalls, cli, cliAsync, cliWithStderrClosed, cliWithStderrFull, heldJob, backdate, records, recordFile, locks, lockFile, lastRun, ago, stateFolder, envFor };
}

// Everything the store holds, as plain data, so "changed nothing" can be proved by comparing.
function snapshot(dbPath) {
  const reader = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return JSON.parse(JSON.stringify({
      tasks: reader.prepare('SELECT * FROM tasks ORDER BY id').all(),
      events: reader.prepare('SELECT * FROM task_events ORDER BY task_id, version').all(),
    }));
  } finally {
    reader.close();
  }
}

// Every file under a folder, with what is in it, so "wrote nothing here" can be proved by comparing.
function treeOf(dir) {
  const out = {};
  const walk = (folder) => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) { out[`${path.relative(dir, full)}/`] = ''; walk(full); } else out[path.relative(dir, full)] = fs.readFileSync(full, 'utf8');
    }
  };
  walk(dir);
  return out;
}

const eventsOf = (db, id) => db.prepare('SELECT event_type, actor, payload FROM task_events WHERE task_id = ? ORDER BY version').all(id)
  .map((row) => ({ type: row.event_type, actor: row.actor, payload: row.payload ? JSON.parse(row.payload) : null }));
const completedEvents = (db, id) => eventsOf(db, id).filter((event) => event.type === 'completed');
const seasonOf = (d) => {
  const season = loadSeason(d.dir, { dbPath: d.dbPath, now: Date.now() + 1000, lastSeen: null });
  assert.equal(season.error, undefined);
  return season;
};
const playsOf = (season, id) => season.outcomes.filter((play) => play.task_id === id);
const memberRow = (season, name) => rosterRows({ outcomes: season.outcomes, limit: Number.MAX_SAFE_INTEGER }).find((row) => row.name === name);
const lines = (text) => String(text).split('\n').filter(Boolean);

// ---------------------------------------------------------------------------
// The sweep runs on its own: at the start of atris brief, atris rating and atris gm.

for (const command of [['rating', '--json'], ['brief', '--json'], ['gm', '--json']]) {
  test(`atris ${command[0]} credits a builder whose pull request a person merged, with no command`, (t) => {
    const d = desk(t);
    const first = d.heldJob('Fix the feedback form', 77);
    const second = d.heldJob('Fix the billing page', 78, { builder: 'fleet-cursor' });
    d.setGh({ prs: { [pullAt(77)]: mergedPr(77), [pullAt(78)]: mergedPr(78) } });
    assert.equal(tasks.getTask(d.db, first).status, 'review');

    const run = d.cli(command);

    assert.equal(run.status, 0, run.stderr);
    // The JSON a script reads is untouched: the sweep said nothing on stdout.
    assert.doesNotThrow(() => JSON.parse(run.stdout));
    assert.doesNotMatch(run.stdout, /credited/);
    // One plain line per job, on stderr.
    assert.deepEqual(lines(run.stderr).sort(), ['credited fleet-codex: pull request 77 merged', 'credited fleet-cursor: pull request 78 merged']);
    for (const id of [first, second]) {
      assert.equal(tasks.getTask(d.db, id).status, 'done');
      assert.equal(tasks.getTask(d.db, id).metadata.pull_request.state, 'merged');
      assert.deepEqual(completedEvents(d.db, id).map((event) => event.payload.action), ['merged']);
    }
    assert.deepEqual(d.ghCalls().sort(), [askDefaultBranchCall(), askPullRequestCall(77), askPullRequestCall(78)].sort());
    // The real rating: both builders landed their job.
    const season = seasonOf(d);
    assert.deepEqual(playsOf(season, first).map((play) => play.kind), ['took', 'landed']);
    assert.deepEqual([memberRow(season, 'fleet-codex').landed, memberRow(season, 'fleet-cursor').landed], [1, 1]);
  });
}

// ---------------------------------------------------------------------------
// atris brief prints the owner's screen: what needs a person, and what got done this week. The check runs as a step
// before the screen is read, so the screen shows what the check just did. It is no part of the screen: reading the
// screen asks GitHub nothing and changes no job.

test('atris brief runs the check before it reads the screen: a job it just credited is under Done this week, not under Needs you', (t) => {
  const d = desk(t);
  d.heldJob('Fix the feedback form', 77);
  d.heldJob('Fix the billing page', 78);
  d.setGh({ prs: { [pullAt(77)]: mergedPr(77), [pullAt(78)]: openPr(78) } });
  const titles = (items) => items.map((item) => item.title).sort();
  const without = d.cli(['brief', '--json'], { env: { ATRIS_HELD_SWEEP: 'off' } });
  assert.equal(without.status, 0, without.stderr);
  const before = JSON.parse(without.stdout);
  assert.deepEqual(titles(before.needs_you), ['Fix the billing page', 'Fix the feedback form'], 'without the check, both wait on a person');
  assert.deepEqual(before.done_this_week, []);

  const run = d.cli(['brief', '--json']);

  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(lines(run.stderr), ['credited fleet-codex: pull request 77 merged']);
  const after = JSON.parse(run.stdout);
  assert.deepEqual(titles(after.needs_you), ['Fix the billing page'], 'the merged one no longer waits on a person');
  assert.deepEqual(titles(after.done_this_week), ['Fix the feedback form'], 'it shows as done, the same run that credited it');
  assert.deepEqual(after.team.map((row) => [row.member, row.landed]), [['fleet-codex', 1]]);
});

test('reading the owner screen never runs the check: no question to GitHub, no change to any job', (t) => {
  const d = desk(t);
  d.heldJob('Fix the feedback form', 77);
  d.setGh({ prs: { [pullAt(77)]: mergedPr(77) } });
  const check = t.mock.method(autosweep(), 'autoSweepHeld', () => 'idle');
  const before = snapshot(d.dbPath);

  const data = require('../commands/brief').buildBriefData(d.dir, { owner: true });

  assert.deepEqual(data.needs_you.map((item) => item.title), ['Fix the feedback form']);
  assert.equal(check.mock.callCount(), 0, 'the check is a step before the screen, not a part of reading it');
  assert.deepEqual(d.ghCalls(), []);
  assert.deepEqual(snapshot(d.dbPath), before);
  assert.deepEqual(d.records(), []);
});

test('what atris brief and the README say about the quiet check is true: credit usually comes within the hour, on a command that reaches GitHub, the manual sweep does it right away, and the page only claims to read', (t) => {
  const d = desk(t);
  d.heldJob('Fix the feedback form', 77);
  const brief = require('../commands/brief');

  const help = d.cli(['brief', '--help']);

  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /It reads your jobs\. Before the screen it may quietly check GitHub and credit or release held jobs\s+whose pull request merged or closed\. A merge is usually credited within the hour, by a command that\s+reaches GitHub; atris task sweep --held does it right away\.\s+ATRIS_HELD_SWEEP=off turns that off\./);
  assert.doesNotMatch(help.stdout, /Read only|never changes your jobs/);
  // No exact promise about when a check asks, because each one has an exception: not "at most once an hour", not
  // "the hour starts", not "the next command".
  assert.doesNotMatch(help.stdout, /at most once|the hour starts|next command|checks again/);
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
  assert.match(readme, /When a person merges a builder's pull request, the builder is usually credited within the hour, by an `atris brief`, `atris rating`, `atris gm` or flight that reaches GitHub; `atris task sweep --held` does it right away\. `ATRIS_HELD_SWEEP=off` stops the automatic check\./);
  for (const old of [/the next `atris brief`/, /the first one after the hour/, /a dry run never checks/, /A check starts that hour/, /the next command checks again/, /at most once an hour/, /`atris gm` or flight credits the builder/]) {
    assert.doesNotMatch(readme, old, `the README no longer says ${old}`);
  }
  const page = brief.renderBriefHtml(brief.buildBriefData(d.dir, { owner: true }));
  assert.match(page, /This screen only reads your jobs\./);
  assert.doesNotMatch(page, /Nothing here was changed/);
});

test('a pull request closed without merging lets the claim go, and says so', (t) => {
  const d = desk(t);
  const id = d.heldJob('Fix the feedback form', 78);
  d.setGh({ prs: { [pullAt(78)]: closedPr(78) } });

  const run = d.cli(['rating', '--json']);

  assert.equal(run.status, 0, run.stderr);
  assert.doesNotThrow(() => JSON.parse(run.stdout));
  assert.deepEqual(lines(run.stderr), ['released fleet-codex: pull request 78 closed without merging']);
  const row = tasks.getTask(d.db, id);
  assert.equal(row.status, 'open');
  assert.equal(row.claimed_by, null);
  assert.equal(row.metadata.pull_request.state, 'closed');
  assert.deepEqual(eventsOf(d.db, id).map((event) => event.type), ['created', 'claimed', 'proof_ready', 'claim_released']);
  assert.equal(memberRow(seasonOf(d), 'fleet-codex').dropped, 1, 'the rating counts it as a miss, as the manual sweep does');
});

test('it says nothing when no job moved, and a run that was written down holds off the runs within the hour after it', (t) => {
  const d = desk(t);
  const id = d.heldJob('Fix the feedback form', 77);
  d.setGh({ prs: { [pullAt(77)]: openPr(77) } });
  const before = snapshot(d.dbPath);

  const first = d.cli(['rating', '--json']);

  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stderr, '', 'an open pull request is nothing to report');
  assert.deepEqual(d.ghCalls(), [askPullRequestCall(77)]);
  assert.deepEqual(snapshot(d.dbPath), before, 'the task store is exactly as it was');
  // The commands keep files of their own in the workspace; the time of this run is in none of them.
  for (const [file, body] of Object.entries(treeOf(d.dir))) {
    assert.doesNotMatch(file, /held-sweep/, `${file}`);
    assert.doesNotMatch(body, /last_run_at/, `${file}`);
  }
  // The time of the run is one small file in the CLI's state folder.
  assert.equal(d.records().length, 1);
  assert.ok(Math.abs(d.lastRun() - Date.now()) < 60 * 1000);
  assert.equal(JSON.parse(fs.readFileSync(d.recordFile(), 'utf8')).workspace, d.dir);

  // Fifty-nine minutes later nothing is asked again, by any of the commands.
  d.ago(59 * MINUTE);
  for (const command of [['rating', '--json'], ['brief', '--json'], ['gm', '--json']]) assert.equal(d.cli(command).status, 0);
  assert.equal(d.ghCalls().length, 1, 'still the one question');

  // An hour and a minute later nothing holds it off, and a person has merged the pull request by then.
  d.ago(61 * MINUTE);
  d.setGh({ prs: { [pullAt(77)]: mergedPr(77) } });
  const later = d.cli(['brief', '--json']);
  assert.equal(later.status, 0, later.stderr);
  assert.deepEqual(lines(later.stderr), ['credited fleet-codex: pull request 77 merged']);
  assert.equal(tasks.getTask(d.db, id).status, 'done');
  assert.ok(Math.abs(d.lastRun() - Date.now()) < 60 * 1000, 'and the run is written down again');
});

test('a workspace with no held job never calls GitHub and writes down nothing', (t) => {
  const d = desk(t);
  d.setGh({});
  // Once with no task list at all, once with a task list that holds no job.
  tasks.addTask(d.db, { title: 'Still open', tag: 'feedback', workspaceRoot: d.dir });
  for (const store of [path.join(d.tools, 'nowhere', 'tasks.db'), d.dbPath]) {
    for (const command of [['rating', '--json'], ['brief', '--json'], ['gm', '--json']]) {
      const run = d.cli(command, { env: { ATRIS_TASKS_DB: store } });
      assert.equal(run.status, 0, run.stderr);
      assert.equal(run.stderr, '');
    }
  }
  assert.deepEqual(d.ghCalls(), []);
  assert.deepEqual(d.records(), []);
  assert.equal(fs.existsSync(d.stateFolder), false, 'not even the folder is made');
});

test('jobs that are not held (open, claimed, in review with no pull request, done) never call GitHub', (t) => {
  const d = desk(t);
  tasks.addTask(d.db, { title: 'Still open', tag: 'feedback', workspaceRoot: d.dir });
  const claimed = tasks.addTask(d.db, { title: 'Claimed, not handed in', tag: 'feedback', workspaceRoot: d.dir }).id;
  tasks.claimTask(d.db, { id: claimed, claimedBy: 'fleet-codex', leaseMinutes: 60, leasePid: process.pid });
  const review = tasks.addTask(d.db, { title: 'In review, no pull request', tag: 'feedback', workspaceRoot: d.dir }).id;
  tasks.claimTask(d.db, { id: review, claimedBy: 'fleet-codex', leaseMinutes: 60, leasePid: process.pid });
  tasks.readyTask(d.db, { id: review, actor: 'fleet-codex', proof: 'Built and verified.' });
  const settled = d.heldJob('Already merged', 77);
  d.setGh({ prs: { [pullAt(77)]: mergedPr(77) } });
  // Settle that one by hand, as the manual sweep would, so it is done and no longer held.
  assert.equal(d.cli(['task', 'sweep', '--held', '--as', 'keshav', '--json']).status, 0);
  assert.equal(tasks.getTask(d.db, settled).status, 'done');
  const callsAfterManual = d.ghCalls().length;

  for (const command of [['rating', '--json'], ['brief', '--json'], ['gm', '--json']]) assert.equal(d.cli(command).status, 0);

  assert.equal(d.ghCalls().length, callsAfterManual, 'nothing held, nothing asked');
  assert.deepEqual(d.records(), []);
});

test('ATRIS_HELD_SWEEP=off skips it entirely', (t) => {
  const d = desk(t);
  const id = d.heldJob('Fix the feedback form', 77);
  d.setGh({ prs: { [pullAt(77)]: mergedPr(77) } });
  const before = { row: tasks.getTask(d.db, id), events: eventsOf(d.db, id) };

  for (const command of [['rating', '--json'], ['brief', '--json'], ['gm', '--json']]) {
    const run = d.cli(command, { env: { ATRIS_HELD_SWEEP: 'off' } });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stderr, '');
  }

  assert.deepEqual(d.ghCalls(), []);
  assert.deepEqual(d.records(), []);
  assert.equal(tasks.getTask(d.db, id).status, 'review');
  assert.deepEqual({ row: tasks.getTask(d.db, id), events: eventsOf(d.db, id) }, before, 'the held job is exactly as it was');
});

test('--help never reaches GitHub', (t) => {
  const d = desk(t);
  d.heldJob('Fix the feedback form', 77);
  d.setGh({ prs: { [pullAt(77)]: mergedPr(77) } });
  for (const command of ['rating', 'brief', 'gm']) {
    const run = d.cli([command, '--help']);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stderr, '');
  }
  assert.deepEqual(d.ghCalls(), []);
});

test('only this workspace is swept, never the other workspaces in the same store', (t) => {
  const d = desk(t);
  const other = mkdtemp('auto-sweep-other-');
  t.after(() => fs.rmSync(other, { recursive: true, force: true }));
  fs.mkdirSync(path.join(other, 'atris'));
  gitIn(other, 'init', '-q');
  gitIn(other, 'remote', 'add', 'origin', ORIGIN);
  const mine = d.heldJob('Fix the feedback form', 77);
  const theirs = d.heldJob('Fix the billing page', 78, { root: other });
  d.setGh({ prs: { [pullAt(77)]: mergedPr(77), [pullAt(78)]: mergedPr(78) } });

  const run = d.cli(['rating', '--json']);

  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(lines(run.stderr), ['credited fleet-codex: pull request 77 merged']);
  assert.equal(tasks.getTask(d.db, mine).status, 'done');
  assert.equal(tasks.getTask(d.db, theirs).status, 'review', 'the other workspace is not this command\'s to sweep');
  assert.equal(d.ghCalls().some((call) => call.includes('/pull/78')), false, 'and GitHub was never asked about it');
});

// ---------------------------------------------------------------------------
// The actor: the same name the manual sweep records, so the rating treats both the same.
// (The rating reads any actor with "auto" in its name as an autoland, not a person's merge.)

for (const identity of [{ USER: 'pat' }, { USER: 'pat', ATRIS_AGENT_ID: 'pat-agent' }]) {
  test(`an automatic credit records the same actor as the manual sweep (${Object.keys(identity).join(' and ')})`, (t) => {
    const d = desk(t);
    const env = { ...identity };
    const byHand = d.heldJob('Fix the feedback form', 77);
    d.setGh({ prs: { [pullAt(77)]: mergedPr(77), [pullAt(78)]: mergedPr(78) } });
    assert.equal(d.cli(['task', 'sweep', '--held', '--json'], { env }).status, 0);
    const byItself = d.heldJob('Fix the billing page', 78);
    d.setGh({ prs: { [pullAt(77)]: mergedPr(77), [pullAt(78)]: mergedPr(78) } });

    const run = d.cli(['rating', '--json'], { env });

    assert.equal(run.status, 0, run.stderr);
    const expected = identity.ATRIS_AGENT_ID || identity.USER;
    assert.equal(completedEvents(d.db, byHand)[0].actor, expected, 'the manual sweep, given no --as');
    assert.equal(completedEvents(d.db, byItself)[0].actor, expected, 'the automatic one');
    assert.doesNotMatch(expected, /auto/i);
    const season = seasonOf(d);
    for (const id of [byHand, byItself]) {
      const landed = playsOf(season, id).find((play) => play.kind === 'landed');
      assert.equal(landed.member, 'fleet-codex');
      assert.equal(landed.landed_by, 'you', 'a person\'s merge, whichever sweep wrote it down');
    }
    assert.equal(memberRow(season, 'fleet-codex').landed, 2);
  });
}

// ---------------------------------------------------------------------------
// When gh cannot be used, the command is untouched, nothing is said, nothing is written down, and
// nothing is held off.

const trouble = [
  ['gh is not installed', { withoutGh: true }, {}],
  ['gh is not signed in (it exits 4)', {}, { exits: { [pullAt(77)]: { code: 4, say: 'To get started with GitHub CLI, please run:  gh auth login\nAlternatively, populate the GH_TOKEN environment variable with a GitHub API authentication token.' } } }],
  ['gh says the token is bad (HTTP 401)', {}, { fail: { [pullAt(77)]: 'HTTP 401: Bad credentials (https://api.github.com/graphql)\nTry authenticating with:  gh auth login' } }],
  ['GitHub is down (HTTP 502)', {}, { fail: { [pullAt(77)]: 'HTTP 502: Bad Gateway (https://api.github.com/graphql)' } }],
  ['GitHub cannot be reached', {}, { fail: { [pullAt(77)]: 'error connecting to api.github.com\ncheck your internet connection or https://githubstatus.com' } }],
  ['gh is killed before it answers (SIGKILL)', {}, { kill: 'SIGKILL' }],
  ['gh is stopped before it answers (SIGTERM)', {}, { kill: 'SIGTERM' }],
  ['gh exits 0 and prints nothing', {}, { raw: { [pullAt(77)]: '' } }],
  ['gh exits 0 and prints something that is not a pull request', {}, { raw: { [pullAt(77)]: '{"message":"hello"}' } }],
];
for (const [name, options, setup] of trouble) {
  test(`${name}: skipped quietly and not written down, so nothing is held off`, (t) => {
    const d = desk(t);
    const id = d.heldJob('Fix the feedback form', 77);
    d.setGh({ prs: { [pullAt(77)]: mergedPr(77) }, ...setup });
    const before = snapshot(d.dbPath);
    const control = d.cli(['rating', '--json'], { env: { ATRIS_HELD_SWEEP: 'off' } });

    const run = d.cli(['rating', '--json'], options);

    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stderr, '', 'no outage is worth a line');
    assert.deepEqual(JSON.parse(run.stdout).here, JSON.parse(control.stdout).here, 'the command printed what it prints without the sweep');
    assert.deepEqual(snapshot(d.dbPath), before);
    assert.deepEqual(d.records(), [], 'a run with no readable answer is not a run');
    assert.equal(tasks.getTask(d.db, id).status, 'review');

    // GitHub is back: a following command asks and credits.
    d.setGh({ prs: { [pullAt(77)]: mergedPr(77) } });
    const next = d.cli(['rating', '--json']);
    assert.deepEqual(lines(next.stderr), ['credited fleet-codex: pull request 77 merged']);
    assert.equal(tasks.getTask(d.db, id).status, 'done');
  });
}

test('a gh that never answers holds the command for eight seconds at most, and nothing is held off', (t) => {
  const d = desk(t);
  const id = d.heldJob('Fix the feedback form', 77);
  const second = d.heldJob('Fix the billing page', 78);
  d.setGh({ prs: { [pullAt(77)]: mergedPr(77), [pullAt(78)]: mergedPr(78) }, hangMs: 120000 });
  const started = Date.now();

  const run = d.cli(['rating', '--json']);

  const took = Date.now() - started;
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stderr, '');
  assert.doesNotThrow(() => JSON.parse(run.stdout));
  assert.ok(took < 12000, `took ${took} ms`);
  assert.equal(d.ghCalls().length, 1, 'one timeout is an outage: it stopped asking');
  assert.deepEqual(d.records(), []);
  assert.deepEqual([tasks.getTask(d.db, id).status, tasks.getTask(d.db, second).status], ['review', 'review']);

  d.setGh({ prs: { [pullAt(77)]: mergedPr(77), [pullAt(78)]: mergedPr(78) } });
  const next = d.cli(['rating', '--json']);
  assert.equal(lines(next.stderr).length, 2);
  assert.equal(tasks.getTask(d.db, id).status, 'done');
});

test('a pull request GitHub cannot find is an answer and no outage: the run stays quiet, is written down, and a command within the hour does not ask again', (t) => {
  const d = desk(t);
  const id = d.heldJob('Fix the feedback form', 77);
  d.setGh({ fail: { [pullAt(77)]: notFoundFor(77) } });

  const run = d.cli(['rating', '--json']);

  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stderr, '');
  assert.equal(d.ghCalls().length, 1);
  assert.equal(d.records().length, 1, 'GitHub answered that there is no such pull request, so the run is written down');
  assert.equal(d.cli(['brief', '--json']).status, 0);
  assert.equal(d.ghCalls().length, 1, 'and a command within the hour does not ask again');
  assert.equal(tasks.getTask(d.db, id).status, 'review');
});

// The other side of that, on the real command line: what gh says when it cannot find the pull request's repository, a bare
// 404, the sentence for some other pull request, the sentence inside a longer message, or the sentence with a space in
// front or a blank line behind, is no answer about this pull request, so nothing is written down and nothing is held off.
for (const [name, words] of [
  ['a repository gh cannot read', "GraphQL: Could not resolve to a Repository with the name 'acme/widgets'. (repository)"],
  ['a 404 from the API (HTTP 404)', 'HTTP 404: Not Found (https://api.github.com/repos/acme/widgets/pulls/77)'],
  ['a status that only starts with 404 (HTTP 4040)', 'HTTP 4040: Not Found (https://api.github.com/repos/acme/widgets/pulls/77)'],
  ['the sentence for another pull request number (78, asked about 77)', notFoundFor(78)],
  ['the sentence inside a longer message', `error: ${notFoundFor(77)}`],
  // The fake gh ends what it says with one line break, so the second row ends in two.
  ['the sentence with a space in front of it', ` ${notFoundFor(77)}`],
  ['the sentence with a blank line behind it', `${notFoundFor(77)}\n`],
]) {
  test(`on the real command line, ${name} is no answer: the run stays quiet, nothing is written down, and nothing is held off`, (t) => {
    const d = desk(t);
    const id = d.heldJob('Fix the feedback form', 77);
    d.setGh({ fail: { [pullAt(77)]: words } });

    const run = d.cli(['rating', '--json']);

    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stderr, '');
    assert.equal(d.ghCalls().length, 1);
    assert.deepEqual(d.records(), [], 'GitHub said nothing about the pull request, so the hour does not start');
    assert.equal(d.cli(['brief', '--json']).status, 0);
    assert.equal(d.ghCalls().length, 2, 'and a following command asks again');
    assert.equal(tasks.getTask(d.db, id).status, 'review');
  });
}

test('a merge that is not this job\'s own build is refused by the sweep and the automatic run says nothing', (t) => {
  const d = desk(t);
  const id = d.heldJob('Fix the feedback form', 77);
  d.setGh({ prs: { [pullAt(77)]: mergedPr(77, { headRefName: 'someone-elses-branch' }) } });
  const before = snapshot(d.dbPath);

  const run = d.cli(['rating', '--json']);

  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stderr, '');
  assert.ok(d.ghCalls().includes(askPullRequestCall(77)), 'GitHub was asked, and the sweep refused what it heard');
  assert.deepEqual(snapshot(d.dbPath), before);
  assert.equal(tasks.getTask(d.db, id).status, 'review');
});

// ---------------------------------------------------------------------------
// Never breaking the command it runs inside.

test('a failure of its own costs one short line on stderr and nothing else', (t) => {
  const d = desk(t);
  const id = d.heldJob('Fix the feedback form', 77);
  d.setGh({ prs: { [pullAt(77)]: mergedPr(77) } });
  const control = d.cli(['rating', '--json'], { env: { ATRIS_HELD_SWEEP: 'off' } });
  assert.equal(control.status, 0, control.stderr);
  // The state folder cannot be made: a file sits where its parent folder should be.
  fs.writeFileSync(path.join(d.home, '.atris'), 'not a folder');

  const run = d.cli(['rating', '--json']);

  assert.equal(run.status, control.status);
  assert.deepEqual(JSON.parse(run.stdout).here, JSON.parse(control.stdout).here, 'the command printed what it prints without the sweep');
  assert.match(run.stderr, /^held jobs: automatic check failed \(.{1,140}\)\n$/, 'one short line');
  assert.deepEqual(d.ghCalls(), [], 'a run that cannot be written down does not start, so GitHub is not asked on every command');
  assert.equal(tasks.getTask(d.db, id).status, 'review');
});

// A line the check says goes to stderr on the spot, and a line that cannot be written is lost where it is written. If
// it were handed to the stream instead, a pipe whose reader has gone would raise EPIPE later, outside anything that
// could catch it, and end a command that goes on running (atris gm does) with a different exit code after a job was
// settled. The reader is gone before the command starts, so every line it says is lost. The control is the same
// command with the check off, asked of the store as the run left it; the time a command prints is not compared.
const withoutClock = (value) => JSON.parse(JSON.stringify(value, (key, child) => (key === 'generated_at' || key === 'now' ? undefined : child)));

for (const command of [['rating', '--json'], ['brief', '--json'], ['gm', '--json']]) {
  test(`atris ${command[0]} with stderr a pipe whose reader has gone ends as it does with the check off, and the job is settled`, async (t) => {
    const d = desk(t);
    const id = d.heldJob('Fix the feedback form', 77);
    d.setGh({ prs: { [pullAt(77)]: mergedPr(77) } });
    // A command that sets itself up on its first run (atris gm seeds a first job) has done so before the two runs compared.
    assert.equal(d.cli(command, { env: { ATRIS_HELD_SWEEP: 'off' } }).status, 0);

    const run = await d.cliWithStderrClosed(command);

    assert.equal(tasks.getTask(d.db, id).status, 'done', 'the job was settled, whether or not its line could be said');
    const control = d.cli(command, { env: { ATRIS_HELD_SWEEP: 'off' } });
    assert.equal(control.status, 0, control.stderr);
    assert.equal(run.signal, null);
    assert.equal(run.status, control.status, 'the same exit code');
    assert.deepEqual(withoutClock(JSON.parse(run.stdout)), withoutClock(JSON.parse(control.stdout)), 'the same output');
    assert.equal(d.records().length, 1, 'and the run is written down');
  });
}

// And a pipe that is full and that nobody reads must not hold the command either. The line is written straight to
// descriptor 2, which waits for room on a pipe the parent handed down in the ordinary way, so a command that said its
// line and then waited would keep the command, and the lock beside the time of the run, for as long as nobody read the
// pipe, after the job was settled (the eight seconds bound the waiting on git and GitHub, not a write). So the check
// makes sure Node has made process.stderr first, which sets the descriptor to not wait: a full pipe then costs the line
// and nothing else. (POSIX only: Windows has no named pipes of this kind to fill.) The command is killed at the limit,
// so a command held by the pipe fails the test and does not hang the suite.
for (const command of [['rating', '--json'], ['brief', '--json'], ['gm', '--json']]) {
  test(`atris ${command[0]} with stderr a full pipe nobody reads is not held by the write: it ends as it does with the check off, and the job is settled`, { skip: process.platform === 'win32' }, async (t) => {
    const d = desk(t);
    const id = d.heldJob('Fix the feedback form', 77);
    d.setGh({ prs: { [pullAt(77)]: mergedPr(77) } });
    // A command that sets itself up on its first run (atris gm seeds a first job) has done so before the two runs compared.
    assert.equal(d.cli(command, { env: { ATRIS_HELD_SWEEP: 'off' } }).status, 0);

    const run = await d.cliWithStderrFull(command);

    assert.equal(run.timedOut, false, `the command was still running after ${run.took} ms, held by a full pipe nobody reads`);
    assert.ok(run.took < 8000, `it ended after ${run.took} ms`);
    assert.equal(run.signal, null);
    assert.equal(tasks.getTask(d.db, id).status, 'done', 'the job was settled, whether or not its line could be said');
    const control = d.cli(command, { env: { ATRIS_HELD_SWEEP: 'off' } });
    assert.equal(control.status, 0, control.stderr);
    assert.equal(run.status, control.status, 'the same exit code');
    assert.deepEqual(withoutClock(JSON.parse(run.stdout)), withoutClock(JSON.parse(control.stdout)), 'the same output');
    assert.equal(d.records().length, 1, 'and the run is written down');
    assert.deepEqual(d.locks(), [], 'and the lock beside it is not held');
  });
}

// The same, in the process itself: whatever the write to stderr raises (EPIPE when nobody reads, EAGAIN when the pipe is
// full) is swallowed where the line is written. The line goes to descriptor 2 once and whole, never to the stream, and no
// listener is put on the stream to answer for it.
for (const code of ['EPIPE', 'EAGAIN']) {
  test(`a line that cannot be written (${code}) is lost on the spot: the error stays where it is written, and the run goes on and ends as a run`, (t) => {
    const { d, ids, clock } = inProcess(t, { held: 1 });
    const gh = ghAt(clock, () => mergedPr(71, { headRefName: buildBranch(ids[0]) }));
    const writeSync = fs.writeSync;
    const tried = [];
    t.mock.method(fs, 'writeSync', (fd, data, ...rest) => {
      if (fd !== 2) return writeSync.call(fs, fd, data, ...rest);
      tried.push(String(data));
      throw Object.assign(new Error(`${code}: write failed`), { code, syscall: 'write' });
    });
    const streamed = [];
    t.mock.method(process.stderr, 'write', (chunk) => { streamed.push(String(chunk)); return true; });
    const listeners = process.stderr.listenerCount('error');

    // No `say` is given, so the check says its line the way it does on a real command line.
    const outcome = autosweep().autoSweepHeld({ root: d.dir, env: { HOME: d.home }, now: () => clock.now, run: gh.run });

    assert.equal(outcome, 'ran');
    assert.deepEqual(tried, ['credited fleet-codex: pull request 71 merged\n'], 'the line was written once, whole, to descriptor 2');
    assert.deepEqual(streamed, [], 'and never handed to the stream, whose failure would come later');
    assert.equal(process.stderr.listenerCount('error'), listeners, 'no listener was put on stderr');
    assert.equal(tasks.getTask(d.db, ids[0]).status, 'done', 'the credit stands');
    assert.equal(d.records().length, 1, 'and the run is written down');
  });
}

// A write can go through in part when the pipe has a little room. It is not tried again for the rest: a line on a full
// pipe can be cut short or lost, and that is all it costs.
test('a line the pipe takes only in part is not offered again: the rest is lost with it, and the run goes on', (t) => {
  const { d, ids, clock } = inProcess(t, { held: 1 });
  const gh = ghAt(clock, () => mergedPr(71, { headRefName: buildBranch(ids[0]) }));
  const writeSync = fs.writeSync;
  const tried = [];
  t.mock.method(fs, 'writeSync', (fd, data, ...rest) => {
    if (fd !== 2) return writeSync.call(fs, fd, data, ...rest);
    tried.push(String(data));
    return 10;
  });

  const outcome = autosweep().autoSweepHeld({ root: d.dir, env: { HOME: d.home }, now: () => clock.now, run: gh.run });

  assert.equal(outcome, 'ran');
  assert.deepEqual(tried, ['credited fleet-codex: pull request 71 merged\n'], 'written once, and the part the pipe did not take is not offered again');
  assert.equal(tasks.getTask(d.db, ids[0]).status, 'done', 'the credit stands');
  assert.equal(d.records().length, 1, 'and the run is written down');
});

test('a failure after the check ran still says what it did, then the one short line', (t) => {
  const { d, ids, clock, said, sweep } = inProcess(t, { held: 1 });
  const gh = ghAt(clock, () => mergedPr(71, { headRefName: buildBranch(ids[0]) }));
  // Midway the state folder turns into a file, so the time of the run cannot be written down.
  const breaking = (command, args, options) => {
    fs.rmSync(d.stateFolder, { recursive: true, force: true });
    fs.writeFileSync(d.stateFolder, 'not a folder');
    return gh.run(command, args, options);
  };

  assert.equal(sweep(breaking), 'failed');

  assert.equal(tasks.getTask(d.db, ids[0]).status, 'done', 'the credit stands');
  assert.equal(said.length, 2);
  assert.equal(said[0], 'credited fleet-codex: pull request 71 merged');
  assert.match(said[1], /^held jobs: automatic check failed \(.{1,140}\)$/);
  assert.equal(fs.statSync(d.stateFolder).isFile(), true, 'and no record was made');
});

// ---------------------------------------------------------------------------
// Two commands that start together.

test('commands that start together ask GitHub once between them, and the ones that cannot take the check skip it quietly', async (t) => {
  const d = desk(t);
  const id = d.heldJob('Fix the feedback form', 77);
  // Each question takes a moment, so the other commands start while the first is still asking.
  d.setGh({ prs: { [pullAt(77)]: mergedPr(77) }, hangMs: 1200 });

  const runs = await Promise.all(['rating', 'brief', 'rating', 'brief'].map((name) => d.cliAsync([name, '--json'])));

  for (const run of runs) {
    assert.equal(run.status, 0, run.stderr);
    assert.doesNotThrow(() => JSON.parse(run.stdout));
  }
  assert.deepEqual(d.ghCalls().sort(), [askDefaultBranchCall(), askPullRequestCall(77)].sort(), 'one run asked, the others did not');
  assert.deepEqual(runs.flatMap((run) => lines(run.stderr)), ['credited fleet-codex: pull request 77 merged'], 'and said once');
  assert.deepEqual(completedEvents(d.db, id).map((event) => event.payload.action), ['merged'], 'one landing on file');
  assert.equal(d.records().length, 1);
  assert.deepEqual(d.locks(), [], 'and the check is let go');
});

// A manual sweep takes no lock, so it can be asking at the same moment as an automatic run. Both ask; only one can write.
test('an automatic run and a manual sweep racing for one merge credit the builder once', async (t) => {
  const d = desk(t);
  const id = d.heldJob('Fix the feedback form', 77);
  // Each run's first question waits until both have asked, so neither can have written anything yet.
  d.setGh({ prs: { [pullAt(77)]: mergedPr(77) }, rendezvous: 2 });

  const [auto, byHand] = await Promise.all([d.cliAsync(['rating', '--json']), d.cliAsync(['task', 'sweep', '--held', '--as', 'keshav', '--json'])]);

  for (const run of [auto, byHand]) assert.equal(run.status, 0, run.stderr);
  assert.ok(d.ghCalls().filter((call) => call.startsWith('pr view')).length >= 2, 'both asked before either wrote');
  assert.deepEqual(completedEvents(d.db, id).map((event) => event.payload.action), ['merged'], 'one landing on file');
  assert.equal(tasks.getTask(d.db, id).status, 'done');
  const season = seasonOf(d);
  assert.deepEqual(playsOf(season, id).map((play) => play.kind), ['took', 'landed']);
  assert.equal(memberRow(season, 'fleet-codex').landed, 1);
  // Said once: by the automatic run if it wrote the landing, in the manual report if that did.
  assert.equal(lines(auto.stderr).length + JSON.parse(byHand.stdout).summary.landed, 1);
});

// The manual sweep finishes while an automatic run waits on GitHub: once on the pull request question, before the run has
// looked at the store again, and once on the default branch question, after the run has checked that no other job has the
// pull request and only the write is left.
for (const waiting of ['pr', 'repo']) {
  test(`a manual sweep that finishes while a run waits on GitHub's ${waiting === 'pr' ? 'pull request' : 'default branch'} answer leaves it nothing to credit`, (t) => {
    const { d, ids, clock, said, sweep } = inProcess(t, { held: 1 });
    const { askGitHub, askDefaultBranch, sweepHeldJobs } = require('../lib/held-pull-requests');
    const merged = () => mergedPr(71, { headRefName: buildBranch(ids[0]) });
    const handGh = ghAt(clock, merged);
    const byHand = () => sweepHeldJobs(tasks, d.db, {
      workspaceRoot: d.dir,
      actor: 'keshav',
      ask: (url) => askGitHub(url, { run: handGh.run }),
      askBranch: (link) => askDefaultBranch(link, { run: handGh.run }),
    });
    let inner = null;
    const first = ghAt(clock, (args) => {
      if (args[0] === waiting && !inner) inner = byHand();
      return merged();
    });

    assert.equal(sweep(first.run), 'ran');

    assert.equal(inner.summary.landed, 1, 'the manual sweep credited the builder while the run waited');
    assert.equal(first.calls.some((call) => call.args[0] === waiting), true);
    assert.equal(tasks.getTask(d.db, ids[0]).status, 'done');
    assert.deepEqual(completedEvents(d.db, ids[0]).map((event) => event.payload.action), ['merged'], 'one landing on file');
    assert.deepEqual(said, [], 'the run found nothing left to do and said nothing');
    assert.deepEqual(playsOf(seasonOf(d), ids[0]).map((play) => play.kind), ['took', 'landed']);
  });
}

// ---------------------------------------------------------------------------
// The check itself, in the process, with the clock and gh in the test's hands.

// gh as a function: `answers` maps a pull request link to what `pr view` prints, a failure, or a function. An answer
// with a signal is a gh that was stopped by that signal before it said anything (no launch error, no exit status);
// one with raw is a gh that exited 0 and printed exactly that text.
// The check runs git through the same function, so a git call is answered by the real git unless `git` says
// otherwise; the calls to gh and to git are written down apart, each with the time limit it was given.
function ghAt(clock, answers, { cost = 0, git = null, gitCost = 0 } = {}) {
  const calls = [];
  const gitCalls = [];
  const run = (command, args, options) => {
    if (command === 'git') {
      gitCalls.push({ args, timeout: options.timeout });
      clock.now += gitCost;
      return git ? git(args) : spawnSync(command, args, options);
    }
    calls.push({ command, args, timeout: options.timeout });
    clock.now += cost;
    const url = args[2];
    const answer = typeof answers === 'function' ? answers(args) : answers[url];
    if (answer && answer.say !== undefined) return { status: answer.status, stdout: '', stderr: answer.say };
    if (answer && answer.error) return { error: answer.error, status: null, signal: 'SIGKILL', stdout: '', stderr: '' };
    if (answer && answer.signal) return { status: null, signal: answer.signal, stdout: '', stderr: '' };
    if (answer && answer.raw !== undefined) return { status: 0, stdout: answer.raw, stderr: '' };
    if (args[0] === 'repo') return { status: 0, stdout: JSON.stringify({ defaultBranchRef: { name: 'main' } }), stderr: '' };
    return { status: 0, stdout: JSON.stringify(answer), stderr: '' };
  };
  return { run, calls, gitCalls };
}

// A second checkout of the workspace's repository, linked to it with `git worktree add`, as the one a flight's builder
// works in. The task list of the workspace covers it, and finding that out is a call to git.
function linkedCheckout(dir, name = 'side') {
  gitIn(dir, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '--allow-empty', '-q', '-m', 'first');
  const linked = path.join(path.dirname(dir), name);
  gitIn(dir, 'worktree', 'add', '-q', linked, '-b', name);
  return real(linked);
}

// Writes down each call to git for a workspace's linked checkouts (`git worktree list`, the one call the task list makes
// to git), with the folder it was made in and the limits it was given, and lets the real git answer. With `failFirst`, the first call fails with that
// error instead.
function watchWorktreeLookups(t, { failFirst = null } = {}) {
  const childProcess = require('node:child_process');
  const answer = childProcess.execFileSync;
  const calls = [];
  t.mock.method(childProcess, 'execFileSync', (file, args, options) => {
    if (file === 'git' && Array.isArray(args) && args[0] === 'worktree') {
      calls.push({ args, cwd: options && options.cwd, timeout: options && options.timeout, killSignal: options && options.killSignal });
      if (failFirst && calls.length === 1) throw failFirst;
    }
    return answer(file, args, options);
  });
  return calls;
}

// A git that answers everything as the real one does, except `git worktree ...`: that it takes holdMs over, and when it
// is asked to stop it does not (it ignores the polite stop, so only a kill ends it). It sits first in the desk's bin
// folder, so the commands the desk runs find it; with `here` it is first on this process's PATH too. Each call it was
// asked for is written down.
function hangingGit(t, d, { holdMs = 20000, here = false } = {}) {
  let realGit = null;
  for (const entry of String(process.env.PATH || '').split(path.delimiter)) {
    const candidate = path.join(entry, 'git');
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      realGit = candidate;
      break;
    } catch { /* keep looking */ }
  }
  assert.ok(realGit, 'there is a git on the PATH');
  const log = path.join(d.tools, 'worktree-calls.log');
  fs.writeFileSync(path.join(d.bin, 'git'), `#!${process.execPath}
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
if (args[0] === 'worktree') {
  fs.appendFileSync(${JSON.stringify(log)}, args.join(' ') + '\\n');
  process.on('SIGTERM', () => {});
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${holdMs});
  process.exit(0);
}
const done = spawnSync(${JSON.stringify(realGit)}, args, { stdio: 'inherit' });
process.exit(done.status === null ? 1 : done.status);
`, { mode: 0o755 });
  if (here) {
    const saved = process.env.PATH;
    process.env.PATH = `${d.bin}${path.delimiter}${saved}`;
    t.after(() => { process.env.PATH = saved; });
  }
  return { calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : []) };
}

// A desk with `held` jobs waiting on pull requests 71, 72, ... in that order, the first the oldest (the check goes
// through them oldest first), and the check itself in the test's hands. With `linked`, the jobs are held in a second
// checkout linked to the workspace (returned as `side`), so that finding them takes the call to git for the linked
// checkouts, and the workspace's own folder has not been looked at when the check starts.
function inProcess(t, { held = 3, linked = false } = {}) {
  const d = desk(t);
  const side = linked ? linkedCheckout(d.dir) : null;
  const ids = [];
  for (let n = 1; n <= held; n += 1) ids.push(d.heldJob(`Job ${n}`, 70 + n, side ? { root: side } : {}));
  ids.forEach((id, index) => d.backdate(id, (held - 1 - index) * 1000));
  const clock = { now: Date.now() };
  const said = [];
  const sweep = (run, extra = {}) => autosweep().autoSweepHeld({ root: d.dir, env: { HOME: d.home }, now: () => clock.now, run, say: (line) => said.push(line), ...extra });
  return { d, ids, clock, said, sweep, side };
}

test('every question to gh has a short time limit, and the whole check has a limit too', (t) => {
  const { d, clock, said, sweep } = inProcess(t, { held: 5 });
  // Every question takes three seconds: slow, but inside its own limit.
  const gh = ghAt(clock, (args) => openPr(Number(/\/pull\/(\d+)$/.exec(args[2])[1])), { cost: 3000 });

  const outcome = sweep(gh.run);

  assert.equal(outcome, 'ran');
  assert.ok(gh.calls.length >= 1 && gh.calls.length < 5, `asked ${gh.calls.length} of 5`);
  for (const call of gh.calls) assert.ok(call.timeout > 0 && call.timeout <= 4000, `limit ${call.timeout} ms`);
  assert.equal(gh.calls.at(-1).timeout < 4000, true, 'the last question gets only the time that is left');
  assert.deepEqual(said, []);
  // Running out of time is not GitHub being down: the run is written down, and the rest are left as they are.
  assert.equal(d.records().length, 1);
});

test('a question that times out stops the run: one call, no line, no record', (t) => {
  const { d, clock, said, sweep } = inProcess(t);
  const gh = ghAt(clock, () => ({ error: Object.assign(new Error('spawnSync gh ETIMEDOUT'), { code: 'ETIMEDOUT' }) }));

  assert.equal(sweep(gh.run), 'blocked');

  assert.equal(gh.calls.length, 1);
  assert.deepEqual(said, []);
  assert.deepEqual(d.records(), []);
});

for (const [name, answer] of [
  ['sign in first (exit 4)', { status: 4, say: 'To get started with GitHub CLI, please run:  gh auth login' }],
  ['a bad token', { status: 1, say: 'HTTP 401: Bad credentials (https://api.github.com/graphql)' }],
  ['a bad gateway', { status: 1, say: 'HTTP 502: Bad Gateway (https://api.github.com/graphql)' }],
  ['no network', { status: 1, say: 'Post "https://api.github.com/graphql": dial tcp: lookup api.github.com: no such host' }],
]) {
  test(`gh saying ${name} stops the run after one call without a line or a record`, (t) => {
    const { d, clock, said, sweep } = inProcess(t);
    const gh = ghAt(clock, () => answer);

    assert.equal(sweep(gh.run), 'blocked');

    assert.equal(gh.calls.length, 1, 'the other jobs were not asked');
    assert.deepEqual(said, []);
    assert.deepEqual(d.records(), []);
  });
}

test('a pull request GitHub cannot find does not stop the other jobs from being asked, and is an answer', (t) => {
  const { d, clock, said, sweep } = inProcess(t);
  const gh = ghAt(clock, (args) => ({ status: 1, say: notFoundFor(numberOf(args)) }));

  assert.equal(sweep(gh.run), 'ran');

  assert.equal(gh.calls.length, 3);
  assert.deepEqual(said, []);
  assert.equal(d.records().length, 1, 'GitHub answered for every one of them, so the run is written down');
  assert.equal(sweep(gh.run), 'recent');
  assert.equal(gh.calls.length, 3, 'and nothing is asked again in the hour');
});

// GitHub saying there is no such pull request is an answer, in the one way gh says it: its whole message "Could not resolve
// to a PullRequest with the number of N", for the very N asked about, which GitHub says only once the repository itself
// resolved. The whole error output counts, less the one line break gh ends it with ("\n", or "\r\n" where lines end that
// way), and with that break or with none. Nothing else is: not a 404 (GitHub answers 404 for a repository the token
// cannot read as well), not the sentence for another number, not the sentence inside a longer message, not a failure
// with other words or none, and not the sentence with anything else around it, a space or a blank line in front, a
// second line break or spaces behind. Those say nothing about this pull request, and nothing is held off.
for (const [name, words] of [
  ['as gh prints it', notFoundFor(71)],
  ['with the line break gh ends it with', `${notFoundFor(71)}\n`],
  ['with a carriage return and a line break at the end', `${notFoundFor(71)}\r\n`],
]) {
  test(`GitHub saying there is no such pull request (${name}) is a run`, (t) => {
    const { d, clock, sweep } = inProcess(t, { held: 1 });
    const gh = ghAt(clock, () => ({ status: 1, say: words }));

    assert.equal(sweep(gh.run), 'ran');

    assert.equal(gh.calls.length, 1);
    assert.equal(d.records().length, 1);
  });
}

for (const [name, answer] of [
  ['a repository it cannot read', { status: 1, say: "GraphQL: Could not resolve to a Repository with the name 'acme/widgets'. (repository)" }],
  ['a 404 from the API (HTTP 404)', { status: 1, say: 'HTTP 404: Not Found (https://api.github.com/repos/acme/widgets/pulls/71)' }],
  ['a 404 as newer gh words it', { status: 1, say: 'gh: Not Found (HTTP 404)' }],
  ['a status that only starts with 404 (HTTP 4040)', { status: 1, say: 'HTTP 4040: Not Found (https://api.github.com/repos/acme/widgets/pulls/71)' }],
  ['the sentence for a pull request without its number', { status: 1, say: 'GraphQL: Could not resolve to a PullRequest.' }],
  ['the sentence worded another way (GraphQL error: in front, no path behind)', { status: 1, say: 'GraphQL error: Could not resolve to a PullRequest with the number of 71.' }],
  ['the sentence for another pull request number (72, asked about 71)', { status: 1, say: notFoundFor(72) }],
  ['the sentence for a number that only starts like the one asked about (711, asked about 71)', { status: 1, say: notFoundFor(711) }],
  ['the sentence for a number the one asked about starts with (7, asked about 71)', { status: 1, say: notFoundFor(7) }],
  ['the sentence after other words on the same line', { status: 1, say: `error: ${notFoundFor(71)}` }],
  ['the sentence with another error after it', { status: 1, say: `${notFoundFor(71)}, Something unrelated went wrong (repository)` }],
  ['the sentence on a line after another line', { status: 1, say: `Something unrelated happened first\n${notFoundFor(71)}` }],
  ['the sentence on a line before another line', { status: 1, say: `${notFoundFor(71)}\nSomething unrelated happened after` }],
  // Only the one line break at the end is let go. Anything else around the sentence makes it some other reply.
  ['the sentence with a space in front of it', { status: 1, say: ` ${notFoundFor(71)}` }],
  ['the sentence with a space in front of it and its line break behind', { status: 1, say: ` ${notFoundFor(71)}\n` }],
  ['the sentence with a blank line in front of it', { status: 1, say: `\n${notFoundFor(71)}\n` }],
  ['the sentence with two line breaks behind it', { status: 1, say: `${notFoundFor(71)}\n\n` }],
  ['the sentence with two carriage return and line breaks behind it', { status: 1, say: `${notFoundFor(71)}\r\n\r\n` }],
  ['the sentence with spaces behind it', { status: 1, say: `${notFoundFor(71)}   ` }],
  ['the sentence with spaces between it and its line break', { status: 1, say: `${notFoundFor(71)}  \n` }],
  ['the sentence with spaces behind its line break', { status: 1, say: `${notFoundFor(71)}\n  ` }],
  ['the sentence with a carriage return and no line break behind it', { status: 1, say: `${notFoundFor(71)}\r` }],
  ['a failure with no words', { status: 1, say: '' }],
  ['words it has not shown before', { status: 1, say: 'GraphQL: Something went wrong while executing your query.' }],
  ['a refusal for the token (HTTP 403)', { status: 1, say: 'HTTP 403: Resource not accessible by personal access token (https://api.github.com/graphql)' }],
  ['the words on the error output of a gh that exited 0 and printed nothing', { status: 0, say: notFoundFor(71) }],
  ['the words printed as an ordinary reply (exit 0)', { raw: notFoundFor(71) }],
]) {
  test(`${name} is not GitHub saying there is no such pull request: nothing is written down and nothing is held off`, (t) => {
    const { d, ids, clock, sweep } = inProcess(t, { held: 1 });
    const gh = ghAt(clock, () => answer);

    assert.equal(sweep(gh.run), 'idle');
    assert.deepEqual(d.records(), []);

    const next = ghAt(clock, mergedFor(ids));
    assert.equal(sweep(next.run), 'ran', 'a following run asks, and credits');
    assert.equal(tasks.getTask(d.db, ids[0]).status, 'done');
  });
}

test('a reply that says there is no such pull request is written down as a run, and an empty reply is not', (t) => {
  const { d, clock, sweep } = inProcess(t, { held: 1 });
  const empty = ghAt(clock, () => ({ raw: '' }));
  const missing = ghAt(clock, () => ({ status: 1, say: notFoundFor(71) }));

  assert.equal(sweep(empty.run), 'idle', 'gh exited 0 and printed nothing');
  assert.deepEqual(d.records(), [], 'an empty reply is no answer');

  assert.equal(sweep(missing.run), 'ran', 'GitHub said there is no such pull request');
  assert.equal(d.records().length, 1, 'that is an answer');

  assert.equal(sweep(missing.run), 'recent');
  assert.equal(missing.calls.length, 1, 'and it is not asked again in the hour');
});

test('the hour is counted from the last run, a clock set back does not stall it, and the opt-out wins', (t) => {
  const { d, clock, sweep } = inProcess(t, { held: 1 });
  const gh = ghAt(clock, () => openPr(71));

  assert.equal(sweep(gh.run), 'ran');
  assert.equal(sweep(gh.run), 'recent');
  clock.now += 59 * MINUTE;
  assert.equal(sweep(gh.run), 'recent');
  clock.now += 2 * MINUTE;
  assert.equal(sweep(gh.run), 'ran');
  assert.equal(gh.calls.length, 2);

  // A record from the future (the clock was set back) does not hold the sweep off for the hour.
  fs.writeFileSync(d.recordFile(), JSON.stringify({ last_run_at: clock.now + 5 * HOUR }));
  assert.equal(sweep(gh.run), 'ran');
  assert.equal(gh.calls.length, 3);

  // Off means off, however the switch is spelled, and it is the first thing looked at.
  for (const off of ['off', 'OFF', ' off ', '0', 'false', 'no']) assert.equal(sweep(gh.run, { env: { HOME: d.home, ATRIS_HELD_SWEEP: off } }), 'off');
  assert.equal(gh.calls.length, 3);
});

test('each workspace has its own hour', (t) => {
  const { d, clock, sweep } = inProcess(t, { held: 1 });
  const gh = ghAt(clock, () => openPr(71));
  assert.equal(sweep(gh.run), 'ran');

  const other = mkdtemp('auto-sweep-other-');
  t.after(() => fs.rmSync(other, { recursive: true, force: true }));
  fs.mkdirSync(path.join(other, 'atris'));
  gitIn(other, 'init', '-q');
  gitIn(other, 'remote', 'add', 'origin', ORIGIN);
  const url = pullAt(99);
  const { id } = tasks.addTask(d.db, { title: 'Elsewhere', tag: 'feedback', workspaceRoot: other });
  tasks.claimTask(d.db, { id, claimedBy: 'fleet-codex', leaseMinutes: 60, leasePid: process.pid });
  tasks.readyTask(d.db, { id, actor: 'fleet-codex', proof: 'Built and verified.', merge: { number: '99', url } });
  const elsewhere = ghAt(clock, () => openPr(99));

  assert.equal(autosweep().autoSweepHeld({ root: other, env: { HOME: d.home }, now: () => clock.now, run: elsewhere.run, say: () => {} }), 'ran');
  assert.equal(elsewhere.calls.length, 1);
  assert.equal(d.records().length, 2);
  assert.equal(sweep(gh.run), 'recent');
});

// ---------------------------------------------------------------------------
// Eight seconds bound the waiting, not the whole run: they are counted from the start, cover git and GitHub, and the run
// stops asking once they are used up. A locked task store is given up on after about a second of its own.

// Another process that takes the task store's write lock when told to and keeps it for holdMs (or until it is
// let go), the way a long write by some other command would.
function storeLocker(t, dbPath, { holdMs = 7000 } = {}) {
  const dir = mkdtemp('auto-sweep-locker-');
  const go = path.join(dir, 'go');
  const locked = path.join(dir, 'locked');
  const script = path.join(dir, 'locker.js');
  fs.writeFileSync(script, `
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const [dbPath, go, locked, holdMs] = process.argv.slice(2);
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
while (!fs.existsSync(go)) sleep(10);
const db = new DatabaseSync(dbPath);
db.exec('PRAGMA busy_timeout = 10000');
db.exec('BEGIN IMMEDIATE');
fs.writeFileSync(locked, '');
sleep(Number(holdMs));
db.exec('COMMIT');
`);
  const child = spawn(process.execPath, [script, dbPath, go, locked, String(holdMs)], { stdio: 'ignore', env: { ...process.env, NODE_NO_WARNINGS: '1' } });
  const exited = new Promise((resolve) => child.on('close', resolve));
  const release = async () => { child.kill('SIGKILL'); await exited; };
  t.after(async () => { await release(); fs.rmSync(dir, { recursive: true, force: true }); });
  return {
    // Takes the lock now and returns once it is held.
    lock() {
      fs.writeFileSync(go, '');
      const until = Date.now() + 15000;
      while (!fs.existsSync(locked)) {
        if (Date.now() > until) throw new Error('the other process never took the lock');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    },
    release,
  };
}

const numberOf = (args) => Number(/\/pull\/(\d+)$/.exec(args[2])[1]);
// Every pull request merged, on the branch of the job (71 is the first job, 72 the second, ...) that named it.
const mergedFor = (ids) => (args) => (args[0] === 'pr' ? mergedPr(numberOf(args), { headRefName: buildBranch(ids[numberOf(args) - 71]) }) : null);
const busy = () => Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR', errcode: 5 });

test('a task store another process holds locked is given up on after a moment: nothing asked, said or written down, and nothing is held off', async (t) => {
  const { d, clock, said, sweep } = inProcess(t, { held: 1 });
  const gh = ghAt(clock, () => openPr(71));
  const locker = storeLocker(t, d.dbPath);
  locker.lock();
  const started = Date.now();

  const outcome = sweep(gh.run);

  const took = Date.now() - started;
  assert.equal(outcome, 'blocked');
  assert.ok(took < 5000, `waited ${took} ms for the store`);
  assert.equal(gh.calls.length, 0, 'GitHub was not asked: with the store locked there was nothing to do with an answer');
  assert.deepEqual(said, []);
  assert.deepEqual(d.records(), [], 'a run that could not get to the store is not a run');
  assert.deepEqual(d.locks(), [], 'and the check is let go');

  await locker.release();
  assert.equal(sweep(gh.run), 'ran', 'a following run goes on');
  assert.equal(gh.calls.length, 1);
});

test('a store opened with a short wait is a connection of its own, leaves the cached one alone, and gives up on a locked store', async (t) => {
  const d = desk(t);
  const cached = tasks.open(d.dbPath);
  const mine = tasks.open(d.dbPath, { shortWait: true });
  assert.notEqual(mine, cached);
  assert.equal(tasks.open(d.dbPath), cached, 'the cached connection is still the one everything else gets');
  mine.close();
  assert.doesNotThrow(() => cached.prepare('SELECT 1').get(), 'and closing the short one leaves it open');

  const locker = storeLocker(t, d.dbPath);
  locker.lock();
  const started = Date.now();
  assert.throws(() => tasks.open(d.dbPath, { shortWait: true }), (err) => tasks.isBusyError(err));
  assert.ok(Date.now() - started < 3000, `waited ${Date.now() - started} ms`);
  await locker.release();
  assert.doesNotThrow(() => tasks.open(d.dbPath, { shortWait: true }).close(), 'the next one opens');
});

test('a store that turns busy while the run waits on GitHub is given up on after a moment: the credit is left for a later run', async (t) => {
  const { d, ids, clock, said, sweep } = inProcess(t, { held: 1 });
  const locker = storeLocker(t, d.dbPath);
  // The store is free when the run starts, and another process takes it while GitHub is answering.
  const gh = ghAt(clock, (args) => {
    if (args[0] === 'pr') locker.lock();
    return mergedFor(ids)(args);
  });
  const started = Date.now();

  const outcome = sweep(gh.run);

  const took = Date.now() - started;
  assert.equal(outcome, 'blocked');
  assert.ok(took < 6000, `waited ${took} ms for the store`);
  assert.deepEqual(said, [], 'a store that is busy is not worth a line');
  assert.deepEqual(d.records(), []);
  assert.deepEqual(d.locks(), []);
  assert.equal(tasks.getTask(d.db, ids[0]).status, 'review');

  await locker.release();
  assert.equal(sweep(ghAt(clock, mergedFor(ids)).run), 'ran');
  assert.deepEqual(said, ['credited fleet-codex: pull request 71 merged']);
  assert.equal(tasks.getTask(d.db, ids[0]).status, 'done');
});

test('git has a short limit of its own, and a git that cannot answer stops the run like a gh that cannot, even after GitHub has answered', (t) => {
  const { d, ids, clock, said, sweep } = inProcess(t, { held: 1 });
  const hung = { error: Object.assign(new Error('spawnSync git ETIMEDOUT'), { code: 'ETIMEDOUT' }), status: null, signal: 'SIGKILL', stdout: '', stderr: '' };
  const gh = ghAt(clock, mergedFor(ids), { git: () => hung });

  assert.equal(sweep(gh.run), 'blocked');

  assert.equal(gh.gitCalls.length, 1);
  assert.ok(gh.gitCalls[0].timeout > 0 && gh.gitCalls[0].timeout <= 2000, `limit ${gh.gitCalls[0].timeout} ms`);
  assert.deepEqual(said, []);
  assert.deepEqual(d.records(), [], 'GitHub had answered, but a run that could not read the origin failed, so it is not written down');
  assert.equal(tasks.getTask(d.db, ids[0]).status, 'review');
});

test('git is asked inside the time that is left of the eight seconds', (t) => {
  const { ids, clock, said, sweep } = inProcess(t, { held: 1 });
  // The pull request question takes 6.5 seconds of the 8, so 1.5 are left for git and the default branch.
  const gh = ghAt(clock, mergedFor(ids), { cost: 6500 });

  assert.equal(sweep(gh.run), 'ran');

  assert.equal(gh.gitCalls.length, 1);
  assert.equal(gh.gitCalls[0].timeout, 1500);
  assert.deepEqual(said, ['credited fleet-codex: pull request 71 merged']);
});

test('the eight seconds count what git took: with too little left the default branch is not asked and the job is left for a later run', (t) => {
  const { d, ids, clock, said, sweep } = inProcess(t, { held: 1 });
  const gh = ghAt(clock, mergedFor(ids), { gitCost: 7000 });

  assert.equal(sweep(gh.run), 'ran');

  assert.equal(gh.calls.filter((call) => call.args[0] === 'repo').length, 0, 'with a second left, the default branch was not asked');
  assert.deepEqual(said, []);
  assert.equal(tasks.getTask(d.db, ids[0]).status, 'review');
});

// ---------------------------------------------------------------------------
// A git that runs but exits with an error has not answered, any more than one that hangs or cannot be run: any exit
// but 0 stops the run, and a run that was stopped is not written down.

for (const [name, heard] of [
  ['cannot be found (exit 127)', { status: 127, signal: null, stdout: '', stderr: 'git: command not found' }],
  ['cannot read the folder (exit 128)', { status: 128, signal: null, stdout: '', stderr: 'fatal: cannot change to the workspace' }],
  ['finds no origin remote (exit 2)', { status: 2, signal: null, stdout: '', stderr: "error: No such remote 'origin'" }],
  ['is stopped by a signal', { status: null, signal: 'SIGSEGV', stdout: '', stderr: '' }],
]) {
  test(`a git that ${name} has not answered: the run stops after one call, nothing is said or written down, and nothing is held off`, (t) => {
    const { d, ids, clock, said, sweep } = inProcess(t, { held: 1 });
    const gh = ghAt(clock, mergedFor(ids), { git: () => heard });

    assert.equal(sweep(gh.run), 'blocked');

    assert.equal(gh.gitCalls.length, 1);
    assert.deepEqual(said, []);
    assert.deepEqual(d.records(), [], 'GitHub had answered, but a run that could not read the origin failed, so it is not written down');
    assert.deepEqual(d.locks(), []);
    assert.equal(tasks.getTask(d.db, ids[0]).status, 'review');

    // A following run, with a git that answers, asks again and credits the builder.
    assert.equal(sweep(ghAt(clock, mergedFor(ids)).run), 'ran');
    assert.deepEqual(said, ['credited fleet-codex: pull request 71 merged']);
    assert.equal(tasks.getTask(d.db, ids[0]).status, 'done');
  });
}

// ---------------------------------------------------------------------------
// Which checkouts are the workspace's: its task list covers the ones linked to it with `git worktree`, and telling
// them is a call to git. The run makes that call only when some job is held somewhere, inside what is left of its
// total, and ends it outright when it does not answer.

test('with no job held anywhere, git is not asked for the linked checkouts at all', (t) => {
  const { d, clock, said, sweep, side } = inProcess(t, { held: 0, linked: true });
  tasks.addTask(d.db, { title: 'Still open', tag: 'feedback', workspaceRoot: side });
  const lookups = watchWorktreeLookups(t);
  const gh = ghAt(clock, () => openPr(71));

  assert.equal(sweep(gh.run), 'idle');

  assert.deepEqual(lookups, [], 'no call to git');
  assert.equal(gh.calls.length, 0);
  assert.deepEqual(said, []);
  assert.deepEqual(d.records(), []);
});

test('a job held in some other workspace only is no reason to take the check: nothing is made and nothing is asked', (t) => {
  const { d, clock, said, sweep } = inProcess(t, { held: 0, linked: true });
  const other = mkdtemp('auto-sweep-other-');
  t.after(() => fs.rmSync(other, { recursive: true, force: true }));
  fs.mkdirSync(path.join(other, 'atris'));
  gitIn(other, 'init', '-q');
  gitIn(other, 'remote', 'add', 'origin', ORIGIN);
  d.heldJob('Elsewhere', 99, { root: other });
  const gh = ghAt(clock, () => openPr(99));

  assert.equal(sweep(gh.run), 'idle');

  assert.equal(gh.calls.length, 0);
  assert.deepEqual(said, []);
  assert.equal(fs.existsSync(d.stateFolder), false, 'no folder, no lock, no record');
});

test('when the linked checkouts are needed, git is asked inside what is left of the eight seconds and ended outright if it does not answer', (t) => {
  const { ids, clock, said, sweep } = inProcess(t, { held: 1, linked: true });
  const lookups = watchWorktreeLookups(t);
  const gh = ghAt(clock, mergedFor(ids));

  assert.equal(sweep(gh.run), 'ran');

  assert.equal(lookups.length, 1, 'asked once for the whole run');
  assert.ok(lookups[0].timeout > 0 && lookups[0].timeout <= 2000, `limit ${lookups[0].timeout} ms`);
  assert.equal(lookups[0].killSignal, 'SIGKILL', 'a git that ignores the polite stop is killed');
  assert.deepEqual(said, ['credited fleet-codex: pull request 71 merged'], 'and the job held in the linked checkout was found');
});

// The task store is opened (and the time starts to run down) before git is asked; here the clock jumps as it is opened.
for (const [spent, wanted] of [[7000, 1000], [7600, null]]) {
  test(`git is asked for the linked checkouts inside what is left of the eight seconds${wanted === null ? ', and not at all with too little left' : ''} (${spent} ms spent)`, (t) => {
    const { d, ids, clock, said, sweep } = inProcess(t, { held: 1, linked: true });
    const lookups = watchWorktreeLookups(t);
    const looked = fs.existsSync;
    let spentYet = false;
    t.mock.method(fs, 'existsSync', (target) => {
      if (!spentYet && String(target) === d.dbPath) { spentYet = true; clock.now += spent; }
      return looked(target);
    });
    const gh = ghAt(clock, mergedFor(ids));

    const outcome = sweep(gh.run);

    assert.deepEqual(said, []);
    assert.equal(gh.calls.length, 0, 'GitHub was not asked: this run did not get as far');
    if (wanted === null) {
      assert.equal(outcome, 'blocked');
      assert.deepEqual(lookups, []);
    } else {
      assert.equal(lookups.length, 1);
      assert.equal(lookups[0].timeout, wanted);
    }
    assert.deepEqual(d.records(), [], 'a run that did not get to ask is not a run');
  });
}

for (const [name, error] of [
  ['takes longer than its limit', Object.assign(new Error('spawnSync git ETIMEDOUT'), { code: 'ETIMEDOUT', signal: 'SIGKILL' })],
  ['exits with an error', Object.assign(new Error('Command failed: git worktree list --porcelain'), { status: 128 })],
]) {
  test(`a call for the linked checkouts that ${name} stops the run: nothing asked, said or written down, and nothing is held off`, (t) => {
    const { d, ids, clock, said, sweep } = inProcess(t, { held: 1, linked: true });
    const lookups = watchWorktreeLookups(t, { failFirst: error });
    const gh = ghAt(clock, mergedFor(ids));

    assert.equal(sweep(gh.run), 'blocked');

    assert.equal(lookups.length, 1);
    assert.equal(gh.calls.length, 0, 'GitHub was not asked: which checkouts are the workspace\'s is not known');
    assert.deepEqual(said, []);
    assert.deepEqual(d.records(), []);
    assert.deepEqual(d.locks(), []);
    assert.equal(tasks.getTask(d.db, ids[0]).status, 'review');

    // The failure was not remembered for the rest of the process: a following run asks git again, and goes on.
    assert.equal(sweep(ghAt(clock, mergedFor(ids)).run), 'ran');
    assert.equal(lookups.length, 2);
    assert.deepEqual(said, ['credited fleet-codex: pull request 71 merged']);
  });
}

test('within the hour of the last run, nothing is looked up: not even the linked checkouts', (t) => {
  const { d, clock, sweep } = inProcess(t, { held: 1, linked: true });
  d.setGh({ prs: { [pullAt(71)]: openPr(71) } });
  // The record is made by a command of its own, so this process has not asked git about the checkouts yet.
  assert.equal(d.cli(['rating', '--json']).status, 0);
  assert.equal(d.records().length, 1);
  clock.now = Date.now();
  const lookups = watchWorktreeLookups(t);
  const gh = ghAt(clock, () => openPr(71));

  assert.equal(sweep(gh.run), 'recent');

  assert.deepEqual(lookups, []);
  assert.equal(gh.calls.length, 0);
});

test('the task list asks git for the linked checkouts with a limit of five seconds, and ends it outright', (t) => {
  const d = desk(t);
  const side = linkedCheckout(d.dir);
  tasks.addTask(d.db, { title: 'In the linked checkout', tag: 'feedback', workspaceRoot: side });
  const lookups = watchWorktreeLookups(t);

  const listed = tasks.listTasks(d.db, { workspaceRoot: d.dir });

  assert.deepEqual(listed.map((row) => row.title), ['In the linked checkout'], 'the linked checkout is in the workspace\'s view');
  assert.equal(lookups.length, 1);
  assert.equal(lookups[0].timeout, 5000);
  assert.equal(lookups[0].killSignal, 'SIGKILL');
});

test('the lookup tells the linked checkouts and says when it could not tell; no time is no call, never a call with no limit', (t) => {
  const d = desk(t);
  const side = linkedCheckout(d.dir);
  const lone = mkdtemp('auto-sweep-lone-');
  t.after(() => fs.rmSync(lone, { recursive: true, force: true }));
  gitIn(lone, 'init', '-q');
  const lookups = watchWorktreeLookups(t);

  assert.deepEqual(tasks.lookUpLinkedWorktrees(d.dir, { timeoutMs: 0 }), { roots: [], failed: true });
  assert.deepEqual(lookups, [], 'a limit of nothing would mean no limit at all, so git was not called');
  assert.deepEqual(tasks.lookUpLinkedWorktrees(d.dir, { timeoutMs: 1500 }), { roots: [side], failed: false });
  assert.equal(lookups.length, 1);
  assert.equal(lookups[0].timeout, 1500);
  assert.deepEqual(tasks.lookUpLinkedWorktrees(d.dir), { roots: [side], failed: false });
  assert.equal(lookups.length, 1, 'what git said is remembered for the process');
  // A repository with no linked checkout has nothing to ask git about.
  assert.deepEqual(tasks.lookUpLinkedWorktrees(lone), { roots: [], failed: false });
  assert.equal(lookups.length, 1);
});

test('the task list\'s own lookup that fails is remembered for the process: the workspace alone, and git is not asked again', (t) => {
  const d = desk(t);
  linkedCheckout(d.dir);
  tasks.addTask(d.db, { title: 'Here', tag: 'feedback', workspaceRoot: d.dir });
  const lookups = watchWorktreeLookups(t, { failFirst: Object.assign(new Error('spawnSync git ETIMEDOUT'), { code: 'ETIMEDOUT' }) });

  assert.deepEqual(tasks.listTasks(d.db, { workspaceRoot: d.dir }).map((row) => row.title), ['Here']);
  assert.deepEqual(tasks.listTasks(d.db, { workspaceRoot: d.dir }).map((row) => row.title), ['Here']);

  assert.equal(lookups.length, 1);
  assert.deepEqual(tasks.lookUpLinkedWorktrees(d.dir), { roots: [], failed: true });
});

test('a git that ignores the polite stop cannot hold a task list for long: it is ended outright, and the list is the workspace\'s own jobs', (t) => {
  const d = desk(t);
  linkedCheckout(d.dir);
  tasks.addTask(d.db, { title: 'Here', tag: 'feedback', workspaceRoot: d.dir });
  hangingGit(t, d, { here: true });
  const started = Date.now();

  const listed = tasks.listTasks(d.db, { workspaceRoot: d.dir });

  const took = Date.now() - started;
  assert.ok(took < 15000, `waited ${took} ms for git`);
  assert.deepEqual(listed.map((row) => row.title), ['Here']);
});

test('a git that ignores the polite stop costs the run two seconds at most: nothing asked, said or written down', (t) => {
  const { d, ids, clock, said, sweep } = inProcess(t, { held: 1, linked: true });
  const git = hangingGit(t, d, { here: true });
  const gh = ghAt(clock, mergedFor(ids));
  const started = Date.now();

  const outcome = sweep(gh.run);

  const took = Date.now() - started;
  assert.ok(took < 8000, `waited ${took} ms for git`);
  assert.equal(outcome, 'blocked');
  assert.equal(git.calls().length, 1);
  assert.equal(gh.calls.length, 0);
  assert.deepEqual(said, []);
  assert.deepEqual(d.records(), []);
  assert.deepEqual(d.locks(), []);
  assert.equal(tasks.getTask(d.db, ids[0]).status, 'review');
});

test('on the real command line, a git that ignores the polite stop delays the command by a few seconds: it still prints what it prints, and the sweep says and writes down nothing', (t) => {
  const d = desk(t);
  const side = linkedCheckout(d.dir);
  const id = d.heldJob('Fix the feedback form', 77, { root: side });
  d.setGh({ prs: { [pullAt(77)]: mergedPr(77) } });
  const git = hangingGit(t, d, { holdMs: 40000 });
  const started = Date.now();

  const run = d.cli(['rating', '--json']);

  const took = Date.now() - started;
  assert.ok(took < 30000, `took ${took} ms`);
  assert.equal(run.status, 0, run.stderr);
  assert.doesNotThrow(() => JSON.parse(run.stdout));
  assert.equal(run.stderr, '');
  assert.ok(git.calls().length >= 1, 'git was asked');
  assert.deepEqual(d.ghCalls(), [], 'and GitHub was not');
  assert.deepEqual(d.records(), []);
  assert.equal(tasks.getTask(d.db, id).status, 'review');
});

// ---------------------------------------------------------------------------
// Git is started inside the eight seconds on every path. When a merge is refused because another job holds the pull
// request, the sweep names that job in its own workspace's numbering, and reading that numbering lists that workspace's
// tasks, which starts git when the workspace has checkouts linked to it. The run says nothing about a refusal, so it
// names the job by its id and starts no git for a workspace it was not asked about.

// A second workspace, in a folder of its own with its own repository and a checkout linked to it, holding a job that
// waits on the same pull request as the desk's job (its number, 71 unless told), or with `landed`, a job that already
// landed with it.
function otherWorkspace(t, d, { number = 71, landed = false } = {}) {
  const parent = mkdtemp('auto-sweep-other-');
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const other = path.join(parent, 'work');
  fs.mkdirSync(path.join(other, 'atris'), { recursive: true });
  gitIn(other, 'init', '-q');
  gitIn(other, 'remote', 'add', 'origin', ORIGIN);
  linkedCheckout(other);
  assert.equal(tasks.workspaceRoot(other), other, 'the folder is its own workspace');
  // The job is claimed in the desk's workspace and then moved by hand. Claiming a job in a workspace makes this process
  // ask git for that workspace's linked checkouts once and remember the answer, and the run under test has to meet the
  // other workspace as a command line does, with nothing known about it yet.
  let id;
  if (landed) {
    ({ id } = tasks.addTask(d.db, { title: 'Landed with the same pull request, from the other workspace', tag: 'feedback', workspaceRoot: d.dir }));
    assert.equal(tasks.claimTask(d.db, { id, claimedBy: 'fleet-claude', leaseMinutes: 60, leasePid: process.pid }).claimed, true);
    const merge = { merge_commit: COMMIT, number, url: pullAt(number), merged_at: MERGED_AT };
    assert.equal(tasks.readyTask(d.db, { id, actor: 'fleet-claude', proof: 'Landed by the flight.', merge }).ready, true);
  } else {
    id = d.heldJob('The same pull request, from the other workspace', number, { builder: 'fleet-claude' });
  }
  d.db.prepare('UPDATE tasks SET workspace_root = ? WHERE id = ?').run(other, id);
  return { other, id };
}

test('a merge refused because a job in another workspace holds the pull request starts no git for that workspace', (t) => {
  const { d, ids, clock, said, sweep } = inProcess(t, { held: 1 });
  const { id: theirs } = otherWorkspace(t, d);
  const lookups = watchWorktreeLookups(t);
  const gh = ghAt(clock, mergedFor(ids));

  assert.equal(sweep(gh.run), 'ran');

  assert.deepEqual(lookups.map((lookup) => lookup.cwd), [], 'git was not asked for any workspace\'s linked checkouts');
  assert.deepEqual(gh.calls.map((call) => call.args.slice(0, 2).join(' ')), ['pr view'], 'a refusal made from the board alone asks GitHub nothing more');
  assert.deepEqual(said, []);
  assert.equal(tasks.getTask(d.db, ids[0]).status, 'review');
  assert.equal(tasks.getTask(d.db, theirs).status, 'review');
  assert.equal(d.records().length, 1, 'GitHub was asked and answered, so the run is written down');
});

test('the same refusal, closed instead of merged, starts no git for the other workspace either', (t) => {
  const { d, ids, clock, said, sweep } = inProcess(t, { held: 1 });
  otherWorkspace(t, d);
  const lookups = watchWorktreeLookups(t);
  const gh = ghAt(clock, () => closedPr(71, { headRefName: buildBranch(ids[0]) }));

  assert.equal(sweep(gh.run), 'ran');

  assert.deepEqual(lookups.map((lookup) => lookup.cwd), []);
  assert.deepEqual(said, []);
  assert.equal(tasks.getTask(d.db, ids[0]).status, 'review', 'and the builder keeps the claim');
});

test('a merge refused because a job in another workspace already landed with the pull request starts no git for that workspace either', (t) => {
  const { d, ids, clock, said, sweep } = inProcess(t, { held: 1 });
  const { id: theirs } = otherWorkspace(t, d, { landed: true });
  const theirsBefore = tasks.getTask(d.db, theirs);
  const lookups = watchWorktreeLookups(t);
  const gh = ghAt(clock, mergedFor(ids));

  assert.equal(sweep(gh.run), 'ran');

  assert.deepEqual(lookups.map((lookup) => lookup.cwd), []);
  assert.deepEqual(said, []);
  assert.equal(tasks.getTask(d.db, ids[0]).status, 'review', 'refused: the pull request is already taken');
  assert.deepEqual(tasks.getTask(d.db, theirs), theirsBefore, 'and the other job is left as it was');
});

test('a git that ignores the polite stop cannot hold the run when a refusal names a job in another workspace', (t) => {
  const { d, ids, clock, said, sweep } = inProcess(t, { held: 1 });
  otherWorkspace(t, d);
  const git = hangingGit(t, d, { here: true });
  const gh = ghAt(clock, mergedFor(ids));
  const started = Date.now();

  const outcome = sweep(gh.run);

  const took = Date.now() - started;
  assert.ok(took < 3000, `took ${took} ms`);
  assert.equal(outcome, 'ran');
  assert.deepEqual(git.calls(), [], 'git was not asked for linked checkouts at all');
  assert.deepEqual(said, []);
  assert.equal(tasks.getTask(d.db, ids[0]).status, 'review');
});

test('on the real command line, a refusal that names a job in another workspace starts no git for it, so a git that ignores the polite stop holds nothing', (t) => {
  const d = desk(t);
  const id = d.heldJob('Fix the feedback form', 77);
  otherWorkspace(t, d, { number: 77 });
  d.setGh({ prs: { [pullAt(77)]: mergedPr(77) } });
  const git = hangingGit(t, d, { holdMs: 40000 });
  const started = Date.now();

  const run = d.cli(['rating', '--json']);

  const took = Date.now() - started;
  assert.ok(took < 8000, `took ${took} ms`);
  assert.equal(run.status, 0, run.stderr);
  assert.doesNotThrow(() => JSON.parse(run.stdout));
  assert.equal(run.stderr, '', 'a refusal is not worth a line');
  assert.deepEqual(git.calls(), [], 'git was not asked for linked checkouts');
  assert.deepEqual(d.ghCalls(), [askPullRequestCall(77)]);
  assert.equal(tasks.getTask(d.db, id).status, 'review');
});

// ---------------------------------------------------------------------------
// A gh that cannot be launched at all is an outage, like a gh that is not there.

for (const [name, heard] of [
  ['a gh file that cannot be run (EACCES)', { error: Object.assign(new Error('spawnSync gh EACCES'), { code: 'EACCES', errno: -13, syscall: 'spawnSync gh' }) }],
  ['a gh that cannot be started for want of memory (ENOMEM)', { error: Object.assign(new Error('spawnSync gh ENOMEM'), { code: 'ENOMEM', errno: -12, syscall: 'spawnSync gh' }) }],
  ['a wrapper that cannot be executed (exit 126)', { status: 126, say: 'gh: Permission denied' }],
]) {
  test(`${name} stops the run after one call without a line or a record`, (t) => {
    const { d, clock, said, sweep } = inProcess(t);
    const gh = ghAt(clock, () => heard);

    assert.equal(sweep(gh.run), 'blocked');

    assert.equal(gh.calls.length, 1, 'the other jobs were not asked');
    assert.deepEqual(said, []);
    assert.deepEqual(d.records(), []);
  });
}

test('a runner that throws instead of answering stops the run the same way', (t) => {
  const { d, said, sweep } = inProcess(t);
  let calls = 0;

  assert.equal(sweep(() => { calls += 1; throw new Error('spawn failed'); }), 'blocked');

  assert.equal(calls, 1);
  assert.deepEqual(said, []);
  assert.deepEqual(d.records(), []);
});

test('a gh file that cannot be run on the real command line is skipped quietly, not written down, and nothing is held off', (t) => {
  const d = desk(t);
  const id = d.heldJob('Fix the feedback form', 77);
  d.setGh({ prs: { [pullAt(77)]: mergedPr(77) } });
  const gh = path.join(d.bin, 'gh');
  fs.chmodSync(gh, 0o644);

  const run = d.cli(['rating', '--json'], { fakeGhOnly: true });

  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stderr, '', 'a gh that cannot be run is not worth a word');
  assert.doesNotThrow(() => JSON.parse(run.stdout));
  assert.deepEqual(d.records(), [], 'a run that could not ask is not a run');
  assert.equal(tasks.getTask(d.db, id).status, 'review');

  fs.chmodSync(gh, 0o755);
  const next = d.cli(['rating', '--json'], { fakeGhOnly: true });
  assert.deepEqual(lines(next.stderr), ['credited fleet-codex: pull request 77 merged']);
  assert.equal(tasks.getTask(d.db, id).status, 'done');
});

// ---------------------------------------------------------------------------
// A gh that did not exit on its own (a signal ended it before it said anything) has told us nothing about the pull
// request: the run stops as it does for a gh that timed out, and nothing is held off for an hour.

for (const signal of ['SIGKILL', 'SIGTERM']) {
  test(`a gh ended by ${signal} before it answers stops the run after one call: nothing more said, nothing written down, and nothing is held off`, (t) => {
    const { d, ids, clock, said, sweep } = inProcess(t);
    const gh = ghAt(clock, () => ({ signal }));

    assert.equal(sweep(gh.run), 'blocked');

    assert.equal(gh.calls.length, 1, 'the other jobs were not asked');
    assert.deepEqual(said, []);
    assert.deepEqual(d.records(), []);
    assert.deepEqual(d.locks(), []);
    assert.deepEqual(ids.map((id) => tasks.getTask(d.db, id).status), ['review', 'review', 'review']);

    // A following run asks again, and credits all three.
    const next = ghAt(clock, mergedFor(ids));
    assert.equal(sweep(next.run), 'ran');
    assert.deepEqual(next.calls.filter((call) => call.args[0] === 'pr').map((call) => numberOf(call.args)), [71, 72, 73]);
    assert.equal(said.length, 3);
  });
}

// A failure after a readable answer is still a failure. The merge is read and counted, and then the question about the
// default branch cannot be answered: the run stops, writes nothing down, and holds nothing off.
test('a gh ended by a signal on the default branch question, after a readable answer, is a failure: nothing is written down and nothing is held off', (t) => {
  const { d, ids, clock, said, sweep } = inProcess(t, { held: 1 });
  const gh = ghAt(clock, (args) => (args[0] === 'repo' ? { signal: 'SIGKILL' } : mergedFor(ids)(args)));

  assert.equal(sweep(gh.run), 'blocked');

  assert.deepEqual(gh.calls.map((call) => call.args[0]), ['pr', 'repo'], 'the merge was read, then the default branch was asked');
  assert.deepEqual(said, []);
  assert.deepEqual(d.records(), [], 'GitHub had answered, but the run failed after it, so the hour does not start');
  assert.deepEqual(d.locks(), []);
  assert.equal(tasks.getTask(d.db, ids[0]).status, 'review');

  assert.equal(sweep(ghAt(clock, mergedFor(ids)).run), 'ran');
  assert.deepEqual(said, ['credited fleet-codex: pull request 71 merged']);
});

test('a gh that times out on the default branch question, after a readable answer, is a failure: nothing is written down and nothing is held off', (t) => {
  const { d, ids, clock, said, sweep } = inProcess(t, { held: 1 });
  const timedOut = { error: Object.assign(new Error('spawnSync gh ETIMEDOUT'), { code: 'ETIMEDOUT' }) };
  const gh = ghAt(clock, (args) => (args[0] === 'repo' ? timedOut : mergedFor(ids)(args)));

  assert.equal(sweep(gh.run), 'blocked');

  assert.deepEqual(gh.calls.map((call) => call.args[0]), ['pr', 'repo'], 'the merge was read, then the default branch was asked');
  assert.deepEqual(said, []);
  assert.deepEqual(d.records(), [], 'GitHub had answered, but the run failed after it, so the hour does not start');
  assert.deepEqual(d.locks(), []);
  assert.equal(tasks.getTask(d.db, ids[0]).status, 'review');

  assert.equal(sweep(ghAt(clock, mergedFor(ids)).run), 'ran', 'a following run asks again, and credits');
  assert.deepEqual(said, ['credited fleet-codex: pull request 71 merged']);
  assert.equal(d.records().length, 1);
});

test('jobs settled before a gh is ended by a signal stay settled: their lines stand, the run is not written down although GitHub answered, and the rest are left for a later run', (t) => {
  const { d, ids, clock, said, sweep } = inProcess(t, { held: 2 });
  const gh = ghAt(clock, (args) => (args[0] === 'pr' && numberOf(args) === 72 ? { signal: 'SIGKILL' } : mergedFor(ids)(args)));

  assert.equal(sweep(gh.run), 'blocked');

  assert.deepEqual(said, ['credited fleet-codex: pull request 71 merged']);
  assert.equal(tasks.getTask(d.db, ids[0]).status, 'done');
  assert.equal(tasks.getTask(d.db, ids[1]).status, 'review');
  assert.deepEqual(completedEvents(d.db, ids[0]).map((event) => event.payload.action), ['merged']);
  assert.deepEqual(d.records(), [], 'GitHub answered for the first job, but the run failed after it, so it is not written down');

  const next = ghAt(clock, mergedFor(ids));
  assert.equal(sweep(next.run), 'ran');
  assert.deepEqual(next.calls.filter((call) => call.args[0] === 'pr').map((call) => numberOf(call.args)), [72], 'only the job that was not settled is asked about');
  assert.deepEqual(said, ['credited fleet-codex: pull request 71 merged', 'credited fleet-codex: pull request 72 merged']);
});

// Output past the buffer: the runner ends gh with a signal and says why, so this is a reply too long to read about that
// one pull request. It stops nothing (the other jobs are asked), and it is no readable answer.
const tooMuch = () => ({ error: Object.assign(new Error('spawnSync gh ENOBUFS'), { code: 'ENOBUFS' }) });

test('output past the buffer is no readable answer: the run goes on to the next job and, with nothing else read, is not written down', (t) => {
  const { d, ids, clock, said, sweep } = inProcess(t, { held: 2 });
  const gh = ghAt(clock, tooMuch);

  assert.equal(sweep(gh.run), 'idle');

  assert.equal(gh.calls.length, 2, 'it stopped nothing: the second job was asked too');
  assert.deepEqual(said, []);
  assert.deepEqual(d.records(), []);
  assert.deepEqual(d.locks(), []);

  assert.equal(sweep(ghAt(clock, mergedFor(ids)).run), 'ran', 'a following run asks again');
  assert.equal(said.length, 2);
});

test('output past the buffer for one job and a readable answer for the next: the run goes on, credits that one and is written down', (t) => {
  const { d, ids, clock, said, sweep } = inProcess(t, { held: 2 });
  const gh = ghAt(clock, (args) => (args[0] === 'pr' && numberOf(args) === 71 ? tooMuch() : mergedFor(ids)(args)));

  assert.equal(sweep(gh.run), 'ran');

  assert.deepEqual(gh.calls.filter((call) => call.args[0] === 'pr').map((call) => numberOf(call.args)), [71, 72]);
  assert.deepEqual(said, ['credited fleet-codex: pull request 72 merged']);
  assert.deepEqual(ids.map((id) => tasks.getTask(d.db, id).status), ['review', 'done']);
  assert.equal(d.records().length, 1);
});

// ---------------------------------------------------------------------------
// One rule decides whether a run is written down: GitHub gave at least one readable answer in it (a reply the sweep
// parsed into a pull request state, or gh's whole message "Could not resolve to a PullRequest with the number of N", for the
// very N asked about) and nothing in the run failed. Answers are counted, not jobs or calls. Running out of time is not a failure: with an answer in hand it still
// counts, and the jobs that were not asked are left as they are. A failure is a gh or a git that could not be used (on any
// question, the default branch included), a store that stayed busy, or a job that could not be settled: after one the run
// is not written down even if GitHub had answered, and nothing is held off. A run without an answer is not a run
// either, and nothing is held off: no time was left to ask, gh printed nothing or something that is not a pull
// request or too much, or the only jobs had no link to ask about.

// What a gh that exits 0 can print without having described a pull request.
const notAPullRequest = [
  ['nothing at all', ''],
  ['only a line break', '\n'],
  ['words, not JSON', 'Welcome to the GitHub CLI'],
  ['a JSON list', '[]'],
  ['an object that names no pull request', '{"message":"hello"}'],
  ['a pull request with no state', '{"number":71}'],
  ['a state it does not know', '{"number":71,"state":"PARKED"}'],
  ['a state and no pull request number', '{"state":"OPEN"}'],
  ['a pull request number that is not a number', '{"number":"seventy-one","state":"OPEN"}'],
];
for (const [name, raw] of notAPullRequest) {
  test(`a gh that exits 0 and prints ${name} has not answered: every job is asked, nothing is said or written down, and nothing is held off`, (t) => {
    const { d, ids, clock, said, sweep } = inProcess(t);
    const gh = ghAt(clock, () => ({ raw }));

    assert.equal(sweep(gh.run), 'idle');

    assert.equal(gh.calls.length, 3, 'a reply that cannot be read stops nothing: the other jobs are asked');
    assert.deepEqual(said, []);
    assert.deepEqual(d.records(), [], 'no readable answer is no run');
    assert.deepEqual(d.locks(), []);
    assert.deepEqual(ids.map((id) => tasks.getTask(d.db, id).status), ['review', 'review', 'review']);

    // A following run asks again, and credits all three.
    assert.equal(sweep(ghAt(clock, mergedFor(ids)).run), 'ran');
    assert.deepEqual(said, [71, 72, 73].map((number) => `credited fleet-codex: pull request ${number} merged`));
  });
}

test('a settled job stays settled when a later reply cannot be read, and the run is written down for the answer it did get', (t) => {
  const { d, ids, clock, said, sweep } = inProcess(t, { held: 2 });
  const gh = ghAt(clock, (args) => (args[0] === 'pr' && numberOf(args) === 72 ? { raw: '' } : mergedFor(ids)(args)));

  assert.equal(sweep(gh.run), 'ran');

  assert.deepEqual(said, ['credited fleet-codex: pull request 71 merged']);
  assert.deepEqual(ids.map((id) => tasks.getTask(d.db, id).status), ['done', 'review']);
  assert.equal(d.records().length, 1);
});

// The clock is the test's, so time can be spent where the run cannot help it. Here it is spent as the task store is
// opened, which is before anything is asked.
function spendWhenStoreIsOpened(t, d, clock, ms) {
  const looked = fs.existsSync;
  let spent = false;
  t.mock.method(fs, 'existsSync', (target) => {
    if (!spent && String(target) === d.dbPath) { spent = true; clock.now += ms; }
    return looked(target);
  });
}

// A workspace can hold thousands of tasks besides the held jobs. They get their ids in the same few milliseconds, which is
// what makes numbering them slow.
function crowd(d, count) {
  for (let n = 0; n < count; n += 1) tasks.addTask(d.db, { title: `Other task ${n}`, tag: 'feedback', workspaceRoot: d.dir });
}

// Writes down each whole listing of a task list (no status asked for) and each numbering of jobs, with how many jobs were
// numbered and against how many tasks, and lets both through. With a clock, the time can be spent as the nth whole
// listing is read (atList: [nth, ms]), which is where a long task list takes it.
function watchStore(t, { clock = null, atList = null } = {}) {
  const list = tasks.listTasks;
  const number = tasks.withTaskDisplayRefs;
  const seen = { lists: [], numberings: [] };
  t.mock.method(tasks, 'listTasks', (db, options) => {
    const rows = list(db, options);
    if (!(options && options.status)) {
      seen.lists.push(rows.length);
      if (atList && seen.lists.length === atList[0]) clock.now += atList[1];
    }
    return rows;
  });
  t.mock.method(tasks, 'withTaskDisplayRefs', (rows, refRows) => {
    seen.numberings.push({ jobs: Array.isArray(rows) ? rows.length : null, against: Array.isArray(refRows) ? refRows.length : null });
    return number(rows, refRows);
  });
  return seen;
}

test('the eight seconds used up before the first question is no run: nothing is asked, said or written down, and nothing is held off', (t) => {
  const { d, ids, clock, said, sweep } = inProcess(t, { held: 2 });
  spendWhenStoreIsOpened(t, d, clock, 7000);
  const gh = ghAt(clock, mergedFor(ids));

  assert.equal(sweep(gh.run), 'blocked');

  assert.equal(gh.calls.length, 0);
  assert.deepEqual(said, []);
  assert.deepEqual(d.records(), [], 'no time to ask is not a run');
  assert.deepEqual(d.locks(), []);

  assert.equal(sweep(ghAt(clock, mergedFor(ids)).run), 'ran');
  assert.equal(said.length, 2);
});

// The task list is read once, before the first question. Reading it is not cut short, but it uses the same eight
// seconds, so a read that takes them all leaves none to ask with: nothing is asked, said or written down, and nothing
// is held off.
test('the eight seconds used up in reading the task list is no run: nothing is asked, said or written down, and nothing is held off', (t) => {
  const { d, ids, clock, said, sweep } = inProcess(t, { held: 2 });
  const seen = watchStore(t, { clock, atList: [1, 7000] });
  const gh = ghAt(clock, mergedFor(ids));

  assert.equal(sweep(gh.run), 'blocked');

  assert.equal(gh.calls.length, 0, 'GitHub was never asked');
  assert.equal(seen.lists.length, 1, 'the list was read, and that was all');
  assert.deepEqual(seen.numberings, []);
  assert.deepEqual(said, []);
  assert.deepEqual(d.records(), [], 'nothing came back, so nothing is a run');
  assert.deepEqual(d.locks(), []);
  assert.deepEqual(ids.map((id) => tasks.getTask(d.db, id).status), ['review', 'review']);

  assert.equal(sweep(ghAt(clock, mergedFor(ids)).run), 'ran', 'and a following run asks');
  assert.deepEqual(said, ['credited fleet-codex: pull request 71 merged', 'credited fleet-codex: pull request 72 merged']);
});

// A workspace can hold thousands of tasks, and numbering them is the slow part of reading them. The run's lines name the
// builder and the pull request, never a task number, so it numbers nothing: it reads the task list once, however many jobs
// are held, and each call of the sweep is handed its job from that. The manual sweep prints task numbers, so it still
// numbers, and the same spy sees it do so. (The pull requests are open, so no job is credited: the store numbers the list
// inside a credit, to write its journal line, and that is the store's own and is not what is counted here.)
test('the run reads the task list once and numbers nothing, however many jobs are held, and the manual sweep still numbers', (t) => {
  const { d, ids, clock, said, sweep } = inProcess(t, { held: 4 });
  crowd(d, 3000);
  const { askGitHub, askDefaultBranch, sweepHeldJobs } = require('../lib/held-pull-requests');
  const seen = watchStore(t);
  const gh = ghAt(clock, (args) => openPr(numberOf(args)));

  assert.equal(sweep(gh.run), 'ran');

  assert.deepEqual(gh.calls.map((call) => numberOf(call.args)), [71, 72, 73, 74], 'every job was asked about, in order');
  assert.deepEqual(said, []);
  assert.deepEqual(ids.map((id) => tasks.getTask(d.db, id).status), ['review', 'review', 'review', 'review']);
  assert.deepEqual(seen.lists, [3004], 'the task list was read once');
  assert.deepEqual(seen.numberings, [], 'and nothing was numbered');

  const byHand = sweepHeldJobs(tasks, d.db, {
    workspaceRoot: d.dir,
    actor: 'keshav',
    dryRun: true,
    ask: (url) => askGitHub(url, { run: gh.run }),
    askBranch: (link) => askDefaultBranch(link, { run: gh.run }),
  });

  assert.equal(byHand.results.length, 4);
  assert.deepEqual(seen.numberings, [{ jobs: 4, against: 3004 }], 'the manual sweep numbers its four jobs against the whole list');
});

// The sweep a person runs by hand is not handed a listing: it lists the workspace and numbers its held jobs itself, as
// it always did, and so does a call for one job that is not handed one.
test('the manual sweep still lists the workspace and numbers its held jobs itself, once for each call', (t) => {
  const { d, ids, clock } = inProcess(t, { held: 3 });
  crowd(d, 40);
  const { askGitHub, askDefaultBranch, sweepHeldJobs } = require('../lib/held-pull-requests');
  const handGh = ghAt(clock, mergedFor(ids));
  const seen = watchStore(t);
  const byHand = (extra = {}) => sweepHeldJobs(tasks, d.db, {
    workspaceRoot: d.dir,
    actor: 'keshav',
    dryRun: true,
    ask: (url) => askGitHub(url, { run: handGh.run }),
    askBranch: (link) => askDefaultBranch(link, { run: handGh.run }),
    ...extra,
  });

  const all = byHand();

  assert.equal(all.results.length, 3);
  assert.deepEqual(seen.lists, [43]);
  assert.deepEqual(seen.numberings, [{ jobs: 3, against: 43 }]);

  const one = byHand({ only: ids[1] });

  assert.deepEqual(one.results.map((result) => result.task_id), [ids[1]]);
  assert.deepEqual(seen.lists, [43, 43], 'a call handed no listing reads the list again');
  assert.deepEqual(seen.numberings, [{ jobs: 3, against: 43 }, { jobs: 1, against: 43 }]);
});

// The listing a call is handed is task rows already read: the call lists and numbers nothing, sweeps the held jobs among
// what it is handed (not the other tasks), picks the one it was asked for, and names a job by its number when its row has
// one and by its id when it has not.
test('a sweep handed a listing lists and numbers nothing itself, and sweeps the held jobs in it, or the one asked for', (t) => {
  const { d, ids, clock } = inProcess(t, { held: 3 });
  crowd(d, 40);
  const { askGitHub, askDefaultBranch, sweepHeldJobs } = require('../lib/held-pull-requests');
  const rows = tasks.listTasks(d.db, { workspaceRoot: d.dir });
  const listing = tasks.withTaskDisplayRefs(rows, rows);
  const handGh = ghAt(clock, mergedFor(ids));
  const seen = watchStore(t);
  const from = (extra = {}) => sweepHeldJobs(tasks, d.db, {
    workspaceRoot: d.dir,
    actor: 'keshav',
    dryRun: true,
    listing,
    ask: (url) => askGitHub(url, { run: handGh.run }),
    askBranch: (link) => askDefaultBranch(link, { run: handGh.run }),
    ...extra,
  });

  const all = from();
  const one = from({ only: ids[1] });
  const none = from({ listing: [] });
  const plain = from({ listing: rows });

  assert.deepEqual(all.results.map((result) => result.task_id).sort(), [...ids].sort(), 'the held jobs among the 43 tasks handed in');
  assert.deepEqual(one.results.map((result) => result.task_id), [ids[1]]);
  assert.deepEqual(none.results, [], 'an empty listing is a listing with nothing held in it, not a call to read the workspace');
  for (const result of [...all.results, ...one.results]) {
    assert.equal(result.ref, listing.find((row) => row.id === result.task_id).display_id, 'a job is named as the listing numbered it');
  }
  assert.ok(rows.every((row) => !row.display_id && !row.legacy_ref), 'the rows as read carry no number');
  assert.deepEqual(plain.results.map((result) => [result.task_id, result.ref]).sort(), ids.map((id) => [id, id]).sort(), 'a job whose row has no number is named by its id');
  assert.deepEqual(seen, { lists: [], numberings: [] }, 'no call listed or numbered anything');
});

test('one readable answer and then the time running out is a run, since running out of time is not a failure: the jobs not asked are left as they are', (t) => {
  const { d, clock, said, sweep } = inProcess(t);
  // The first question takes 7 of the 8 seconds, and GitHub says that pull request is still open.
  const gh = ghAt(clock, () => openPr(71), { cost: 7000 });

  assert.equal(sweep(gh.run), 'ran');

  assert.equal(gh.calls.length, 1, 'the other two jobs were not asked');
  assert.deepEqual(said, []);
  assert.equal(d.records().length, 1, 'but the run is written down');
  assert.equal(sweep(gh.run), 'recent', 'and the jobs not asked are left as they are');
  assert.equal(gh.calls.length, 1);
});

test('one readable answer, and then the time is gone before the next job is asked: still a run, since running out of time is not a failure', (t) => {
  const { d, ids, clock, said, sweep } = inProcess(t, { held: 2 });
  // The first job is settled; its two questions (the pull request, then the repository's default branch) take 7 of the 8
  // seconds, which leaves too little to ask about the second.
  const gh = ghAt(clock, mergedFor(ids), { cost: 3500 });

  assert.equal(sweep(gh.run), 'ran');

  assert.deepEqual(gh.calls.filter((call) => call.args[0] === 'pr').map((call) => numberOf(call.args)), [71]);
  assert.deepEqual(said, ['credited fleet-codex: pull request 71 merged']);
  assert.deepEqual(ids.map((id) => tasks.getTask(d.db, id).status), ['done', 'review']);
  assert.equal(d.records().length, 1);
});

test('a merge is the one readable answer and there is no time left to ask which branch it landed on: still a run, since running out of time is not a failure, and the credit is left for a later run', (t) => {
  const { d, ids, clock, said, sweep } = inProcess(t, { held: 1 });
  // GitHub takes 7 of the 8 seconds to say the pull request is merged.
  const gh = ghAt(clock, mergedFor(ids), { cost: 7000 });

  assert.equal(sweep(gh.run), 'ran');

  assert.deepEqual(gh.calls.map((call) => call.args[0]), ['pr'], 'the default branch was not asked');
  assert.deepEqual(said, []);
  assert.equal(tasks.getTask(d.db, ids[0]).status, 'review');
  assert.equal(d.records().length, 1);
  assert.equal(sweep(gh.run), 'recent');

  clock.now += 61 * MINUTE;
  assert.equal(sweep(ghAt(clock, mergedFor(ids)).run), 'ran');
  assert.deepEqual(said, ['credited fleet-codex: pull request 71 merged']);
});

// A job that names a pull request by number and has no link, in a workspace whose origin cannot be read, can be asked
// about nowhere: there is nothing to put to GitHub.
function numberOnlyJob(d, number) {
  const id = d.heldJob('Names a number and no link', number);
  d.db.prepare("UPDATE tasks SET metadata = json_set(metadata, '$.pull_request', json(?)) WHERE id = ?").run(JSON.stringify({ state: 'open', number }), id);
  return id;
}

test('a held job with no link and no origin is no run: GitHub is asked nothing and nothing is written down, command after command', (t) => {
  const { d, clock, said, sweep } = inProcess(t, { held: 0 });
  gitIn(d.dir, 'remote', 'remove', 'origin');
  const id = numberOnlyJob(d, 99);
  const gh = ghAt(clock, () => openPr(99));

  assert.equal(sweep(gh.run), 'idle');
  assert.equal(sweep(gh.run), 'idle', 'nothing makes it a run, so nothing is held off');

  assert.equal(gh.calls.length, 0, 'there is no link to put to GitHub');
  assert.deepEqual(said, []);
  assert.deepEqual(d.records(), []);
  assert.deepEqual(d.locks(), []);
  assert.equal(tasks.getTask(d.db, id).status, 'review');
});

test('a job with no link beside a job with one: the answer for the one that has a link makes it a run', (t) => {
  const { d, clock, said, sweep } = inProcess(t, { held: 1 });
  numberOnlyJob(d, 99);
  const gh = ghAt(clock, () => openPr(71));

  assert.equal(sweep(gh.run), 'ran');

  assert.equal(gh.calls.length, 1, 'only the job with a link was put to GitHub');
  assert.deepEqual(said, []);
  assert.equal(d.records().length, 1);
});

test('on the real command line, a held job with no link and no origin asks gh nothing and leaves no record', (t) => {
  const d = desk(t);
  gitIn(d.dir, 'remote', 'remove', 'origin');
  const id = numberOnlyJob(d, 99);
  d.setGh({ prs: { [pullAt(99)]: openPr(99) } });

  const run = d.cli(['rating', '--json']);

  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stderr, '');
  assert.doesNotThrow(() => JSON.parse(run.stdout));
  assert.deepEqual(d.ghCalls(), []);
  assert.deepEqual(d.records(), []);
  assert.deepEqual(d.locks(), []);
  assert.equal(tasks.getTask(d.db, id).status, 'review');
});

// ---------------------------------------------------------------------------
// Each job's line is said as that job is settled, and one job failing hides none of the others.

test('each job\'s line is said as soon as that job is settled, before the next job is asked about', (t) => {
  const { ids, clock, said, sweep } = inProcess(t, { held: 3 });
  const sayingWhenAsked = [];
  const gh = ghAt(clock, (args) => {
    if (args[0] === 'pr') sayingWhenAsked.push(said.length);
    return mergedFor(ids)(args);
  });

  assert.equal(sweep(gh.run), 'ran');

  assert.deepEqual(sayingWhenAsked, [0, 1, 2], 'the first credit was already said when the second job was asked about');
  assert.deepEqual(said, [71, 72, 73].map((number) => `credited fleet-codex: pull request ${number} merged`));
});

test('a job that cannot be settled costs one short line, the other jobs are still settled, the credits already made are said, and the run is not written down although GitHub answered', (t) => {
  const { d, ids, clock, said, sweep } = inProcess(t, { held: 3 });
  const land = tasks.landHeldMerge;
  t.mock.method(tasks, 'landHeldMerge', (db, args) => {
    if (args.id === ids[1]) throw new Error('disk I/O error');
    return land(db, args);
  });
  const gh = ghAt(clock, mergedFor(ids));

  assert.equal(sweep(gh.run), 'failed');

  assert.deepEqual(said, [
    'credited fleet-codex: pull request 71 merged',
    'held jobs: could not check fleet-codex: pull request 72 (disk I/O error)',
    'credited fleet-codex: pull request 73 merged',
  ]);
  assert.deepEqual(ids.map((id) => tasks.getTask(d.db, id).status), ['done', 'review', 'done']);
  assert.deepEqual(d.records(), [], 'GitHub answered, but a run with a job that could not be settled failed, so it is not written down and that job is asked about again');
  assert.deepEqual(d.locks(), []);
});

test('a store that is busy when a job is to be settled stops the run quietly, the credits already made stand, and the run is not written down although GitHub answered', (t) => {
  const { d, ids, clock, said, sweep } = inProcess(t, { held: 3 });
  const land = tasks.landHeldMerge;
  t.mock.method(tasks, 'landHeldMerge', (db, args) => {
    if (args.id === ids[1]) throw busy();
    return land(db, args);
  });
  const gh = ghAt(clock, mergedFor(ids));

  assert.equal(sweep(gh.run), 'blocked');

  assert.deepEqual(said, ['credited fleet-codex: pull request 71 merged']);
  assert.deepEqual(ids.map((id) => tasks.getTask(d.db, id).status), ['done', 'review', 'review']);
  assert.equal(gh.calls.filter((call) => call.args[0] === 'pr').length, 2, 'the third job was not asked about');
  assert.deepEqual(d.records(), [], 'GitHub answered, but a store that stays busy fails the run, so it is not written down');
});

test('the sweep can be limited to one job, and told where the workspace came from instead of asking git', (t) => {
  const { d, ids, clock } = inProcess(t, { held: 2 });
  const { askGitHub, askDefaultBranch, sweepHeldJobs } = require('../lib/held-pull-requests');
  const gh = ghAt(clock, mergedFor(ids));
  const origins = [];

  const report = sweepHeldJobs(tasks, d.db, {
    workspaceRoot: d.dir,
    actor: 'keshav',
    only: ids[1],
    ask: (url) => askGitHub(url, { run: gh.run }),
    askBranch: (link) => askDefaultBranch(link, { run: gh.run }),
    askOrigin: (root) => { origins.push(root); return REPO; },
  });

  assert.deepEqual(report.results.map((result) => result.task_id), [ids[1]]);
  assert.equal(report.summary.landed, 1);
  assert.deepEqual(gh.calls.map((call) => call.args[2]), [pullAt(72), repoLink()], 'only that job was asked about');
  assert.deepEqual(origins, [d.dir]);
  assert.equal(gh.gitCalls.length, 0);
  assert.deepEqual(ids.map((id) => tasks.getTask(d.db, id).status), ['review', 'done']);
});

// ---------------------------------------------------------------------------
// One command at a time: a small lock file, created exclusively, stale after a minute.

test('a run that starts while another holds the check skips it: nothing asked, said or written down by the skipped one', (t) => {
  const { d, ids, clock, said, sweep } = inProcess(t, { held: 1 });
  const second = ghAt(clock, mergedFor(ids));
  let inner = null;
  const first = ghAt(clock, (args) => {
    if (inner === null) inner = sweep(second.run);
    return mergedFor(ids)(args);
  });

  assert.equal(sweep(first.run), 'ran');

  assert.equal(inner, 'running');
  assert.equal(second.calls.length, 0);
  assert.deepEqual(said, ['credited fleet-codex: pull request 71 merged'], 'said once, by the run that had the check');
  assert.equal(d.records().length, 1);
  assert.deepEqual(d.locks(), [], 'and the check is let go when that run is over');
});

// Both commands looked at the record before either had run. The slow one takes the lock only after the other has
// run the whole check and let it go, so the lock is free: it has to look at the record again.
test('a command that is slow to take the check finds the record of the run that finished before it, and skips', (t) => {
  const { d, ids, clock, said, sweep } = inProcess(t, { held: 1 });
  const early = ghAt(clock, mergedFor(ids));
  const late = ghAt(clock, mergedFor(ids));
  const made = fs.mkdirSync;
  let nested = false;
  let inner = null;
  // The folder for the record and the lock is made after the look at the record and just before the lock is taken.
  t.mock.method(fs, 'mkdirSync', (...args) => {
    const result = made(...args);
    if (!nested && String(args[0]) === d.stateFolder) {
      nested = true;
      inner = sweep(early.run);
    }
    return result;
  });

  const outcome = sweep(late.run);

  assert.equal(inner, 'ran');
  assert.equal(outcome, 'recent');
  assert.equal(late.calls.length, 0);
  assert.deepEqual(said, ['credited fleet-codex: pull request 71 merged'], 'said once');
  assert.equal(d.records().length, 1);
  assert.deepEqual(d.locks(), []);
});

test('a lock a minute old is a check that died and is taken over; one under a minute old is a check still under way', (t) => {
  const { d, clock, said, sweep } = inProcess(t, { held: 1 });
  const gh = ghAt(clock, () => openPr(71));
  assert.equal(sweep(gh.run), 'ran');
  d.ago(2 * HOUR);
  const lock = d.lockFile();
  fs.writeFileSync(lock, 'a run that died\n');
  const age = (ms) => { const when = new Date(clock.now - ms); fs.utimesSync(lock, when, when); };

  age(30 * 1000);
  assert.equal(sweep(gh.run), 'running');
  assert.equal(gh.calls.length, 1, 'half a minute: left alone');
  assert.equal(fs.existsSync(lock), true, 'and not taken');

  age(2 * MINUTE);
  assert.equal(sweep(gh.run), 'ran');
  assert.equal(gh.calls.length, 2, 'two minutes: taken over, and the check ran');
  assert.deepEqual(d.locks(), []);
  assert.deepEqual(said, []);
});

test('a run lets go only of its own lock: one taken over in the meantime is left to the run that holds it', (t) => {
  const { d, ids, clock, sweep } = inProcess(t, { held: 1 });
  let taken = null;
  const gh = ghAt(clock, (args) => {
    if (args[0] === 'pr' && taken === null) {
      taken = path.join(d.stateFolder, d.locks()[0]);
      fs.writeFileSync(taken, 'the run that took it over\n');
    }
    return mergedFor(ids)(args);
  });

  assert.equal(sweep(gh.run), 'ran');

  assert.equal(fs.readFileSync(taken, 'utf8'), 'the run that took it over\n');
});

test('a run that fails or is stopped lets the check go and writes nothing down', (t) => {
  const { d, clock, sweep } = inProcess(t, { held: 1 });
  const hung = { error: Object.assign(new Error('spawnSync gh ETIMEDOUT'), { code: 'ETIMEDOUT' }) };

  assert.equal(sweep(ghAt(clock, () => hung).run), 'blocked');
  assert.deepEqual(d.locks(), []);
  assert.deepEqual(d.records(), []);

  // The next one is not turned away by a lock the last one left behind.
  assert.equal(sweep(ghAt(clock, () => openPr(71)).run), 'ran');
  assert.deepEqual(d.locks(), []);
  assert.equal(d.records().length, 1);
});

// Taking over a dead lock is a step one run at a time may take, guarded by a second small file beside the lock (its
// name and .takeover). Two runs can both find the same dead lock; the second to act must not remove the lock the first
// has made since, so the run that holds the guard looks at the lock again before it removes it. These play the other
// run by hand, at the moment between this run's look at the dead lock and its step to take it over.

// The first run is long past, and a run that died left its lock two minutes ago.
function deadLock({ d, clock, sweep }) {
  assert.equal(sweep(ghAt(clock, () => openPr(71)).run), 'ran');
  d.ago(2 * HOUR);
  const lock = d.lockFile();
  fs.writeFileSync(lock, 'a run that died\n');
  const then = new Date(clock.now - 2 * MINUTE);
  fs.utimesSync(lock, then, then);
  return lock;
}
// Whatever is in the state folder besides the record and the lock: a guard, a lock moved aside, a half-written record.
const strays = (d) => fs.readdirSync(d.stateFolder).filter((name) => !name.endsWith('.json') && !name.endsWith('.lock'));

test('the second of two runs to find a dead lock leaves alone the lock the first has made since', (t) => {
  const { d, ids, clock, said, sweep } = inProcess(t, { held: 1 });
  const lock = deadLock({ d, clock, sweep });
  const looked = fs.statSync;
  let other = false;
  t.mock.method(fs, 'statSync', (...args) => {
    const result = looked(...args);
    if (!other && String(args[0]) === lock) {
      other = true;
      // The other run found the same dead lock, removed it and made its own, all after this run looked.
      fs.unlinkSync(lock);
      fs.writeFileSync(lock, 'the other run\n');
    }
    return result;
  });
  const gh = ghAt(clock, mergedFor(ids));

  assert.equal(sweep(gh.run), 'running');

  assert.equal(other, true, 'the other run took it over');
  assert.equal(gh.calls.length, 0, 'nothing was asked: the other run has the check');
  assert.equal(fs.readFileSync(lock, 'utf8'), 'the other run\n', 'and its lock is where it left it');
  assert.deepEqual(strays(d), [], 'no file of this run is left behind');
  assert.deepEqual(said, []);
  assert.equal(tasks.getTask(d.db, ids[0]).status, 'review');
});

test('a run that finds another run in the middle of taking over the dead lock leaves it to that run', (t) => {
  const { d, ids, clock, said, sweep } = inProcess(t, { held: 1 });
  const lock = deadLock({ d, clock, sweep });
  const guard = `${lock}.takeover`;
  fs.writeFileSync(guard, 'the other run\n');
  const gh = ghAt(clock, mergedFor(ids));

  assert.equal(sweep(gh.run), 'running');

  assert.equal(gh.calls.length, 0);
  assert.equal(fs.readFileSync(guard, 'utf8'), 'the other run\n', 'the other run\'s guard is not this run\'s to remove');
  assert.equal(fs.readFileSync(lock, 'utf8'), 'a run that died\n', 'nor is the lock');
  assert.deepEqual(said, []);
});

test('a guard left by a run that died in the middle of a takeover is cleared, and the takeover goes on', (t) => {
  const { d, ids, clock, said, sweep } = inProcess(t, { held: 1 });
  const lock = deadLock({ d, clock, sweep });
  const guard = `${lock}.takeover`;
  fs.writeFileSync(guard, 'a run that died\n');
  const then = new Date(clock.now - 2 * MINUTE);
  fs.utimesSync(guard, then, then);
  const gh = ghAt(clock, mergedFor(ids));

  assert.equal(sweep(gh.run), 'ran');

  assert.deepEqual(said, ['credited fleet-codex: pull request 71 merged']);
  assert.deepEqual(strays(d), []);
  assert.equal(fs.existsSync(lock), false);
});

test('a run that has the guard and finds the dead lock already gone makes the lock itself', (t) => {
  const { d, ids, clock, said, sweep } = inProcess(t, { held: 1 });
  const lock = deadLock({ d, clock, sweep });
  const looked = fs.statSync;
  let other = false;
  t.mock.method(fs, 'statSync', (...args) => {
    const result = looked(...args);
    if (!other && String(args[0]) === lock) {
      other = true;
      fs.unlinkSync(lock);
    }
    return result;
  });
  const gh = ghAt(clock, mergedFor(ids));

  assert.equal(sweep(gh.run), 'ran');

  assert.equal(other, true);
  assert.deepEqual(said, ['credited fleet-codex: pull request 71 merged']);
  assert.deepEqual(strays(d), []);
  assert.equal(fs.existsSync(lock), false, 'and let it go at the end');
});

test('a run that removes the dead lock but loses the new lock to another run gives the check up, and lets the guard go', (t) => {
  const { d, ids, clock, said, sweep } = inProcess(t, { held: 1 });
  const lock = deadLock({ d, clock, sweep });
  const removed = fs.unlinkSync;
  let other = false;
  t.mock.method(fs, 'unlinkSync', (target) => {
    removed(target);
    if (!other && String(target) === lock) {
      other = true;
      // Between this run's removal of the dead lock and its making of the new one, another run makes its own.
      fs.writeFileSync(lock, 'the other run\n');
    }
  });
  const gh = ghAt(clock, mergedFor(ids));

  assert.equal(sweep(gh.run), 'running');

  assert.equal(other, true, 'the dead lock was removed');
  assert.equal(gh.calls.length, 0);
  assert.equal(fs.readFileSync(lock, 'utf8'), 'the other run\n');
  assert.deepEqual(strays(d), []);
  assert.deepEqual(said, []);
});

test('a dead lock that one run alone finds is taken over, and nothing of the old one is left', (t) => {
  const { d, ids, clock, said, sweep } = inProcess(t, { held: 1 });
  const lock = deadLock({ d, clock, sweep });
  const gh = ghAt(clock, mergedFor(ids));

  assert.equal(sweep(gh.run), 'ran');

  assert.deepEqual(said, ['credited fleet-codex: pull request 71 merged']);
  assert.equal(fs.existsSync(lock), false, 'the new lock was let go at the end');
  assert.deepEqual(strays(d), []);
  assert.equal(d.records().length, 1);
});

test('a lock dated more than a minute ahead, by a clock that was set back, is taken over like an old one', (t) => {
  const { d, ids, clock, said, sweep } = inProcess(t, { held: 1 });
  const lock = deadLock({ d, clock, sweep });
  const ahead = new Date(clock.now + 2 * MINUTE);
  fs.utimesSync(lock, ahead, ahead);
  const gh = ghAt(clock, mergedFor(ids));

  assert.equal(sweep(gh.run), 'ran');

  assert.deepEqual(said, ['credited fleet-codex: pull request 71 merged']);
  assert.deepEqual(strays(d), []);
});

test('a lock the other run lets go just after this run was turned away is made by this run', (t) => {
  const { d, ids, clock, said, sweep } = inProcess(t, { held: 1 });
  const lock = deadLock({ d, clock, sweep });
  const fresh = new Date(clock.now);
  fs.utimesSync(lock, fresh, fresh);
  const looked = fs.statSync;
  let other = false;
  t.mock.method(fs, 'statSync', (...args) => {
    if (!other && String(args[0]) === lock) {
      other = true;
      // The run that held it is over (it failed, so it wrote nothing down) before this run looks at the lock.
      fs.unlinkSync(lock);
    }
    return looked(...args);
  });
  const gh = ghAt(clock, mergedFor(ids));

  assert.equal(sweep(gh.run), 'ran');

  assert.equal(other, true);
  assert.deepEqual(said, ['credited fleet-codex: pull request 71 merged']);
  assert.deepEqual(strays(d), []);
  assert.equal(fs.existsSync(lock), false, 'and let it go at the end');
});

// The same, with real commands: eight start at once on the same dead lock. One takes it over and asks; the other seven
// find the guard or the new lock and go on without a word. The hook tests above are what fail on the old takeover; this
// one is a check that the guard works between real processes and leaves nothing behind.
test('eight commands that start together on one dead lock ask GitHub once, credit once and leave no file behind', async (t) => {
  const d = desk(t);
  const id = d.heldJob('Fix the feedback form', 77);
  d.setGh({ prs: { [pullAt(77)]: openPr(77) } });
  assert.equal(d.cli(['rating', '--json']).status, 0);
  assert.equal(d.records().length, 1);
  d.ago(2 * HOUR);
  const lock = d.lockFile();
  fs.writeFileSync(lock, 'a run that died\n');
  const then = new Date(Date.now() - 2 * MINUTE);
  fs.utimesSync(lock, then, then);
  const before = d.ghCalls().length;
  d.setGh({ prs: { [pullAt(77)]: mergedPr(77) }, hangMs: 1500 });

  const runs = await Promise.all(Array.from({ length: 8 }, (_, i) => d.cliAsync([i % 2 ? 'brief' : 'rating', '--json'])));

  for (const run of runs) {
    assert.equal(run.status, 0, run.stderr);
    assert.doesNotThrow(() => JSON.parse(run.stdout));
  }
  assert.deepEqual(d.ghCalls().slice(before).sort(), [askDefaultBranchCall(), askPullRequestCall(77)].sort(), 'one run asked');
  assert.deepEqual(runs.flatMap((run) => lines(run.stderr)), ['credited fleet-codex: pull request 77 merged'], 'and said once');
  assert.deepEqual(completedEvents(d.db, id).map((event) => event.payload.action), ['merged'], 'one landing on file');
  assert.deepEqual(fs.readdirSync(d.stateFolder).filter((name) => !name.endsWith('.json')), [], 'no lock, guard or other file is left');
});

// ---------------------------------------------------------------------------
// A run that asked GitHub nothing is not written down, so a command that may have a job to ask about is not held off.

// Nothing held is nothing to ask, so it is idle whether or not any of the eight seconds is left.
for (const [spent, when] of [[0, ''], [7000, ', even when the time is gone by then']]) {
  test(`a manual sweep that settles the last held job before the check starts leaves the run nothing to do, and the hour does not start${when}`, (t) => {
    const { d, ids, clock, said, sweep } = inProcess(t, { held: 1 });
    const { askGitHub, askDefaultBranch, sweepHeldJobs } = require('../lib/held-pull-requests');
    const handGh = ghAt(clock, mergedFor(ids));
    const made = fs.mkdirSync;
    let byHand = null;
    // The folder for the record and the lock is made after the first look at the task store and just before the lock is taken.
    t.mock.method(fs, 'mkdirSync', (...args) => {
      const result = made(...args);
      if (byHand === null && String(args[0]) === d.stateFolder) {
        byHand = sweepHeldJobs(tasks, d.db, {
          workspaceRoot: d.dir,
          actor: 'keshav',
          ask: (url) => askGitHub(url, { run: handGh.run }),
          askBranch: (link) => askDefaultBranch(link, { run: handGh.run }),
        });
        clock.now += spent;
      }
      return result;
    });
    const gh = ghAt(clock, mergedFor(ids));
    const seen = watchStore(t);

    const outcome = sweep(gh.run);

    assert.equal(byHand.summary.landed, 1, 'the manual sweep credited the builder first');
    assert.equal(outcome, 'idle');
    assert.equal(seen.numberings.length, 1, 'the manual sweep numbered its job, and the run numbered nothing');
    assert.equal(gh.calls.length, 0, 'the run found no held job and asked GitHub nothing');
    assert.deepEqual(said, []);
    assert.deepEqual(d.records(), [], 'a run that asked nothing holds nothing off');
    assert.deepEqual(d.locks(), []);

    // A new job is handed in, and a following run asks about it.
    const next = d.heldJob('Job 2', 72);
    const later = ghAt(clock, (args) => (args[0] === 'pr' ? mergedPr(numberOf(args), { headRefName: buildBranch(next) }) : null));
    assert.equal(sweep(later.run), 'ran');
    assert.deepEqual(said, ['credited fleet-codex: pull request 72 merged']);
    assert.equal(tasks.getTask(d.db, next).status, 'done');
  });
}

test('a job settled between the run\'s list of held jobs and its question about that job leaves nothing asked, and the hour does not start', (t) => {
  const { d, ids, clock, said, sweep } = inProcess(t, { held: 1 });
  const { askGitHub, askDefaultBranch, sweepHeldJobs } = require('../lib/held-pull-requests');
  const handGh = ghAt(clock, mergedFor(ids));
  const list = tasks.listTasks;
  let lists = 0;
  let settling = false;
  let byHand = null;
  // The run lists the workspace once, and goes from that listing job by job, each job read again just before its question:
  // a manual sweep finishes in between, after the run has the listing in hand.
  t.mock.method(tasks, 'listTasks', (db, options) => {
    const rows = list(db, options);
    if (!settling && options && options.workspaceRoot === d.dir && !options.status) {
      lists += 1;
      if (lists === 1) {
        settling = true;
        try {
          byHand = sweepHeldJobs(tasks, d.db, {
            workspaceRoot: d.dir,
            actor: 'keshav',
            ask: (url) => askGitHub(url, { run: handGh.run }),
            askBranch: (link) => askDefaultBranch(link, { run: handGh.run }),
          });
        } finally {
          settling = false;
        }
      }
    }
    return rows;
  });
  const gh = ghAt(clock, mergedFor(ids));

  const outcome = sweep(gh.run);

  assert.equal(byHand && byHand.summary.landed, 1, 'the manual sweep credited the builder in between');
  assert.equal(outcome, 'idle');
  assert.equal(gh.calls.length, 0);
  assert.deepEqual(said, []);
  assert.deepEqual(d.records(), []);
});

// ---------------------------------------------------------------------------
// Both flights run it, once they are past their disk look, and never on a dry run. (What a pick that reads the results
// after the check sees is pinned at the end.)

async function flyDispatch(d, extra = {}) {
  return fleet.runDispatchFlight({
    root: d.dir,
    taskIds: ['not-a-job-in-this-store'],
    engine: 'codex',
    installedEngines: ['codex'],
    freeSpace: () => 50e9,
    spaceGuard: true,
    ownCli: () => ({ status: 1, stdout: '', stderr: 'no such task' }),
    log: () => {},
    ...extra,
  });
}

function withGhOnPath(d, fn) {
  const saved = { PATH: process.env.PATH, USER: process.env.USER, HOME: process.env.HOME, ATRIS_HELD_SWEEP: process.env.ATRIS_HELD_SWEEP };
  const written = [];
  const write = process.stderr.write;
  const writeSync = fs.writeSync;
  process.env.PATH = `${path.join(d.tools, 'bin')}${path.delimiter}${saved.PATH}`;
  process.env.HOME = d.home;
  delete process.env.ATRIS_HELD_SWEEP;
  // What reaches stderr is caught both ways it can: through the stream, and straight to descriptor 2, which is where the
  // check writes its lines. Writes to any other descriptor go through.
  process.stderr.write = (chunk, ...rest) => { written.push(String(chunk)); return typeof rest.at(-1) === 'function' ? rest.at(-1)() : true; };
  fs.writeSync = (fd, data, ...rest) => {
    if (fd !== 2) return writeSync.call(fs, fd, data, ...rest);
    written.push(String(data));
    return Buffer.byteLength(String(data));
  };
  const done = () => {
    process.stderr.write = write;
    fs.writeSync = writeSync;
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  };
  return Promise.resolve().then(fn).then((out) => { done(); return { out, written }; }, (err) => { done(); throw err; });
}

test('a dispatch flight credits a merged job before it starts anything', async (t) => {
  const d = desk(t);
  const id = d.heldJob('Fix the feedback form', 77);
  d.setGh({ prs: { [pullAt(77)]: mergedPr(77) } });

  const { written } = await withGhOnPath(d, () => flyDispatch(d));

  assert.equal(tasks.getTask(d.db, id).status, 'done');
  assert.deepEqual(written.join('').split('\n').filter((line) => line.startsWith('credited')), ['credited fleet-codex: pull request 77 merged']);
});

test('a dispatch flight under the disk floor writes nothing to any job, not even a credit', async (t) => {
  const d = desk(t);
  const id = d.heldJob('Fix the feedback form', 77);
  d.setGh({ prs: { [pullAt(77)]: mergedPr(77) } });
  const before = snapshot(d.dbPath);

  await withGhOnPath(d, () => flyDispatch(d, { freeSpace: () => 4e9 }));

  assert.deepEqual(snapshot(d.dbPath), before);
  assert.deepEqual(d.ghCalls(), []);
  assert.equal(tasks.getTask(d.db, id).status, 'review');
});

test('a dispatch flight with the check switched off leaves a merged job alone', async (t) => {
  const d = desk(t);
  const id = d.heldJob('Fix the feedback form', 77);
  d.setGh({ prs: { [pullAt(77)]: mergedPr(77) } });

  const saved = process.env.ATRIS_HELD_SWEEP;
  const { written } = await withGhOnPath(d, () => {
    process.env.ATRIS_HELD_SWEEP = 'off';
    return flyDispatch(d);
  }).finally(() => { if (saved === undefined) delete process.env.ATRIS_HELD_SWEEP; else process.env.ATRIS_HELD_SWEEP = saved; });

  assert.deepEqual(d.ghCalls(), []);
  assert.equal(tasks.getTask(d.db, id).status, 'review');
  assert.deepEqual(written.join('').split('\n').filter((line) => line.startsWith('credited')), []);
});

// A fleet flight over one open job that the task list names. The task command and the engine are stand-ins that
// do nothing, so a flight that gets as far as claiming stops there: these tests are about what it does first.
const OPEN_JOB = 'Fix the form so people stop retyping. Done: the form keeps what was typed. Check: node --test test/form.test.js.';
function staffOneJob(d, extra = {}) {
  const file = path.join(d.dir, '.atris', 'state', 'tasks.projection.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ tasks: [{ id: 'a-job-the-store-does-not-hold', display_id: 'BCK-1', workspace_root: d.dir, status: 'open', title: OPEN_JOB, ...extra }] }));
}
function flyFleet(d, extra = {}) {
  return fleet.runFleetFlight({
    root: d.dir,
    engines: ['codex'],
    log: () => {},
    ownCli: () => ({ status: 1, stdout: '', stderr: 'no such task' }),
    dispatcher: () => Promise.resolve({ exitCode: 0, report: '' }),
    lander: () => ({ ok: true, stage: 'shipped' }),
    guardCliLink: () => ({ changed: false, ok: true }),
    freeSpace: () => 50e9,
    spaceGuard: true,
    ...extra,
  });
}
const workTree = (d) => Object.fromEntries(Object.entries(treeOf(d.dir)).filter(([name]) => !name.startsWith('.git')));

test('a fleet flight credits a merged job once it is past the disk look, before it claims anything, and a dry run leaves it alone', async (t) => {
  const d = desk(t);
  const id = d.heldJob('Fix the feedback form', 77);
  d.setGh({ prs: { [pullAt(77)]: mergedPr(77) } });
  staffOneJob(d);
  const before = snapshot(d.dbPath);

  await withGhOnPath(d, () => flyFleet(d, { dryRun: true }));
  assert.deepEqual(snapshot(d.dbPath), before, 'a dry run writes nothing');
  assert.deepEqual(d.ghCalls(), [], 'and asks nothing');

  const seenAtClaim = [];
  const { written } = await withGhOnPath(d, () => flyFleet(d, {
    ownCli: (args) => { seenAtClaim.push([args[1], tasks.getTask(d.db, id).status]); return { status: 1, stdout: '', stderr: 'no such task' }; },
  }));
  assert.deepEqual(seenAtClaim, [['claim', 'done']], 'the credit was made before the flight claimed anything');
  assert.deepEqual(written.join('').split('\n').filter((line) => line.startsWith('credited')), ['credited fleet-codex: pull request 77 merged']);
});

test('a fleet flight under the disk floor writes nothing to any job, not even a credit, and asks GitHub nothing', async (t) => {
  const d = desk(t);
  const id = d.heldJob('Fix the feedback form', 77);
  d.setGh({ prs: { [pullAt(77)]: mergedPr(77) } });
  staffOneJob(d);
  const before = snapshot(d.dbPath);
  const folder = workTree(d);

  const { out } = await withGhOnPath(d, () => flyFleet(d, { freeSpace: () => 4e9 }));

  assert.equal(out.refusal.reason, 'low_disk', 'the flight was refused');
  assert.deepEqual(snapshot(d.dbPath), before, 'nothing was written to any job');
  assert.deepEqual(d.ghCalls(), []);
  assert.equal(tasks.getTask(d.db, id).status, 'review');
  assert.deepEqual(workTree(d), folder, 'and nothing in the workspace');
  assert.equal(fs.existsSync(d.stateFolder), false, 'not even the time of a run');
});

// ---------------------------------------------------------------------------
// What a pick that reads the results after the check sees. The picker reads the results (lib/builder-pick.js) late, only
// when a job needs a pick, and where in a flight that falls depends on the jobs: dealing a free job reads them while the
// flight is staffed, a retry that has to choose a fallback builder reads them when it happens. Only what always holds is
// pinned: a read made after the check sees what the check credited, in that flight (a dispatch flight's fallback pick,
// and a fleet flight's retry when every staffed job names its builder, so that staffing read nothing) or in a later one.
// Each test notes what the one held job looked like each time the picker reads the results.
const DEAD = { exitCode: 1, report: '', stderr: 'Usage limit reached. Purchase more credits.' };

function jobSeenAtEachRead(t, d, id) {
  const season = require('../lib/gm-season');
  const read = season.loadOutcomes;
  const seen = [];
  t.mock.method(season, 'loadOutcomes', (...args) => {
    seen.push(tasks.getTask(d.db, id).status);
    return read(...args);
  });
  return seen;
}

test('a fleet flight that reads the results to deal a free job reads them while it staffs, and a later flight\'s deal reads them with the credit in', async (t) => {
  const d = desk(t);
  const id = d.heldJob('Fix the feedback form', 77);
  d.setGh({ prs: { [pullAt(77)]: mergedPr(77) } });
  staffOneJob(d);
  const seen = jobSeenAtEachRead(t, d, id);

  await withGhOnPath(d, () => flyFleet(d, { engines: ['claude', 'codex'], pick: 'rating' }));

  assert.deepEqual(seen, ['review'], 'dealing the free job read the results while the job was still held');
  assert.equal(tasks.getTask(d.db, id).status, 'done', 'and the check credited it after');

  await withGhOnPath(d, () => flyFleet(d, { engines: ['claude', 'codex'], pick: 'rating' }));

  assert.deepEqual(seen, ['review', 'done'], 'a later flight dealt its free job from results with the credit in them');
});

test('a fleet flight whose staffed jobs all name their builder reads no results to staff them, and a retry reads them after the check, with the credit in', async (t) => {
  const d = desk(t);
  const id = d.heldJob('Fix the feedback form', 77);
  d.setGh({ prs: { [pullAt(77)]: mergedPr(77) } });
  staffOneJob(d, { executed_by: 'claude' });
  const seen = jobSeenAtEachRead(t, d, id);
  const asked = [];
  let readsAtFirstClaim = null;

  await withGhOnPath(d, () => flyFleet(d, {
    engines: ['claude', 'codex'],
    pick: 'rating',
    ownCli: (args) => {
      if (args[1] === 'claim' && readsAtFirstClaim === null) readsAtFirstClaim = seen.length;
      if (args[0] === 'worktree' && args[1] === 'start') return { status: 0, stdout: `next: cd ${d.dir}/wt-1\n`, stderr: '' };
      return { status: 0, stdout: 'ok', stderr: '' };
    },
    dispatcher: (entry) => {
      asked.push(entry.engine);
      return Promise.resolve(entry.engine === 'claude' ? DEAD : { exitCode: 0, report: 'built it' });
    },
    scoutAsk: false,
  }));

  assert.deepEqual(asked, ['claude', 'codex'], 'the job went to the builder it names, which was dead, so the flight went looking for another');
  assert.equal(readsAtFirstClaim, 0, 'staffing needed no results: the job names its builder');
  assert.deepEqual(seen, ['done'], 'the retry read the results after the check had credited the job');
  assert.equal(tasks.getTask(d.db, id).status, 'done');
});

test('a dispatch flight\'s fallback pick reads the results after the check, with the credit in', async (t) => {
  const d = desk(t);
  const id = d.heldJob('Fix the feedback form', 77);
  d.setGh({ prs: { [pullAt(77)]: mergedPr(77) } });
  const seen = jobSeenAtEachRead(t, d, id);
  const asked = [];
  const job = { id: 'row-900', display_id: 'CLI-900', workspace_root: d.dir, status: 'open', tag: 'cli', title: `${OPEN_JOB} Edits lib/form.js` };

  await withGhOnPath(d, () => flyDispatch(d, {
    taskIds: ['CLI-900'],
    installedEngines: ['codex', 'claude'],
    pick: 'rating',
    ownCli: (args) => {
      if (args[0] === 'task' && args[1] === 'show') return { status: 0, stdout: JSON.stringify(job), stderr: '' };
      if (args[0] === 'worktree' && args[1] === 'start') return { status: 0, stdout: `next: cd ${d.dir}/wt-900\n`, stderr: '' };
      return { status: 0, stdout: 'done: worktree shipped\n', stderr: '' };
    },
    dispatcher: (entry) => {
      asked.push(entry.engine);
      return Promise.resolve(entry.engine === 'codex' ? DEAD : { exitCode: 0, report: 'built it' });
    },
    scoutAsk: false,
    rebase: () => ({ ok: true, stage: 'rebased' }),
    verifier: () => ({ status: 0, stdout: '# pass 1\n', stderr: '' }),
  }));

  assert.deepEqual(asked, ['codex', 'claude'], 'the first engine was dead, so the flight went looking for another');
  assert.equal(tasks.getTask(d.db, id).status, 'done');
  assert.deepEqual(seen, ['done'], 'the picker first read the results after the check had credited the job');
});
