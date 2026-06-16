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
  return text.length > max ? `${text.slice(0, Math.max(0, max - 3)).trim()}...` : text;
}

function inferDomain(answer) {
  const text = String(answer || '').toLowerCase();
  if (/college|application|essay|common app|school/.test(text)) return 'school';
  if (/code|coding|program|website|app|project/.test(text)) return 'building';
  if (/week|schedule|calendar|plan|homework/.test(text)) return 'planning';
  return 'general';
}

function starterTaskTitle(answer) {
  const summary = compactText(answer, 80) || 'first useful path';
  return `First useful step: ${summary}`;
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

function createStarterTask(root, answer) {
  const atrisDir = path.join(root, 'atris');
  if (!fs.existsSync(atrisDir)) return null;
  try {
    const taskDb = require('./task-db');
    const db = taskDb.open();
    const workspaceRoot = taskDb.workspaceRoot(root);
    const title = starterTaskTitle(answer);
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
      title: starterTaskTitle(answer),
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
} = {}) {
  if (hasContextProfile(root)) return false;
  if (String(userInput || '').trim()) return true;
  if (mapStatus !== 'ready') return true;
  if (liveMissionsCount > 0 || wipCount > 0 || backlogCount > 0 || inboxCount > 0) return false;
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

module.exports = {
  PROFILE_REL_PATH,
  profilePath,
  loadContextProfile,
  hasContextProfile,
  saveContextProfile,
  createStarterTask,
  shouldGatherContext,
  renderPrompt,
  starterTaskTitle,
  inferDomain,
};
