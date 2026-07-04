const fs = require('fs');
const path = require('path');
const { countTaskReceiptsToday, countJournalCompletedReceipts } = require('./now');

function analyticsAtris() {
  const targetDir = path.join(process.cwd(), 'atris');

  if (!fs.existsSync(targetDir)) {
    console.log('✗ atris/ folder not found. Run "atris init" first.');
    process.exit(1);
  }

  // Get date range (today + last 7 days)
  const today = new Date();
  const dates = [];
  for (let i = 0; i < 7; i++) {
    const date = new Date(today);
    date.setDate(date.getDate() - i);
    dates.push(date);
  }

  // Parse journals and collect data
  let totalCompletions = 0;
  let todayCompletions = 0;
  let todayInbox = 0;
  let oldestInbox = 0;
  const completionsByDay = {};
  const hourCounts = {};

  dates.forEach((date, index) => {
    const year = date.getFullYear();
    // Use local timezone, not UTC (fixes timezone bug)
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const dateFormatted = `${year}-${month}-${day}`;
    const logPath = path.join(targetDir, 'logs', year.toString(), `${dateFormatted}.md`);

    // Durable task receipts are the completion truth in the task-db era;
    // journal C# entries remain the legacy fallback. Same precedence as
    // `atris now`, so the two surfaces report the same number.
    const receiptCount = countTaskReceiptsToday(process.cwd(), date);

    if (!fs.existsSync(logPath)) {
      completionsByDay[dateFormatted] = receiptCount;
      totalCompletions += receiptCount;
      if (index === 0) todayCompletions = receiptCount;
      return;
    }

    const content = fs.readFileSync(logPath, 'utf8');

    // Same precedence chain as `atris now`: durable receipts, then the shared
    // journal heuristic (Proof: lines, then C# entries) — so the two surfaces
    // report the same completion number by construction.
    const completionCount = receiptCount || countJournalCompletedReceipts(logPath);
    completionsByDay[dateFormatted] = completionCount;
    totalCompletions += completionCount;

    if (index === 0) {
      todayCompletions = completionCount;

      // Count today's inbox
      const inboxMatch = content.match(/## Inbox\r?\n([\s\S]*?)(?=\r?\n##|---|$)/);
      if (inboxMatch && inboxMatch[1].trim()) {
        const inboxMatches = inboxMatch[1].match(/- \*\*I\d+:/g);
        todayInbox = inboxMatches ? inboxMatches.length : 0;
      }
    }

    if (index === 6) {
      // Count oldest day's inbox for trend
      const inboxMatch = content.match(/## Inbox\r?\n([\s\S]*?)(?=\r?\n##|---|$)/);
      if (inboxMatch && inboxMatch[1].trim()) {
        const inboxMatches = inboxMatch[1].match(/- \*\*I\d+:/g);
        oldestInbox = inboxMatches ? inboxMatches.length : 0;
      }
    }

    // Parse timestamps for productivity hours. Match the journal heading
    // format `### Title — HH:MM` and the legacy `**HH:MM:SS**` form.
    const timestampMatches = content.match(/(?:—|--)\s*(\d{2}):\d{2}(?::\d{2})?\b|\*\*(\d{2}):\d{2}(?::\d{2})?\*\*/g);
    if (timestampMatches) {
      timestampMatches.forEach(ts => {
        const m = ts.match(/(\d{2}):/);
        if (!m) return;
        const hour = parseInt(m[1], 10);
        if (Number.isFinite(hour) && hour >= 0 && hour < 24) {
          hourCounts[hour] = (hourCounts[hour] || 0) + 1;
        }
      });
    }
  });

  // Calculate metrics
  const velocity = (totalCompletions / 7).toFixed(1);
  const inboxTrend = todayInbox > oldestInbox ? 'Growing ⬆' :
                     todayInbox < oldestInbox ? 'Shrinking ⬇' :
                     'Stable →';

  // Find most productive hour
  let mostProductiveHour = null;
  let maxCount = 0;
  Object.keys(hourCounts).forEach(hour => {
    if (hourCounts[hour] > maxCount) {
      maxCount = hourCounts[hour];
      mostProductiveHour = hour;
    }
  });

  const productiveHours = mostProductiveHour !== null ?
    `${mostProductiveHour}:00 - ${(parseInt(mostProductiveHour) + 1) % 24}:00` :
    'No data';

  // Display analytics
  // Use local timezone, not UTC (fixes timezone bug)
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, '0');
  const day = String(today.getDate()).padStart(2, '0');
  const dateFormatted = `${year}-${month}-${day}`;
  console.log('');
  console.log('┌─────────────────────────────────────────────────────────────┐');
  console.log(`│ Atris Analytics — ${dateFormatted}${' '.repeat(34 - dateFormatted.length)}│`);
  console.log('└─────────────────────────────────────────────────────────────┘');
  console.log('');

  // Today's performance
  console.log(`📊 Today's Performance`);
  console.log(`   Completions: ${todayCompletions}`);
  console.log(`   Inbox items: ${todayInbox}`);
  console.log('');

  // Weekly trends
  console.log(`📈 Weekly Trends (Last 7 Days)`);
  console.log(`   Total completions: ${totalCompletions}`);
  console.log(`   Average velocity: ${velocity} completions/day`);
  console.log(`   Inbox trend: ${inboxTrend}`);
  console.log('');

  // Productivity patterns
  console.log(`⏰ Productivity Patterns`);
  console.log(`   Most active hour: ${productiveHours}`);
  console.log(`   Activity count: ${maxCount} timestamps`);
  console.log('');

  // Daily breakdown
  console.log(`📅 Daily Breakdown`);
  const sortedDates = Object.keys(completionsByDay).sort().reverse();
  // Cap the bar so a high-count day can't overflow the 63-char box; the exact
  // count is still printed numerically after it. Mirrors `mission layers`.
  const BAR_MAX = 40;
  sortedDates.forEach((date, index) => {
    const count = completionsByDay[date];
    const bar = '█'.repeat(Math.min(count, BAR_MAX));
    const label = index === 0 ? ' (today)' : '';
    console.log(`   ${date}: ${bar} ${count}${label}`);
  });
  console.log('');

  console.log('─────────────────────────────────────────────────────────────');
  console.log('💡 Insight: This data syncs to backend via "atris log sync"');
  console.log('');
}


module.exports = {
  analyticsAtris
};
