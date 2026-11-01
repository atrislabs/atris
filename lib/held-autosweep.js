'use strict';

// Held jobs, swept on their own. A held job is work that is done and handed in, waiting in Review under its
// builder's name for a person to land its pull request. When the person merges it, nothing in the task store
// hears about it: `atris task sweep --held` is the check that asks GitHub (lib/held-pull-requests.js), and
// nobody ran it, so a merged pull request sat for hours with its builder still rated 25. The commands that
// show the rating or start work now run that same check themselves: atris brief, atris rating and atris gm at
// their start, and both flights (the fleet flight and the dispatch flight) once they are past their disk look.
// So a merge is usually credited within the hour, by one of those that reaches GitHub, and `atris task sweep --held`
// does it right away. Only what always holds is said about the rest. Order: the check never runs before a flight's
// low-disk look (a flight that refuses writes nothing to any job) and never on a dry run, and any pick of a builder
// that reads the results after the check sees what the check credited or released, in that flight or in a later one.
//
// It is a favor to the command around it, never a cost:
//   - Only this workspace, and only when it has a held job, which reads of the task store tell. The first is one
//     plain question about every workspace, with no call to git: with no job held anywhere, which is the usual
//     case, that is the end of it, and nothing is asked of GitHub or of git or written anywhere. Only when some
//     job is held somewhere is git asked which checkouts are linked to this workspace (a held job may sit in
//     one), and that call is held to what is left of the eight seconds and ended outright if it does not answer.
//   - A run that GitHub gave a readable answer in, and that did not fail, is written down, and holds off the runs
//     that would start within the hour after it. Its time is one small file in the CLI's state folder
//     (state/held-sweep, one file for each workspace), never in the task store or the repository. Any other run
//     writes nothing, so it holds nothing off.
//   - One command at a time. A run first makes a small lock file beside that record, with the exclusive flag,
//     so of two commands that start together one asks GitHub and the other goes on without a word. A lock
//     more than a minute old belongs to a run that died, and is taken over under a second small file made the
//     same way, so that only one run at a time removes it and a late second command cannot remove the new lock
//     the first has made; a run that loses any step of that goes on without a word.
//   - Eight seconds bound the waiting, not the whole run. They are counted from the start of the run and cover git and
//     GitHub: git gets two seconds to tell the linked checkouts and two to say where the workspace came from; one
//     question to GitHub gets four, and none is started with under a second and a half left. Once the eight are used
//     up the run stops asking. The task store is opened with a wait of about a second for other writers. So a slow or
//     missing gh, a hung git or a locked store holds the command for eight seconds at most. Reads of the local task
//     list are not cut short, and on the real store they take well under a second. Known limit: the run lists the
//     workspace's tasks once and never numbers them, but each credit numbers the list inside the task store to write
//     the journal line, as the manual sweep does, which can take seconds on a very large list. Nothing else starts
//     git. The sweep would, when it refuses a pull request that another job has and names that job in that job's own
//     workspace (listing a workspace's tasks asks git for its linked checkouts), and that can be a workspace this run
//     was never asked about. The run says nothing of a refusal, so it names that job by its id and looks at no other
//     workspace.
//   - gh missing, gh that cannot be run, gh stopped by a signal or timed out, not signed in, GitHub down, git that
//     cannot answer (it hung, could not be run, or exited with an error), a store that stays locked: the run stops,
//     says nothing and is not written down, so it holds nothing off. A job that cannot be settled does not stop the
//     run, but the run is not written down either. All of that holds after GitHub has answered too. The jobs it
//     settled before it stopped stay settled. A run is written down when GitHub gave it at least one readable
//     answer and nothing in it failed, and using up the eight seconds is not a failure (the rule is stated where the
//     record is written), so a run that asked nothing, or understood nothing, or failed, holds nothing off.
//   - Silent unless it acts. It says one plain line on stderr for each job it credits or lets go, as soon as
//     that job is settled, and nothing on stdout, so --json output is untouched. A job it cannot settle costs
//     one short line, and the run goes on to the next job. A line that cannot be written (nobody reads stderr,
//     or the pipe is full) is lost where it is written, or cut short when the pipe had room for only part of it,
//     and the command ends as it would have without the check. On POSIX a pipe that is full is not waited for; a
//     terminal that is paused holds this write as it holds every other line the command prints.
//   - It never breaks the command around it: a failure of its own costs one short line on stderr.
//   - ATRIS_HELD_SWEEP=off skips it entirely.
//
// The check is the manual sweep itself (sweepHeldJobs), called for one job at a time under the name the manual
// sweep records when it is not told one, so the rating reads a credit the same whichever way it was written.
// The workspace's task list is read once for the whole run and never numbered, since the run prints no task number, and
// each call is handed its job from that.
// The manual sweep takes no lock, so it can be running at the same moment. That is safe: a job is settled only
// while its row is still what the sweep read, and one pull request lands once, so the second run finds
// nothing left to do.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const taskDb = require('./task-db');
const { atrisHome } = require('./state-home');
const { pullRequestOfLink } = require('./pull-request-link');
const { askGitHub, askDefaultBranch, heldJobsAmong, originRepoOf, sweepHeldJobs } = require('./held-pull-requests');

