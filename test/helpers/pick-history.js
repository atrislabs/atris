'use strict';

// A scratch task store with a made-up history of plays, and a real git repository with a real remote, for the
// tests of the builder picker. Every play is written the way the rating reads it (the job's creation, a claim,
// then how the claim ended) at a time the test chooses, so the picker counts exactly what the rating counts.
// The claim itself goes through the real claim command (lib/task-db.js claimTask), so the job's title and tags at
// that moment are saved the way a real claim saves them; only its time is moved to the play's time. The store is
// the one ATRIS_TASKS_DB names for as long as the test runs; nothing else is touched.
//
// The folder the flights run from also becomes a small git repository whose origin is a real bare repository
// (kept inside the folder's own .git), because the picker counts a landing only when its commit is on origin's
// default branch. Every commit here is empty and carries a time the test chooses. A landed play names a new
// commit on the default branch, made 10 minutes after its claim, that exists on origin only: the folder has not
// fetched it, the way a merge that happened a minute ago has not been fetched. Unless the test says otherwise:
//   commit: undefined      that new commit
//   commit: '<hex>'        that commit, whatever it is (an old one, a made-up one, store.side())
//   commit: null           a landing with no commit at all
//   where: 'pull_request'  the commit sits only in the merged pull request
// historyStore(t, root, { git: false }) leaves the folder without git, and { origin: false } gives it a
// repository with no origin at all. store.main is the old commit every repository starts with (October 1, before
// any claim here), and store.sync() fetches origin, the way the flight does.
//
// A landed play can say who handed the work in (handIn: { by, builtWith }), the way a flight's hand-in does:
// handed_in_by is the engine that finished and built_with the others that ran an attempt. With separate: true the
// hand-in is its own earlier entry (a pull request left open), and a later entry records the merge. A job in
// another workspace of the same store is workspace: '<path>'. store.record(id, { commit, at }) adds a later landing
// record to a job that has one already, the way a later review pass records another commit.
//
// A job that has been through a play can be played again (job: '<id>'): it is opened again (reopen: true adds the
// reopened entry a person's reopen writes), claimed by whoever the play names, and ended the way the play says. took
// is how long after its claim a play ends (an hour unless the test says otherwise).
//
// A job can be changed between its creation and its claim (before: (id) => store.tag(id, ...)), and after its
// play, the way people retag, rename and backlog finished jobs. snapshot: false takes the job's saved title and
// tags off the claim, the way a claim made before they were saved looks.
//
// watchGit(t) puts a stand-in git first on the path that logs every question the picker asks (calls()), and what
// each was given (environments(): whether standard input was a terminal, GIT_TERMINAL_PROMPT, GIT_SSH_COMMAND).
// historyStore also points git at an empty settings file and clears the ssh variables, so a person's own git settings
// never reach these tests; a test that wants an ssh command sets it itself.

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tasks = require('../../lib/task-db');

const CLEAN_GIT = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_(DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|OBJECT_DIRECTORY|PREFIX)$/.test(key)));
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const MINUTE = 60000;
const HOUR = 3600000;
const OLD_WORK = Date.parse('2026-10-01T00:00:00Z');

