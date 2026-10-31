'use strict';

// Whether a landing really landed. The rating counts a job as landed when its record says it merged. The
// builder picker steers by that count, so it asks more of each landing, and it asks git, on this computer:
//
//   One. The commit the record names is on origin's default branch. The branch is listed once (git rev-list, back to
//        a day before the earliest claim the caller will ask about), and every commit is looked up in that list.
//        However many landings there are, git is asked the same few questions, and no process is started for any one
//        landing.
//   Two. The commit is no older than the claim it lands, allowing five minutes for clocks that disagree. Work
//        that was already on the branch before the job began is not what the job landed. Every commit is read
//        in one batched call (git rev-list --stdin), however many landings there are.
//   Three. No other job recorded the same commit first. The check does not know jobs: the caller passes
//        `owns(commit)`, and a landing counts only when one of its commits is the caller's to claim.
//
// The default branch is the one origin/HEAD names, and nothing else: origin/main and origin/master are never
// guessed, because a repository whose default branch is something else would be checked against the wrong
// branch without a word. When origin/HEAD is not set, or names a branch this folder does not have, no landing can be
// checked here and the reason names the fix (git remote set-head origin --auto). The same goes for a folder
// that is not a git repository, a computer without git, and a folder with no origin.
//
// Before anything is counted, refresh() fetches origin's default branch once (and only that branch), so a merge
// that happened a minute ago is known. The fetch names where the branch goes (+refs/heads/<branch>:refs/remotes/
// origin/<branch>), so the ref that is checked is the ref that was fetched, whatever the repository's own fetch
// settings say. If the fetch fails or takes too long, no landing can be checked, and the reason says so. Everything
// else asks only about this computer's repository; the fetch is the one question that goes out, and it is marked so
// a stand-in for git can tell it apart.
//
// Everything git does before a pick shares one budget of five seconds, counted from the first question: each
// question is given what is left of it, the question about the person's ssh settings and the fetch included. When it
// is gone nothing more is asked, and no landing can be checked. Git never prompts a person: its standard input is
// closed, GIT_TERMINAL_PROMPT is 0, and the fetch runs ssh in batch mode (-o BatchMode=yes). A person's own ssh
// command (GIT_SSH_COMMAND, GIT_SSH or core.sshCommand) is not replaced: the fetch runs it as it is, the five
// seconds still end it, and notes() says so in one line.
//
// A landing with no commit, a commit git cannot find or that sits on a side branch only, a commit made before the
// claim, or one another job recorded first: none of these count as landed. The check changes nothing the rating
// counts. One check lives for one run: it reads the default branch once, reads each commit once, and looks up
// each commit in what it read. If git stops answering in time (a hung disk, a lock) or the budget runs out, the
// check stops asking and cannotCheck() says so: nothing more counts as landed.
//
// The limit of listing only the window: `git rev-list --max-age` skips a commit older than the limit and does not
// walk on to its parents, so a branch whose commit dates run backwards by more than a day (a clock set wrong, a
// rebase on a machine far behind) can hide commits behind such a commit. A hidden commit is not landed, which is
// the safe answer. The day on top of the five minutes of skew is what that allowance is.

const { spawnSync } = require('child_process');

const HEX = /^[0-9a-f]{7,64}$/i;
const COMMIT_KEYS = ['merge_commit', 'merge_commit_sha', 'merge_sha'];

// A folder's own git, not the repository of whatever hook or script started this run.
const GIT_POINTERS = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE', 'GIT_SHALLOW_FILE', 'GIT_PREFIX'];

