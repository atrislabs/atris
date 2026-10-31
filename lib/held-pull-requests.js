'use strict';

// Held jobs. A held job is work that is done and whose pull request waits for a person to land
// it: the job sits in Review under the builder's name with the pull request open on the row.
// When a person merges that pull request on GitHub, by any method, nothing in the task store
// hears about it, so the rating shows the job held forever and the builder is never credited.
// `atris task sweep --held` asks GitHub about each held job and writes down what happened.
//
//   merged:  the merge is recorded the way any landed merge is recorded, and the job closes as
//            done with the action "merged", which the rating counts as landed for the builder
//            who held the claim. A person's merge is the acceptance, so it is not a review
//            pass and it certifies nothing. The landing is dated at the merge, not at the
//            sweep, so a merge swept in late does not count as new.
//   closed:  the pull request is recorded as closed and the claim is released with the reason
//            "pull request closed without landing: <url>". The rating counts that as a miss,
//            and a person can still mark the job not needed.
//   open:    nothing changes.
//
// The link on a row is whatever a builder wrote there, so before it credits a merge or lets a
// claim go the sweep proves the pull request is this job's own build, from what GitHub itself
// says. It is in the repository the job's workspace came from (the owner and name in GitHub's
// own link equal those of the workspace's origin remote), and so is its head branch (a fork's
// branch is not this workspace's build). The head branch carries the job's row id as a whole
// word, and no other row id: that is how the flights name the branch they build on
// (flightTaskName in lib/fleet.js). No other job has the pull request: none already landed with
// it, and none still on the board also points at it, because two jobs cannot both be credited for
// one merge. And, for a merge, it was merged after the claim now on the job began, and into the
// repository's default branch (a merge into a feature branch has not landed). If any of that
// fails the job is refused: nothing is written, one plain line says why, and the sweep goes on to
// the next job. A merge with no usable merge time is not credited either. The sweep never looks
// at what is inside the pull request: a person merged it, and that person is the judge of that.
//
// GitHub is the only source, so anyone may run this, agents included: the run grants nothing
// of its own, it writes down what GitHub says. It works by row id, only on jobs in the
// workspace being swept (or every workspace when asked), and only while the row is still
// what it read: GitHub answers slowly, and a job someone settled in the meantime is left alone.
//
// One outage rule. When GitHub does not answer in time, or gh is not installed (it is not found,
// or a shim says "command not found" and exits 127), the run stops asking and changes nothing
// more. Any other failure leaves that one job unknown, and the rest are still checked.

const { spawnSync } = require('child_process');
const { pullRequestOfLink } = require('./pull-request-link');

// Per call. A hung gh must not hang the whole sweep.
const ASK_TIMEOUT_MS = 30000;
const FIELDS = 'state,mergeCommit,mergedAt,mergedBy,number,url,headRefName,headRepository,headRepositoryOwner,baseRefName';
const COMMIT = /^[0-9a-f]{7,64}$/i;
// How GitHub names a person or a bot: one word of letters, digits and a few marks.
const LOGIN = /^[A-Za-z0-9][A-Za-z0-9_.\-[\]/]{0,63}$/;
const STATES = { OPEN: 'open', MERGED: 'merged', CLOSED: 'closed' };
// One word of an owner or a repository name as GitHub writes them.
const REPO_WORD = /^[A-Za-z0-9_.-]+$/;
// The shape of a job's row id: 26 characters of the alphabet row ids are written in (digits and
// lower case letters, never i, l, o or u).
const ROW_ID_WORD = /^[0-9a-hjkmnp-tv-z]{26}$/;

const TITLE_MAX = 80;
const DETAIL_MAX = 200;

