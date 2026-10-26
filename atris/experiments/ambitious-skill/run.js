#!/usr/bin/env node
'use strict';

// Produces three answers per task: plain, nudge, skill. See README.md.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const HERE = __dirname;
const OUT = path.join(HERE, process.env.AMB_OUT || 'out');
const SKILL = fs.readFileSync(path.join(HERE, '..', '..', 'skills', 'ambitious', 'SKILL.md'), 'utf8');
const TASKS = JSON.parse(fs.readFileSync(path.join(HERE, process.env.AMB_TASKS || 'tasks.json'), 'utf8'));
const WORKER = process.env.AMB_WORKER || 'claude-sonnet-5-5';
const NUDGE = 'Be ambitious: do the deeper, better version of this that a top professional in the field would do.';
const EMPTY = fs.mkdtempSync(path.join(os.tmpdir(), 'amb-run-'));

function claude(prompt, system) {
  const args = ['-p', prompt, '--model', WORKER, '--tools', '', '--setting-sources', '', '--strict-mcp-config'];
  if (system) args.push('--append-system-prompt', system);
  return new Promise((resolve, reject) => {
    const child = spawn('claude', args, { cwd: EMPTY, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => (code === 0 && out.trim() ? resolve(out.trim()) : reject(new Error(`claude exit ${code}: ${err.slice(0, 300)}`))));
  });
}

function deeperTask(rewrite) {
  const at = rewrite.search(/deeper task:/i);
  if (at === -1) throw new Error('rewrite has no "deeper task:" section');
  return rewrite.slice(at).replace(/^deeper task:\s*/i, '').replace(/```\s*$/, '').trim();
}

async function runTask(t) {
  const file = path.join(OUT, `${t.id}.json`);
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  const rewriteSystem = `${SKILL}\n\nOnly produce the output shape block (the four answers and the deeper task). Do not do the task.`;
  const [plain, nudge, rewrite] = await Promise.all([
    claude(t.task),
    claude(`${t.task}\n\n${NUDGE}`),
    claude(t.task, rewriteSystem),
  ]);
  const deeper = deeperTask(rewrite);
  const skill = await claude(deeper);
  const record = { ...t, rewrite, deeper, answers: { plain, nudge, skill } };
  fs.writeFileSync(file, JSON.stringify(record, null, 2));
  console.log(`done ${t.id}  words plain=${wc(plain)} nudge=${wc(nudge)} skill=${wc(skill)}`);
  return record;
}

const wc = (s) => s.split(/\s+/).filter(Boolean).length;

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const queue = [...TASKS];
  const workers = Array.from({ length: Number(process.env.AMB_PARALLEL || 4) }, async () => {
    while (queue.length) {
      const t = queue.shift();
      try { await runTask(t); } catch (e) { console.error(`fail ${t.id}: ${e.message}`); process.exitCode = 1; }
    }
  });
  await Promise.all(workers);
}

main();
