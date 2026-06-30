#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const root = process.cwd();
const files = {
  intake: 'atris/context/_ingest/2026-06-29-ai-memory-moat/intake.md',
  page: 'atris/wiki/concepts/ai-memory-moat-enterprise-agents.md',
  index: 'atris/wiki/index.md',
  log: 'atris/wiki/log.md',
  status: 'atris/wiki/STATUS.md',
};

const insights = [
  { label: 'context stickiness', intake: 'Context stickiness', page: 'Context stickiness' },
  { label: 'breadth versus depth', intake: 'Breadth versus depth', page: 'Breadth and depth split' },
  { label: 'Waymo standard', intake: 'Waymo', page: 'Waymo' },
  { label: 'workflow redesign', intake: 'Rethink the workflow', page: 'Workflow redesign beats' },
  { label: 'software with opinions', intake: 'Software with opinions', page: 'Software with opinions' },
  { label: 'headcount impact', intake: 'More engineers', page: 'Headcount impact is uneven' },
  { label: 'token prices', intake: 'Tokens at one-tenth', page: 'Token prices should fall' },
  { label: 'token caps', intake: 'Token allocation trap', page: 'Token caps can punish' },
  { label: 'attacker acceleration', intake: "Attacker's new edge", page: 'Attackers gain from coding models' },
  { label: 'forward-deployed warning', intake: 'forward-deployed', page: 'Forward-deployed' },
  { label: 'platform shifts', intake: 'Three missed tricks', page: 'Missing several platform shifts' },
  { label: 'sunk-cost discipline', intake: 'Sunk cost', page: 'Sunk-cost discipline' },
];

const pageRequirements = [
  'owner-computer-model.md',
  'wiki-as-memory-substrate.md',
  'verifiable-reward-loop.md',
  'glass-interface-principle.md',
  'persistent AI computer',
];

const errors = [];

function read(relativePath) {
  const absolutePath = path.join(root, relativePath);
  if (!fs.existsSync(absolutePath)) {
    errors.push(`missing file: ${relativePath}`);
    return '';
  }
  return fs.readFileSync(absolutePath, 'utf8');
}

const intake = read(files.intake);
const page = read(files.page);
const index = read(files.index);
const log = read(files.log);
const status = read(files.status);

for (const insight of insights) {
  if (!intake.toLowerCase().includes(insight.intake.toLowerCase())) {
    errors.push(`intake missing insight: ${insight.label}`);
  }
  if (!page.toLowerCase().includes(insight.page.toLowerCase())) {
    errors.push(`wiki page missing insight: ${insight.label}`);
  }
}

for (const requirement of pageRequirements) {
  if (!page.includes(requirement)) {
    errors.push(`wiki page missing requirement: ${requirement}`);
  }
}

if (!page.includes(files.intake)) {
  errors.push('wiki page does not cite source intake');
}
if (!index.includes(files.page)) {
  errors.push('wiki index does not link AI memory moat page');
}
if (!log.includes(files.intake) || !log.includes('ai-memory-moat-enterprise-agents.md')) {
  errors.push('wiki log does not record source and destination');
}
if (!status.includes('AI memory moat') || !status.includes('memory plus workflow plus proof')) {
  errors.push('wiki status does not summarize the new memory');
}

if (errors.length) {
  console.error('AI MEMORY MOAT VERIFY FAILED');
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log('AI MEMORY MOAT VERIFIED');
console.log(`insights=${insights.length}`);
console.log(`source=${files.intake}`);
console.log(`page=${files.page}`);