// All of git's work before a pick shares this long, as short as the fetch a worktree start makes
// (commands/worktree.js refreshRemoteRef): it runs before a flight's first job is dealt, and a slow network is
// answered by dealing in turn, not by waiting.
const BUDGET_MS = 5000;
// A commit made up to this long before its claim still counts: two computers' clocks are never quite together.
const SKEW_MS = 5 * 60 * 1000;
// The default branch is listed back to this much before the skew allowance, for commits whose dates are out of order.
const WINDOW_MARGIN_MS = 24 * 60 * 60 * 1000;
const FIX = 'git remote set-head origin --auto';
const ORIGIN_BRANCH = /^refs\/remotes\/origin\/([^\s:-][^\s:]*)$/;
// Run ssh so that it cannot wait on a person (no password, no host-key question).
const BATCH_SSH = 'ssh -o BatchMode=yes';

// The commits one landing record names, from the same places the rating looks for a merge (the record itself,
// its landing, its pull request). A merged pull request's merge commit is checked like any other commit.
function commitsOf(payload) {
  const record = payload && typeof payload === 'object' ? payload : {};
  const places = [record, record.landing, record.pull_request, record.pr]
    .filter((place) => place && typeof place === 'object' && !Array.isArray(place));
  const found = [];
  for (const place of places) {
    for (const key of COMMIT_KEYS) {
      if (typeof place[key] === 'string' && HEX.test(place[key])) found.push(place[key].toLowerCase());
    }
  }
  return [...new Set(found)];
}

function cleanEnv(base) {
  const env = { ...base, GIT_TERMINAL_PROMPT: '0' };
  for (const key of GIT_POINTERS) delete env[key];
  return env;
}

// Start git in `root`. Standard input is closed unless there is text for it, `timeout` is what is left of the budget,
// and git never prompts. `input` is text for git's standard input. `network` marks the one question that goes out; it
// is given `ssh` (the ssh command to run, when the check chose one) and keeps the repository's own network settings.
function runGit(spawn, base, root, args, { input, network = false, ssh = '', timeout } = {}) {
  const env = cleanEnv(base);
  if (!network) env.GIT_NO_LAZY_FETCH = '1';
  if (ssh) env.GIT_SSH_COMMAND = ssh;
  const done = spawn('git', ['-C', root, ...args], {
    env,
    encoding: 'utf8',
    timeout,
    killSignal: 'SIGKILL',
    maxBuffer: 64 * 1024 * 1024,
    ...(input === undefined ? {} : { input }),
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'ignore'],
  });
  if (done.error) return { status: -1, stdout: '', missing: done.error.code === 'ENOENT', timedOut: done.error.code === 'ETIMEDOUT' };
  return { status: done.status, stdout: String(done.stdout || ''), missing: false, timedOut: false };
}