function gitIn(dir, extra = {}) {
  return (...args) => execFileSync('git', [
    '-c', 'user.name=Picker Test', '-c', 'user.email=picker@test.invalid',
    '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args,
  ], { cwd: dir, env: { ...CLEAN_GIT, ...extra }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

// An empty commit made at `when` on top of `parents`, filed under `ref` when there is one. Returns its id.
function commitAt(dir, when, { parents = [], ref = null, message = 'work' } = {}) {
  const stamp = `${Math.floor(when / 1000)} +0000`;
  const git = gitIn(dir, { GIT_AUTHOR_DATE: stamp, GIT_COMMITTER_DATE: stamp });
  const id = git('commit-tree', EMPTY_TREE, ...parents.flatMap((parent) => ['-p', parent]), '-m', message);
  if (ref) git('update-ref', ref, id);
  return id;
}

// A repository in `root` with one old commit on its default branch. Unless `origin` is false, origin is a real
// bare repository that holds the same branch, and origin/HEAD says which branch is the default, the way
// `git remote set-head origin --auto` leaves it after a clone.
function repoIn(root, { branch = 'main', origin = true } = {}) {
  fs.mkdirSync(root, { recursive: true });
  const git = gitIn(root);
  git('init', '-q', '-b', branch);
  const main = commitAt(root, OLD_WORK, { ref: `refs/heads/${branch}`, message: 'work that landed' });
  const repo = { root, git, main, branch, origin, remote: null };
  if (origin) {
    repo.remote = path.join(root, '.git', 'scratch-origin.git');
    git('init', '-q', '--bare', '-b', branch, repo.remote);
    git('remote', 'add', 'origin', repo.remote);
    git('push', '-q', 'origin', branch);
    git('remote', 'set-head', 'origin', '--auto');
  }
  const ref = `refs/heads/${branch}`;
  // A new commit on the default branch, made at `when`. With an origin it is made there, and this folder does not
  // have it until it fetches. Without one it is a commit of the folder's own.
  repo.land = (when, message = 'work that landed') => {
    const dir = repo.remote || root;
    return commitAt(dir, when, { parents: [gitIn(dir)('rev-parse', ref)], ref, message });
  };
  // A new commit on the folder's own copy of the default branch only: not pushed, so not on origin.
  repo.unpushed = (when, message = 'work nobody pushed') => {
    const parent = git('rev-parse', ref);
    const head = git('symbolic-ref', '--short', 'HEAD');
    if (head !== branch) throw new Error('the default branch is not checked out');
    return commitAt(root, when, { parents: [parent], ref, message });
  };
  // A commit on a side branch of the folder's own that never reaches the default branch.
  repo.side = (when, message = 'work that never landed') => commitAt(root, when, { parents: [main], ref: 'refs/heads/side', message });
  // A pull request merged the way a hosting site does it: a merge commit on origin's default branch whose second
  // parent is the branch's own commit, made a minute before.
  repo.merged = (when, message = 'Merge pull request #7 from feature') => {
    const dir = repo.remote || root;
    const tip = gitIn(dir)('rev-parse', ref);
    const branchCommit = commitAt(dir, when - MINUTE, { parents: [tip], message: 'feature work' });
    const merge = commitAt(dir, when, { parents: [tip, branchCommit], ref, message });
    return { merge, branchCommit };
  };
  // Fetch origin's default branch into this folder, the way the flight does.
  repo.sync = () => { git('fetch', '-q', 'origin', branch); };
  return repo;
}

// Every git command run while the test is going, one line each, so a test can say what was asked and how often.
function watchGit(t) {
  const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-watch-'));
  const log = path.join(dir, 'calls.log');
  const envLog = path.join(dir, 'environments.log');
  // One line per call for the commands, and one for what each call was given: whether standard input is a terminal,
  // GIT_TERMINAL_PROMPT and GIT_SSH_COMMAND ("unset" when the call was not given it).
  const shim = [
    '#!/bin/sh',
    `printf '%s\\n' "$*" >> '${log}'`,
    'if [ -t 0 ]; then terminal=yes; else terminal=no; fi',
    `printf '%s\\t%s\\t%s\\t%s\\n' "$terminal" "\${GIT_TERMINAL_PROMPT-unset}" "\${GIT_SSH_COMMAND-unset}" "$*" >> '${envLog}'`,
    `exec '${real}' "$@"`,
    '',
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'git'), shim, { mode: 0o755 });
  const saved = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${saved}`;
  t.after(() => {
    process.env.PATH = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  // The flight asks git about a folder with -C <folder>; that part is left off so a line starts with the command.
  const lines = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((line) => line.replace(/^-C \S+ /, '')) : []);
  const environments = () => (fs.existsSync(envLog)
    ? fs.readFileSync(envLog, 'utf8').split('\n').filter(Boolean).map((row) => {
      const [terminal, prompt, ssh, ...rest] = row.split('\t');
      return { terminal: terminal === 'yes', prompt, ssh, line: rest.join('\t').replace(/^-C \S+ /, '') };
    })
    : []);
  return {
    calls: lines,
    // What each call was given: { line, terminal, prompt, ssh }.
    environments,
    // The commands that start with these words, e.g. startingWith('fetch').
    startingWith: (...words) => lines().filter((line) => words.some((word) => line === word || line.startsWith(`${word} `))),
    clear: () => { fs.rmSync(log, { force: true }); fs.rmSync(envLog, { force: true }); },
  };
}

function historyStore(t, root, { git: withGit = true, origin = true, branch = 'main' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'builder-pick-store-'));
  const dbPath = path.join(dir, 'tasks.db');
  const saved = process.env.ATRIS_TASKS_DB;
  process.env.ATRIS_TASKS_DB = dbPath;
  // A person's own git settings (a global ssh command, say) never reach these tests: git reads an empty settings file,
  // and no ssh command comes from the environment. A test that wants one sets it itself.
  fs.writeFileSync(path.join(dir, 'git-config'), '');
  const gitVars = { GIT_CONFIG_GLOBAL: path.join(dir, 'git-config'), GIT_CONFIG_NOSYSTEM: '1', GIT_SSH_COMMAND: undefined, GIT_SSH: undefined };
  const savedGit = Object.fromEntries(Object.keys(gitVars).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(gitVars)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  const db = tasks.open(dbPath);
  const workspace = tasks.workspaceRoot(root);
  const repo = withGit ? repoIn(root, { branch, origin }) : null;
  let seq = 0;
  const commits = new Map();
  const insertTask = db.prepare('INSERT INTO tasks (id, title, status, tag, workspace_root, created_at, updated_at, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const insertEvent = db.prepare('INSERT INTO task_events (event_id, task_id, version, workspace_root, actor, event_type, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  t.after(() => {
    tasks.close();
    if (saved === undefined) delete process.env.ATRIS_TASKS_DB; else process.env.ATRIS_TASKS_DB = saved;
    for (const [key, value] of Object.entries(savedGit)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const store = {
    db,
    dbPath,
    workspace,
    repo,
    // The old commit on the default branch that every repository starts with.
    main: repo ? repo.main : null,
    land: (...args) => repo.land(...args),
    unpushed: (...args) => repo.unpushed(...args),
    side: (...args) => repo.side(...args),
    merged: (...args) => repo.merged(...args),
    sync: () => repo.sync(),
    // Origin cannot be reached (its folder is gone), then is back.
    breakRemote: () => fs.renameSync(repo.remote, `${repo.remote}.gone`),
    restoreRemote: () => fs.renameSync(`${repo.remote}.gone`, repo.remote),
    // The ways origin's default branch goes missing.
    dropOriginHead: () => repo.git('symbolic-ref', '--delete', 'refs/remotes/origin/HEAD'),
    dangleOriginHead: () => repo.git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/gone'),
    removeOrigin: () => repo.git('remote', 'remove', 'origin'),
    // The commit a landed play named (or null), by the play's job id.
    commitOf: (id) => commits.get(id) || null,
    // One job and how its claim ended. The claim is at `at`; the ending an hour later.
    // outcome: landed | dropped | sent_back | held | could_not_start | claimed (still held)
    play({ member, outcome, at, tag = null, title = 'seeded job', metadata = {}, commit, where = 'landing', before = null, snapshot = true, workspace: inWorkspace = workspace, handIn = null, job = null, reopen = false, took = HOUR }) {
      seq += 1;
      const id = job || `seed-${seq}`;
      const known = job ? db.prepare('SELECT workspace_root FROM tasks WHERE id = ?').get(job) : null;
      if (job && !known) throw new Error(`there is no job ${job} to play again`);
      const room = known ? known.workspace_root : inWorkspace;
      let version = known ? db.prepare('SELECT MAX(version) AS v FROM task_events WHERE task_id = ?').get(id).v : 0;
      const add = (actor, type, payload, when) => {
        version += 1;
        insertEvent.run(`${id}-e${version}`, id, version, room, actor, type, JSON.stringify(payload), when);
      };
      if (!known) {
        insertTask.run(id, title, 'open', tag, room, at - HOUR, at - HOUR, JSON.stringify(metadata));
        add(null, 'created', { title, tag, status: 'open', source_key: null, metadata }, at - HOUR);
      } else if (reopen) {
        add('keshav', 'reopened', { previous_status: 'done', reason: 'reopened' }, at - MINUTE);
      }
      // Changes made before the claim go through the real task commands, which add their own events.
      if (before) before(id);
      // The claim is the real one. It stamps the time it happens, so its time is moved to the play's.
      const claim = tasks.claimTask(db, { id, claimedBy: member });
      if (!claim.claimed) throw new Error(`the claim did not apply: ${claim.reason}`);
      db.prepare('UPDATE task_events SET created_at = ? WHERE event_id = ?').run(at, claim.event.event_id);
      if (!snapshot) db.prepare("UPDATE task_events SET payload = json_remove(payload, '$.job_at_claim') WHERE event_id = ?").run(claim.event.event_id);
      if (outcome === 'claimed') db.prepare('UPDATE tasks SET claimed_at = ?, updated_at = ? WHERE id = ?').run(at, at + took, id);
      else db.prepare("UPDATE tasks SET status = 'open', claimed_by = NULL, claimed_at = NULL, updated_at = ? WHERE id = ?").run(at + took, id);
      version = db.prepare('SELECT MAX(version) AS v FROM task_events WHERE task_id = ?').get(id).v;
      const released = { released_by: member, previous_claimed_by: member };
      if (outcome === 'landed') {
        let sha = commit;
        if (sha === undefined) {
          // A landing names a commit made after the claim. Without git there is none, so it names a made-up one.
          sha = repo ? repo.land(at + 10 * MINUTE) : String(seq).padStart(2, '0').repeat(20);
        }
        if (sha) {
          commits.set(id, sha);
          const merged = { state: 'merged', merge_commit: sha, number: 100 + seq };
          const names = handIn ? {
            ...(handIn.by ? { handed_in_by: handIn.by } : {}),
            ...(handIn.builtWith && handIn.builtWith.length ? { built_with: handIn.builtWith } : {}),
          } : {};
          if (handIn && handIn.separate) {
            // The hand-in left a pull request open; a person merged it later, and the sweep wrote the merge down.
            add(handIn.by || member, 'proof_ready', { proof: 'built it', pull_request: { state: 'open', number: 100 + seq }, ...names }, at + took - 2 * MINUTE);
            add('autoland', 'completed', { status: 'done', action: 'merged', pull_request: merged, landed_at: new Date(at + took).toISOString() }, at + took);
          } else {
            add('autoland', 'proof_ready', {
              proof: 'built it',
              landing: where === 'pull_request' ? { happened: 'merged' } : { happened: 'merged', merge_commit: sha },
              pull_request: merged,
              self_landed: true,
              ...names,
            }, at + took);
          }
        } else {
          // A person accepted it and no merge was recorded: the rating counts it, there is no commit to check.
          add('autoland', 'completed', { action: 'merged' }, at + took);
        }
      } else if (outcome === 'dropped') add(member, 'claim_released', { ...released, reason: 'ran out of time' }, at + took);
      else if (outcome === 'held') add(member, 'claim_released', { ...released, kind: 'proof_not_saved', pull_request: { state: 'open', number: 9 } }, at + took);
      else if (outcome === 'could_not_start') add(member, 'claim_released', { ...released, kind: 'could_not_start' }, at + took);
      else if (outcome === 'sent_back') add('keshav', 'revision_requested', { note: 'again' }, at + took);
      return id;
    },
    // A later landing record for a job that has one already: another commit recorded in a later review pass (or the
    // same one again). It is a new entry on that job, in the job's workspace or another.
    record(id, { commit, at, type = 'proof_ready', workspace: there = workspace, actor = 'autoland', eventId } = {}) {
      const version = db.prepare('SELECT MAX(version) AS v FROM task_events WHERE task_id = ?').get(id).v + 1;
      const payload = type === 'completed'
        ? { status: 'done', action: 'merged', pull_request: { state: 'merged', merge_commit: commit } }
        : { proof: 'checked again', landing: { happened: 'merged', merge_commit: commit }, pull_request: { state: 'merged', merge_commit: commit } };
      insertEvent.run(eventId || `${id}-r${version}`, id, version, there, actor, type, JSON.stringify(payload), at);
    },
    // Many of one kind, a minute apart.
    plays(n, spec) {
      return Array.from({ length: n }, (_, i) => this.play({ ...spec, at: spec.at + i * MINUTE }));
    },

    // ---- changes made to a job after its play, the way people make them ----
    // `atris task tag`: a recorded change to the tag list.
    tag(id, { add = [], remove = [] }) {
      const done = tasks.tagTask(db, { id, actor: 'keshav', add, remove });
      if (!done.tagged) throw new Error(`tag did not apply: ${done.reason}`);
    },
    // `atris task retitle`: the new title, and a note that keeps the old one.
    retitle(id, title) {
      const row = tasks.getTask(db, id);
      db.prepare('UPDATE tasks SET title = ?, updated_at = ? WHERE id = ?').run(title, Math.max(Date.now(), Number(row.updated_at) + 1), id);
      tasks.noteTask(db, { id, actor: 'keshav', content: `previous title: ${row.title}` });
    },
    // Moving a planned job to the backlog: a recorded change to the tag.
    backlog(id, tag = 'capture') {
      const done = tasks.backlogTask(db, { id, actor: 'keshav', reason: 'clear_plan', tag });
      if (!done.backlogged) throw new Error(`backlog did not apply: ${done.reason}`);
    },
  };
  return store;
}

module.exports = { historyStore, repoIn, watchGit, commitAt, OLD_WORK };
