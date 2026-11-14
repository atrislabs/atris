'use strict';

// atris feed: the decision feed for a local project. Ideas from the team, a
// yes or no from the person, and checked results, from the project's own
// tasks. Same JSON as the cloud feed (atris.feed.v1). Logic: lib/feed-core.js.

const feed = require('../lib/feed-core');

const VALUE_FLAGS = new Set([
  '--filter', '--limit', '--cursor', '--since', '--as', '--title', '--why', '--body', '--detail',
  '--visual', '--kind', '--lane', '--note', '--story',
]);

function parse(args) {
  const positional = [];
  const flags = {};
  const story = [];
  let json = false;
  for (let i = 0; i < args.length; i += 1) {
    const token = String(args[i]);
    if (token === '--json') { json = true; continue; }
    if (token === '--help' || token === '-h') { flags.help = true; continue; }
    if (token === '--') { positional.push(...args.slice(i + 1).map(String)); break; }
    const eq = token.indexOf('=');
    const name = token.startsWith('--') && eq > 0 ? token.slice(0, eq) : token;
    if (VALUE_FLAGS.has(name)) {
      const value = eq > 0 && token.startsWith('--') ? token.slice(eq + 1) : args[i + 1];
      if (!(eq > 0 && token.startsWith('--'))) i += 1;
      if (value === undefined) throw new feed.FeedError(400, `${name} needs a value`);
      if (name === '--story') story.push(String(value));
      else flags[name.slice(2)] = String(value);
      continue;
    }
    positional.push(token);
  }
  if (story.length) flags.story = story;
  return { positional, flags, json };
}

function visualFlag(raw) {
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    throw new feed.FeedError(400, 'visual must be JSON, for example {"kind":"metric","label":"Paying customers","value":"12"}', { field: 'visual' });
  }
}

const HELP = [
  'usage: atris feed [cards] [--filter all|needs_decision|working|dismissed] [--limit N] [--cursor C] [--since T] [--json]',
  '       atris feed theme [--json]',
  '       atris feed theme set "<one plain sentence>"',
  '       atris feed propose --as <member> --title "<title>" --why "<how it moves the goal>"',
  '                          [--body "<text>"] [--detail "<technical notes>"] [--visual \'<json>\']',
  '                          [--kind proposal|question] [--lane money|billing|...] [--story "<line>"]',
  '       atris feed decide <card> approve|dismiss [--note "<text>"]',
  '       atris feed talk <card> "<message>" [--as <member>]',
  '       atris feed messages <card>',
  '       atris feed revise <card> --as <member> [--title ...] [--why ...] [--body ...] [--detail ...] [--visual ...]',
  '       atris feed more',
  '',
  'Ideas wait for a person. Approve hands the idea to its team member and starts it',
  `in the background (at most ${feed.FEED_MAX_RUNNING} at once; the rest wait in order).`,
];

function textCard(card) {
  const mark = card.needs_decision ? 'decide' : card.state;
  const lines = [`${mark.padEnd(8)}${card.title}`];
  if (card.why) lines.push(`        why: ${card.why}`);
  if (card.kind === 'result' || card.proof.status !== 'none') lines.push(`        proof: ${card.proof.status}`);
  if (card.run && card.run.status === 'queued') lines.push(`        waiting to start, number ${card.run.position} in line`);
  lines.push(`        ${card.author.name} · ${card.id}`);
  return lines.join('\n');
}

function printText(command, out) {
  if (command === 'cards') {
    const theme = out.theme.text ? `goal: ${out.theme.text}` : 'goal: not set. set it: atris feed theme set "<sentence>"';
    console.log(theme);
    console.log(`${out.counts.needs_decision} waiting for you, ${out.counts.working} being worked on, ${out.counts.done_today} done today`);
    for (const card of out.cards) console.log(`\n${textCard(card)}`);
    if (out.next_cursor) console.log(`\nmore: atris feed cards --cursor ${out.next_cursor}`);
    return;
  }
  if (command === 'theme') {
    console.log(out.theme ? (out.theme.text || 'no goal set yet') : (out.text || 'no goal set yet'));
    return;
  }
  if (command === 'messages') {
    for (const message of out.messages) console.log(`${message.from.name}: ${message.text}`);
    if (out.reply_pending) console.log('(waiting for the team member to answer)');
    if (!out.messages.length) console.log('no messages yet');
    return;
  }
  if (command === 'decide') {
    const outcome = out.outcome || {};
    const said = out.decision ? out.decision.choice : '';
    if (out.replayed) console.log(`already decided: ${said}`);
    else if (said === 'dismiss') console.log('dismissed.');
    else if (outcome.started) console.log('approved. the team member started on it.');
    else if (outcome.reason === 'queued') console.log(`approved. it starts when a slot frees up (number ${outcome.position} in line).`);
    else if (outcome.reason === 'accepted') console.log('accepted.');
    else console.log(`approved. not started: ${outcome.reason || 'unknown'}`);
    return;
  }
  if (command === 'more') {
    console.log(out.reason);
    return;
  }
  if (out.card) {
    console.log(textCard(out.card));
    return;
  }
  if (out.message) console.log(`sent. ${out.reply_pending ? 'the team member answers on its next run.' : ''}`.trim());
}

