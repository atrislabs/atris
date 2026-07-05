'use strict';

const path = require('node:path');
const { readResultRecords, taskMetadata } = require('./runner');

const REPORT_SCHEMA = 'atris.bench.report.v1';
const DEFAULT_PACK = 'agents-v1';
const CATEGORY_ORDER = ['navigate', 'edit', 'contract', 'build', 'recover'];

function repoRootFromHere() {
  return path.resolve(__dirname, '..', '..');
}

function isFullRun(record, totalTaskCount) {
  return Array.isArray(record.tasks) && totalTaskCount > 0 && record.tasks.length === totalTaskCount;
}

// Latest full run wins outright; partial runs (from --task filtering) are only
// merged together when the engine never produced a full run of the pack.
function effectiveTasksForEngine(records, totalTaskCount) {
  const sorted = [...records].sort((a, b) => new Date(a.started) - new Date(b.started));
  const fullRuns = sorted.filter((record) => isFullRun(record, totalTaskCount));
  if (fullRuns.length) {
    return fullRuns[fullRuns.length - 1].tasks;
  }
  const merged = new Map();
  for (const record of sorted) {
    for (const task of record.tasks || []) {
      merged.set(task.id, task);
    }
  }
  return Array.from(merged.values());
}

function meanDurationMs(tasks) {
  const durations = tasks
    .filter((task) => !task.skipped)
    .map((task) => Number(task.duration_ms) || 0);
  if (!durations.length) return null;
  const sum = durations.reduce((total, value) => total + value, 0);
  return Math.round(sum / durations.length);
}

function buildBenchReport(options = {}) {
  const repoRoot = path.resolve(options.repoRoot || repoRootFromHere());
  const stateRoot = options.stateRoot || process.cwd();
  const pack = options.pack || DEFAULT_PACK;

  const records = readResultRecords({ stateRoot }).filter((record) => record.pack === pack);
  if (!records.length) {
    return { schema: REPORT_SCHEMA, pack, engines: [] };
  }

  const taskCategories = new Map();
  let totalTaskCount = 0;
  try {
    const tasks = taskMetadata({ repoRoot, pack });
    totalTaskCount = tasks.length;
    for (const task of tasks) taskCategories.set(task.id, task.category || null);
  } catch (err) {
    // degrade instead of crashing the report: fall back to the largest observed run
    totalTaskCount = records.reduce((max, record) => Math.max(max, (record.tasks || []).length), 0);
  }

  const byEngine = new Map();
  for (const record of records) {
    const engineName = record.engine || 'unknown';
    if (!byEngine.has(engineName)) byEngine.set(engineName, []);
    byEngine.get(engineName).push(record);
  }

  const categoryTotals = new Map();
  for (const category of taskCategories.values()) {
    if (!category) continue;
    categoryTotals.set(category, (categoryTotals.get(category) || 0) + 1);
  }

  const engines = Array.from(byEngine.keys())
    .sort((a, b) => a.localeCompare(b))
    .map((engineName) => {
      const tasks = effectiveTasksForEngine(byEngine.get(engineName), totalTaskCount);
      const passed = tasks.filter((task) => task.passed && !task.skipped);
      const failed = tasks.filter((task) => !task.passed && !task.skipped);
      const skipped = tasks.filter((task) => task.skipped);

      const categories = CATEGORY_ORDER.map((name) => {
        const categoryTasks = tasks.filter((task) => taskCategories.get(task.id) === name);
        const categoryPassed = categoryTasks.filter((task) => task.passed && !task.skipped);
        return {
          name,
          passed: categoryPassed.length,
          total: categoryTotals.get(name) || 0,
        };
      });

      return {
        engine: engineName,
        passed: passed.length,
        total: totalTaskCount,
        categories,
        meanDurationMs: meanDurationMs(tasks),
        failed: failed.map((task) => task.id),
        skipped: skipped.length,
      };
    });

  return { schema: REPORT_SCHEMA, pack, engines };
}

function formatDuration(ms) {
  if (ms === null || ms === undefined) return 'n/a';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function renderBenchReportText(report) {
  if (!report.engines.length) {
    return `no runs recorded for pack ${report.pack}`;
  }
  const lines = [`pack: ${report.pack}`, ''];
  for (const engine of report.engines) {
    lines.push(`engine: ${engine.engine}`);
    lines.push(`  score      ${engine.passed}/${engine.total} passed`);
    for (const category of engine.categories) {
      lines.push(`  ${category.name.padEnd(10)} ${category.passed}/${category.total}`);
    }
    lines.push(`  mean dur   ${formatDuration(engine.meanDurationMs)}`);
    lines.push(`  skipped    ${engine.skipped}`);
    lines.push(`  failed     ${engine.failed.length ? engine.failed.join(', ') : 'none'}`);
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

module.exports = {
  DEFAULT_PACK,
  REPORT_SCHEMA,
  buildBenchReport,
  renderBenchReportText,
};
