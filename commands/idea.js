'use strict';

// atris idea: feed ideas, Atris delegates.
//   atris idea "<sentence>" [--repo <path>] [--verify "<cmd>"]   save one idea
//   atris idea [--repo <path>] [--json]                          list ideas
//   atris idea retry <n> [--repo <path>]                         put one back in line
//   atris idea tick [--repo <path>] [--max-minutes <n>]          build the oldest waiting idea
//   atris idea on|off [--repo <path>] [--dry-run]                 tick every 10 minutes, or stop

const fs = require('fs');
const os = require('os');
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
const { ideaScore, readOutcomes, scoreLine } = require('../lib/idea-ledger');

const VALUE_FLAGS = new Set(['--repo', '--verify', '--max-minutes']);

function ideaUsage() {
  return [
    'Usage: atris idea "<sentence>" [--repo <path>] [--verify "<cmd>"]',
    '       atris idea [--repo <path>] [--json]',
    '       atris idea retry <n> [--repo <path>] [--verify "<cmd>"]',
    '       atris idea tick [--repo <path>] [--max-minutes <n>]',
    '       atris idea on|off [--repo <path>] [--dry-run]',
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
    } else if (arg === '--dry-run') {
      flags.dryRun = true;
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

const TICK_EVERY_SECONDS = 600;

// The timer that runs `atris idea tick` for one repo: launchd on macOS, cron
// elsewhere, through the same planner `atris campaign keep` uses.
function ideaTimerPlan(repo, keepDeps = {}) {
  const { planKeep } = require('../lib/campaign-keep');
  return planKeep({
    root: repo,
    home: path.join(os.homedir(), '.atris', 'overnight'),
    atrisBin: path.resolve(__dirname, '..', 'bin', 'atris.js'),
    job: {
      name: 'idea-tick',
      args: ['idea', 'tick'],
      every_seconds: TICK_EVERY_SECONDS,
      marker: 'ATRIS_IDEA_TICK',
      log: `idea-tick-${path.basename(repo)}.log`,
    },
    ...(keepDeps.plan || {}),
  });
}

function ideaTimerOn(plan, keepDeps = {}) {
  if (plan.kind === 'launchd') return fs.existsSync(plan.file);
  const spawn = keepDeps.spawn || spawnSync;
  const listed = spawn('crontab', ['-l'], { encoding: 'utf8', timeout: 10000 });
  return listed.status === 0 && String(listed.stdout || '').includes(plan.marker);
}

function switchTimer(turnOn, { repo, dryRun, json, log, keepDeps }) {
  const { installKeep, removeKeep } = require('../lib/campaign-keep');
  const plan = ideaTimerPlan(repo, keepDeps);
  const where = plan.kind === 'launchd' ? plan.file : 'your crontab';
  if (dryRun) {
    if (json) log(JSON.stringify({ schema: 'atris.idea_timer.v1', ok: true, on: turnOn, dry_run: true, plan }, null, 2));
    else log(`would ${turnOn ? 'start' : 'stop'} a ${plan.kind} timer in ${where}:\n  every ${plan.every_seconds / 60} minutes: ${plan.command}\n  in ${repo}\n  log ${plan.log_path}`);
    return 0;
  }
  const result = (turnOn ? installKeep : removeKeep)(plan, keepDeps);
  if (json) log(JSON.stringify({ schema: 'atris.idea_timer.v1', on: turnOn, ...result, plan }, null, 2));
  if (!result.ok) {
    if (!json) log(`could not ${turnOn ? 'start' : 'stop'} the timer: ${result.error}`);
    return 1;
  }
  if (json) return 0;
  if (turnOn) {
    log(`on. every ${plan.every_seconds / 60} minutes the oldest idea in ${path.basename(repo)} gets built and checked.`);
    log(`log: ${plan.log_path}`);
    log('stop it: atris idea off');
  } else {
    log(result.removed === false ? 'the idea timer was not on here.' : 'off. ideas stay saved; nothing builds them until you turn it back on.');
  }
  return 0;
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
    tag: idea.tag || null,
  };
}

// Ideas the loop files about itself land in the loop's own code, so they go
// to this atris checkout when it is a git checkout, else to the same repo.
function loopHome(repo) {
  const home = path.resolve(__dirname, '..');
  return fs.existsSync(path.join(home, '.git')) ? home : repo;
}

function renderIdeaList(ideas, { repo, timerOn = null, score = null } = {}) {
  const lines = [];
  if (score && score.builds) {
    lines.push(scoreLine(score));
    lines.push('');
  }
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
    const tag = idea.tag === 'loop' ? '[loop] ' : '';
    lines.push(`  ${String(idea.n).padStart(width)}. ${idea.status.padEnd(9)} ${tag}${oneLine(idea.text, 80)}`);
    if (idea.status === 'landed' && idea.link) lines.push(`${pad}${idea.link}`);
    if (idea.status === 'refused' && idea.reason) lines.push(`${pad}${oneLine(idea.reason, 100)}`);
    if (idea.status === 'building' && idea.task_id) lines.push(`${pad}task ${idea.task_id}`);
  }
  const waiting = ideas.filter((idea) => idea.status === 'waiting').length;
  if (waiting) {
    lines.push('');
    lines.push(`${waiting} waiting. they build one at a time, oldest first.`);
    if (timerOn === true) lines.push('the next one starts within 10 minutes.');
    if (timerOn === false) lines.push('nothing builds them yet. start it: atris idea on');
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

function retryIdea(ref, { repo, verify = '', json, log }) {
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
  const next = updateIdea(repo, idea.id, { status: 'waiting', reason: '', attempts: 0, ...(verify ? { verify } : {}) });
  if (json) log(JSON.stringify({ schema: 'atris.idea.v1', ok: true, repo, idea: ideaJson(next) }, null, 2));
  else log(`idea ${next.n} is back in line.`);
  return 0;
}

function ideaAtris(args = process.argv.slice(3), { cwd = process.cwd(), log = console.log, keepDeps = {} } = {}) {
  const list = Array.isArray(args) ? args : [];
  if (argsWantHelp(list)) {
    log(ideaUsage());
    return 0;
  }
  const { flags, words } = parseArgs(list);
  const repo = resolveRepo(flags.repo, cwd);
  const json = flags.json === true;
  const verb = words[0];

  if (verb === 'retry' && words.length <= 2) return retryIdea(words[1], { repo, verify: flags.verify || '', json, log });
  if ((verb === 'on' || verb === 'off') && words.length === 1) {
    return switchTimer(verb === 'on', { repo, dryRun: flags.dryRun === true, json, log, keepDeps });
  }
  if (verb === 'tick' && words.length === 1) {
    const minutes = Number(flags['max-minutes']);
    const { runIdeaTick, DEFAULT_BUILD_SECONDS } = require('../lib/idea-tick');
    return runIdeaTick({
      root: repo,
      log: json ? () => {} : log,
      loopRepo: loopHome(repo),
      maxSeconds: Number.isFinite(minutes) && minutes > 0 ? Math.floor(minutes * 60) : DEFAULT_BUILD_SECONDS,
    }).then((outcome) => {
      if (json) log(JSON.stringify({ schema: 'atris.idea_tick.v1', repo, ...outcome }, null, 2));
      return 0;
    });
  }
  if (verb === 'list' && words.length === 1) words.length = 0;

  const sentence = words.join(' ').trim();
  if (sentence) return saveIdea(sentence, { repo, verify: flags.verify || '', json, log });

  const ideas = readIdeas(repo);
  const score = ideaScore(readOutcomes(repo));
  if (json) {
    log(JSON.stringify({ schema: 'atris.idea_list.v1', repo, score: { ...score, line: scoreLine(score) }, ideas: ideas.map(ideaJson) }, null, 2));
    return 0;
  }
  let timerOn = null;
  try { timerOn = ideaTimerOn(ideaTimerPlan(repo, keepDeps), keepDeps); } catch {}
  log(renderIdeaList(ideas, { repo, timerOn, score }));
  return 0;
}

module.exports = {
  ideaAtris,
};
