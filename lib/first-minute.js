'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const FIRST_USE_COMMAND = 'atris "help me choose the first useful step for this project"';
const INIT_COMMAND = 'atris init --minimal';
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
  try {
    const tmp = path.resolve(os.tmpdir()).replace(/\\/g, '/');
    const unix = resolved.replace(/\\/g, '/');
    if (unix === tmp) return true;
  } catch {
    // Named rooms keep their basename even under tmp.
  }
  return false;
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

function loadLocalTasks(root = process.cwd()) {
  try {
    const taskDb = require('./task-db');
    const db = taskDb.open();
    const workspaceRoot = taskDb.workspaceRoot(root);
    const rows = taskDb.listTasks(db, { workspaceRoot, limit: 200 });
    if (Array.isArray(rows) && rows.length) return taskDb.withTaskDisplayRefs(rows);
  } catch {
    // Fall through to the local projection. Tests and fresh folders often have no db.
  }
  const projectionPath = path.join(root, '.atris', 'state', 'tasks.projection.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(projectionPath, 'utf8'));
    return Array.isArray(parsed.tasks) ? parsed.tasks : [];
  } catch {
    return [];
  }
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
    if (isCertifiedReview(task)) return ref ? `atris task accept ${ref}` : 'atris task reviews --limit 5';
    return ref ? `atris task review-chat ${ref} --as codex-review` : 'atris task reviews --limit 5';
  }
  if (task.status === 'claimed') return ref ? `atris task ready ${ref}` : 'atris do';
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
    `${greet(person)}${room} is a clean start.`,
    '',
    `next: ${INIT_COMMAND}`,
  ].join('\n');
}

function renderWorkspace({
  person = '',
  folder = 'this folder',
  task = null,
  recap = null,
  completedTitle = '',
  nextCommand = FIRST_USE_COMMAND,
} = {}) {
  const who = greet(person);
  const title = task && softTitle(task.title);
  let win = `${who}${folder || 'this folder'} is set up.`;
  if (task && task.status === 'done' && title) {
    win = `${who}you already shipped ${title}.`;
  } else if (task && task.status === 'review' && title) {
    win = isCertifiedReview(task)
      ? `${who}${title} is waiting for your ok.`
      : `${who}${title} is ready to look at.`;
  } else if (task && task.status === 'claimed' && title) {
    win = `${who}${title} is already yours.`;
  } else if (task && task.status === 'open' && title) {
    win = `${who}${title} is ready to claim.`;
  } else if (completedTitle) {
    win = `${who}you already shipped ${softTitle(completedTitle)}.`;
  } else if (recap && recap.title) {
    win = `${who}you already have a recap in ${folder || 'this folder'}: ${recap.title}.`;
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
      nextCommand: INIT_COMMAND,
    };
  }
  const tasks = loadLocalTasks(root);
  const picked = pickNext({
    tasks,
    missions,
    person: who,
    completedTitles: Array.isArray(context.completedTasks) ? context.completedTasks : [],
    backlogCount: Array.isArray(context.backlogTasks) ? context.backlogTasks.length : 0,
    inboxCount: typeof context.inboxCount === 'number' ? context.inboxCount : 0,
    wipCount: Array.isArray(context.inProgressTasks) ? context.inProgressTasks.length : 0,
  });
  const recap = loadLatestRecap(root);
  const completedTitle = Array.isArray(context.completedTasks) ? context.completedTasks[0] : '';
  return {
    kind: 'workspace',
    text: renderWorkspace({
      person: who,
      folder: room,
      task: picked.task || null,
      recap,
      completedTitle,
      nextCommand: picked.command,
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

function spokenLineCount(text) {
  return String(text || '')
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean).length;
}

module.exports = {
  buildFirstMinute,
  deskNextCommand,
  folderName,
  isBareAtrisFlag,
  isCertifiedReview,
  personName,
  pickNext,
  renderFresh,
  renderWorkspace,
  shouldAutoInitFresh,
  spokenLineCount,
  taskCommand,
  taskNextCommand,
};
