const fs = require('fs');
const path = require('path');

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

    if (!fs.existsSync(logPath)) {
      completionsByDay[dateFormatted] = 0;
      return;
    }

    const content = fs.readFileSync(logPath, 'utf8');

    // Count completions (C# pattern)
    const completionMatches = content.match(/- \*\*C\d+:/g);
    const completionCount = completionMatches ? completionMatches.length : 0;
    completionsByDay[dateFormatted] = completionCount;
    totalCompletions += completionCount;

    if (index === 0) {
      todayCompletions = completionCount;

      // Count today's inbox
      const inboxMatch = content.match(/## Inbox\n([\s\S]*?)(?=\n##|---)/);
      if (inboxMatch && inboxMatch[1].trim()) {
        const inboxMatches = inboxMatch[1].match(/- \*\*I\d+:/g);
        todayInbox = inboxMatches ? inboxMatches.length : 0;
      }
    }

    if (index === 6) {
      // Count oldest day's inbox for trend
      const inboxMatch = content.match(/## Inbox\n([\s\S]*?)(?=\n##|---)/);
      if (inboxMatch && inboxMatch[1].trim()) {
        const inboxMatches = inboxMatch[1].match(/- \*\*I\d+:/g);
        oldestInbox = inboxMatches ? inboxMatches.length : 0;
      }
    }

    // Parse timestamps for productivity hours
    const timestampMatches = content.match(/\*\*(\d{2}):(\d{2}):(\d{2})\*\*/g);
    if (timestampMatches) {
      timestampMatches.forEach(ts => {
        const hour = parseInt(ts.match(/\d{2}/)[0]);
        hourCounts[hour] = (hourCounts[hour] || 0) + 1;
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
  sortedDates.forEach((date, index) => {
    const count = completionsByDay[date];
    const bar = '█'.repeat(count);
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