function oneLine(value, max) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, Math.max(0, max - 3)).trim()}...` : text;
}

function firstLine(value) {
  return String(value || '').split('\n').map((line) => line.trim()).find(Boolean) || '';
}

function secondsLabel(ms) {
  const seconds = ms / 1000;
  return `${seconds} ${seconds === 1 ? 'second' : 'seconds'}`;
}

// The owner and name, in lower case, of the repository a pull request link is in
// (https://<host>/<owner>/<name>/pull/<number>, however it is decorated), or null when it is not
// such a link.
function repoOfPullRequestLink(link) {
  const named = pullRequestOfLink(link);
  return named ? named.repo : null;
}

// The owner and name, in lower case, of a repository given as an owner and a name (the head
// repository GitHub reports for a branch), or null when either is missing or not a name.
function repoOfParts(owner, name) {
  const ownerText = typeof owner === 'string' ? owner.trim() : '';
  const nameText = typeof name === 'string' ? name.trim() : '';
  return REPO_WORD.test(ownerText) && REPO_WORD.test(nameText) ? `${ownerText}/${nameText}`.toLowerCase() : null;
}

// The owner and name, in lower case, of the repository a git remote points at, or null when it
// does not read as one: a web or ssh address (https://host/owner/name.git, ssh://git@host/owner/name,
// git@host:owner/name.git) with exactly an owner and a name after the host. The host is not
// compared, because an ssh alias in front of github.com is an ordinary way to name it.
function repoOfRemote(remote) {
  const text = String(remote || '').trim();
  const match = /^(?:https?|ssh|git):\/\/(?:[^@/\s]+@)?[^/:\s]+(?::\d+)?\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(text)
    || /^(?:[^@/\s]+@)?[^/:\s]+:([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(text);
  return match ? `${match[1]}/${match[2]}`.toLowerCase() : null;
}

// The row ids in a branch name: the words of it (split on anything that is not a letter or a
// digit, any case) that have the shape of a row id, in order.
function jobIdsIn(headRef) {
  return String(headRef || '').toLowerCase().split(/[^a-z0-9]+/).filter((word) => ROW_ID_WORD.test(word));
}

// Whether a pull request's head branch is this job's build: it carries exactly one row id as a whole
// word, and it is this job's. The case is ignored, so a hand-named branch with the id as the store
// spells it counts. Another job's id, or two ids (even this job's twice), say the branch is not one
// job's build, so it binds nothing. Only words the shape of a row id are ever counted, so a job whose
// own id is not that shape binds nothing either.
function branchNamesJob(headRef, rowId) {
  const id = String(rowId || '').trim().toLowerCase();
  const named = jobIdsIn(headRef);
  return named.length === 1 && named[0] === id;
}

// One call to gh, with its failures told apart the one way every question the sweep asks tells
// them apart. Exactly one of:
//   { stdout }   gh ran and exited 0
//   { outage }   GitHub did not answer in time, or gh is missing (not found, or a shim or wrapper
//                that cannot find it exits 127): the run stops asking
//   { unknown }  one plain sentence on why this one question could not be answered
function runGh(args, { run = spawnSync, timeoutMs = ASK_TIMEOUT_MS } = {}) {
  // gh is found on the PATH: a fixed path adds no boundary, since a process that can change the PATH can write the task store directly.
  const result = run('gh', args, {
    encoding: 'utf8',
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
    maxBuffer: 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  }) || {};
  if (result.error) {
    if (result.error.code === 'ETIMEDOUT') {
      return { outage: { kind: 'timeout', detail: `GitHub did not answer within ${secondsLabel(timeoutMs)}` } };
    }
    if (result.error.code === 'ENOENT') {
      return { outage: { kind: 'gh_missing', detail: 'gh is not installed or not on the PATH, so nothing could be checked' } };
    }
    return { unknown: oneLine(`gh did not run: ${firstLine(result.error.message)}`, DETAIL_MAX) };
  }
  if (result.status !== 0) {
    if (result.status === null) return { unknown: `gh did not finish${result.signal ? ` (${result.signal})` : ''}` };
    // 127 is "command not found": a shim or wrapper that cannot find gh is the same outage as no gh.
    if (result.status === 127) {
      return { outage: { kind: 'gh_missing', detail: 'gh is not installed or not on the PATH (it exited 127), so nothing could be checked' } };
    }
    const said = firstLine(result.stderr);
    return { unknown: said ? oneLine(`gh said: ${said}`, DETAIL_MAX) : `gh exited ${result.status}` };
  }
  return { stdout: String(result.stdout || '') };
}

// What gh printed, as a JSON object, or null when it is anything else.
function jsonObject(text) {
  let data = null;
  try { data = JSON.parse(text); } catch { data = null; }
  return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
}

// What GitHub says about one pull request, in the shape the sweep reads. Exactly one of:
//   { answer }   state is open, merged or closed, with the number, the link, the repository GitHub's
//                own link puts it in, its head branch and the repository that branch lives in, the
//                branch it went (or goes) to, and for a merge its commit, time and merger (null
//                where GitHub gave none or gave nonsense)
//   { outage }   GitHub did not answer in time, or gh is missing: stop asking
//   { unknown }  one plain sentence on why this one pull request could not be read
// `run` and `timeoutMs` are for tests.
function askGitHub(url, { run = spawnSync, timeoutMs = ASK_TIMEOUT_MS } = {}) {
  const ran = runGh(['pr', 'view', url, '--json', FIELDS], { run, timeoutMs });
  if (ran.outage || ran.unknown) return ran;
  const data = jsonObject(ran.stdout);
  if (!data) return { unknown: "GitHub's answer could not be read" };
  const number = Number(data.number);
  if (!Number.isInteger(number) || number <= 0) {
    return { unknown: "GitHub's answer could not be read: it names no pull request number" };
  }
  const rawState = String(data.state || '').trim();
  const state = STATES[rawState.toUpperCase()];
  if (!state) {
    return { unknown: oneLine(`GitHub's answer has a state it does not know (${rawState || 'none'})`, DETAIL_MAX) };
  }
  const commit = data.mergeCommit && typeof data.mergeCommit === 'object' ? String(data.mergeCommit.oid || '').trim() : '';
  const login = data.mergedBy && typeof data.mergedBy === 'object' ? String(data.mergedBy.login || '').trim() : '';
  const mergedAt = typeof data.mergedAt === 'string' ? data.mergedAt.trim() : '';
  const link = typeof data.url === 'string' ? data.url.trim() : '';
  const headRef = typeof data.headRefName === 'string' ? data.headRefName.trim() : '';
  const baseRef = typeof data.baseRefName === 'string' ? data.baseRefName.trim() : '';
  const headOwner = data.headRepositoryOwner && typeof data.headRepositoryOwner === 'object' ? data.headRepositoryOwner.login : null;
  const headName = data.headRepository && typeof data.headRepository === 'object' ? data.headRepository.name : null;
  return {
    answer: {
      state,
      number,
      url: /^https?:\/\//i.test(link) ? link : url,
      // The repository is read only from the link GitHub gave, never from the one that was asked.
      repo: repoOfPullRequestLink(link),
      // The repository the head branch lives in, which is not the pull request's own repository
      // when the branch is in a fork.
      head_repo: repoOfParts(headOwner, headName),
      base_ref: baseRef || null,
      head_ref: headRef || null,
      merge_commit: COMMIT.test(commit) ? commit : null,
      merged_at: mergedAt && Number.isFinite(Date.parse(mergedAt)) ? mergedAt : null,
      merged_by: LOGIN.test(login) ? login : null,
    },
  };
}