function run(args = [], context = {}) {
  const env = context.env || process.env;
  const deps = context.deps || {};
  let parsed;
  try {
    parsed = parse(args);
  } catch (error) {
    console.error(`error: ${error.message}`);
    return 2;
  }
  const { positional, flags, json } = parsed;
  const sub = positional[0] || 'cards';
  if (flags.help || sub === 'help') {
    console.log(HELP.join('\n'));
    return 0;
  }
  let command = sub;
  try {
    const root = feed.projectRoot(context.cwd || process.cwd());
    let out;
    if (sub === 'cards') {
      out = feed.listCards(root, { filter: flags.filter || 'all', limit: flags.limit, cursor: flags.cursor, since: flags.since, env });
    } else if (sub === 'theme') {
      if (positional[1] === 'set') {
        out = feed.setTheme(root, positional.slice(2).join(' '), { env });
      } else if (positional[1]) {
        throw new feed.FeedError(400, `unknown theme command: ${positional[1]}`);
      } else {
        out = { version: feed.FEED_VERSION, theme: feed.readTheme(root, feed.viewerOf(env)) };
      }
    } else if (sub === 'propose') {
      out = feed.proposeCard(root, {
        as: flags.as, title: flags.title, why: flags.why, body: flags.body, detail: flags.detail,
        visual: visualFlag(flags.visual), kind: flags.kind, lane: flags.lane, story: flags.story, env,
      });
    } else if (sub === 'decide') {
      const [, card, choice] = positional;
      if (!card || !choice) throw new feed.FeedError(400, 'usage: atris feed decide <card> approve|dismiss [--note "<text>"]');
      out = feed.decide(root, card, choice, { note: flags.note, env, deps });
    } else if (sub === 'talk') {
      const card = positional[1];
      if (!card) throw new feed.FeedError(400, 'usage: atris feed talk <card> "<message>"');
      out = feed.talk(root, card, positional.slice(2).join(' '), { as: flags.as, env });
    } else if (sub === 'messages') {
      if (!positional[1]) throw new feed.FeedError(400, 'usage: atris feed messages <card>');
      out = feed.listMessages(root, positional[1], { env });
    } else if (sub === 'revise') {
      if (!positional[1]) throw new feed.FeedError(400, 'usage: atris feed revise <card> --as <member> ...');
      out = feed.revise(root, positional[1], {
        as: flags.as, title: flags.title, why: flags.why, body: flags.body, detail: flags.detail,
        visual: visualFlag(flags.visual), story: flags.story, env,
      });
    } else if (sub === 'more') {
      out = feed.requestMoreIdeas(root, { env, deps });
    } else if (sub === 'run') {
      // Internal: the detached runner that `decide` and `more` start.
      if (!positional[1]) throw new feed.FeedError(400, 'usage: atris feed run <run id>');
      feed.runEntry(root, positional[1], deps);
      return 0;
    } else {
      command = 'unknown';
      throw new feed.FeedError(400, `unknown feed command: ${sub}. see: atris feed --help`);
    }
    if (json) console.log(JSON.stringify(out, null, 2));
    else printText(command, out);
    return 0;
  } catch (error) {
    if (!(error instanceof feed.FeedError)) throw error;
    if (json) console.log(JSON.stringify({ version: feed.FEED_VERSION, ok: false, error: error.toJSON() }, null, 2));
    else console.error(`error: ${error.message}`);
    return error.status === 400 && command === 'unknown' ? 2 : 1;
  }
}

const DECISION_SUBCOMMANDS = new Set(['cards', 'theme', 'propose', 'decide', 'talk', 'messages', 'revise', 'more', 'run', 'help']);

// Which feed a command line means. `atris feed list` and `atris feed post`
// stay the business group feed (commands/feed.js); bare `atris feed` is this
// decision feed unless it carries the group feed's own options (--author,
// --full, or a --since window like 7d).
function handles(args = []) {
  const first = args.find((arg) => !String(arg).startsWith('-'));
  if (first) return DECISION_SUBCOMMANDS.has(first);
  if (args.includes('--author') || args.includes('--full')) return false;
  const since = args.indexOf('--since');
  if (since >= 0 && /^\d+[mhd]$/i.test(String(args[since + 1] || ''))) return false;
  return true;
}

// The fast path from bin/atris.js: the desktop app keeps the feed open all
// day, so this answers before the rest of the CLI loads.
function runFromCli(args) {
  let code;
  try {
    code = run(args);
  } catch (error) {
    console.error(`error: ${String(error && error.message || error).split('\n')[0]}`);
    code = 1;
  }
  process.exitCode = code;
}

module.exports = { handles, run, runFromCli };
