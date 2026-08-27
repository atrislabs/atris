'use strict';

const fs = require('fs');
const path = require('path');

const PROFILE_REL_PATH = path.join('.atris', 'state', 'context_profile.json');

function profilePath(root = process.cwd()) {
  return path.join(root, PROFILE_REL_PATH);
}

function loadContextProfile(root = process.cwd()) {
  const target = profilePath(root);
  if (!fs.existsSync(target)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function hasContextProfile(root = process.cwd()) {
  const profile = loadContextProfile(root);
  return Boolean(profile && String(profile.first_answer || '').trim());
}

function compactText(value, max = 160) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  if (text.length <= max) return text;
  const slice = text.slice(0, Math.max(0, max - 3));
  const lastSpace = slice.lastIndexOf(' ');
  // Cut on a word boundary so a title never ends on half a word ("...an autonomo...").
  // Fall back to the hard slice only when a single word already fills the limit.
  const body = lastSpace > 0 ? slice.slice(0, lastSpace) : slice;
  return `${body.replace(/[\s,;:.!?-]+$/, '')}...`;
}

function inferDomain(answer) {
  const text = String(answer || '').toLowerCase();
  if (/college|application|essay|common app|school/.test(text)) return 'school';
  if (/code|coding|program|website|app|project/.test(text)) return 'building';
  if (/week|schedule|calendar|plan|homework/.test(text)) return 'planning';
  return 'general';
}

function isFlagLikeAnswer(answer) {
  const tokens = String(answer || '').trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return true;
  const helpFlag = (token) => token === '--help' || token === '-h' || token === '-?';
  if (tokens.some(helpFlag)) return true;
  if (tokens.length === 1 && (tokens[0] === 'help' || tokens[0].startsWith('-'))) return true;
  return tokens.every((token) => token.startsWith('-') || token === 'help');
}

function starterTaskTitle(answer, folder = 'this folder') {
  const room = folder || 'this folder';
  const { isFirstTalkLine } = require('./first-minute');
  if (isFirstTalkLine(answer)) return room;
  return compactText(answer, 80) || room;
}

function saveContextProfile(root, answer, { source = 'first_contact' } = {}) {
  const text = compactText(answer, 500);
  if (!text) return null;
  const target = profilePath(root);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const existing = loadContextProfile(root) || {};
  const profile = {
    schema: 'atris.context_profile.v1',
    created_at: existing.created_at || new Date().toISOString(),
    updated_at: new Date().toISOString(),
    source,
    first_answer: text,
    inferred_domain: inferDomain(text),
  };
  fs.writeFileSync(target, `${JSON.stringify(profile, null, 2)}\n`, 'utf8');
  return profile;
}

function runSilentMinimalInit(root = process.cwd()) {
  const { spawnSync } = require('child_process');
  const script = process.argv[1] || path.join(__dirname, '..', 'bin', 'atris.js');
  const result = spawnSync(process.execPath, [script, 'init', '--minimal', '--yes'], {
    cwd: root,
    env: process.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return Number.isInteger(result.status) ? result.status : 1;
}

function startFirstTalk(root, answer, { asJson = false, log = console.log } = {}) {
  const {
    firstTalkJson,
    folderName,
    personName,
    renderFirstTalk,
  } = require('./first-minute');
  const initStatus = runSilentMinimalInit(root);
  if (initStatus !== 0) return initStatus;
  saveContextProfile(root, answer, { source: 'first_talk' });
  const starter = createStarterTask(root, answer);
  const room = folderName(root);
  const who = personName();
  if (asJson) {
    log(JSON.stringify(firstTalkJson({ starter, person: who, folder: room }), null, 2));
    return 0;
  }
  log('');
  log(renderFirstTalk({ person: who, folder: room, starter }));
  return 0;
}

function createStarterTask(root, answer) {
  if (isFlagLikeAnswer(answer)) return null;
  const atrisDir = path.join(root, 'atris');
  if (!fs.existsSync(atrisDir)) return null;
  const { folderName } = require('./first-minute');
  const title = starterTaskTitle(answer, folderName(root));
  try {
    const taskDb = require('./task-db');
    const db = taskDb.open();
    const workspaceRoot = taskDb.workspaceRoot(root);
    const sourceKey = taskDb.sourceKey('context-gatherer:first-task', title);
    const added = taskDb.addTask(db, {
      title,
      tag: 'onboarding',
      workspaceRoot,
      sourceKey,
      metadata: {
        source: 'context_gatherer',
        first_answer: compactText(answer, 500),
      },
    });
    const rows = taskDb.listTasks(db, { workspaceRoot });
    const displayRows = taskDb.withTaskDisplayRefs(rows);
    const task = displayRows.find(row => row.id === added.id) || null;
    try {
      const todoPath = path.join(root, 'atris', 'TODO.md');
      fs.writeFileSync(todoPath, taskDb.renderTodoMarkdown(rows, { title: 'TODO.md' }), 'utf8');
    } catch {}
    return {
      id: added.id,
      inserted: added.inserted,
      display_id: task && task.display_id || null,
      title,
    };
  } catch (error) {
    return {
      error: error && error.message ? error.message : String(error),
      title,
    };
  }
}

function shouldGatherContext({
  root = process.cwd(),
  userInput = '',
  mapStatus = 'ready',
  liveMissionsCount = 0,
  wipCount = 0,
  backlogCount = 0,
  inboxCount = 0,
  completedTasksCount = 0,
} = {}) {
  if (hasContextProfile(root)) return false;
  if (String(userInput || '').trim()) return true;
  if (mapStatus !== 'ready') return true;
  // Any signal that the workspace has been used (pending work OR completed
  // history) means it is not a fresh project to onboard.
  if (liveMissionsCount > 0 || wipCount > 0 || backlogCount > 0 || inboxCount > 0 || completedTasksCount > 0) return false;
  return true;
}

function renderPrompt({ projectName = 'this workspace' } = {}) {
  return [
    '',
    'Context gatherer',
    '----------------',
    `Hi. I am Atris, and I want to understand ${projectName} before I suggest a path.`,
    '',
    'What are you trying to make easier right now: school, college apps, coding, a personal project, or something else?',
    'Answer in one sentence. I will turn it into the first useful step.',
  ].join('\n');
}

function normalizeQuestionText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^\w\s']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// True when the input is a question ABOUT Atris itself ("what is atris?",
// "what can you do?") rather than a task request. bin/atris.js uses this to
// show the product overview instead of routing the words into plan/do.
// A clear task verb always wins, so "build a website" is never a meta-question.
function isAtrisMetaQuestion(value) {
  const text = normalizeQuestionText(value);
  if (!text) return false;

  const taskVerb = /\b(add|audit|build|change|create|debug|deploy|edit|fix|implement|make|patch|refactor|remove|review|run|ship|test|update|write)\b/;
  if (taskVerb.test(text)) return false;

  return [
    /^(what'?s|what is|what are|who is|who are)\s+(atris|you|this)\b/,
    /^what\s+atris\s+is\b/,
    /^(what|how)\s+(does|do|can)\s+(atris|you|this)\b/,
    /^(explain|describe|define)\s+(atris|this)\b/,
    /^tell me\s+(about|what)\s+(atris|this)\b/,
    /^why\s+atris\b/,
  ].some((pattern) => pattern.test(text));
}

module.exports = {
  PROFILE_REL_PATH,
  profilePath,
  loadContextProfile,
  hasContextProfile,
  saveContextProfile,
  createStarterTask,
  startFirstTalk,
  shouldGatherContext,
  renderPrompt,
  starterTaskTitle,
  inferDomain,
  isAtrisMetaQuestion,
  isFlagLikeAnswer,
};
