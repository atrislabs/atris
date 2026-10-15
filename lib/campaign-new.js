// atris campaign new "<goal>": the owner's engine drafts a judge for the goal,
// the CLI runs it to prove it fails today, shows the draft, and with --yes
// starts the campaign. A judge is a script outside the model: exit 0 means the
// goal is met. Asking goes through the read-only engine ask runner, the same
// way the campaign loop asks the owner for missions.

'use strict';

const fs = require('fs');
const path = require('path');
const { newCampaignId } = require('./campaign-store');

const DEFAULT_BUDGET = 20;
const DEFAULT_OWNER = 'mission-lead';
const DRAFT_TIMEOUT_SECONDS = 10 * 60;
const ASK_TIMEOUT_MS = 5 * 60 * 1000;
const ATTEMPTS = 2;
const MAX_SEATS = 3;
const MAX_SCRIPT_BYTES = 8 * 1024;

function money(value) {
  return `$${Number(value).toFixed(2)}`;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

// Members with a MEMBER.md can take a seat.
function teamMembers(root) {
  const dir = path.join(root, 'atris', 'team');
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('_') && fs.existsSync(path.join(dir, entry.name, 'MEMBER.md')))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

// A few facts about the workspace so the judge uses commands that exist here.
function workspaceHints(root) {
  const lines = [];
  try {
    const entries = fs.readdirSync(root).filter((name) => !name.startsWith('.')).sort().slice(0, 30);
    if (entries.length) lines.push(`Top-level files: ${entries.join(', ')}`);
  } catch {}
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const scripts = Object.entries(pkg.scripts || {}).slice(0, 15).map(([name, cmd]) => `  npm run ${name}: ${String(cmd).slice(0, 120)}`);
    if (scripts.length) lines.push('package.json scripts:', ...scripts);
  } catch {}
  return lines;
}

function judgePrompt({ goal, members, hints, previous }) {
  return [
    'You write the judge for a new Atris campaign. Answer with JSON only.',
    '',
    `Goal: ${goal}`,
    ...hints,
    members.length ? `Members who can work on it: ${members.join(', ')}` : '',
    '',
    'A judge is a POSIX sh script that runs from the workspace root. It exits 0 only when the goal is met.',
    'Today the goal is not met, so today it must exit non-zero.',
    'Rules:',
    '- Check real outcomes outside any model: run tests, count files, grep output, run a local command. Never ask a model whether it is done.',
    '- Print graded progress so a person sees how close it is: a line "ℹ pass N" and a line "ℹ fail M" (checks met, checks not met).',
    '- Read and run only; change nothing. Finish in under two minutes. Use only commands that exist here.',
    previous ? `Your last draft did not work: ${previous}. Write a different judge.` : '',
    '',
    'Reply with one JSON object and nothing else:',
    `{"title": "<short name, under 60 characters>", "judge_script": "<the whole sh script>", "why": "<one sentence: what it checks and why it fails today>", "seats": ["<up to ${MAX_SEATS} members from the list who should work on this>"]}`,
  ].filter((line) => line !== '').join('\n');
}

function parseDraft(text, members) {
  const match = String(text || '').match(/\{[\s\S]*\}/);
  if (!match) return null;
  let row;
  try {
    row = JSON.parse(match[0]);
  } catch {
    return null;
  }
  if (!row || typeof row.judge_script !== 'string' || !row.judge_script.trim()) return null;
  if (Buffer.byteLength(row.judge_script) > MAX_SCRIPT_BYTES) return null;
  const known = new Set(members);
  const seats = Array.isArray(row.seats) ? [...new Set(row.seats.filter((s) => typeof s === 'string' && known.has(s)))].slice(0, MAX_SEATS) : [];
  return {
    title: typeof row.title === 'string' && row.title.trim() ? row.title.trim().slice(0, 80) : '',
    script: row.judge_script.trim(),
    why: typeof row.why === 'string' ? row.why.trim().slice(0, 300) : '',
    seats,
  };
}

