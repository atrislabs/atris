'use strict';

// A held job is work that is done and whose pull request waits for a person to land it. It
// sits in Review under the builder's name with the pull request open on the row. When a
// person merged that pull request on GitHub, by any method, nothing in the task store heard
// about it: the job stayed in Review, the rating showed it held forever, and the builder was
// never credited.
//
// `atris task sweep --held` asks GitHub about each held job and writes down what happened.
//   merged:  the merge is recorded the way any landed merge is recorded, the job closes as
//            done with the action "merged", and the original claimant is credited as landed.
//            It is not a review pass and it certifies nothing. The landing is dated at the
//            merge, not at the sweep.
//   closed:  the pull request is recorded as closed and the claim is released with the
//            reason "pull request closed without landing: <url>". That rates as a miss.
//   open:    nothing changes.
// Before it writes either, it proves the pull request is this job's own build: in the
// repository the job's workspace came from, with its branch in that repository too, on a branch
// that carries the job's row id and no other job's, not claimed by another job, and (for a merge)
// merged after the claim now on the job began and into the repository's default branch. A link
// anyone can write on a row proves nothing by itself.
// Anyone may run it, agents included, because GitHub is the only source. These tests use a
// fake gh on the PATH, the real task store, the real command line and the real rating.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const tasks = require('../lib/task-db');
const { loadSeason, rosterRows } = require('../lib/gm-season');
const { ratingCommand } = require('../commands/rating');
const { scrubAgentEnv } = require('./helpers/agent-env');

const CLI = path.resolve(__dirname, '..', 'bin', 'atris.js');
const COMMIT = '93b6d4bcf66276bbd6a53aebe72ab48bf9a7b136';
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
// Every desk is a git checkout whose origin remote is this repository, and the pull requests its
// jobs name are pull requests of this repository.
const REPO = 'acme/widgets';
const ORIGIN = `git@github.com:${REPO}.git`;
// gh prints a time to the second, in UTC.
const ghTime = (ms) => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace('.000Z', 'Z');
// The desk's jobs were claimed three hours ago, and a person merged their pull requests an hour ago.
const CLAIMED_AGO = 3 * HOUR;
const MERGED_AT = ghTime(Date.now() - HOUR);
const FIELDS = 'state,mergeCommit,mergedAt,mergedBy,number,url,headRefName,headRepository,headRepositoryOwner,baseRefName';
const AGENT_SESSION = { CLAUDECODE: '1', CODEX_SANDBOX: 'seatbelt', ATRIS_MISSION_DRIVER_DETACHED: '1' };

const pullAt = (number, repo = REPO) => `https://github.com/${repo}/pull/${number}`;
// The repository a pull request link is in, as a link, and the question the sweep asks about it.
const repoLink = (repo = REPO) => `https://github.com/${repo}`;
const askDefaultBranchCall = (repo = REPO) => `repo view ${repoLink(repo)} --json defaultBranchRef`;
// The branch a dispatch flight builds a job on: the job's row id, lowercased, as one word.
const buildBranch = (id, stamp = '20261030-171500') => `codex/codex-dispatch-${String(id).toLowerCase()}-${stamp}`;

// What `gh pr view <url> --json ...` prints for a pull request in each state. The branch is not
// here: the desk fills in the branch of the job that named the pull request (see setGh), unless
// the test gives one. The branch lives in the repository the pull request's link is in and went
// to that repository's default branch, unless the test says otherwise.
const placed = (number, extra) => {
  const [, owner, name] = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\//.exec(extra.url || pullAt(number)) || [];
  return { baseRefName: 'main', headRepository: { name }, headRepositoryOwner: { login: owner } };
};
const mergedPr = (number, extra = {}) => ({ state: 'MERGED', number, url: pullAt(number), mergeCommit: { oid: COMMIT }, mergedAt: MERGED_AT, mergedBy: { login: 'keshav', is_bot: false }, ...placed(number, extra), ...extra });
const closedPr = (number, extra = {}) => ({ state: 'CLOSED', number, url: pullAt(number), mergeCommit: null, mergedAt: null, mergedBy: null, ...placed(number, extra), ...extra });
const openPr = (number, extra = {}) => ({ state: 'OPEN', number, url: pullAt(number), mergeCommit: null, mergedAt: null, mergedBy: null, ...placed(number, extra), ...extra });

const held = () => require('../lib/held-pull-requests');

// ---------------------------------------------------------------------------
// A workspace with a real task database, a fake gh, and the real command line.
//
// The fake gh answers `pr view <url> --json <fields>` and `repo view <url> --json <fields>` from a
// file the test writes, prints only the fields it was asked for (so asking for too few fields
// shows up), and writes down every call. A url with a failure entry exits 1 and says that on
// stderr, as gh does.

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
  return dir;
}

// git in a folder, with none of the repository variables a hook or a parent git leaves in the
// environment, and a failure is a failed test.
function gitIn(dir, ...args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  const done = spawnSync('git', args, { cwd: dir, encoding: 'utf8', env });
  assert.equal(done.status, 0, `git ${args.join(' ')}: ${done.stderr}`);
  return done.stdout;
}

// A folder that is a git checkout with an origin remote, the way a workspace is. The sweep reads
// that remote to learn which repository a job's pull request must be in.
function repoAt(dir, remote = ORIGIN) {
  gitIn(dir, 'init', '-q');
  gitIn(dir, 'remote', 'add', 'origin', remote);
  return dir;
}

function desk(t) {
  // The CLI records the real path of its folder, which is not the /var alias macOS gives mkdtemp.
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'held-sweep-')));
  const tools = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'held-sweep-tools-')));
  fs.mkdirSync(path.join(dir, 'atris'));
  repoAt(dir);
  const dbPath = path.join(dir, 'tasks.db');
  const saved = process.env.ATRIS_TASKS_DB;
  process.env.ATRIS_TASKS_DB = dbPath;
  const db = tasks.open(dbPath);
  t.after(() => {
    tasks.close();
    if (saved === undefined) delete process.env.ATRIS_TASKS_DB; else process.env.ATRIS_TASKS_DB = saved;
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(tools, { recursive: true, force: true });
  });
  assert.equal(tasks.workspaceRoot(dir), dir, 'the folder is its own workspace');

  const bin = path.join(tools, 'bin');
  fs.mkdirSync(bin);
  const ghLog = path.join(tools, 'gh.log');
  const ghSetup = path.join(tools, 'gh.json');
  fs.writeFileSync(path.join(bin, 'gh'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(ghLog)}, args.join(' ') + '\\n');
const setup = fs.existsSync(${JSON.stringify(ghSetup)}) ? JSON.parse(fs.readFileSync(${JSON.stringify(ghSetup)}, 'utf8')) : {};
if (setup.vanishAfter && fs.readFileSync(${JSON.stringify(ghLog)}, 'utf8').split('\\n').filter(Boolean).length >= setup.vanishAfter) fs.unlinkSync(process.argv[1]);
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
// GitHub names are not case sensitive, so a repository is found however its link is spelled.
const repoNamed = Object.keys(setup.repos || {}).find((key) => key.toLowerCase() === String(url).toLowerCase());
const known = command === 'pr view' ? (setup.prs || {})[url] : (setup.repos || {})[repoNamed];
if (!known) {
  console.error(command === 'pr view'
    ? 'GraphQL: Could not resolve to a PullRequest with the number given. (repository.pullRequest)'
    : 'GraphQL: Could not resolve to a Repository with the name given. (repository)');
  process.exit(1);
}
const shown = {};
for (const field of fields) if (field in known) shown[field] = known[field];
console.log(JSON.stringify(shown));
`, { mode: 0o755 });
  // Which job first named each pull request link. GitHub reports a pull request on the branch the
  // flight built it from, which carries that job's row id, so a pull request the test gives no
  // branch to is put on its job's branch. A test that gives a branch, even none, keeps it.
  const namedBy = new Map();
  // `repos` answers `gh repo view <link> --json defaultBranchRef`. The desk's repository lands on
  // main unless the test says otherwise; a test gives its own entry, or null for one gh cannot find.
  const setGh = (setup) => {
    const prs = {};
    for (const [url, pr] of Object.entries(setup.prs || {})) {
      prs[url] = pr && typeof pr === 'object' && !('headRefName' in pr) && namedBy.has(url) ? { ...pr, headRefName: buildBranch(namedBy.get(url)) } : pr;
    }
    const repos = { [repoLink()]: { defaultBranchRef: { name: 'main' } }, ...(setup.repos || {}) };
    fs.writeFileSync(ghSetup, JSON.stringify({ ...setup, prs, repos }));
  };
  const ghCalls = () => (fs.existsSync(ghLog) ? fs.readFileSync(ghLog, 'utf8').split('\n').filter(Boolean) : []);
  const noGh = onlyGit(tools);

  // attempt answers whatever the command did; run insists it worked. withoutGh runs the
  // command on a PATH with no gh at all; fakeGhOnly on a PATH with only the fake gh and git.
  const attempt = (args, { env = {}, withoutGh = false, fakeGhOnly = false } = {}) => spawnSync(process.execPath, [CLI, ...args], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 60000,
    env: {
      ...scrubAgentEnv(),
      ...env,
      PATH: withoutGh ? noGh : fakeGhOnly ? `${bin}${path.delimiter}${noGh}` : `${bin}${path.delimiter}${process.env.PATH}`,
      ATRIS_TASKS_DB: dbPath,
      ATRIS_SKIP_UPDATE_CHECK: '1',
      NODE_NO_WARNINGS: '1',
    },
  });
  const run = (args, options) => {
    const result = attempt(args, options);
    assert.equal(result.status, 0, `${args.join(' ').slice(0, 120)}: ${result.stderr || result.stdout}`);
    return result;
  };
  const sweep = (...extra) => run(['task', 'sweep', '--held', '--as', 'keshav', ...extra]);
  const sweepJson = (...extra) => JSON.parse(sweep('--json', ...extra).stdout);

  // Move one job's whole attempt back in time: its claim, its rows and its events.
  const backdate = (id, ms) => {
    db.prepare('UPDATE tasks SET claimed_at = claimed_at - ?, created_at = created_at - ?, updated_at = updated_at - ? WHERE id = ?').run(ms, ms, ms, id);
    db.prepare('UPDATE task_events SET created_at = created_at - ? WHERE task_id = ?').run(ms, id);
  };

  // A job the flight built in a protected lane: claimed (three hours ago, unless told otherwise),
  // then sent to Review with its open pull request and no merge commit.
  const heldJob = (title, number, { builder = 'fleet-codex', root = dir, repo = REPO, ready = {}, claimedAgo = CLAIMED_AGO } = {}) => {
    const url = pullAt(number, repo);
    const { id } = tasks.addTask(db, { title, tag: 'feedback', workspaceRoot: root });
    assert.equal(tasks.claimTask(db, { id, claimedBy: builder, leaseMinutes: 60, leasePid: process.pid }).claimed, true);
    const readied = tasks.readyTask(db, {
      id,
      actor: builder,
      proof: 'Built and verified; the pull request waits for a person to land it.',
      merge: { number: String(number), url },
      ...ready,
    });
    assert.equal(readied.ready, true);
    if (!namedBy.has(url)) namedBy.set(url, id);
    backdate(id, claimedAgo);
    return id;
  };
  return { dir, dbPath, db, bin, tools, setGh, ghCalls, attempt, run, sweep, sweepJson, heldJob, backdate };
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

// Every file and folder under the workspace except the database itself, with what is in the files.
function treeOf(dir) {
  const out = {};
  const walk = (folder) => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) {
        out[`${path.relative(dir, full)}/`] = '';
        walk(full);
      } else if (!/^tasks\.db/.test(entry.name)) {
        out[path.relative(dir, full)] = fs.readFileSync(full, 'utf8');
      }
    }
  };
  walk(dir);
  return out;
}

const eventsOf = (db, id) => db.prepare('SELECT event_type, actor, payload FROM task_events WHERE task_id = ? ORDER BY version').all(id)
  .map((row) => ({ type: row.event_type, actor: row.actor, payload: row.payload ? JSON.parse(row.payload) : null }));
const eventTypes = (db, id) => eventsOf(db, id).map((event) => event.type);

// The rows and events of some jobs, so "changed nothing" can be proved for just those.
const rowsOf = (snap, ids) => ({ tasks: snap.tasks.filter((r) => ids.includes(r.id)), events: snap.events.filter((e) => ids.includes(e.task_id)) });
const escapeRe = (text) => String(text).replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

// The real rating, read the way `atris rating` and `atris gm` read it.
const seasonOf = (dir, dbPath) => {
  const season = loadSeason(dir, { dbPath, now: Date.now() + 1000, lastSeen: null });
  assert.equal(season.error, undefined);
  return season;
};
const playsOf = (season, id) => season.outcomes.filter((o) => o.task_id === id);
const memberRow = (season, name) => rosterRows({ outcomes: season.outcomes, limit: Number.MAX_SAFE_INTEGER }).find((row) => row.name === name);
const ratingOf = (dir, season, ...args) => {
  let out = '';
  assert.equal(ratingCommand(args, { root: dir, season, lineup: null, write: (s) => { out += s; } }), 0);
  return out;
};

// Take a job for a builder (open to claimed).
const claimFor = (db, id, by) => assert.equal(tasks.claimTask(db, { id, claimedBy: by, leaseMinutes: 60, leasePid: process.pid }).claimed, true);
// The name a job goes by in the sweep's lines: its display id, else its older short ref, else its row id.
const refOf = (db, id) => {
  const row = tasks.getTask(db, id);
  const [shown] = tasks.withTaskDisplayRefs([row], tasks.listTasks(db, { workspaceRoot: row.workspace_root }));
  return shown.display_id || shown.legacy_ref || shown.id;
};

// ---------------------------------------------------------------------------
// Merged.

test('a pull request a person squash-merged lands the job and credits the builder through the real rating, with no review pass', (t) => {
  const d = desk(t);
  const id = d.heldJob('Fix the feedback form', 77);
  const before = tasks.getTask(d.db, id);
  assert.equal(before.status, 'review');
  assert.equal(before.metadata.agent_review_pass_count, 1, 'the builder\'s own ready is the one pass on file');
  assert.deepEqual(playsOf(seasonOf(d.dir, d.dbPath), id).map((o) => o.kind), ['took'], 'nothing says it landed yet');
  d.setGh({ prs: { [pullAt(77)]: mergedPr(77) } });

  const report = d.sweepJson();

  // It asked GitHub about the exact link on the row, once, and which branch the repository lands on.
  assert.deepEqual(d.ghCalls(), [`pr view ${pullAt(77)} --json ${FIELDS}`, askDefaultBranchCall()]);
  assert.equal(report.ok, true);
  assert.equal(report.action, 'sweep_held');
  assert.equal(report.dry_run, false);
  assert.equal(report.summary.landed, 1);
  assert.equal(report.results.length, 1);
  assert.equal(report.results[0].task_id, id);
  assert.equal(report.results[0].outcome, 'merged');
  assert.equal(report.results[0].action, 'landed');
  assert.equal(report.results[0].builder, 'fleet-codex');

  // The merge is recorded the way a landed merge is: commit, state merged, merged at, and who merged it.
  const row = tasks.getTask(d.db, id);
  assert.equal(row.status, 'done');
  assert.equal(row.claimed_by, 'fleet-codex', 'the claimant stays on the row');
  assert.ok(row.done_at > 0);
  assert.equal(row.metadata.merge_commit, COMMIT);
  assert.deepEqual(row.metadata.pull_request, { state: 'merged', merge_commit: COMMIT, number: 77, url: pullAt(77), merged_at: MERGED_AT, merged_by: 'keshav' });

  // It is not a review pass and it certifies nothing: the review record is exactly what it was.
  for (const key of ['agent_review_pass_count', 'agent_reviewed_by', 'agent_reviewed_at', 'agent_review_actors', 'built_by', 'approval_status', 'latest_agent_proof']) {
    assert.deepEqual(row.metadata[key], before.metadata[key], key);
  }
  for (const key of ['agent_certified', 'agent_certified_at', 'agent_certified_by', 'agent_certification_policy', 'independent_review_by', 'accepted_at', 'accepted_by']) {
    assert.equal(row.metadata[key], undefined, key);
  }
  assert.deepEqual(eventTypes(d.db, id), ['created', 'claimed', 'proof_ready', 'completed']);
  const completed = eventsOf(d.db, id).pop();
  assert.equal(completed.actor, 'keshav', 'the event says who ran the check');
  assert.equal(completed.payload.status, 'done');
  assert.equal(completed.payload.action, 'merged');
  assert.equal(completed.payload.auto_accepted, undefined);
  assert.equal(completed.payload.self_landed, undefined);
  assert.deepEqual(completed.payload.pull_request, row.metadata.pull_request);
  assert.equal(completed.payload.landed_at, MERGED_AT, 'the event says when the merge happened, not when the sweep ran');

  // The real rating: the original claimant landed it, and a person's merge is not an autoland.
  const season = seasonOf(d.dir, d.dbPath);
  const plays = playsOf(season, id);
  assert.deepEqual(plays.map((o) => o.kind), ['took', 'landed']);
  assert.equal(plays[1].member, 'fleet-codex');
  assert.equal(plays[1].landed_by, 'you');
  assert.equal(plays[1].at, Date.parse(MERGED_AT), 'the rating dates the landing at the merge');
  const builder = memberRow(season, 'fleet-codex');
  assert.deepEqual([builder.landed, builder.finished, builder.dropped, builder.held], [1, 1, 0, 0]);
  assert.equal(memberRow(season, 'keshav'), undefined, 'the one who ran the check takes no credit and no miss');
  const card = JSON.parse(ratingOf(d.dir, season, 'fleet-codex', '--json')).member;
  assert.deepEqual([card.landed, card.finished], [1, 1]);
  assert.equal(card.waiting_on_pull_request, undefined, 'a landed job is no longer waiting');
  assert.doesNotMatch(ratingOf(d.dir, season, 'fleet-codex'), /atris task sweep --held/);

  // The text a person reads says what happened.
  const second = d.heldJob('Fix the billing page', 78);
  d.setGh({ prs: { [pullAt(78)]: mergedPr(78, { mergedBy: { login: 'harman' } }) } });
  const text = d.sweep().stdout;
  assert.match(text, /^held jobs: 1 checked against GitHub$/m);
  assert.match(text, /^landed \S+ Fix the billing page: pull request 78 was merged by harman; fleet-codex is credited$/m);
  assert.equal(tasks.getTask(d.db, second).status, 'done');
});

test('a merge GitHub reports with no merger still lands the job, and a merger that does not look like a login is not kept', (t) => {
  const d = desk(t);
  const nobody = d.heldJob('Queue merged one', 81);
  const odd = d.heldJob('Odd merger one', 82);
  d.setGh({ prs: {
    [pullAt(81)]: mergedPr(81, { mergedBy: null }),
    [pullAt(82)]: mergedPr(82, { mergedBy: { login: 'two words\nand a line' } }),
  } });

  const report = d.sweepJson();

  assert.equal(report.summary.landed, 2);
  const byId = Object.fromEntries(report.results.map((r) => [r.task_id, r]));
  assert.equal(byId[nobody].detail, 'pull request 81 was merged; fleet-codex is credited');
  assert.equal(byId[odd].detail, 'pull request 82 was merged; fleet-codex is credited');
  for (const id of [nobody, odd]) {
    const row = tasks.getTask(d.db, id);
    assert.equal(row.status, 'done');
    assert.equal(row.metadata.pull_request.state, 'merged');
    assert.equal(row.metadata.pull_request.merge_commit, COMMIT);
    assert.equal(row.metadata.pull_request.merged_at, MERGED_AT);
    assert.equal(row.metadata.pull_request.merged_by, undefined);
  }
});

test('running the sweep again credits nothing twice', (t) => {
  const d = desk(t);
  const id = d.heldJob('Fix the feedback form', 77);
  d.heldJob('Fix the billing page', 78);
  d.setGh({ prs: { [pullAt(77)]: mergedPr(77), [pullAt(78)]: closedPr(78) } });
  d.sweep();
  const calls = d.ghCalls().length;
  const settled = snapshot(d.dbPath);

  const again = d.sweepJson();

  assert.equal(again.results.length, 0, 'nothing is held any more');
  assert.equal(d.ghCalls().length, calls, 'and GitHub is not asked again');
  assert.deepEqual(snapshot(d.dbPath), settled);
  assert.equal(memberRow(seasonOf(d.dir, d.dbPath), 'fleet-codex').landed, 1);
  assert.equal(playsOf(seasonOf(d.dir, d.dbPath), id).filter((o) => o.kind === 'landed').length, 1);
});

// ---------------------------------------------------------------------------
// Proving the pull request is this job's own build. The link on a row is whatever a builder
// wrote there, so before the sweep credits a merge or releases a claim it checks, from what
// GitHub itself says, that the pull request is in the repository the job's workspace came from,
// on a branch that carries the job's row id, and (for a merge) merged after the claim now on the
// job began. If any check fails nothing is written and one plain line says why.

const BRANCH_OF_ANOTHER_JOB = 'codex/codex-dispatch-01k8x3m2q4abcdefghjkmnpqrs-20261030-171500';
const notBuild = (why) => new RegExp(`^\\S+'s recorded pull request is not this job's build: ${why}$`);

test('a pull request in another repository is not this job\'s build, and GitHub\'s own link says which repository it is in', (t) => {
  const d = desk(t);
  // The row names a pull request in someone else's repository. GitHub says it merged, on a branch with the job's id.
  const foreign = d.heldJob('Fix the feedback form', 77, { repo: 'someone/else' });
  // The row's link says this repository, but GitHub's own link for that pull request is in another one.
  const moved = d.heldJob('Fix the billing page', 78);
  // The row's link has the repository's old name, and GitHub spells the pull request's link the current way.
  const renamed = d.heldJob('Fix the invoice page', 79, { repo: 'old-owner/widgets' });
  d.setGh({ prs: {
    [pullAt(77, 'someone/else')]: mergedPr(77, { url: pullAt(77, 'someone/else') }),
    [pullAt(78)]: mergedPr(78, { url: pullAt(78, 'elsewhere/place') }),
    [pullAt(79, 'old-owner/widgets')]: mergedPr(79),
  } });
  const before = snapshot(d.dbPath);
  const filesBefore = treeOf(d.dir);

  // A dry run proves it too, and says it would not land them.
  const dry = JSON.parse(d.run(['task', 'sweep', '--held', '--dry-run', '--as', 'keshav', '--json']).stdout);
  const dryBy = Object.fromEntries(dry.results.map((r) => [r.task_id, r.action]));
  assert.deepEqual([dryBy[foreign], dryBy[moved], dryBy[renamed]], ['refused', 'refused', 'would_land']);
  assert.deepEqual(snapshot(d.dbPath), before);
  assert.deepEqual(treeOf(d.dir), filesBefore);

  const report = d.sweepJson();

  assert.equal(report.ok, true);
  assert.deepEqual([report.summary.landed, report.summary.refused], [1, 2]);
  const byId = Object.fromEntries(report.results.map((r) => [r.task_id, r]));
  assert.deepEqual([byId[foreign].outcome, byId[foreign].action], ['merged', 'refused']);
  assert.deepEqual([byId[moved].outcome, byId[moved].action], ['merged', 'refused']);
  assert.match(byId[foreign].detail, notBuild(escapeRe("it is in someone/else, and this workspace's origin is acme/widgets")));
  assert.match(byId[moved].detail, notBuild(escapeRe("it is in elsewhere/place, and this workspace's origin is acme/widgets")));
  assert.equal(byId[renamed].action, 'landed');
  assert.deepEqual(rowsOf(snapshot(d.dbPath), [foreign, moved]), rowsOf(before, [foreign, moved]), 'not one row or event of the refused jobs changed');
  assert.equal(tasks.getTask(d.db, foreign).status, 'review');
  assert.equal(tasks.getTask(d.db, renamed).status, 'done');
  assert.equal(tasks.getTask(d.db, renamed).metadata.pull_request.url, pullAt(79), 'the record keeps GitHub\'s own link');
  const season = seasonOf(d.dir, d.dbPath);
  assert.deepEqual(playsOf(season, foreign).map((o) => o.kind), ['took']);
  assert.deepEqual(playsOf(season, moved).map((o) => o.kind), ['took']);
  assert.deepEqual(playsOf(season, renamed).map((o) => o.kind), ['took', 'landed']);

  // The text says why, in one line per job, led by the job's own name.
  const lines = d.sweep().stdout.split('\n').filter((line) => /is not this job's build/.test(line));
  assert.equal(lines.length, 2);
  assert.ok(lines.every((line) => notBuild('it is in .+').test(line)), lines.join('\n'));
});

test('a workspace whose origin cannot be read as a GitHub repository proves nothing', (t) => {
  const d = desk(t);
  const other = repoAt(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'held-sweep-other-'))), '/srv/git/widgets.git');
  t.after(() => fs.rmSync(other, { recursive: true, force: true }));
  const noOrigin = d.heldJob('Fix the feedback form', 77);
  const notGitHub = d.heldJob('Fix the billing page', 78, { root: other });
  gitIn(d.dir, 'remote', 'remove', 'origin');
  d.setGh({ prs: { [pullAt(77)]: mergedPr(77), [pullAt(78)]: mergedPr(78) } });
  const before = snapshot(d.dbPath);

  const report = d.sweepJson('--everywhere');

  const byId = Object.fromEntries(report.results.map((r) => [r.task_id, r]));
  for (const id of [noOrigin, notGitHub]) {
    assert.deepEqual([byId[id].outcome, byId[id].action], ['merged', 'refused'], id);
    assert.match(byId[id].detail, notBuild(escapeRe("this workspace's origin remote could not be read as a GitHub repository")), id);
  }
  assert.deepEqual(snapshot(d.dbPath), before);
});

test('the repository is compared the way GitHub spells it: any case, and any ordinary way of writing the origin', (t) => {
  const d = desk(t);
  // The same repository, written as a remote in the ways remotes are written (an ssh alias in front of
  // github.com is one of them), against GitHub's own link for the pull request spelled in another case.
  const sameRepo = [
    ['https://github.com/Acme/Widgets.git', 'ACME/widgets'],
    ['https://someone@github.com/acme/widgets', 'acme/WIDGETS'],
    ['ssh://git@github.com/Acme/Widgets.git', 'acme/widgets'],
    ['ssh://git@github.com:22/acme/widgets/', 'acme/widgets'],
    ['git@Github.com:ACME/WIDGETS.git', 'acme/widgets'],
    ['git@work-github:acme/widgets.git', 'acme/widgets'],
  ];
  // Not an address with an owner and a name after the host, and nothing else.
  const notARepository = ['https://github.com/acme', 'https://github.com/acme/widgets/extra', 'file:///srv/git/widgets.git'];
  let number = 70;
  const sweepWith = (remote, spelled) => {
    gitIn(d.dir, 'remote', 'set-url', 'origin', remote);
    number += 1;
    const id = d.heldJob(`Case ${number}`, number);
    d.setGh({ prs: { [pullAt(number)]: mergedPr(number, { url: pullAt(number, spelled) }) } });
    return d.sweepJson().results.find((r) => r.task_id === id);
  };

  for (const [remote, spelled] of sameRepo) {
    assert.equal(sweepWith(remote, spelled).action, 'landed', `${remote} against ${spelled}`);
  }
  for (const remote of notARepository) {
    const result = sweepWith(remote, 'acme/widgets');
    assert.equal(result.action, 'refused', remote);
    assert.match(result.detail, notBuild(escapeRe("this workspace's origin remote could not be read as a GitHub repository")), remote);
  }
});

test('the origin is read from the workspace folder itself, whatever repository a parent git left in the environment', (t) => {
  const { originRepoOf } = held();
  const folder = (remote) => {
    const dir = repoAt(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'held-sweep-origin-'))), remote);
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
  };
  const mine = folder('git@github.com:acme/widgets.git');
  const theirs = folder('git@github.com:elsewhere/place.git');
  assert.equal(originRepoOf(mine), 'acme/widgets');
  assert.equal(originRepoOf(path.join(mine, 'no-such-folder')), null, 'a folder that is not there says nothing');
  assert.equal(originRepoOf(''), null);
  assert.equal(originRepoOf(null), null);

  // A hook, or a git that ran this one, leaves the repository it is working in in the environment.
  const saved = { GIT_DIR: process.env.GIT_DIR, GIT_WORK_TREE: process.env.GIT_WORK_TREE };
  process.env.GIT_DIR = path.join(theirs, '.git');
  process.env.GIT_WORK_TREE = theirs;
  try {
    assert.equal(originRepoOf(mine), 'acme/widgets', 'not the origin of the repository the environment points at');
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test('a branch is matched by one whole row id and only that job\'s: a short word, a second id, or the same id twice match nothing', () => {
  const { branchNamesJob } = held();
  const id = '01K8X3M2Q4ABCDEFGHJKMNPQRS';
  const mine = id.toLowerCase();
  const another = '01k8x3m2q4abcdefghjkmnpqrt';
  assert.equal(branchNamesJob(`codex/codex-dispatch-${mine}-20261030-171500`, id), true);
  assert.equal(branchNamesJob(id, mine), true, 'the case of either does not matter');
  assert.equal(branchNamesJob('', id), false);
  assert.equal(branchNamesJob(null, id), false);
  // A short word could be any word in a branch name.
  for (const short of ['', null, undefined, 'fix', '12345', 'a'.repeat(15)]) {
    assert.equal(branchNamesJob(`fix/${short}-1 ${short}`, short), false, `an id of ${JSON.stringify(short)}`);
  }
  // Only a row id's own shape is a row id: 26 characters of the alphabet row ids are written in
  // (digits and letters, never i, l, o or u). A job whose id is not that shape binds nothing.
  assert.equal(branchNamesJob(`fix/${'a'.repeat(30)}`, 'a'.repeat(30)), false, 'thirty characters is not a row id');
  assert.equal(branchNamesJob(`fix/${'a'.repeat(16)}`, 'a'.repeat(16)), false, 'neither is sixteen');
  assert.equal(branchNamesJob(`fix/${'a'.repeat(25)}l`, `${'a'.repeat(25)}l`), false, 'l is not in the alphabet');
  // One id, and it is this job's. Another id beside it, in either order, or this one twice, binds nothing.
  assert.equal(branchNamesJob(`codex/${mine}-${another}`, id), false);
  assert.equal(branchNamesJob(`codex/${another}-${mine}`, id), false);
  assert.equal(branchNamesJob(`codex/${mine}-${mine}`, id), false);
  assert.equal(branchNamesJob(`codex/${another}`, id), false, 'another job\'s id alone');
  // Words that are not the shape of a row id are only words.
  for (const word of ['a'.repeat(25), 'a'.repeat(27), `${'a'.repeat(25)}i`, '20261030', 'dispatch']) {
    assert.equal(branchNamesJob(`codex/${word}-${mine}-${word}`, id), true, word);
  }
});

test('a pull request whose branch does not carry the job\'s own id, and only its own, is not its build', (t) => {
  const d = desk(t);
  const cases = [];
  const MISSING = "does not carry this job's id";
  const SEVERAL = 'carries more than one job id';
  const job = (label, number, branchOf, lands, why = MISSING) => {
    const id = d.heldJob(`Case: ${label}`, number);
    cases.push({ id, label, number, branch: branchOf(id), lands, why });
  };
  job('the branch of another job', 71, () => BRANCH_OF_ANOTHER_JOB, false);
  job('a branch named for the display ref, as flights used to', 72, () => 'codex/codex-dispatch-feed-12-20261030-171500', false);
  job('the id glued onto the end of a longer word', 73, (id) => `codex/codex-dispatch-${id.toLowerCase()}x-20261030-171500`, false);
  job('the id glued behind letters', 74, (id) => `codex/codex-dispatch-x${id.toLowerCase()}-20261030-171500`, false);
  job('only the start of the id', 75, (id) => `codex/codex-dispatch-${id.toLowerCase().slice(0, 20)}-20261030-171500`, false);
  job('a branch with no id in it', 76, () => 'main', false);
  job('no branch given at all', 77, () => undefined, false);
  job('the id as a whole word in a hand-named branch, upper case as the store spells it', 78, (id) => `fix/${id}`, true);
  job('the id alone', 79, (id) => id.toLowerCase(), true);
  // A branch is one job's build. Its own id beside another job's, in either order, says it is two jobs'.
  job('its own id and another job\'s after it', 80, (id) => `${buildBranch(id)}-01k8x3m2q4abcdefghjkmnpqrs`, false, SEVERAL);
  job('another job\'s id and its own after it', 81, (id) => `codex/codex-dispatch-01k8x3m2q4abcdefghjkmnpqrs-${id.toLowerCase()}-20261030-171500`, false, SEVERAL);
  job('its own id twice', 82, (id) => `${buildBranch(id)}-${id.toLowerCase()}`, false, SEVERAL);
  // Only the shape of a row id counts as one. Words around the id that are not that shape are words.
  job('its own id among words that are not row ids', 83, (id) => `codex/${'a'.repeat(25)}-${id.toLowerCase()}-${'b'.repeat(27)}-${'a'.repeat(25)}l`, true);
  d.setGh({ prs: Object.fromEntries(cases.map((c) => [pullAt(c.number), mergedPr(c.number, { headRefName: c.branch })])) });
  const before = snapshot(d.dbPath);

  const report = d.sweepJson();

  const byId = Object.fromEntries(report.results.map((r) => [r.task_id, r]));
  for (const c of cases) {
    assert.equal(byId[c.id].action, c.lands ? 'landed' : 'refused', c.label);
    if (c.lands) continue;
    assert.equal(byId[c.id].outcome, 'merged', c.label);
    assert.match(byId[c.id].detail, notBuild(escapeRe(`its branch (${c.branch === undefined ? 'none given' : c.branch}) ${c.why}`)), c.label);
  }
  const refusedIds = cases.filter((c) => !c.lands).map((c) => c.id);
  assert.deepEqual(rowsOf(snapshot(d.dbPath), refusedIds), rowsOf(before, refusedIds), 'not one row or event of a refused job changed');
  assert.deepEqual([report.summary.landed, report.summary.refused], [3, 10]);
});

test('a branch in a fork is not the job\'s build, even with the job\'s id in its name', (t) => {
  const d = desk(t);
  const fork = d.heldJob('Built in a fork', 71);
  const gone = d.heldJob('Built in a fork that was deleted', 72);
  const noOwner = d.heldJob('Built where GitHub does not say', 73);
  const sameName = d.heldJob('Built in the origin', 74);
  const caseOnly = d.heldJob('Built in the origin, spelled in another case', 75);
  // The pull request targets this repository, so its own link is in it, but the branch lives elsewhere.
  const prs = {
    [pullAt(71)]: mergedPr(71, { headRepository: { name: 'widgets' }, headRepositoryOwner: { login: 'someone-else' } }),
    [pullAt(72)]: mergedPr(72, { headRepository: null, headRepositoryOwner: null }),
    [pullAt(73)]: mergedPr(73, { headRepository: { name: 'widgets' }, headRepositoryOwner: {} }),
    [pullAt(74)]: mergedPr(74, { headRepository: { id: 'R_1', name: 'widgets' }, headRepositoryOwner: { id: 'O_1', login: 'acme' } }),
    [pullAt(75)]: mergedPr(75, { headRepository: { name: 'Widgets' }, headRepositoryOwner: { login: 'ACME' } }),
  };
  d.setGh({ prs });
  const before = snapshot(d.dbPath);
  const dry = JSON.parse(d.run(['task', 'sweep', '--held', '--dry-run', '--as', 'keshav', '--json']).stdout);
  assert.deepEqual(Object.fromEntries(dry.results.map((r) => [r.task_id, r.action])),
    { [fork]: 'refused', [gone]: 'refused', [noOwner]: 'refused', [sameName]: 'would_land', [caseOnly]: 'would_land' });
  assert.deepEqual(snapshot(d.dbPath), before);

  const report = d.sweepJson();

  const byId = Object.fromEntries(report.results.map((r) => [r.task_id, r]));
  assert.match(byId[fork].detail, notBuild(escapeRe("its branch is in someone-else/widgets, and this workspace's origin is acme/widgets")));
  assert.match(byId[gone].detail, notBuild(escapeRe("GitHub's answer does not say which repository its branch is in")));
  assert.match(byId[noOwner].detail, notBuild(escapeRe("GitHub's answer does not say which repository its branch is in")));
  assert.deepEqual([report.summary.landed, report.summary.refused], [2, 3]);
  assert.deepEqual(rowsOf(snapshot(d.dbPath), [fork, gone, noOwner]), rowsOf(before, [fork, gone, noOwner]), 'not one row or event of a refused job changed');

  // A closed pull request from a fork releases nothing either.
  const closedFork = d.heldJob('Closed, built in a fork', 76);
  d.setGh({ prs: { ...prs, [pullAt(76)]: closedPr(76, { headRepositoryOwner: { login: 'someone-else' } }) } });
  const closedBefore = snapshot(d.dbPath);
  const closedResult = d.sweepJson().results.find((r) => r.task_id === closedFork);
  assert.deepEqual([closedResult.outcome, closedResult.action], ['closed', 'refused']);
  assert.match(closedResult.detail, notBuild(escapeRe("its branch is in someone-else/widgets, and this workspace's origin is acme/widgets")));
  assert.deepEqual(snapshot(d.dbPath), closedBefore);
  assert.equal(tasks.getTask(d.db, closedFork).status, 'review');
});

test('a merge from before the claim now on the job is not its build, and one a second after the claim is', (t) => {
  const d = desk(t);
  const early = d.heldJob('Merged before the claim', 71);
  const same = d.heldJob('Merged the second it was claimed', 72);
  const later = d.heldJob('Merged a second after the claim', 73);
  const unclaimed = d.heldJob('Claim time missing', 74);
  // Whole seconds, so the claim and the time GitHub prints can be the same instant.
  const claimedAt = Math.floor((Date.now() - 2 * HOUR) / 1000) * 1000;
  for (const id of [early, same, later]) d.db.prepare('UPDATE tasks SET claimed_at = ? WHERE id = ?').run(claimedAt, id);
  d.db.prepare('UPDATE tasks SET claimed_at = NULL WHERE id = ?').run(unclaimed);
  d.setGh({ prs: {
    [pullAt(71)]: mergedPr(71, { mergedAt: ghTime(claimedAt - 1000) }),
    [pullAt(72)]: mergedPr(72, { mergedAt: ghTime(claimedAt) }),
    [pullAt(73)]: mergedPr(73, { mergedAt: ghTime(claimedAt + 1000) }),
    [pullAt(74)]: mergedPr(74),
  } });
  const before = snapshot(d.dbPath);

  const report = d.sweepJson();

  const byId = Object.fromEntries(report.results.map((r) => [r.task_id, r]));
  const claimedIso = new Date(claimedAt).toISOString();
  assert.equal(byId[early].action, 'refused');
  assert.match(byId[early].detail, notBuild(escapeRe(`it was merged at ${ghTime(claimedAt - 1000)}, not after this job's claim began at ${claimedIso}`)));
  assert.equal(byId[same].action, 'refused', 'the same second is not after');
  assert.match(byId[same].detail, notBuild(escapeRe(`it was merged at ${ghTime(claimedAt)}, not after this job's claim began at ${claimedIso}`)));
  assert.equal(byId[later].action, 'landed');
  assert.equal(byId[unclaimed].action, 'refused');
  assert.match(byId[unclaimed].detail, notBuild(escapeRe('this job has no claim time to compare the merge with')));
  assert.deepEqual(rowsOf(snapshot(d.dbPath), [early, same, unclaimed]), rowsOf(before, [early, same, unclaimed]));
  assert.equal(tasks.getTask(d.db, later).status, 'done');
});

