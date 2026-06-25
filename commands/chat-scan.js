const fs = require('fs');
const path = require('path');
const { scanChatLogs, writeLatestScan } = require('../lib/chat-log-scan');

function hasFlag(args, name) {
  return args.includes(name);
}

function readFlag(args, name, fallback) {
  const i = args.indexOf(name);
  if (i === -1 || i === args.length - 1) return fallback;
  return args[i + 1];
}

function printReport(report) {
  console.log('');
  console.log('┌ Chat scan ─────────────────────────────────────────────────┐');
  console.log(`│ sessions ${String(report.summary.sessions).padEnd(3)} │ ax ${String(report.summary.ax_sessions).padEnd(3)} │ cursor ${String(report.summary.cursor_sessions).padEnd(3)} │ findings ${String(report.summary.findings).padEnd(3)} │`);
  console.log('└────────────────────────────────────────────────────────────┘');
  console.log('');
  console.log(`Window: last ${report.window_hours}h`);
  console.log(`Ax logs: ${report.sources.ax_dirs.join(', ') || '(none)'}`);
  console.log(`Cursor: ${report.sources.cursor_roots.join(', ') || '(none)'}`);
  console.log('');

  if (!report.sessions.length) {
    console.log('No recent chat logs found.');
    console.log('  ax --pro --chat writes atris/runs/ax-play-*.log');
    console.log('  Cursor writes ~/.cursor/projects/<slug>/agent-transcripts/*.jsonl');
    return;
  }

  console.log('Recent sessions:');
  for (const session of report.sessions.slice(0, 8)) {
    const label = session.source === 'ax' ? `ax/${session.mode || '?'}` : 'cursor';
    const when = session.started_at || path.basename(session.path);
    const last = session.last_user || session.last_assistant || '(no text captured)';
    console.log(`- [${label}] ${when}`);
    console.log(`  last: ${last}`);
    if (session.interrupted) console.log('  signal: interrupted');
    if (session.log_findings?.length) console.log(`  errors: ${session.log_findings[0]}`);
  }

  if (report.findings.length) {
    console.log('');
    console.log('Problems detected:');
    for (const finding of report.findings.slice(0, 8)) {
      console.log(`- [${finding.severity}] ${finding.title}`);
      if (finding.evidence) console.log(`  ${finding.evidence}`);
    }
    console.log('');
    console.log(`Next: ${report.next_command}`);
  } else {
    console.log('');
    console.log('No problem patterns detected in recent chat logs.');
  }
}

function chatScanCommand(argv = []) {
  const args = argv.filter((a) => a !== '--');
  if (hasFlag(args, '--help') || hasFlag(args, '-h') || args[0] === 'help') {
    console.log(`Usage: atris chat scan [--json] [--hours <n>] [--limit <n>] [--no-write]

Read recent ax chat logs and Cursor agent transcripts; surface friction/errors.

Options:
  --hours <n>   Lookback window (default 720 = 30 days)
  --limit <n>   Max sessions per source (default 12)
  --no-write    Skip writing .atris/state/chat_scan.latest.json
  --json        Machine-readable output`);
    return { ok: true };
  }

  const root = process.cwd();
  if (!fs.existsSync(path.join(root, 'atris'))) {
    console.error('✗ atris/ folder not found. Run from an Atris workspace.');
    process.exit(1);
  }

  const report = scanChatLogs({
    cwd: root,
    hours: readFlag(args, '--hours', 720),
    limit: readFlag(args, '--limit', 12),
  });

  let latestPath = null;
  if (!hasFlag(args, '--no-write')) {
    latestPath = writeLatestScan(root, report);
    report.latest_path = latestPath;
  }

  if (hasFlag(args, '--json')) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report;
  }

  printReport(report);
  if (latestPath) console.log(`\nWrote ${path.relative(root, latestPath)}`);
  return report;
}

module.exports = { chatScanCommand };
