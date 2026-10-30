'use strict';

// The Atris Rating: one number, 25 to 99, for how much real work a teammate
// finishes. 99 means 99 of every 100. Each time a teammate halves its misses
// it gains about 6 points, so the top is the hardest climb: going from 96 to
// 99 percent finished is worth about 12.
//
// One scale rates two things. An engine gets its number from the combine
// below: real tasks graded by the tests that shipped with them. A member
// gets its number from the jobs it lands in its own workspace (gm-season).

const { modelLabel } = require('./roster-models');

const TOP = 99;
const FLOOR = 25;
const STEP = 6;

// Every rating starts from half a finish and half a miss, so a short perfect
// run cannot reach the top: 3 of 3 rates 76, and it takes about 60 in a row
// to rate 99. null when nothing has been tried.
function atrisRating(finished, tries) {
  const all = Number(tries);
  const done = Number(finished);
  if (!Number.isFinite(all) || all <= 0 || !Number.isFinite(done)) return null;
  const share = (Math.min(Math.max(done, 0), all) + 0.5) / (all + 1);
  const raw = TOP - STEP * (Math.log2(TOP) - Math.log2(share / (1 - share)));
  return Math.max(FLOOR, Math.min(TOP, Math.round(raw)));
}

// The combine: Loop Bench, tasks from the atris repos (javascript from the
// CLI, python from the backend), each graded by the hidden tests that shipped
// with its fix, run in Claude Code on the builder prompt Atris kept. unseen
// tasks were held out of every prompt change, so the prompt was never tuned
// on them. finished adds each task's pass rate over its tries; time and price
// count each task once too. broke counts tries that passed their own tests
// but broke another one. The file is what evals/loopbench/combine.py in
// atrisos-backend prints, copied as is, so re-rating is one copy.
function freeze(value) {
  if (value && typeof value === 'object') {
    for (const inner of Object.values(value)) freeze(inner);
    Object.freeze(value);
  }
  return value;
}

const COMBINE = freeze(require('./atris-rating-combine.json'));

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

// "2026-10-29" -> "October 2026"
function monthOf(date) {
  const [year, month] = String(date || '').split('-').map(Number);
  return year && month >= 1 && month <= 12 ? `${MONTHS[month - 1]} ${year}` : '';
}

const RATED = monthOf(COMBINE.rated);

// One engine's card: the overall and four parts, each on the same scale.
function engineCard(row) {
  return {
    model: row.model,
    label: modelLabel(row.model),
    ovr: atrisRating(row.finished, row.tasks),
    finished: row.finished,
    tasks: row.tasks,
    python: atrisRating(row.python.finished, row.python.tasks),
    javascript: atrisRating(row.javascript.finished, row.javascript.tasks),
    unseen: atrisRating(row.unseen.finished, row.unseen.tasks),
    clean: atrisRating(row.tries - row.broke, row.tries),
    parts: { python: row.python, javascript: row.javascript, unseen: row.unseen },
    tries: row.tries,
    broke: row.broke,
    minutes_cap: row.minutes_cap,
    median_minutes: row.median_minutes,
    cost_per_finish: row.cost_per_finish,
  };
}

// Every rated engine, best first.
function combineCards() {
  return COMBINE.engines.map(engineCard).sort((a, b) => b.ovr - a.ovr || a.label.localeCompare(b.label));
}

// The card for a model id, a label, or a family word that names one engine;
// null for a model the combine has not rated.
function combineCardFor(name) {
  const text = String(name || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!text) return null;
  const cards = combineCards();
  const exact = cards.find((card) => card.model === text || card.label === text);
  if (exact) return exact;
  const family = cards.filter((card) => card.label.split(' ')[0] === text);
  return family.length === 1 ? family[0] : null;
}

function finishedText(value) {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 10) / 10);
}

function priceText(dollars) {
  if (typeof dollars !== 'number') return '-';
  return dollars < 1 ? `${Math.round(dollars * 100)}¢` : `$${dollars.toFixed(2)}`;
}

