#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const reportPath = path.join(process.cwd(), 'atris/reports/2026-06-30-mission-product-wedge-discovery.md');
const required = [
  'Mission Product Wedge Discovery',
  'Acme is not tonight\'s wedge',
  'Warm buyer mission rooms often waste cycles',
  'Winner: Chaos -> Mission Room',
  'under five minutes',
  'The product is not "AI agents."',
  'Minimum viable wedge: 24/30',
  'Five Candidate Outcomes',
  'Chaos -> Mission Room',
  'Idea -> Buildable Mission',
  'Daily Operating Room',
  'AgentXP Proof Gate',
  'Warm Buyer Close Room',
  'Product-Led Growth Loop',
  'shareable receipt',
  'Run Mission',
  'Next Build Bet',
  'node scripts/verify-mission-product-wedge.js',
];

function fail(message) {
  console.error(`MISSION PRODUCT WEDGE VERIFY FAILED: ${message}`);
  process.exit(1);
}

if (!fs.existsSync(reportPath)) fail(`missing report ${reportPath}`);

const body = fs.readFileSync(reportPath, 'utf8');
for (const phrase of required) {
  if (!body.includes(phrase)) fail(`missing phrase: ${phrase}`);
}

const candidateRows = body
  .split('\n')
  .filter((line) => line.startsWith('| ') && / \| \d \| \d \| \d \| \d \| \d \| \d \| \d+ \| /.test(line));

if (candidateRows.length !== 5) fail(`expected 5 scored candidate rows, found ${candidateRows.length}`);

const winnerRow = candidateRows.find((line) => line.includes('| Chaos -> Mission Room |'));
if (!winnerRow) fail('missing winner row');
if (!winnerRow.includes('| 30 | Winner |')) fail('winner row must score 30 and be marked Winner');

const eliminateBullets = (body.match(/^- Do not /gm) || []).length;
if (eliminateBullets < 6) fail('eliminate section needs at least 6 Do not bullets');

console.log('MISSION PRODUCT WEDGE VERIFIED');
console.log('report=atris/reports/2026-06-30-mission-product-wedge-discovery.md');
console.log(`candidates=${candidateRows.length}`);
console.log('winner=Chaos -> Mission Room');