// The branch a repository lands on by default, for the link of the repository itself. Exactly one of:
//   { branch }   the default branch's name
//   { outage }   as for askGitHub: stop asking
//   { unknown }  one plain sentence on why it could not be read
// `run` and `timeoutMs` are for tests.
function askDefaultBranch(repoLink, { run = spawnSync, timeoutMs = ASK_TIMEOUT_MS } = {}) {
  const ran = runGh(['repo', 'view', repoLink, '--json', 'defaultBranchRef'], { run, timeoutMs });
  if (ran.outage || ran.unknown) return ran;
  const data = jsonObject(ran.stdout);
  if (!data) return { unknown: "GitHub's answer could not be read" };
  const ref = data.defaultBranchRef;
  const name = ref && typeof ref === 'object' && typeof ref.name === 'string' ? ref.name.trim() : '';
  if (!name) return { unknown: "GitHub's answer does not say which branch is the repository's default" };
  return { branch: name };
}

const NOT_ASKED = 'not asked, because the run stopped when GitHub could not be reached';

// The variables a hook or a parent git leaves behind that point git at some other repository.
const GIT_REPOSITORY_VARIABLES = [
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE', 'GIT_PREFIX',
];

// Which repository a workspace came from: the owner and name its origin remote points at, asked of
// git in the workspace's own folder. Null when git cannot say (no folder, no origin) or the remote
// does not read as a GitHub repository.
function originRepoOf(root, { run = spawnSync } = {}) {
  if (!root) return null;
  const env = { ...process.env };
  for (const key of GIT_REPOSITORY_VARIABLES) delete env[key];
  const done = run('git', ['-C', String(root), 'remote', 'get-url', 'origin'], {
    encoding: 'utf8',
    env,
    timeout: 10000,
    killSignal: 'SIGKILL',
    stdio: ['ignore', 'pipe', 'ignore'],
  }) || {};
  if (done.error || done.status !== 0) return null;
  return repoOfRemote(done.stdout);
}

