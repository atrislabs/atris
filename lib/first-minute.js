'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { isGenericScratchRoot } = require('./scratch-root');

const FIRST_USE_COMMAND = 'atris "help me choose the first useful step for this project"';
const FIRST_TALK_ASK = 'what do you want here';
const BARE_ATRIS_FLAGS = new Set(['--yes', '-y', '--json', '--verbose']);
const NOT_A_PERSON = new Set([
  'root', 'node', 'ubuntu', 'admin', 'nobody', 'www', 'daemon', 'guest',
  'test', 'user', 'operator', 'tmp', 'temp', 'atris',
]);

function clip(value, max = 72) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  if (text.length <= max) return text;
  const slice = text.slice(0, Math.max(0, max - 3));
  const lastSpace = slice.lastIndexOf(' ');
  const body = lastSpace > 0 ? slice.slice(0, lastSpace) : slice;
  return `${body.replace(/[\s,;:.!?-]+$/, '')}...`;
}

function isBareAtrisFlag(token) {
  return BARE_ATRIS_FLAGS.has(String(token || ''));
}

function givenNameFrom(raw) {
  const text = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  const handle = text.includes('@') ? text.split('@')[0] : text;
  const first = handle.split(/[._+\s/-]/)[0].replace(/\d+$/g, '');
  if (!/^[A-Za-z][A-Za-z'-]{1,15}$/.test(first)) return '';
  const name = first.toLowerCase();
  if (NOT_A_PERSON.has(name)) return '';
  return name;
}

function unixUser(env = process.env) {
  const raw = String(env.USER || env.LOGNAME || '').trim();
  let name = raw.split(/[\\/]/).pop();
  if (!name) {
    try {
      name = String(os.userInfo().username || '').trim();
    } catch {
      name = '';
    }
  }
  if (!name || NOT_A_PERSON.has(name.toLowerCase())) return '';
  return name;
}

function loadSavedAccount() {
  try {
    const home = process.env.HOME || os.homedir();
    const file = path.join(home, '.atris', 'credentials.json');
    if (!fs.existsSync(file)) return null;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function personName(env = process.env, account) {
  const fromOperator = givenNameFrom(env.ATRIS_OPERATOR);
  if (fromOperator) return fromOperator;
  const saved = account !== undefined ? account : loadSavedAccount();
  if (saved) {
    const fromAccount = givenNameFrom(saved.name || saved.display_name || saved.username || saved.handle)
      || givenNameFrom(saved.email);
    if (fromAccount) return fromAccount;
  }
  return givenNameFrom(env.USER || env.LOGNAME) || unixUser(env);
}

function isThrowawayFolderName(name) {
  const text = String(name || '');
  if (/^(tmp|temp|atris-)/i.test(text)) return true;
  if (/^[0-9a-f]{8,}$/i.test(text)) return true;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(text);
}

function isScratchFolder(root = process.cwd()) {
  const resolved = path.resolve(root || '.');
  const name = path.basename(resolved);
  if (isThrowawayFolderName(name)) return true;
  // /tmp, /private/tmp, /var/tmp, and os.tmpdir() are rooms, not project parents.
  return isGenericScratchRoot(resolved);
}

function folderName(root = process.cwd()) {
  const name = path.basename(path.resolve(root || '.'));
  if (!name || name === '.' || name === path.sep) return 'this folder';
  if (isScratchFolder(root)) return 'this folder';
  return name;
}

function greet(person) {
  return person ? `hey ${person}, ` : '';
}

function firstTalkCommand(_folder = 'this folder') {
  return `atris "${FIRST_TALK_ASK}?"`;
}

function isFirstTalkLine(value) {
  const text = String(value || '')
    .trim()
    .replace(/^atris\s+/i, '')
    .replace(/^["']+|["']+$/g, '')
    .toLowerCase()
    .replace(/[?.!]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text === FIRST_TALK_ASK;
}

function hasLiveWork({
  task = null,
  backlogCount = 0,
  wipCount = 0,
  inboxCount = 0,
} = {}) {
  return Boolean(task || backlogCount > 0 || wipCount > 0 || inboxCount > 0);
}

function softTitle(title, maxWords = 5) {
  const words = String(title || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  if (!words.length) return '';
  const text = words.slice(0, maxWords).join(' ').replace(/[.,;:!?]+$/g, '');
  return `"${text.toLowerCase()}"`;
}

function taskRef(task) {
  const ref = task && (task.display_id || task.legacy_ref || '');
  return String(ref || '').trim();
}

function newest(tasks) {
  return [...(Array.isArray(tasks) ? tasks : [])].sort((a, b) => (
    Number(b && (b.updated_at || b.created_at) || 0)
    - Number(a && (a.updated_at || a.created_at) || 0)
  ))[0] || null;
}

function isCertifiedReview(task) {
  const review = task && task.review || {};
  const metadata = task && task.metadata || {};
  if (review.agent_certified === true || metadata.agent_certified === true) return true;
  return Number(review.agent_review_pass_count || metadata.agent_review_pass_count || 0) >= 2;
}

function isActionableTask(task) {
  const status = task && task.status;
  return status === 'open' || status === 'claimed' || status === 'review';
}

function titlesFromTodoSection(root, section) {
  try {
    const text = fs.readFileSync(path.join(root, 'atris', 'TODO.md'), 'utf8');
    const match = String(text).match(new RegExp(`##\\s+${section}\\n([\\s\\S]*?)(?=\\n##|$)`, 'i'));
    if (!match) return null;
    const body = String(match[1] || '').trim();
    if (!body || /\(empty|\(see /i.test(body)) return [];
    return body
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /^-\s+/.test(line) && !/\(empty/i.test(line))
      .map((line) => line.replace(/^-+\s*/, '').trim())
      .filter(Boolean);
  } catch {
    return null;
  }
}

function loadLocalTasks(root = process.cwd()) {
  let dbRows = [];
  try {
    const taskDb = require('./task-db');
    const db = taskDb.open();
    const workspaceRoot = taskDb.workspaceRoot(root);
    const rows = taskDb.listTasks(db, { workspaceRoot, limit: 200 });
    if (Array.isArray(rows) && rows.length) dbRows = taskDb.withTaskDisplayRefs(rows);
  } catch {
    // Fall through to the local projection. Tests and fresh folders often have no db.
  }
  if (dbRows.some(isActionableTask)) return dbRows;
  const projectionPath = path.join(root, '.atris', 'state', 'tasks.projection.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(projectionPath, 'utf8'));
    const projected = Array.isArray(parsed.tasks) ? parsed.tasks : [];
    if (projected.some(isActionableTask) || !dbRows.length) return projected;
  } catch {
    // Keep any done-only db rows below.
  }
  return dbRows;
}

function loadLatestRecap(root = process.cwd()) {
  const dir = path.join(root, 'atris', 'reports');
  if (!fs.existsSync(dir)) return null;
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const recaps = names
    .filter((name) => /\.md$/i.test(name) && /recap/i.test(name))
    .map((name) => {
      const file = path.join(dir, name);
      let mtime = 0;
      try {
        mtime = fs.statSync(file).mtimeMs;
      } catch {
        mtime = 0;
      }
      return { file, name, mtime };
    })
    .sort((a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name));
  const hit = recaps[0];
  if (!hit) return null;
  let title = path.basename(hit.name, '.md').replace(/[-_]+/g, ' ');
  try {
    const head = fs.readFileSync(hit.file, 'utf8').slice(0, 2000);
    const h1 = head.split('\n').find((line) => line.startsWith('# '));
    if (h1) title = h1.slice(2).trim();
  } catch {
    // Keep the filename title.
  }
  title = clip(title, 72);
  return title ? { title, file: hit.file } : null;
}

function taskCommand(task, person) {
  const ref = taskRef(task);
  const who = person || 'operator';
  if (!task) return FIRST_USE_COMMAND;
  if (task.status === 'review') {
    return ref ? `atris task accept ${ref}` : 'atris task reviews --limit 5';
  }
  if (task.status === 'claimed') return 'atris do';
  if (task.status === 'open') {
    return ref ? `atris task claim ${ref} --as ${who}` : 'atris task next';
  }
  return 'atris do';
}

function deskNextCommand(tasks, person) {
  const list = Array.isArray(tasks) ? tasks : [];
  const picked = pickNext({ tasks: list, person });
  if (!picked.task) return list.length ? 'atris task next' : 'atris task new';
  return taskCommand(picked.task, person);
}

function taskNextCommand(tasks, person) {
  const list = Array.isArray(tasks) ? tasks : [];
  const picked = pickNext({ tasks: list, person });
  if (!picked.task) return 'atris task new';
  return picked.command;
}

function pickNext({
  tasks = [],
  missions = [],
  person = '',
  completedTitles = [],
  backlogCount = 0,
  inboxCount = 0,
  wipCount = 0,
} = {}) {
  const reviews = (Array.isArray(tasks) ? tasks : []).filter((task) => task && task.status === 'review');
  const certified = newest(reviews.filter(isCertifiedReview));
  if (certified) return { task: certified, command: taskCommand(certified, person) };
  const claimed = newest(tasks.filter((task) => task && task.status === 'claimed'));
  if (claimed) return { task: claimed, command: taskCommand(claimed, person) };
  const review = newest(reviews);
  if (review) return { task: review, command: taskCommand(review, person) };
  const needTick = (missions || []).find((mission) => mission && mission.verifier && !mission.verifier_passed);
  if (needTick) {
    const id = String(needTick.id || '').trim();
    return {
      mission: needTick,
      command: id
        ? `atris mission tick ${id} --verify --complete-on-pass`
        : 'atris mission status --status active',
    };
  }
  const open = newest(tasks.filter((task) => task && task.status === 'open'));
  if (open) return { task: open, command: taskCommand(open, person) };
  if (wipCount > 0 || backlogCount > 0) return { command: 'atris do' };
  if (inboxCount > 0) return { command: 'atris plan' };
  if (completedTitles.length > 0) return { command: 'atris plan' };
  return { command: FIRST_USE_COMMAND };
}

function isUserVisibleName(name) {
  const text = String(name || '');
  if (!text || text === '.' || text === '..') return false;
  if (text.startsWith('.')) return false;
  // The local task store can land in the folder during a look.
  // It is system noise, not user work.
  return !/^tasks\.db(-wal|-shm)?$/i.test(text);
}

function directoryHasUserVisibleWork(dir) {
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return false;
  }
  return names.some(isUserVisibleName);
}

function isUserVisibleWorkEntry(root, name) {
  if (!isUserVisibleName(name)) return false;
  const full = path.join(root, name);
  let stat;
  try {
    stat = fs.lstatSync(full);
  } catch {
    return false;
  }
  if (stat.isDirectory()) return directoryHasUserVisibleWork(full);
  return true;
}

function listUserVisibleWork(root = process.cwd()) {
  let names = [];
  try {
    names = fs.readdirSync(root);
  } catch {
    return [];
  }
  return names.filter((name) => isUserVisibleWorkEntry(root, name))
    .sort((a, b) => a.localeCompare(b));
}

function spokenVisibleNames(files) {
  const seen = new Set();
  const names = [];
  for (const raw of Array.isArray(files) ? files : []) {
    const name = path.basename(String(raw || '')).replace(/\s+/g, ' ').trim();
    if (!isUserVisibleName(name) || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names.sort((a, b) => a.localeCompare(b));
}

function spokenCommitSubject(value) {
  const text = clip(value, 72);
  if (text.endsWith('...')) return text;
  return text.replace(/[.,;:!?]+$/g, '');
}

function spokenBranchName(value) {
  let text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  if (/^origin\//.test(text)) text = text.slice('origin/'.length).replace(/\s+/g, ' ').trim();
  if (!text || text === 'HEAD') return '';
  if (/^(main|master)$/i.test(text)) return '';
  if (/^[0-9a-f]{7,}$/i.test(text)) return '';
  return clip(text, 72);
}

function gitProbeEnv() {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  return env;
}

function hasLocalGit(root = process.cwd()) {
  try {
    return fs.existsSync(path.join(path.resolve(root || '.'), '.git'));
  } catch {
    return false;
  }
}

function gitProbe(root, args) {
  return spawnSync('git', [
    '-C', path.resolve(root || '.'),
    '-c', 'safe.directory=*',
    ...args,
  ], {
    encoding: 'utf8',
    timeout: 3000,
    stdio: ['ignore', 'pipe', 'ignore'],
    env: gitProbeEnv(),
  });
}

function porcelainPath(line) {
  const text = String(line || '');
  if (text.length < 4) return '';
  let body = text.slice(3);
  if (/^[CR]/.test(text)) {
    const arrow = body.lastIndexOf(' -> ');
    if (arrow >= 0) body = body.slice(arrow + 4);
  }
  const trimmed = body.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  return trimmed;
}

function listDirtyWork(root = process.cwd()) {
  if (!hasLocalGit(root)) return null;
  try {
    const result = gitProbe(root, ['status', '--porcelain']);
    if (!result || result.status !== 0) return null;
    const names = String(result.stdout || '')
      .split('\n')
      .map(porcelainPath)
      .filter(Boolean);
    return names.length ? names : null;
  } catch {
    return null;
  }
}

function spokenOpenWork(files) {
  const names = spokenVisibleNames(files);
  if (names.length === 1) return `${names[0]} is still open.`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are still open.`;
  return 'this folder still has open work.';
}

function headCommitSubject(root = process.cwd()) {
  if (!hasLocalGit(root)) return '';
  try {
    const result = gitProbe(root, [
      '-c', 'log.showSignature=false',
      'log', '-1', '--pretty=format:%s',
    ]);
    if (!result || result.status !== 0) return '';
    return spokenCommitSubject(result.stdout);
  } catch {
    return '';
  }
}

function headBranchName(root = process.cwd()) {
  if (!hasLocalGit(root)) return '';
  try {
    const result = gitProbe(root, ['branch', '--show-current']);
    if (!result || result.status !== 0) return '';
    return spokenBranchName(result.stdout);
  } catch {
    return '';
  }
}

function resolveFreshCommit({ root, files, commit } = {}) {
  const visible = spokenVisibleNames(files);
  if (!visible.length) return '';
  if (commit !== undefined) return spokenCommitSubject(commit);
  return root ? headCommitSubject(root) : '';
}

function resolveFreshBranch({ root, files, commit, branch } = {}) {
  const visible = spokenVisibleNames(files);
  if (!visible.length) return '';
  if (branch !== undefined) return spokenBranchName(branch);
  if (commit !== undefined) return '';
  return root ? headBranchName(root) : '';
}

function resolveFreshOpenWork({ root, files, commit, dirty } = {}) {
  const visible = spokenVisibleNames(files);
  if (!visible.length) return '';
  if (dirty !== undefined) {
    const names = spokenVisibleNames(Array.isArray(dirty) ? dirty : []);
    if (!names.length) return '';
    return spokenOpenWork(names);
  }
  if (commit !== undefined) return '';
  if (!root) return '';
  if (!headCommitSubject(root)) return '';
  const listed = listDirtyWork(root);
  if (!listed) return '';
  const names = spokenVisibleNames(listed);
  if (!names.length) return '';
  return spokenOpenWork(names);
}

function freshWinLine({ folder = 'this folder', files, root, commit, dirty, branch } = {}) {
  const visible = spokenVisibleNames(files);
  const open = resolveFreshOpenWork({ root, files: visible, commit, dirty });
  if (open) return open;
  const named = resolveFreshBranch({ root, files: visible, commit, branch });
  if (named) return `${named} is already here.`;
  const subject = resolveFreshCommit({ root, files: visible, commit });
  if (subject) return `${subject} is already here.`;
  if (visible.length === 1) return `${visible[0]} is already here.`;
  if (visible.length === 2) return `${visible[0]} and ${visible[1]} are already here.`;
  if (visible.length > 2) return 'this folder already has work.';
  return `${folder || 'this folder'} is empty.`;
}

function freshNextCommand(files, folder = 'this folder') {
  if (spokenVisibleNames(files).length) return 'atris do';
  return firstTalkCommand(folder);
}

function renderFresh({ person = '', folder = 'this folder', files, root, commit, dirty, branch } = {}) {
  const room = folder || 'this folder';
  return [
    `${greet(person)}${freshWinLine({ folder: room, files, root, commit, dirty, branch })}`,
    '',
    `next: ${freshNextCommand(files, room)}`,
  ].join('\n');
}

function spokenStarterTitle(title, folder = 'this folder') {
  const text = String(title || '').replace(/\s+/g, ' ').trim();
  if (!text) return folder || 'this folder';
  return text.replace(/[.,;:!?]+$/g, '');
}

function visibleWorkTitle(files, folder = 'this folder') {
  const visible = spokenVisibleNames(files);
  if (visible.length === 1) return visible[0];
  if (visible.length === 2) return `${visible[0]} and ${visible[1]}`;
  return folder || 'this folder';
}

function firstTalkNext({ starter = null, person = '', folder = 'this folder' } = {}) {
  const room = folder || 'this folder';
  if (starter && starter.display_id) {
    return taskCommand({
      display_id: starter.display_id,
      status: starter.status || 'claimed',
    }, person);
  }
  const title = spokenStarterTitle(starter && starter.title, room);
  return `atris task new "${title}"`;
}

function firstTalkJson({ starter = null, person = '', folder = 'this folder' } = {}) {
  return {
    schema: 'atris.one_lap.v1',
    ok: true,
    status: 'started',
    next_action: firstTalkNext({ starter, person, folder }),
    task: starter && starter.display_id
      ? { display_id: starter.display_id, title: starter.title }
      : null,
  };
}

function renderFirstTalk({ person = '', folder = 'this folder', starter = null } = {}) {
  const room = folder || 'this folder';
  const title = spokenStarterTitle(starter && starter.title, room);
  return [
    `${greet(person)}${title} is ready.`,
    '',
    `next: ${firstTalkNext({ starter, person, folder: room })}`,
  ].join('\n');
}

function freshMinuteJson(folder = 'this folder', files, extra = {}) {
  const root = extra && extra.root;
  const commit = extra && extra.commit;
  const dirty = extra && extra.dirty;
  const branch = extra && extra.branch;
  return {
    schema: 'atris.one_lap.v1',
    ok: false,
    status: 'stuck',
    reason: freshWinLine({ folder, files, root, commit, dirty, branch }).replace(/\.$/, ''),
    next_action: freshNextCommand(files, folder),
  };
}

function renderWorkspace({
  person = '',
  folder = 'this folder',
  task = null,
  recap = null,
  completedTitle = '',
  nextCommand = FIRST_USE_COMMAND,
  liveWork = false,
  movingTitle = '',
} = {}) {
  const who = greet(person);
  const title = task && softTitle(task.title);
  let win = `${who}${folder || 'this folder'} is set up.`;
  if (task && task.status === 'done' && title) {
    win = `${who}you already shipped ${title}.`;
  } else if (task && task.status === 'review') {
    win = `${who}something finished. waiting on you.`;
  } else if (task && task.status === 'claimed' && title) {
    win = `${who}${title} is already yours.`;
  } else if (task && task.status === 'open' && title) {
    win = `${who}${title} is ready to claim.`;
  } else if (movingTitle && liveWork) {
    win = `${who}${softTitle(movingTitle)} is waiting.`;
  } else if (completedTitle && !liveWork) {
    win = `${who}you already shipped ${softTitle(completedTitle)}.`;
  } else if (recap && recap.title && !liveWork) {
    win = `${who}you already have a recap in ${folder || 'this folder'}: ${recap.title}.`;
  } else if (liveWork) {
    win = `${who}${folder || 'this folder'} has work in motion.`;
  }
  const lines = [win];
  if (recap && recap.title && task) lines.push(`last recap: ${recap.title}.`);
  lines.push('');
  lines.push(`next: ${nextCommand}`);
  return lines.join('\n');
}

function buildFirstMinute({
  root = process.cwd(),
  fresh = false,
  person,
  folder,
  context = {},
  missions = [],
  files,
  commit,
  dirty,
  branch,
} = {}) {
  const who = person != null ? person : personName();
  const room = folder != null ? folder : folderName(root);
  if (fresh) {
    const visible = files != null ? spokenVisibleNames(files) : listUserVisibleWork(root);
    return {
      kind: 'fresh',
      text: renderFresh({ person: who, folder: room, files: visible, root, commit, dirty, branch }),
      nextCommand: freshNextCommand(visible, room),
      files: visible,
    };
  }
  const tasks = loadLocalTasks(root);
  const todoBacklog = titlesFromTodoSection(root, 'Backlog');
  const todoWip = titlesFromTodoSection(root, 'In Progress');
  const backlogCount = todoBacklog
    ? todoBacklog.length
    : (Array.isArray(context.backlogTasks) ? context.backlogTasks.length : 0);
  const inboxCount = typeof context.inboxCount === 'number' ? context.inboxCount : 0;
  const wipCount = todoWip
    ? todoWip.length
    : (Array.isArray(context.inProgressTasks) ? context.inProgressTasks.length : 0);
  const picked = pickNext({
    tasks,
    missions,
    person: who,
    completedTitles: Array.isArray(context.completedTasks) ? context.completedTasks : [],
    backlogCount,
    inboxCount,
    wipCount,
  });
  const recap = loadLatestRecap(root);
  const completedTitle = Array.isArray(context.completedTasks) ? context.completedTasks[0] : '';
  const movingTitle = (todoWip && todoWip[0])
    || (todoBacklog && todoBacklog[0])
    || (!todoBacklog && !todoWip && ((Array.isArray(context.inProgressTasks) && context.inProgressTasks[0])
      || (Array.isArray(context.backlogTasks) && context.backlogTasks[0])))
    || '';
  const liveWork = hasLiveWork({
    task: picked.task || null,
    backlogCount,
    wipCount,
    inboxCount,
  });
  return {
    kind: 'workspace',
    text: renderWorkspace({
      person: who,
      folder: room,
      task: picked.task || null,
      recap,
      completedTitle,
      nextCommand: picked.command,
      liveWork,
      movingTitle,
    }),
    nextCommand: picked.command,
    task: picked.task || null,
    recap,
  };
}

function shouldAutoInitFresh(args = process.argv.slice(2), _env = process.env) {
  const list = Array.isArray(args) ? args : [];
  if (list.includes('--json')) return false;
  // --yes / -y is explicit consent. Headless env must not block it.
  return list.includes('--yes') || list.includes('-y');
}

// Looking at the next task is not first-talk. A quoted `task next`
// must not init a room in an empty folder.
function isTaskNextLook(value) {
  return /^task\s+next\b/i.test(String(value || '').trim());
}

const LEFTOVER_LOOK_VERBS = new Set(['brainstorm', 'wish', 'log', 'plan', 'do']);

// Leftover words after a known verb are not first-talk. A quoted
// `brainstorm hi` / `wish hi` must not init a room in an empty folder.
function isLeftoverVerbLook(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return false;
  if (isTaskNextLook(text)) return true;
  const match = text.match(/^([A-Za-z][\w-]*)\s+\S/);
  if (!match) return false;
  return LEFTOVER_LOOK_VERBS.has(match[1].toLowerCase());
}

function spokenLineCount(text) {
  return String(text || '')
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean).length;
}

function isFreshWorkspace(root = process.cwd()) {
  return !fs.existsSync(path.join(root, 'atris'));
}

function speakFirstMinute({
  root = process.cwd(),
  fresh,
  asJson = false,
  log = console.log,
  files,
} = {}) {
  const isFresh = fresh != null ? Boolean(fresh) : isFreshWorkspace(root);
  const visible = files != null ? spokenVisibleNames(files) : listUserVisibleWork(root);
  if (asJson && isFresh) {
    log(JSON.stringify(freshMinuteJson(folderName(root), visible, { root }), null, 2));
    return 2;
  }
  const screen = buildFirstMinute({
    root,
    fresh: isFresh,
    files: isFresh ? visible : undefined,
  });
  log('');
  log(screen.text);
  return 0;
}

module.exports = {
  buildFirstMinute,
  deskNextCommand,
  firstTalkCommand,
  firstTalkJson,
  firstTalkNext,
  folderName,
  freshMinuteJson,
  freshNextCommand,
  freshWinLine,
  headBranchName,
  headCommitSubject,
  listDirtyWork,
  isBareAtrisFlag,
  isCertifiedReview,
  isFirstTalkLine,
  isFreshWorkspace,
  isLeftoverVerbLook,
  isTaskNextLook,
  listUserVisibleWork,
  personName,
  pickNext,
  renderFirstTalk,
  spokenStarterTitle,
  visibleWorkTitle,
  renderFresh,
  renderWorkspace,
  shouldAutoInitFresh,
  speakFirstMinute,
  spokenLineCount,
  taskCommand,
  taskNextCommand,
};
