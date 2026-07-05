'use strict';

const fs = require('fs');
const path = require('path');

const { getLogPath } = require('../lib/file-ops');
const { parseJournalSections } = require('../lib/journal');
const { isDoneSection } = require('../lib/todo-sections');
const { parseSection } = require('../lib/todo-fallback');

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_DAYS = 7;
const TASK_PROJECTION_FILE = path.join('.atris', 'state', 'tasks.projection.json');
const CAREER_XP_RECEIPTS_FILE = path.join('.atris', 'state', 'career_xp_receipts.jsonl');

function readProjection(root) {
  const projectionPath = path.join(root, TASK_PROJECTION_FILE);
  if (!fs.existsSync(projectionPath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(projectionPath, 'utf8'));
    return Array.isArray(parsed.tasks) ? parsed.tasks : null;
  } catch (e) {
    return null;
  }
}

function asWindowDays(days) {
  const parsed = Number(days);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_DAYS;
}

function timestampMs(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function inlineText(value, fallback = 'untitled') {
  const text = String(value || '').replace(/[—–]/g, '-').replace(/\s+/g, ' ').trim();
  return text || fallback;
}

function formatXp(value) {
  const number = Number(value) || 0;
  return Number.isInteger(number) ? String(number) : String(Math.round(number * 100) / 100);
}

function localDateKey(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function lastDateKeys(days, now) {
  const end = new Date(now);
  if (!Number.isFinite(end.getTime())) return lastDateKeys(days, Date.now());
  const dates = [];
  for (let offset = 0; offset < days; offset += 1) {
    const date = new Date(end);
    date.setDate(end.getDate() - offset);
    const key = localDateKey(date);
    if (key) dates.push(key);
  }
  return dates;
}

function withWorkspaceCwd(root, fn) {
  const previous = process.cwd();
  process.chdir(root);
  try {
    return fn();
  } finally {
    process.chdir(previous);
  }
}

function buildLandings(root, cutoff) {
  const tasks = readProjection(root) || [];
  return tasks
    .filter(task => task && task.status === 'done' && Number(timestampMs(task.done_at)) >= cutoff)
    .sort((a, b) => Number(timestampMs(b.done_at) || 0) - Number(timestampMs(a.done_at) || 0))
    .map((task) => {
      const id = inlineText(task.display_id || task.task_ref || task.id, 'task');
      return {
        id,
        title: inlineText(task.title, 'untitled task'),
        done_at: task.done_at || null,
        source: `task ${id}`,
      };
    });
}

function buildJournalCompletions(root, days, now) {
  return withWorkspaceCwd(root, () => {
    const completions = [];
    for (const dateKey of lastDateKeys(days, now)) {
      const { logFile, dateFormatted } = getLogPath(`${dateKey}T12:00:00`);
      if (!fs.existsSync(logFile)) continue;
      let content;
      try {
        content = fs.readFileSync(logFile, 'utf8');
      } catch (e) {
        continue;
      }
      const sections = parseJournalSections(content);
      for (const [sectionName, sectionContent] of Object.entries(sections)) {
        if (!isDoneSection(sectionName)) continue;
        for (const item of parseSection(sectionContent, 'Completed')) {
          completions.push({
            id: item.id || null,
            title: inlineText(item.title, 'completed item'),
            date: dateFormatted,
            source: `journal ${dateFormatted}`,
          });
        }
      }
    }
    return completions;
  });
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const rows = [];
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      rows.push(JSON.parse(trimmed));
    } catch (e) {
      // A weekly report should stay readable even if a local ledger has a bad row.
    }
  }
  return rows;
}