// Why a pull request GitHub says is merged or closed is not this job's own build, in a plain
// phrase, or null when it is. The repository comes from GitHub's own link for the pull request
// and must be the one the workspace's origin remote points at, and so must the repository the
// head branch lives in (a fork's branch is not this workspace's build); the head branch must
// carry the job's row id, and no other.
function notBuildReason(row, answer, originRepo) {
  if (!originRepo) return "this workspace's origin remote could not be read as a GitHub repository";
  if (!answer.repo) return "GitHub's answer does not say which repository it is in";
  if (answer.repo !== originRepo) return `it is in ${answer.repo}, and this workspace's origin is ${originRepo}`;
  if (!answer.head_repo) return "GitHub's answer does not say which repository its branch is in";
  if (answer.head_repo !== originRepo) return `its branch is in ${answer.head_repo}, and this workspace's origin is ${originRepo}`;
  if (!branchNamesJob(answer.head_ref, row.id)) {
    const branch = answer.head_ref ? oneLine(answer.head_ref, DETAIL_MAX) : 'none given';
    return jobIdsIn(answer.head_ref).length > 1
      ? `its branch (${branch}) carries more than one job id`
      : `its branch (${branch}) does not carry this job's id`;
  }
  return null;
}

// Why a merge cannot be this job's current attempt, or null when it can: the claim now on the job
// began before the merge. A job reopened and claimed again must not be credited for a merge that
// happened before its new claim, and a missing claim time proves nothing.
function mergeBeforeClaimReason(row, answer) {
  const claimedAt = row.claimed_at == null ? NaN : Number(row.claimed_at);
  if (!Number.isFinite(claimedAt)) return 'this job has no claim time to compare the merge with';
  if (!(Date.parse(answer.merged_at) > claimedAt)) {
    return `it was merged at ${answer.merged_at}, not after this job's claim began at ${new Date(claimedAt).toISOString()}`;
  }
  return null;
}

// Why a store refused to settle a job the sweep had read, in a plain sentence.
function leftAloneDetail(reason) {
  if (reason === 'not_held') return 'it no longer waits on a pull request, so it was left alone';
  if (/^already_/.test(String(reason))) return `it is now ${String(reason).slice('already_'.length)}, so it was left alone`;
  return 'it changed while GitHub was being asked, so it was left alone';
}

