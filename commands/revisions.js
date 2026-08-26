'use strict';

const {
  appendDailySummary,
  computeRevisionMetric,
} = require('../lib/revision-metric');

function plural(count, word) {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

function plainSubject(subject) {
  return String(subject || 'untitled landing')
    .replace(/—/g, ',')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function formatRevisionMetric(metric, saved) {
  const summary = metric.rolling_7_days;
  const lines = [
    `revision signals in the last seven days: ${summary.revision_count} across ${plural(summary.landed_changes, 'atris-assisted landing')}.`,
    `clean so far: ${summary.clean_so_far}. still observing: ${summary.still_observing}. the target is zero revisions.`,
    'this is a same-file git signal, not proof of automatic landing or why a human changed the file.',
  ];
  for (const change of (metric.changes || []).filter((item) => item.revision_count > 0)) {
    lines.push(`"${plainSubject(change.subject)}": ${plural(change.revision_count, 'possible revision')}.`);
  }
  lines.push(saved.appended
    ? `daily summary saved for ${saved.row.date}.`
    : `daily summary for ${saved.row.date} was already saved.`);
  return lines.join('\n');
}

function revisionsCommand(args = [], deps = {}) {
  const root = deps.root || process.cwd();
  const json = args.includes('--json');
  let metric;
  try {
    metric = (deps.computeRevisionMetric || computeRevisionMetric)(root, {
      now: deps.now,
      ref: deps.ref,
    });
  } catch {
    console.error('this folder has no readable git history, so revisions cannot be measured.');
    return 1;
  }
  const saved = (deps.appendDailySummary || appendDailySummary)(root, metric, deps.stateOptions);
  if (json) console.log(JSON.stringify({ ...metric, daily_summary: saved }));
  else console.log(formatRevisionMetric(metric, saved));
  return 0;
}

module.exports = { formatRevisionMetric, plainSubject, revisionsCommand };
