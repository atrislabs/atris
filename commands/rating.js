'use strict';

// atris rating: the Atris Rating, one number from 25 to 99 for how much real
// work a teammate finishes. Engines are rated in the combine (Loop Bench);
// members are rated on the jobs they land here, the same numbers atris gm
// shows. Read only: nothing runs and nothing is written.

const { hasFlag } = require('../lib/arg-parser');
const { modelLabel } = require('../lib/roster-models');
const rating = require('../lib/atris-rating');

const USAGE = [
  'usage: atris rating [engine | member] [--json]',
  '  how much real work each AI teammate finishes, one number from 25 to 99.',
  '',
  '  atris rating            every engine the combine rated, and your members here',
  '  atris rating opus       one engine\'s card (opus, sonnet, haiku, or a model id)',
  '  atris rating <member>   one member\'s rating here, next to its engine\'s',
  '  --json                  print it as json',
].join('\n');

// "an 86", "a 76": eighty-something, eleven, and eighteen start with a vowel.
function rated(n) {
  return `${/^(8|11$|18$)/.test(String(n)) ? 'an' : 'a'} ${n}`;
}

// Jobs the build machine could not start (no room on the disk, a build copy that would not open) were let
// go before any engine ran. They are no member's miss and not finished, and they say so in a line of their own.
function couldNotStartLine(n) {
  return `${n} ${n === 1 ? 'job' : 'jobs'} could not start on this machine. ${n === 1 ? 'It doesn\'t' : 'They don\'t'} count against anyone.`;
}

// Members rated on the last 30 days of jobs here, best first, each with the
// job and model the roster gives it, plus the build line: what the build
// engine rates in the combine and what members doing build landed here.
// null when there is no task list or no finished job to rate.
function readHere(deps = {}) {
  let root = deps.root;
  let played = deps.season;
  try {
    if (!root) root = require('../lib/task-db').workspaceRoot(process.cwd());
    if (!played) played = require('../lib/gm-season').loadSeason(root, { lastSeen: null });
  } catch {
    return null;
  }
  if (!played || played.error || played.no_history) return null;
  const { rosterRows, tally } = require('../lib/gm-season');
  // Jobs still in review whose pull request is open, per builder. These do not depend on the
  // last 30 days of plays: a job can wait longer than that, and its builder still has it.
  const waiting = new Map();
  for (const review of played.reviews || []) {
    if (review && review.waiting_on_pull_request && review.member) waiting.set(review.member, (waiting.get(review.member) || 0) + 1);
  }
  const roster = rosterRows({ outcomes: played.outcomes || [], limit: Number.MAX_SAFE_INTEGER });
  // A member whose only misses were later confirmed not needed, or whose only jobs
  // wait on a pull request or could not start, has no finished job, but still shows,
  // so those jobs have somewhere to be counted.
  const rows = roster.filter((row) => row.finished > 0 || row.not_needed > 0 || row.held > 0 || row.could_not_start > 0 || waiting.has(row.name));
  for (const name of waiting.keys()) {
    if (!roster.some((row) => row.name === name)) rows.push({ name, ...tally([]), ovr: null });
  }
  if (!rows.length) return null;
  let lineup = deps.lineup;
  if (lineup === undefined) lineup = require('../lib/team-lineup').readLineupSafe(root);
  const team = new Map(((lineup && lineup.ok && lineup.team) || []).map((row) => [String(row.member || '').toLowerCase(), row]));
  const members = rows.map((row) => {
    const seat = team.get(row.name.toLowerCase()) || {};
    const reasons = new Map();
    for (const play of played.outcomes || []) {
      if (play.member === row.name && ['dropped', 'sent_back', 'abandoned'].includes(play.kind) && play.reason) {
        reasons.set(play.reason, (reasons.get(play.reason) || 0) + 1);
      }
    }
    const miss_reasons = [...reasons].map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)).slice(0, 3);
    return { member: row.name, ovr: row.ovr, landed: row.landed, finished: row.finished, ...(row.not_needed ? { not_needed: row.not_needed } : {}), ...(row.held ? { held: row.held } : {}), ...(row.could_not_start ? { could_not_start: row.could_not_start } : {}), ...(waiting.has(row.name) ? { waiting_on_pull_request: waiting.get(row.name) } : {}), job: seat.job || null, model: seat.model || null, ...(miss_reasons.length ? { miss_reasons } : {}) };
  });
  const buildJob = ((lineup && lineup.ok && lineup.jobs) || []).find((row) => row.job === 'build' && !row.key);
  const buildModel = buildJob && buildJob.now_runs ? buildJob.now_runs.model : null;
  const card = buildModel ? rating.combineCards().find((c) => c.model === buildModel) : null;
  const builders = members.filter((m) => m.job === 'build');
  const landed = builders.reduce((sum, m) => sum + m.landed, 0);
  const finished = builders.reduce((sum, m) => sum + m.finished, 0);
  const couldNotStart = members.reduce((sum, m) => sum + (m.could_not_start || 0), 0);
  return {
    workspace: played.workspace_name || null,
    members,
    ...(couldNotStart ? { could_not_start: couldNotStart } : {}),
    build: card && finished ? { model: buildModel, combine_ovr: card.ovr, landed, finished, ovr: rating.atrisRating(landed, finished) } : null,
  };
}