test('a reopened job claimed again gets nothing for a merge from before its new claim', (t) => {
  const d = desk(t);
  const id = d.heldJob('Fix the feedback form', 77);
  // A person merges the pull request two hours ago, but nobody sweeps. The job is reopened and a
  // second builder takes it. Its hand-in names the same, already merged, pull request.
  assert.equal(tasks.reopenTask(d.db, { id, actor: 'harman', reason: 'redo it from scratch', fromReview: true }).reopened, true);
  assert.equal(tasks.claimTask(d.db, { id, claimedBy: 'fleet-claude', leaseMinutes: 60, leasePid: process.pid }).claimed, true);
  assert.equal(tasks.readyTask(d.db, { id, actor: 'fleet-claude', proof: 'Rebuilt it.', merge: { number: '77', url: pullAt(77) } }).ready, true);
  const newClaim = Date.now() - 30 * 60 * 1000;
  d.db.prepare('UPDATE tasks SET claimed_at = ? WHERE id = ?').run(newClaim, id);
  const mergedAt = ghTime(Date.now() - 2 * HOUR);
  d.setGh({ prs: { [pullAt(77)]: mergedPr(77, { mergedAt }) } });
  const held = tasks.getTask(d.db, id);
  assert.equal(held.status, 'review');
  assert.equal(held.claimed_by, 'fleet-claude');
  assert.ok(Date.parse(mergedAt) < newClaim, 'the merge is before the new claim');
  const before = snapshot(d.dbPath);

  const report = d.sweepJson();

  assert.deepEqual([report.results[0].outcome, report.results[0].action], ['merged', 'refused']);
  assert.match(report.results[0].detail, notBuild("it was merged at .+, not after this job's claim began at .+"));
  assert.deepEqual(snapshot(d.dbPath), before, 'the second builder is credited with nothing and the job is untouched');
  const season = seasonOf(d.dir, d.dbPath);
  assert.equal(playsOf(season, id).some((o) => o.kind === 'landed'), false);
  assert.equal(memberRow(season, 'fleet-claude').landed, 0);
});

test('a merge GitHub gives no usable time for credits nothing, and says so', (t) => {
  const d = desk(t);
  const none = d.heldJob('Merged, no time', 71);
  const garbled = d.heldJob('Merged, garbled time', 72);
  d.setGh({ prs: {
    [pullAt(71)]: mergedPr(71, { mergedAt: null }),
    [pullAt(72)]: mergedPr(72, { mergedAt: 'some time last week' }),
  } });
  const before = snapshot(d.dbPath);

  const report = d.sweepJson();

  for (const [id, number] of [[none, 71], [garbled, 72]]) {
    const result = report.results.find((r) => r.task_id === id);
    assert.deepEqual([result.outcome, result.action], ['unknown', 'none'], String(number));
    assert.equal(result.detail, `GitHub says pull request ${number} is merged but gave no usable merge time`);
  }
  assert.deepEqual([report.summary.landed, report.summary.unknown], [0, 2]);
  assert.deepEqual(snapshot(d.dbPath), before);
  assert.match(d.sweep().stdout, /^could not check \S+ Merged, no time: GitHub says pull request 71 is merged but gave no usable merge time$/m);
});

// ---------------------------------------------------------------------------
// One pull request, one landing. A pull request that a job already landed with, or that another
// job still on the board also points at, is not this job's to land: two jobs cannot both be
// credited for one merge, and a person has to say which one it was. The check is made again
// inside the write, so a job that took the pull request while GitHub was being asked is seen.

// A job a flight landed itself: handed in with the merge on file, so its row says merged.
const landedWith = (d, title, number, { repo = REPO, builder = 'fleet-gemini', url = pullAt(number, repo), then } = {}) => {
  const { id } = tasks.addTask(d.db, { title, tag: 'feedback', workspaceRoot: d.dir });
  claimFor(d.db, id, builder);
  const merge = { merge_commit: COMMIT, number, url, merged_at: MERGED_AT };
  assert.equal(tasks.readyTask(d.db, { id, actor: builder, proof: 'Landed by the flight.', merge }).ready, true);
  if (then) then(id);
  return id;
};
// A job that waits on a pull request, with the branch GitHub reports carrying the job's own id.
const heldOn = (d, title, number, extra) => {
  const id = d.heldJob(title, number, extra);
  return { id, branch: buildBranch(id) };
};

test('a pull request another live job also points at is refused for every job that points at it, and a dry run says so', (t) => {
  const d = desk(t);
  // Both rows name pull request 77, and GitHub's branch carries the first job's id: the branch alone
  // would let the first land. The second job's name on the same pull request stops it.
  const first = d.heldJob('Fix the feedback form', 77);
  const second = d.heldJob('Fix the feedback form again', 77);
  const closedOne = d.heldJob('Closed, one of two', 78);
  const closedOther = d.heldJob('Closed, the other', 78);
  const alone = d.heldJob('Its own pull request', 79);
  d.setGh({ prs: { [pullAt(77)]: mergedPr(77), [pullAt(78)]: closedPr(78), [pullAt(79)]: mergedPr(79) } });
  const before = snapshot(d.dbPath);

  const dry = JSON.parse(d.run(['task', 'sweep', '--held', '--dry-run', '--as', 'keshav', '--json']).stdout);
  const dryBy = Object.fromEntries(dry.results.map((r) => [r.task_id, r.action]));
  assert.deepEqual([dryBy[first], dryBy[second], dryBy[closedOne], dryBy[closedOther], dryBy[alone]], ['refused', 'refused', 'refused', 'refused', 'would_land']);
  assert.deepEqual(snapshot(d.dbPath), before);
  // Two jobs on one pull request are one question to GitHub in a run, not two.
  const askedAbout = (number) => d.ghCalls().filter((call) => call === `pr view ${pullAt(number)} --json ${FIELDS}`).length;
  assert.deepEqual([77, 78, 79].map(askedAbout), [1, 1, 1], 'each pull request was asked about once in the dry run');

  const report = d.sweepJson();

  assert.deepEqual([77, 78, 79].map(askedAbout), [2, 2, 2], 'and once more in the real run');
  const byId = Object.fromEntries(report.results.map((r) => [r.task_id, r]));
  assert.match(byId[first].detail, notBuild(escapeRe(`another job (${byId[second].ref}) still points at pull request 77 in ${REPO}`)));
  assert.match(byId[closedOne].detail, notBuild(escapeRe(`another job (${byId[closedOther].ref}) still points at pull request 78 in ${REPO}`)));
  for (const id of [first, second, closedOne, closedOther]) assert.equal(byId[id].action, 'refused', id);
  assert.equal(byId[alone].action, 'landed');
  assert.deepEqual([report.summary.landed, report.summary.released, report.summary.refused], [1, 0, 4]);
  const stuck = [first, second, closedOne, closedOther];
  assert.deepEqual(rowsOf(snapshot(d.dbPath), stuck), rowsOf(before, stuck), 'not one row or event of a refused job changed');
  const season = seasonOf(d.dir, d.dbPath);
  for (const id of [first, second]) assert.equal(playsOf(season, id).some((o) => o.kind === 'landed'), false, 'neither is credited');
  for (const id of [closedOne, closedOther]) assert.equal(playsOf(season, id).some((o) => o.kind === 'dropped'), false, 'and neither takes a miss');
});

test('a job in another checkout of the same repository that points at the same pull request stops the landing, and is left alone', (t) => {
  const d = desk(t);
  const checkout = repoAt(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'held-sweep-other-'))), ORIGIN);
  t.after(() => fs.rmSync(checkout, { recursive: true, force: true }));
  const mine = d.heldJob('Fix the feedback form', 77);
  const theirs = d.heldJob('The same pull request, from the other checkout', 77, { root: checkout, builder: 'fleet-claude' });
  d.setGh({ prs: { [pullAt(77)]: mergedPr(77) } });
  const before = snapshot(d.dbPath);

  const report = d.sweepJson();

  assert.deepEqual(report.results.map((r) => r.task_id), [mine], 'the other checkout\'s job is not in this run');
  assert.equal(report.results[0].action, 'refused');
  assert.match(report.results[0].detail, notBuild(escapeRe(`another job (${refOf(d.db, theirs)}) still points at pull request 77 in ${REPO}`)));
  assert.deepEqual(snapshot(d.dbPath), before, 'neither job was touched');
  assert.deepEqual(d.ghCalls(), [`pr view ${pullAt(77)} --json ${FIELDS}`], 'a refusal made from the board alone does not ask which branch the repository lands on');
});

test('a pull request a job already landed with is refused for any other job, on its row or only in its history', (t) => {
  const d = desk(t);
  const archive = (id) => assert.equal(tasks.archiveTask(d.db, { id, actor: 'harman', reason: 'not needed' }).archived, true);
  const finish = (id) => assert.equal(tasks.doneTask(d.db, { id, status: 'done', actor: 'harman', allowReview: true, action: 'accepted' }).updated, true);
  // Pull request 77 landed with a job that was reopened since, so only its history says so.
  const history = d.heldJob('Landed, then reopened', 77);
  d.setGh({ prs: { [pullAt(77)]: mergedPr(77) } });
  assert.equal(d.sweepJson().summary.landed, 1);
  assert.equal(tasks.reopenTask(d.db, { id: history, actor: 'harman', reason: 'redo it' }).reopened, true);
  assert.equal(tasks.getTask(d.db, history).metadata.pull_request, undefined, 'the row no longer says it landed');
  // The others landed with the merge on the row: still in review, finished, archived.
  const inReview = landedWith(d, 'Landed by a flight, in review', 78);
  const finished = landedWith(d, 'Landed by a flight, finished', 79, { then: finish });
  const archived = landedWith(d, 'Landed by a flight, archived', 80, { then: archive });
  const owners = { 77: history, 78: inReview, 79: finished, 80: archived };
  // A new job waits on each of those pull requests, and GitHub's branch carries its own id.
  const mine = [77, 78, 79, 80].map((number) => ({ number, ...heldOn(d, `Waits on ${number}`, number) }));
  // Not in the way: a job accepted by hand while its pull request was still open, and the same
  // number in another repository.
  const handAccepted = d.heldJob('Accepted by hand with its pull request open', 81);
  finish(handAccepted);
  const nextToAccepted = heldOn(d, 'Waits next to an accepted job', 81);
  const otherRepo = landedWith(d, 'Landed in another repository', 82, { repo: 'someone/else' });
  const sameNumberHere = heldOn(d, 'Same number, this repository', 82);
  d.setGh({ prs: {
    ...Object.fromEntries(mine.map((m) => [pullAt(m.number), mergedPr(m.number, { headRefName: m.branch })])),
    [pullAt(81)]: mergedPr(81, { headRefName: nextToAccepted.branch }),
    [pullAt(82)]: mergedPr(82, { headRefName: sameNumberHere.branch }),
  } });
  const before = snapshot(d.dbPath);

  const report = d.sweepJson();

  const byId = Object.fromEntries(report.results.map((r) => [r.task_id, r]));
  for (const m of mine) {
    assert.equal(byId[m.id].action, 'refused', `pull request ${m.number}`);
    assert.match(byId[m.id].detail, notBuild(escapeRe(`pull request ${m.number} in ${REPO} already landed with ${refOf(d.db, owners[m.number])}`)), `pull request ${m.number}`);
  }
  assert.equal(byId[nextToAccepted.id].action, 'landed', 'a job accepted by hand with its pull request open did not land with it');
  assert.equal(byId[sameNumberHere.id].action, 'landed', 'the same number in another repository is another pull request');
  assert.deepEqual([report.summary.landed, report.summary.refused], [2, 4]);
  const stuck = mine.map((m) => m.id);
  assert.deepEqual(rowsOf(snapshot(d.dbPath), stuck), rowsOf(before, stuck), 'not one row or event of a refused job changed');
  assert.equal(tasks.getTask(d.db, otherRepo).status, 'review');
});