// Check every held job against GitHub and, unless dryRun, write down what happened.
//
//   taskStore      lib/task-db
//   db             an open connection (read only is enough for a dry run)
//   workspaceRoot  the workspace being swept; null sweeps every workspace
//   actor          who ran the check; the events carry this name, never the builder's
//   ask            how to ask GitHub about a link (askGitHub); asked once per link per run
//   askBranch      how to ask GitHub for a repository's default branch (askDefaultBranch); asked
//                  once per repository per run, and only for a pull request that was merged
//
// Returns { ok, action, dry_run, scope, actor, outage, summary, results }. ok is false only on
// an outage. Each result is { task_id, ref, title, builder, workspace_root, pull_request,
// outcome, action, detail } where outcome is what GitHub said (merged, closed, open) or
// unknown or not_asked, and action is what was done: landed, released, would_land,
// would_release, none, left_alone, or refused (the pull request is not this job's build: nothing
// was written, and detail is the plain line saying why).
function sweepHeldJobs(taskStore, db, { workspaceRoot = null, actor, dryRun = false, ask = askGitHub, askBranch = askDefaultBranch } = {}) {
  if (!actor) throw new Error('actor required');
  const scope = workspaceRoot ? 'workspace' : 'everywhere';
  // No task list yet means nothing is held.
  const inScope = db ? taskStore.listTasks(db, { workspaceRoot: workspaceRoot || null }) : [];
  const held = inScope
    .filter((row) => row.status === 'review' && taskStore.heldPullRequestOf(row))
    .sort((a, b) => (Number(a.created_at || 0) - Number(b.created_at || 0)) || String(a.id).localeCompare(String(b.id)));
  const named = taskStore.withTaskDisplayRefs(held, inScope);

  // Each question goes to GitHub once per run, whatever the answer: a failure is not asked again.
  const answers = new Map();
  const askOnce = (url) => {
    if (!answers.has(url)) {
      let asked;
      try {
        asked = ask(url);
      } catch (err) {
        asked = { unknown: oneLine(`could not ask GitHub: ${firstLine(err && err.message) || 'unknown error'}`, DETAIL_MAX) };
      }
      answers.set(url, asked && typeof asked === 'object' ? asked : { unknown: "GitHub's answer could not be read" });
    }
    return answers.get(url);
  };
  const branches = new Map();
  const defaultBranchOf = (repoLink) => {
    const key = repoLink.toLowerCase();
    if (!branches.has(key)) {
      let asked;
      try {
        asked = askBranch(repoLink);
      } catch (err) {
        asked = { unknown: oneLine(`could not ask GitHub: ${firstLine(err && err.message) || 'unknown error'}`, DETAIL_MAX) };
      }
      branches.set(key, asked && typeof asked === 'object' ? asked : { unknown: "GitHub's answer could not be read" });
    }
    return branches.get(key);
  };

  // A workspace's origin is read once per run, and only if a pull request needs it.
  const origins = new Map();
  const originOf = (root) => {
    if (!origins.has(root)) origins.set(root, originRepoOf(root));
    return origins.get(root);
  };

  // The name a person reads for a job, in its own workspace's numbering.
  const refOfJob = (id) => {
    const task = taskStore.getTask(db, id);
    if (!task) return String(id);
    const [shown] = taskStore.withTaskDisplayRefs([task], taskStore.listTasks(db, { workspaceRoot: task.workspace_root || null }));
    return (shown && (shown.display_id || shown.legacy_ref || shown.id)) || String(id);
  };
  // Why this pull request is not this job's to settle, when another job has it.
  const takenReason = (taken, answer) => (taken.how === 'landed'
    ? `pull request ${answer.number} in ${answer.repo} already landed with ${refOfJob(taken.id)}`
    : `another job (${refOfJob(taken.id)}) still points at pull request ${answer.number} in ${answer.repo}`);

  let outage = null;
  const results = [];
  for (const row of named) {
    const pullRequest = taskStore.heldPullRequestOf(row);
    const result = {
      task_id: row.id,
      ref: row.display_id || row.legacy_ref || row.id,
      title: oneLine(row.title, TITLE_MAX),
      builder: row.claimed_by,
      workspace_root: row.workspace_root,
      pull_request: { number: pullRequest.number, url: pullRequest.url },
      outcome: 'unknown',
      action: 'none',
      detail: null,
    };
    results.push(result);
    if (outage) {
      result.outcome = 'not_asked';
      result.detail = NOT_ASKED;
      continue;
    }
    if (!pullRequest.url) {
      result.detail = `the job names pull request ${pullRequest.number} but no link, so there is nothing to ask`;
      continue;
    }
    const asked = askOnce(pullRequest.url);
    if (asked.outage) {
      outage = asked.outage;
      result.detail = outage.detail;
      continue;
    }
    if (!asked.answer) {
      result.detail = asked.unknown || "GitHub's answer could not be read";
      continue;
    }
    const answer = asked.answer;
    if (pullRequest.number && answer.number !== pullRequest.number) {
      result.detail = `GitHub answered for pull request ${answer.number}, not ${pullRequest.number}`;
      continue;
    }
    const expected = { updatedAt: row.updated_at, claimedBy: row.claimed_by, pullRequestUrl: pullRequest.url };
    if (answer.state === 'open') {
      result.outcome = 'open';
      continue;
    }
    // Merged or closed: before a merge is credited or a claim let go, the pull request must be
    // this job's own build. If it is not, nothing is written and the sweep goes on.
    result.outcome = answer.state;
    const refuse = (why) => {
      result.action = 'refused';
      result.detail = `${result.ref}'s recorded pull request is not this job's build: ${why}`;
    };
    const notBuild = notBuildReason(row, answer, originOf(row.workspace_root));
    if (notBuild) {
      refuse(notBuild);
      continue;
    }
    // The pull request this job would settle, in the words the store compares them by.
    const identity = { repo: answer.repo, number: answer.number };
    // The same question is asked of the store again inside the write, where nothing can slip in
    // between; this look lets a refusal made from the board alone skip the questions below.
    const takenBefore = () => taskStore.pullRequestTakenBy(db, { ...identity, exceptId: row.id });
    if (answer.state === 'merged') {
      if (!answer.merge_commit) {
        result.outcome = 'unknown';
        result.detail = `GitHub says pull request ${answer.number} is merged but gave no merge commit`;
        continue;
      }
      if (!answer.merged_at) {
        result.outcome = 'unknown';
        result.detail = `GitHub says pull request ${answer.number} is merged but gave no usable merge time`;
        continue;
      }
      const early = mergeBeforeClaimReason(row, answer);
      if (early) {
        refuse(early);
        continue;
      }
      const takenNow = takenBefore();
      if (takenNow) {
        refuse(takenReason(takenNow, answer));
        continue;
      }
      // A merge counts only on the repository's default branch. The default branch is asked of
      // GitHub once for each repository in the run, from the repository's own address.
      if (!answer.base_ref) {
        refuse("GitHub's answer does not say which branch it was merged into");
        continue;
      }
      const repository = pullRequestOfLink(answer.url);
      const defaults = repository ? defaultBranchOf(repository.repoLink) : { unknown: "GitHub's answer does not say which repository it is in" };
      if (defaults.outage) {
        outage = defaults.outage;
        result.outcome = 'unknown';
        result.detail = outage.detail;
        continue;
      }
      if (!defaults.branch) {
        result.outcome = 'unknown';
        result.detail = defaults.unknown || "GitHub's answer could not be read";
        continue;
      }
      if (answer.base_ref !== defaults.branch) {
        refuse(`it was merged into ${answer.base_ref}, not the repository's default branch ${defaults.branch}`);
        continue;
      }
      const sentence = `pull request ${answer.number} was merged${answer.merged_by ? ` by ${answer.merged_by}` : ''}`;
      if (dryRun) {
        result.action = 'would_land';
        result.detail = `${sentence}; ${row.claimed_by} would be credited`;
        continue;
      }
      const landed = taskStore.landHeldMerge(db, {
        id: row.id,
        actor,
        workspaceRoot: workspaceRoot || row.workspace_root,
        expected,
        pullRequest: identity,
        merge: {
          merge_commit: answer.merge_commit,
          number: answer.number,
          url: answer.url,
          merged_at: answer.merged_at,
          merged_by: answer.merged_by,
        },
        proof: sentence,
      });
      if (landed.landed) {
        result.action = 'landed';
        result.detail = `${sentence}; ${row.claimed_by} is credited`;
      } else if (landed.reason === 'pull_request_taken') {
        refuse(takenReason({ id: landed.taken_by, how: landed.taken_how }, answer));
      } else if (landed.reason === 'invalid_merge_record') {
        result.outcome = 'unknown';
        result.detail = `GitHub's merge commit for pull request ${answer.number} could not be used`;
      } else {
        result.action = 'left_alone';
        result.detail = leftAloneDetail(landed.reason);
      }
      continue;
    }
    // closed without merging, whatever branch it was aimed at
    const takenNow = takenBefore();
    if (takenNow) {
      refuse(takenReason(takenNow, answer));
      continue;
    }
    const reason = `pull request closed without landing: ${pullRequest.url}`;
    if (dryRun) {
      result.action = 'would_release';
      result.detail = reason;
      continue;
    }
    const released = taskStore.releaseClosedPullRequest(db, {
      id: row.id,
      actor,
      workspaceRoot: workspaceRoot || row.workspace_root,
      expected,
      pullRequest: identity,
      reason,
    });
    if (released.released) {
      result.action = 'released';
      result.detail = reason;
    } else if (released.reason === 'pull_request_taken') {
      refuse(takenReason({ id: released.taken_by, how: released.taken_how }, answer));
    } else {
      result.action = 'left_alone';
      result.detail = leftAloneDetail(released.reason);
    }
  }

  const count = (test) => results.filter(test).length;
  const summary = {
    checked: count((r) => r.outcome !== 'not_asked'),
    landed: count((r) => r.action === 'landed'),
    released: count((r) => r.action === 'released'),
    would_land: count((r) => r.action === 'would_land'),
    would_release: count((r) => r.action === 'would_release'),
    refused: count((r) => r.action === 'refused'),
    open: count((r) => r.outcome === 'open'),
    unknown: count((r) => r.outcome === 'unknown'),
    left_alone: count((r) => r.action === 'left_alone'),
    not_asked: count((r) => r.outcome === 'not_asked'),
  };
  return {
    ok: outage === null,
    action: 'sweep_held',
    dry_run: Boolean(dryRun),
    scope,
    actor,
    outage,
    summary,
    results,
  };
}

// The plain lines a person reads, one per job that moved or could not be read, then a count of
// the ones still open.
function describeHeldSweep(report) {
  if (!report.results.length) return ['no held jobs: nothing is waiting on an open pull request'];
  const lines = [`held jobs: ${report.summary.checked} checked against GitHub${report.dry_run ? ' (dry run, nothing written)' : ''}`];
  const verbs = {
    landed: 'landed',
    released: 'released',
    would_land: 'would land',
    would_release: 'would release',
    left_alone: 'left alone',
  };
  for (const result of report.results) {
    if (result.outcome === 'open') continue;
    // A refusal names the job and says why in one line of its own.
    if (result.action === 'refused') {
      lines.push(result.detail);
      continue;
    }
    const verb = verbs[result.action] || (result.outcome === 'not_asked' ? 'not asked' : 'could not check');
    lines.push(`${verb} ${result.ref} ${result.title}: ${result.detail}`);
  }
  if (report.summary.open) lines.push(`still open: ${report.summary.open}`);
  return lines;
}

module.exports = { ASK_TIMEOUT_MS, askGitHub, askDefaultBranch, branchNamesJob, originRepoOf, sweepHeldJobs, describeHeldSweep };
