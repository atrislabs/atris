'use strict';

// After an ignited member run ends with its check passing, hand the branch to
// GitHub auto-merge. Every local gate fails closed: the branch stays put and
// one plain line says which gate held it. GitHub then waits for the branch to
// be up to date and CI green; this never merges, rebases, or polls itself.
// The one exception is a project with no remote: there the branch merges into
// the main checkout's branch on this computer, past the same gates.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  deniedTagOf,
  declaredProtectedLane,
  sniffedProtectedLane,
} = require('./auto-accept-certified');
const { isDecisionHoldTag, isDecisionTask } = require('./task-decision');
const { inboxMapEdits } = require('./member-map-inbox');

// Git replacement refs can make a local check read different code than the
// commit that gets pushed; every git and gh call here ignores them.
function run(cmd, args, cwd, extraEnv = {}, { raw = false } = {}) {
  const env = { ...process.env, ...extraEnv, GIT_NO_REPLACE_OBJECTS: '1' };
  const res = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: 120000, env });
  const stdout = String(res.stdout || '');
  return {
    ok: res.status === 0,
    status: res.status,
    stdout: raw ? stdout : stdout.trim(),
    stderr: String(res.stderr || res.error?.message || '').trim(),
  };
}

// The policy lives in the main checkout, not the mission's worktree copy.
function mainCheckoutRoot(cwd) {
  const common = run('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd);
  if (!common.ok || !common.stdout) return null;
  return path.dirname(common.stdout);
}

function policyOn(cwd) {
  const root = mainCheckoutRoot(cwd);
  if (!root) return false;
  try {
    const policy = JSON.parse(fs.readFileSync(path.join(root, '.atris', 'policy', 'autoland.json'), 'utf8'));
    return Boolean(policy) && typeof policy === 'object' && policy.enabled === true;
  } catch {
    return false;
  }
}

const TAG_KEYS = new Set(['tag', 'tags', 'todo_tags', 'lane']);
const METADATA_DEPTH_LIMIT = 6;
const METADATA_TEXT_CAP = 64 * 1024;

// Every string anywhere in metadata, and the ones anywhere below a tag key.
// Metadata too deep or too large to read whole returns null, which holds.
function metadataStrings(metadata) {
  const texts = [];
  const tags = [];
  let size = 0;
  const walk = (value, depth, tagged) => {
    if (typeof value === 'string') {
      size += value.length;
      texts.push(value);
      if (tagged) tags.push(value);
      return size <= METADATA_TEXT_CAP;
    }
    if (!value || typeof value !== 'object') return true;
    if (depth >= METADATA_DEPTH_LIMIT) return false;
    if (Array.isArray(value)) return value.every((item) => walk(item, depth + 1, tagged));
    return Object.entries(value).every(([key, item]) => walk(item, depth + 1, tagged || TAG_KEYS.has(key)));
  };
  return walk(metadata, 0, false) ? { texts, tags } : null;
}

// A row's protected lane, or null. Tags are its own tag and lane, every
// string under a tag key anywhere in metadata, and '#tag' words in the title.
// Text is the title, objective, and every string in metadata.
function protectedLane(row) {
  if (!row || typeof row !== 'object') return 'unreadable';
  // Metadata is a plain object or absent; anything else, including stored
  // text that would not parse, cannot be checked.
  const meta = row.metadata;
  if (row.metadata_unreadable || (meta !== undefined && meta !== null && (typeof meta !== 'object' || Array.isArray(meta)))) {
    return 'metadata could not be read';
  }
  const found = metadataStrings(meta);
  if (!found) return 'metadata too large to check';
  const title = String(row.title || '');
  const tags = [
    row.tag,
    row.lane,
    ...(Array.isArray(row.tags) ? row.tags : []),
    ...found.tags,
    ...(title.match(/#[A-Za-z0-9_-]+/g) || []).map((t) => t.slice(1)),
  ];
  // Decision rows wait for a person; the same rule member go's picker uses.
  if (isDecisionTask(row)) return 'needs a human decision';
  for (const tag of tags) {
    const text = String(tag ?? '');
    if ([text, ...text.split(/[\s,]+/)].some(isDecisionHoldTag)) return 'needs a human decision';
    const denied = deniedTagOf({ tag: text });
    if (denied) return denied;
  }
  const objective = [title, typeof row.objective === 'string' ? row.objective : '', ...found.texts].filter(Boolean).join('\n');
  const view = { title, objective, metadata: {} };
  const declared = declaredProtectedLane(view);
  if (declared) return `declared "${declared.phrase}"`;
  const sniffed = sniffedProtectedLane(view);
  if (sniffed) return sniffed.lane;
  return null;
}

// Every task this mission points at, or null when a link is malformed.
function linkedTaskIds(mission) {
  const ids = [];
  if (mission.task_ids !== undefined) {
    if (!Array.isArray(mission.task_ids)) return null;
    for (const id of mission.task_ids) {
      if (typeof id !== 'string' || !id.trim()) return null;
      ids.push(id.trim());
    }
  }
  const xp = mission.xp_task;
  if (xp !== undefined && xp !== null && (typeof xp !== 'object' || Array.isArray(xp))) return null;
  for (const value of [mission.task_id, mission.task_ref, mission.current_task_id, xp?.task_id, xp?.ref]) {
    if (value === undefined || value === null || value === '') continue;
    if (typeof value !== 'string' || !value.trim()) return null;
    ids.push(value.trim());
  }
  return [...new Set(ids)];
}

function defaultLoadTask(id) {
  try {
    const taskDb = require('./task-db');
    return taskDb.getTask(taskDb.open(), id) || null;
  } catch {
    return null;
  }
}

const RECEIPT_STAMP_RE = /^\d{4}-\d{2}-\d{2}T[0-9-]+Z\.json$/;

// The newest run receipt this mission wrote in its own folder, or null.
function latestRunReceipt(missionId, cwd) {
  if (typeof missionId !== 'string' || !/^[A-Za-z0-9._-]+$/.test(missionId)) return null;
  const dir = path.join(cwd, 'atris', 'runs');
  const prefix = `mission-${missionId}-`;
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const latest = names
    .filter((name) => name.startsWith(prefix) && RECEIPT_STAMP_RE.test(name.slice(prefix.length)))
    .sort((a, b) => (a.slice(prefix.length) < b.slice(prefix.length) ? -1 : 1))
    .pop();
  if (!latest) return null;
  try {
    const receipt = JSON.parse(fs.readFileSync(path.join(dir, latest), 'utf8'));
    if (!receipt || typeof receipt !== 'object' || receipt.mission_id !== missionId) return null;
    return receipt;
  } catch {
    return null;
  }
}

// Review must cover the final code of the final run. The newest receipt for
// this mission must be a finished run's summary, recorded on a clean folder
// whose code tree is the one checked out now, with nothing newer in the
// mission's own state and no commit made after it. Every tick in that run
// must have passed its check and a verdict from a reviewer engine other than
// the member and every engine that did the work.
function reviewHold(mission, workerEngine, cwd, pin = {}) {
  const receipt = latestRunReceipt(mission.id, cwd);
  if (!receipt) return 'no run receipt for this mission could be read';
  const result = receipt.result && typeof receipt.result === 'object' ? receipt.result : {};
  if (result.kind !== 'mission_run_summary') return 'the latest run has not finished';
  const receiptAt = Date.parse(receipt.at || '');
  if (!Number.isFinite(receiptAt)) return 'the latest run receipt has no time';
  if (receipt.clean !== true) return 'the latest run ended with unsaved changes';
  const head = run('git', ['rev-parse', 'HEAD^{tree}'], cwd);
  if (!head.ok || !head.stdout || receipt.git_tree !== head.stdout) {
    return 'the latest review was not recorded on the code that is checked out now';
  }
  const commitTime = run('git', ['log', '-1', '--format=%ct', 'HEAD'], cwd);
  const committedAt = Number(commitTime.stdout) * 1000;
  if (!commitTime.ok || !Number.isFinite(committedAt) || committedAt <= 0 || committedAt > receiptAt) {
    return 'the code was committed after the latest review';
  }

  const ticks = Array.isArray(result.ticks) ? result.ticks : [];
  if (!ticks.length || result.tick_count !== ticks.length) return 'no reviewed work is recorded on the latest run';
  const lastTick = ticks[ticks.length - 1] || {};
  const lastTickAt = Date.parse(mission.last_tick_at || '');
  if (!Number.isFinite(lastTickAt) || lastTickAt > receiptAt) return 'the mission ran again after the latest receipt';
  if (mission.last_tick_status !== 'ran') return 'the mission\'s last step did not finish cleanly';
  if (mission.last_tick_index !== undefined && mission.last_tick_index !== lastTick.tick_index) {
    return 'the mission ran again after the latest receipt';
  }

  const worker = String(workerEngine || mission.runner || '').trim().toLowerCase();
  if (!worker || worker === 'auto') return 'the engine that did the work is unknown';
  const self = new Set([mission.owner, worker, ...ticks.map((tick) => tick && tick.engine_id)]
    .map((v) => String(v || '').trim().toLowerCase()).filter(Boolean));
  for (const tick of ticks) {
    if (!tick || typeof tick !== 'object' || tick.status !== 'ran' || tick.verifier_passed !== true) {
      return 'a step on the latest run did not pass its check';
    }
    const referee = tick.referee_result;
    if (!referee || typeof referee !== 'object' || referee.mode !== 'engine' || referee.passed !== true) {
      return 'a reviewer on the latest run did not pass it';
    }
    const reviewer = String(referee.engine || '').trim().toLowerCase();
    if (!reviewer || self.has(reviewer)) return 'the latest run was reviewed by the same engine that did the work';
  }
  if (lastTick.reviewed_git_tree !== head.stdout) return 'the review did not see the code that is checked out now';
  pin.tree = head.stdout;
  return null;
}

// The checked-out code as git sees it with config tricks switched off: every
// untracked file listed, submodules compared, no file monitor, and no index
// entry marked assume-unchanged or skip-worktree (anything but an 'H' tag).
function gitCodeState(cwd) {
  const status = run('git', [
    '-c', 'status.showUntrackedFiles=all', '-c', 'core.fsmonitor=false',
    'status', '--porcelain', '--untracked-files=all', '--ignore-submodules=none',
  ], cwd);
  const index = run('git', ['-c', 'core.fsmonitor=false', 'ls-files', '-v'], cwd);
  const hidden = !index.ok || index.stdout.split('\n').some((line) => line && !line.startsWith('H '));
  const tree = run('git', ['rev-parse', 'HEAD^{tree}'], cwd);
  return {
    clean: status.ok && !status.stdout && !hidden,
    hidden,
    status: status.ok ? status.stdout : null,
    tree: tree.ok && tree.stdout ? tree.stdout : null,
  };
}

// New files Atris writes for itself while a run is going (receipts, state,
// logs). Changed tracked files always count.
const BOOKKEEPING = /^\?\? (?:\.atris\/|atris\/(?:runs|status|logs)\/|atris\/team\/[^/]+\/logs\/)/;

function codeStatus(state) {
  if (!state || state.status == null) return null;
  return state.status.split('\n').filter((line) => line && !BOOKKEEPING.test(line)).join('\n');
}

function unsavedHold(cwd) {
  if (!gitCodeState(cwd).clean) return 'unsaved changes; the check may not match what would merge';
  return null;
}

// Files where every side only adds lines: map files, the map notes file, and
// member logs. A clash in these keeps both sides' lines instead of holding.
const MAP_FILE = /(?:^|\/)MAP(?:-NOTES)?\.md$|^atris\/team\/[^/]+\/logs\/[^/]+\.md$/;

// Keep both sides' lines of one clashing map file, as a stored blob. A file
// both sides created, like the same day's member log, merges against empty.
function unionMapBlob(file, mergeBase, ours, theirs, cwd, tmp) {
  const sides = [];
  for (const [name, rev] of [['base', mergeBase], ['ours', ours], ['theirs', theirs]]) {
    const blob = run('git', ['cat-file', 'blob', `${rev}:${file}`], cwd, {}, { raw: true });
    if (!blob.ok && name !== 'base') return null;
    const out = path.join(tmp, name);
    fs.writeFileSync(out, blob.ok ? blob.stdout : '');
    sides.push(out);
  }
  const merged = run('git', ['merge-file', '-p', '--union', sides[1], sides[0], sides[2]], cwd, {}, { raw: true });
  if (!merged.ok) return null;
  const out = path.join(tmp, 'merged');
  fs.writeFileSync(out, merged.stdout);
  const blob = run('git', ['hash-object', '-w', out], cwd);
  return blob.ok && /^[0-9a-f]{40,64}$/.test(blob.stdout) ? blob.stdout : null;
}

// Merge the main branch into the reviewed commit without touching the
// checkout. Edits to the shared map files first move to the map inbox in a
// commit on top of the reviewed commit, so they never clash. A clean merge
// pushes that commit as is. When every clash is a map file or member log, both
// sides' lines are kept and a merge commit is pushed instead, so GitHub has
// nothing left to resolve. Any other clash holds. With catchUp, a clean merge
// against a main branch that moved also becomes a merge commit, so the branch
// is up to date. With localBase, the main branch is the local one and nothing
// is fetched.
function mergeWithBase(reviewedSha, base, branch, cwd, { catchUp = false, localBase = false } = {}) {
  const baseRef = localBase ? `refs/heads/${base}` : `refs/remotes/origin/${base}`;
  if (!localBase) {
    const fetched = run('git', ['fetch', '-q', 'origin', `+refs/heads/${base}:${baseRef}`], cwd);
    if (!fetched.ok) return { hold: `the main branch could not be fetched (${fetched.stderr.split('\n')[0]})` };
  }
  const baseRead = run('git', ['rev-parse', baseRef], cwd);
  const baseSha = baseRead.ok ? baseRead.stdout : '';
  if (!/^[0-9a-f]{40,64}$/.test(baseSha)) return { hold: 'the main branch could not be read' };
  const inboxed = inboxMapEdits({ headSha: reviewedSha, baseSha, branch, cwd });
  if (inboxed.hold) return { hold: inboxed.hold };
  const headSha = inboxed.sha;
  const mapInboxed = inboxed.moved;
  const tree = run('git', ['merge-tree', '--write-tree', '--name-only', headSha, baseSha], cwd);
  if (tree.status === 0) {
    if (!catchUp) return { sha: headSha, mapInboxed };
    if (headSha === reviewedSha && run('git', ['merge-base', '--is-ancestor', baseSha, headSha], cwd).ok) {
      return { sha: headSha, current: true };
    }
    const commit = run('git', [
      'commit-tree', tree.stdout.split(/\r?\n/)[0], '-p', headSha, '-p', baseSha,
      '-m', `Merge ${base} into ${branch} to catch up`,
    ], cwd);
    if (!commit.ok || !/^[0-9a-f]{40,64}$/.test(commit.stdout)) return { hold: 'the catch-up merge could not be saved' };
    return { sha: commit.stdout, mapInboxed };
  }
  if (tree.status !== 1) return { hold: 'the branch could not be compared with the main branch' };
  const [treeId, ...files] = tree.stdout.split(/\r?\n\r?\n/)[0].split(/\r?\n/).filter(Boolean);
  const clashes = files.filter((file) => !MAP_FILE.test(file));
  if (!files.length || clashes.length) {
    return { hold: `the branch clashes with the main branch in ${(clashes.length ? clashes : ['unknown files']).join(', ')}` };
  }
  const bases = run('git', ['merge-base', '--all', headSha, baseSha], cwd);
  const mergeBase = bases.ok ? bases.stdout.split('\n').filter(Boolean) : [];
  if (mergeBase.length !== 1) return { hold: 'the branch and the main branch share no single starting point' };

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-map-merge-'));
  try {
    const index = { GIT_INDEX_FILE: path.join(tmp, 'index') };
    if (!run('git', ['read-tree', treeId], cwd, index).ok) return { hold: 'the merged map could not be built' };
    for (const file of files) {
      const blob = unionMapBlob(file, mergeBase[0], headSha, baseSha, cwd, tmp);
      const mode = (run('git', ['ls-tree', headSha, '--', file], cwd).stdout.match(/^(\d{6}) blob /) || [])[1];
      if (!blob || !mode) return { hold: `the map file ${file} could not be merged line by line` };
      if (!run('git', ['update-index', '--cacheinfo', `${mode},${blob},${file}`], cwd, index).ok) {
        return { hold: 'the merged map could not be built' };
      }
    }
    const merged = run('git', ['write-tree'], cwd, index);
    if (!merged.ok) return { hold: 'the merged map could not be built' };
    const commit = run('git', [
      'commit-tree', merged.stdout, '-p', headSha, '-p', baseSha,
      '-m', `Merge ${base} into ${branch}, keeping map lines from both sides`,
    ], cwd);
    if (!commit.ok || !/^[0-9a-f]{40,64}$/.test(commit.stdout)) return { hold: 'the map merge could not be saved' };
    return { sha: commit.stdout, mapMerged: files, mapInboxed };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// Every branch autoland handed to GitHub, so a sweep can tell when GitHub
// dropped one. Lives in the main checkout beside the policy.
function queueFile(cwd) {
  const root = mainCheckoutRoot(cwd);
  return root ? path.join(root, '.atris', 'state', 'autoland-queue.json') : null;
}

function readQueue(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (data && typeof data.entries === 'object' && !Array.isArray(data.entries)) return data.entries;
  } catch {}
  return {};
}

function writeQueue(file, entries) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ schema: 'atris.autoland_queue.v1', entries }, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

function recordQueued(cwd, entry) {
  const file = queueFile(cwd);
  if (!file) return;
  try {
    const entries = readQueue(file);
    entries[entry.branch] = entry;
    writeQueue(file, entries);
  } catch {}
}

function held(gate, line) {
  return { merged: false, auto_merge: false, gate, line: `left the branch for you: ${line}` };
}

function hasOrigin(cwd) {
  return run('git', ['remote', 'get-url', 'origin'], cwd).ok;
}

// The branch the main checkout is on, or '' when it is not on one.
function mainCheckoutBranch(cwd) {
  const root = mainCheckoutRoot(cwd);
  const read = root ? run('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], root) : null;
  return read?.ok ? read.stdout : '';
}

// Where a finished run's work goes, as one plain line for the start of a run.
function landingDestination(cwd) {
  if (!policyOn(cwd)) return 'finished work stays on its own branch for you; self-landing is off';
  if (!hasOrigin(cwd)) {
    const base = mainCheckoutBranch(cwd);
    return `finished work merges into ${base || 'the main branch'} on this computer once its check and review pass`;
  }
  return 'finished work goes to GitHub as a pull request that merges itself once checks pass';
}

// A project with no remote has no GitHub to hand the branch to, so the main
// checkout's own branch is the target. The reviewed commit catches up with it
// without touching any checkout, then the main checkout fast-forwards to that
// commit, which refuses rather than overwrite anything there.
function landLocally({ headSha, branch, cwd, pinnedTree }) {
  const root = mainCheckoutRoot(cwd);
  const base = mainCheckoutBranch(cwd);
  if (!root || !base) return held('base', 'the main checkout is not on a branch');
  if (base === branch) return held('branch', 'the work is not on its own branch');
  const mainState = gitCodeState(root);
  if (mainState.hidden || codeStatus(mainState) !== '') {
    return held('unsaved', 'the main checkout has unsaved changes; merging there could mix them in');
  }
  const landing = mergeWithBase(headSha, base, branch, cwd, { catchUp: true, localBase: true });
  if (landing.hold) return held('conflict', landing.hold);
  if (!pinnedTree()) return held('review', 'the reviewed commit no longer holds the reviewed code');
  const forward = run('git', ['merge', '--ff-only', '-q', landing.sha], root);
  if (!forward.ok) return held('merge', `the main checkout could not move forward (${forward.stderr.split('\n')[0]})`);
  const mapNote = landing.mapInboxed?.length ? ' (map edits saved to the map inbox)'
    : landing.mapMerged ? ' (map lines from both sides kept)' : '';
  return {
    merged: true,
    auto_merge: false,
    local: true,
    gate: null,
    base,
    landed: landing.sha,
    map_merged: landing.mapMerged || [],
    map_inboxed: landing.mapInboxed || [],
    line: `merged into ${base} on this computer${mapNote}; this project has no GitHub remote`,
  };
}

// closeTaskIds: jobs taken off the list for this run. They only ride along
// so the sweep can close them once the change merges; unlike the mission's
// own linked tasks they do not gate the landing.
function autolandMemberRun({ mission, cwd, summary = '', workerEngine = '', loadTask = defaultLoadTask, closeTaskIds = [] } = {}) {
  if (!mission || typeof mission !== 'object') return held('mission', 'the mission could not be read');
  if (mission.verifier_result?.passed !== true) return held('check', 'the check did not pass');
  if (!policyOn(cwd)) return held('policy', 'self-landing is not switched on in the main checkout');

  const missionLane = protectedLane({ ...mission, title: mission.objective });
  if (missionLane) return held('protected', `this mission sits in a protected area (${missionLane})`);
  const taskIds = linkedTaskIds(mission);
  if (!taskIds) return held('protected', 'the mission\'s linked tasks are not a clean list of ids');
  for (const id of taskIds) {
    let task = null;
    try {
      task = loadTask(id, cwd);
    } catch {
      task = null;
    }
    if (!task || typeof task !== 'object') return held('protected', `a linked task (${id}) could not be read`);
    const lane = protectedLane(task);
    if (lane) return held('protected', `a linked task sits in a protected area (${lane})`);
    // A passing run cannot override a person's send-back. Read the current
    // task, not historical events: submitting fresh proof resets it to pending.
    const approvals = [task.review?.approval_status, task.metadata?.approval_status];
    if (approvals.some((value) => ['revise', 'revised', 'rejected'].includes(String(value || '').trim().toLowerCase()))) {
      return held('approval', 'a linked task was turned down; it needs fresh proof before it can go to github');
    }
  }

  const unsaved = unsavedHold(cwd);
  if (unsaved) return held('unsaved', unsaved);
  const pin = {};
  const reviewGap = reviewHold(mission, workerEngine, cwd, pin);
  if (reviewGap) return held('review', reviewGap);
  // Pin the commit the review passed on. Only this commit (or a map-only
  // merge built on it) is pushed and merged, so a commit made after this
  // point never rides along.
  const headRead = run('git', ['rev-parse', 'HEAD'], cwd);
  const headSha = headRead.ok ? headRead.stdout : '';
  if (!/^[0-9a-f]{40,64}$/.test(headSha)) return held('branch', 'the latest commit could not be read');
  const pinnedTree = () => {
    const tree = run('git', ['rev-parse', `${headSha}^{tree}`], cwd);
    return tree.ok && tree.stdout === pin.tree;
  };
  if (!pin.tree || !pinnedTree()) return held('review', 'the code moved while the review was being checked');

  const branchRead = run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  const branch = String(mission.worktree?.branch || branchRead.stdout || '').trim();
  if (!branch || branch === 'HEAD' || branch === 'master' || branch === 'main') {
    return held('branch', 'the work is not on its own branch');
  }
  if (!hasOrigin(cwd)) return landLocally({ headSha, branch, cwd, pinnedTree });
  const remoteHead =run('git', ['ls-remote', '--symref', 'origin', 'HEAD'], cwd);
  const base = (remoteHead.stdout.match(/^ref: refs\/heads\/(\S+)\s+HEAD$/m) || [])[1] || '';
  if (!remoteHead.ok || !base) return held('base', 'the main branch on GitHub could not be read');
  if (branch === base) return held('branch', 'the work is not on its own branch');

  const landing = mergeWithBase(headSha, base, branch, cwd);
  if (landing.hold) return held('conflict', landing.hold);
  const pushSha = landing.sha;

  if (!pinnedTree()) return held('review', 'the reviewed commit no longer holds the reviewed code');
  const push = run('git', ['push', 'origin', `${pushSha}:refs/heads/${branch}`], cwd);
  if (!push.ok) return held('push', `the branch could not be pushed (${push.stderr.split('\n')[0]})`);

  // Find the open pull request from exactly this branch into the main
  // branch, or open one. Merge is always addressed by number, never by a
  // branch name gh might read as a number, and pinned to the pushed commit.
  const listed = run('gh', [
    'pr', 'list', '--head', branch, '--base', base, '--state', 'open',
    '--json', 'number,headRefName,baseRefName,headRefOid,isCrossRepository',
  ], cwd);
  if (!listed.ok) return held('pull request', `open pull requests could not be read (${listed.stderr.split('\n')[0]})`);
  let rows;
  try {
    rows = JSON.parse(listed.stdout || '[]');
  } catch {
    rows = null;
  }
  if (!Array.isArray(rows)) return held('pull request', 'open pull requests could not be read');
  const matches = rows.filter((pr) => pr && pr.headRefName === branch && pr.baseRefName === base
    && pr.isCrossRepository === false && Number.isInteger(pr.number) && pr.number > 0);
  if (matches.length > 1) return held('pull request', 'more than one pull request is open for this branch');
  let number = matches.length ? matches[0].number : 0;
  let url = '';
  if (!number) {
    const title = String(mission.objective || branch).replace(/\s+/g, ' ').trim().slice(0, 70);
    const body = String(summary || '').trim() || `Receipt: ${mission.receipt_path || 'none recorded'}`;
    const created = run('gh', ['pr', 'create', '--head', branch, '--base', base, '--title', title, '--body', body], cwd);
    url = created.ok ? created.stdout.split('\n').pop().trim() : '';
    number = Number((url.match(/\/pull\/(\d+)$/) || [])[1] || 0);
    if (!created.ok || !number) {
      return held('pull request', `the pull request could not be opened (${(created.stderr || url).split('\n')[0]})`);
    }
  }
  const label = url || `pull request #${number}`;

  const merge = run('gh', ['pr', 'merge', String(number), '--auto', '--merge', '--match-head-commit', pushSha], cwd);
  if (!merge.ok) return held('auto-merge', `auto-merge could not be switched on for ${label}`);
  recordQueued(cwd, {
    branch, base, number, pushed: pushSha, mission_id: mission.id || null,
    task_ids: [...new Set([...taskIds, ...(Array.isArray(closeTaskIds) ? closeTaskIds : [])
      .filter((id) => typeof id === 'string' && id.trim()).map((id) => id.trim())])],
    requeues: 0, queued_at: new Date().toISOString(),
  });
  const mapNote = landing.mapInboxed?.length ? ' (map edits saved to the map inbox)'
    : landing.mapMerged ? ' (map lines from both sides kept)' : '';
  return {
    merged: false,
    auto_merge: true,
    gate: null,
    url: label,
    pushed: pushSha,
    map_merged: landing.mapMerged || [],
    map_inboxed: landing.mapInboxed || [],
    line: `merges on its own once checks pass${mapNote}: ${label}`,
  };
}

const MAX_REQUEUES = 3;

// One queued branch: leave it, forget it, or catch it up and queue it again.
// Only the exact commit autoland queued (or its own catch-up) is re-queued; a
// push by anyone else, a closed pull request, or a real clash leaves it.
// GitHub keeps auto-merge on when master moves under a queued branch and the
// two clash, so a clashing branch is caught up even while still queued.
function requeueOne(entry, cwd, maxRequeues) {
  const { branch, base, number } = entry;
  const label = `pull request #${number} (${branch})`;
  const keep = (state, line) => ({ branch, number, state, keep: true, line: `${label}: ${line}` });
  const forget = (state, line) => ({ branch, number, state, keep: false, line: `${label}: ${line}` });
  const viewed = run('gh', ['pr', 'view', String(number), '--json',
    'number,state,headRefName,baseRefName,headRefOid,isCrossRepository,autoMergeRequest,mergeable'], cwd);
  let pr = null;
  try {
    pr = viewed.ok ? JSON.parse(viewed.stdout) : null;
  } catch {
    pr = null;
  }
  if (!pr || typeof pr !== 'object') return keep('unreadable', 'github could not be read; will look again');
  // Only the commit autoland pushed counts as the member's own change; a merge
  // that carried someone else's push leaves the job for a person.
  if (pr.state === 'MERGED') {
    if (pr.headRefOid !== entry.pushed) return forget('merged', 'merged with commits someone else pushed; its job is left for you');
    return { ...forget('merged', 'merged'), own: true };
  }
  if (pr.state !== 'OPEN') return forget('closed', 'closed by someone; left alone');
  if (pr.headRefName !== branch || pr.baseRefName !== base || pr.isCrossRepository !== false) {
    return forget('moved', 'no longer points from this branch into the main branch; left for you');
  }
  if (pr.autoMergeRequest && pr.mergeable !== 'CONFLICTING') return keep('queued', 'still queued');
  if (pr.headRefOid !== entry.pushed) return forget('changed', 'someone pushed to it after it was queued; left for you');
  if ((Number(entry.requeues) || 0) >= maxRequeues) {
    return forget('gave-up', `dropped again after ${maxRequeues} catch-ups; left for you`);
  }
  const fetched = run('git', ['fetch', '-q', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`], cwd);
  const remote = run('git', ['rev-parse', `refs/remotes/origin/${branch}`], cwd);
  if (!fetched.ok || !remote.ok || remote.stdout !== entry.pushed) {
    return keep('unreadable', 'the branch on github could not be read; will look again');
  }
  const landing = mergeWithBase(entry.pushed, base, branch, cwd, { catchUp: true });
  if (landing.hold) return forget('clash', `${landing.hold}; left for you`);
  if (!landing.current) {
    const push = run('git', ['push', 'origin', `${landing.sha}:refs/heads/${branch}`], cwd);
    if (!push.ok) return keep('push', `the catch-up could not be pushed (${push.stderr.split('\n')[0]})`);
  }
  const merge = run('gh', ['pr', 'merge', String(number), '--auto', '--merge', '--match-head-commit', landing.sha], cwd);
  // The catch-up may already be on github; carry it so the next look does not
  // mistake our own push for someone else's.
  if (!merge.ok) return { ...keep('auto-merge', 'auto-merge could not be switched back on; will look again'), pushed: landing.sha };
  return {
    branch, number, state: 'requeued', keep: true, pushed: landing.sha,
    line: `${label}: ${landing.current ? 'queued again' : 'caught up with the main branch and queued again'}`,
  };
}

function defaultCloseTask(id, { number }) {
  const taskDb = require('./task-db');
  const db = taskDb.open();
  // A hold or protected area added while the change waited to merge still
  // wins: that job stays for a person.
  if (protectedLane(taskDb.getTask(db, id))) return { updated: false };
  return taskDb.doneTask(db, {
    id, actor: 'autoland', allowReview: true, autoAccepted: true,
    action: 'merged', proof: `its own pull request #${number} merged`,
  });
}

// The member's own change merged: close every job it was queued for. A job
// already closed, or one that cannot be read, is left as it is.
function closeMergedJobs(entry, closeTask) {
  const ids = Array.isArray(entry.task_ids) ? entry.task_ids.filter((id) => typeof id === 'string' && id.trim()) : [];
  const closed = [];
  for (const id of ids) {
    let out = null;
    try {
      out = closeTask(id, { number: entry.number, branch: entry.branch });
    } catch {
      out = null;
    }
    if (out && out.updated) closed.push(id);
  }
  return closed;
}

// Look at every branch autoland queued and re-queue the ones GitHub dropped.
// A branch whose own change merged closes the jobs it was queued for.
function requeueDroppedAutolands({ cwd, maxRequeues = MAX_REQUEUES, closeTask = defaultCloseTask } = {}) {
  const file = queueFile(cwd);
  if (!file) return { checked: 0, results: [], line: 'not inside a git checkout' };
  if (!policyOn(cwd)) return { checked: 0, results: [], line: 'self-landing is not switched on in the main checkout' };
  const entries = readQueue(file);
  const results = [];
  for (const [key, entry] of Object.entries(entries)) {
    const valid = entry && typeof entry.branch === 'string' && entry.branch === key && typeof entry.base === 'string'
      && Number.isInteger(entry.number) && entry.number > 0 && /^[0-9a-f]{40,64}$/.test(String(entry.pushed || ''));
    const result = valid ? requeueOne(entry, cwd, maxRequeues)
      : { branch: key, state: 'unreadable', keep: false, line: `${key}: queue entry could not be read; dropped from the list` };
    if (valid && result.own) {
      result.closed = closeMergedJobs(entry, closeTask);
      const n = result.closed.length;
      if (n) result.line += `; closed ${n === 1 ? 'its job' : `its ${n} jobs`}`;
    }
    results.push(result);
    if (!result.keep) delete entries[key];
    else if (result.state === 'requeued' || (result.pushed && result.pushed !== entry.pushed)) {
      entries[key] = { ...entry, pushed: result.pushed, requeues: (Number(entry.requeues) || 0) + 1, requeued_at: new Date().toISOString() };
    }
  }
  if (results.length) writeQueue(file, entries);
  const requeued = results.filter((r) => r.state === 'requeued').length;
  const closed = results.reduce((sum, r) => sum + (r.closed ? r.closed.length : 0), 0);
  const closedNote = closed ? `; ${closed} finished ${closed === 1 ? 'job' : 'jobs'} closed after merging` : '';
  const line = results.length
    ? `${requeued} of ${results.length} queued ${results.length === 1 ? 'change' : 'changes'} put back in line${closedNote}`
    : 'nothing is waiting in github\'s merge line';
  return { checked: results.length, requeued, closed, results, line };
}

module.exports = {
  autolandMemberRun,
  landingDestination,
  requeueDroppedAutolands,
  codeStatus,
  gitCodeState,
};