test('a row says its pull request landed in any of the ways a row can say so, and no history is needed for it', (t) => {
  const d = desk(t);
  // Jobs that never handed in or landed anything through the store, so only the row speaks: merged by
  // state (in any case), by a merge commit, or by a merge time, in whatever state the job is now.
  const cases = [
    [91, { state: 'merged' }, true],
    [92, { state: 'MERGED' }, true],
    [93, { state: 'open', merge_commit: COMMIT }, true],
    [94, { state: 'open', merged_at: MERGED_AT }, true],
    [95, { state: 'open' }, false],
    [96, { state: 'closed' }, false],
  ];
  for (const [number, record, landed] of cases) {
    const { id } = tasks.addTask(d.db, { title: `Says ${JSON.stringify(record)}`, tag: 'feedback', workspaceRoot: d.dir });
    d.db.prepare("UPDATE tasks SET status = 'done', metadata = json_set(COALESCE(metadata, '{}'), '$.pull_request', json(?)) WHERE id = ?")
      .run(JSON.stringify({ ...record, number, url: pullAt(number) }), id);
    assert.equal(eventTypes(d.db, id).some((type) => type === 'proof_ready' || type === 'completed'), false, 'the history says nothing about it');
    const expected = landed ? { id, how: 'landed' } : null;
    assert.deepEqual(tasks.pullRequestTakenBy(d.db, { repo: REPO, number }), expected, JSON.stringify(record));
    assert.deepEqual(tasks.pullRequestTakenBy(d.db, { repo: REPO, number, exceptId: id }), expected, `${JSON.stringify(record)}: not even that job can land with it twice`);
  }
});

test('the pull request is checked again inside the write: a job that took it while GitHub was being asked stops the landing', (t) => {
  const d = desk(t);
  const mine = d.heldJob('Fix the feedback form', 77);
  const closing = d.heldJob('Fix the billing page', 78);
  const latecomers = {};
  const take = (number) => {
    const { id } = tasks.addTask(d.db, { title: `Latecomer on ${number}`, tag: 'feedback', workspaceRoot: d.dir });
    claimFor(d.db, id, 'fleet-claude');
    assert.equal(tasks.readyTask(d.db, { id, actor: 'fleet-claude', proof: 'Built it again.', merge: { number: String(number), url: pullAt(number) } }).ready, true);
    latecomers[number] = id;
  };
  // The sweep asks the store whether anyone else has the pull request, and only then writes. A job
  // takes each pull request between the two: after the sweep's own look, before its write.
  const store = {
    ...tasks,
    pullRequestTakenBy: (db, args) => {
      const found = tasks.pullRequestTakenBy(db, args);
      assert.equal(found, null, 'when the sweep looked, nobody had it');
      if (!latecomers[args.number]) take(args.number);
      return found;
    },
  };
  const ask = (url) => {
    const number = Number(url.split('/').pop());
    const own = { number, url, repo: REPO, head_repo: REPO, base_ref: 'main', head_ref: buildBranch(number === 77 ? mine : closing) };
    return { answer: number === 77
      ? { state: 'merged', ...own, merge_commit: COMMIT, merged_at: MERGED_AT, merged_by: 'keshav' }
      : { state: 'closed', ...own, merge_commit: null, merged_at: null, merged_by: null } };
  };
  const stuck = [mine, closing];
  const before = rowsOf(snapshot(d.dbPath), stuck);

  const report = held().sweepHeldJobs(store, d.db, { workspaceRoot: d.dir, actor: 'keshav', ask, askBranch: () => ({ branch: 'main' }) });

  const byId = Object.fromEntries(report.results.map((r) => [r.task_id, r]));
  assert.deepEqual([byId[mine].action, byId[closing].action], ['refused', 'refused']);
  assert.match(byId[mine].detail, notBuild(escapeRe(`another job (${refOf(d.db, latecomers[77])}) still points at pull request 77 in ${REPO}`)));
  assert.match(byId[closing].detail, notBuild(escapeRe(`another job (${refOf(d.db, latecomers[78])}) still points at pull request 78 in ${REPO}`)));
  assert.deepEqual(rowsOf(snapshot(d.dbPath), stuck), before, 'nothing was written for either');
  assert.deepEqual([tasks.getTask(d.db, mine).status, tasks.getTask(d.db, closing).status], ['review', 'review']);
});

test('the store refuses to land or release a pull request another job has, says which job, and lets go once that job is off the board', (t) => {
  const d = desk(t);
  const a = d.heldJob('First', 77);
  const b = d.heldJob('Second', 77);
  const merge = { merge_commit: COMMIT, number: 77, url: pullAt(77), merged_at: MERGED_AT, merged_by: 'keshav' };
  const reason = 'pull request closed without landing: x';
  const pullRequest = { repo: REPO, number: 77 };
  const read = () => {
    const row = tasks.getTask(d.db, a);
    return { updatedAt: row.updated_at, claimedBy: row.claimed_by, pullRequestUrl: pullAt(77) };
  };
  const args = () => ({ id: a, actor: 'keshav', workspaceRoot: d.dir, expected: read(), pullRequest });
  const before = snapshot(d.dbPath);

  assert.deepEqual(tasks.pullRequestTakenBy(d.db, { repo: REPO, number: 77, exceptId: a }), { id: b, how: 'live' });
  assert.deepEqual(tasks.pullRequestTakenBy(d.db, { repo: REPO.toUpperCase(), number: '77', exceptId: b }), { id: a, how: 'live' }, 'the repository is compared in any case');
  assert.equal(tasks.pullRequestTakenBy(d.db, { repo: REPO, number: 78 }), null, 'another number');
  assert.equal(tasks.pullRequestTakenBy(d.db, { repo: 'acme/gadgets', number: 77 }), null, 'another repository');
  assert.equal(tasks.pullRequestTakenBy(d.db, { repo: REPO, number: 77 })?.how, 'live', 'with no job excepted, any job on it counts');
  const landed = tasks.landHeldMerge(d.db, { ...args(), merge });
  const released = tasks.releaseClosedPullRequest(d.db, { ...args(), reason });
  assert.deepEqual([landed.landed, landed.reason, landed.taken_by, landed.taken_how], [false, 'pull_request_taken', b, 'live']);
  assert.deepEqual([released.released, released.reason, released.taken_by, released.taken_how], [false, 'pull_request_taken', b, 'live']);
  assert.deepEqual(snapshot(d.dbPath), before);

  // A job that has gone off the board no longer points at it.
  assert.equal(tasks.archiveTask(d.db, { id: b, actor: 'harman', reason: 'not needed' }).archived, true);
  assert.equal(tasks.pullRequestTakenBy(d.db, { repo: REPO, number: 77, exceptId: a }), null);
  assert.equal(tasks.landHeldMerge(d.db, { ...args(), merge }).landed, true);
  // And once it landed, the pull request is taken for good, for every job, whatever the row says now.
  assert.deepEqual(tasks.pullRequestTakenBy(d.db, { repo: REPO, number: 77, exceptId: b }), { id: a, how: 'landed' });
  assert.equal(tasks.reopenTask(d.db, { id: a, actor: 'harman', reason: 'redo it' }).reopened, true);
  assert.deepEqual(tasks.pullRequestTakenBy(d.db, { repo: REPO, number: 77 }), { id: a, how: 'landed' }, 'its history says it landed');
  assert.deepEqual(tasks.pullRequestTakenBy(d.db, { repo: REPO, number: 77, exceptId: a }), { id: a, how: 'landed' }, 'and not even that job can land with it twice');
  assert.throws(() => tasks.pullRequestTakenBy(d.db, { repo: 'not a repository', number: 77 }), /pullRequest required/);
  assert.throws(() => tasks.pullRequestTakenBy(d.db, { repo: REPO, number: 0 }), /pullRequest required/);
});

test('a link on a row names a pull request however it is decorated, and a row that names only a number names no repository', (t) => {
  const d = desk(t);
  const link = (url) => {
    const id = d.heldJob(`Link ${url}`, 77);
    d.db.prepare("UPDATE tasks SET metadata = json_set(metadata, '$.pull_request.url', ?) WHERE id = ?").run(url, id);
    return id;
  };
  const decorated = [`${pullAt(88)}/`, `${pullAt(88)}/files`, `${pullAt(88)}?diff=split`, `${pullAt(88)}#discussion_r1`, pullAt(88).toUpperCase().replace('HTTPS', 'https')];
  for (const url of decorated) {
    const id = link(url);
    assert.deepEqual(tasks.pullRequestTakenBy(d.db, { repo: REPO, number: 88 }), { id, how: 'live' }, url);
    d.db.prepare("UPDATE tasks SET status = 'archived' WHERE id = ?").run(id);
  }
  const numberOnly = d.heldJob('Names a number and no link', 89);
  d.db.prepare("UPDATE tasks SET metadata = json_remove(metadata, '$.pull_request.url') WHERE id = ?").run(numberOnly);
  assert.equal(tasks.pullRequestTakenBy(d.db, { repo: REPO, number: 89 }), null);
});

// One number has many spellings: GitHub opens /pull/77 and /pull/0077 as the same pull request. A
// pull request is a repository and a number, so every link is read as one and those two values are
// compared, never the text a link happens to be written with.
const zeroPadded = (number, width = 5, repo = REPO) => pullAt(number, repo).replace(/\/pull\/\d+$/, `/pull/${String(number).padStart(width, '0')}`);
const spelledAs = (d, id, url) => d.db.prepare("UPDATE tasks SET metadata = json_set(metadata, '$.pull_request.url', ?) WHERE id = ?").run(url, id);
// A landed job a person accepted and then reopened: the row has let go of the pull request, so only the
// job's history says it landed.
const acceptedThenReopened = (d) => (id) => {
  assert.equal(tasks.doneTask(d.db, { id, status: 'done', actor: 'harman', allowReview: true, action: 'accepted' }).updated, true);
  assert.equal(tasks.reopenTask(d.db, { id, actor: 'harman', reason: 'redo it' }).reopened, true);
  d.db.prepare("UPDATE tasks SET metadata = json_remove(metadata, '$.pull_request', '$.merge_commit') WHERE id = ?").run(id);
};

test('the store finds a pull request another job has however its number is spelled, and the guarded write stops on it', (t) => {
  const d = desk(t);
  const merge = (number) => ({ merge_commit: COMMIT, number, url: pullAt(number), merged_at: MERGED_AT, merged_by: 'keshav' });
  const reason = 'pull request closed without landing: x';
  const waitsOn = (title, number) => {
    const id = d.heldJob(title, number);
    return { id, read: () => { const row = tasks.getTask(d.db, id); return { updatedAt: row.updated_at, claimedBy: row.claimed_by, pullRequestUrl: pullAt(number) }; } };
  };

  // A live job names the pull request with leading zeros, in each of the ways a number can be padded.
  const live = waitsOn('Waits on 77', 77);
  for (const width of [3, 4, 5, 12]) {
    const other = d.heldJob(`Pads 77 to ${width}`, 77);
    spelledAs(d, other, zeroPadded(77, width));
    assert.deepEqual(tasks.pullRequestTakenBy(d.db, { repo: REPO, number: 77, exceptId: live.id }), { id: other, how: 'live' }, `padded to ${width} digits`);
    d.db.prepare("UPDATE tasks SET status = 'archived' WHERE id = ?").run(other);
  }
  // A padded link that is also decorated, and in another case, is still that pull request.
  const decorated = d.heldJob('Pads and decorates', 77);
  spelledAs(d, decorated, `${zeroPadded(77, 4).toUpperCase().replace('HTTPS', 'https')}/files#diff`);
  assert.deepEqual(tasks.pullRequestTakenBy(d.db, { repo: REPO, number: 77, exceptId: live.id }), { id: decorated, how: 'live' });
  // Zeros do not make another pull request: 770 is not 77, and another repository's 77 is not ours.
  assert.equal(tasks.pullRequestTakenBy(d.db, { repo: REPO, number: 770 }), null);
  assert.equal(tasks.pullRequestTakenBy(d.db, { repo: 'acme/gadgets', number: 77 }), null);

  // The guarded write refuses, and changes nothing, for the one that read the plain link.
  const before = snapshot(d.dbPath);
  const args = (job, number) => ({ id: job.id, actor: 'keshav', workspaceRoot: d.dir, expected: job.read(), pullRequest: { repo: REPO, number } });
  const landed = tasks.landHeldMerge(d.db, { ...args(live, 77), merge: merge(77) });
  const released = tasks.releaseClosedPullRequest(d.db, { ...args(live, 77), reason });
  assert.deepEqual([landed.landed, landed.reason, landed.taken_by, landed.taken_how], [false, 'pull_request_taken', decorated, 'live']);
  assert.deepEqual([released.released, released.reason, released.taken_by, released.taken_how], [false, 'pull_request_taken', decorated, 'live']);
  assert.deepEqual(snapshot(d.dbPath), before);

  // A job that landed with the pull request, its link written with zeros, takes it for good: on its
  // row, whatever status the job is in now, and only in its history after a reopen.
  const onRow = landedWith(d, 'Landed by a flight', 78, { url: zeroPadded(78) });
  const inHistory = landedWith(d, 'Landed, then reopened', 79, { url: zeroPadded(79, 3), then: acceptedThenReopened(d) });
  assert.equal(tasks.getTask(d.db, inHistory).metadata.pull_request, undefined, 'the row no longer says it landed');
  const finished = landedWith(d, 'Landed, then finished', 80, { url: zeroPadded(80, 8), then: (id) => assert.equal(tasks.doneTask(d.db, { id, status: 'done', actor: 'harman', allowReview: true, action: 'accepted' }).updated, true) });
  for (const [number, owner] of [[78, onRow], [79, inHistory], [80, finished]]) {
    const job = waitsOn(`Waits on ${number}`, number);
    assert.deepEqual(tasks.pullRequestTakenBy(d.db, { repo: REPO, number, exceptId: job.id }), { id: owner, how: 'landed' }, `pull request ${number}`);
    assert.deepEqual(tasks.pullRequestTakenBy(d.db, { repo: REPO, number, exceptId: owner }), { id: owner, how: 'landed' }, `and not even that job can land with ${number} twice`);
    const mark = snapshot(d.dbPath);
    const landedWithIt = tasks.landHeldMerge(d.db, { ...args(job, number), merge: merge(number) });
    const releasedWithIt = tasks.releaseClosedPullRequest(d.db, { ...args(job, number), reason });
    assert.deepEqual([landedWithIt.landed, landedWithIt.reason, landedWithIt.taken_by, landedWithIt.taken_how], [false, 'pull_request_taken', owner, 'landed'], `pull request ${number}`);
    assert.deepEqual([releasedWithIt.released, releasedWithIt.reason, releasedWithIt.taken_by, releasedWithIt.taken_how], [false, 'pull_request_taken', owner, 'landed'], `pull request ${number}`);
    assert.deepEqual(snapshot(d.dbPath), mark, `pull request ${number}: nothing was written`);
  }
});

test('a pull request is refused for a job when another job names it with leading zeros, live or landed, before GitHub is asked which branch the repository lands on', (t) => {
  const d = desk(t);
  // Live: two jobs wait on pull request 77, and one of them writes its link with zeros. The same for
  // pull request 80, which GitHub says was closed.
  const plain = heldOn(d, 'Fix the feedback form', 77);
  const padded = heldOn(d, 'The same pull request, written with zeros', 77);
  spelledAs(d, padded.id, zeroPadded(77));
  const closedPlain = heldOn(d, 'Closed, written plainly', 80);
  const closedPadded = heldOn(d, 'Closed, written with zeros', 80);
  spelledAs(d, closedPadded.id, zeroPadded(80, 3));
  // Landed with its link written with zeros: on its row, and only in its history.
  const onRow = landedWith(d, 'Landed by a flight', 78, { url: zeroPadded(78) });
  const inHistory = landedWith(d, 'Landed, then reopened', 79, { url: zeroPadded(79), then: acceptedThenReopened(d) });
  const waits78 = heldOn(d, 'Waits on 78', 78);
  const waits79 = heldOn(d, 'Waits on 79', 79);
  d.setGh({ prs: {
    [pullAt(77)]: mergedPr(77, { headRefName: plain.branch }),
    [zeroPadded(77)]: mergedPr(77, { headRefName: padded.branch }),
    [pullAt(78)]: mergedPr(78, { headRefName: waits78.branch }),
    [pullAt(79)]: mergedPr(79, { headRefName: waits79.branch }),
    [pullAt(80)]: closedPr(80, { headRefName: closedPlain.branch }),
    [zeroPadded(80, 3)]: closedPr(80, { headRefName: closedPadded.branch }),
  } });
  const waiting = [plain.id, padded.id, closedPlain.id, closedPadded.id, waits78.id, waits79.id];
  const before = snapshot(d.dbPath);

  const dry = JSON.parse(d.run(['task', 'sweep', '--held', '--dry-run', '--as', 'keshav', '--json']).stdout);
  assert.deepEqual(dry.results.map((r) => r.action), waiting.map(() => 'refused'), 'a dry run says so too');
  assert.deepEqual(snapshot(d.dbPath), before);

  const report = d.sweepJson();

  const byId = Object.fromEntries(report.results.map((r) => [r.task_id, r]));
  assert.deepEqual(waiting.map((id) => byId[id].action), waiting.map(() => 'refused'));
  assert.match(byId[plain.id].detail, notBuild(escapeRe(`another job (${refOf(d.db, padded.id)}) still points at pull request 77 in ${REPO}`)));
  assert.match(byId[padded.id].detail, notBuild(escapeRe(`another job (${refOf(d.db, plain.id)}) still points at pull request 77 in ${REPO}`)));
  assert.match(byId[closedPlain.id].detail, notBuild(escapeRe(`another job (${refOf(d.db, closedPadded.id)}) still points at pull request 80 in ${REPO}`)));
  assert.match(byId[closedPadded.id].detail, notBuild(escapeRe(`another job (${refOf(d.db, closedPlain.id)}) still points at pull request 80 in ${REPO}`)));
  assert.match(byId[waits78.id].detail, notBuild(escapeRe(`pull request 78 in ${REPO} already landed with ${refOf(d.db, onRow)}`)));
  assert.match(byId[waits79.id].detail, notBuild(escapeRe(`pull request 79 in ${REPO} already landed with ${refOf(d.db, inHistory)}`)));
  assert.deepEqual([report.summary.landed, report.summary.released, report.summary.refused], [0, 0, 6]);
  assert.deepEqual(rowsOf(snapshot(d.dbPath), waiting), rowsOf(before, waiting), 'not one row or event of a refused job changed');
  assert.equal(d.ghCalls().some((call) => call.startsWith('repo view')), false, 'a refusal made from the board alone does not ask which branch the repository lands on');
  const season = seasonOf(d.dir, d.dbPath);
  for (const id of waiting) assert.deepEqual(playsOf(season, id).filter((o) => o.kind === 'landed' || o.kind === 'dropped'), [], 'no credit and no miss');
});

test('the recheck inside the write sees a latecomer whose link is spelled with zeros', (t) => {
  const d = desk(t);
  const mine = d.heldJob('Fix the feedback form', 77);
  const closing = d.heldJob('Fix the billing page', 78);
  const latecomers = {};
  const take = (number) => {
    const { id } = tasks.addTask(d.db, { title: `Latecomer on ${number}`, tag: 'feedback', workspaceRoot: d.dir });
    claimFor(d.db, id, 'fleet-claude');
    assert.equal(tasks.readyTask(d.db, { id, actor: 'fleet-claude', proof: 'Built it again.', merge: { number: String(number), url: zeroPadded(number) } }).ready, true);
    latecomers[number] = id;
  };
  // The sweep's own look finds nobody; a job takes each pull request, link spelled with zeros,
  // before its write, and only the look inside the write can see it.
  const store = {
    ...tasks,
    pullRequestTakenBy: (db, args) => {
      const found = tasks.pullRequestTakenBy(db, args);
      assert.equal(found, null, 'when the sweep looked, nobody had it');
      if (!latecomers[args.number]) take(args.number);
      return found;
    },
  };
  const ask = (url) => {
    const number = Number(url.split('/').pop());
    const own = { number, url, repo: REPO, head_repo: REPO, base_ref: 'main', head_ref: buildBranch(number === 77 ? mine : closing) };
    return { answer: number === 77
      ? { state: 'merged', ...own, merge_commit: COMMIT, merged_at: MERGED_AT, merged_by: 'keshav' }
      : { state: 'closed', ...own, merge_commit: null, merged_at: null, merged_by: null } };
  };
  const stuck = [mine, closing];
  const before = rowsOf(snapshot(d.dbPath), stuck);

  const report = held().sweepHeldJobs(store, d.db, { workspaceRoot: d.dir, actor: 'keshav', ask, askBranch: () => ({ branch: 'main' }) });

  const byId = Object.fromEntries(report.results.map((r) => [r.task_id, r]));
  assert.deepEqual([byId[mine].action, byId[closing].action], ['refused', 'refused']);
  assert.match(byId[mine].detail, notBuild(escapeRe(`another job (${refOf(d.db, latecomers[77])}) still points at pull request 77 in ${REPO}`)));
  assert.match(byId[closing].detail, notBuild(escapeRe(`another job (${refOf(d.db, latecomers[78])}) still points at pull request 78 in ${REPO}`)));
  assert.deepEqual(rowsOf(snapshot(d.dbPath), stuck), before, 'nothing was written for either');
});

// ---------------------------------------------------------------------------
// A merge counts only on the repository's default branch. A pull request merged into a feature
// branch has not landed. The default branch is asked of GitHub once for each repository in a run.

const MERGED_INTO_FEATURE = (base) => `it was merged into ${base}, not the repository's default branch main`;

test('a merge into any branch but the repository\'s default is refused, one with no base named is too, and a closed pull request is released whatever it targeted', (t) => {
  const d = desk(t);
  const cases = [
    ['merged into a feature branch', 71, { baseRefName: 'feature/billing' }, 'refused', MERGED_INTO_FEATURE('feature/billing')],
    ['merged into the default branch', 72, { baseRefName: 'main' }, 'landed'],
    ['merged into a branch named like it in another case', 73, { baseRefName: 'Main' }, 'refused', MERGED_INTO_FEATURE('Main')],
    ['merged with no base named', 74, { baseRefName: null }, 'refused', "GitHub's answer does not say which branch it was merged into"],
    ['closed, aimed at a feature branch', 75, { baseRefName: 'feature/billing' }, 'released'],
  ];
  const ids = cases.map(([label, number]) => d.heldJob(`Case: ${label}`, number));
  d.setGh({ prs: Object.fromEntries(cases.map(([, number, extra]) => [pullAt(number), (number === 75 ? closedPr : mergedPr)(number, extra)])) });
  const before = snapshot(d.dbPath);

  const dry = JSON.parse(d.run(['task', 'sweep', '--held', '--dry-run', '--as', 'keshav', '--json']).stdout);
  const dryBy = Object.fromEntries(dry.results.map((r) => [r.task_id, r.action]));
  assert.deepEqual(ids.map((id) => dryBy[id]), ['refused', 'would_land', 'refused', 'refused', 'would_release']);
  assert.deepEqual(snapshot(d.dbPath), before);

  const report = d.sweepJson();

  cases.forEach(([label, , , action, why], i) => {
    const result = report.results.find((r) => r.task_id === ids[i]);
    assert.equal(result.action, action, label);
    if (action === 'refused') {
      assert.equal(result.outcome, 'merged', label);
      assert.match(result.detail, notBuild(escapeRe(why)), label);
    }
  });
  assert.deepEqual([report.summary.landed, report.summary.released, report.summary.refused], [1, 1, 3]);
  const refusedIds = [ids[0], ids[2], ids[3]];
  assert.deepEqual(rowsOf(snapshot(d.dbPath), refusedIds), rowsOf(before, refusedIds), 'not one row or event of a refused job changed');
  assert.equal(playsOf(seasonOf(d.dir, d.dbPath), ids[0]).some((o) => o.kind === 'landed'), false);
  // The default branch was asked once in each of the two runs, however many merges there were.
  assert.equal(d.ghCalls().filter((call) => call === askDefaultBranchCall()).length, 2);
});

test('the default branch is asked once for each repository in a run, and each pull request is held to its own repository\'s', (t) => {
  const d = desk(t);
  const other = repoAt(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'held-sweep-other-'))), 'https://github.com/acme/gadgets.git');
  t.after(() => fs.rmSync(other, { recursive: true, force: true }));
  const gadgets = (title, number) => d.heldJob(title, number, { root: other, builder: 'fleet-claude', repo: 'acme/gadgets' });
  const inTrunk = gadgets('Merged into its default branch', 81);
  const inMain = gadgets('Merged into another repository\'s default branch', 82);
  const first = d.heldJob('First in the workspace', 77);
  const second = d.heldJob('Second in the workspace', 78);
  const third = d.heldJob('Third in the workspace', 79);
  d.setGh({
    prs: {
      [pullAt(77)]: mergedPr(77), [pullAt(78)]: mergedPr(78), [pullAt(79)]: mergedPr(79),
      [pullAt(81, 'acme/gadgets')]: mergedPr(81, { url: pullAt(81, 'acme/gadgets'), baseRefName: 'trunk' }),
      [pullAt(82, 'acme/gadgets')]: mergedPr(82, { url: pullAt(82, 'acme/gadgets'), baseRefName: 'main' }),
    },
    repos: { [repoLink('acme/gadgets')]: { defaultBranchRef: { name: 'trunk' } } },
  });

  const report = d.sweepJson('--everywhere');

  const byId = Object.fromEntries(report.results.map((r) => [r.task_id, r]));
  assert.deepEqual([first, second, third, inTrunk].map((id) => byId[id].action), ['landed', 'landed', 'landed', 'landed']);
  assert.equal(byId[inMain].action, 'refused');
  assert.match(byId[inMain].detail, notBuild(escapeRe("it was merged into main, not the repository's default branch trunk")));
  assert.deepEqual(d.ghCalls().filter((call) => call.startsWith('repo view')).sort(), [askDefaultBranchCall(), askDefaultBranchCall('acme/gadgets')].sort(),
    'one question for each repository, however many pull requests were merged in it');
});

test('the default branch is asked once for a repository however each answer spells its name', (t) => {
  const d = desk(t);
  d.heldJob('Spelled one way', 77);
  d.heldJob('Spelled another way', 78);
  d.heldJob('Spelled the way the workspace does', 79);
  d.setGh({ prs: {
    [pullAt(77)]: mergedPr(77, { url: pullAt(77, 'Acme/Widgets') }),
    [pullAt(78)]: mergedPr(78, { url: pullAt(78, 'ACME/WIDGETS') }),
    [pullAt(79)]: mergedPr(79),
  } });

  const report = d.sweepJson();

  assert.deepEqual(report.results.map((r) => r.action), ['landed', 'landed', 'landed']);
  assert.equal(d.ghCalls().filter((call) => call.startsWith('repo view')).length, 1, 'one repository, one question');
});

