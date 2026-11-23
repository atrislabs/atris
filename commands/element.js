'use strict';

// atris element: headless single-focus swarm interface.
// Shows one card at a time (decisions first, then live work and results) and
// lets a person or agent act with one word: yes, no, pass, talk, say, more.
// Shares 100% of lib/feed-core.js and commands/decision-feed.js state.

const feed = require('../lib/feed-core');
const decisionFeed = require('./decision-feed');

const SHORT_ACTIONS = new Set(['next', 'yes', 'no', 'pass', 'talk', 'help']);

const HELP = [
  'usage: atris element [--filter all|needs_decision|working|parked|done] [--json]',
  '       atris element next [--filter ...] [--json]       show the one card needing focus right now',
  '       atris element yes [<card>] [--note "<text>"]     approve the top decision card (or <card>) and start work',
  '       atris element no [<card>] [--note "<text>"]      dismiss the top card (or <card>)',
  '       atris element pass [<card>]                      scroll past the top card (or <card>)',
  '       atris element talk [<card>] "<words>" [--stream] talk with the top card\'s team member',
  '       atris element say "<words>" [--ask]              post a short note or question to the swarm',
  '       atris element more                               wake team members for fresh ideas',
  '       atris element members | member on|off <name>     see or toggle swarm members',
  '       atris element cards | doctor | setup | theme     all decision-feed commands work here too',
  '',
  'Element runs headlessly in any terminal, pipe or agent chat. One card at a time.',
];

function isCardId(token) {
  return /^(task|post|ask|session|card|note|proposal|idea|result|work):/i.test(String(token || '').trim());
}

function splitArgs(args = []) {
  const positional = [];
  const flags = {};
  let json = false;
  let help = false;
  for (let i = 0; i < args.length; i += 1) {
    const token = String(args[i]);
    if (token === '--json') { json = true; continue; }
    if (token === '--help' || token === '-h') { help = true; continue; }
    if (token === '--') { positional.push(...args.slice(i + 1).map(String)); break; }
    if (token.startsWith('--')) {
      const eq = token.indexOf('=');
      if (eq > 0) {
        flags[token.slice(2, eq)] = token.slice(eq + 1);
      } else if (['--filter', '--note', '--limit', '--cursor', '--since', '--as', '--member', '--engine'].includes(token)) {
        flags[token.slice(2)] = args[i + 1] !== undefined ? String(args[i + 1]) : '';
        i += 1;
      } else {
        flags[token.slice(2)] = true;
      }
      continue;
    }
    positional.push(token);
  }
  return { positional, flags, json, help };
}

function pickFocusCard(cards = [], { preferDecision = true } = {}) {
  if (!Array.isArray(cards) || !cards.length) return null;
  if (preferDecision) {
    const waiting = cards.find((c) => c && c.source && c.source.type === 'session');
    if (waiting) return waiting;
    const decide = cards.find((c) => c && c.needs_decision);
    if (decide) return decide;
  }
  return cards[0];
}

function focusPayload(root, { filter = 'all', env = process.env, preferDecision = true } = {}) {
  const listed = feed.listCards(root, { filter, limit: 25, env });
  const focus = pickFocusCard(listed.cards, { preferDecision });
  const remaining = Math.max(0, listed.cards.length - (focus ? 1 : 0));
  const actions = !focus
    ? ['atris element more', 'atris element say "<note>"']
    : focus.needs_decision
      ? ['atris element yes', 'atris element no', 'atris element pass', 'atris element talk "<words>"']
      : ['atris element pass', 'atris element talk "<words>"', 'atris element no'];
  return {
    version: feed.FEED_VERSION,
    goal: listed.theme ? listed.theme.text : '',
    counts: listed.counts,
    focus,
    remaining,
    actions,
  };
}

function printFocus(out) {
  const goal = out.goal ? `goal: ${out.goal}` : 'goal: not set (set with: atris element theme set "<sentence>")';
  console.log(goal);
  const c = out.counts || {};
  console.log(`${c.needs_decision || 0} waiting, ${c.working || 0} working, ${c.new_results || 0} new results, ${c.done_today || 0} done today`);
  if (!out.focus) {
    console.log('\nclear. nothing waiting for you right now.');
    console.log('next: atris element more  |  atris element say "<note>"');
    return;
  }
  console.log(`\n${decisionFeed.textCard(out.focus)}`);
  if (out.remaining > 0) console.log(`\n${out.remaining} more in queue`);
  console.log(`next: ${out.actions.join('  |  ')}`);
}