// `run(root, args, { input, network, ssh, timeout })` stands in for git in tests, and `spawn` for the operating
// system's way of starting it. They answer { status, stdout, missing, timedOut }. `env` is the environment git
// runs in (this process's by default), `now` the clock the budget is counted on, and `since` (milliseconds) the
// earliest claim any landing asked about could have: the default branch is listed back to a day before it.
function createLandingCheck(root, { run, spawn = spawnSync, env = process.env, now = Date.now, budgetMs = BUDGET_MS, since } = {}) {
  const gitRun = run || ((dir, args, options) => runGit(spawn, env, dir, args, options));
  let startedAt = null;    // the first question starts the budget
  let spent = false;       // the budget is used up, or git did not answer in time: no more questions are asked
  let target = null;       // { ref, branch }, or { problem }: looked up once
  let fetched = null;      // null until refresh() has run, then '' or why it could not fetch
  let unreadable = '';     // why the commits, or the default branch, could not be read
  const told = [];         // what the check did that a person should hear about
  const sightings = new Map();   // a commit as spelled (lower case) -> { oid, time } or null
  let onBranch = null;           // the full ids of the commits on the default branch inside the window

  // Every question goes through here, with what is left of the budget. Once git has not answered in time, or the
  // budget is gone, no more are asked.
  function ask(args, options = {}) {
    const silent = { status: -1, stdout: '', missing: false, timedOut: true };
    if (spent) return silent;
    if (startedAt === null) startedAt = now();
    const left = budgetMs - (now() - startedAt);
    if (left <= 0) {
      spent = true;
      return silent;
    }
    const answer = gitRun(root, args, { ...options, timeout: left });
    if (answer.timedOut) spent = true;
    return answer;
  }

  // The branch to check against, or why there is none. Looked up once.
  function look() {
    if (target) return target;
    const fail = (problem) => (target = { problem });
    const inside = ask(['rev-parse', '--git-dir']);
    if (inside.missing) return fail('git is not installed here');
    if (inside.timedOut) return fail('git did not answer in time');
    if (inside.status !== 0) return fail('this folder is not a git repository');
    const head = ask(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
    if (head.timedOut) return fail('git did not answer in time');
    const named = head.status === 0 ? ORIGIN_BRANCH.exec(head.stdout.trim()) : null;
    if (!named) {
      // Not set. Say which of two things it is: no origin at all, or an origin whose default branch was never read.
      const remote = ask(['remote', 'get-url', 'origin']);
      if (remote.timedOut) return fail('git did not answer in time');
      return fail(remote.status === 0 ? `origin's default branch is not set here, so there is no branch to check against; fix it with ${FIX}` : 'no origin branch');
    }
    const ref = head.stdout.trim();
    const there = ask(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    if (there.timedOut) return fail('git did not answer in time');
    if (there.status !== 0) return fail(`origin's default branch, origin/${named[1]}, is not in this folder; fix it with ${FIX}`);
    return (target = { ref, branch: named[1] });
  }

  // Why no landing can be checked in this folder at all, or ''. A fetch that failed counts: a folder that cannot
  // bring origin up to date does not vouch for anything. So does a git that stopped answering.
  function cannotCheck() {
    return look().problem || fetched || unreadable || '';
  }

  // The ssh command the fetch runs with, or '' to leave ssh as the repository has it. A person's own ssh command
  // (GIT_SSH_COMMAND, GIT_SSH, or core.sshCommand in the repository's settings) is never replaced: it runs as it is, the
  // five seconds still end the fetch, and the check says so. With none, ssh is told never to wait on a person.
  function sshForFetch() {
    let own = '';
    if (String(env.GIT_SSH_COMMAND || '').trim()) own = 'GIT_SSH_COMMAND';
    else if (String(env.GIT_SSH || '').trim()) own = 'GIT_SSH';
    else {
      const configured = ask(['config', '--get', 'core.sshCommand']);
      if (configured.status === 0 && configured.stdout.trim()) own = 'core.sshCommand';
    }
    if (!own) return BATCH_SSH;
    told.push(`your own ssh command (${own}) was left as it is, so ssh may stop to ask for a password; the fetch gives up after five seconds either way`);
    return '';
  }

  // Fetch origin's default branch, once. Returns '' when it worked, else why it did not. Asked again, it answers the
  // same and does not try again. A folder that cannot be checked is not fetched.
  function refresh() {
    const found = look();
    if (found.problem) return found.problem;
    if (fetched !== null) return fetched;
    const ssh = sshForFetch();
    const spec = `+refs/heads/${found.branch}:refs/remotes/origin/${found.branch}`;
    const done = ask(['fetch', 'origin', spec], { network: true, ...(ssh ? { ssh } : {}) });
    if (done.timedOut) fetched = 'could not fetch origin in time';
    else if (done.status !== 0) fetched = 'could not fetch origin';
    else fetched = '';
    // What was unknown before the fetch may be known now.
    if (!fetched) {
      sightings.clear();
      onBranch = null;
    }
    return fetched;
  }

  // The commits as git has them, in one batched call: a Map from each commit as spelled (lower case) to
  // { oid, time } (the full id and the commit time in milliseconds), or to null when git does not have it, or when a
  // short spelling starts more than one commit. What was read before is not read again.
  function read(commits) {
    const names = [...new Set((Array.isArray(commits) ? commits : []).map((commit) => String(commit == null ? '' : commit).trim().toLowerCase()).filter((commit) => HEX.test(commit)))];
    const fresh = names.filter((name) => !sightings.has(name));
    if (fresh.length) {
      const found = look();
      if (found.problem || spent || unreadable) {
        for (const name of fresh) sightings.set(name, null);
      } else {
        // --ignore-missing goes first: git reads it before the names on standard input. With it, a name git does not
        // have, or one that starts two commits, is left out instead of ending the whole batch.
        const answer = ask(['rev-list', '--ignore-missing', '--no-walk=unsorted', '--stdin', '--format=%H %ct'], { input: `${fresh.join('\n')}\n` });
        if (answer.timedOut) unreadable = 'git did not answer in time';
        else if (answer.status !== 0) unreadable = 'git could not read the commits';
        const commitsRead = [];
        if (!unreadable) {
          for (const line of answer.stdout.split('\n')) {
            const one = /^([0-9a-f]{40,64}) (\d+)$/.exec(line.trim());
            if (one) commitsRead.push({ oid: one[1], time: Number(one[2]) * 1000 });
          }
        }
        // Each spelling is looked up in a map of the commits it could start, not compared against every commit: one
        // entry for each commit and each length a spelling was given in (a spelling is 7 to 64 digits).
        const lengths = [...new Set(fresh.map((name) => name.length))];
        const starting = new Map();
        for (const one of commitsRead) {
          for (const length of lengths) {
            if (length > one.oid.length) continue;
            const prefix = one.oid.slice(0, length);
            const held = starting.get(prefix);
            if (held) held.push(one); else starting.set(prefix, [one]);
          }
        }
        for (const name of fresh) {
          const starts = starting.get(name) || [];
          sightings.set(name, starts.length === 1 ? starts[0] : null);
        }
        // A commit asked for by a short spelling is also known by its full id, which is how a later landing may name it.
        for (const one of commitsRead) if (!sightings.has(one.oid)) sightings.set(one.oid, one);
      }
    }
    return new Map(names.map((name) => [name, sightings.get(name) || null]));
  }

  // The commits on the default branch, listed once: the full ids of everything reachable from it inside the window,
  // or null when git could not list it (cannotCheck says why).
  function branchCommits(ref) {
    if (onBranch) return onBranch;
    if (unreadable) return null;
    const edge = Number.isFinite(since) ? since - SKEW_MS - WINDOW_MARGIN_MS : 0;
    const window = edge > 0 ? [`--max-age=${Math.floor(edge / 1000)}`] : [];
    const answer = ask(['rev-list', ...window, ref, '--']);
    if (answer.timedOut) unreadable = 'git did not answer in time';
    else if (answer.status !== 0) unreadable = 'git could not read the default branch';
    if (unreadable) return null;
    onBranch = new Set(answer.stdout.split('\n').map((line) => line.trim().toLowerCase()).filter(Boolean));
    return onBranch;
  }

  return {
    cannotCheck,
    refresh,
    read,
    // What the check did that a person should hear about, in plain words: a line each, said once. Empty when it left
    // nothing of theirs alone.
    notes: () => told.slice(),
    // True when one of these commits is on the default branch, is no older than `claimedAt` (a time in
    // milliseconds, if given; five minutes of skew allowed) and is `owns(commit)`'s to claim (if given; it is
    // handed the full id, and only for a commit that is already landed). No commits, or no branch to check, is false.
    landed(commits, { claimedAt, owns } = {}) {
      const found = look();
      if (found.problem || fetched || unreadable) return false;
      const seen = read(commits);
      if (unreadable) return false;
      const listed = [...seen.values()].some(Boolean) ? branchCommits(found.ref) : null;
      if (!listed) return false;
      return [...seen.keys()].some((name) => {
        const sighting = seen.get(name);
        if (!sighting) return false;
        if (Number.isFinite(claimedAt) && sighting.time < claimedAt - SKEW_MS) return false;
        if (!listed.has(sighting.oid)) return false;
        return typeof owns === 'function' ? Boolean(owns(sighting.oid)) : true;
      });
    },
  };
}

module.exports = { commitsOf, createLandingCheck };
