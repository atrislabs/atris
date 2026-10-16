// Work and review in rounds (Astra's rule: let agents work 50 minutes, then
// take 10). In the work window the campaign loop runs: it plans, runs missions
// at once, and judges. In the break the judge runs if due, reserves are
// reconciled, and the owner writes a short review of the round into the
// campaign's lessons file, which the next round's planning reads. Each round
// leaves the campaign a little smarter than the last.

'use strict';

const fs = require('fs');
const path = require('path');
const { paysDollars } = require('./campaign-core');
const { getCampaign, openCampaignStore } = require('./campaign-store');

const LESSON_LINES_FOR_PLANNING = 30;

function parseDuration(text, fallbackMs) {
  if (text === undefined || text === null || text === '') return fallbackMs;
  const match = /^(\d+(?:\.\d+)?)\s*(s|m|h)?$/i.exec(String(text).trim());
  if (!match) throw new Error(`durations look like 50m, 10m, 90s, or 1h (got ${text})`);
  const unit = (match[2] || 'm').toLowerCase();
  return Math.round(Number(match[1]) * { s: 1000, m: 60000, h: 3600000 }[unit]);
}

function lessonsPath(root, campaignId) {
  return path.join(root, 'atris', 'campaigns', campaignId, 'lessons.md');
}

function globalLessonsPath(root) {
  return path.join(root, 'atris', 'campaigns', 'lessons.md');
}

function parseBulletLines(filePath) {
  try {
    const text = fs.readFileSync(filePath, 'utf8');
    return text.split('\n').filter((line) => line.trim().startsWith('- '));
  } catch {
    return [];
  }
}

// The newest lessons for the planner: local campaign lessons plus deduplicated
// cross-campaign RSI lessons so every new campaign inherits earlier lessons.
function readLessons(root, campaignId, lines = LESSON_LINES_FOR_PLANNING) {
  const local = parseBulletLines(lessonsPath(root, campaignId));
  const global = parseBulletLines(globalLessonsPath(root));
  const seen = new Set();
  const merged = [];
  for (const line of [...local, ...global]) {
    const key = line.trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(line);
  }
  return merged.slice(-lines).join('\n');
}

function roundSummary(before, after) {
  const fresh = after.missions.filter((m) => !before.missions.some((b) => b.id === m.id && b.status === m.status));
  const kept = fresh.filter((m) => m.status === 'ended' && m.outcome === 'kept').length;
  const failed = fresh.filter((m) => m.status === 'ended' && m.outcome !== 'kept').length;
  const vetoed = fresh.filter((m) => m.status === 'vetoed').length;
  const spent = Math.round((after.budget.spent - before.budget.spent) * 100) / 100;
  return { kept, failed, vetoed, spent, fresh };
}

// On a subscription the round is told without dollars, since none were paid.
function roundTally(view, summary) {
  return `${summary.kept} kept, ${summary.failed} failed${paysDollars(view) ? `, $${summary.spent} spent` : ''}`;
}

function reviewPrompt(view, summary, lessons) {
  const paid = paysDollars(view);
  const missions = summary.fresh.map((m) => `- ${m.id}: ${m.status}${m.outcome ? ` (${m.outcome})` : ''}${paid && m.cost_usd !== null ? `, $${m.cost_usd}` : ''}`).join('\n') || '- none ended this round';
  return [
    'You review one round of an Atris campaign. Reply with 2 to 6 short lessons, one per line, each starting with "- ".',
    'A lesson says what to do differently next round, in plain words. Do not repeat a lesson already listed.',
    '',
    `Campaign: ${view.title}`,
    `Judge: ${view.judge}`,
    `Judge now: ${view.last_judge ? `${view.last_judge.passed ? 'passed' : 'failed'}${view.last_judge.reading !== null ? ` (reading ${view.last_judge.reading})` : ''}: ${view.answer.text || ''}` : 'never run'}`,
    `This round: ${summary.kept} kept, ${summary.failed} failed, ${summary.vetoed} could not start${paid ? `, $${summary.spent} spent` : ''}`,
    'Missions this round:',
    missions,
    '',
    'Lessons so far:',
    lessons || '- none yet',
  ].join('\n');
}

function makeCadence(root, loop, options = {}, deps = {}) {
  const store = deps.store || openCampaignStore(root);
  const log = deps.log || ((line) => console.log(line));
  const now = deps.now || (() => Date.now());
  const sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const ask = deps.ask;
  const workMs = parseDuration(options.work, 50 * 60000);
  const breakMs = parseDuration(options.break, 10 * 60000);
  const rounds = Number(options.rounds) > 0 ? Number(options.rounds) : Infinity;

  async function review(id, before) {
    const after = getCampaign(store, id);
    const summary = roundSummary(before, after);
    const lessons = readLessons(root, id, 200);
    let written = [];
    if (ask) {
      const answer = await ask(root, after, reviewPrompt(after, summary, lessons));
      // A lesson already on file is not written twice.
      const known = new Set(lessons.split('\n').map((line) => line.trim().toLowerCase()));
      written = String((answer && answer.text) || '').split('\n').map((line) => line.trim())
        .filter((line) => line.startsWith('- ') && !known.has(line.toLowerCase())).slice(0, 6);
    }
    const file = lessonsPath(root, id);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (!fs.existsSync(file)) fs.writeFileSync(file, `# Lessons: ${after.title}\n\nWritten by the owner at each review; the next round plans from them.\n`);
    const stamp = new Date(now()).toISOString().slice(0, 16).replace('T', ' ');
    const header = `\n## ${stamp}: ${roundTally(after, summary)}\n`;
    fs.appendFileSync(file, `${header}${(written.length ? written : ['- (no review written this round)']).join('\n')}\n`);
    return { summary, lessons: written, view: after };
  }

  async function run(id) {
    let round = 0;
    let last = { reason: 'not started' };
    while (round < rounds) {
      round += 1;
      const before = getCampaign(store, id);
      const until = now() + workMs;
      log(`round ${round}: working until ${new Date(until).toISOString().slice(11, 16)}`);
      let stopped = null;
      while (now() < until) {
        const result = await loop.step(id);
        if (result.stop) {
          stopped = result.reason;
          break;
        }
      }
      const breakStarted = now();
      log(`round ${round}: review`);
      const { summary, lessons, view: reviewed } = await review(id, before);
      log(`  ${roundTally(reviewed, summary)}; ${lessons.length} lesson${lessons.length === 1 ? '' : 's'} written`);
      const view = getCampaign(store, id);
      last = { reason: stopped || 'work window ended', round };
      // Finished, out of money, or waiting on a person: no point in another round.
      if (['done', 'out_of_budget', 'needs_you', 'paused'].includes(view.state) || (stopped && !/missions running|nothing usable/.test(stopped))) {
        return { rounds: round, reason: stopped || view.state, campaign: view };
      }
      const rest = breakMs - (now() - breakStarted);
      if (round < rounds && rest > 0) await sleep(rest);
    }
    return { rounds: round, reason: last.reason, campaign: getCampaign(store, id) };
  }

  return { run, review };
}

module.exports = { lessonsPath, makeCadence, parseDuration, readLessons, reviewPrompt };
