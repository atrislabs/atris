const fs = require('fs');
const path = require('path');
const { getLogPath, ensureLogDirectory, createLogFile } = require('../lib/journal');
const { detectWorkspaceState, loadContext } = require('../lib/state-detection');
const { readWikiStatus } = require('../lib/wiki');
const { gateForHuman, numberWord } = require('../lib/voice-gate');

const CLARITY_FIELDS = [
  { key: 'focus', label: 'Focus' },
  { key: 'voice', label: 'Voice' },
  { key: 'cadence', label: 'Cadence' },
  { key: 'done', label: 'Done means' },
  { key: 'leash', label: 'Leash' },
];

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function readClarityMarkdownProfile(mdPath) {
  try {
    const content = fs.readFileSync(mdPath, 'utf8');
    const profile = {};
    for (const { key, label } of CLARITY_FIELDS) {
      const match = content.match(new RegExp(`^- ${escapeRegExp(label)}: (.+)$`, 'm'));
      if (match?.[1]?.trim()) profile[key] = match[1].trim();
    }
    return profile;
  } catch {
    return {};
  }
}

function readActivationClarityProfile(root, profilePaths) {
  const paths = profilePaths(root);
  if (fs.existsSync(paths.json)) {
    try {
      return { profile: JSON.parse(fs.readFileSync(paths.json, 'utf8')), mdPath: paths.md };
    } catch {
      return { profile: {}, mdPath: paths.md };
    }
  }
  if (fs.existsSync(paths.md)) {
    return { profile: readClarityMarkdownProfile(paths.md), mdPath: paths.md };
  }
  return { profile: {}, mdPath: paths.md };
}

function formatClarityLine(profile, mdRelPath) {
  const parts = CLARITY_FIELDS
    .map(({ key }) => (profile?.[key] ? `${key} ${profile[key]}` : null))
    .filter(Boolean);
  if (!parts.length) return null;
  return `clarity: ${parts.join(', ')} (see ${mdRelPath})`;
}

function countWord(value) {
  const count = Math.max(0, Math.trunc(Number(value) || 0));
  return numberWord(count);
}