const HOUR_MS = 60 * 60 * 1000;
// TOTAL_MS bounds the waiting, not the whole run. It is counted from the start of the run, and the run stops asking
// once it is used up. Reads of the local task list are not cut short. One question to GitHub gets CALL_MS of it and is
// not started with less than LEAST_CALL_MS left, which could not answer it in time; each of git's questions (which
// checkouts are linked to the workspace, and where the workspace came from) gets GIT_MS and is not started with less
// than LEAST_GIT_MS left.
const TOTAL_MS = 8000;
const CALL_MS = 4000;
const LEAST_CALL_MS = 1500;
const GIT_MS = 2000;
const LEAST_GIT_MS = 500;
// A lock this far from now, either way, belongs to a run that died.
const STALE_LOCK_MS = 60 * 1000;
const OFF = /^(off|0|false|no)$/i;
// One plain question to the task store, about every workspace and with no call to git: is any job held? It asks
// for more than the check settles (a job in review with a claim and a pull request on its row, whether or not that
// pull request is still open) and never for less, so a no is a no for every workspace.
const ANY_HELD_JOB = "SELECT 1 FROM tasks WHERE status = 'review' AND claimed_by IS NOT NULL AND claimed_by <> '' AND metadata LIKE '%\"pull_request\"%' LIMIT 1";

// What gh says when it is not signed in, and when GitHub cannot answer right now. The sweep already stops on
// a gh that is missing or that times out; these are the other ways gh fails for the whole run rather than for
// one pull request. Anything else gh says (a pull request it cannot find, a repository it may not read) is an
// answer about that one job, and the run goes on.
const SIGNED_OUT = /gh auth login|bad credentials|HTTP 401|not logged in|authentication (?:is )?required|requires authentication|GH_TOKEN|GITHUB_TOKEN/i;
const GITHUB_DOWN = /HTTP 5\d\d|HTTP 429|bad gateway|service unavailable|gateway time-?out|internal server error|rate limit|error connecting to|check your internet|githubstatus|could not resolve host|no such host|dial tcp|network is unreachable|connection (?:refused|reset|timed out)|\bE(?:CONNREFUSED|CONNRESET|NOTFOUND|AI_AGAIN|TIMEDOUT)\b|i\/o timeout|TLS handshake|x509/i;
// The one way gh says, in so many words, that GitHub has no pull request with the number it was asked about, and the
// repository itself is there. gh 2.74.2 prints exactly this on its error output, nothing on its output, and exits 1:
//   GraphQL: Could not resolve to a PullRequest with the number of 99999999. (repository.pullRequest)
// Nothing else is that, and a 404 least of all, since GitHub answers 404 for a repository the token cannot read too.
// A repository it cannot read ("Could not resolve to a Repository"), a message it has not shown before and a failure
// with no words at all say nothing about the pull request. So the match is the whole error output, less the one line
// break gh ends it with, and that is that message and nothing but it, for the very number asked about: the same
// sentence for another number, the sentence inside a longer message (words in front of it, another error behind it,
// other lines around it), the sentence with a space or a blank line in front or a second line break or spaces behind,
// a 404 or a longer status like "HTTP 4040" are all some other reply, which cannot be read. Another wording of the
// sentence, such as "GraphQL error:" in front of it and no path behind it, is not taken for it either: if a gh words
// it so, a deleted link is no answer, and holds nothing off, which is the safe side.
function noSuchPullRequestMessage(number) {
  return `GraphQL: Could not resolve to a PullRequest with the number of ${number}. (repository.pullRequest)`;
}

