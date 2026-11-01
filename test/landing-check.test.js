'use strict';

// Whether a landing really landed. The rating counts a job as landed when its record says it merged; the builder
// picker asks more of each landing, and lib/landing-check.js asks git, on this computer:
//
//   - the commit is on origin's default branch (the branch is listed once, back to a day before the earliest claim
//     the caller will ask about, and every commit is looked up in that list: no process per landing)
//   - the commit is no older than the claim it lands, allowing five minutes of clock skew
//   - the caller can say no job recorded the same commit first (the first job to record keeps it)
//
// The default branch is the one origin/HEAD names, and nothing else: origin/main and origin/master are never
// guessed. When origin/HEAD is missing or points at a branch that is not here, no landing can be checked, and the
// check says so with the fix (git remote set-head origin --auto). It fetches origin's default branch once, when
// asked, with an explicit refspec so the ref that is checked is the ref that was fetched, so a merge that happened
// a minute ago is known. Everything git does before a pick shares one five-second budget, and git never prompts:
// stdin is closed, GIT_TERMINAL_PROMPT is 0, and ssh runs in batch mode unless the person set an ssh command of
// their own (then it is left alone, and the check says so). These tests build small real repositories with a real
// remote and ask the real git, and use stand-ins for git and for the operating system to count and time what is asked.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { commitsOf, createLandingCheck } = require('../lib/landing-check');
const { repoIn, watchGit } = require('./helpers/pick-history');

const MADE_UP = 'deadbeef'.repeat(5); // forty hex digits that name no commit
const T = Date.parse('2026-11-01T00:00:00Z');
const MINUTE = 60000;
const DAY = 24 * 60 * MINUTE;
const FIX = 'git remote set-head origin --auto';
const FETCH_TRUNK = 'fetch origin +refs/heads/trunk:refs/remotes/origin/trunk';