function receiptAmount(receipt) {
  const value = receipt?.xp ?? receipt?.amount ?? receipt?.reward ?? receipt?.delta_agent_xp ?? receipt?.delta_xp;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function receiptTime(receipt) {
  return receipt?.accepted_at || receipt?.timestamp || receipt?.created_at || receipt?.at || receipt?.date || null;
}

function receiptSource(receipt) {
  if (receipt?.receipt_id) return `receipt ${inlineText(receipt.receipt_id)}`;
  if (receipt?.source_task_id) return `receipt for task ${inlineText(receipt.source_task_id)}`;
  if (receipt?.task_ref) return `receipt for task ${inlineText(receipt.task_ref)}`;
  return 'career xp receipt';
}

function buildXp(root, cutoff) {
  const receiptsPath = path.join(root, CAREER_XP_RECEIPTS_FILE);
  const receipts = readJsonl(receiptsPath)
    .map((receipt) => {
      const amount = receiptAmount(receipt);
      const timestamp = receiptTime(receipt);
      return {
        receipt,
        amount,
        timestamp,
        timestamp_ms: timestampMs(timestamp),
      };
    })
    .filter(row => row.amount > 0)
    .filter(row => !row.receipt?.outcome || row.receipt.outcome === 'accepted')
    .filter(row => Number(row.timestamp_ms) >= cutoff)
    .sort((a, b) => Number(b.timestamp_ms || 0) - Number(a.timestamp_ms || 0))
    .map((row) => ({
      receipt_id: row.receipt.receipt_id || null,
      source_task_id: row.receipt.source_task_id || row.receipt.task_ref || null,
      title: inlineText(row.receipt.title || row.receipt.goal || row.receipt.source_task_id || row.receipt.task_ref || row.receipt.receipt_id, 'career xp receipt'),
      amount: row.amount,
      timestamp: row.timestamp,
      source: receiptSource(row.receipt),
    }));
  const total = receipts.reduce((sum, receipt) => sum + receipt.amount, 0);
  return { total, receipts };
}

function buildWeekReportData(root = process.cwd(), { days = DEFAULT_DAYS, now = Date.now() } = {}) {
  const windowDays = asWindowDays(days);
  const nowMs = timestampMs(now) || Date.now();
  const cutoff = nowMs - windowDays * DAY_MS;
  const landings = buildLandings(root, cutoff);
  const completions = buildJournalCompletions(root, windowDays, nowMs);
  const xp = buildXp(root, cutoff);
  return {
    empty: landings.length === 0 && completions.length === 0 && xp.total <= 0,
    days: windowDays,
    landings,
    completions,
    xp,
  };
}

function renderWeekReport(data) {
  const landings = Array.isArray(data?.landings) ? data.landings : [];
  const completions = Array.isArray(data?.completions) ? data.completions : [];
  const xp = data?.xp && typeof data.xp === 'object' ? data.xp : { total: 0, receipts: [] };
  const receipts = Array.isArray(xp.receipts) ? xp.receipts : [];
  const lines = [
    `week in review: ${landings.length} landed, ${completions.length} completions, ${formatXp(xp.total)} xp`,
  ];

  if (data?.empty) {
    lines.push('');
    lines.push(`quiet week: no landings, journal completions, or xp receipts found in the last ${data.days || DEFAULT_DAYS} days.`);
    return lines.join('\n');
  }

  if (landings.length) {
    lines.push('');
    lines.push(`landings: ${landings.length} tasks, known from task projection`);
    for (const landing of landings) {
      lines.push(`- landed: ${inlineText(landing.title)} | size: 1 task | know: ${inlineText(landing.source || landing.id, 'task')}`);
    }
  }

  if (completions.length) {
    lines.push('');
    lines.push(`journal completions: ${completions.length} items, known from daily logs`);
    for (const completion of completions) {
      lines.push(`- completed: ${inlineText(completion.title)} | size: 1 journal item | know: ${inlineText(completion.source, 'journal')}`);
    }
  }

  if (receipts.length) {
    lines.push('');
    lines.push(`career xp: ${formatXp(xp.total)} xp, known from ${receipts.length} receipts`);
    for (const receipt of receipts) {
      lines.push(`- xp: ${inlineText(receipt.title, 'career xp receipt')} | size: ${formatXp(receipt.amount)} xp | know: ${inlineText(receipt.source, 'career xp receipt')}`);
    }
  }

  return lines.join('\n');
}

function showReportHelp() {
  console.log('Usage: atris report [week] [--days=N] [--json]');
  console.log('Shows landings, journal completions, and Career XP for the last N days.');
}

function readDaysFlag(args) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--days' && args[index + 1]) return args[index + 1];
    if (arg.startsWith('--days=')) return arg.slice('--days='.length);
  }
  return DEFAULT_DAYS;
}

function positionalArgs(args) {
  const positionals = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--days') {
      index += 1;
      continue;
    }
    if (arg.startsWith('--')) continue;
    positionals.push(arg);
  }
  return positionals;
}

function reportCommand(args = []) {
  const argv = Array.isArray(args) ? args : Array.from(arguments);
  if (argv.includes('--help') || argv.includes('-h') || argv[0] === 'help') {
    showReportHelp();
    return 0;
  }

  const positionals = positionalArgs(argv);
  if (positionals.length > 1 || (positionals[0] && positionals[0] !== 'week')) {
    showReportHelp();
    return 1;
  }

  const data = buildWeekReportData(process.cwd(), { days: readDaysFlag(argv) });
  if (argv.includes('--json')) {
    console.log(JSON.stringify(data, null, 2));
    return 0;
  }
  console.log(renderWeekReport(data));
  return 0;
}

module.exports = {
  buildWeekReportData,
  renderWeekReport,
  reportCommand,
  showReportHelp,
};
