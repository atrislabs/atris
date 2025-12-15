const fs = require('fs');
const path = require('path');

function isFeatureInProgress(ideaContent) {
  if (!ideaContent || typeof ideaContent !== 'string') return false;
  return /\*\*Status:\*\*\s*in-progress\b/i.test(ideaContent) || /\bstatus:\s*in-progress\b/i.test(ideaContent);
}

function listFeatureDirs(featuresDir) {
  if (!fs.existsSync(featuresDir)) return [];
  return fs
    .readdirSync(featuresDir)
    .filter((name) => {
      if (name.startsWith('_')) return false;
      const full = path.join(featuresDir, name);
      try {
        return fs.statSync(full).isDirectory();
      } catch {
        return false;
      }
    });
}

function getInProgressFeatures(featuresDir) {
  const featureDirs = listFeatureDirs(featuresDir);
  const inProgress = [];
  for (const featureName of featureDirs) {
    const ideaPath = path.join(featuresDir, featureName, 'idea.md');
    if (!fs.existsSync(ideaPath)) continue;
    const content = fs.readFileSync(ideaPath, 'utf8');
    if (isFeatureInProgress(content)) {
      inProgress.push(featureName);
    }
  }
  return inProgress;
}

function getBacklogTasks(atrisDir) {
  const todoFile = path.join(atrisDir, 'TODO.md');
  const legacyTaskContextFile = path.join(atrisDir, 'TASK_CONTEXTS.md');
  const taskFilePath = fs.existsSync(todoFile)
    ? todoFile
    : (fs.existsSync(legacyTaskContextFile) ? legacyTaskContextFile : null);

  if (!taskFilePath) return [];

  const content = fs.readFileSync(taskFilePath, 'utf8');
  return getTasksFromTodoSection(content, 'Backlog');
}

function getInProgressTasks(atrisDir) {
  const todoFile = path.join(atrisDir, 'TODO.md');
  const legacyTaskContextFile = path.join(atrisDir, 'TASK_CONTEXTS.md');
  const taskFilePath = fs.existsSync(todoFile)
    ? todoFile
    : (fs.existsSync(legacyTaskContextFile) ? legacyTaskContextFile : null);

  if (!taskFilePath) return [];

  const content = fs.readFileSync(taskFilePath, 'utf8');
  return getTasksFromTodoSection(content, 'In Progress');
}

function getCompletedTasks(atrisDir) {
  const todoFile = path.join(atrisDir, 'TODO.md');
  const legacyTaskContextFile = path.join(atrisDir, 'TASK_CONTEXTS.md');
  const taskFilePath = fs.existsSync(todoFile)
    ? todoFile
    : (fs.existsSync(legacyTaskContextFile) ? legacyTaskContextFile : null);

  if (!taskFilePath) return [];

  const content = fs.readFileSync(taskFilePath, 'utf8');
  return getTasksFromTodoSection(content, 'Completed');
}