// What is left of the eight seconds of waiting, in milliseconds.
function timeLeft(now, began) {
  return TOTAL_MS - (now() - began);
}

// One line on stderr, written on the spot, and lost where it is written if it cannot be. A stream's write on a pipe is
// finished later, and a pipe whose reader has gone then fails with EPIPE as an error event that no try around the
// write can catch: it ends a command that goes on running (atris gm, a flight) with a different exit code, after a
// job was settled. So the line goes straight to the file (descriptor 2), and any error (EPIPE when nobody reads,
// EAGAIN when the pipe is full) costs the line and nothing else. No listener is added to process.stderr: that would
// answer for every other write the command makes as well.
//
// The line before the write makes Node create process.stderr first. On POSIX Node sets a pipe to not wait for room
// when it creates that stream, and until then the descriptor is whatever the parent handed down, usually one that
// waits. A write to a pipe that is full and that nobody reads would then never return, and would hold the command and
// the lock for as long as nobody read it, after a job was settled: the eight seconds bound the waiting on git and
// GitHub, not a write. With the stream made, the same write fails at once with EAGAIN, which the catch swallows. A
// write can also go through in part when the pipe has a little room. It is not tried again, so on a full pipe a line
// can be cut short or lost. A terminal stays as Node sets it (it waits for room), so a paused terminal holds this
// write exactly as it holds every other line the command prints.
function writeLine(line) {
  try {
    void process.stderr;
    fs.writeSync(2, `${line}\n`);
  } catch {
    // The line is lost. The command goes on.
  }
}

function oneLine(text, max) {
  const flat = String(text === undefined || text === null ? '' : text).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
}

// Who `atris task sweep --held` records when it is not told with --as (DEFAULT_OWNER in commands/task.js).
// The rating reads a name with "auto" in it as an autoland, so a credit written here must carry that same
// name, never one of its own.
function actorOf(env) {
  const osName = () => { try { return os.userInfo().username; } catch { return ''; } };
  return String(env.ATRIS_AGENT_ID || env.USER || osName() || 'unknown');
}

// Where the time of the last written-down run for a workspace is kept: one small file named by the workspace's path,
// so two workspaces never share a record and looking at one never writes into its repository.
function recordPath(workspace, env) {
  const name = crypto.createHash('sha1').update(path.resolve(String(workspace))).digest('hex');
  return path.join(atrisHome(env), 'state', 'held-sweep', `${name}.json`);
}

function lastRunAt(file) {
  try {
    const at = Number(JSON.parse(fs.readFileSync(file, 'utf8')).last_run_at);
    return Number.isFinite(at) && at > 0 ? at : null;
  } catch {
    return null;
  }
}

// Whether the check ran within the last hour. A last run in the future (the clock was set back) does not hold
// the sweep off.
function ranRecently(file, now) {
  const last = lastRunAt(file);
  return last !== null && now() >= last && now() - last < HOUR_MS;
}