function minutesText(minutes) {
  return typeof minutes === 'number' ? `${minutes.toFixed(1)} min` : '-';
}

const SCALE_LINES = Object.freeze([
  'how much real work a teammate finishes, 25 to 99. 99 means 99 of every 100.',
  'each halving of misses is worth about 6 points, so the top is the hardest climb.',
]);

// The league table: every rated engine, best first.
function renderCombine(cards = combineCards()) {
  const caps = [...new Set(cards.map((card) => card.minutes_cap))];
  const capLine = caps.length > 1
    ? cards.filter((card) => card.minutes_cap !== Math.min(...caps)).map((card) => `${card.label} gets ${card.minutes_cap} minutes a task`).join(', ') + `, the others ${Math.min(...caps)}.`
    : `every engine gets ${caps[0]} minutes a task.`;
  const lines = [
    'atris rating',
    ...SCALE_LINES,
    '',
    `the combine: ${COMBINE.tasks} atris tasks, each graded by the tests that shipped with it`,
    '',
    `  ${'ovr'.padEnd(5)}${'engine'.padEnd(12)}${'finished'.padEnd(12)}${'py'.padEnd(4)}${'js'.padEnd(4)}${'unseen'.padEnd(8)}${'clean'.padEnd(7)}${'time'.padEnd(9)}price`,
  ];
  for (const card of cards) {
    lines.push(`  ${String(card.ovr).padEnd(5)}${card.label.padEnd(12)}${`${finishedText(card.finished)} of ${card.tasks}`.padEnd(12)}${String(card.python).padEnd(4)}${String(card.javascript).padEnd(4)}${String(card.unseen).padEnd(8)}${String(card.clean).padEnd(7)}${minutesText(card.median_minutes).padEnd(9)}${priceText(card.cost_per_finish)}`);
  }
  const top = cards[0];
  lines.push(
    '',
    top && top.ovr >= TOP ? `${top.label} is a 99.` : 'no engine is a 99 yet.',
    'py, js: python and javascript tasks. unseen: ones the prompt was never tuned on.',
    'clean: tries that broke no other test. time: median to finish.',
    'price: per finished task, pay-per-use.',
    capLine,
    `${COMBINE.bench}, ${RATED}. one engine: atris rating <engine>`,
  );
  return lines.join('\n');
}

// One engine's card.
function renderCard(card) {
  const head = `${card.label}, builder`;
  const part = (name, value, text) => `  ${name.padEnd(13)}${String(value).padEnd(5)}${text}`;
  return [
    `${head}${' '.repeat(Math.max(2, 44 - head.length))}${card.ovr} ovr`,
    '',
    part('python', card.python, `${finishedText(card.parts.python.finished)} of ${card.parts.python.tasks} tasks`),
    part('javascript', card.javascript, `${finishedText(card.parts.javascript.finished)} of ${card.parts.javascript.tasks} tasks`),
    part('unseen', card.unseen, `${finishedText(card.parts.unseen.finished)} of ${card.parts.unseen.tasks} tasks the Atris prompt was never tuned on`),
    part('clean', card.clean, `broke another test on ${card.broke} of ${card.tries} tries`),
    '',
    `  finished ${finishedText(card.finished)} of ${card.tasks} tasks, ${minutesText(card.median_minutes)} median, ${card.minutes_cap} minute cap`,
    `  ${priceText(card.cost_per_finish)} per finished task on pay-per-use`,
    `  ${COMBINE.bench}, ${RATED}, ${card.tries} tries graded by each task's shipped tests`,
  ].join('\n');
}

// What the boot team line adds after a build engine, like " (86 ovr)", or ''
// for a model the combine has not rated.
function bootRatingText(model) {
  const card = model ? combineCards().find((c) => c.model === String(model).trim()) : null;
  return card ? ` (${card.ovr} ovr)` : '';
}

module.exports = {
  COMBINE,
  SCALE_LINES,
  atrisRating,
  bootRatingText,
  combineCardFor,
  combineCards,
  renderCard,
  renderCombine,
};
