#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const reportPath = path.join(process.cwd(), 'atris/reports/2026-06-30-30-day-runway-cash-sprint.md');
const required = [
  '30 days',
  'DoorDash PO',
  'not invoiced yet',
  'July 1, 2026',
  'invoice packet',
  'AP/procurement',
  'earliest payable date',
  '7-day paid pilot',
  'invoice-first terms',
  'Daily Operating Loop',
  'Eliminate',
  'No new mission without a verifier or receipt',
  'node scripts/verify-runway-cash-sprint.js',
];

function fail(message) {
  console.error(`RUNWAY CASH SPRINT VERIFY FAILED: ${message}`);
  process.exit(1);
}

if (!fs.existsSync(reportPath)) fail(`missing report ${reportPath}`);

const body = fs.readFileSync(reportPath, 'utf8');
for (const phrase of required) {
  if (!body.includes(phrase)) fail(`missing phrase: ${phrase}`);
}

const tomorrowChecklist = (body.match(/^## July 1, 2026 Cash Day$/m) || []).length;
if (tomorrowChecklist !== 1) fail('missing unique July 1 cash day section');

const numberedActions = body.match(/^\d+\. /gm) || [];
if (numberedActions.length < 5) fail('July 1 cash day needs at least 5 numbered actions');

console.log('RUNWAY CASH SPRINT VERIFIED');
console.log('report=atris/reports/2026-06-30-30-day-runway-cash-sprint.md');
console.log(`actions=${numberedActions.length}`);