function getTasksFromTodoSection(content, sectionName) {
  if (!content || typeof content !== 'string') return [];
  if (!sectionName || typeof sectionName !== 'string') return [];

  const match = content.match(new RegExp(`##\\s+${escapeRegExp(sectionName)}\\n([\\s\\S]*?)(?=\\n##|$)`, 'i'));
  if (!match) return [];

  const body = (match[1] || '').trim();
  if (!body || /\(empty/i.test(body)) return [];

  const tasks = [];
  const titleRegex = /^Task:\s*(.+)$/gim;
  let titleMatch;
  while ((titleMatch = titleRegex.exec(body))) {
    tasks.push(titleMatch[1].trim());
  }

  if (tasks.length > 0) return tasks;

  return body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^-\s+/.test(line) && !/\(empty/i.test(line))
    .map((line) => line.replace(/^-+\s*/, '').trim());
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getTodayInboxItems(workspaceDir) {
  const atrisDir = path.join(workspaceDir, 'atris');
  const logsDir = path.join(atrisDir, 'logs');
  const todayLog = getTodayLogPath(logsDir);
  if (!fs.existsSync(todayLog)) {
    return { count: 0, preview: [], file: todayLog };
  }

  const logContent = fs.readFileSync(todayLog, 'utf8');
  const inboxMatch = logContent.match(/## Inbox\n([\s\S]*?)(?=\n##|$)/);
  if (!inboxMatch || !inboxMatch[1] || !inboxMatch[1].trim()) {
    return { count: 0, preview: [], file: todayLog };
  }

  const items = inboxMatch[1]
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('-'))
    .map((line) => line.replace(/^-+\s*/, '').trim())
    .filter(Boolean)
    .filter((line) => !/^\(empty/i.test(line));

  return {
    count: items.length,
    preview: items.slice(0, 3),
    file: todayLog,
  };
}

/**
 * Detect workspace state: fresh install, has inbox items, in-progress work, or blocked
 */
function detectWorkspaceState(workspaceDir) {
  const atrisDir = path.join(workspaceDir, 'atris');
  const featuresDir = path.join(atrisDir, 'features');
  const logsDir = path.join(atrisDir, 'logs');
  const mapFile = path.join(atrisDir, 'MAP.md');
  const todoFile = path.join(atrisDir, 'TODO.md');
  const legacyTaskContextFile = path.join(atrisDir, 'TASK_CONTEXTS.md');
  const todayLog = getTodayLogPath(logsDir);

  // Check if atris/ exists
  if (!fs.existsSync(atrisDir)) {
    return { state: 'fresh', reason: 'No atris/ folder found' };
  }

  // Check for in-progress work (features/*/idea.md)
  const inProgressFeatures = getInProgressFeatures(featuresDir);
  if (inProgressFeatures.length > 0) {
    const feature = inProgressFeatures[0];
    return {
      state: 'in-progress',
      feature,
      file: path.join(featuresDir, feature, 'idea.md'),
    };
  }

  // Check for inbox items in today's log
  if (fs.existsSync(todayLog)) {
    const logContent = fs.readFileSync(todayLog, 'utf8');
    const inboxMatch = logContent.match(/## Inbox\n([\s\S]*?)(?=##|$)/);
    if (inboxMatch && inboxMatch[1].trim()) {
      const inboxItems = inboxMatch[1]
        .split('\n')
        .filter(line => line.trim().startsWith('-'))
        .map(line => line.replace(/^-\s*/, '').trim())
        .filter(line => line.length > 0);

      if (inboxItems.length > 0) {
        return {
          state: 'inbox',
          items: inboxItems,
          count: inboxItems.length
        };
      }
    }
  }

  // Check for blocked tasks (prefer TODO.md, fallback to legacy TASK_CONTEXTS.md)
  const taskFilePath = fs.existsSync(todoFile)
    ? todoFile
    : (fs.existsSync(legacyTaskContextFile) ? legacyTaskContextFile : null);
  if (taskFilePath) {
    const content = fs.readFileSync(taskFilePath, 'utf8');
    if (content.includes('Risk Level: High') || content.includes('blocked')) {
      return { state: 'blocked', reason: 'Tasks marked as blocked or high risk' };
    }
  }

  // Default: setup complete but no active work
  return { state: 'ready', reason: 'Setup complete, no active work' };
}

/**
 * Get today's log file path
 */
function getTodayLogPath(logsDir) {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return path.join(logsDir, year.toString(), `${year}-${month}-${day}.md`);
}

/**
 * Load context: MAP, journal, and feature files
 */
function loadContext(workspaceDir) {
  const atrisDir = path.join(workspaceDir, 'atris');
  const mapFile = path.join(atrisDir, 'MAP.md');
  const todayLog = getTodayLogPath(path.join(atrisDir, 'logs'));
  const featuresDir = path.join(atrisDir, 'features');

  const context = {
    mapExists: fs.existsSync(mapFile),
    mapStatus: 'missing',
    mapPath: path.relative(workspaceDir, mapFile),
    hasInbox: false,
    inboxItems: [],
    inboxCount: 0,
    inProgressFeatures: [],
    inProgressFeaturesCount: 0,
    backlogTasks: [],
    inProgressTasks: [],
    completedTasks: [],
    recentLog: null
  };

  // Load MAP
  if (context.mapExists) {
    const mapContent = fs.readFileSync(mapFile, 'utf8');
    context.map = mapContent.split('\n').slice(0, 5); // First 5 lines
    const normalized = mapContent.toLowerCase();
    const isPlaceholder = normalized.includes('generated by your ai agent after reading atris.md')
      || normalized.includes('run your ai agent with atris.md to populate this file');
    context.mapStatus = isPlaceholder ? 'placeholder' : 'ready';
  }

  // Load inbox
  if (fs.existsSync(todayLog)) {
    const logContent = fs.readFileSync(todayLog, 'utf8');
    const inboxMatch = logContent.match(/## Inbox\n([\s\S]*?)(?=##|$)/);
    if (inboxMatch && inboxMatch[1].trim()) {
      const inbox = getTodayInboxItems(workspaceDir);
      context.hasInbox = inbox.count > 0;
      context.inboxItems = inbox.preview;
      context.inboxCount = inbox.count;
      context.recentLog = inbox.file;
    }
  }

  // Load in-progress features
  const allInProgressFeatures = getInProgressFeatures(featuresDir);
  context.inProgressFeatures = allInProgressFeatures.slice(0, 2);
  context.inProgressFeaturesCount = allInProgressFeatures.length;

  // Load tasks (for quick status line)
  context.backlogTasks = getBacklogTasks(atrisDir);
  context.inProgressTasks = getInProgressTasks(atrisDir);
  context.completedTasks = getCompletedTasks(atrisDir);

  return context;
}

module.exports = {
  detectWorkspaceState,
  loadContext,
  getTodayInboxItems,
  getTodayLogPath,
  getBacklogTasks,
  getInProgressTasks
};