// The owner's engine through the read-only ask runner.
async function askOwner(root, view, prompt) {
  const { resolveEngineForMember } = require('./member-engine');
  const { runEngineAskJobs } = require('./engine-ask');
  const pick = resolveEngineForMember(view.owner, root) || {};
  const engine = (pick.engine && pick.engine.id) || 'claude';
  const [answer] = await runEngineAskJobs([{ engine, model: pick.model || '', prompt, label: 'campaign new judge' }], { root, timeoutMs: ASK_TIMEOUT_MS });
  return { text: (answer && answer.stdout) || '', engine, ok: Boolean(answer && answer.ok) };
}

function writeJudge(root, id, script) {
  const rel = path.join('atris', 'campaigns', id, 'judge.sh');
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = script.startsWith('#!') ? script : `#!/bin/sh\n${script}`;
  fs.writeFileSync(file, body.endsWith('\n') ? body : `${body}\n`, { mode: 0o755 });
  return rel.split(path.sep).join('/');
}

// 126 and 127 mean the shell could not run a command; null means it hung or
// never started. Those are broken judges, not failing ones.
function brokenReading(reading) {
  return reading.exit === null || reading.exit === undefined || reading.exit === 126 || reading.exit === 127;
}

// Ask, write, run; one retry with the reason when the draft passes today,
// cannot run, or is not a script.
async function draftJudge({ root, goal, owner, idFlag, timeout, ask, judge }) {
  const members = teamMembers(root);
  const hints = workspaceHints(root);
  let previous = '';
  let id = idFlag || '';
  let last = null;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const prompt = judgePrompt({ goal, members, hints, previous });
    const answer = await ask(root, { id: id || 'new', owner, title: goal }, prompt);
    const draft = parseDraft(answer.text, members);
    if (!draft) {
      previous = 'the reply was not one JSON object with a judge_script';
      last = { error: `${owner}'s engine (${answer.engine || 'unknown'}) did not return a judge script` };
      continue;
    }
    if (!draft.title) draft.title = goal.slice(0, 80);
    if (!id) id = newCampaignId(draft.title);
    const judgeFile = writeJudge(root, id, draft.script);
    const command = `sh ${judgeFile}`;
    const reading = await judge(command, timeout);
    const result = { id, draft, judgeFile, command, reading, engine: answer.engine };
    if (reading.passed) {
      previous = `it passed today (${reading.summary || 'exit 0'}), so it cannot tell when the goal is met`;
      last = { ...result, error: `the drafted judge already passes (${reading.summary || 'exit 0'}); a judge must fail first` };
      continue;
    }
    if (brokenReading(reading)) {
      previous = `it could not run (${reading.summary || `exit ${reading.exit}`})`;
      last = { ...result, error: `the drafted judge could not run: ${reading.summary || `exit ${reading.exit}`}` };
      continue;
    }
    return { ok: true, ...result };
  }
  if (id && !idFlag) fs.rmSync(path.join(root, 'atris', 'campaigns', id), { recursive: true, force: true });
  return { ok: false, ...last };
}

function startArgs(result, { budget, owner, run }) {
  const args = ['start', result.draft.title, '--judge', result.command, '--budget', String(budget), '--id', result.id, '--owner', owner];
  for (const seat of result.draft.seats) args.push('--seat', seat);
  if (run) args.push('--run');
  return args;
}

function startCommand(result, options) {
  const seats = result.draft.seats.map((seat) => ` --seat ${seat}`).join('');
  return `atris campaign start ${shellQuote(result.draft.title)} --judge ${shellQuote(result.command)} --budget ${options.budget} --id ${result.id} --owner ${options.owner}${seats}`;
}