function folder(t, prefix = 'landing-check-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A repository with one old commit on its default branch, and a real origin that has it.
function repoFor(t, options) {
  const root = folder(t);
  return repoIn(root, options);
}

// ---------------------------------------------------------------------------
// The commits a landing record names.

test('commitsOf reads the places the rating looks for a merge, and nothing that is not a commit id', () => {
  const a = 'a'.repeat(40);
  const b = 'b'.repeat(40);
  const c = 'c'.repeat(7);
  assert.deepEqual(commitsOf({ merge_commit: a }), [a]);
  assert.deepEqual(commitsOf({ merge_commit_sha: a }), [a]);
  assert.deepEqual(commitsOf({ merge_sha: a }), [a]);
  assert.deepEqual(commitsOf({ landing: { merge_commit: a } }), [a]);
  assert.deepEqual(commitsOf({ pull_request: { state: 'merged', merge_commit: a, number: 7 } }), [a]);
  assert.deepEqual(commitsOf({ pr: { merge_sha: a } }), [a]);
  assert.deepEqual(commitsOf({ landing: { merge_commit: a }, pull_request: { merge_commit: b } }), [a, b], 'every place is read');
  assert.deepEqual(commitsOf({ merge_commit: a, landing: { merge_commit: a }, pull_request: { merge_commit: a } }), [a], 'one commit named three times is one commit');
  assert.deepEqual(commitsOf({ merge_commit: 'A'.repeat(40) }), [a], 'ids are lower case');
  assert.deepEqual(commitsOf({ merge_commit: c }), [c], 'a short id of seven digits is an id');
  assert.deepEqual(commitsOf({ proof: 'built it', self_landed: true, number: 7 }), []);
  assert.deepEqual(commitsOf({ start_commit: a, work_commit: b }), [], 'the commit a job started from is not a landing');
});

test('commitsOf ignores what is not a commit id, and records that are not records', () => {
  for (const merge_commit of ['', 'main', 'abc123', 'g'.repeat(40), 'a'.repeat(65), ' ', 12345678, null, undefined, true, ['a'.repeat(40)], { sha: 'a'.repeat(40) }]) {
    assert.deepEqual(commitsOf({ merge_commit }), [], `${JSON.stringify(merge_commit)} is not a commit`);
  }
  assert.deepEqual(commitsOf({ landing: ['a'.repeat(40)] }), [], 'a list in place of a landing is not a landing');
  assert.deepEqual(commitsOf({ landing: 'merged' }), []);
  for (const payload of [null, undefined, 'a'.repeat(40), 42, [], [{ merge_commit: 'a'.repeat(40) }], true]) {
    assert.deepEqual(commitsOf(payload), [], `${JSON.stringify(payload)}`);
  }
});

// ---------------------------------------------------------------------------
// A real repository with a real origin.

test('a made-up commit id is not landed, and a real commit on the default branch is', (t) => {
  const repo = repoFor(t);
  const check = createLandingCheck(repo.root);
  assert.equal(check.landed([MADE_UP]), false);
  assert.equal(check.landed([repo.main]), true);
  assert.equal(check.landed([repo.main.slice(0, 12)]), true, 'a short id that git can resolve is the same commit');
  assert.equal(check.cannotCheck(), '', 'the check could run');
});

test('a commit that sits on a side branch only is not landed', (t) => {
  const repo = repoFor(t);
  const side = repo.side(T);
  const check = createLandingCheck(repo.root);
  assert.equal(check.landed([side]), false);
  assert.equal(check.landed([MADE_UP, side]), false, 'neither commit is on the default branch');
  assert.equal(check.landed([side, repo.main]), true, 'one commit of a landing being on the branch is enough');
});

test('a merged pull request passes through its merge commit, and so does the branch\'s own commit behind it', (t) => {
  const repo = repoFor(t);
  const unmerged = repo.side(T + MINUTE, 'abandoned work');
  const { merge, branchCommit } = repo.merged(T + 5 * MINUTE);
  repo.sync();
  const check = createLandingCheck(repo.root);
  assert.equal(check.landed([merge]), true);
  assert.equal(check.landed([branchCommit]), true);
  assert.equal(check.landed([unmerged]), false);
});

test('the default branch moving on does not unland older work, and work not yet pushed to origin is not landed', (t) => {
  const repo = repoFor(t);
  const first = repo.main;
  const second = repo.land(T);
  repo.sync();
  const unpushed = repo.unpushed(T + MINUTE);
  const check = createLandingCheck(repo.root);
  assert.equal(check.landed([first]), true);
  assert.equal(check.landed([second]), true);
  assert.equal(check.landed([unpushed]), false, 'the local branch is not what counts; origin\'s copy of it is');
});

test('no commit at all is not landed', (t) => {
  const repo = repoFor(t);
  const check = createLandingCheck(repo.root);
  for (const commits of [[], undefined, null, 'not a list', ['not a commit'], [''], [12345678]]) {
    assert.equal(check.landed(commits), false, JSON.stringify(commits));
  }
});

// ---------------------------------------------------------------------------
// Which branch is the default one: origin/HEAD, and nothing else.

test('the default branch is whatever origin\'s HEAD names', (t) => {
  const trunk = repoFor(t, { branch: 'trunk' });
  assert.equal(createLandingCheck(trunk.root).landed([trunk.main]), true, 'origin/HEAD names trunk');
  const slashed = repoFor(t, { branch: 'release/4' });
  assert.equal(createLandingCheck(slashed.root).landed([slashed.main]), true, 'a branch name with a slash is a branch name');
});

test('origin/main and origin/master are never guessed: with no origin/HEAD nothing can be checked, and the check names the fix', (t) => {
  for (const branch of ['main', 'master']) {
    const repo = repoFor(t, { branch });
    repo.git('symbolic-ref', '--delete', 'refs/remotes/origin/HEAD');
    // origin/<branch> is right there, and still not used.
    assert.equal(repo.git('rev-parse', '--verify', `refs/remotes/origin/${branch}`), repo.main);
    const check = createLandingCheck(repo.root);
    assert.equal(check.landed([repo.main]), false, `origin/${branch} exists and is not guessed`);
    const why = check.cannotCheck();
    assert.match(why, /default branch/);
    assert.ok(why.includes(FIX), `the fix is named: ${why}`);
  }
});

test('an origin/HEAD that points at a branch that is not here cannot be used either, and the check names the fix', (t) => {
  const repo = repoFor(t);
  repo.git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/gone');
  const check = createLandingCheck(repo.root);
  assert.equal(check.landed([repo.main]), false, 'origin/main is there, but origin/HEAD does not name it');
  const why = check.cannotCheck();
  assert.match(why, /origin\/gone/);
  assert.ok(why.includes(FIX), why);
});

test('a folder with no origin at all cannot be checked, and says so without a fix that could not work', (t) => {
  const repo = repoFor(t, { origin: false });
  const check = createLandingCheck(repo.root);
  assert.equal(check.landed([repo.main]), false, 'the commit is real, but there is no origin to hold it against');
  assert.equal(check.cannotCheck(), 'no origin branch');
});

test('with no git repository in the folder, nothing is landed and the check says why', (t) => {
  const check = createLandingCheck(folder(t));
  assert.equal(check.landed([MADE_UP]), false);
  assert.equal(check.cannotCheck(), 'this folder is not a git repository');
});

test('with git missing from this computer, nothing is landed and the check says why', (t) => {
  const repo = repoFor(t);
  const nothingHere = folder(t, 'landing-check-nopath-');
  const saved = process.env.PATH;
  t.after(() => { process.env.PATH = saved; });
  process.env.PATH = nothingHere;
  const check = createLandingCheck(repo.root);
  assert.equal(check.landed([repo.main]), false);
  assert.equal(check.cannotCheck(), 'git is not installed here');
});

test('a git of someone else\'s repository in the environment does not redirect the check', (t) => {
  const mine = repoFor(t);
  const other = repoFor(t);
  const saved = { GIT_DIR: process.env.GIT_DIR, GIT_WORK_TREE: process.env.GIT_WORK_TREE };
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  process.env.GIT_DIR = path.join(other.root, '.git');
  process.env.GIT_WORK_TREE = other.root;
  const check = createLandingCheck(mine.root);
  assert.equal(check.landed([mine.main]), true, 'the folder\'s own repository answers');
  assert.equal(check.landed([MADE_UP]), false);
});

// ---------------------------------------------------------------------------
// A landing belongs to its job: it is no older than its claim, and one job keeps a commit.

test('a commit older than the claim it lands is not landed, with five minutes allowed for clocks that disagree', (t) => {
  const repo = repoFor(t);
  const made = repo.land(T);
  repo.sync();
  const check = createLandingCheck(repo.root);
  assert.equal(check.landed([made], { claimedAt: T }), true, 'made at the claim');
  assert.equal(check.landed([made], { claimedAt: T - 10 * MINUTE }), true, 'made after the claim');
  assert.equal(check.landed([made], { claimedAt: T + 5 * MINUTE }), true, 'five minutes before the claim is within the skew');
  assert.equal(check.landed([made], { claimedAt: T + 5 * MINUTE + 1000 }), false, 'a second past the skew is too old');
  assert.equal(check.landed([made], { claimedAt: T + 3 * 3600000 }), false, 'old work that was already on the branch is not what the claim landed');
  assert.equal(check.landed([made]), true, 'asked with no claim time, only the branch is asked');
  assert.equal(check.landed([repo.main], { claimedAt: T }), false, 'the commit every repository starts with is older than any claim here');
});

test('the commit time is the time of the commit itself, and a landing counts when any commit it names is fresh enough', (t) => {
  const repo = repoFor(t);
  const stale = repo.land(T - 2 * 3600000);
  const fresh = repo.land(T + MINUTE);
  repo.sync();
  const check = createLandingCheck(repo.root);
  assert.equal(check.landed([stale], { claimedAt: T }), false);
  assert.equal(check.landed([stale, fresh], { claimedAt: T }), true);
  assert.equal(check.landed([fresh.slice(0, 10), stale.slice(0, 10)], { claimedAt: T }), true, 'short ids are read the same way');
});

test('the caller says whether the job owns a commit, and is given the full id however the record spelled it', (t) => {
  const repo = repoFor(t);
  const made = repo.land(T);
  repo.sync();
  const check = createLandingCheck(repo.root);
  const given = [];
  assert.equal(check.landed([made.slice(0, 9)], { claimedAt: T, owns: (id) => { given.push(id); return true; } }), true);
  assert.deepEqual(given, [made], 'the full id, lower case');
  assert.equal(check.landed([made], { claimedAt: T, owns: () => false }), false, 'a commit another job recorded first is not this job\'s');
  assert.equal(check.landed([made, repo.main], { owns: (id) => id === repo.main }), true, 'one commit that is this job\'s is enough');
  // A commit that is not landed is never offered to the caller to own.
  const asked = [];
  check.landed([MADE_UP, repo.side(T)], { owns: (id) => { asked.push(id); return true; } });
  assert.deepEqual(asked, []);
});

// ---------------------------------------------------------------------------
// The times are read in one batch.

test('every commit asked about is read in one batched call, however it is spelled, and what git does not know is dropped', (t) => {
  const repo = repoFor(t);
  const made = [1, 2, 3, 4].map((n) => repo.land(T + n * MINUTE));
  repo.sync();
  const watch = watchGit(t);
  const check = createLandingCheck(repo.root);
  const seen = check.read([made[0], made[1].slice(0, 12), made[2].toUpperCase(), MADE_UP, 'abc1234', made[0]]);
  assert.equal(watch.startingWith('rev-list').length, 1, `one call: ${watch.calls().join(' | ')}`);
  assert.equal(seen.get(made[0]).oid, made[0]);
  assert.equal(seen.get(made[1].slice(0, 12)).oid, made[1]);
  assert.equal(seen.get(made[2].toUpperCase().toLowerCase()).oid, made[2]);
  assert.equal(seen.get(made[0]).time, Math.floor((T + MINUTE) / 1000) * 1000, 'the commit time, in milliseconds');
  assert.equal(seen.get(MADE_UP), null, 'a commit git does not have');
  assert.equal(seen.get('abc1234'), null);
  // Everything asked above is known, so landed() asks nothing more of the batch. The default branch is listed once,
  // for all of them, and no process is started for any one commit.
  for (const id of made.slice(0, 3)) assert.equal(check.landed([id], { claimedAt: T }), true);
  assert.equal(watch.startingWith('rev-list').length, 2, 'the batch, and the one listing of the default branch');
  assert.equal(check.landed([made[3]], { claimedAt: T }), true, 'a commit not in the first batch is read when it is first asked');
  assert.equal(watch.startingWith('rev-list').length, 3, 'one more batch for the one more commit; the listing is not made again');
  assert.deepEqual(watch.startingWith('merge-base'), [], 'no process per landing');
});

// ---------------------------------------------------------------------------
// A merge that happened a minute ago, and the one fetch that finds it.

test('before the fetch a fresh merge on origin is unknown; after it, it counts', (t) => {
  const repo = repoFor(t);
  const fresh = repo.land(T);
  const check = createLandingCheck(repo.root);
  assert.equal(check.landed([fresh]), false, 'this folder has not fetched it yet');
  assert.equal(check.refresh(), '', 'the fetch worked');
  assert.equal(check.landed([fresh], { claimedAt: T }), true, 'what was unknown a moment ago is looked at again after the fetch');
  assert.equal(check.cannotCheck(), '');
});

test('the fetch is origin\'s default branch only, named in full, and happens once however often it is asked for', (t) => {
  const repo = repoFor(t, { branch: 'trunk' });
  repo.land(T);
  const watch = watchGit(t);
  watch.clear();
  const check = createLandingCheck(repo.root);
  assert.equal(check.refresh(), '');
  assert.equal(check.refresh(), '');
  assert.equal(check.refresh(), '');
  assert.deepEqual(watch.startingWith('fetch'), [FETCH_TRUNK]);
});

test('the fetch names where it puts the branch, so the ref that is checked is the ref that was fetched, whatever the repository\'s own fetch settings say', (t) => {
  const repo = repoFor(t);
  // Fetch settings that cover some other branch: a plain `git fetch origin main` would fill FETCH_HEAD and leave
  // origin/main where it was, and the check would look at a branch that never moved.
  repo.git('config', '--replace-all', 'remote.origin.fetch', '+refs/heads/elsewhere:refs/remotes/origin/elsewhere');
  const fresh = repo.land(T);
  const check = createLandingCheck(repo.root);
  assert.equal(check.landed([fresh]), false, 'not fetched yet');
  assert.equal(check.refresh(), '');
  assert.equal(repo.git('rev-parse', '--verify', 'refs/remotes/origin/main'), fresh, 'origin/main is where the fetch put it');
  assert.equal(check.landed([fresh], { claimedAt: T }), true);
});

test('nothing is fetched when the folder cannot be checked in the first place', (t) => {
  const noHead = repoFor(t);
  noHead.git('symbolic-ref', '--delete', 'refs/remotes/origin/HEAD');
  const watch = watchGit(t);
  watch.clear();
  const check = createLandingCheck(noHead.root);
  const why = check.refresh();
  assert.ok(why.includes(FIX), why);
  assert.deepEqual(watch.startingWith('fetch'), []);
  assert.equal(check.cannotCheck(), why);
});

test('when origin cannot be reached the fetch says why, nothing is landed, and the folder cannot be checked', (t) => {
  const repo = repoFor(t);
  const old = repo.main;
  const check = createLandingCheck(repo.root);
  fs.renameSync(repo.remote, `${repo.remote}.gone`);
  const why = check.refresh();
  assert.match(why, /^could not fetch origin/);
  assert.equal(check.cannotCheck(), why, 'the same reason, asked either way');
  assert.equal(check.landed([old]), false, 'a folder that cannot fetch does not vouch for anything');
  assert.equal(check.refresh(), why, 'asked again, it does not try again');
});

test('a fetch that takes too long is a failed fetch, and says so', () => {
  const run = (root, args, options = {}) => {
    if (args[0] === 'fetch') return { status: -1, stdout: '', missing: false, timedOut: true, options };
    if (args[0] === 'rev-parse' && args[1] === '--git-dir') return { status: 0, stdout: '.git\n' };
    if (args[0] === 'symbolic-ref') return { status: 0, stdout: 'refs/remotes/origin/main\n' };
    return { status: 0, stdout: 'abc\n' };
  };
  const check = createLandingCheck('/anywhere', { run, env: {} });
  assert.equal(check.refresh(), 'could not fetch origin in time');
  assert.equal(check.cannotCheck(), 'could not fetch origin in time');
});

// ---------------------------------------------------------------------------
// One run asks each question once, and only ever asks locally (apart from the one fetch).

// A stand-in for git that answers the questions the check asks and writes down what was asked. `onBranch` is what
// listing the default branch gives. With a `clock`, every answer takes `took` milliseconds of it, and an answer that
// would take longer than the patience it was given is a timeout that used all of that patience.
function fakeGit({ head = 'refs/remotes/origin/main', commits = {}, onBranch = [], fetch = { status: 0, stdout: '' }, remote = true, config = null, listing, batch, clock = null, took = 0 } = {}) {
  const asked = [];
  const ok = (stdout = '') => ({ status: 0, stdout, missing: false });
  const answer = (args, options) => {
    const line = args.join(' ');
    if (line === 'rev-parse --git-dir') return ok('.git\n');
    if (args[0] === 'symbolic-ref') return head ? ok(`${head}\n`) : { status: 1, stdout: '', missing: false };
    if (line === 'remote get-url origin') return remote ? ok('somewhere\n') : { status: 2, stdout: '', missing: false };
    if (line === 'config --get core.sshCommand') return config ? ok(`${config}\n`) : { status: 1, stdout: '', missing: false };
    if (args[0] === 'rev-parse' && args[1] === '--verify') return ok('abc\n');
    if (args[0] === 'fetch') return { missing: false, ...fetch };
    if (args[0] === 'rev-list' && args.includes('--stdin')) {
      if (batch) return batch(args, options);
      const wanted = String(options.input || '').split('\n').filter(Boolean);
      const lines = [];
      for (const oid of Object.keys(commits)) {
        if (wanted.some((name) => oid.startsWith(name.toLowerCase()))) lines.push(`commit ${oid}`, `${oid} ${Math.floor(commits[oid] / 1000)}`);
      }
      return ok(lines.length ? `${lines.join('\n')}\n` : '');
    }
    // The default branch, listed: the commits on it, one id to a line.
    if (args[0] === 'rev-list') return listing ? listing(args, options) : ok(onBranch.length ? `${onBranch.join('\n')}\n` : '');
    return { status: 1, stdout: '', missing: false };
  };
  const run = (root, args, options = {}) => {
    asked.push({ line: args.join(' '), args, options });
    if (clock) {
      if (options.timeout !== undefined && took > options.timeout) {
        clock.now += options.timeout;
        return { status: -1, stdout: '', missing: false, timedOut: true };
      }
      clock.now += took;
    }
    return answer(args, options);
  };
  const count = (word) => asked.filter((entry) => entry.args[0] === word).length;
  return { run, asked, count };
}

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const BRANCH = 'refs/remotes/origin/main';

// A check over a stand-in for git, in an environment of its own: the person's real ssh settings are not read.
const over = (git, options = {}) => createLandingCheck('/anywhere', { run: git.run, env: {}, ...options });
// What listing the default branch asked, apart from the batch that reads the commits.
const listings = (git) => git.asked.filter((entry) => entry.args[0] === 'rev-list' && !entry.args.includes('--stdin')).map((entry) => entry.args);

test('one check reads the default branch once, the commits in one batch, and lists the default branch once', () => {
  const git = fakeGit({ commits: { [A]: T, [B]: T, [C]: T }, onBranch: [A, C] });
  const check = over(git);
  check.read([A, B, C]);
  for (let i = 0; i < 5; i += 1) {
    assert.equal(check.landed([A]), true);
    assert.equal(check.landed([B]), false);
    assert.equal(check.landed([C]), true);
  }
  assert.equal(check.cannotCheck(), '');
  assert.equal(git.count('merge-base'), 0, 'no process per landing');
  assert.equal(git.count('rev-list'), 2, 'the commit times come in one batch, and the default branch is listed in one call');
  assert.equal(git.count('symbolic-ref'), 1);
  assert.equal(git.count('rev-parse'), 2, 'the repository, then the branch');
  assert.deepEqual(listings(git), [['rev-list', BRANCH, '--']]);
  assert.ok(git.asked.every((entry) => /^(rev-parse|symbolic-ref|remote|rev-list) /.test(entry.line)), `only questions about this computer's repository were asked: ${git.asked.map((entry) => entry.line).join(' | ')}`);
  assert.equal(git.asked.find((entry) => entry.args.includes('--stdin')).options.input, `${A}\n${B}\n${C}\n`);
});

test('the git work does not grow with the landings: the same calls for three commits as for three hundred', () => {
  const calls = (count) => {
    const oids = Array.from({ length: count }, (_, i) => `${(i + 1).toString(16).padStart(8, '0')}${'a'.repeat(32)}`);
    const git = fakeGit({ commits: Object.fromEntries(oids.map((oid) => [oid, T])), onBranch: oids });
    const check = over(git);
    assert.equal(check.refresh(), '');
    check.read(oids);
    for (const oid of oids) assert.equal(check.landed([oid], { claimedAt: T }), true);
    return git.asked.map((entry) => entry.args[0]);
  };
  const few = calls(3);
  const many = calls(300);
  assert.deepEqual(many, few, 'three hundred landings ask git exactly what three do');
  assert.equal(many.filter((word) => word === 'merge-base').length, 0);
  assert.equal(many.filter((word) => word === 'rev-list').length, 2, 'the commits in one batch, and the default branch in one listing');
});

test('the default branch is listed back to a day before the earliest claim asked about, and in full when no claim is named', () => {
  const asked = (options) => {
    const git = fakeGit({ commits: { [A]: T }, onBranch: [A] });
    const check = over(git, options);
    check.read([A]);
    check.landed([A]);
    return listings(git);
  };
  assert.deepEqual(asked({}), [['rev-list', BRANCH, '--']], 'no window named, so the whole branch');
  assert.deepEqual(asked({ since: T }), [['rev-list', `--max-age=${Math.floor((T - 5 * MINUTE - DAY) / 1000)}`, BRANCH, '--']]);
  assert.deepEqual(asked({ since: 1000 }), [['rev-list', BRANCH, '--']], 'a window that reaches back past the epoch is the whole branch too');
});

test('with a real repository, only the commits inside the window are listed: older work on the branch is not what a claim could have landed', (t) => {
  const repo = repoFor(t);
  const fresh = repo.land(T + MINUTE);
  repo.sync();
  const check = createLandingCheck(repo.root, { since: T });
  assert.equal(check.landed([fresh], { claimedAt: T }), true);
  assert.equal(check.landed([repo.main]), false, 'October\'s commit is on the branch, and a month before the window');
  const everything = createLandingCheck(repo.root);
  assert.equal(everything.landed([repo.main]), true, 'with no window it is listed');
});

test('the one fetch is the only question that goes out, and it names the branch origin/HEAD names and where it goes', () => {
  const git = fakeGit({ head: 'refs/remotes/origin/release/4', commits: { [A]: T } });
  const check = over(git);
  assert.equal(check.refresh(), '');
  const fetch = git.asked.find((entry) => entry.args[0] === 'fetch');
  assert.deepEqual(fetch.args, ['fetch', 'origin', '+refs/heads/release/4:refs/remotes/origin/release/4'], 'the ref that is checked is the ref that was fetched');
  assert.equal(fetch.options.network, true, 'the fetch is marked as the one network question');
  assert.ok(git.asked.filter((entry) => entry !== fetch).every((entry) => !entry.options.network));
});

test('a problem is found once and then remembered', () => {
  let calls = 0;
  const run = () => { calls += 1; return { status: -1, stdout: '', missing: true }; };
  const check = createLandingCheck('/anywhere', { run, env: {} });
  assert.equal(check.landed([A]), false);
  assert.equal(check.landed([B]), false);
  assert.equal(check.cannotCheck(), 'git is not installed here');
  assert.equal(check.cannotCheck(), 'git is not installed here');
  assert.equal(calls, 1);
});

test('a default branch git cannot list means no landing can be checked, and the check says so', () => {
  const git = fakeGit({ commits: { [A]: T }, onBranch: [A], listing: () => ({ status: 128, stdout: '', missing: false }) });
  const check = over(git);
  assert.equal(check.landed([A]), false);
  assert.equal(check.cannotCheck(), 'git could not read the default branch');
  assert.equal(check.landed([A]), false);
  assert.equal(git.count('rev-list'), 2, 'listed once, not again after it failed');
});

test('a git that stops answering partway means the folder cannot be checked, and nothing more is asked', () => {
  const git = fakeGit({ commits: { [A]: T, [B]: T }, onBranch: [A] });
  const run = (root, args, options) => (args[0] === 'rev-list' && !args.includes('--stdin')
    ? { status: -1, stdout: '', missing: false, timedOut: true }
    : git.run(root, args, options));
  const check = createLandingCheck('/anywhere', { run, env: {} });
  assert.equal(check.cannotCheck(), '', 'the branch was found');
  check.read([A, B]);
  assert.equal(check.landed([A]), false, 'the listing never came');
  assert.equal(check.cannotCheck(), 'git did not answer in time');
  const asked = git.asked.length;
  assert.equal(check.landed([B]), false);
  check.read([C]);
  assert.equal(git.asked.length, asked, 'asked nothing after the silence');
});

test('a git that does not answer the very first question cannot check anything, and is asked once', () => {
  let calls = 0;
  const run = () => { calls += 1; return { status: -1, stdout: '', missing: false, timedOut: true }; };
  const check = createLandingCheck('/anywhere', { run, env: {} });
  assert.equal(check.landed([A]), false);
  assert.equal(check.landed([B]), false);
  assert.equal(check.cannotCheck(), 'git did not answer in time');
  assert.equal(check.cannotCheck(), 'git did not answer in time');
  assert.equal(calls, 1);
});

test('a batch that git cannot read, or does not answer, means no commit can be checked at all', () => {
  const broken = fakeGit({ batch: () => ({ status: 129, stdout: '', missing: false }) });
  const one = over(broken);
  one.read([A]);
  assert.equal(one.cannotCheck(), 'git could not read the commits');
  assert.equal(one.landed([A]), false);

  const silent = fakeGit({ batch: () => ({ status: -1, stdout: '', missing: false, timedOut: true }) });
  const two = over(silent);
  two.read([A]);
  assert.equal(two.cannotCheck(), 'git did not answer in time');
});

test('a short id is matched to the one commit it starts, and an id that starts two commits is not trusted', () => {
  const one = `cd${'2'.repeat(38)}`;
  const first = `ab00000${'1'.repeat(33)}`;
  const second = `ab00000${'2'.repeat(33)}`;
  const git = fakeGit({ commits: { [one]: T, [first]: T, [second]: T } });
  const check = over(git);
  const seen = check.read([`cd${'2'.repeat(10)}`, 'ab00000', 'ab000001', 'abcdefa', 'ab']);
  assert.equal(seen.get(`cd${'2'.repeat(10)}`).oid, one, 'one commit starts this');
  assert.equal(seen.get('ab00000'), null, 'two commits start with it, so it names neither');
  assert.equal(seen.get('ab000001').oid, first, 'one more digit names one');
  assert.equal(seen.get('abcdefa'), null, 'git did not know it');
  assert.equal(seen.has('ab'), false, 'two digits are not a commit id at all');
  assert.equal(git.count('rev-list'), 1);
});

test('reading many commits looks each spelling up in a map: the time does not grow with spellings times commits', () => {
  const count = 15000;
  const oids = Array.from({ length: count }, (_, i) => `${i.toString(16).padStart(10, '0')}${'c'.repeat(30)}`);
  const batch = () => ({ status: 0, stdout: `${oids.map((oid) => `commit ${oid}\n${oid} ${Math.floor(T / 1000)}`).join('\n')}\n`, missing: false });
  for (const spell of [(oid) => oid, (oid) => oid.slice(0, 12), (oid) => oid.slice(0, 7).toUpperCase() + oid.slice(7, 20)]) {
    const check = over(fakeGit({ batch }));
    const names = oids.map(spell);
    const began = Date.now();
    const seen = check.read(names);
    const took = Date.now() - began;
    assert.equal(seen.get(names[count - 1].toLowerCase()).oid, oids[count - 1]);
    assert.equal(seen.get(names[0].toLowerCase()).oid, oids[0]);
    // Comparing every spelling against every commit is over 200 million comparisons; a map is a few thousand lookups.
    assert.ok(took < 1500, `${count} commits took ${took} ms to read`);
  }
});

// ---------------------------------------------------------------------------
// One budget for everything git does before a pick, and git never prompts.

test('everything git does before a pick shares one five-second budget: each question is given what is left of it, the config probe and the fetch included', () => {
  const clock = { now: 1000 };   // not zero: the budget runs from the first question
  const git = fakeGit({ clock, took: 1200 });
  const check = over(git, { now: () => clock.now });
  assert.equal(check.refresh(), 'could not fetch origin in time', 'the fetch got what was left, 200 ms, and it needed longer');
  assert.deepEqual(git.asked.map((entry) => [entry.args.slice(0, 2).join(' '), entry.options.timeout]), [
    ['rev-parse --git-dir', 5000],
    ['symbolic-ref --quiet', 3800],
    ['rev-parse --verify', 2600],
    ['config --get', 1400],
    ['fetch origin', 200],
  ]);
  assert.equal(check.cannotCheck(), 'could not fetch origin in time');
  const asked = git.asked.length;
  check.read([A]);
  assert.equal(check.landed([A]), false);
  assert.equal(git.asked.length, asked, 'once the budget is gone nothing more is asked');
});

test('a git too slow to answer even the first questions cannot check anything, and is not asked past the budget', () => {
  const clock = { now: 0 };
  const git = fakeGit({ clock, took: 2500 });
  const check = over(git, { now: () => clock.now });
  assert.equal(check.landed([A]), false);
  assert.equal(check.cannotCheck(), 'git did not answer in time');
  assert.equal(git.asked.length, 2, 'two answers used the five seconds, and a third was not asked for');
});

test('the budget is the same five seconds when the questions arrive over a long time: it runs from the first question', () => {
  const clock = { now: 0 };
  const git = fakeGit({ clock, took: 100, commits: { [A]: T }, onBranch: [A] });
  const check = over(git, { now: () => clock.now });
  assert.equal(check.cannotCheck(), '');
  clock.now += 60000;
  assert.equal(check.landed([A]), false, 'a minute later the budget is long gone');
  assert.equal(check.cannotCheck(), 'git did not answer in time');
  assert.equal(git.count('rev-list'), 0, 'nothing was asked after the budget ended');
});

// A stand-in for the operating system's way of starting a program, so a test can see exactly how git is started.
function fakeSpawn({ config = '', fetchStatus = 0, fetchError = null } = {}) {
  const started = [];
  const spawn = (command, args, options) => {
    const rest = args.slice(2);   // after -C <folder>
    started.push({ command, args: rest, options, line: rest.join(' ') });
    const reply = (status, stdout = '') => ({ status, stdout, signal: null });
    if (rest[0] === 'rev-parse' && rest[1] === '--git-dir') return reply(0, '.git\n');
    if (rest[0] === 'symbolic-ref') return reply(0, 'refs/remotes/origin/main\n');
    if (rest[0] === 'rev-parse' && rest[1] === '--verify') return reply(0, 'abc\n');
    if (rest[0] === 'config') return config ? reply(0, `${config}\n`) : reply(1);
    if (rest[0] === 'fetch') return fetchError ? { status: null, stdout: '', error: fetchError } : reply(fetchStatus);
    if (rest[0] === 'rev-list' && rest.includes('--stdin')) return reply(0, `commit ${A}\n${A} ${Math.floor(T / 1000)}\n`);
    if (rest[0] === 'rev-list') return reply(0, `${A}\n`);
    return reply(1);
  };
  return { spawn, started };
}

test('git never prompts: stdin is closed, GIT_TERMINAL_PROMPT is 0, every call has a time limit, and ssh runs in batch mode', () => {
  const { spawn, started } = fakeSpawn();
  const check = createLandingCheck('/anywhere', { spawn, env: { PATH: '/usr/bin', HOME: '/home/someone' } });
  assert.equal(check.refresh(), '');
  check.read([A]);
  assert.equal(check.landed([A]), true);
  assert.ok(started.length >= 6, started.map((one) => one.line).join(' | '));
  for (const one of started) {
    assert.equal(one.command, 'git');
    assert.equal(one.options.env.GIT_TERMINAL_PROMPT, '0', one.line);
    assert.ok(Number.isFinite(one.options.timeout) && one.options.timeout > 0 && one.options.timeout <= 5000, `${one.line}: ${one.options.timeout}`);
    const fed = one.options.input !== undefined;
    assert.equal(one.options.stdio[0], fed ? 'pipe' : 'ignore', `${one.line}: nothing is left open for git to ask a person on`);
    assert.equal(one.options.env.GIT_DIR, undefined);
  }
  const fetch = started.find((one) => one.args[0] === 'fetch');
  assert.deepEqual(fetch.args, ['fetch', 'origin', '+refs/heads/main:refs/remotes/origin/main']);
  assert.match(fetch.options.env.GIT_SSH_COMMAND, /(^| )-o BatchMode=yes( |$)/, 'ssh cannot wait for a person');
  assert.equal(started.filter((one) => one.options.env.GIT_SSH_COMMAND).length, 1, 'only the fetch can reach for ssh');
  assert.ok(started.some((one) => one.line === 'config --get core.sshCommand'), 'the person\'s own ssh setting was looked for');
  assert.deepEqual(check.notes(), [], 'nothing of the person\'s was overridden, so there is nothing to say');
});

for (const own of [
  { label: 'GIT_SSH_COMMAND', env: { GIT_SSH_COMMAND: 'ssh -i /keys/mine' }, config: '', probes: false },
  { label: 'GIT_SSH', env: { GIT_SSH: '/usr/local/bin/my-ssh' }, config: '', probes: false },
  { label: 'core.sshCommand', env: {}, config: 'ssh -F /home/me/ssh_config', probes: true },
]) {
  test(`${own.label} is the person's own ssh command: it is left as it is, the fetch still never waits on a person, and the check says what it did`, () => {
    const { spawn, started } = fakeSpawn({ config: own.config });
    const check = createLandingCheck('/anywhere', { spawn, env: { PATH: '/usr/bin', ...own.env } });
    assert.equal(check.refresh(), '');
    const fetch = started.find((one) => one.args[0] === 'fetch');
    assert.equal(fetch.options.env.GIT_SSH_COMMAND, own.env.GIT_SSH_COMMAND, 'batch mode is added only when the person has no ssh command of their own');
    assert.equal(fetch.options.env.GIT_TERMINAL_PROMPT, '0');
    assert.equal(fetch.options.stdio[0], 'ignore');
    assert.ok(fetch.options.timeout <= 5000);
    assert.equal(started.some((one) => one.line === 'config --get core.sshCommand'), own.probes);
    const notes = check.notes();
    assert.equal(notes.length, 1, notes.join(' | '));
    assert.ok(notes[0].includes(own.label), `the note names where the ssh command comes from: ${notes[0]}`);
    assert.match(notes[0], /left (it )?(as it is|alone)/);
    assert.match(notes[0], /five seconds/);
    assert.equal(check.refresh(), '');
    assert.deepEqual(check.notes(), notes, 'said once, however often the fetch is asked for');
  });
}

test('a fetch that the operating system times out is a fetch that did not finish in time, and a spawn that fails to start is no fetch', () => {
  const late = fakeSpawn({ fetchError: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }) });
  assert.equal(createLandingCheck('/anywhere', { spawn: late.spawn, env: {} }).refresh(), 'could not fetch origin in time');
  const failed = fakeSpawn({ fetchStatus: 128 });
  assert.equal(createLandingCheck('/anywhere', { spawn: failed.spawn, env: {} }).refresh(), 'could not fetch origin');
});