// Written to a temp file then renamed, so a reader never sees half a file and two runs never clobber each other.
function writeRecord(file, workspace, at) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify({ workspace, last_run_at: at, last_run_iso: new Date(at).toISOString() })}\n`);
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* nothing left to clean */ }
    throw err;
  }
}

// Makes the lock file with the exclusive flag and puts the run's token in it. False when the file is already there.
function makeLock(file, token) {
  let fd;
  try {
    fd = fs.openSync(file, 'wx');
  } catch (err) {
    if (err && err.code === 'EEXIST') return false;
    throw err;
  }
  try {
    fs.writeSync(fd, `${token}\n`);
  } catch (err) {
    fs.closeSync(fd);
    try { fs.unlinkSync(file); } catch { /* nothing left to clean */ }
    throw err;
  }
  fs.closeSync(fd);
  return true;
}

// When a file was made (its own time), or null when there is no such file.
function madeAtOf(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
}

// A file this far from now, either way, belongs to a run that died.
const isDead = (madeAt, now) => Math.abs(now() - madeAt) >= STALE_LOCK_MS;

// The right to run the check, as a small file made with the exclusive flag: of two commands that start together
// only one can make it. Returns { release }, or null when another run holds it.
//
// A lock more than STALE_LOCK_MS old belongs to a run that died, and is taken over. Removing a lock by its name
// is not safe on its own: two runs can look at the same dead lock, and the slower one would then remove the new
// lock the faster one has made since. So the removal is a step one run at a time may take, guarded by a second
// small file made the same way beside the lock (its name and .takeover). The run that makes it looks at the lock
// again, removes it only if it is still that old, and makes the new lock. A run that finds the guard taken, finds
// the lock new after all, or loses the making of the new lock to another run, gives the check up. No run removes
// a lock it has not just seen to be dead, while holding the guard that keeps every other run from removing one.
// A guard more than STALE_LOCK_MS old is a run that died in the middle of a takeover: it is removed, once.
function takeLock(file, now) {
  const token = crypto.randomBytes(8).toString('hex');
  const mine = { release: () => letGo(file, token) };
  if (makeLock(file, token)) return mine;
  const madeAt = madeAtOf(file);
  // The run that held it let it go in the moment between: it is free to make, once.
  if (madeAt === null) return makeLock(file, token) ? mine : null;
  if (!isDead(madeAt, now)) return null;
  const guard = `${file}.takeover`;
  if (!makeLock(guard, token)) {
    const guardedAt = madeAtOf(guard);
    if (guardedAt === null || !isDead(guardedAt, now)) return null;
    try { fs.unlinkSync(guard); } catch (err) { if (!err || err.code !== 'ENOENT') throw err; }
    if (!makeLock(guard, token)) return null;
  }
  try {
    const nowMadeAt = madeAtOf(file);
    if (nowMadeAt !== null) {
      if (!isDead(nowMadeAt, now)) return null;
      try { fs.unlinkSync(file); } catch (err) { if (!err || err.code !== 'ENOENT') throw err; }
    }
    return makeLock(file, token) ? mine : null;
  } finally {
    letGo(guard, token);
  }
}

// Lets the lock go, if it is still this run's: one taken over as dead is not removed by the run that lost it.
function letGo(file, token) {
  try {
    if (fs.readFileSync(file, 'utf8').trim() === token) fs.unlinkSync(file);
  } catch { /* already gone */ }
}

// Reads the task store for the question `ask`, on a connection that opens nothing for writing and creates nothing,
// as the sweep of expired claims does. A store that cannot be read holds no job this check can settle (the
// command's own views report it): `unread` is the answer then.
function readStore({ env, say, ask, unread }) {
  try {
    const target = taskDb.getDbPath();
    if (!fs.existsSync(target)) return unread;
    const reader = new DatabaseSync(target, { readOnly: true });
    try {
      return ask(reader);
    } finally {
      reader.close();
    }
  } catch (err) {
    if (env.ATRIS_DEBUG) say(`held jobs: could not read the task list (${oneLine(err && err.message, 120)})`);
    return unread;
  }
}

// Whether any job is held, in any workspace: one plain question, with no call to git.
function anyJobHeld({ env, say }) {
  return readStore({ env, say, unread: false, ask: (reader) => Boolean(reader.prepare(ANY_HELD_JOB).get()) });
}

// Whether this workspace has a job held for a pull request: held (it has), none (it has not) or blocked (git could
// not tell which checkouts are linked to the workspace, in the time there was). The workspace's jobs include those
// held in checkouts linked to it, and telling them is a call to git, held to what is left of the eight seconds and
// ended outright if it does not answer. Not asked at all when no job is held anywhere (see anyJobHeld).
function workspaceHolds(workspace, { env, say, left }) {
  return readStore({
    env,
    say,
    unread: 'none',
    ask: (reader) => {
      const time = Math.floor(Math.min(GIT_MS, left()));
      if (time < LEAST_GIT_MS) return 'blocked';
      if (taskDb.lookUpLinkedWorktrees(workspace, { timeoutMs: time }).failed) return 'blocked';
      return taskDb.listTasks(reader, { workspaceRoot: workspace, status: 'review' }).some((row) => taskDb.heldPullRequestOf(row)) ? 'held' : 'none';
    },
  });
}

// Whether what gh did says it cannot be used for any pull request right now, as an outage the sweep stops on:
// it could not be launched at all (a file that cannot be run, no memory, a runner that threw, a wrapper that
// exits 126), it was stopped by a signal before it said anything, it is not signed in, or GitHub is not
// answering.
function troubleWith(heard) {
  if (!heard) return null;
  if (heard.error) {
    // Output past the buffer is a trouble with that one answer, not with gh. It comes first because the runner
    // ends gh with a signal then, too.
    return heard.error.code === 'ENOBUFS' ? null : { kind: 'gh_unusable', detail: 'gh could not be run, so nothing could be checked' };
  }
  // A gh with no exit status was ended by a signal, and with no error to say why it has told us nothing about the
  // pull request, as one that timed out has not: the run stops, and nothing is written down.
  if (heard.status === null) return { kind: 'gh_stopped', detail: 'gh was stopped before it answered, so nothing could be checked' };
  if (typeof heard.status !== 'number' || heard.status === 0) return null;
  if (heard.status === 126) return { kind: 'gh_unusable', detail: 'gh could not be run, so nothing could be checked' };
  const said = String(heard.stderr || '').slice(0, 4000);
  if (heard.status === 4 || SIGNED_OUT.test(said)) return { kind: 'not_signed_in', detail: 'gh is not signed in to GitHub, so nothing could be checked' };
  if (GITHUB_DOWN.test(said)) return { kind: 'github_down', detail: 'GitHub is not answering, so nothing could be checked' };
  return null;
}

// Whether what gh did is GitHub saying that there is no pull request with this number, the one the question was about:
// gh exited 1 and its whole error output, less the one line break at the end ("\n", or "\r\n"), is the message above
// for this number. Only that one break is let go: a space or a blank line in front, a second line break behind, spaces
// anywhere around the line make it some other reply. (The pattern's "$" is the very end of the text here, since it has
// no "m" flag, so it never lets go of a break in the middle.) GitHub has answered then, though not with a pull request
// state. With no number to check against (the question was not about one pull request) nothing is.
function saysNoSuchPullRequest(heard, number) {
  if (!heard || heard.status !== 1 || !Number.isSafeInteger(number) || number <= 0) return false;
  return String(heard.stderr || '').replace(/\r?\n$/, '') === noSuchPullRequestMessage(number);
}

// What the sweep asks of GitHub and of git, each held to its own limit and to what is left of the eight seconds,
// and each asked once for the whole run (the sweep is called job by job, and would ask again every time).
// It counts the readable answers GitHub gave (answered), which is half of what a run is written down for; the other
// half is that nothing failed. When the time is spent GitHub is not asked, and the sweep stops on that outage: it is no
// answer, it is not a failure, and it does not undo the answers before it. Blocked is the other kind of stop, for a gh
// or a git that cannot be used at all, on any question: that is a failure, and an answer before it does not save the run.
function limited({ run, now, began }) {
  let blocked = false;
  let answered = 0;
  let heard = null;
  const left = () => timeLeft(now, began);
  // Runs a command and keeps what it did. A runner that throws did not run the command.
  const listen = (command, args, options) => {
    try {
      heard = run(command, args, options) || {};
    } catch (error) {
      heard = { error };
    }
    return heard;
  };
  const asked = new Map();
  const askOnce = (key, ask) => {
    if (!asked.has(key)) asked.set(key, ask());
    return asked.get(key);
  };
  const github = (key, ask, number) => askOnce(key, () => {
    const time = left();
    if (time < LEAST_CALL_MS) return { outage: { kind: 'out_of_time', detail: 'the check ran out of time' } };
    heard = null;
    const answer = ask({ run: listen, timeoutMs: Math.floor(Math.min(CALL_MS, time)) });
    const trouble = answer.outage || (answer.unknown ? troubleWith(heard) : null);
    if (!trouble) {
      // A reply the sweep parsed into a pull request state, or GitHub saying there is no pull request with the number
      // the question was about. The default branch of a repository (askBranch) is neither, and is only asked after a
      // merge has been read and counted.
      if (answer.answer || (answer.unknown && saysNoSuchPullRequest(heard, number))) answered += 1;
      return answer;
    }
    blocked = true;
    return { outage: trouble };
  });
  return {
    // The number is the one in the link, which is the one gh is asked about and the only one it can name in its reply.
    ask: (url) => github(`pull request ${url}`, (options) => askGitHub(url, options), (pullRequestOfLink(url) || {}).number),
    askBranch: (repoLink) => github(`repository ${repoLink.toLowerCase()}`, (options) => askDefaultBranch(repoLink, options)),
    // Where the workspace came from. With too little time left git is not asked, and the job is left as it is.
    // A git that did not exit with 0 (it hung, could not be run, exited with an error, or was stopped
    // by a signal) has not answered, and says nothing about the origin, so the run stops.
    askOrigin: (root) => askOnce(`origin ${root}`, () => {
      const time = left();
      if (time < LEAST_GIT_MS) return null;
      heard = null;
      const origin = originRepoOf(root, { run: listen, timeoutMs: Math.floor(Math.min(GIT_MS, time)) });
      if (!heard || (!heard.error && heard.status === 0)) return origin;
      blocked = true;
      return null;
    }),
    blocked: () => blocked,
    answered: () => answered,
    left,
  };
}

// The pull request a job names, in words: "pull request 71", or "its pull request" when the row gives no number.
function pullRequestWords(pullRequest) {
  const number = pullRequest.number || (pullRequestOfLink(pullRequest.url) || {}).number;
  return number ? `pull request ${number}` : 'its pull request';
}

// One plain line for each job the sweep settled: what was done for the builder, the pull request, what happened.
function linesFor(report) {
  const lines = [];
  for (const result of report.results) {
    const named = pullRequestWords(result.pull_request);
    const builder = oneLine(result.builder, 60);
    if (result.action === 'landed') lines.push(`credited ${builder}: ${named} merged`);
    else if (result.action === 'released') lines.push(`released ${builder}: ${named} closed without merging`);
  }
  return lines;
}

// The workspace's held jobs, oldest first, one call of the sweep for each, and each job's line said as soon as
// that job is settled. A job the sweep throws on costs one short line and the run goes on to the next. A store
// that is busy ends the run (the error goes up to autoSweepHeld) with the lines already said standing.
// The task list is read once, before the first job, and nothing is numbered: the run's lines name the builder and the
// pull request, never a task number, and the sweep is called job by job. Each call is handed its job, read again by its
// id first, so that a job someone settled since is not asked about. Reading the list can take the time there was; then
// there is none to ask with, and nothing is asked, said or written down.
// Returns one word: ran (GitHub gave at least one readable answer, and nothing failed: running out of time after an
// answer is not a failure), blocked (gh, git or GitHub could not be used, on any question and whatever was answered
// before, or there was no time left to ask and nothing had been answered), failed (a job could not be settled) or idle
// (no readable answer came back and nothing stopped the run: the last held job was settled by someone else since the
// first look, no job had a link to ask about, or every reply was unreadable). Only a ran is written down (see sweep).
function checkJobs({ db, workspace, actor, limits, say }) {
  let failed = false;
  let outOfTime = false;
  const held = heldJobsAmong(taskDb, taskDb.listTasks(db, { workspaceRoot: workspace }));
  if (!held.length) return 'idle';
  if (limits.left() < LEAST_CALL_MS) return 'blocked';
  for (const job of held) {
    if (limits.blocked()) break;
    if (limits.left() < LEAST_CALL_MS) {
      outOfTime = true;
      break;
    }
    let report;
    try {
      const current = taskDb.getTask(db, job.id);
      report = sweepHeldJobs(taskDb, db, {
        workspaceRoot: workspace,
        actor,
        only: job.id,
        listing: current ? [current] : [],
        ask: limits.ask,
        askBranch: limits.askBranch,
        askOrigin: limits.askOrigin,
        // The run says nothing of a refusal, and the sweep's own way of naming the other job lists that job's
        // workspace, which can start git outside the eight seconds. The id is name enough.
        nameOf: (id) => String(id),
      });
    } catch (err) {
      if (taskDb.isBusyError(err)) throw err;
      failed = true;
      say(`held jobs: could not check ${oneLine(job.claimed_by, 60)}: ${pullRequestWords(taskDb.heldPullRequestOf(job))} (${oneLine(err && err.message, 100) || 'unknown error'})`);
      continue;
    }
    for (const line of linesFor(report)) say(line);
    // A question can find the time gone though the look above did not: the default branch is asked after the pull
    // request has been read.
    if (report.outage && report.outage.kind === 'out_of_time') {
      outOfTime = true;
      break;
    }
  }
  if (limits.blocked()) return 'blocked';
  if (failed) return 'failed';
  if (limits.answered() > 0) return 'ran';
  return outOfTime ? 'blocked' : 'idle';
}

// The check itself, on a connection to the task store of its own that waits about a second for other writers.
function check({ workspace, env, now, run, say, began }) {
  const db = taskDb.open(undefined, { shortWait: true });
  try {
    return checkJobs({ db, workspace, actor: actorOf(env), limits: limited({ run, now, began }), say });
  } finally {
    try { db.close(); } catch { /* nothing left to close */ }
  }
}

function sweep({ root, env, now, run, say }) {
  if (OFF.test(String(env.ATRIS_HELD_SWEEP || '').trim())) return 'off';
  const began = now();
  const workspace = taskDb.workspaceRoot(root);
  // One plain question first, about every workspace and with no call to git: with no job held anywhere, which is
  // the usual case, that is all.
  if (!anyJobHeld({ env, say })) return 'idle';
  const file = recordPath(workspace, env);
  if (ranRecently(file, now)) return 'recent';
  const here = workspaceHolds(workspace, { env, say, left: () => timeLeft(now, began) });
  if (here === 'blocked') return 'blocked';
  if (here === 'none') return 'idle';
  // A run that cannot be written down would start again with every command, so it does not start: the folder
  // for the record, which holds the lock too, is made first.
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lock = takeLock(file.replace(/\.json$/, '.lock'), now);
  if (!lock) return 'running';
  try {
    // A command that started with this one may have run the check in the time between the look above and the lock.
    if (ranRecently(file, now)) return 'recent';
    const outcome = check({ workspace, env, now, run, say, began });
    // The rule for the record, and the only one: a run is written down when GitHub gave at least one readable answer in
    // it and nothing in the run failed. Running out of time is not a failure.
    //   - A readable answer is a reply the sweep parsed into a pull request state (open, merged or closed), or GitHub
    //     saying in so many words that there is no pull request with the number asked about: gh's whole message
    //     "Could not resolve to a PullRequest with the number of N", for that very N, which it says only once the
    //     repository itself resolved. A 404, a repository gh cannot read, another number, the sentence inside a longer
    //     message and any other words are no answer. Answers are counted, not jobs or calls.
    //   - A failure is a gh or a git that could not be used (missing, could not be launched, killed, timed out, not
    //     signed in, GitHub not answering), on any question, the one about the default branch included; a task store that
    //     stayed busy; or a job that could not be settled. After a failure nothing is written down, even if GitHub had
    //     answered before it, because a prompt retry is what a real failure wants: nothing holds the retry off. What the
    //     run settled before it failed stays settled. A single reply that cannot be read (nothing, something that is not
    //     a pull request, too much, gh failing in some other way for that one job) is no failure of the run, only no
    //     answer, and the run goes on to the next job.
    //   - Using up the eight seconds is not a failure. Once an answer has come back, the time running out later still
    //     counts as a run, and the jobs not asked are left as they are. With no answer there is no run, and nothing is
    //     held off: no time was left to ask, every reply was unreadable, or the only jobs had no link.
    // Written before the lock is let go, so a run that takes the lock after this one finds the record.
    if (outcome === 'ran') writeRecord(file, workspace, now());
    return outcome;
  } finally {
    lock.release();
  }
}

// Runs the held-job sweep for the workspace the command is in, if it is due. Never throws. Returns what
// happened as one word: off, idle (no held job, or no readable answer from GitHub), recent (ran within the hour),
// running (another command has the check), blocked (gh, git or GitHub could not be used, there was no time left to
// ask, or the store stayed locked), ran (at least one readable answer and nothing failed: written down), or failed (a
// job could not be settled). `env`, `now`, `run` and `say` are for tests.
function autoSweepHeld({ root = process.cwd(), env = process.env, now = Date.now, run = spawnSync, say = writeLine } = {}) {
  try {
    return sweep({ root, env, now, run, say });
  } catch (err) {
    // A store that stays busy past its short wait is not worth a line: nothing is written down.
    if (taskDb.isBusyError(err)) return 'blocked';
    try { say(`held jobs: automatic check failed (${oneLine(err && err.message, 120) || 'unknown error'})`); } catch { /* the command goes on */ }
    return 'failed';
  }
}

module.exports = { autoSweepHeld };