test('a default branch GitHub cannot give leaves the merge unknown and unwritten, and an outage stops the run, like any other gh failure', (t) => {
  const d = desk(t);
  const other = repoAt(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'held-sweep-other-'))), 'https://github.com/acme/gadgets.git');
  t.after(() => fs.rmSync(other, { recursive: true, force: true }));
  const one = d.heldJob('Merged in the repository gh fails on', 77);
  const two = d.heldJob('Merged in it too', 78);
  const fine = d.heldJob('Merged in the repository gh answers for', 81, { root: other, builder: 'fleet-claude', repo: 'acme/gadgets' });
  const prs = {
    [pullAt(77)]: mergedPr(77),
    [pullAt(78)]: mergedPr(78),
    [pullAt(81, 'acme/gadgets')]: mergedPr(81, { url: pullAt(81, 'acme/gadgets'), baseRefName: 'trunk' }),
  };
  const gadgets = { [repoLink('acme/gadgets')]: { defaultBranchRef: { name: 'trunk' } } };
  d.setGh({ prs, repos: gadgets, fail: { [repoLink()]: 'HTTP 502: Bad Gateway (https://api.github.com/graphql)\nmore detail' } });
  const before = snapshot(d.dbPath);

  const report = d.sweepJson('--everywhere');

  assert.equal(report.ok, true, 'one failure is not an outage');
  const byId = Object.fromEntries(report.results.map((r) => [r.task_id, r]));
  for (const id of [one, two]) {
    assert.deepEqual([byId[id].outcome, byId[id].action], ['unknown', 'none'], id);
    assert.match(byId[id].detail, /^gh said: HTTP 502: Bad Gateway/, id);
  }
  assert.equal(byId[fine].action, 'landed', 'the rest are still checked');
  assert.equal(d.ghCalls().filter((call) => call === askDefaultBranchCall()).length, 1, 'and the failure was not asked again for the second job');
  assert.deepEqual(rowsOf(snapshot(d.dbPath), [one, two]), rowsOf(before, [one, two]));
  const stillHeld = snapshot(d.dbPath);

  // A repository with no default branch says nothing useful either.
  d.setGh({ prs, repos: { ...gadgets, [repoLink()]: { defaultBranchRef: null } } });
  const none = d.sweepJson('--everywhere').results.filter((r) => [one, two].includes(r.task_id));
  assert.equal(none.length, 2);
  for (const result of none) {
    assert.deepEqual([result.outcome, result.action], ['unknown', 'none']);
    assert.match(result.detail, /does not say which branch is the repository's default/);
  }
  assert.deepEqual(snapshot(d.dbPath), stillHeld);

  // gh gone, or not found, for that question: the run stops and says what it did not ask.
  d.setGh({ prs, repos: gadgets, exits: { [repoLink()]: { code: 127, say: 'env: gh: command not found' } } });
  const stopped = d.attempt(['task', 'sweep', '--held', '--everywhere', '--as', 'keshav', '--json']);
  assert.equal(stopped.status, 1, stopped.stderr || stopped.stdout);
  const outage = JSON.parse(stopped.stdout);
  assert.equal(outage.ok, false);
  assert.equal(outage.outage.kind, 'gh_missing');
  assert.deepEqual(outage.results.map((r) => [r.outcome, r.action]), [['unknown', 'none'], ['not_asked', 'none']]);
  assert.deepEqual(snapshot(d.dbPath), stillHeld);
});

test('asking for a repository\'s default branch uses a 30 second limit and tells a hang or a missing gh from any other failure', () => {
  const { askDefaultBranch, ASK_TIMEOUT_MS } = held();
  const link = repoLink();
  const seen = [];
  const answers = (result) => (command, args, options) => {
    seen.push({ command, args, options });
    return result;
  };
  const ok = (data) => answers({ status: 0, stderr: '', stdout: JSON.stringify(data) });

  assert.deepEqual(askDefaultBranch(link, { run: ok({ defaultBranchRef: { name: 'main' } }) }), { branch: 'main' });
  assert.equal(seen[0].command, 'gh');
  assert.deepEqual(seen[0].args, ['repo', 'view', link, '--json', 'defaultBranchRef']);
  assert.equal(seen[0].options.timeout, ASK_TIMEOUT_MS);
  assert.equal(seen[0].options.killSignal, 'SIGKILL');
  assert.deepEqual(askDefaultBranch(link, { run: ok({ defaultBranchRef: { name: ' release/3.74 ' } }) }), { branch: 'release/3.74' });
  for (const odd of [{}, { defaultBranchRef: null }, { defaultBranchRef: {} }, { defaultBranchRef: { name: '' } }, { defaultBranchRef: { name: 42 } }, { defaultBranchRef: 'main' }]) {
    const asked = askDefaultBranch(link, { run: ok(odd) });
    assert.equal(asked.branch, undefined, JSON.stringify(odd));
    assert.match(asked.unknown, /does not say which branch is the repository's default/, JSON.stringify(odd));
  }

  const failed = (code) => ({ status: null, stdout: '', stderr: '', error: Object.assign(new Error(`spawnSync gh ${code}`), { code }) });
  assert.equal(askDefaultBranch(link, { run: answers(failed('ETIMEDOUT')) }).outage.kind, 'timeout');
  assert.equal(askDefaultBranch(link, { run: answers(failed('ENOENT')) }).outage.kind, 'gh_missing');
  assert.equal(askDefaultBranch(link, { run: answers({ status: 127, stdout: '', stderr: 'env: gh: not found' }) }).outage.kind, 'gh_missing');
  for (const [label, result, pattern] of [
    ['gh failing', { status: 1, stdout: '', stderr: '\nHTTP 502: Bad Gateway\nmore' }, /^gh said: HTTP 502: Bad Gateway$/],
    ['gh failing with no words', { status: 4, stdout: '', stderr: '' }, /^gh exited 4$/],
    ['an answer that is not JSON', { status: 0, stdout: 'not json', stderr: '' }, /could not be read/],
    ['an answer that is not an object', { status: 0, stdout: '[1]', stderr: '' }, /could not be read/],
  ]) {
    const asked = askDefaultBranch(link, { run: answers(result) });
    assert.equal(asked.outage, undefined, label);
    assert.equal(asked.branch, undefined, label);
    assert.match(asked.unknown, pattern, label);
  }
});

// ---------------------------------------------------------------------------
// Closed without merging.

test('a job that waited past the rating window before its merge was swept in still credits its builder', (t) => {
  const d = desk(t);
  const id = d.heldJob('Fix the feedback form', 77);
  // Move the whole attempt back 40 days, past the 30 days the rating reads.
  d.db.prepare('UPDATE task_events SET created_at = created_at - ? WHERE task_id = ?').run(40 * 24 * 60 * 60 * 1000, id);
  assert.deepEqual(playsOf(seasonOf(d.dir, d.dbPath), id), [], 'the rating cannot see the old attempt yet');
  d.setGh({ prs: { [pullAt(77)]: mergedPr(77) } });

  assert.equal(d.sweepJson().summary.landed, 1);

  const season = seasonOf(d.dir, d.dbPath);
  assert.deepEqual(playsOf(season, id).map((o) => [o.kind, o.member]), [['landed', 'fleet-codex']]);
  assert.equal(memberRow(season, 'fleet-codex').landed, 1);
});

test('a landing is dated at the merge: an old merge swept in now is outside the rating window, a recent one counts', (t) => {
  const d = desk(t);
  const old = d.heldJob('Merged long ago', 71, { claimedAgo: 50 * DAY });
  const recent = d.heldJob('Merged ten days ago', 72, { claimedAgo: 12 * DAY });
  const mergedLongAgo = ghTime(Date.now() - 45 * DAY);
  const mergedRecently = ghTime(Date.now() - 10 * DAY);
  d.setGh({ prs: { [pullAt(71)]: mergedPr(71, { mergedAt: mergedLongAgo }), [pullAt(72)]: mergedPr(72, { mergedAt: mergedRecently }) } });

  assert.equal(d.sweepJson().summary.landed, 2);

  // Both landings are on file as landed when GitHub says the merge happened.
  assert.equal(eventsOf(d.db, old).pop().payload.landed_at, mergedLongAgo);
  assert.equal(eventsOf(d.db, recent).pop().payload.landed_at, mergedRecently);
  const season = seasonOf(d.dir, d.dbPath);
  assert.deepEqual(playsOf(season, old), [], 'a merge older than the 30 days is not in the rating, however late it was written down');
  const plays = playsOf(season, recent);
  assert.deepEqual(plays.map((o) => o.kind), ['took', 'landed']);
  assert.equal(plays[1].at, Date.parse(mergedRecently));
  const builder = memberRow(season, 'fleet-codex');
  assert.deepEqual([builder.landed, builder.finished], [1, 1], 'only the recent merge counts');
});

test('a landing cannot be dated after it was written down', () => {
  const { outcomesFromEvents } = require('../lib/gm-season');
  const now = Date.now();
  const row = (landedAt) => ({
    event_id: 'e2', task_id: 't1', event_type: 'completed', actor: 'keshav', created_at: now - HOUR, version: 2,
    payload: JSON.stringify({ status: 'done', action: 'merged', ...(landedAt === undefined ? {} : { landed_at: landedAt }) }),
    claim_actor: 'fleet-codex', claim_event_id: 'e1', claim_event_at: now - 5 * HOUR, claimed_by: 'fleet-codex', claimed_at: now - 5 * HOUR, title: 'Job',
  });
  const landedAt = (value) => outcomesFromEvents([row(value)]).find((o) => o.kind === 'landed').at;

  assert.equal(landedAt(undefined), now - HOUR, 'with no merge time it is dated when it was written down');
  assert.equal(landedAt(ghTime(now - 3 * HOUR)), Date.parse(ghTime(now - 3 * HOUR)), 'a merge time is used');
  assert.equal(landedAt(ghTime(now + 10 * DAY)), now - HOUR, 'a merge time in the future cannot hold a landing in the window');
  for (const bad of ['yesterday', '', null, {}, [], true]) assert.equal(landedAt(bad), now - HOUR, `unusable: ${JSON.stringify(bad)}`);

  // Nothing but a landing is dated by it: a drop whose record carries one is dated when it happened.
  const drop = { ...row(undefined), event_type: 'claim_released', payload: JSON.stringify({ reason: 'gave up', previous_claimed_by: 'fleet-codex', landed_at: ghTime(now - 3 * HOUR) }) };
  assert.equal(outcomesFromEvents([drop]).find((o) => o.kind === 'dropped').at, now - HOUR);
});

test('a pull request closed without merging releases the claim with the reason, rates as a miss, and a person can still mark it not needed', (t) => {
  const d = desk(t);
  const id = d.heldJob('Fix the feedback form', 78);
  const before = tasks.getTask(d.db, id);
  assert.equal(before.metadata.agent_review_pass_count, 1);
  d.setGh({ prs: { [pullAt(78)]: closedPr(78) } });

  const report = d.sweepJson();

  assert.equal(report.summary.released, 1);
  assert.equal(report.results[0].outcome, 'closed');
  assert.equal(report.results[0].action, 'released');

  // The pull request is recorded as closed, and the claim is gone.
  const row = tasks.getTask(d.db, id);
  assert.equal(row.status, 'open');
  assert.equal(row.claimed_by, null);
  assert.equal(row.claimed_at, null);
  assert.equal(row.done_at, null);
  assert.deepEqual(row.metadata.pull_request, { state: 'closed', number: 78, url: pullAt(78) });
  assert.equal(row.metadata.merge_commit, undefined);
  // The attempt is over, so its review record does not count toward the next attempt.
  for (const key of ['agent_review_pass_count', 'agent_reviewed_by', 'agent_review_actors', 'approval_status', 'latest_agent_proof', 'agent_certified']) {
    assert.equal(row.metadata[key], undefined, key);
  }

  // One release event, with the reason, in the builder's name, and no proof-not-saved marker.
  const reason = `pull request closed without landing: ${pullAt(78)}`;
  assert.deepEqual(eventTypes(d.db, id), ['created', 'claimed', 'proof_ready', 'claim_released']);
  const released = eventsOf(d.db, id).pop();
  assert.equal(released.actor, 'keshav');
  assert.deepEqual(released.payload, { released_by: 'keshav', previous_claimed_by: 'fleet-codex', reason, pull_request: { state: 'closed', number: 78, url: pullAt(78) } });
  assert.equal(released.payload.kind, undefined);

  // The real rating counts a miss for the builder, with that reason, and not a hold.
  const season = seasonOf(d.dir, d.dbPath);
  const plays = playsOf(season, id);
  assert.deepEqual(plays.map((o) => o.kind), ['took', 'dropped']);
  assert.equal(plays[1].member, 'fleet-codex');
  assert.equal(plays[1].reason, reason);
  const builder = memberRow(season, 'fleet-codex');
  assert.deepEqual([builder.landed, builder.dropped, builder.held, builder.finished], [0, 1, 0, 1]);
  const card = JSON.parse(ratingOf(d.dir, season, 'fleet-codex', '--json')).member;
  assert.deepEqual(card.miss_reasons, [{ reason, count: 1 }]);
  assert.equal(memberRow(season, 'keshav'), undefined, 'the one who ran the check takes no miss');

  // A person can still say the job did not need doing, and the miss stops counting.
  const cleared = d.attempt(['task', 'archive', id, '--not-needed', '--as', 'harman', '--reason', 'we chose a different fix']);
  assert.equal(cleared.status, 0, cleared.stderr || cleared.stdout);
  const after = seasonOf(d.dir, d.dbPath);
  assert.deepEqual(playsOf(after, id).map((o) => o.kind), ['took', 'not_needed']);
  const builderAfter = memberRow(after, 'fleet-codex');
  assert.deepEqual([builderAfter.dropped, builderAfter.not_needed, builderAfter.finished], [0, 1, 0]);

  // The text a person reads says why.
  const other = d.heldJob('Fix the billing page', 79);
  d.setGh({ prs: { [pullAt(79)]: closedPr(79) } });
  const text = d.sweep().stdout;
  assert.match(text, new RegExp(`^released \\S+ Fix the billing page: pull request closed without landing: ${pullAt(79).replace(/[./]/g, '\\$&')}$`, 'm'));
  assert.equal(tasks.getTask(d.db, other).status, 'open');
});

test('a closed pull request that is not the job\'s own releases nothing and is not a miss for the builder', (t) => {
  const d = desk(t);
  const foreign = d.heldJob('Closed, in another repository', 71, { repo: 'someone/else' });
  const otherBranch = d.heldJob('Closed, on another job\'s branch', 72);
  const own = d.heldJob('Closed, its own', 73);
  d.setGh({ prs: {
    [pullAt(71, 'someone/else')]: closedPr(71, { url: pullAt(71, 'someone/else') }),
    [pullAt(72)]: closedPr(72, { headRefName: BRANCH_OF_ANOTHER_JOB }),
    [pullAt(73)]: closedPr(73),
  } });
  const before = snapshot(d.dbPath);

  const report = d.sweepJson();

  const byId = Object.fromEntries(report.results.map((r) => [r.task_id, r]));
  assert.deepEqual([byId[foreign].outcome, byId[foreign].action], ['closed', 'refused']);
  assert.deepEqual([byId[otherBranch].outcome, byId[otherBranch].action], ['closed', 'refused']);
  assert.match(byId[foreign].detail, notBuild(escapeRe("it is in someone/else, and this workspace's origin is acme/widgets")));
  assert.match(byId[otherBranch].detail, notBuild(escapeRe(`its branch (${BRANCH_OF_ANOTHER_JOB}) does not carry this job's id`)));
  assert.equal(byId[own].action, 'released');
  assert.deepEqual([report.summary.released, report.summary.refused], [1, 2]);
  assert.deepEqual(rowsOf(snapshot(d.dbPath), [foreign, otherBranch]), rowsOf(before, [foreign, otherBranch]), 'the claims stay where they were');
  assert.equal(tasks.getTask(d.db, foreign).status, 'review');
  assert.equal(tasks.getTask(d.db, own).status, 'open');
  // Only the job whose own pull request closed is a miss.
  assert.equal(memberRow(seasonOf(d.dir, d.dbPath), 'fleet-codex').dropped, 1);
});

// ---------------------------------------------------------------------------
// Still open, and the runs that must not write.

test('a pull request still open changes nothing, and GitHub was asked', (t) => {
  const d = desk(t);
  d.heldJob('Fix the feedback form', 77);
  d.setGh({ prs: { [pullAt(77)]: openPr(77) } });
  const before = snapshot(d.dbPath);

  const report = d.sweepJson();

  assert.deepEqual(d.ghCalls(), [`pr view ${pullAt(77)} --json ${FIELDS}`]);
  assert.equal(report.ok, true);
  assert.equal(report.results[0].outcome, 'open');
  assert.equal(report.results[0].action, 'none');
  assert.deepEqual([report.summary.open, report.summary.landed, report.summary.released], [1, 0, 0]);
  assert.deepEqual(snapshot(d.dbPath), before);
  assert.match(d.sweep().stdout, /^still open: 1$/m);
});

test('a dry run asks GitHub, says what it would do, and writes nothing', (t) => {
  const d = desk(t);
  const merged = d.heldJob('Fix the feedback form', 77);
  const closed = d.heldJob('Fix the billing page', 78);
  d.heldJob('Fix the invoice page', 79);
  d.setGh({ prs: { [pullAt(77)]: mergedPr(77), [pullAt(78)]: closedPr(78), [pullAt(79)]: openPr(79) } });
  const before = snapshot(d.dbPath);
  const filesBefore = treeOf(d.dir);

  const report = JSON.parse(d.run(['task', 'sweep', '--held', '--dry-run', '--as', 'keshav', '--json']).stdout);

  assert.equal(d.ghCalls().filter((call) => call.startsWith('pr view')).length, 3, 'it asked about every held job');
  assert.equal(d.ghCalls().filter((call) => call.startsWith('repo view')).length, 1, 'and which branch the repository lands on, once, for the merge');
  assert.equal(report.dry_run, true);
  const byId = Object.fromEntries(report.results.map((r) => [r.task_id, r.action]));
  assert.equal(byId[merged], 'would_land');
  assert.equal(byId[closed], 'would_release');
  assert.deepEqual([report.summary.landed, report.summary.released], [0, 0]);
  assert.deepEqual(snapshot(d.dbPath), before, 'not one row or event changed');
  assert.deepEqual(treeOf(d.dir), filesBefore, 'no task list, todo or journal file was written either');

  const text = d.run(['task', 'sweep', '--held', '--dry-run', '--as', 'keshav']).stdout;
  assert.match(text, /^held jobs: 3 checked against GitHub \(dry run, nothing written\)$/m);
  assert.match(text, /^would land \S+ Fix the feedback form: pull request 77 was merged by keshav; fleet-codex would be credited$/m);
  assert.match(text, /^would release \S+ Fix the billing page: pull request closed without landing: /m);
  assert.deepEqual(snapshot(d.dbPath), before);
  assert.deepEqual(treeOf(d.dir), filesBefore);

  // And the real run afterwards still has all of it to do.
  const real = d.sweepJson();
  assert.deepEqual([real.summary.landed, real.summary.released], [1, 1]);
});

test('a dry run with no task list yet finds nothing and creates none', (t) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'held-sweep-empty-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'atris'));
  const dbPath = path.join(dir, 'state', 'tasks.db');
  const result = spawnSync(process.execPath, [CLI, 'task', 'sweep', '--held', '--dry-run', '--as', 'keshav', '--json'], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 60000,
    env: { ...scrubAgentEnv(), ATRIS_TASKS_DB: dbPath, ATRIS_SKIP_UPDATE_CHECK: '1', NODE_NO_WARNINGS: '1' },
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.deepEqual([report.ok, report.dry_run, report.results], [true, true, []]);
  assert.equal(fs.existsSync(path.join(dir, 'state')), false, 'no task list was created');
  assert.deepEqual(treeOf(dir), { 'atris/': '' });
});

// ---------------------------------------------------------------------------
// GitHub does not answer, or answers badly.

test('when gh is missing the run asks nothing more and changes nothing', (t) => {
  const d = desk(t);
  for (const n of [77, 78, 79]) d.heldJob(`Job ${n}`, n);
  d.setGh({ prs: { [pullAt(77)]: mergedPr(77), [pullAt(78)]: closedPr(78), [pullAt(79)]: mergedPr(79) } });
  const before = snapshot(d.dbPath);

  const result = d.attempt(['task', 'sweep', '--held', '--as', 'keshav', '--json'], { withoutGh: true });

  assert.equal(result.status, 1, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, false);
  assert.equal(report.outage.kind, 'gh_missing');
  assert.deepEqual(report.results.map((r) => r.outcome), ['unknown', 'not_asked', 'not_asked']);
  assert.deepEqual(report.results.map((r) => r.action), ['none', 'none', 'none']);
  assert.deepEqual(snapshot(d.dbPath), before);
  assert.deepEqual(d.ghCalls(), [], 'the fake gh was never on the path');

  const plain = d.attempt(['task', 'sweep', '--held', '--as', 'keshav'], { withoutGh: true });
  assert.equal(plain.status, 1);
  assert.match(plain.stderr, /gh is not installed or not on the PATH, so nothing could be checked/);
  assert.match(plain.stderr, /2 held jobs were not asked/);
  assert.deepEqual(snapshot(d.dbPath), before);
});

test('a gh that exits 127, command not found, is an outage too: the run stops and changes nothing', (t) => {
  const d = desk(t);
  for (const n of [77, 78, 79]) d.heldJob(`Job ${n}`, n);
  d.setGh({
    exits: { [pullAt(77)]: { code: 127, say: 'env: gh: command not found' } },
    prs: { [pullAt(78)]: mergedPr(78), [pullAt(79)]: closedPr(79) },
  });
  const before = snapshot(d.dbPath);

  const result = d.attempt(['task', 'sweep', '--held', '--as', 'keshav', '--json']);

  assert.equal(result.status, 1, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, false);
  assert.equal(report.outage.kind, 'gh_missing');
  assert.deepEqual(report.results.map((r) => r.outcome), ['unknown', 'not_asked', 'not_asked']);
  assert.deepEqual(d.ghCalls(), [`pr view ${pullAt(77)} --json ${FIELDS}`], 'it stopped asking after the first answer');
  assert.deepEqual(snapshot(d.dbPath), before);
  const plain = d.attempt(['task', 'sweep', '--held', '--as', 'keshav']);
  assert.equal(plain.status, 1);
  assert.match(plain.stderr, /stopped: gh is not installed or not on the PATH \(it exited 127\), so nothing could be checked\. 2 held jobs were not asked/);
});

test('an outage after some jobs were settled keeps what was settled and still refreshes the task list', (t) => {
  const d = desk(t);
  const first = d.heldJob('Fix the feedback form', 77);
  const second = d.heldJob('Fix the billing page', 78);
  const third = d.heldJob('Fix the invoice page', 79);
  // gh answers twice (the pull request, then which branch the repository lands on) and is gone for the third question.
  d.setGh({ vanishAfter: 2, prs: { [pullAt(77)]: mergedPr(77), [pullAt(78)]: mergedPr(78), [pullAt(79)]: mergedPr(79) } });
  const todo = path.join(d.dir, 'atris', 'TODO.md');
  assert.equal(fs.existsSync(todo), false);

  const result = d.attempt(['task', 'sweep', '--held', '--as', 'keshav', '--json'], { fakeGhOnly: true });

  assert.equal(result.status, 1, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, false);
  assert.equal(report.outage.kind, 'gh_missing');
  assert.deepEqual(report.results.map((r) => [r.task_id, r.outcome, r.action]),
    [[first, 'merged', 'landed'], [second, 'unknown', 'none'], [third, 'not_asked', 'none']]);
  assert.deepEqual([report.summary.landed, report.summary.unknown, report.summary.not_asked], [1, 1, 1]);
  assert.deepEqual(d.ghCalls(), [`pr view ${pullAt(77)} --json ${FIELDS}`, askDefaultBranchCall()], 'two questions, then gh was gone');
  assert.equal(tasks.getTask(d.db, first).status, 'done', 'what was settled stays settled');
  assert.deepEqual(playsOf(seasonOf(d.dir, d.dbPath), first).map((o) => o.kind), ['took', 'landed']);
  assert.equal(tasks.getTask(d.db, second).status, 'review');
  assert.equal(tasks.getTask(d.db, third).status, 'review');
  assert.equal(fs.existsSync(report.projection_path), true, 'the task projection was refreshed before the run stopped');
  assert.equal(fs.existsSync(todo), true, 'and so was the task list');
});

test('after an outage the run stops asking, and what was not asked is said so', (t) => {
  const d = desk(t);
  for (const n of [77, 78, 79]) d.heldJob(`Job ${n}`, n);
  const asked = [];
  const ask = (url) => {
    asked.push(url);
    return { outage: { kind: 'timeout', detail: 'GitHub did not answer within 30 seconds' } };
  };
  const before = snapshot(d.dbPath);

  const report = held().sweepHeldJobs(tasks, d.db, { workspaceRoot: d.dir, actor: 'keshav', ask });

  assert.equal(asked.length, 1, 'the second and third were never asked');
  assert.equal(report.ok, false);
  assert.deepEqual(report.outage, { kind: 'timeout', detail: 'GitHub did not answer within 30 seconds' });
  assert.deepEqual(report.results.map((r) => r.outcome), ['unknown', 'not_asked', 'not_asked']);
  assert.equal(report.summary.not_asked, 2);
  assert.deepEqual(snapshot(d.dbPath), before);
});

test('a plain failure on one job leaves that job unknown and the rest are still checked', (t) => {
  const d = desk(t);
  const failing = d.heldJob('Job that gh fails on', 77);
  const merged = d.heldJob('Job that merged', 78);
  const closed = d.heldJob('Job that closed', 79);
  // Oldest first is the order it checks them in, so the failure comes first.
  d.db.prepare('UPDATE tasks SET created_at = created_at - 5000 WHERE id = ?').run(failing);
  d.setGh({
    fail: { [pullAt(77)]: 'HTTP 502: Bad Gateway (https://api.github.com/graphql)\nmore detail' },
    prs: { [pullAt(78)]: mergedPr(78), [pullAt(79)]: closedPr(79) },
  });

  const result = d.sweep('--json');
  const report = JSON.parse(result.stdout);

  assert.deepEqual(d.ghCalls().filter((call) => call.startsWith('pr view')).map((call) => call.split(' ')[2]), [pullAt(77), pullAt(78), pullAt(79)], 'all three were asked, in order');
  assert.equal(report.ok, true, 'one failure is not an outage');
  assert.equal(report.outage, null);
  assert.equal(report.results.find((r) => r.task_id === failing).outcome, 'unknown');
  assert.match(report.results.find((r) => r.task_id === failing).detail, /gh said: HTTP 502: Bad Gateway/);
  assert.equal(tasks.getTask(d.db, failing).status, 'review', 'the unknown job is untouched');
  assert.deepEqual(eventTypes(d.db, failing), ['created', 'claimed', 'proof_ready']);
  assert.equal(tasks.getTask(d.db, merged).status, 'done');
  assert.equal(tasks.getTask(d.db, closed).status, 'open');
  assert.deepEqual([report.summary.unknown, report.summary.landed, report.summary.released], [1, 1, 1]);
  assert.match(d.sweep().stdout, /^held jobs: 1 checked against GitHub$/m, 'the next run only has the unknown one left');
});

test('asking gh uses the facts the checks need, a 30 second limit, and tells a hang or a missing gh from any other failure', () => {
  const { askGitHub, ASK_TIMEOUT_MS } = held();
  const url = pullAt(77);
  const seen = [];
  const answers = (result) => (command, args, options) => {
    seen.push({ command, args, options });
    return result;
  };

  const branch = buildBranch('01K8X3M2Q4ABCDEFGHJKMNPQRS');
  const ok = askGitHub(url, { run: answers({ status: 0, stderr: '', stdout: JSON.stringify(mergedPr(77, { headRefName: branch })) }) });
  assert.equal(ASK_TIMEOUT_MS, 30000);
  assert.equal(seen[0].command, 'gh');
  assert.deepEqual(seen[0].args, ['pr', 'view', url, '--json', FIELDS]);
  assert.equal(seen[0].options.timeout, 30000);
  // The repository is read from GitHub's own link, the branch is the one GitHub names, the branch's
  // repository is the owner and name GitHub gives for it, and the base is the branch it went to.
  assert.deepEqual(ok, { answer: { state: 'merged', number: 77, url, repo: REPO, head_repo: REPO, base_ref: 'main', head_ref: branch, merge_commit: COMMIT, merged_at: MERGED_AT, merged_by: 'keshav' } });
  assert.deepEqual(askGitHub(url, { run: answers({ status: 0, stderr: '', stdout: JSON.stringify(closedPr(77)) }) }),
    { answer: { state: 'closed', number: 77, url, repo: REPO, head_repo: REPO, base_ref: 'main', head_ref: null, merge_commit: null, merged_at: null, merged_by: null } });
  // The branch's repository and the base are kept only when they read as what they are.
  const answerWith = (extra) => askGitHub(url, { run: answers({ status: 0, stderr: '', stdout: JSON.stringify({ ...mergedPr(77), ...extra }) }) }).answer;
  assert.equal(answerWith({ headRepository: { name: 'Widgets' }, headRepositoryOwner: { login: 'ACME' } }).head_repo, 'acme/widgets', 'in lower case');
  for (const odd of [
    { headRepository: null, headRepositoryOwner: null },
    { headRepository: { name: 'widgets' }, headRepositoryOwner: {} },
    { headRepository: {}, headRepositoryOwner: { login: 'acme' } },
    { headRepository: { name: 'wid/gets' }, headRepositoryOwner: { login: 'acme' } },
    { headRepository: { name: 'widgets' }, headRepositoryOwner: { login: 'ac me' } },
    { headRepository: 'acme/widgets', headRepositoryOwner: 'acme' },
    { headRepository: { name: 42 }, headRepositoryOwner: { login: ['acme'] } },
  ]) assert.equal(answerWith(odd).head_repo, null, JSON.stringify(odd));
  assert.equal(answerWith({ baseRefName: ' release/3.74 ' }).base_ref, 'release/3.74');
  for (const odd of [null, '', '   ', 42, ['main'], {}]) assert.equal(answerWith({ baseRefName: odd }).base_ref, null, JSON.stringify(odd));
  assert.equal(askGitHub(url, { run: answers({ status: 0, stderr: '', stdout: JSON.stringify(openPr(77)) }) }).answer.state, 'open');
  // A link that is not a pull request link names no repository, and a link GitHub does not give is
  // not made up from the one that was asked: the repository comes only from what GitHub said.
  const noLink = askGitHub(url, { run: answers({ status: 0, stderr: '', stdout: JSON.stringify({ ...mergedPr(77), url: undefined }) }) }).answer;
  assert.deepEqual([noLink.url, noLink.repo], [url, null]);
  const oddLink = askGitHub(url, { run: answers({ status: 0, stderr: '', stdout: JSON.stringify({ ...mergedPr(77), url: 'https://github.com/acme/widgets/issues/77' }) }) }).answer;
  assert.equal(oddLink.repo, null);
  for (const odd of [42, '', '   ', null, ['x']]) {
    const answer = askGitHub(url, { run: answers({ status: 0, stderr: '', stdout: JSON.stringify({ ...mergedPr(77), headRefName: odd }) }) }).answer;
    assert.equal(answer.head_ref, null, JSON.stringify(odd));
  }

  const failed = (code) => ({ status: null, stdout: '', stderr: '', error: Object.assign(new Error(`spawnSync gh ${code}`), { code }) });
  assert.equal(askGitHub(url, { run: answers(failed('ETIMEDOUT')) }).outage.kind, 'timeout');
  assert.equal(askGitHub(url, { run: answers(failed('ENOENT')) }).outage.kind, 'gh_missing');
  // A shim or wrapper that cannot find gh exits 127, "command not found": the same outage as a missing gh.
  const notFound = askGitHub(url, { run: answers({ status: 127, stdout: '', stderr: 'env: gh: No such file or directory' }) });
  assert.equal(notFound.outage.kind, 'gh_missing');
  assert.match(notFound.outage.detail, /gh is not installed or not on the PATH \(it exited 127\), so nothing could be checked/);
  assert.equal(notFound.answer, undefined);
  assert.equal(notFound.unknown, undefined);
  for (const [label, result, pattern] of [
    ['gh failing', { status: 1, stdout: '', stderr: '\nHTTP 502: Bad Gateway\nmore' }, /^gh said: HTTP 502: Bad Gateway$/],
    ['gh failing with no words', { status: 4, stdout: '', stderr: '' }, /^gh exited 4$/],
    ['gh unable to start for another reason', failed('EACCES'), /^gh did not run: spawnSync gh EACCES$/],
    ['an answer that is not JSON', { status: 0, stdout: 'not json', stderr: '' }, /could not be read/],
    ['an answer that is not an object', { status: 0, stdout: '[1]', stderr: '' }, /could not be read/],
    ['a state it does not know', { status: 0, stdout: JSON.stringify({ ...openPr(77), state: 'LIMBO' }), stderr: '' }, /state .*LIMBO/],
    ['no pull request number', { status: 0, stdout: JSON.stringify({ ...openPr(77), number: 'x' }), stderr: '' }, /could not be read/],
  ]) {
    const asked = askGitHub(url, { run: answers(result) });
    assert.equal(asked.outage, undefined, label);
    assert.equal(asked.answer, undefined, label);
    assert.match(asked.unknown, pattern, label);
  }
});

test('a gh that hangs is given up on at the limit and counted as an outage', (t) => {
  const tools = fs.mkdtempSync(path.join(os.tmpdir(), 'held-sweep-slow-'));
  t.after(() => fs.rmSync(tools, { recursive: true, force: true }));
  const slow = path.join(tools, 'slow-gh');
  // It ignores the polite stop, so only a hard kill ends it.
  fs.writeFileSync(slow, `#!${process.execPath}\nprocess.on('SIGTERM', () => {});\nsetTimeout(() => {}, 30000);\n`, { mode: 0o755 });
  const started = Date.now();

  const asked = held().askGitHub(pullAt(77), { timeoutMs: 400, run: (command, args, options) => spawnSync(slow, args, options) });

  assert.equal(asked.outage.kind, 'timeout');
  assert.match(asked.outage.detail, /did not answer/);
  assert.ok(Date.now() - started < 15000, 'it did not wait for the hang');
});

test('answers that do not fit the job leave it unknown and unchanged', (t) => {
  const d = desk(t);
  const wrongNumber = d.heldJob('Answer for another pull request', 77);
  const noCommit = d.heldJob('Merged but no commit', 78);
  const unreadable = d.heldJob('Answer that is not JSON', 79);
  const noLink = d.heldJob('No link on the row', 80);
  d.db.prepare("UPDATE tasks SET metadata = json_set(metadata, '$.pull_request', json('{\"state\":\"open\",\"number\":80}')) WHERE id = ?").run(noLink);
  d.setGh({
    prs: { [pullAt(77)]: mergedPr(12), [pullAt(78)]: mergedPr(78, { mergeCommit: null }) },
    raw: { [pullAt(79)]: 'this is not json' },
  });
  const before = snapshot(d.dbPath);

  const report = d.sweepJson();

  assert.equal(report.ok, true);
  const byId = Object.fromEntries(report.results.map((r) => [r.task_id, r]));
  for (const id of [wrongNumber, noCommit, unreadable, noLink]) {
    assert.equal(byId[id].outcome, 'unknown', id);
    assert.equal(byId[id].action, 'none', id);
  }
  assert.match(byId[wrongNumber].detail, /answered for pull request 12, not 77/);
  assert.match(byId[noCommit].detail, /merged but gave no merge commit/);
  assert.match(byId[unreadable].detail, /could not be read/);
  assert.match(byId[noLink].detail, /pull request 80 but no link/);
  assert.equal(d.ghCalls().some((call) => /pull\/80/.test(call)), false, 'with no link there is nothing to ask');
  assert.deepEqual(snapshot(d.dbPath), before);
});

// ---------------------------------------------------------------------------
// Which jobs it works on.

test('a job in another workspace is neither asked about nor touched, unless every workspace is swept', (t) => {
  const d = desk(t);
  // Their workspace is another repository, and each job is proved against its own workspace's origin.
  const other = repoAt(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'held-sweep-other-'))), 'https://github.com/acme/gadgets.git');
  t.after(() => fs.rmSync(other, { recursive: true, force: true }));
  const mine = d.heldJob('Fix the feedback form', 77);
  const theirs = d.heldJob('Fix the invoice page', 78, { root: other, builder: 'fleet-claude', repo: 'acme/gadgets' });
  d.setGh({
    prs: { [pullAt(77)]: mergedPr(77), [pullAt(78, 'acme/gadgets')]: mergedPr(78, { url: pullAt(78, 'acme/gadgets'), baseRefName: 'trunk' }) },
    repos: { [repoLink('acme/gadgets')]: { defaultBranchRef: { name: 'trunk' } } },
  });
  const theirsBefore = snapshot(d.dbPath);
  const theirRows = (snap) => ({ task: snap.tasks.find((r) => r.id === theirs), events: snap.events.filter((e) => e.task_id === theirs) });

  const report = d.sweepJson();

  assert.deepEqual(d.ghCalls(), [`pr view ${pullAt(77)} --json ${FIELDS}`, askDefaultBranchCall()], 'the other workspace\'s pull request was never asked about');
  assert.equal(tasks.getTask(d.db, mine).status, 'done');
  assert.deepEqual(report.results.map((r) => r.task_id), [mine]);
  assert.equal(report.scope, 'workspace');
  assert.deepEqual(theirRows(snapshot(d.dbPath)), theirRows(theirsBefore), 'not one row or event of theirs changed');
  assert.equal(tasks.getTask(d.db, theirs).status, 'review');

  const everywhere = d.sweepJson('--everywhere');

  assert.equal(everywhere.scope, 'everywhere');
  assert.deepEqual(everywhere.results.map((r) => r.task_id), [theirs]);
  assert.equal(tasks.getTask(d.db, theirs).status, 'done');
  assert.deepEqual(playsOf(seasonOf(other, d.dbPath), theirs).map((o) => o.kind), ['took', 'landed']);
});