// ---------------------------------------------------------------------------
// Whether any landing can be checked in this folder at all.

test('cannotCheck says why no landing can be checked in this folder at all, and says nothing when the check can run', (t) => {
  const fine = repoFor(t);
  assert.equal(createLandingCheck(fine.root).cannotCheck(), '');

  assert.equal(createLandingCheck(repoFor(t, { origin: false }).root).cannotCheck(), 'no origin branch');

  assert.equal(createLandingCheck(folder(t)).cannotCheck(), 'this folder is not a git repository');

  const nothingHere = folder(t, 'landing-check-nopath-');
  const saved = process.env.PATH;
  t.after(() => { process.env.PATH = saved; });
  process.env.PATH = nothingHere;
  assert.equal(createLandingCheck(fine.root).cannotCheck(), 'git is not installed here');
});

test('an origin with no default branch set and one with a dangling one are told apart from no origin, by the fix they name', () => {
  const unset = fakeGit({ head: null });
  assert.match(over(unset).cannotCheck(), /not set.*git remote set-head origin --auto/);
  const none = fakeGit({ head: null, remote: false });
  assert.equal(over(none).cannotCheck(), 'no origin branch');
});

test('asking cannotCheck first changes nothing about what is landed, and nothing is asked twice', () => {
  const git = fakeGit({ commits: { [A]: T, [B]: T }, onBranch: [A] });
  const check = over(git);
  assert.equal(check.cannotCheck(), '');
  assert.equal(check.cannotCheck(), '');
  assert.equal(check.landed([A]), true);
  assert.equal(check.landed([B]), false);
  assert.equal(check.cannotCheck(), '');
  assert.equal(git.count('symbolic-ref'), 1, 'the default branch is read once');
  assert.equal(git.asked.filter((entry) => entry.line === 'rev-parse --git-dir').length, 1);
});
