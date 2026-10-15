'use strict';

// Draft a judge for a campaign that was started from one sentence. The owner's
// engine reads the goal through the same read-only ask path the campaign loop
// plans with, and answers with one shell command or a small bash script that
// fails today and passes once the goal is met. Nothing here runs the judge or
// writes files: the caller shows the draft to a person and runs it first.

const DRAFT_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_JUDGE_CHARS = 4000;

function shellQuote(text) {
  return `'${String(text).replace(/'/g, `'\\''`)}'`;
}

function draftPrompt(goal, root) {
  return [
    `You write the judge for an Atris campaign. Answer with JSON only.`,
    ``,
    `Goal: ${goal}`,
    `Working folder: ${root}`,
    ``,
    `A judge is a check that exits 0 when the goal is met and non-zero otherwise.`,
    `It must fail right now, before any work, and pass once the goal is really met.`,
    `It must only read: no edits, no installs, no network writes, no deletes.`,
    `Prefer one shell command. Use a small bash script only when one command cannot check the goal.`,
    `Reply with one JSON object and nothing else:`,
    `{"command": "<one shell command, or empty when you give a script>", "script": "<small bash script, or empty>", "explain": "<one plain sentence saying what the judge checks>"}`,
  ].join('\n');
}

// Pull the judge out of the engine's answer. Returns null when the answer
// holds no usable command or script.
function parseDraft(text) {
  const raw = String(text || '');
  const match = raw.match(/\{[\s\S]*\}/);
  let row = null;
  if (match) {
    try {
      row = JSON.parse(match[0]);
    } catch {
      row = null;
    }
  }
  if (!row || typeof row !== 'object') {
    const fenced = raw.match(/```(?:bash|sh|shell)?\n([\s\S]*?)```/);
    if (!fenced || !fenced[1].trim()) return null;
    row = { script: fenced[1] };
  }
  const command = typeof row.command === 'string' ? row.command.trim() : '';
  const script = typeof row.script === 'string' ? row.script.trim() : '';
  const explain = typeof row.explain === 'string' ? row.explain.trim().slice(0, 300) : '';
  if (command && !command.includes('\n') && command.length <= MAX_JUDGE_CHARS) {
    return { judge: command, script: null, explain };
  }
  const body = script || command;
  if (!body || body.length > MAX_JUDGE_CHARS) return null;
  return { judge: `bash -c ${shellQuote(body)}`, script: body, explain };
}

// Ask the owner's engine through the read-only ask runner, like askOwner in
// campaign-loop.js.
async function askEngine(root, owner, prompt) {
  const { resolveEngineForMember } = require('./member-engine');
  const { runEngineAskJobs } = require('./engine-ask');
  const pick = resolveEngineForMember(owner, root) || {};
  const engine = (pick.engine && pick.engine.id) || 'claude';
  const [answer] = await runEngineAskJobs([{ engine, model: pick.model || '', prompt, label: 'campaign draft judge' }], { root, timeoutMs: DRAFT_TIMEOUT_MS });
  return { text: (answer && answer.stdout) || '', engine, ok: Boolean(answer && answer.ok) };
}

async function draftJudge(root, goal, { ask = askEngine, owner = 'mission-lead' } = {}) {
  const sentence = String(goal || '').trim();
  if (!sentence) return { ok: false, reason: 'no goal to draft a judge for' };
  const answer = await ask(root, owner, draftPrompt(sentence, root));
  const draft = parseDraft(answer && answer.text);
  if (!draft) {
    return { ok: false, engine: answer && answer.engine, reason: 'the engine did not answer with a command or script' };
  }
  return { ok: true, engine: answer.engine, ...draft };
}

module.exports = { draftJudge, draftPrompt, parseDraft };