test('the store refuses a job that is not in the workspace it was told about', (t) => {
  const d = desk(t);
  const other = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'held-sweep-other-')));
  t.after(() => fs.rmSync(other, { recursive: true, force: true }));
  const theirs = d.heldJob('Fix the invoice page', 78, { root: other });
  const row = tasks.getTask(d.db, theirs);
  const expected = { updatedAt: row.updated_at, claimedBy: row.claimed_by, pullRequestUrl: pullAt(78) };
  const pullRequest = { repo: REPO, number: 78 };
  const before = snapshot(d.dbPath);

  const landed = tasks.landHeldMerge(d.db, { id: theirs, actor: 'keshav', workspaceRoot: d.dir, expected, pullRequest, merge: { merge_commit: COMMIT, number: 78, url: pullAt(78), merged_at: MERGED_AT } });
  const released = tasks.releaseClosedPullRequest(d.db, { id: theirs, actor: 'keshav', workspaceRoot: d.dir, expected, pullRequest, reason: 'pull request closed without landing: x' });

  assert.deepEqual([landed.landed, landed.reason], [false, 'not_in_workspace']);
  assert.deepEqual([released.released, released.reason], [false, 'not_in_workspace']);
  assert.deepEqual(snapshot(d.dbPath), before);

  // A caller that names no workspace at all is refused, so the guard cannot be skipped by leaving it out.
  assert.throws(() => tasks.landHeldMerge(d.db, { id: theirs, actor: 'keshav', expected, pullRequest, merge: { merge_commit: COMMIT, number: 78, url: pullAt(78), merged_at: MERGED_AT } }), /workspaceRoot required/);
  assert.throws(() => tasks.releaseClosedPullRequest(d.db, { id: theirs, actor: 'keshav', expected, pullRequest, reason: 'pull request closed without landing: x' }), /workspaceRoot required/);
  assert.deepEqual(snapshot(d.dbPath), before);
});

test('a job already landed or archived is neither asked about nor touched', (t) => {
  const d = desk(t);
  const live = d.heldJob('Still waiting', 77);
  const done = d.heldJob('A person closed it by hand', 78);
  const archived = d.heldJob('Swept off the board', 79);
  const alreadyMerged = d.heldJob('Landed with its merge on file', 80);
  assert.equal(tasks.doneTask(d.db, { id: done, status: 'done', actor: 'keshav', allowReview: true, action: 'accepted' }).updated, true);
  assert.equal(tasks.archiveTask(d.db, { id: archived, actor: 'keshav', reason: 'not needed' }).archived, true);
  tasks.readyTask(d.db, { id: alreadyMerged, actor: 'fleet-codex', proof: 'Merged by the builder with the commit on file.', merge: { merge_commit: COMMIT, number: 80, url: pullAt(80), merged_at: MERGED_AT } });
  d.setGh({ prs: { [pullAt(77)]: mergedPr(77), [pullAt(78)]: closedPr(78), [pullAt(79)]: closedPr(79), [pullAt(80)]: closedPr(80) } });
  const untouchedIds = [done, archived, alreadyMerged];
  const before = rowsOf(snapshot(d.dbPath), untouchedIds);

  const report = d.sweepJson();

  assert.deepEqual(d.ghCalls(), [`pr view ${pullAt(77)} --json ${FIELDS}`, askDefaultBranchCall()], 'only the job still waiting was asked about');
  assert.deepEqual(report.results.map((r) => r.task_id), [live]);
  assert.equal(tasks.getTask(d.db, live).status, 'done');
  assert.deepEqual(rowsOf(snapshot(d.dbPath), untouchedIds), before);
  assert.equal(tasks.getTask(d.db, done).status, 'done');
  assert.equal(tasks.getTask(d.db, archived).status, 'archived');
  assert.equal(tasks.getTask(d.db, alreadyMerged).status, 'review');
});

test('a review job with no open pull request, or with no builder, is not a held job', (t) => {
  const d = desk(t);
  const live = d.heldJob('Still waiting', 77);
  // An ordinary review job: the builder's proof names no pull request.
  const { id: plain } = tasks.addTask(d.db, { title: 'Ordinary review job', tag: 'feedback', workspaceRoot: d.dir });
  tasks.claimTask(d.db, { id: plain, claimedBy: 'fleet-codex', leaseMinutes: 60, leasePid: process.pid });
  tasks.readyTask(d.db, { id: plain, actor: 'fleet-codex', proof: 'Built and checked.' });
  // A review job with an open pull request on file and nobody who built it.
  const { id: nobody } = tasks.addTask(d.db, { title: 'Review job with no builder', tag: 'feedback', workspaceRoot: d.dir });
  tasks.readyTask(d.db, { id: nobody, actor: 'keshav', proof: 'Built by hand.', merge: { number: '81', url: pullAt(81) } });
  assert.equal(tasks.getTask(d.db, nobody).claimed_by, null);
  d.setGh({ prs: { [pullAt(77)]: mergedPr(77), [pullAt(81)]: mergedPr(81) } });
  const before = snapshot(d.dbPath);

  const report = d.sweepJson();

  assert.deepEqual(d.ghCalls(), [`pr view ${pullAt(77)} --json ${FIELDS}`, askDefaultBranchCall()]);
  assert.deepEqual(report.results.map((r) => r.task_id), [live]);
  assert.deepEqual(rowsOf(snapshot(d.dbPath), [plain, nobody]), rowsOf(before, [plain, nobody]));
});

test('what counts as held is one definition: in review, under a builder, pull request open, no merge on file', () => {
  const open = { state: 'open', number: 7, url: pullAt(7) };
  const row = (over = {}, pullRequest = open) => ({ status: 'review', claimed_by: 'fleet-codex', metadata: { pull_request: pullRequest }, ...over });

  assert.deepEqual(tasks.heldPullRequestOf(row()), { number: 7, url: pullAt(7) });
  assert.deepEqual(tasks.heldPullRequestOf(row({}, { state: 'OPEN', number: '7' })), { number: 7, url: null });
  assert.deepEqual(tasks.heldPullRequestOf(row({}, { state: 'open', url: pullAt(7) })), { number: null, url: pullAt(7) });
  const notHeld = {
    'a job that is done': row({ status: 'done' }),
    'a job that is open': row({ status: 'open' }),
    'a job nobody holds': row({ claimed_by: null }),
    'a pull request already merged': row({}, { ...open, state: 'merged' }),
    'a pull request already closed': row({}, { ...open, state: 'closed' }),
    'an open pull request with a merge commit on file': row({}, { ...open, merge_commit: COMMIT }),
    'an open pull request with a merge time on file': row({}, { ...open, merged_at: '2026-10-30T12:00:00Z' }),
    'a pull request with neither a number nor a link': row({}, { state: 'open' }),
    'a link that is not a web link': row({}, { state: 'open', url: 'file:///etc/passwd' }),
    'no pull request': row({ metadata: {} }),
    'no metadata': row({ metadata: null }),
    'no row': null,
  };
  for (const [what, value] of Object.entries(notHeld)) assert.equal(tasks.heldPullRequestOf(value), null, what);
});

test('a job sent to review again after its pull request was closed is not held, and the closed one is not asked about again', (t) => {
  const d = desk(t);
  const id = d.heldJob('Fix the feedback form', 78);
  d.setGh({ prs: { [pullAt(78)]: closedPr(78) } });
  assert.equal(d.sweepJson().summary.released, 1);
  const calls = d.ghCalls().length;
  // Another builder takes it and hands in work that names no pull request.
  assert.equal(tasks.claimTask(d.db, { id, claimedBy: 'fleet-claude', leaseMinutes: 60, leasePid: process.pid }).claimed, true);
  assert.equal(tasks.readyTask(d.db, { id, actor: 'fleet-claude', proof: 'Rebuilt and checked on this machine.' }).ready, true);
  const row = tasks.getTask(d.db, id);
  assert.equal(row.status, 'review');
  assert.equal(row.metadata.pull_request, undefined, 'the new attempt does not carry the old attempt\'s pull request, closed or not');
  assert.equal(tasks.heldPullRequestOf(row), null);
  const before = snapshot(d.dbPath);

  const again = d.sweepJson();

  assert.deepEqual(again.results, []);
  assert.equal(d.ghCalls().length, calls, 'the closed pull request was not asked about again');
  assert.deepEqual(snapshot(d.dbPath), before);
  const season = seasonOf(d.dir, d.dbPath);
  assert.equal(season.reviews.find((review) => review.task_id === id).waiting_on_pull_request, undefined);
});

test('a job that changes while GitHub is being asked is left alone', (t) => {
  const d = desk(t);
  const archivedMeanwhile = d.heldJob('Archived while asking', 77);
  const reassignedMeanwhile = d.heldJob('New pull request while asking', 78);
  const settledMeanwhile = d.heldJob('Closed by hand while asking', 79);
  const answers = { [pullAt(77)]: 'merged', [pullAt(78)]: 'closed', [pullAt(79)]: 'merged' };
  const ids = { [pullAt(77)]: archivedMeanwhile, [pullAt(78)]: reassignedMeanwhile, [pullAt(79)]: settledMeanwhile };
  const ask = (url) => {
    // Someone else acts on the job after the sweep read it and before GitHub answered.
    if (url === pullAt(77)) tasks.archiveTask(d.db, { id: archivedMeanwhile, actor: 'harman', reason: 'not needed' });
    if (url === pullAt(78)) tasks.readyTask(d.db, { id: reassignedMeanwhile, actor: 'fleet-codex', proof: 'Rebuilt with a new pull request.', merge: { number: '88', url: pullAt(88) } });
    if (url === pullAt(79)) tasks.doneTask(d.db, { id: settledMeanwhile, status: 'done', actor: 'harman', allowReview: true, action: 'accepted' });
    const number = Number(url.split('/').pop());
    const own = { number, url, repo: REPO, head_repo: REPO, base_ref: 'main', head_ref: buildBranch(ids[url]) };
    return { answer: answers[url] === 'merged'
      ? { state: 'merged', ...own, merge_commit: COMMIT, merged_at: MERGED_AT, merged_by: 'keshav' }
      : { state: 'closed', ...own, merge_commit: null, merged_at: null, merged_by: null } };
  };
  const report = held().sweepHeldJobs(tasks, d.db, { workspaceRoot: d.dir, actor: 'keshav', ask, askBranch: () => ({ branch: 'main' }) });

  assert.deepEqual(report.results.map((r) => r.action), ['left_alone', 'left_alone', 'left_alone']);
  assert.deepEqual([report.summary.landed, report.summary.released], [0, 0]);
  assert.equal(tasks.getTask(d.db, archivedMeanwhile).status, 'archived');
  assert.deepEqual(eventTypes(d.db, archivedMeanwhile), ['created', 'claimed', 'proof_ready', 'archived']);
  const reassigned = tasks.getTask(d.db, reassignedMeanwhile);
  assert.equal(reassigned.status, 'review', 'the new pull request still waits');
  assert.equal(reassigned.claimed_by, 'fleet-codex');
  assert.equal(reassigned.metadata.pull_request.url, pullAt(88));
  assert.deepEqual(eventTypes(d.db, reassignedMeanwhile), ['created', 'claimed', 'proof_ready', 'proof_ready']);
  assert.deepEqual(eventTypes(d.db, settledMeanwhile), ['created', 'claimed', 'proof_ready', 'completed']);
  assert.equal(eventsOf(d.db, settledMeanwhile).pop().payload.action, 'accepted', 'the person\'s own acceptance is the one on file');
});