function renderDraft(result, options) {
  const lines = [
    `draft for: ${options.goal}`,
    '',
    `title     ${result.draft.title}`,
    `judge     ${result.command}`,
    `today     fails, as it should: ${result.reading.summary || `exit ${result.reading.exit}`}`,
  ];
  if (result.draft.why) lines.push(`checks    ${result.draft.why}`);
  lines.push(`owner     ${options.owner}`);
  lines.push(`seats     ${result.draft.seats.length ? result.draft.seats.join(', ') : 'none yet'}`);
  lines.push(`budget    ${money(options.budget)}`);
  lines.push('', `read or edit the judge: ${result.judgeFile}`);
  return lines.join('\n');
}

function askAtTerminal(question) {
  if (!process.stdin.isTTY || !process.stderr.isTTY) return Promise.resolve(false);
  const readline = require('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => rl.question(question, (answer) => {
    rl.close();
    resolve(/^y(es)?$/i.test(answer.trim()));
  }));
}

// deps.start is the start verb; deps.ask replaces the owner's engine in tests.
async function draftAndStart(args, ctx, deps = {}) {
  const { readFlag } = require('./arg-parser');
  const goal = String(deps.goal || '').trim();
  if (!goal) return ctx.fail('say the goal: atris campaign new "<goal>" [--budget 20] [--owner <member>] [--yes] [--run]');
  const budgetText = readFlag(args, '--budget', '');
  const budget = budgetText ? Number(budgetText) : DEFAULT_BUDGET;
  if (!(budget > 0)) return ctx.fail('--budget must be dollars above 0');
  const owner = readFlag(args, '--owner', '') || DEFAULT_OWNER;
  const timeout = Number(readFlag(args, '--timeout', '')) || DRAFT_TIMEOUT_SECONDS;
  const options = { goal, budget, owner, run: args.includes('--run') };
  if (!ctx.asJson) console.error(`asking ${owner}'s engine to draft a judge that fails today`);

  const result = await draftJudge({
    root: deps.root || process.cwd(), goal, owner, timeout,
    idFlag: readFlag(args, '--id', ''),
    ask: deps.ask || askOwner,
    judge: ctx.judge,
  });
  if (!result.ok) {
    if (ctx.asJson) {
      console.log(JSON.stringify({ ok: false, error: result.error, draft: result.draft || null, reading: result.reading || null }));
      return 1;
    }
    return ctx.fail(`${result.error}. Write the judge yourself: atris campaign start "<title>" --judge "<command that fails today>" --budget ${budget}`, 1);
  }

  const draft = { id: result.id, title: result.draft.title, judge: result.command, judge_file: result.judgeFile, why: result.draft.why, seats: result.draft.seats, owner, budget, engine: result.engine };
  // Only a person at a terminal can say yes here; agents and pipes pass --yes.
  const confirm = deps.confirm || askAtTerminal;
  const canAsk = deps.confirm ? true : Boolean(process.stdin.isTTY && process.stderr.isTTY);
  const asked = !args.includes('--yes') && !ctx.asJson && canAsk;
  const yes = args.includes('--yes') || (asked && await confirm(`${renderDraft(result, options)}\n\nstart it${options.run ? ' and run it' : ''}? [y/N] `));
  if (!yes) {
    const command = startCommand(result, options);
    const shown = asked ? 'not started.' : renderDraft(result, options);
    ctx.out(`${shown}\nstart it:  ${command}\n(or run this again with --yes)`,
      { ok: true, action: 'campaign_drafted', draft, reading: result.reading, start_command: command });
    return 0;
  }
  // Start with the reading already taken, so the judge does not run twice.
  if (!ctx.asJson && args.includes('--yes')) console.log(renderDraft(result, options));
  const startCtx = {
    ...ctx,
    judge: async () => result.reading,
    out: (human, json) => ctx.out(human, { ...json, draft }),
  };
  return deps.start(startArgs(result, options), startCtx);
}

module.exports = { draftAndStart, judgePrompt, parseDraft };