async function run(args = [], { cwd = process.cwd(), env = process.env, deps = {} } = {}) {
  const { positional, flags, json, help } = splitArgs(args);
  const sub = positional[0] || 'next';

  if (help && (!positional.length || sub === 'help' || sub === 'next')) {
    console.log(HELP.join('\n'));
    return 0;
  }
  if (sub === 'help') {
    console.log(HELP.join('\n'));
    return 0;
  }

  // Forward every full decision-feed command directly so Element and Feed never diverge.
  if (!SHORT_ACTIONS.has(sub)) {
    return decisionFeed.run(args, { cwd, env, deps });
  }

  let root;
  try {
    root = feed.projectRoot(cwd);
  } catch (caught) {
    const error = feed.asFeedError(caught);
    if (!error) throw caught;
    if (json) console.log(JSON.stringify({ version: feed.FEED_VERSION, ok: false, error: error.toJSON() }, null, 2));
    else console.error(`error: ${error.message}`);
    return 1;
  }

  if (sub === 'next') {
    try {
      const out = focusPayload(root, { filter: flags.filter || 'all', env });
      if (json) console.log(JSON.stringify(out, null, 2));
      else printFocus(out);
      return 0;
    } catch (caught) {
      const error = feed.asFeedError(caught);
      if (!error) throw caught;
      if (json) console.log(JSON.stringify({ version: feed.FEED_VERSION, ok: false, error: error.toJSON() }, null, 2));
      else console.error(`error: ${error.message}`);
      return 1;
    }
  }

  const forwardedFlags = [];
  if (json) forwardedFlags.push('--json');
  if (flags.note) forwardedFlags.push('--note', flags.note);
  if (flags.stream) forwardedFlags.push('--stream');
  if (flags.as) forwardedFlags.push('--as', flags.as);

  if (sub === 'yes') {
    let cardId = positional[1];
    if (!cardId) {
      const out = focusPayload(root, { filter: 'needs_decision', env, preferDecision: true });
      if (!out.focus) {
        if (json) console.log(JSON.stringify({ version: feed.FEED_VERSION, ok: false, error: { code: 'empty', message: 'no card waiting for a decision.' } }, null, 2));
        else console.log('nothing waiting for approval right now.');
        return 0;
      }
      cardId = out.focus.id;
    }
    return decisionFeed.run(['decide', cardId, 'approve', ...forwardedFlags], { cwd, env, deps });
  }

  if (sub === 'no') {
    let cardId = positional[1];
    if (!cardId) {
      const out = focusPayload(root, { filter: 'all', env, preferDecision: true });
      if (!out.focus) {
        if (json) console.log(JSON.stringify({ version: feed.FEED_VERSION, ok: false, error: { code: 'empty', message: 'no card to dismiss.' } }, null, 2));
        else console.log('nothing to dismiss right now.');
        return 0;
      }
      cardId = out.focus.id;
    }
    return decisionFeed.run(['dismiss', cardId, ...forwardedFlags], { cwd, env, deps });
  }

  if (sub === 'pass') {
    let cardId = positional[1];
    if (!cardId) {
      const out = focusPayload(root, { filter: 'all', env, preferDecision: true });
      if (!out.focus) {
        if (json) console.log(JSON.stringify({ version: feed.FEED_VERSION, ok: false, error: { code: 'empty', message: 'no card to pass.' } }, null, 2));
        else console.log('nothing to pass right now.');
        return 0;
      }
      cardId = out.focus.id;
    }
    return decisionFeed.run(['pass', cardId, ...forwardedFlags], { cwd, env, deps });
  }

  if (sub === 'talk') {
    let cardId = positional[1];
    let message = positional.slice(2).join(' ').trim();
    if (!isCardId(cardId)) {
      message = positional.slice(1).join(' ').trim();
      const out = focusPayload(root, { filter: 'all', env, preferDecision: true });
      if (!out.focus) {
        if (json) console.log(JSON.stringify({ version: feed.FEED_VERSION, ok: false, error: { code: 'empty', message: 'no active card to talk on.' } }, null, 2));
        else console.error('error: no active card to talk on.');
        return 1;
      }
      cardId = out.focus.id;
    }
    if (!message) {
      const err = 'usage: atris element talk [<card>] "<words>"';
      if (json) console.log(JSON.stringify({ version: feed.FEED_VERSION, ok: false, error: { code: 'bad_request', message: err } }, null, 2));
      else console.error(`error: ${err}`);
      return 1;
    }
    return decisionFeed.run(['talk', cardId, message, ...forwardedFlags], { cwd, env, deps });
  }

  return decisionFeed.run(args, { cwd, env, deps });
}

function runFromCli(args) {
  Promise.resolve().then(() => run(args)).then((code) => { process.exitCode = code; }, (error) => {
    console.error(`error: ${String(error && error.message || error).split('\n')[0]}`);
    process.exitCode = 1;
  });
}

module.exports = { focusPayload, pickFocusCard, run, runFromCli };