test('the store lands and releases a held job only while the row is still the one that was read', (t) => {
  const d = desk(t);
  const merge = { merge_commit: COMMIT, number: 77, url: pullAt(77), merged_at: MERGED_AT, merged_by: 'keshav' };
  const reason = 'pull request closed without landing: x';
  const pullRequest = { repo: REPO, number: 77 };
  // What a caller read before it asked GitHub.
  const read = (id, number = 77) => {
    const row = tasks.getTask(d.db, id);
    return { updatedAt: row.updated_at, claimedBy: row.claimed_by, pullRequestUrl: pullAt(number) };
  };
  const cases = [
    ['a row the store does not know', (id) => ({ id: 'no-such-row', expected: read(id) }), 'not_found'],
    ['a row changed since it was read', (id) => ({ id, expected: { ...read(id), updatedAt: read(id).updatedAt - 1 } }), 'stale_task_state'],
    ['a row that changed hands', (id) => ({ id, expected: { ...read(id), claimedBy: 'someone-else' } }), 'stale_task_state'],
    ['a row that points at another pull request', (id) => ({ id, expected: { ...read(id), pullRequestUrl: pullAt(99) } }), 'stale_task_state'],
  ];
  for (const [label, build, why] of cases) {
    const id = d.heldJob(`Case: ${label}`, 77);
    const before = snapshot(d.dbPath);
    const args = { actor: 'keshav', workspaceRoot: d.dir, pullRequest, ...build(id) };
    const landed = tasks.landHeldMerge(d.db, { ...args, merge });
    const released = tasks.releaseClosedPullRequest(d.db, { ...args, reason });
    assert.deepEqual([landed.landed, landed.reason], [false, why], `land: ${label}`);
    assert.deepEqual([released.released, released.reason], [false, why], `release: ${label}`);
    assert.deepEqual(snapshot(d.dbPath), before, label);
  }

  // A merge with no commit to record, or no time to date it by, is refused whatever the row says.
  const noCommit = d.heldJob('Case: no commit', 77);
  const beforeNoCommit = snapshot(d.dbPath);
  for (const bad of [
    { number: 77, url: pullAt(77), merged_at: MERGED_AT },
    { merge_commit: 'not a commit', merged_at: MERGED_AT },
    { merge_commit: COMMIT, number: 77, url: pullAt(77) },
    { merge_commit: COMMIT, number: 77, url: pullAt(77), merged_at: 'some time last week' },
    { merge_commit: COMMIT, number: 77, url: pullAt(77), merged_at: '' },
    null,
  ]) {
    const refused = tasks.landHeldMerge(d.db, { id: noCommit, actor: 'keshav', workspaceRoot: d.dir, expected: read(noCommit), pullRequest, merge: bad });
    assert.deepEqual([refused.landed, refused.reason], [false, 'invalid_merge_record']);
  }
  assert.deepEqual(snapshot(d.dbPath), beforeNoCommit);

  // A row that is no longer in Review, and a Review row that is not a held job.
  const done = d.heldJob('Case: done', 77);
  tasks.doneTask(d.db, { id: done, status: 'done', actor: 'keshav', allowReview: true, action: 'accepted' });
  const { id: plain } = tasks.addTask(d.db, { title: 'Case: not held', tag: 'feedback', workspaceRoot: d.dir });
  tasks.claimTask(d.db, { id: plain, claimedBy: 'fleet-codex', leaseMinutes: 60, leasePid: process.pid });
  tasks.readyTask(d.db, { id: plain, actor: 'fleet-codex', proof: 'Built and checked.' });
  for (const [id, why] of [[done, 'already_done'], [plain, 'not_held']]) {
    const args = { id, actor: 'keshav', workspaceRoot: d.dir, expected: read(id), pullRequest };
    assert.equal(tasks.landHeldMerge(d.db, { ...args, merge }).reason, why);
    assert.equal(tasks.releaseClosedPullRequest(d.db, { ...args, reason }).reason, why);
  }

  // A merger that does not look like a login is not kept, and the merge still lands. (Its pull
  // request is its own: the jobs above that name 77 would each be another live job on it.)
  const odd = d.heldJob('Case: odd merger', 90);
  const landedOdd = tasks.landHeldMerge(d.db, { id: odd, actor: 'keshav', workspaceRoot: d.dir, expected: read(odd, 90), pullRequest: { repo: REPO, number: 90 }, merge: { ...merge, number: 90, url: pullAt(90), merged_by: 'two words\nand a line' } });
  assert.equal(landedOdd.landed, true);
  assert.equal(tasks.getTask(d.db, odd).metadata.pull_request.merged_by, undefined);
  assert.equal(tasks.getTask(d.db, odd).metadata.pull_request.merge_commit, COMMIT);

  // A caller that does not say what it read, or which pull request it is settling, cannot write at all.
  assert.throws(() => tasks.landHeldMerge(d.db, { id: plain, actor: 'keshav', workspaceRoot: d.dir, pullRequest, merge }), /expected/);
  assert.throws(() => tasks.releaseClosedPullRequest(d.db, { id: plain, actor: 'keshav', workspaceRoot: d.dir, pullRequest, reason }), /expected/);
  for (const missing of [undefined, null, {}, { repo: REPO }, { number: 77 }, { repo: 'not a repository', number: 77 }, { repo: REPO, number: 0 }, { repo: REPO, number: '77x' }]) {
    const args = { id: plain, actor: 'keshav', workspaceRoot: d.dir, expected: read(plain), pullRequest: missing };
    assert.throws(() => tasks.landHeldMerge(d.db, { ...args, merge }), /pullRequest required/, JSON.stringify(missing));
    assert.throws(() => tasks.releaseClosedPullRequest(d.db, { ...args, reason }), /pullRequest required/, JSON.stringify(missing));
  }
});

// ---------------------------------------------------------------------------
// The next builder starts with a clean review record. A job's builder is stamped by its first
// hand-in, and two passes certify a job when one of them is not the builder's. If the last
// builder's name and passes stayed on a job whose claim was let go, the next builder would count
// as an independent check of its own work and certify itself with two passes of its own.

const readyTwice = (db, id, actor) => {
  for (const pass of [1, 2]) assert.equal(tasks.readyTask(db, { id, actor, proof: `Pass ${pass} by ${actor}: node --test exited 0.` }).ready, true);
  return tasks.getTask(db, id);
};
// What a finished attempt leaves that the next attempt must not inherit.
const REVIEW_RECORD = ['built_by', 'agent_review_actors', 'agent_review_pass_count', 'independent_review_by', 'agent_certified'];
const noReviewRecord = (row) => {
  for (const key of REVIEW_RECORD) assert.equal(row.metadata[key], undefined, key);
};
// A job its builder handed in once and a person sent back: claimed by that builder, with the
// review record the hand-in left and the revision note.
const sentBackJob = (d) => {
  const { id } = tasks.addTask(d.db, { title: 'Fix the feedback form', tag: 'feedback', workspaceRoot: d.dir });
  claimFor(d.db, id, 'fleet-codex');
  assert.equal(tasks.readyTask(d.db, { id, actor: 'fleet-codex', proof: 'Built and checked.' }).ready, true);
  assert.equal(tasks.reviseTask(d.db, { id, actor: 'harman', note: 'the button is the wrong colour' }).revised, true);
  const row = tasks.getTask(d.db, id);
  assert.deepEqual([row.status, row.claimed_by], ['claimed', 'fleet-codex']);
  assert.equal(row.metadata.built_by, 'fleet-codex', 'while the same builder fixes it, its name stays on the job');
  assert.deepEqual(row.metadata.agent_review_actors, ['fleet-codex']);
  return id;
};
// The next builder hands in twice by itself, and no one certifies its own work.
const assertCannotSelfCertify = (d, id) => {
  claimFor(d.db, id, 'fleet-claude');
  const after = readyTwice(d.db, id, 'fleet-claude');
  assert.notEqual(after.metadata.agent_certified, true, 'two passes by the one builder are not an independent check');
  assert.equal(after.metadata.built_by, 'fleet-claude', 'the builder on record is the one who built this attempt');
  // A pass by someone else still certifies, so the check itself is intact.
  assert.equal(tasks.readyTask(d.db, { id, actor: 'fleet-gemini', proof: 'Independent pass: node --test exited 0.' }).ready, true);
  const certified = tasks.getTask(d.db, id);
  assert.equal(certified.metadata.agent_certified, true);
  assert.equal(certified.metadata.independent_review_by, 'fleet-gemini');
};

test('after a closed pull request lets the claim go, the next builder cannot certify its own work', (t) => {
  const d = desk(t);
  const id = d.heldJob('Fix the feedback form', 77);
  assert.equal(tasks.getTask(d.db, id).metadata.built_by, 'fleet-codex');
  d.setGh({ prs: { [pullAt(77)]: closedPr(77) } });
  assert.equal(d.sweepJson().summary.released, 1);
  noReviewRecord(tasks.getTask(d.db, id));

  assertCannotSelfCertify(d, id);
});

test('a reopened job does not keep the last builder on record either', (t) => {
  const d = desk(t);
  const id = d.heldJob('Fix the feedback form', 77);
  assert.equal(tasks.reopenTask(d.db, { id, actor: 'harman', reason: 'redo it', fromReview: true }).reopened, true);
  noReviewRecord(tasks.getTask(d.db, id));

  assertCannotSelfCertify(d, id);
});

test('a claim let go after the work was handed in and sent back does not leave the last builder on record', (t) => {
  const d = desk(t);
  const id = sentBackJob(d);

  assert.equal(tasks.releaseTask(d.db, { id, actor: 'fleet-codex', reason: 'paused at ship: blocked' }).released, true);

  const released = tasks.getTask(d.db, id);
  assert.equal(released.status, 'open');
  noReviewRecord(released);
  assert.equal(released.metadata.approval_status, 'revise', 'the job is still marked sent back, with the reason');
  assert.equal(released.metadata.human_revision_note, 'the button is the wrong colour');
  assertCannotSelfCertify(d, id);
});

test('a claim that expires after the work was handed in and sent back does not leave the last builder on record', (t) => {
  const d = desk(t);
  const id = sentBackJob(d);
  assert.equal(tasks.setLease(d.db, { id, holder: 'fleet-codex' }), true);

  const expired = tasks.expireLeases(d.db, { now: Date.now() + 3 * HOUR, isAlive: () => false });

  assert.deepEqual(expired.map((e) => e.id), [id]);
  const row = tasks.getTask(d.db, id);
  assert.equal(row.status, 'open');
  noReviewRecord(row);
  assert.equal(row.metadata.approval_status, 'revise');
  assertCannotSelfCertify(d, id);
});

test('a claim let go before any hand-in has no review record to clear, and the same builder keeps its own while it fixes sent-back work', (t) => {
  const d = desk(t);
  const { id: fresh } = tasks.addTask(d.db, { title: 'Never handed in', tag: 'feedback', workspaceRoot: d.dir });
  claimFor(d.db, fresh, 'fleet-codex');
  const metadataBefore = tasks.getTask(d.db, fresh).metadata;
  assert.equal(tasks.releaseTask(d.db, { id: fresh, actor: 'fleet-codex', reason: 'paused at start' }).released, true);
  assert.deepEqual(tasks.getTask(d.db, fresh).metadata, (() => { const { lease, ...rest } = metadataBefore; return rest; })());

  // The same builder, still holding the sent-back job, hands in again: its record carries on and
  // its own passes alone still do not certify.
  const id = sentBackJob(d);
  const again = readyTwice(d.db, id, 'fleet-codex');
  assert.equal(again.metadata.built_by, 'fleet-codex');
  assert.notEqual(again.metadata.agent_certified, true);
});

// ---------------------------------------------------------------------------
// A pull request belongs to one build attempt. An attempt starts when a job is claimed from open,
// or handed in or started by someone who did not hold it, and whatever the last attempt left about
// its pull request goes with it: the link on the row and any merge commit. A person's sent-back
// note stays. The store claims a job only from open, so no claim is ever made to review work that
// is already in Review, and a review pass, which is not a new attempt, keeps the link.

const SENT_BACK_NOTE = 'the button is the wrong colour';
// Open jobs a new builder may take, each carrying what an earlier attempt left on the row.
const backInOpen = (d) => {
  // One. Its pull request was closed, and the sweep let the claim go.
  const closed = d.heldJob('Closed, then let go', 91);
  d.setGh({ prs: { [pullAt(91)]: closedPr(91) } });
  assert.equal(d.sweepJson().summary.released, 1);
  // Two. A person sent it back, and its builder then let the claim go with the pull request still open on the row.
  const sentBack = d.heldJob('Sent back, then let go', 92);
  assert.equal(tasks.reviseTask(d.db, { id: sentBack, actor: 'harman', note: SENT_BACK_NOTE }).revised, true);
  assert.equal(tasks.releaseTask(d.db, { id: sentBack, actor: 'fleet-codex', reason: 'paused at start' }).released, true);
  // Three. A flight landed it, a person accepted it, and it was reopened: the merge commit stays on the row.
  const reopened = landedWith(d, 'Landed, then reopened', 93, {
    then: (id) => assert.equal(tasks.doneTask(d.db, { id, status: 'done', actor: 'harman', allowReview: true, action: 'accepted' }).updated, true),
  });
  assert.equal(tasks.reopenTask(d.db, { id: reopened, actor: 'harman', reason: 'redo it' }).reopened, true);
  return { closed, sentBack, reopened };
};

test('a claim from open starts a new attempt: the last one\'s pull request link and merge commit are gone, the sent-back note stays, and the hand-in after it carries nothing forward', (t) => {
  const d = desk(t);
  const jobs = backInOpen(d);
  const calls = d.ghCalls().length;
  for (const [label, id] of Object.entries(jobs)) {
    const stale = tasks.getTask(d.db, id);
    assert.equal(stale.status, 'open', label);
    assert.ok(stale.metadata.pull_request || stale.metadata.merge_commit, `${label}: the open job still carries what the last attempt left`);

    claimFor(d.db, id, 'fleet-claude');

    const claimed = tasks.getTask(d.db, id);
    assert.equal(claimed.metadata.pull_request, undefined, `${label}: link`);
    assert.equal(claimed.metadata.merge_commit, undefined, `${label}: merge commit`);
    if (label === 'sentBack') {
      assert.equal(claimed.metadata.approval_status, 'revise', 'the job is still marked sent back');
      assert.equal(claimed.metadata.human_revision_note, SENT_BACK_NOTE, 'with the reason');
    }
    // The new builder hands in work that names no pull request. It is not held for anyone's old one.
    assert.equal(tasks.readyTask(d.db, { id, actor: 'fleet-claude', proof: 'Rebuilt and checked on this machine.' }).ready, true);
    const handedIn = tasks.getTask(d.db, id);
    assert.deepEqual([handedIn.status, handedIn.claimed_by], ['review', 'fleet-claude'], label);
    assert.equal(handedIn.metadata.pull_request, undefined, `${label}: nothing carried into the hand-in`);
    assert.equal(handedIn.metadata.merge_commit, undefined, `${label}: no merge commit either`);
    assert.equal(tasks.heldPullRequestOf(handedIn), null, label);
  }
  const report = d.sweepJson();
  assert.deepEqual(report.results, [], 'nothing is held, so fleet-claude is credited for no earlier attempt\'s pull request');
  assert.equal(d.ghCalls().length, calls, 'and GitHub is not asked');
});

test('work handed in on an open job starts a new attempt too: the last one\'s link and merge commit are gone, and only the new link is kept', (t) => {
  const d = desk(t);
  const jobs = backInOpen(d);
  const bare = (id) => assert.equal(tasks.readyTask(d.db, { id, actor: 'keshav', proof: 'Built by hand.' }).ready, true);

  bare(jobs.closed);
  bare(jobs.sentBack);

  for (const id of [jobs.closed, jobs.sentBack]) {
    const row = tasks.getTask(d.db, id);
    assert.equal(row.status, 'review');
    assert.equal(row.metadata.pull_request, undefined, 'no pull request of the last attempt');
    assert.equal(row.metadata.merge_commit, undefined);
  }
  // Handed in with a pull request of its own, only that one is on the row.
  assert.equal(tasks.readyTask(d.db, { id: jobs.reopened, actor: 'keshav', proof: 'Built by hand.', merge: { number: '95', url: pullAt(95) } }).ready, true);
  const row = tasks.getTask(d.db, jobs.reopened);
  assert.deepEqual(row.metadata.pull_request, { state: 'open', number: 95, url: pullAt(95) });
  assert.equal(row.metadata.merge_commit, undefined, 'the merge commit of the last attempt did not come along');
});

test('starting work with task do is a new attempt too, and a builder who keeps working on its own sent-back job keeps its own link', (t) => {
  const d = desk(t);
  const jobs = backInOpen(d);
  const startWork = (id, actor) => {
    assert.equal(tasks.stageTask(d.db, { id, actor, stage: 'plan', goal: 'Fix it', exit: 'It works', proofNeeded: 'node --test exits 0' }).staged, true);
    const doing = tasks.stageTask(d.db, { id, actor, stage: 'do', firstMove: 'start' });
    assert.equal(doing.staged, true, JSON.stringify(doing));
    return tasks.getTask(d.db, id);
  };
  for (const [label, id] of Object.entries(jobs)) {
    const row = startWork(id, 'fleet-claude');
    assert.deepEqual([row.status, row.claimed_by], ['claimed', 'fleet-claude'], label);
    assert.equal(row.metadata.pull_request, undefined, `${label}: link`);
    assert.equal(row.metadata.merge_commit, undefined, `${label}: merge commit`);
  }
  // A claimed job nobody holds is handed to whoever starts it.
  const { id: unowned } = tasks.addTask(d.db, { title: 'Claimed with no owner', tag: 'feedback', workspaceRoot: d.dir, status: 'claimed' });
  d.db.prepare("UPDATE tasks SET metadata = json_set(COALESCE(metadata, '{}'), '$.pull_request', json(?), '$.merge_commit', ?) WHERE id = ?")
    .run(JSON.stringify({ state: 'open', number: 96, url: pullAt(96) }), COMMIT, unowned);
  assert.equal(tasks.getTask(d.db, unowned).metadata.pull_request.number, 96);
  const started = startWork(unowned, 'fleet-claude');
  assert.equal(started.claimed_by, 'fleet-claude');
  assert.equal(started.metadata.pull_request, undefined);
  assert.equal(started.metadata.merge_commit, undefined);
  // The builder who holds a sent-back job and starts work on it again is on the same attempt.
  const mine = d.heldJob('Sent back, the same builder fixes it', 97);
  assert.equal(tasks.reviseTask(d.db, { id: mine, actor: 'harman', note: SENT_BACK_NOTE }).revised, true);
  const again = startWork(mine, 'fleet-codex');
  assert.equal(again.claimed_by, 'fleet-codex');
  assert.deepEqual(again.metadata.pull_request, { state: 'open', number: 97, url: pullAt(97) });
});

// The claim and the drop of the last attempt's evidence are one write. `task do` used to take the
// claim in one write and drop the link in a second, so a hand-in landing between the two kept the
// old link. `watching` hands a test the store with a look after each write to a job's row: that is
// the moment a second writer can slip in, and the moment to read the row as that write left it.
const watching = (db, after) => new Proxy(db, {
  get(target, name) {
    const member = target[name];
    if (name !== 'prepare') return typeof member === 'function' ? member.bind(target) : member;
    return (sql) => {
      const statement = target.prepare(sql);
      if (!/^\s*UPDATE tasks\b/i.test(sql)) return statement;
      return new Proxy(statement, {
        get(inner, key) {
          const part = inner[key];
          if (key !== 'run') return typeof part === 'function' ? part.bind(inner) : part;
          return (...params) => {
            const outcome = inner.run(...params);
            if (outcome.changes === 1) after(sql);
            return outcome;
          };
        },
      });
    };
  },
});
const planFor = (db, id, actor) => assert.equal(tasks.stageTask(db, { id, actor, stage: 'plan', goal: 'Fix it', exit: 'It works', proofNeeded: 'node --test exits 0' }).staged, true);

// Two writers meeting. A second connection to the store stands in for another process: it has no patience for a
// lock (its busy timeout is zero), so a write it cannot make is turned away at once instead of waiting.
const otherProcess = (t, d) => {
  const other = new DatabaseSync(d.dbPath);
  other.exec('PRAGMA busy_timeout = 0');
  t.after(() => other.close());
  return other;
};
// What a try came to: its answer, or the error it ended in.
const tryTo = (attempt) => {
  try {
    return { answer: attempt() };
  } catch (err) {
    return { error: String(err && err.message) };
  }
};
// A connection that does something right before the first statement of this kind runs: the instant after the store
// has written a job's row and before it writes the entry. It stands for another process looking, or writing, at
// that moment.
function justBefore(db, pattern, act) {
  let armed = true;
  const bound = (target, value) => (typeof value === 'function' ? value.bind(target) : value);
  return new Proxy(db, {
    get(target, name) {
      if (name !== 'prepare') return bound(target, target[name]);
      return (sql) => {
        const statement = target.prepare(sql);
        if (!pattern.test(sql)) return statement;
        return new Proxy(statement, {
          get(inner, member) {
            if (member !== 'run') return bound(inner, inner[member]);
            return (...params) => {
              if (armed) { armed = false; act(); }
              return inner.run(...params);
            };
          },
        });
      };
    },
  });
}
// The same, right before the connection asks for the write lock: a writer that has to wait is waiting, and the
// world goes on.
function justBeforeLock(db, act) {
  let armed = true;
  return new Proxy(db, {
    get(target, name) {
      const value = target[name];
      if (name !== 'exec') return typeof value === 'function' ? value.bind(target) : value;
      return (sql) => {
        if (armed && /^\s*BEGIN IMMEDIATE/i.test(sql)) { armed = false; act(); }
        return target.exec(sql);
      };
    },
  });
}
// A disk that is full for one kind of history entry.
const noRoomFor = (db, eventType) => db.exec(`CREATE TRIGGER no_room_for_${eventType} BEFORE INSERT ON task_events WHEN NEW.event_type = '${eventType}' BEGIN SELECT RAISE(ABORT, 'no space left on device'); END`);
const roomAgain = (db, eventType) => db.exec(`DROP TRIGGER no_room_for_${eventType}`);
// A claimed job nobody holds, with an earlier attempt's link and merge commit still on it.
const unownedWithLink = (d) => {
  const { id } = tasks.addTask(d.db, { title: 'Claimed with no owner', tag: 'feedback', workspaceRoot: d.dir, status: 'claimed' });
  d.db.prepare("UPDATE tasks SET metadata = json_set(COALESCE(metadata, '{}'), '$.pull_request', json(?), '$.merge_commit', ?) WHERE id = ?")
    .run(JSON.stringify({ state: 'open', number: 96, url: pullAt(96) }), COMMIT, id);
  return id;
};
// What another connection sees of a job being started: its row, the claims fleet-claude has on record for it, and
// whether the last attempt's link or merge commit is still on it.
const startSeenBy = (apart, id) => {
  const row = apart.prepare('SELECT status, claimed_by, metadata FROM tasks WHERE id = ?').get(id);
  const claims = apart.prepare("SELECT COUNT(*) AS n FROM task_events WHERE task_id = ? AND event_type = 'claimed' AND actor = 'fleet-claude'").get(id).n;
  const metadata = JSON.parse(row.metadata || '{}');
  return [row.status, row.claimed_by, claims, Boolean(metadata.pull_request || metadata.merge_commit)];
};

// ---------------------------------------------------------------------------
// The claim `task do` takes, the evidence it drops and the claimed entry are one transaction, and so is every
// other write it makes. Before, the claim was saved first and its entry a few statements later, and a hand-in
// landing between the two left a claim with no entry: the rating then tied a landing to the claim before it.

test('a hand-in tried in the middle of task do is turned away: the claim task do took always has its entry, and the hand-in made after it lands on that claim', (t) => {
  const d = desk(t);
  const jobs = backInOpen(d);
  const unowned = unownedWithLink(d);
  const other = otherProcess(t, d);
  for (const [label, id] of [['an open job', jobs.closed], ['a claimed job nobody holds', unowned]]) {
    planFor(d.db, id, 'fleet-claude');
    // The builder's hand-in arrives from another process right after the claim is written, before the stage is.
    const tries = [];
    const store = watching(d.db, () => {
      if (tries.length || tasks.getTask(d.db, id).claimed_by !== 'fleet-claude') return;
      tries.push(tryTo(() => tasks.readyTask(other, { id, actor: 'fleet-claude', proof: 'Handed in between the claim and the stage.' })));
    });

    const staged = tasks.stageTask(store, { id, actor: 'fleet-claude', stage: 'do', firstMove: 'start' });

    assert.equal(tries.length, 1, `${label}: a hand-in was tried in the middle of task do`);
    assert.notEqual(tries[0].answer && tries[0].answer.ready, true, `${label}: it did not land: ${JSON.stringify(tries[0])}`);
    assert.match(tries[0].error || '', /database is locked/, `${label}: the lock turned it away`);
    assert.equal(staged.staged, true, `${label}: and task do finished its own work: ${JSON.stringify(staged)}`);
    const claimed = tasks.getTask(d.db, id);
    assert.deepEqual([claimed.status, claimed.claimed_by], ['claimed', 'fleet-claude'], label);
    assert.equal(tasks.latestClaim(d.db, id).actor, 'fleet-claude', `${label}: the claim has its entry`);

    // Tried again once task do is done, the hand-in lands on that claim.
    assert.equal(tasks.readyTask(d.db, { id, actor: 'fleet-claude', proof: 'Handed in after task do.' }).ready, true, label);
    const handedIn = tasks.getTask(d.db, id);
    assert.deepEqual([handedIn.status, handedIn.claimed_by], ['review', 'fleet-claude'], label);
    assert.equal(handedIn.metadata.pull_request, undefined, `${label}: the last attempt's link did not come along`);
    assert.equal(handedIn.metadata.merge_commit, undefined, `${label}: nor its merge commit`);
    assert.deepEqual(eventTypes(d.db, id).slice(-4), ['task_planned', 'claimed', 'work_started', 'proof_ready'], `${label}: the history reads in order`);
  }
});

test('a hand-in that waited for the lock while task do claimed the job is refused with the usual answer, and the claim has its entry', (t) => {
  const d = desk(t);
  const { closed: id } = backInOpen(d);
  planFor(d.db, id, 'fleet-claude');
  let doing = null;
  // The hand-in looked at the job before task do claimed it. Task do runs, and is done, while the hand-in waits for the lock.
  const waiting = justBeforeLock(otherProcess(t, d), () => {
    doing = tasks.stageTask(d.db, { id, actor: 'fleet-claude', stage: 'do', firstMove: 'start' });
  });

  const handIn = tasks.readyTask(waiting, { id, actor: 'fleet-claude', proof: 'Handed in by a process that looked before task do claimed the job.' });

  assert.ok(doing, 'task do ran while the hand-in waited for the lock');
  assert.equal(doing.staged, true, JSON.stringify(doing));
  assert.deepEqual([handIn.ready, handIn.reason], [false, 'claim changed hands'], 'the hand-in found the job claimed since it looked, and wrote nothing');
  const row = tasks.getTask(d.db, id);
  assert.deepEqual([row.status, row.claimed_by], ['claimed', 'fleet-claude']);
  assert.equal(tasks.latestClaim(d.db, id).actor, 'fleet-claude');
  assert.deepEqual(eventTypes(d.db, id).slice(-3), ['task_planned', 'claimed', 'work_started']);
});

test('starting work with task do takes the claim, drops the last attempt\'s link and writes the claimed entry as one: nobody else can see one without the others', (t) => {
  const d = desk(t);
  const jobs = backInOpen(d);
  const unowned = unownedWithLink(d);
  const apart = new DatabaseSync(d.dbPath);
  t.after(() => apart.close());
  for (const [label, id, wasThen] of [
    ['an open job', jobs.closed, ['open', null]],
    ['a claimed job nobody holds', unowned, ['claimed', null]],
  ]) {
    planFor(d.db, id, 'fleet-claude');
    const atTheEntry = [];
    const racing = justBefore(d.db, /INSERT INTO task_events/, () => atTheEntry.push(startSeenBy(apart, id)));

    assert.equal(tasks.stageTask(racing, { id, actor: 'fleet-claude', stage: 'do', firstMove: 'start' }).staged, true, label);

    assert.deepEqual(atTheEntry, [[...wasThen, 0, true]], `${label}: another connection saw the job as it was, link and all, not a claim with no entry`);
    assert.deepEqual(startSeenBy(apart, id), ['claimed', 'fleet-claude', 1, false], `${label}: and then the claim, its entry and the clean slate together`);
  }
});

