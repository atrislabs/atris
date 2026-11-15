'use strict';

// atris feed: the decision feed for a local project. Ideas from the team, a
// yes or no from the person, and checked results, from the project's own
// tasks. Same JSON as the cloud feed (atris.feed.v1). Logic: lib/feed-core.js.

const feed = require('../lib/feed-core');

function team() {
  return require('../lib/feed-team');
}

function room() {
  return require('../lib/feed-room');
}

const VALUE_FLAGS = new Set([
  '--filter', '--limit', '--cursor', '--since', '--as', '--title', '--why', '--body', '--detail',
  '--visual', '--kind', '--lane', '--note', '--story', '--reason', '--card', '--proof', '--text', '--engine', '--choose', '--member', '--wait', '--cards',
]);
const BOOL_FLAGS = new Set(['--stream', '--no-call', '--ask']);

function parse(args) {
  const positional = [];
  const flags = {};
  const story = [];
  let json = false;
  for (let i = 0; i < args.length; i += 1) {
    const token = String(args[i]);
    if (token === '--json') { json = true; continue; }
    if (token === '--help' || token === '-h') { flags.help = true; continue; }
    if (BOOL_FLAGS.has(token)) { flags[token.slice(2)] = true; continue; }
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
  'The feed changed meaning: bare `atris feed` now opens this decision feed. The business group feed is',
  '`atris feed list` and `atris feed post`. For one release a bare call whose output is not a terminal (and has',
  'no --json) still shows the group feed, with a notice on stderr.',
  '',
  'usage: atris feed [cards] [--filter all|needs_decision|working|parked|done|dismissed] [--limit N] [--cursor C] [--since T] [--json]',
  '       atris feed pass <card> [<card> ...] [--cards \'[{"id":...,"seen":false}]\']   (scrolled past; three passes park an idea, a passed result is read; cards under 10 seconds old or never seen are left alone)',
  '       atris feed theme [--json]',
  '       atris feed theme set "<one plain sentence>"',
  '       atris feed propose --as <member> --title "<title>" --why "<how it moves the goal>"',
  '                          [--body "<text>"] [--detail "<technical notes>"] [--visual \'<json>\']',
  '                          [--kind proposal|question] [--lane money|billing|...] [--story "<line>"]',
  '       atris feed decide <card> approve|dismiss [--note "<text>"]',
  '       atris feed talk <card> "<message>" [--stream] [--as <member>]   or   atris feed talk <card> --choose <id>',
  '                          (the card\'s member answers at once, one tool-free turn on its model; --stream prints it as it comes)',
  '       atris feed messages <card>',
  '       atris feed revise <card> --as <member> [--title ...] [--why ...] [--body ...] [--detail ...] [--visual ...]',
  '       atris feed more                     (wakes up to 3 ON members to look for ideas: a ping with reason scroll)',
  '       atris feed settings [set default-engine <id>]   the one default model for members with none of their own',
  '       atris feed engines                  the models usable on this computer right now',
  '       atris feed members                  the team: on or off, model in effect, last active, what it is doing',
  '       atris feed member on|off <name>',
  '       atris feed ping [<member>] [--reason scroll|heartbeat|event] [--stream]',
  '                          (members think up ideas in one fast turn each, up to 3 at once; --stream prints cards as they are written)',
  '       atris feed settings set local-pings-per-day <n> | cloud-pings-per-day <n> | member-gap-seconds <n>',
  '       atris feed emit --as <member> idea|question --title "..." --why "..." | progress --card <card> "<line>"',
  '                          | result --card <card> --proof "<what you ran and what it showed>" ["<plain line>"]',
  '       atris feed events [--limit N]        the stream of what members put in the feed',
  '       atris feed say "<one or two plain sentences>" [--as <member>] [--ask]',
  '                          (a short note in the feed, yours unless --as names a team member; with --ask, a question anyone can answer)',
  '       atris feed react <card> 👍|❤️|😂|🔥|👀 [--as <member>]   (taps that reaction on or off, as you unless --as)',
  '       atris feed reply <card> "<text>" [--as <member>]          (a short reply on any card, at most 280 characters)',
  '       atris feed start <folder> [--engine <id>]   set up a folder of projects, add a starter team, turn it on, first ping',
  '       atris feed doctor [--no-call]       before a demo: what is ready, what is not, and the one thing to do (exits 1 when not ready)',
  '       atris feed repair                   put right runs, replies and approvals left half done; says what it fixed',
  '       atris feed notes [--member <name>]  what the owner taught the team in card conversations; notes forget <id> removes one',
  '',
  'Ideas wait for a person. Approve hands the idea to its team member and starts it',
  `in the background (at most ${feed.FEED_MAX_RUNNING} at once; the rest wait in order).`,
];

function textCard(card) {
  const note = card.kind === 'post' || card.kind === 'ask';
  const mark = note ? card.kind : card.needs_decision ? 'decide' : card.state;
  const lines = [`${mark.padEnd(8)}${card.title}`];
  if (card.why) lines.push(`        why: ${card.why}`);
  if (card.kind === 'result' || card.proof.status !== 'none') lines.push(`        proof: ${card.proof.status}`);
  if (card.run && card.run.status === 'queued') lines.push(`        waiting to start, number ${card.run.position} in line`);
  lines.push(`        ${card.author.name} · ${card.id}`);
  const count = card.reply_count || 0;
  const social = [(card.reactions || []).map((r) => `${r.emoji} ${r.count}`).join(' '), count ? `${count} repl${count === 1 ? 'y' : 'ies'}` : '']
    .filter(Boolean).join(' · ');
  if (social) lines.push(`        ${social}`);
  for (const reply of card.replies || []) lines.push(`          ${reply.author.name}: ${reply.text}`);
  return lines.join('\n');
}

function printText(command, out) {
  if (command === 'cards') {
    const theme = out.theme.text ? `goal: ${out.theme.text}` : 'goal: not set. set it: atris feed theme set "<sentence>"';
    console.log(theme);
    console.log(`${out.counts.needs_decision} waiting for you, ${out.counts.working} being worked on, ${out.counts.new_results} new results, ${out.counts.parked} parked, ${out.counts.done_today} done today`);
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
  if (command === 'talk') {
    if (out.reply) console.log(`${out.reply.from.name}: ${out.reply.text}`);
    else console.log(out.reply_skipped || 'sent.');
    return;
  }
  if (command === 'members') {
    for (const m of out.members) console.log(`${m.on ? 'on ' : 'off'}  ${m.name.padEnd(14)} ${m.engine_name}${m.engine_available ? '' : ' (cannot run here)'}${m.doing ? `  · ${m.doing}` : ''}`);
    return;
  }
  if (command === 'member') {
    printText('members', out);
    return;
  }
  if (command === 'engines') {
    for (const e of out.engines) console.log(`${e.available ? 'ready' : '-    '}  ${e.id.padEnd(14)} ${e.name} (${e.kind})${e.reason ? `: ${e.reason}` : ''}`);
    console.log(`default for members with none of their own: ${out.engine_in_effect}`);
    return;
  }
  if (command === 'settings') {
    console.log(`default model: ${out.engine_in_effect}${out.default_engine ? '' : ' (the workspace default)'}${out.engine_available ? '' : `, cannot run here: ${out.engine_reason}`}`);
    return;
  }
  if (command === 'ping') {
    console.log(out.reason);
    return;
  }
  if (command === 'emit') {
    console.log(`${out.event.type} in the feed${out.card ? `: ${out.card.title}` : ''}`);
    return;
  }
  if (command === 'events') {
    for (const e of out.events) console.log(`${String(e.at).slice(0, 16).replace('T', ' ')}  ${e.member}  ${e.type}: ${e.text}`);
    if (!out.events.length) console.log('nothing yet');
    return;
  }
  if (command === 'doctor') {
    for (const check of out.checks) {
      console.log(`${check.ok ? 'ready' : check.blocking ? 'NOT  ' : 'note '}  ${check.name.padEnd(16)} ${check.detail}`);
      if (check.fix) console.log(`${' '.repeat(24)}do: ${check.fix}`);
    }
    console.log(out.ready ? `\nready (${(out.took_ms / 1000).toFixed(1)}s)` : `\nnot ready (${(out.took_ms / 1000).toFixed(1)}s)`);
    return;
  }
  if (command === 'notes') {
    if (out.forgot) { console.log(`forgot: ${out.forgot.text}`); return; }
    for (const note of out.notes) console.log(`${note.id}  ${note.scope === 'team' ? 'team' : note.member}: ${note.text}`);
    if (!out.notes.length) console.log('nothing learned yet');
    return;
  }
  if (command === 'repair') {
    console.log(out.fixed.length ? out.fixed.map((line) => `fixed: ${line}`).join('\n') : 'nothing needed fixing');
    if (out.started) console.log(`started ${out.started} waiting run${out.started === 1 ? '' : 's'}`);
    return;
  }
  if (command === 'start') {
    console.log(`${out.folder}: ${out.steps.join('; ')}. ${out.ping.reason}`);
    return;
  }
  if (command === 'pass') {
    console.log(`passed ${out.passed}.${out.skipped.length ? ` not passed: ${out.skipped.join(' ')}` : ''}`);
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

async function run(args = [], context = {}) {
  const env = context.env || process.env;
  const deps = context.deps || {};
  const write = context.write || ((text) => process.stdout.write(text));
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
    if (sub === 'doctor') {
      const out = await team().doctor(context.cwd || process.cwd(), { env, deps, call: !flags['no-call'] });
      if (json) console.log(JSON.stringify(out, null, 2));
      else printText('doctor', out);
      return out.ready ? 0 : 1;
    }
    if (sub === 'start') {
      const out = await team().start(positional[1] || context.cwd || process.cwd(), { env, deps, engine: flags.engine });
      if (json) console.log(JSON.stringify(out, null, 2));
      else printText('start', out);
      return 0;
    }
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
    } else if (sub === 'pass') {
      // --cards '[{"id": "...", "seen": false}]' lets the screen say which cards were never on screen.
      let items = positional.slice(1);
      if (flags.cards) {
        try { items = items.concat(JSON.parse(flags.cards)); } catch { throw new feed.FeedError(400, 'cards must be JSON, like [{"id": "task:...", "seen": false}]'); }
      }
      out = feed.passCards(root, items, { env });
    } else if (sub === 'talk') {
      const card = positional[1];
      if (!card) throw new feed.FeedError(400, 'usage: atris feed talk <card> "<message>"');
      // --stream --json: one JSON event per line (saved, chunk, reply, revision, done).
      // --stream alone: the answer's words as they come. --json alone: the final answer.
      const onEvent = !flags.stream ? null : json
        ? (event) => write(`${JSON.stringify(event)}\n`)
        : (event) => { if (event.type === 'chunk') write(event.text); else if (event.type === 'done') write('\n'); };
      try {
        out = await feed.talk(root, card, positional.slice(2).join(' '), { as: flags.as, choose: flags.choose, env, deps, onEvent });
      } catch (error) {
        if (flags.stream && json && error instanceof feed.FeedError) {
          write(`${JSON.stringify({ type: 'error', ok: false, error: error.toJSON() })}\n`);
          return 1;
        }
        throw error;
      }
      if (flags.stream) return 0;
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
    } else if (sub === 'settings') {
      if (positional[1] === 'set') {
        if (!positional[2] || positional[3] === undefined) throw new feed.FeedError(400, 'usage: atris feed settings set default-engine <id> | local-pings-per-day <n> | cloud-pings-per-day <n> | member-gap-seconds <n>');
        out = positional[2] === 'default-engine'
          ? team().setDefaultEngine(root, positional[3], { env })
          : team().setLimit(root, positional[2], positional[3], { env });
      } else if (positional[1]) {
        throw new feed.FeedError(400, `unknown settings command: ${positional[1]}`);
      } else {
        out = team().settingsView(root, { env });
      }
    } else if (sub === 'engines') {
      out = { version: feed.FEED_VERSION, engines: team().listEngines({ env }), ...team().settingsView(root, { env }) };
    } else if (sub === 'members') {
      out = team().listMembers(root, { env });
    } else if (sub === 'member') {
      const [, onOff, name] = positional;
      if (!['on', 'off'].includes(onOff) || !name) throw new feed.FeedError(400, 'usage: atris feed member on|off <name>');
      out = team().setOn(root, name, onOff === 'on', { env });
    } else if (sub === 'ping' || sub === 'think') {
      // ping: wake members to think up ideas. --stream prints each event as it
      // happens (member_started, card_started, card_text, card_visual,
      // card_done or card_dropped, member_done, done); without it the thinking
      // runs in the background and this answers at once. think is the
      // background half, for members ping already planned.
      const onEvent = flags.stream ? (event) => write(`${JSON.stringify(event)}\n`) : null;
      if (sub === 'think') {
        const wait = Math.min(60000, Math.max(0, Number(flags.wait) || 0));
        if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
        const results = await team().think(root, positional.slice(1), { reason: flags.reason || 'scroll', env, deps, onEvent });
        out = { version: feed.FEED_VERSION, members: results };
      } else if (flags.stream) {
        await team().pingStream(root, { member: positional[1], reason: flags.reason || 'scroll', env, deps, onEvent });
        return 0;
      } else {
        const result = team().ping(root, { member: positional[1], reason: flags.reason || 'scroll', env, deps });
        delete result.plan;
        out = result;
      }
    } else if (sub === 'emit') {
      out = team().emit(root, {
        as: flags.as, type: positional[1], title: flags.title, why: flags.why, body: flags.body, detail: flags.detail,
        visual: visualFlag(flags.visual), lane: flags.lane, card: flags.card, proof: flags.proof,
        text: flags.text || positional.slice(2).join(' '), env, deps,
      });
    } else if (sub === 'say') {
      out = room().say(root, { as: flags.as, text: flags.text || positional.slice(1).join(' '), ask: flags.ask === true, env, deps });
    } else if (sub === 'react') {
      const [, card, emoji] = positional;
      if (!card || !emoji) throw new feed.FeedError(400, 'usage: atris feed react <card> <emoji> [--as <member>]');
      out = room().react(root, card, emoji, { as: flags.as, env, deps });
    } else if (sub === 'reply') {
      const card = positional[1];
      const text = flags.text || positional.slice(2).join(' ');
      if (!card || !text) throw new feed.FeedError(400, 'usage: atris feed reply <card> "<text>" [--as <member>]');
      out = room().reply(root, card, text, { as: flags.as, env, deps });
    } else if (sub === 'events') {
      out = { version: feed.FEED_VERSION, events: team().readEvents(root, { limit: Number.parseInt(flags.limit, 10) || 50 }) };
    } else if (sub === 'notes') {
      const digest = require('../lib/feed-digest');
      if (positional[1] === 'forget') {
        if (!positional[2]) throw new feed.FeedError(400, 'usage: atris feed notes forget <id>');
        if (feed.viewerOf(env).agent) throw new feed.FeedError(403, 'Only a person can remove what the team was taught.');
        out = { version: feed.FEED_VERSION, forgot: digest.forgetNote(root, positional[2]) };
      } else {
        out = { version: feed.FEED_VERSION, notes: digest.listNotes(root, { member: flags.member || null }) };
      }
    } else if (sub === 'repair') {
      out = team().repair(root, { env, deps });
    } else if (sub === 'run') {
      // Internal: the detached runner that decide, ping and more start.
      if (!positional[1]) throw new feed.FeedError(400, 'usage: atris feed run <run id>');
      await feed.runEntry(root, positional[1], deps);
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

const DECISION_SUBCOMMANDS = new Set(['cards', 'theme', 'propose', 'decide', 'pass', 'talk', 'messages', 'revise', 'more', 'run', 'help',
  'settings', 'engines', 'members', 'member', 'ping', 'think', 'emit', 'events', 'start', 'doctor', 'repair', 'notes',
  'say', 'react', 'reply']);

const LEGACY_BARE_NOTICE = 'note: bare `atris feed` now opens the decision feed. Output is not a terminal, so this run showed the '
  + 'business group feed as before; that ends next release. Use `atris feed list` for the group feed, `atris feed cards --json` for the new one.';

// Which feed a command line means, and the one-line notice to print first.
// `atris feed list` and `atris feed post` stay the business group feed
// (commands/feed.js). Bare `atris feed` is this decision feed, except:
// with the group feed's own options (--author, --full, a --since window like
// 7d) it stays the group feed; and for one release, when output is not a
// terminal and neither a subcommand nor --json is given, it behaves as before
// (the group feed) and says so on stderr, so a script reading the old output
// does not silently get something else.
function route(args = [], { isTTY = false } = {}) {
  const first = args.find((arg) => !String(arg).startsWith('-'));
  if (first) return { decision: DECISION_SUBCOMMANDS.has(first), notice: '' };
  if (args.includes('--help') || args.includes('-h')) return { decision: true, notice: '' };
  if (args.includes('--author') || args.includes('--full')) return { decision: false, notice: '' };
  const since = args.indexOf('--since');
  if (since >= 0 && /^\d+[mhd]$/i.test(String(args[since + 1] || ''))) return { decision: false, notice: '' };
  if (args.includes('--json') || isTTY) return { decision: true, notice: '' };
  return { decision: false, notice: LEGACY_BARE_NOTICE };
}

function handles(args = [], options = {}) {
  return route(args, options).decision;
}

// The fast path from bin/atris.js: the desktop app keeps the feed open all
// day, so this answers before the rest of the CLI loads.
function runFromCli(args) {
  Promise.resolve().then(() => run(args)).then((code) => { process.exitCode = code; }, (error) => {
    console.error(`error: ${String(error && error.message || error).split('\n')[0]}`);
    process.exitCode = 1;
  });
}

module.exports = { LEGACY_BARE_NOTICE, handles, route, run, runFromCli };