function renderHere(here) {
  const ranked = here.members.filter((m) => m.ovr != null);
  const fresh = here.members.filter((m) => m.ovr == null);
  const nameW = Math.min(24, Math.max(6, ...ranked.map((m) => m.member.length))) + 2;
  const lines = [`here${here.workspace ? `: ${here.workspace}` : ''}, last 30 days, the same ratings as atris gm`, ''];
  if (ranked.length) {
    lines.push(`  ${'ovr'.padEnd(5)}${'member'.padEnd(nameW)}${'landed'.padEnd(11)}${'job'.padEnd(8)}model`);
    for (const m of ranked) {
      const name = m.member.length > nameW - 2 ? `${m.member.slice(0, nameW - 5)}...` : m.member;
      lines.push(`  ${String(m.ovr).padEnd(5)}${name.padEnd(nameW)}${`${m.landed} of ${m.finished}`.padEnd(11)}${(m.job || '').padEnd(8)}${m.model ? modelLabel(m.model) : ''}`.trimEnd());
    }
  } else {
    lines.push('  no member has 3 finished jobs here yet');
  }
  if (fresh.length) {
    const names = fresh.map((m) => m.member);
    const head = `new, under 3 finished jobs (${names.length}): `;
    const shown = [];
    for (const name of names) {
      if (head.length + [...shown, name].join(', ').length + ', and 99 more'.length > 80) break;
      shown.push(name);
    }
    const rest = names.length - shown.length;
    lines.push('', `${head}${shown.join(', ')}${rest ? `, and ${rest} more` : ''}`);
  }
  lines.push('landed: accepted or merged. drops and abandons count against a member.');
  if (here.could_not_start) lines.push(couldNotStartLine(here.could_not_start));
  if (here.build) {
    const b = here.build;
    lines.push('', `build runs ${modelLabel(b.model)}, ${rated(b.combine_ovr)} in the combine.`,
      `members doing build here landed ${b.landed} of ${b.finished} jobs, ${rated(b.ovr)}.`);
  }
  return lines.join('\n');
}

function renderMember(m, card) {
  const job = m.job ? `, ${m.job}${m.model ? ` on ${modelLabel(m.model)}` : ''}` : '';
  const head = `${m.member}${job}`;
  const lines = [
    `${head}${' '.repeat(Math.max(2, 44 - head.length))}${m.ovr == null ? 'new' : `${m.ovr} ovr`} here`,
    '',
    `  landed ${m.landed} of ${m.finished} finished jobs in the last 30 days`,
  ];
  if (m.not_needed) lines.push(`  not needed: ${m.not_needed} (confirmed by someone else, so ${m.not_needed === 1 ? 'it does' : 'they do'} not count either way)`);
  if (m.held) lines.push(`  waiting on a pull request: ${m.held} (the work is done and a person has to land it, so ${m.held === 1 ? 'it does' : 'they do'} not count either way)`);
  if (m.could_not_start) lines.push(`  ${couldNotStartLine(m.could_not_start)}`);
  if (m.waiting_on_pull_request) {
    const one = m.waiting_on_pull_request === 1;
    lines.push(`  ${m.waiting_on_pull_request} ${one ? 'job waits' : 'jobs wait'} on an open pull request. Check GitHub and credit ${one ? 'it' : 'them'}: atris task sweep --held`);
  }
  if (m.ovr == null) lines.push('  rated once it has 3 finished jobs');
  if (m.miss_reasons && m.miss_reasons.length) {
    lines.push('  top miss reasons:');
    for (const item of m.miss_reasons) lines.push(`  ${item.count}: ${item.reason}`);
  }
  if (card && m.job === 'build') lines.push(`  its engine, ${card.label}, is ${rated(card.ovr)} in the combine: atris rating ${card.label.split(' ')[0]}`);
  lines.push(`  every play: atris gm card ${m.member}`);
  return lines.join('\n');
}

function ratingCommand(args = [], deps = {}) {
  const taskDb = require('../lib/task-db');
  taskDb.sweepExpiredLeases();
  const write = deps.write || ((text) => process.stdout.write(text));
  if (hasFlag(args, '--help') || hasFlag(args, '-h') || args[0] === 'help') {
    write(`${USAGE}\n`);
    return 0;
  }
  const json = hasFlag(args, '--json');
  const name = args.filter((arg) => !arg.startsWith('-')).join(' ').trim();
  const cards = rating.combineCards();
  if (name) {
    const card = rating.combineCardFor(name);
    if (card) {
      write(json ? `${JSON.stringify({ schema: 'atris.rating.v1', engine: card }, null, 2)}\n` : `${rating.renderCard(card)}\n`);
      return 0;
    }
    const here = readHere(deps);
    const member = here && here.members.find((m) => m.member.toLowerCase() === name.toLowerCase());
    if (member) {
      const own = member.model ? cards.find((c) => c.model === member.model) || null : null;
      write(json ? `${JSON.stringify({ schema: 'atris.rating.v1', member, engine: member.job === 'build' ? own : null }, null, 2)}\n` : `${renderMember(member, own)}\n`);
      return 0;
    }
    const err = deps.error || ((text) => process.stderr.write(text));
    err(`no engine or member called "${name}" is rated. engines: ${cards.map((c) => c.label).join(', ')}. members show once they finish a job here.\n`);
    return 1;
  }
  const here = readHere(deps);
  if (json) {
    write(`${JSON.stringify({
      schema: 'atris.rating.v1',
      scale: { floor: 25, top: 99, means: rating.SCALE_LINES.join(' ') },
      combine: { bench: rating.COMBINE.bench, month: rating.COMBINE.month, tasks: rating.COMBINE.tasks, unseen: rating.COMBINE.unseen, engines: cards },
      here,
    }, null, 2)}\n`);
    return 0;
  }
  write(`${rating.renderCombine(cards)}${here ? `\n\n${renderHere(here)}` : ''}\n`);
  return 0;
}

module.exports = { ratingCommand, USAGE };