test('task do whose history entry cannot be saved is taken back with it, whichever way it started: the job is exactly as it was, and the retry claims once', (t) => {
  const d = desk(t);
  const jobs = backInOpen(d);
  const unowned = unownedWithLink(d);
  const { id: mine } = tasks.addTask(d.db, { title: 'Claimed by the builder who starts it', tag: 'feedback', workspaceRoot: d.dir });
  claimFor(d.db, mine, 'fleet-claude');
  for (const [label, id, entry, stage] of [
    // The stage name is read the way the store reads it: any case, any spacing.
    ['an open job, failing at the claimed entry', jobs.closed, 'claimed', ' Do '],
    ['an open job, failing at the work_started entry', jobs.sentBack, 'work_started', 'do'],
    ['a claimed job nobody holds, failing at the claimed entry', unowned, 'claimed', 'do'],
    ['a job its builder holds, failing at the work_started entry', mine, 'work_started', 'do'],
  ]) {
    planFor(d.db, id, 'fleet-claude');
    const before = rowsOf(snapshot(d.dbPath), [id]);
    const start = () => tasks.stageTask(d.db, { id, actor: 'fleet-claude', stage, firstMove: 'start' });
    noRoomFor(d.db, entry);
    assert.throws(start, /no space left on device/, label);

    assert.deepEqual(rowsOf(snapshot(d.dbPath), [id]), before, `${label}: the job is exactly as it was: no claim, no stage, its old link still on it`);
    assert.notEqual(d.db.isTransaction, true, `${label}: and no transaction is left open`);
    roomAgain(d.db, entry);

    assert.equal(start().staged, true, `${label}: the retry started the work`);
    const entries = eventsOf(d.db, id);
    assert.equal(entries.filter((event) => event.type === 'claimed' && event.actor === 'fleet-claude').length, 1, `${label}: one claim on record`);
    assert.equal(entries.filter((event) => event.type === 'work_started').length, 1, `${label}: one start on record`);
  }
});

test('every way a build attempt starts drops the last attempt\'s link and merge commit in the very write that starts it', (t) => {
  const d = desk(t);
  const jobs = backInOpen(d);
  // The row as the first write to it left it.
  const afterFirstWrite = (id, run) => {
    let seen = null;
    run(watching(d.db, () => { if (!seen) seen = tasks.getTask(d.db, id); }));
    assert.ok(seen, 'the call wrote the job');
    return seen;
  };
  const noEvidence = (row, label) => {
    assert.equal(row.metadata.pull_request, undefined, `${label}: link`);
    assert.equal(row.metadata.merge_commit, undefined, `${label}: merge commit`);
  };
  const stale = (id) => assert.ok(tasks.getTask(d.db, id).metadata.pull_request || tasks.getTask(d.db, id).metadata.merge_commit, 'the job carries what the last attempt left');

  // One. A claim from open.
  stale(jobs.closed);
  const claimed = afterFirstWrite(jobs.closed, (store) => assert.equal(tasks.claimTask(store, { id: jobs.closed, claimedBy: 'fleet-claude', leaseMinutes: 60, leasePid: process.pid }).claimed, true));
  assert.equal(claimed.status, 'claimed');
  noEvidence(claimed, 'claim from open');

  // Two. Work handed in on an open job.
  stale(jobs.sentBack);
  const handedIn = afterFirstWrite(jobs.sentBack, (store) => assert.equal(tasks.readyTask(store, { id: jobs.sentBack, actor: 'keshav', proof: 'Built by hand.' }).ready, true));
  assert.equal(handedIn.status, 'review');
  noEvidence(handedIn, 'hand-in on an open job');

  // Three. `task do` on an open job.
  stale(jobs.reopened);
  planFor(d.db, jobs.reopened, 'fleet-claude');
  const doing = afterFirstWrite(jobs.reopened, (store) => assert.equal(tasks.stageTask(store, { id: jobs.reopened, actor: 'fleet-claude', stage: 'do', firstMove: 'start' }).staged, true));
  assert.equal(doing.status, 'claimed');
  assert.equal(doing.claimed_by, 'fleet-claude');
  noEvidence(doing, 'task do on an open job');

  // Four. `task do` on a claimed job nobody holds.
  const { id: unowned } = tasks.addTask(d.db, { title: 'Claimed with no owner', tag: 'feedback', workspaceRoot: d.dir, status: 'claimed' });
  d.db.prepare("UPDATE tasks SET metadata = json_set(COALESCE(metadata, '{}'), '$.pull_request', json(?), '$.merge_commit', ?) WHERE id = ?")
    .run(JSON.stringify({ state: 'open', number: 96, url: pullAt(96) }), COMMIT, unowned);
  stale(unowned);
  planFor(d.db, unowned, 'fleet-claude');
  const took = afterFirstWrite(unowned, (store) => assert.equal(tasks.stageTask(store, { id: unowned, actor: 'fleet-claude', stage: 'do', firstMove: 'start' }).staged, true));
  assert.equal(took.claimed_by, 'fleet-claude');
  noEvidence(took, 'task do on a job nobody holds');
});

test('a claim that asks for no lease starts a new attempt too', (t) => {
  const d = desk(t);
  const jobs = backInOpen(d);
  for (const [label, id] of Object.entries(jobs)) {
    assert.equal(tasks.claimTask(d.db, { id, claimedBy: 'fleet-claude' }).claimed, true, label);
    const claimed = tasks.getTask(d.db, id);
    assert.equal(claimed.metadata.lease, undefined, `${label}: no lease was asked for`);
    assert.equal(claimed.metadata.pull_request, undefined, `${label}: link`);
    assert.equal(claimed.metadata.merge_commit, undefined, `${label}: merge commit`);
  }
});

test('work handed in on a claimed job nobody holds is a new attempt, and on one somebody holds it is not', (t) => {
  const d = desk(t);
  const leftOver = (title, number, claimant) => {
    const { id } = tasks.addTask(d.db, { title, tag: 'feedback', workspaceRoot: d.dir, status: 'claimed' });
    d.db.prepare("UPDATE tasks SET claimed_by = ?, metadata = json_set(COALESCE(metadata, '{}'), '$.pull_request', json(?), '$.merge_commit', ?) WHERE id = ?")
      .run(claimant, JSON.stringify({ state: 'open', number, url: pullAt(number) }), COMMIT, id);
    return id;
  };
  const unowned = leftOver('Claimed with no owner', 96, null);
  const held = leftOver('Claimed and held by its builder', 97, 'fleet-codex');

  assert.equal(tasks.readyTask(d.db, { id: unowned, actor: 'keshav', proof: 'Built by hand.' }).ready, true);
  assert.equal(tasks.readyTask(d.db, { id: held, actor: 'fleet-codex', proof: 'Built and checked.' }).ready, true);

  const fresh = tasks.getTask(d.db, unowned).metadata;
  assert.equal(fresh.pull_request, undefined, 'nobody held it, so the last attempt\'s link is not carried into this hand-in');
  assert.equal(fresh.merge_commit, undefined);
  const same = tasks.getTask(d.db, held).metadata;
  assert.deepEqual(same.pull_request, { state: 'open', number: 97, url: pullAt(97) }, 'its own builder is still on the same attempt');
  assert.equal(same.merge_commit, COMMIT);
});

test('a review pass is not a new attempt: the job keeps its pull request link, and a job in review cannot be claimed over it', (t) => {
  const d = desk(t);
  const id = d.heldJob('Fix the feedback form', 77);
  const link = tasks.getTask(d.db, id).metadata.pull_request;
  assert.deepEqual(link, { state: 'open', number: 77, url: pullAt(77) });

  assert.equal(tasks.readyTask(d.db, { id, actor: 'fleet-claude', proof: 'Looked at it: node --test exited 0.' }).ready, true);
  assert.equal(tasks.readyTask(d.db, { id, actor: 'fleet-codex', proof: 'The builder looks again.' }).ready, true);

  assert.deepEqual(tasks.getTask(d.db, id).metadata.pull_request, link);
  // The store claims a job only from open, so no claim is made to review work that is already in Review.
  const claim = tasks.claimTask(d.db, { id, claimedBy: 'fleet-gemini' });
  assert.deepEqual([claim.claimed, claim.reason], [false, 'already_review']);
  const row = tasks.getTask(d.db, id);
  assert.deepEqual(row.metadata.pull_request, link);
  assert.deepEqual(tasks.heldPullRequestOf(row), { number: 77, url: pullAt(77) });
});

test('a claim still works on a job with no metadata, and leaves metadata it cannot read as it was', (t) => {
  const d = desk(t);
  const blank = (title, value) => {
    const { id } = tasks.addTask(d.db, { title, tag: 'feedback', workspaceRoot: d.dir });
    d.db.prepare('UPDATE tasks SET metadata = ? WHERE id = ?').run(value, id);
    return id;
  };
  const rawMetadata = (id) => d.db.prepare('SELECT metadata FROM tasks WHERE id = ?').get(id).metadata;

  const nothing = blank('No metadata at all', null);
  assert.equal(tasks.claimTask(d.db, { id: nothing, claimedBy: 'fleet-claude' }).claimed, true);
  assert.equal(rawMetadata(nothing), null);
  const leased = blank('No metadata, with a lease', null);
  assert.equal(tasks.claimTask(d.db, { id: leased, claimedBy: 'fleet-claude', leaseMinutes: 60, leasePid: process.pid }).claimed, true);
  assert.equal(tasks.getTask(d.db, leased).metadata.lease.holder, 'fleet-claude');
  const garbled = blank('Metadata that is not JSON', 'not json');
  assert.equal(tasks.claimTask(d.db, { id: garbled, claimedBy: 'fleet-claude' }).claimed, true);
  assert.equal(rawMetadata(garbled), 'not json');
});

// ---------------------------------------------------------------------------
// Authorship is cumulative. Anyone who ever claimed a job to build it, or handed work in on it, is
// one of its authors for good, and no author is an independent check of it: not one of the two
// passes that certify a job, and not a positive review. Sending the job back, letting the claim go
// or reopening it does not make a past builder look independent again.

const unclaimedAndHandedIn = (d, by = 'fleet-codex') => {
  const { id } = tasks.addTask(d.db, { title: 'Fix the feedback form', tag: 'feedback', workspaceRoot: d.dir });
  assert.equal(tasks.readyTask(d.db, { id, actor: by, proof: 'Built and checked.' }).ready, true);
  assert.equal(tasks.getTask(d.db, id).claimed_by, null, 'nobody held it');
  return id;
};
const passBy = (db, id, actor) => assert.equal(tasks.readyTask(db, { id, actor, proof: `Pass by ${actor}: node --test exited 0.` }).ready, true);
const certification = (db, id) => {
  const { agent_certified: certified, independent_review_by: by } = tasks.getTask(db, id).metadata;
  return [certified === true, by];
};

test('a job handed in with nobody holding it, then sent back, cannot be certified by the next builder\'s own passes, or by the first builder\'s', (t) => {
  const d = desk(t);
  const id = unclaimedAndHandedIn(d);
  assert.equal(tasks.reviseTask(d.db, { id, actor: 'harman', note: SENT_BACK_NOTE }).revised, true);
  assert.equal(tasks.getTask(d.db, id).status, 'open', 'sent back with no claimant, so it is open again');

  claimFor(d.db, id, 'fleet-claude');
  readyTwice(d.db, id, 'fleet-claude');
  assert.deepEqual(certification(d.db, id), [false, undefined], 'the builder\'s own two passes are not an independent check');
  passBy(d.db, id, 'fleet-codex');
  assert.deepEqual(certification(d.db, id), [false, undefined], 'neither is the first builder\'s');
  passBy(d.db, id, 'fleet-gemini');
  assert.deepEqual(certification(d.db, id), [true, 'fleet-gemini'], 'someone who built none of it is');
});

test('a review pass on a job with no builder on record does not stamp the reviewer as its builder', (t) => {
  const d = desk(t);
  // A row from before the builder was written down: claimed and handed in by fleet-codex, nothing stamped.
  const strip = (id) => d.db.prepare("UPDATE tasks SET metadata = json_remove(metadata, '$.built_by', '$.agent_review_actors', '$.independent_review_by', '$.agent_review_pass_count') WHERE id = ?").run(id);
  const reviewerFirst = d.heldJob('Fix the feedback form', 77);
  strip(reviewerFirst);
  assert.equal(tasks.getTask(d.db, reviewerFirst).metadata.built_by, undefined);

  passBy(d.db, reviewerFirst, 'fleet-claude');

  const afterReviewer = tasks.getTask(d.db, reviewerFirst);
  assert.equal(afterReviewer.metadata.built_by, 'fleet-codex', 'the builder is the one who held the claim, not the one who looked');
  assert.deepEqual(certification(d.db, reviewerFirst), [false, undefined], 'one pass is not two');
  passBy(d.db, reviewerFirst, 'fleet-codex');
  assert.deepEqual(certification(d.db, reviewerFirst), [true, 'fleet-claude'], 'the independent check is the reviewer, never the builder');

  // The builder's own passes, on a row with no builder on record, certify nothing.
  const own = d.heldJob('Fix the billing page', 78);
  strip(own);
  passBy(d.db, own, 'fleet-codex');
  passBy(d.db, own, 'fleet-codex');
  assert.equal(tasks.getTask(d.db, own).metadata.built_by, 'fleet-codex');
  assert.deepEqual(certification(d.db, own), [false, undefined]);
});

test('a past builder is never an independent reviewer of a job, however the job came back, and cannot give it a positive review', (t) => {
  const d = desk(t);
  const id = d.heldJob('Fix the feedback form', 77);
  assert.equal(tasks.reopenTask(d.db, { id, actor: 'harman', reason: 'redo it from scratch', fromReview: true }).reopened, true);
  noReviewRecord(tasks.getTask(d.db, id));
  claimFor(d.db, id, 'fleet-claude');
  passBy(d.db, id, 'fleet-claude');

  passBy(d.db, id, 'fleet-codex');

  const row = tasks.getTask(d.db, id);
  assert.equal(row.metadata.agent_review_pass_count, 2);
  assert.deepEqual(certification(d.db, id), [false, undefined], 'the job\'s first builder is not an independent check of the rebuild');
  // Neither of its builders may judge it, whichever way the name is written.
  for (const [label, actor, builder] of [['the first', 'fleet-codex', 'fleet-codex'], ['the second', 'fleet-claude', 'fleet-claude'], ['the first, spelled another way', ' Fleet_Codex ', 'fleet-codex']]) {
    const refused = tasks.reviewTask(d.db, { id, actor, reward: 1, proof: 'Looks good.' });
    assert.deepEqual([refused.reviewed, refused.reason, refused.builder], [false, 'judge_equals_worker', builder], label);
  }
  // Someone who built none of it can, and so can a pass that gives no reward.
  assert.equal(tasks.reviewTask(d.db, { id, actor: 'harman', reward: 1, proof: 'Looks good.' }).reviewed, true);
  passBy(d.db, id, 'fleet-gemini');
  assert.deepEqual(certification(d.db, id), [true, 'fleet-gemini']);
});

test('only a hand-in is written down as one: a review pass leaves no mark, and nor does a machine\'s name', (t) => {
  const d = desk(t);
  const { id } = tasks.addTask(d.db, { title: 'Fix the feedback form', tag: 'feedback', workspaceRoot: d.dir });
  claimFor(d.db, id, 'fleet-codex');

  for (const actor of ['fleet-codex', 'fleet-claude', 'autoland-verifier']) passBy(d.db, id, actor);

  const marks = eventsOf(d.db, id).filter((event) => event.type === 'proof_ready').map((event) => event.payload.handed_in_by);
  assert.deepEqual(marks, ['fleet-codex', undefined, undefined], 'the hand-in, then two passes');
  assert.deepEqual([...tasks.authorsOfTask(d.db, tasks.getTask(d.db, id))], ['fleet-codex']);
});

test('work handed in under a machine\'s name makes no author of the machine, which is still an independent check', (t) => {
  const d = desk(t);
  const { id } = tasks.addTask(d.db, { title: 'Fix the feedback form', tag: 'feedback', workspaceRoot: d.dir });
  claimFor(d.db, id, 'fleet-codex');

  passBy(d.db, id, 'autoland-verifier');

  assert.equal(eventsOf(d.db, id).find((event) => event.type === 'proof_ready').payload.handed_in_by, undefined);
  assert.equal(tasks.getTask(d.db, id).metadata.built_by, 'fleet-codex', 'the builder on record is the one who held the claim');
  assert.deepEqual([...tasks.authorsOfTask(d.db, tasks.getTask(d.db, id))], ['fleet-codex']);
  passBy(d.db, id, 'autoland-verifier');
  assert.deepEqual(certification(d.db, id), [true, 'autoland-verifier']);
});

test('a hand-in by someone who did not hold the claim makes both of them authors, and only a third party is independent', (t) => {
  const d = desk(t);
  const { id } = tasks.addTask(d.db, { title: 'Fix the feedback form', tag: 'feedback', workspaceRoot: d.dir });
  claimFor(d.db, id, 'fleet-codex');

  // The flight restaffed the job: the engine that built it is not the one that took the claim.
  passBy(d.db, id, ' Fleet_Claude ');

  assert.deepEqual([...tasks.authorsOfTask(d.db, tasks.getTask(d.db, id))].sort(), ['fleet-claude', 'fleet-codex']);
  passBy(d.db, id, 'fleet-codex');
  assert.deepEqual(certification(d.db, id), [false, undefined], 'the one who held the claim is an author');
  passBy(d.db, id, 'fleet-gemini');
  assert.deepEqual(certification(d.db, id), [true, 'fleet-gemini']);
});

test('a hand-in can name the others who built the work with it: each is an author for good, and none is an independent check', (t) => {
  const d = desk(t);
  const { id } = tasks.addTask(d.db, { title: 'Fix the feedback form', tag: 'feedback', workspaceRoot: d.dir });
  claimFor(d.db, id, 'maya');

  // A flight that ran for a member: two engines built it, and the member's name is on the hand-in.
  // The names come as written, and the hand-in's own name, a machine's name, blanks and repeats mean nothing.
  const handedIn = tasks.readyTask(d.db, {
    id, actor: 'maya', proof: 'Built and checked.',
    builtWith: [' Fleet_Codex ', 'fleet-cursor', 'fleet-codex', 'maya', 'autoland-verifier', '', '  ', null, 7],
  });
  assert.equal(handedIn.ready, true);
  const mark = eventsOf(d.db, id).find((event) => event.type === 'proof_ready').payload;
  assert.equal(mark.handed_in_by, 'maya');
  assert.deepEqual(mark.built_with, ['fleet-codex', 'fleet-cursor']);
  assert.deepEqual([...tasks.authorsOfTask(d.db, tasks.getTask(d.db, id))].sort(), ['fleet-codex', 'fleet-cursor', 'maya']);

  passBy(d.db, id, 'fleet-codex');
  passBy(d.db, id, 'fleet-cursor');
  assert.deepEqual(certification(d.db, id), [false, undefined], 'neither engine that built it is an independent check');
  for (const actor of ['fleet-codex', 'fleet-cursor', ' Fleet_Cursor ']) {
    const refused = tasks.reviewTask(d.db, { id, actor, reward: 1, proof: 'Looks good.' });
    assert.deepEqual([refused.reviewed, refused.reason], [false, 'judge_equals_worker'], actor);
  }
  passBy(d.db, id, 'fleet-gemini');
  assert.deepEqual(certification(d.db, id), [true, 'fleet-gemini'], 'someone who built none of it is');
});

test('only a hand-in can name builders: a review pass that names some records none, and neither does an empty or odd list', (t) => {
  const d = desk(t);
  const { id } = tasks.addTask(d.db, { title: 'Fix the feedback form', tag: 'feedback', workspaceRoot: d.dir });
  claimFor(d.db, id, 'fleet-codex');
  assert.equal(tasks.readyTask(d.db, { id, actor: 'fleet-codex', proof: 'Built and checked.', builtWith: [] }).ready, true);
  // A pass that names builders, itself among them, counts none of them.
  assert.equal(tasks.readyTask(d.db, { id, actor: 'fleet-claude', proof: 'A pass.', builtWith: ['fleet-claude', 'fleet-gemini'] }).ready, true);

  const marks = eventsOf(d.db, id).filter((event) => event.type === 'proof_ready').map((event) => event.payload);
  assert.deepEqual(marks.map((mark) => mark.built_with), [undefined, undefined], 'the hand-in named nobody and the pass is not a build');
  assert.deepEqual([...tasks.authorsOfTask(d.db, tasks.getTask(d.db, id))], ['fleet-codex']);
  assert.deepEqual(certification(d.db, id), [true, 'fleet-claude'], 'the pass is still an independent look, whoever it named');

  for (const odd of ['fleet-gemini', { 0: 'fleet-gemini' }, 7, true, null, undefined]) {
    const { id: other } = tasks.addTask(d.db, { title: `Odd list ${JSON.stringify(odd)}`, tag: 'feedback', workspaceRoot: d.dir });
    claimFor(d.db, other, 'fleet-codex');
    assert.equal(tasks.readyTask(d.db, { id: other, actor: 'fleet-codex', proof: 'Built and checked.', builtWith: odd }).ready, true);
    assert.equal(eventsOf(d.db, other).find((event) => event.type === 'proof_ready').payload.built_with, undefined, JSON.stringify(odd));
    assert.deepEqual([...tasks.authorsOfTask(d.db, tasks.getTask(d.db, other))], ['fleet-codex'], JSON.stringify(odd));
  }
});

test('a hand-in that names builders counts them in its own pass record too, so a look it names is no independent check even when the hand-in is already the second pass', (t) => {
  const d = desk(t);
  const jobWithAnEarlierLook = (title) => {
    const { id } = tasks.addTask(d.db, { title, tag: 'feedback', workspaceRoot: d.dir });
    claimFor(d.db, id, 'maya');
    // A look by fleet-gemini is already on file, as an earlier pass on this work left it.
    d.db.prepare("UPDATE tasks SET metadata = json_set(COALESCE(metadata, '{}'), '$.agent_review_pass_count', 1, '$.agent_review_actors', json(?)) WHERE id = ?")
      .run(JSON.stringify(['fleet-gemini']), id);
    return id;
  };

  const named = jobWithAnEarlierLook('Built with the engine that looked at it');
  assert.equal(tasks.readyTask(d.db, { id: named, actor: 'maya', proof: 'Built and checked.', builtWith: ['fleet-gemini'] }).ready, true);
  assert.deepEqual(certification(d.db, named), [false, undefined], 'fleet-gemini built it too');

  // The same job, with a hand-in that names nobody, is certified by that earlier look.
  const control = jobWithAnEarlierLook('Built by one builder');
  assert.equal(tasks.readyTask(d.db, { id: control, actor: 'maya', proof: 'Built and checked.' }).ready, true);
  assert.deepEqual(certification(d.db, control), [true, 'fleet-gemini']);
});

// ---------------------------------------------------------------------------
// A hand-in and the entry that names who built the work are one transaction. Before, the job was saved as handed in
// and its entry, the one that names the engines a flight built it with, followed: the engines were lost if the
// process stopped between, and a look landing in between could count one of them as independent.

test('a hand-in and the entry that names who built it are one write: nobody else can see the job handed in before its builders are on record', (t) => {
  const d = desk(t);
  const { id } = tasks.addTask(d.db, { title: 'Fix the feedback form', tag: 'feedback', workspaceRoot: d.dir });
  claimFor(d.db, id, 'maya');
  const apart = new DatabaseSync(d.dbPath);
  t.after(() => apart.close());
  const handInSeenBy = () => {
    const row = apart.prepare('SELECT status, claimed_by FROM tasks WHERE id = ?').get(id);
    const marks = apart.prepare("SELECT payload FROM task_events WHERE task_id = ? AND event_type = 'proof_ready' ORDER BY version").all(id).map((entry) => JSON.parse(entry.payload));
    return [row.status, row.claimed_by, marks.map((mark) => mark.built_with)];
  };
  const atTheEntry = [];
  const racing = justBefore(d.db, /INSERT INTO task_events/, () => atTheEntry.push(handInSeenBy()));

  assert.equal(tasks.readyTask(racing, { id, actor: 'maya', proof: 'Built and checked.', builtWith: ['fleet-codex', 'fleet-cursor'] }).ready, true);

  assert.deepEqual(atTheEntry, [['claimed', 'maya', []]], 'another connection saw the job still with its builder, not in review with the engines that built it unrecorded');
  assert.deepEqual(handInSeenBy(), ['review', 'maya', [['fleet-codex', 'fleet-cursor']]], 'and then the hand-in with its builders on record');
});

test('a hand-in whose entry cannot be saved is taken back with it: nothing is half saved, and the retry records the builders once', (t) => {
  const d = desk(t);
  const { id } = tasks.addTask(d.db, { title: 'Fix the feedback form', tag: 'feedback', workspaceRoot: d.dir });
  claimFor(d.db, id, 'maya');
  const before = rowsOf(snapshot(d.dbPath), [id]);
  const handIn = () => tasks.readyTask(d.db, { id, actor: 'maya', proof: 'Built and checked.', builtWith: ['fleet-codex'] });
  noRoomFor(d.db, 'proof_ready');
  assert.throws(handIn, /no space left on device/);

  assert.deepEqual(rowsOf(snapshot(d.dbPath), [id]), before, 'the job is exactly as it was: still being built, with no hand-in that has no entry');
  assert.notEqual(d.db.isTransaction, true, 'and no transaction is left open');
  roomAgain(d.db, 'proof_ready');

  assert.equal(handIn().ready, true);
  const marks = eventsOf(d.db, id).filter((event) => event.type === 'proof_ready');
  assert.equal(marks.length, 1, 'recorded once');
  assert.deepEqual([marks[0].payload.handed_in_by, marks[0].payload.built_with], ['maya', ['fleet-codex']]);
  assert.equal(tasks.getTask(d.db, id).status, 'review');
});

test('a review pass whose entry cannot be saved is taken back with it, so a pass count and a certification never run ahead of the history', (t) => {
  const d = desk(t);
  const id = d.heldJob('Fix the feedback form', 77);
  const before = rowsOf(snapshot(d.dbPath), [id]);
  const pass = () => tasks.readyTask(d.db, { id, actor: 'fleet-claude', proof: 'Looked at it: node --test exited 0.' });
  noRoomFor(d.db, 'proof_ready');
  assert.throws(pass, /no space left on device/);

  assert.deepEqual(rowsOf(snapshot(d.dbPath), [id]), before, 'the job is exactly as it was: no pass counted, nothing certified');
  roomAgain(d.db, 'proof_ready');

  assert.equal(pass().ready, true);
  assert.deepEqual(certification(d.db, id), [true, 'fleet-claude'], 'the retry counts the pass once');
  assert.equal(eventsOf(d.db, id).filter((event) => event.type === 'proof_ready').length, 2, 'the hand-in and the pass, once each');
});

