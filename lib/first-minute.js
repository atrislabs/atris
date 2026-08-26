'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { isGenericScratchRoot } = require('./scratch-root');

const FIRST_USE_COMMAND = 'atris "help me choose the first useful step for this project"';
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

function firstTalkCommand(folder = 'this folder') {
  const room = String(folder || 'this folder').replace(/["`]/g, '').trim() || 'this folder';
  return `atris "what should ${room} be?"`;
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
  if (task.status === 'claimed') return ref ? `atris task show ${ref}` : 'atris do';
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

function renderFresh({ person = '', folder = 'this folder' } = {}) {
  const room = folder || 'this folder';
  return [
    `${greet(person)}${room} is empty.`,
    '',
    `next: ${firstTalkCommand(room)}`,
  ].join('\n');
}

function renderFirstTalk({ person = '', folder = 'this folder', starter = null } = {}) {
  const room = folder || 'this folder';
  const ref = starter && starter.display_id;
  const claimAs = person || 'operator';
  const next = ref
    ? `atris task claim ${ref} --as ${claimAs}`
    : `atris task new "first useful step for ${room}"`;
  return [
    `${greet(person)}I saved a first step for ${room}.`,
    '',
    `next: ${next}`,
  ].join('\n');
}

function freshMinuteJson(folder = 'this folder') {
  return {
    schema: 'atris.one_lap.v1',
    ok: false,
    status: 'stuck',
    reason: 'this folder is empty',
    next_action: firstTalkCommand(folder),
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
  const ref = taskRef(task);
  let win = `${who}${folder || 'this folder'} is set up.`;
  if (task && task.status === 'done' && title) {
    win = `${who}you already shipped ${title}.`;
  } else if (task && task.status === 'review') {
    win = `${who}one finished thing is waiting for your ok${ref ? ` (${ref})` : ''}.`;
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
} = {}) {
  const who = person != null ? person : personName();
  const room = folder != null ? folder : folderName(root);
  if (fresh) {
    return {
      kind: 'fresh',
      text: renderFresh({ person: who, folder: room }),
      nextCommand: firstTalkCommand(room),
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
} = {}) {
  const isFresh = fresh != null ? Boolean(fresh) : isFreshWorkspace(root);
  if (asJson && isFresh) {
    log(JSON.stringify(freshMinuteJson(folderName(root)), null, 2));
    return 2;
  }
  const screen = buildFirstMinute({ root, fresh: isFresh });
  log('');
  log(screen.text);
  return 0;
}

module.exports = {
  buildFirstMinute,
  deskNextCommand,
  firstTalkCommand,
  folderName,
  freshMinuteJson,
  isBareAtrisFlag,
  isCertifiedReview,
  isFreshWorkspace,
  isTaskNextLook,
  personName,
  pickNext,
  renderFirstTalk,
  renderFresh,
  renderWorkspace,
  shouldAutoInitFresh,
  speakFirstMinute,
  spokenLineCount,
  taskCommand,
  taskNextCommand,
};
