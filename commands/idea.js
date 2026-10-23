'use strict';

// atris idea: feed ideas, Atris delegates.
//   atris idea "<sentence>" [--repo <path>] [--verify "<cmd>"]   save one idea
//   atris idea [--repo <path>] [--json]                          list ideas
//   atris idea retry <n> [--repo <path>]                         put one back in line

const path = require('path');
const { spawnSync } = require('child_process');
const { argsWantHelp } = require('../lib/noninteractive');
const {
  addIdea,
  findIdea,
  ideaRefusal,
  oneLine,
  readIdeas,
  updateIdea,
} = require('../lib/idea-inbox');

const VALUE_FLAGS = new Set(['--repo', '--verify']);

function ideaUsage() {
  return [
    'Usage: atris idea "<sentence>" [--repo <path>] [--verify "<cmd>"]',
    '       atris idea [--repo <path>] [--json]',
    '       atris idea retry <n> [--repo <path>]',
  ].join('\n');
}

function parseArgs(args = []) {
  const list = Array.isArray(args) ? args.map(String) : [];
  const flags = {};
  const words = [];
  for (let i = 0; i < list.length; i += 1) {
    const arg = list[i];
    const eq = arg.match(/^(--[a-z-]+)=(.*)$/);
    if (eq && VALUE_FLAGS.has(eq[1])) {
      flags[eq[1].slice(2)] = eq[2];
    } else if (VALUE_FLAGS.has(arg)) {
      flags[arg.slice(2)] = list[i + 1] || '';
      i += 1;
    } else if (arg === '--json') {
      flags.json = true;
    } else if (!arg.startsWith('--')) {
      words.push(arg);
    }
  }
  return { flags, words };
}

// The repo an idea belongs to: --repo when given, else the git top of the
// current folder, else the folder itself.
function resolveRepo(repo, cwd = process.cwd()) {
  const start = path.resolve(cwd, repo || '.');
  const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: start, encoding: 'utf8' });
  return top.status === 0 && String(top.stdout || '').trim() ? String(top.stdout).trim() : start;
}

function ideaJson(idea) {
  return {
    n: idea.n,
    id: idea.id,
    text: idea.text,
    status: idea.status,
    reason: idea.reason || null,
    task_id: idea.task_id || null,
    link: idea.link || null,
    at: idea.at,
  };
}

function renderIdeaList(ideas, { repo } = {}) {
  const lines = [];
  if (!ideas.length) {
    lines.push('no ideas here yet.');
    lines.push('');
    lines.push('drop one: atris idea "make the inbox search faster"');
    return lines.join('\n');
  }
  lines.push(`ideas in ${path.basename(repo || '.')}: ${ideas.length}`);
  lines.push('');
  const width = String(ideas.length).length;
  const pad = ' '.repeat(width + 4 + 10);
  for (const idea of ideas) {
    lines.push(`  ${String(idea.n).padStart(width)}. ${idea.status.padEnd(9)} ${oneLine(idea.text, 80)}`);
    if (idea.status === 'landed' && idea.link) lines.push(`${pad}${idea.link}`);
    if (idea.status === 'refused' && idea.reason) lines.push(`${pad}${oneLine(idea.reason, 100)}`);
    if (idea.status === 'building' && idea.task_id) lines.push(`${pad}task ${idea.task_id}`);
  }
  const waiting = ideas.filter((idea) => idea.status === 'waiting').length;
  if (waiting) {
    lines.push('');
    lines.push(`${waiting} waiting. they build one at a time, oldest first.`);
  }
  return lines.join('\n');
}

function saveIdea(sentence, { repo, verify, json, log }) {
  const idea = addIdea(repo, sentence, { verify });
  if (json) {
    log(JSON.stringify({ schema: 'atris.idea.v1', ok: true, repo, idea: ideaJson(idea) }, null, 2));
    return 0;
  }
  if (idea.status === 'refused') {
    log(`saved idea ${idea.n}, but I will not build it alone: ${idea.reason}.`);
    log('');
    log('it stays on the list so you can pick it up yourself.');
    return 0;
  }
  log(`saved idea ${idea.n}: ${oneLine(idea.text, 80)}`);
  log('');
  log('it gets built and checked when the idea tick runs, one idea at a time.');
  log('see where it is: atris idea');
  return 0;
}

function retryIdea(ref, { repo, json, log }) {
  const idea = findIdea(readIdeas(repo), ref);
  if (!idea) {
    log(`no idea ${ref || '(missing number)'} here. see the list: atris idea`);
    return 2;
  }
  if (idea.status === 'building' || idea.status === 'landed') {
    log(`idea ${idea.n} is ${idea.status}; nothing to retry.`);
    return 2;
  }
  const refusal = ideaRefusal(idea.text);
  if (refusal) {
    log(`idea ${idea.n} still ${refusal.replace(/, needs owner$/, '')}. it needs you, not a retry.`);
    return 2;
  }
  const next = updateIdea(repo, idea.id, { status: 'waiting', reason: '', attempts: 0 });
  if (json) log(JSON.stringify({ schema: 'atris.idea.v1', ok: true, repo, idea: ideaJson(next) }, null, 2));
  else log(`idea ${next.n} is back in line.`);
  return 0;
}

function ideaAtris(args = process.argv.slice(3), { cwd = process.cwd(), log = console.log } = {}) {
  const list = Array.isArray(args) ? args : [];
  if (argsWantHelp(list)) {
    log(ideaUsage());
    return 0;
  }
  const { flags, words } = parseArgs(list);
  const repo = resolveRepo(flags.repo, cwd);
  const json = flags.json === true;
  const verb = words[0];

  if (verb === 'retry' && words.length <= 2) return retryIdea(words[1], { repo, json, log });
  if (verb === 'list' && words.length === 1) words.length = 0;

  const sentence = words.join(' ').trim();
  if (sentence) return saveIdea(sentence, { repo, verify: flags.verify || '', json, log });

  const ideas = readIdeas(repo);
  if (json) {
    log(JSON.stringify({ schema: 'atris.idea_list.v1', repo, ideas: ideas.map(ideaJson) }, null, 2));
    return 0;
  }
  log(renderIdeaList(ideas, { repo }));
  return 0;
}

module.exports = {
  ideaAtris,
};