test('a look that lands while a hand-in is being saved cannot count an engine the hand-in names as an independent check', (t) => {
  const d = desk(t);
  const other = otherProcess(t, d);
  const { id } = tasks.addTask(d.db, { title: 'Fix the feedback form', tag: 'feedback', workspaceRoot: d.dir });
  claimFor(d.db, id, 'maya');
  // fleet-codex helped build the work. It looks at it from another process while the hand-in is being saved.
  const tries = [];
  const racing = justBefore(d.db, /INSERT INTO task_events/, () => {
    tries.push(tryTo(() => tasks.readyTask(other, { id, actor: 'fleet-codex', proof: 'Looked at it: node --test exited 0.' })));
  });

  assert.equal(tasks.readyTask(racing, { id, actor: 'maya', proof: 'Built and checked.', builtWith: ['fleet-codex'] }).ready, true);

  assert.equal(tries.length, 1, 'a look was tried in the middle of the hand-in');
  assert.notEqual(tries[0].answer && tries[0].answer.ready, true, `it did not land: ${JSON.stringify(tries[0])}`);
  assert.deepEqual(certification(d.db, id), [false, undefined], 'so the job is not certified by an engine that built it');
  // A look made once the hand-in is saved knows who built the work.
  passBy(d.db, id, 'fleet-codex');
  assert.deepEqual(certification(d.db, id), [false, undefined], 'and neither is the look made after it');
  passBy(d.db, id, 'fleet-gemini');
  assert.deepEqual(certification(d.db, id), [true, 'fleet-gemini'], 'someone who built none of it is');
});

test('a hand-in and task do made inside a caller\'s own transaction join it, and are taken back with it', (t) => {
  const d = desk(t);
  const jobs = backInOpen(d);
  const { id: building } = tasks.addTask(d.db, { title: 'Fix the feedback form', tag: 'feedback', workspaceRoot: d.dir });
  claimFor(d.db, building, 'maya');
  planFor(d.db, jobs.closed, 'fleet-claude');
  const before = rowsOf(snapshot(d.dbPath), [building, jobs.closed]);

  d.db.exec('BEGIN IMMEDIATE');
  assert.equal(tasks.readyTask(d.db, { id: building, actor: 'maya', proof: 'Built and checked.', builtWith: ['fleet-codex'] }).ready, true);
  assert.equal(tasks.stageTask(d.db, { id: jobs.closed, actor: 'fleet-claude', stage: 'do', firstMove: 'start' }).staged, true);
  assert.equal(d.db.isTransaction, true, 'the caller\'s transaction is still open');
  d.db.exec('ROLLBACK');

  assert.deepEqual(rowsOf(snapshot(d.dbPath), [building, jobs.closed]), before, 'the caller\'s rollback took both back');
});

// ---------------------------------------------------------------------------
// A hand-in and a review pass are worked out from the job as it stands once the write lock is held, not as it stood
// when the caller first looked. A call that has to wait for the lock waits while the world goes on: a person sends
// the job back, its builder hands it in again, another pass lands. It used to write its own earlier look at the job
// over all of that, and to judge who was independent from the authors it had read before the wait.

const commitIn = (dir, message) => {
  gitIn(dir, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '--allow-empty', '-q', '-m', message);
  return gitIn(dir, 'rev-parse', 'HEAD').trim();
};
// maya's job is in review with pull request 77, and a reviewer looks at it. While the reviewer's pass waits for the
// lock, a person sends the job back and maya hands it in again with a new pull request and a new commit, naming
// fleet-codex among the engines that built it. Then the pass gets the lock.
const lookThatWaited = (t, reviewer) => {
  const d = desk(t);
  const firstCommit = commitIn(d.dir, 'The first build');
  const id = d.heldJob('Fix the feedback form', 77, { builder: 'maya' });
  const handedIn = tasks.getTask(d.db, id);
  assert.deepEqual([handedIn.status, handedIn.metadata.pull_request.number, handedIn.metadata.work_commit], ['review', 77, firstCommit], 'the first hand-in');
  const later = {};
  const waiting = justBeforeLock(otherProcess(t, d), () => {
    assert.equal(tasks.reviseTask(d.db, { id, actor: 'harman', note: SENT_BACK_NOTE }).revised, true);
    later.commit = commitIn(d.dir, 'The fix');
    assert.equal(tasks.readyTask(d.db, { id, actor: 'maya', proof: 'Fixed what was asked.', merge: { number: '78', url: pullAt(78) }, builtWith: ['fleet-codex'] }).ready, true);
    later.after = rowsOf(snapshot(d.dbPath), [id]);
  });
  const pass = tasks.readyTask(waiting, { id, actor: reviewer, proof: 'Looked at it: node --test exited 0.' });
  assert.ok(later.commit, 'the job was sent back and handed in again while the pass waited');
  return { d, id, pass, ...later };
};
const proofEntries = (db, id) => eventsOf(db, id).filter((event) => event.type === 'proof_ready').map((event) => [event.actor, event.payload.review_pass_count, event.payload.agent_certified]);

test('a review pass that waited for the lock while the job was sent back and handed in again naming its reviewer as a builder is turned away, and the reviewer\'s next pass is no independent check', (t) => {
  const { d, id, pass, after } = lookThatWaited(t, 'fleet-codex');

  assert.deepEqual([pass.ready, pass.reason], [false, 'claim changed hands'], 'it looked at work that has since been replaced');
  assert.deepEqual(rowsOf(snapshot(d.dbPath), [id]), after, 'and wrote nothing');
  assert.deepEqual(certification(d.db, id), [false, undefined]);
  const row = tasks.getTask(d.db, id);
  assert.equal(row.metadata.agent_review_pass_count, 1, 'only the new hand-in is counted');
  assert.deepEqual(row.metadata.agent_review_actors, ['maya']);
  assert.deepEqual(proofEntries(d.db, id), [['maya', 1, false], ['maya', 1, false]], 'the history has the two hand-ins and no pass');
  // A pass made now knows who built the work: fleet-codex is one of them, so its look certifies nothing. Someone who
  // built none of it does.
  passBy(d.db, id, 'fleet-codex');
  assert.deepEqual(certification(d.db, id), [false, undefined], 'fleet-codex built the new hand-in with maya');
  passBy(d.db, id, 'fleet-gemini');
  assert.deepEqual(certification(d.db, id), [true, 'fleet-gemini']);
});

test('a review pass that waited for the lock while the job was sent back and handed in again is turned away even when its reviewer built none of it: it certifies nothing it did not look at', (t) => {
  const { d, id, pass, after } = lookThatWaited(t, 'fleet-gemini');

  assert.deepEqual([pass.ready, pass.reason], [false, 'claim changed hands']);
  assert.deepEqual(rowsOf(snapshot(d.dbPath), [id]), after, 'and wrote nothing');
  assert.deepEqual(certification(d.db, id), [false, undefined], 'the new hand-in is not certified by a look at the old one');
  assert.equal(tasks.getTask(d.db, id).metadata.agent_review_pass_count, 1);
  // The same reviewer, looking at the job as it stands, can certify it.
  passBy(d.db, id, 'fleet-gemini');
  assert.deepEqual(certification(d.db, id), [true, 'fleet-gemini']);
});

test('a review pass that waited for the lock while the job was sent back and handed in again leaves the new hand-in\'s pull request, commit and send-back note on the job', (t) => {
  const { d, id, commit } = lookThatWaited(t, 'fleet-codex');

  const row = tasks.getTask(d.db, id);
  assert.deepEqual(row.metadata.pull_request, { state: 'open', number: 78, url: pullAt(78) }, 'the job keeps the pull request of the last hand-in, so the sweep still finds it');
  assert.equal(row.metadata.work_commit, commit, 'and its commit');
  assert.equal(row.metadata.human_revision_note, SENT_BACK_NOTE, 'and the note the person sent it back with');
  assert.equal(row.status, 'review');
  assert.equal(row.claimed_by, 'maya');
  assert.equal(row.metadata.latest_agent_proof, 'Fixed what was asked.', 'and what the hand-in said, not what the pass would have');
  assert.deepEqual(tasks.heldPullRequestOf(row), { number: 78, url: pullAt(78) }, 'still a held job, on the new pull request');
});

test('a review pass that waited for the lock is judged on who built the job as the history stands then: an engine named on it meanwhile is no independent check', (t) => {
  const d = desk(t);
  const id = d.heldJob('Fix the feedback form', 77, { builder: 'maya' });
  // fleet-codex's pass waits for the lock. A hand-in entry naming fleet-codex as a builder is written on the job's
  // history while it waits, by a writer that left the row alone.
  const waiting = justBeforeLock(otherProcess(t, d), () => {
    tasks.appendTaskEvent(d.db, {
      taskId: id,
      workspaceRoot: tasks.getTask(d.db, id).workspace_root,
      actor: 'maya',
      eventType: 'proof_ready',
      payload: { proof: 'Built with fleet-codex.', handed_in_by: 'maya', built_with: ['fleet-codex'] },
    });
  });

  const pass = tasks.readyTask(waiting, { id, actor: 'fleet-codex', proof: 'Looked at it: node --test exited 0.' });

  assert.equal(pass.ready, true, JSON.stringify(pass));
  assert.deepEqual(certification(d.db, id), [false, undefined], 'fleet-codex is on the job\'s history as a builder by the time its pass is counted');
  const row = tasks.getTask(d.db, id);
  assert.equal(row.metadata.agent_review_pass_count, 2);
  assert.deepEqual(row.metadata.agent_review_actors, ['maya', 'fleet-codex']);
  passBy(d.db, id, 'fleet-gemini');
  assert.deepEqual(certification(d.db, id), [true, 'fleet-gemini']);
});

test('two review passes that meet at the lock each add to the other\'s record: the second counts on the first, and neither is lost', (t) => {
  const d = desk(t);
  const id = d.heldJob('Fix the feedback form', 77, { builder: 'maya' });
  // fleet-gemini looked first and its pass waits for the lock. fleet-claude's pass goes in while it waits.
  const waiting = justBeforeLock(otherProcess(t, d), () => passBy(d.db, id, 'fleet-claude'));

  const second = tasks.readyTask(waiting, { id, actor: 'fleet-gemini', proof: 'Looked at it too: node --test exited 0.' });

  assert.equal(second.ready, true, JSON.stringify(second));
  const row = tasks.getTask(d.db, id);
  assert.equal(row.metadata.agent_review_pass_count, 3, 'the hand-in and two passes');
  assert.deepEqual(row.metadata.agent_review_actors, ['maya', 'fleet-claude', 'fleet-gemini'], 'both passes are on the record, in the order they landed');
  assert.deepEqual(certification(d.db, id), [true, 'fleet-claude'], 'certified by the first independent look, which the second did not take away');
  const entries = eventsOf(d.db, id).filter((event) => event.type === 'proof_ready').map((event) => [event.actor, event.payload.review_pass_count, event.payload.agent_certified]);
  assert.deepEqual(entries, [['maya', 1, false], ['fleet-claude', 2, true], ['fleet-gemini', 3, true]], 'each entry counts the passes before it');
});

test('a hand-in that waited for the lock keeps what another writer put on the job meanwhile', (t) => {
  const d = desk(t);
  const { id } = tasks.addTask(d.db, { title: 'Fix the feedback form', tag: 'feedback', workspaceRoot: d.dir });
  claimFor(d.db, id, 'maya');
  // The hand-in looked at the job, and then a result was written on it while the hand-in waited.
  const waiting = justBeforeLock(otherProcess(t, d), () => {
    assert.equal(tasks.setTaskResult(d.db, { id, actor: 'harman', result: 'The form saves again.' }).saved, true);
  });

  const handIn = tasks.readyTask(waiting, { id, actor: 'maya', proof: 'Built and checked.' });

  assert.equal(handIn.ready, true, JSON.stringify(handIn));
  const row = tasks.getTask(d.db, id);
  assert.equal(row.status, 'review');
  assert.equal(row.metadata.result, 'The form saves again.', 'the result written while the hand-in waited is still on the job');
  assert.equal(row.metadata.result_by, 'harman');
  assert.equal(row.metadata.agent_review_pass_count, 1);
});

test('a review pass that waited for the lock while a person sent the job back is turned away: it does not hand the job in again, and the job stays sent back', (t) => {
  const d = desk(t);
  const id = d.heldJob('Fix the feedback form', 77);
  let sentBack = null;
  const waiting = justBeforeLock(otherProcess(t, d), () => {
    assert.equal(tasks.reviseTask(d.db, { id, actor: 'harman', note: SENT_BACK_NOTE }).revised, true);
    sentBack = rowsOf(snapshot(d.dbPath), [id]);
  });

  const pass = tasks.readyTask(waiting, { id, actor: 'fleet-claude', proof: 'Looked at it: node --test exited 0.' });

  assert.ok(sentBack, 'the job was sent back while the pass waited');
  assert.deepEqual([pass.ready, pass.reason], [false, 'claim changed hands']);
  assert.deepEqual(rowsOf(snapshot(d.dbPath), [id]), sentBack, 'the pass wrote nothing');
  const row = tasks.getTask(d.db, id);
  assert.deepEqual([row.status, row.claimed_by, row.metadata.approval_status], ['claimed', 'fleet-codex', 'revise']);
});

test('a hand-in that waited for the lock while the same job was handed in by another process is turned away, and is not counted as a pass on it', (t) => {
  const d = desk(t);
  const { id } = tasks.addTask(d.db, { title: 'Fix the feedback form', tag: 'feedback', workspaceRoot: d.dir });
  claimFor(d.db, id, 'maya');
  let first = null;
  const waiting = justBeforeLock(otherProcess(t, d), () => {
    assert.equal(tasks.readyTask(d.db, { id, actor: 'maya', proof: 'Built and checked.' }).ready, true);
    first = rowsOf(snapshot(d.dbPath), [id]);
  });

  const again = tasks.readyTask(waiting, { id, actor: 'maya', proof: 'Built and checked, sent twice.' });

  assert.ok(first, 'the job was handed in while the second hand-in waited');
  assert.deepEqual([again.ready, again.reason], [false, 'claim changed hands']);
  assert.deepEqual(rowsOf(snapshot(d.dbPath), [id]), first, 'the second hand-in wrote nothing');
  assert.equal(tasks.getTask(d.db, id).metadata.agent_review_pass_count, 1, 'one hand-in, no pass');
});

test('a hand-in that waited for the lock while the claim it was made on moved is turned away, whether the claim went to someone else or the same builder took the job again', (t) => {
  const d = desk(t);
  for (const [label, next] of [['to someone else', 'bob'], ['to the same builder, again', 'maya']]) {
    const { id } = tasks.addTask(d.db, { title: `Fix the feedback form, claim moved ${label}`, tag: 'feedback', workspaceRoot: d.dir });
    claimFor(d.db, id, 'maya');
    // The claim is a minute old. A new claim by the same builder is told apart by its time alone, and one by someone
    // else is made to carry the old time, so that only the name tells it apart.
    const claimedAt = tasks.getTask(d.db, id).claimed_at - 60 * 1000;
    d.db.prepare('UPDATE tasks SET claimed_at = ? WHERE id = ?').run(claimedAt, id);
    let moved = null;
    const waiting = justBeforeLock(otherProcess(t, d), () => {
      assert.equal(tasks.releaseTask(d.db, { id, actor: 'maya', reason: 'paused' }).released, true, label);
      claimFor(d.db, id, next);
      if (next !== 'maya') d.db.prepare('UPDATE tasks SET claimed_at = ? WHERE id = ?').run(claimedAt, id);
      moved = rowsOf(snapshot(d.dbPath), [id]);
    });

    const handIn = tasks.readyTask(waiting, { id, actor: 'maya', proof: 'Built and checked.' });

    assert.ok(moved, `${label}: the claim moved while the hand-in waited`);
    assert.deepEqual([handIn.ready, handIn.reason], [false, 'claim changed hands'], label);
    assert.deepEqual(rowsOf(snapshot(d.dbPath), [id]), moved, `${label}: the hand-in wrote nothing`);
    const row = tasks.getTask(d.db, id);
    assert.deepEqual([row.status, row.claimed_by], ['claimed', next], label);
  }
});

test('a job whose send-back count is not a number can still be handed in', (t) => {
  const d = desk(t);
  const { id } = tasks.addTask(d.db, { title: 'Fix the feedback form', tag: 'feedback', workspaceRoot: d.dir });
  claimFor(d.db, id, 'maya');
  d.db.prepare("UPDATE tasks SET metadata = json_set(COALESCE(metadata, '{}'), '$.human_revision_count', 'many') WHERE id = ?").run(id);

  const handIn = tasks.readyTask(d.db, { id, actor: 'maya', proof: 'Built and checked.' });

  assert.equal(handIn.ready, true, JSON.stringify(handIn));
  assert.equal(tasks.getTask(d.db, id).status, 'review');
});

test('a call that waited for the lock while the job was closed finds it closed and says so', (t) => {
  const d = desk(t);
  const id = d.heldJob('Fix the feedback form', 77);
  let closed = null;
  const waiting = justBeforeLock(otherProcess(t, d), () => {
    assert.equal(tasks.doneTask(d.db, { id, status: 'done', actor: 'harman', allowReview: true, action: 'accepted' }).updated, true);
    closed = rowsOf(snapshot(d.dbPath), [id]);
  });

  const pass = tasks.readyTask(waiting, { id, actor: 'fleet-claude', proof: 'Looked at it: node --test exited 0.' });

  assert.ok(closed, 'the job was accepted while the pass waited');
  assert.deepEqual([pass.ready, pass.reason], [false, 'already_done']);
  assert.deepEqual(rowsOf(snapshot(d.dbPath), [id]), closed, 'the pass wrote nothing');
});

test('the authors of a row from before hand-ins were marked are its builder and its claimant, and a row the store does not know has none', (t) => {
  const d = desk(t);
  const id = d.heldJob('Fix the feedback form', 77);
  // Older rows have no marks: only the stamp and the claimant say who built them.
  d.db.prepare("DELETE FROM task_events WHERE task_id = ? AND event_type = 'claimed'").run(id);
  d.db.prepare("UPDATE task_events SET payload = json_remove(payload, '$.handed_in_by') WHERE task_id = ? AND event_type = 'proof_ready'").run(id);
  d.db.prepare("UPDATE tasks SET metadata = json_set(metadata, '$.built_by', 'Fleet_Gemini') WHERE id = ?").run(id);

  assert.deepEqual([...tasks.authorsOfTask(d.db, tasks.getTask(d.db, id))].sort(), ['fleet-codex', 'fleet-gemini']);
  assert.deepEqual([...tasks.authorsOfTask(d.db, null)], []);
  assert.deepEqual([...tasks.authorsOfTask(d.db, { id: 'no-such-row', metadata: null, claimed_by: null })], []);
});

// ---------------------------------------------------------------------------
// Who may run it.

test('anyone may run it, agents included: GitHub is the only source and nothing is granted by the caller', (t) => {
  const d = desk(t);
  const merged = d.heldJob('Fix the feedback form', 77);
  const closed = d.heldJob('Fix the billing page', 78);
  d.setGh({ prs: { [pullAt(77)]: mergedPr(77), [pullAt(78)]: closedPr(78) } });

  const result = d.attempt(['task', 'sweep', '--held', '--as', 'fleet-codex', '--json'], { env: AGENT_SESSION });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(JSON.parse(result.stdout).summary.landed, 1);
  assert.equal(tasks.getTask(d.db, merged).status, 'done');
  assert.equal(tasks.getTask(d.db, closed).status, 'open');
  // The agent got no more than GitHub said: no reward, no certification, no accepted mark.
  const row = tasks.getTask(d.db, merged);
  assert.equal(row.metadata.accepted_at, undefined);
  assert.equal(row.metadata.agent_certified, undefined);
  assert.equal(row.metadata.approval_status, 'pending');
  assert.equal(eventsOf(d.db, merged).pop().actor, 'fleet-codex');

  // The auto-accept lane is still closed to an agent session.
  const blocked = d.attempt(['task', 'sweep', '--auto-accept', '--json'], { env: AGENT_SESSION });
  assert.notEqual(blocked.status, 0);
  assert.equal(JSON.parse(blocked.stdout).reason, 'agent_proof_only_human_accept_blocked');
});

test('the held lane does not take the expired-claims flags, and the plain sweep is unchanged', (t) => {
  const d = desk(t);
  d.heldJob('Fix the feedback form', 77);
  d.setGh({ prs: { [pullAt(77)]: mergedPr(77) } });
  const before = snapshot(d.dbPath);
  for (const flag of [['--auto-accept'], ['--stale-days', '1'], ['--claimer', 'fleet-codex']]) {
    const result = d.attempt(['task', 'sweep', '--held', ...flag, '--as', 'keshav']);
    assert.notEqual(result.status, 0, flag.join(' '));
    assert.match(result.stderr, /cannot be combined/, flag.join(' '));
  }
  const unnamed = d.attempt(['task', 'sweep', '--held', '--as']);
  assert.notEqual(unnamed.status, 0);
  assert.match(unnamed.stderr, /--as needs a name/);
  assert.deepEqual(d.ghCalls(), []);
  assert.deepEqual(snapshot(d.dbPath), before);
  // Without --held the sweep still only lets go of expired claims, and a held job is not one.
  assert.deepEqual(JSON.parse(d.run(['task', 'sweep', '--stale-days', '0', '--json']).stdout).tasks, []);
  assert.deepEqual(snapshot(d.dbPath), before);
});

test('the sweep cannot run under a name the system keeps for its own machines', (t) => {
  const d = desk(t);
  d.heldJob('Fix the feedback form', 77);
  d.setGh({ prs: { [pullAt(77)]: mergedPr(77) } });
  const before = snapshot(d.dbPath);
  for (const machine of ['auto-accept-certified', 'autoland-verifier']) {
    const result = d.attempt(['task', 'sweep', '--held', '--as', machine]);
    assert.notEqual(result.status, 0, machine);
    assert.match(result.stderr, /reserved_actor/, machine);
  }
  assert.deepEqual(d.ghCalls(), []);
  assert.deepEqual(snapshot(d.dbPath), before);
});

test('the task help lists the held lane', (t) => {
  const d = desk(t);
  const help = d.run(['task', '--help']).stdout;
  assert.match(help, /atris task sweep --held \[--everywhere\] \[--dry-run\] \[--json\]/);
});

// ---------------------------------------------------------------------------
// The rating names the check. It never asks GitHub itself.

test('atris rating names the check when a member has jobs waiting on a pull request, and asks GitHub nothing', (t) => {
  const d = desk(t);
  d.heldJob('First waiting job', 77);
  d.heldJob('Second waiting job', 78);
  d.heldJob('Only waiting job', 79, { builder: 'fleet-claude' });
  const done = d.heldJob('Landed long ago', 80, { builder: 'fleet-gemini' });
  tasks.doneTask(d.db, { id: done, status: 'done', actor: 'keshav', allowReview: true, action: 'accepted' });
  d.setGh({ prs: { [pullAt(77)]: mergedPr(77) } });
  const season = seasonOf(d.dir, d.dbPath);

  const two = ratingOf(d.dir, season, 'fleet-codex');
  assert.deepEqual(two.split('\n').filter((line) => /atris task sweep --held/.test(line)),
    ['  2 jobs wait on an open pull request. Check GitHub and credit them: atris task sweep --held']);
  const one = ratingOf(d.dir, season, 'fleet-claude');
  assert.deepEqual(one.split('\n').filter((line) => /atris task sweep --held/.test(line)),
    ['  1 job waits on an open pull request. Check GitHub and credit it: atris task sweep --held']);
  assert.match(one, /landed 0 of 0 finished jobs/, 'a member whose only job is waiting still has a card');
  assert.equal(JSON.parse(ratingOf(d.dir, season, 'fleet-codex', '--json')).member.waiting_on_pull_request, 2);
  assert.equal(JSON.parse(ratingOf(d.dir, season, 'fleet-claude', '--json')).member.waiting_on_pull_request, 1);
  // A job a person already landed is not waiting.
  const landed = ratingOf(d.dir, season, 'fleet-gemini');
  assert.doesNotMatch(landed, /atris task sweep --held/);
  assert.equal('waiting_on_pull_request' in JSON.parse(ratingOf(d.dir, season, 'fleet-gemini', '--json')).member, false);

  // The real command does the same and never calls gh, even with one on the PATH.
  const card = d.run(['rating', 'fleet-codex']).stdout;
  assert.match(card, /^ {2}2 jobs wait on an open pull request\. Check GitHub and credit them: atris task sweep --held$/m);
  assert.deepEqual(d.ghCalls(), [], 'the rating asked GitHub nothing');
  const bare = d.run(['rating', 'fleet-codex', '--json'], { withoutGh: true });
  assert.equal(JSON.parse(bare.stdout).member.waiting_on_pull_request, 2);
});

test('a job that has waited longer than the rating window still shows on its builder\'s card', (t) => {
  const d = desk(t);
  const id = d.heldJob('Waiting a long time', 77);
  const longAgo = Date.now() - 45 * 86400000;
  d.db.prepare('UPDATE task_events SET created_at = ? WHERE task_id = ?').run(longAgo, id);
  d.db.prepare('UPDATE tasks SET created_at = ?, updated_at = ? WHERE id = ?').run(longAgo, longAgo, id);
  const season = seasonOf(d.dir, d.dbPath);
  assert.deepEqual(playsOf(season, id), [], 'the rating has no play for it in its 30 days');

  const text = ratingOf(d.dir, season, 'fleet-codex');

  assert.match(text, /^ {2}1 job waits on an open pull request\. Check GitHub and credit it: atris task sweep --held$/m);
  assert.equal(JSON.parse(ratingOf(d.dir, season, 'fleet-codex', '--json')).member.waiting_on_pull_request, 1);
});