function sentenceFragment(value) {
  return String(value || '')
    .replace(/[`*_#>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.!?]+$/, '');
}

function humanSentence(value) {
  return gateForHuman(value).text.toLowerCase();
}

// Titles arrive with tracker tags and stacked clauses; the narration keeps
// one readable clause so the operator can take it in at a glance.
function focusFragment(value, max = 72) {
  const first = sentenceFragment(value)
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .split(';')[0]
    .trim();
  if (first.length <= max) return first;
  const cut = first.slice(0, max);
  return `${cut.slice(0, cut.lastIndexOf(' '))}...`;
}

// A truncated fragment already ends with '...'; adding the template's period
// would render four dots.
function closeSentence(fragment) {
  return fragment.endsWith('...') ? fragment : `${fragment}.`;
}

// The handoff block is markdown for agents; the operator gets its context
// line as one plain sentence.
function handoffSentence(handoffContent) {
  if (!handoffContent) return null;
  const contextMatch = String(handoffContent).match(/\*\*Context:\*\*\s*(.+)/);
  const note = focusFragment(contextMatch?.[1] || handoffContent, 100);
  if (!note) return null;
  return humanSentence(`last session left a note: ${closeSentence(note)}`);
}

function completionSentence(completions) {
  if (!Array.isArray(completions) || !completions.length) return null;
  const count = completions.length;
  const biggest = sentenceFragment(completions[0]?.desc);
  if (!biggest) return null;
  const landed = count === 1 ? 'one thing landed' : `${countWord(count)} things landed`;
  return humanSentence(`since last time: ${landed}; the biggest: ${biggest}.`);
}

function activeWorkSentence(state, context) {
  const tasks = Array.isArray(context?.inProgressTasks) ? context.inProgressTasks : [];
  if (tasks.length) {
    const count = tasks.length;
    const focus = focusFragment(tasks[0]);
    const subject = count === 1 ? 'task is' : 'tasks are';
    return humanSentence(`right now: ${countWord(count)} ${subject} in progress; the focus is ${closeSentence(focus)}`);
  }

  const features = Array.isArray(context?.inProgressFeatures) ? context.inProgressFeatures : [];
  const featureCount = Number(context?.inProgressFeaturesCount) || features.length;
  if (featureCount > 0 && features.length) {
    const focus = focusFragment(features[0]).replace(/[-_]+/g, ' ');
    const subject = featureCount === 1 ? 'feature is' : 'features are';
    return humanSentence(`right now: ${countWord(featureCount)} ${subject} in progress; the focus is ${closeSentence(focus)}`);
  }

  const inboxCount = Number(context?.inboxCount) || 0;
  const inboxItem = sentenceFragment(context?.inboxItems?.[0]);
  if (inboxCount > 0 && inboxItem) {
    const subject = inboxCount === 1 ? 'inbox item is' : 'inbox items are';
    return humanSentence(`right now: ${countWord(inboxCount)} ${subject} waiting; first: ${closeSentence(inboxItem)}`);
  }

  if (state?.state === 'blocked' && state.reason) {
    return humanSentence(`right now: work is blocked by ${sentenceFragment(state.reason)}.`);
  }
  if (state?.state === 'ready') {
    return humanSentence('right now: no active work is in progress.');
  }
  if (state?.state) {
    return humanSentence(`right now: the workspace is ${sentenceFragment(state.state)}.`);
  }
  return null;
}

function activateAtris() {
  const workspaceDir = process.cwd();
  const targetDir = path.join(workspaceDir, 'atris');

  if (!fs.existsSync(targetDir)) {
    console.log('✗ atris/ folder not found. Run "atris init" first.');
    process.exit(1);
  }

  const personaFile = path.join(targetDir, 'PERSONA.md');
  const mapFile = path.join(targetDir, 'MAP.md');
  const todoFile = path.join(targetDir, 'TODO.md');
  const legacyTaskContextsFile = path.join(targetDir, 'TASK_CONTEXTS.md');

  // Journal (create today's file if missing so the system is always runnable)
  ensureLogDirectory();
  const { logFile, dateFormatted } = getLogPath();
  if (!fs.existsSync(logFile)) {
    createLogFile(logFile, dateFormatted);
  }

  const state = detectWorkspaceState(workspaceDir);
  const context = loadContext(workspaceDir);
  const wikiStatus = readWikiStatus(workspaceDir);

  // Check for handoff from previous session
  let handoffContent = null;
  if (fs.existsSync(logFile)) {
    const journalContent = fs.readFileSync(logFile, 'utf8');
    const handoffMatch = journalContent.match(/## Handoff\n([\s\S]*?)(?=\n---|\n## |$)/);
    if (handoffMatch && handoffMatch[1].trim() && handoffMatch[1].includes('**Context:**')) {
      handoffContent = handoffMatch[1].trim();
    }
  }

  // Get last 3 completions from journal logs
  let recentCompletions = [];
  const logsDir = path.join(targetDir, 'logs');
  if (fs.existsSync(logsDir)) {
    const allLogs = [];
    const yearDirs = fs.readdirSync(logsDir).filter(d => /^\d{4}$/.test(d));
    for (const year of yearDirs) {
      const yearPath = path.join(logsDir, year);
      if (fs.statSync(yearPath).isDirectory()) {
        const files = fs.readdirSync(yearPath).filter(f => f.endsWith('.md'));
        files.forEach(f => allLogs.push(path.join(yearPath, f)));
      }
    }
    // Sort descending (most recent first)
    allLogs.sort().reverse();

    // Extract C# items from logs until we have 3. Dedupe by ID across files
    // since per-day numbering reuses C1, C2, etc. the same ID appearing
    // in two day-files would otherwise render as duplicate rows.
    const seenIds = new Set();
    for (const logPath of allLogs) {
      if (recentCompletions.length >= 3) break;
      const content = fs.readFileSync(logPath, 'utf8');
      const completedSection = content.match(/## Completed ✅\n([\s\S]*?)(?=\n## |$)/);
      if (completedSection) {
        // Match `- **C#: Title**` (title between the bold markers). If extra
        // prose follows after `**`, ignore it. the activation view shows
        // titles only, truncated to 59 chars.
        const matches = completedSection[1].matchAll(/- \*\*C(\d+):\s*([^*\n]+?)\*\*/gm);
        for (const match of matches) {
          if (recentCompletions.length >= 3) break;
          const id = `C${match[1]}`;
          if (seenIds.has(id)) continue;
          seenIds.add(id);
          recentCompletions.push({ id, desc: match[2].trim(), file: path.basename(logPath) });
        }
      }
    }
  }

  const rel = (p) => path.relative(workspaceDir, p);
  const taskFilePath = fs.existsSync(todoFile)
    ? todoFile
    : (fs.existsSync(legacyTaskContextsFile) ? legacyTaskContextsFile : null);

  // Keep loading learnings for parity with the existing activation path.
  let learningCount = 0;
  try {
    const learningsPath = path.join(targetDir, 'learnings.jsonl');
    if (fs.existsSync(learningsPath)) {
      const lines = fs.readFileSync(learningsPath, 'utf8').trim().split('\n').filter(Boolean);
      learningCount = lines.length;
    }
  } catch {}

  let moves = [];
  try {
    const { nextMoves } = require('../lib/next-moves');
    const { profilePaths } = require('../lib/clarity');
    const root = process.cwd();
    moves = nextMoves(root, 3);
    const { profile, mdPath } = readActivationClarityProfile(root, profilePaths);
    formatClarityLine(profile, rel(mdPath));
  } catch { /* alive onboarding is best-effort; never block activate */ }

  let briefData = null;
  try {
    const { buildBriefData } = require('./brief');
    briefData = buildBriefData(workspaceDir);
  } catch { /* brief is best-effort */ }
  try {
    const { syncStatus } = require('../lib/sync-status');
    syncStatus(workspaceDir);
  } catch { /* sync status is best-effort */ }

  void dateFormatted;
  void learningCount;
  void wikiStatus;
  fs.existsSync(personaFile);
  fs.existsSync(mapFile);
  void taskFilePath;

  console.log(humanSentence('atris is up.'));

  const statusLines = [
    handoffSentence(handoffContent),
    completionSentence(recentCompletions),
    activeWorkSentence(state, context),
  ].filter(Boolean);
  if (Array.isArray(briefData?.waiting)) {
    const approvalCount = briefData.waiting.length;
    if (approvalCount === 0) {
      statusLines.push('nothing is waiting on you.');
    } else {
      const approvalLabel = approvalCount === 1 ? 'approval' : 'approvals';
      statusLines.push(`waiting on you: ${countWord(approvalCount)} ${approvalLabel}. see them: atris task reviews`);
    }
  }
  if (statusLines.length) {
    console.log('');
    statusLines.forEach((line) => console.log(line));
  }

  const nextMove = moves[0] || briefData?.moves?.[0];
  const nextMoveTitle = focusFragment(nextMove?.title, 100);
  if (nextMoveTitle) {
    console.log('');
    console.log(humanSentence(`today's move: ${closeSentence(nextMoveTitle)}`));
  }
}

module.exports = { activateAtris };
