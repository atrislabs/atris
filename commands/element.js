'use strict';

// atris element: headless single-focus swarm interface.
// Combines single-card focus (Superhuman style), composable agent board primitives
// (post --id/--id-only, wait, tail, leased claim/complete), and performance loss curves.
// Shares 100% of lib/feed-core.js and commands/decision-feed.js state.

const feed = require('../lib/feed-core');
const ops = require('../lib/element-ops');
const cmds = require('../lib/element-commands');
const sched = require('../lib/element-schedules');
const inspect = require('../lib/element-inspect');
const decisionFeed = require('./decision-feed');

const ELEMENT_ACTIONS = new Set([
  'next', 'yes', 'no', 'pass', 'talk', 'post', 'wait', 'tail', 'claim', 'complete', 'curve', 'cmd', 'run', 'schedule', 'inspect', 'help',
]);

const VALUE_FLAGS = new Set([
  '--filter', '--note', '--limit', '--cursor', '--since', '--as', '--member', '--engine',
  '--id', '--after', '--timeout', '--interval', '--lease', '--wait', '--proof', '--file', '--window',
  '--description', '--every', '--to', '--now', '--port',
]);

const HELP = [
  'usage: atris element [--filter all|needs_decision|working|parked|done] [--json]',
  '       atris element next [--filter ...] [--json]                  show the one card needing focus right now',
  '       atris element yes [<card>] [--note "<text>"]                approve the top decision card (or <card>) and start work',
  '       atris element no [<card>] [--note "<text>"]                 dismiss the top card (or <card>)',
  '       atris element pass [<card>]                                 scroll past the top card (or <card>)',
  '       atris element talk [<card>] "<words>" [--stream]            talk with the top card\'s team member',
  '       atris element post "<words>" [--as <member>] [--id <key>] [--id-only] [--ask]',
  '                                                                   idempotent post; --id-only prints only the card id',
  '       atris element wait [<card>] [--after <reply-id>] [--timeout 5m]',
  '                                                                   block until a new reply or state change lands (race-free)',
  '       atris element tail [--limit 20] [--since <iso>] [--follow] [--timeout 30s] [--json]',
  '                                                                   stream Element events as lines or NDJSON',
  '       atris element claim --as <member> [--lease 5m] [--wait 30s] [--json]',
  '                                                                   claim the next ready card with a lease (no double-claim)',
  '       atris element complete <card> --as <member> --proof "<what passed>" ["<summary>"]',
  '                                                                   record a verified result and release the lease',
  '       atris element curve [--file <path>] [--limit 100] [--window 10] [--json]',
  '                                                                   loss curve, spend, p95 speed and slowest bottleneck',
  '       atris element cmd add <name> "<shell>" [--description "..."] | list | remove <name>',
  '                                                                   register deterministic /workflows (built-ins: /curve, /doctor)',
  '       atris element run /<name> [<card>] [--as <member>] [--json] run a registered workflow and post its receipt into the thread',
  '       atris element schedule add --every 1h --to <member> "<msg>" | list | remove <id> | tick',
  '                                                                   repeating board messages (cron as a message to an agent)',
  '       atris element inspect [--port 4100] [--no-open]             open the local Element web viewer on 127.0.0.1',
  '       atris element say | more | members | doctor | setup | theme all decision-feed commands work here too',
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
      } else if (VALUE_FLAGS.has(token)) {
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

// A chat that stopped and waits on the person is answered in its own window: yes, no and pass cannot act on it,
// so it never takes the one-card focus (it would hold it forever). It shows as its own line instead.
const isChat = (card) => Boolean(card && card.source && card.source.type === 'session');

function pickFocusCard(cards = [], { preferDecision = true } = {}) {
  if (!Array.isArray(cards)) return null;
  cards = cards.filter((c) => c && !isChat(c));
  if (!cards.length) return null;
  if (preferDecision) {
    const decide = cards.find((c) => c && c.needs_decision);
    if (decide) return decide;
  }
  return cards[0];
}

function focusPayload(root, { filter = 'all', env = process.env, preferDecision = true } = {}) {
  const listed = feed.listCards(root, { filter, limit: 25, env });
  const chats = listed.cards.filter(isChat).map((c) => ({ id: c.id, title: c.title, ask: c.body }));
  const cards = listed.cards.filter((c) => !isChat(c));
  const focus = pickFocusCard(cards, { preferDecision });
  const remaining = Math.max(0, cards.length - (focus ? 1 : 0));
  const actions = !focus
    ? ['atris element more', 'atris element post "<note>"']
    : focus.needs_decision
      ? ['atris element yes', 'atris element no', 'atris element pass', 'atris element talk "<words>"']
      : ['atris element pass', 'atris element talk "<words>"', 'atris element no'];
  return {
    version: feed.FEED_VERSION,
    goal: listed.theme ? listed.theme.text : '',
    counts: listed.counts,
    chats,
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
  const chats = out.chats || [];
  if (chats.length) {
    console.log(`\n${chats.length === 1 ? 'A chat is' : `${chats.length} chats are`} waiting on you in ${chats.length === 1 ? 'its own window' : 'their own windows'}:`);
    for (const chat of chats.slice(0, 3)) console.log(`  ${chat.title}`);
  }
  if (!out.focus) {
    console.log(chats.length ? '\nnothing else waiting for you right now.' : '\nclear. nothing waiting for you right now.');
    console.log('next: atris element more  |  atris element post "<note>"');
    return;
  }
  console.log(`\n${decisionFeed.textCard(out.focus)}`);
  if (out.remaining > 0) console.log(`\n${out.remaining} more in queue`);
  console.log(`next: ${out.actions.join('  |  ')}`);
}

function printCurve(out) {
  const s = out.summary || {};
  if (!s.total_episodes) {
    console.log('no episodes recorded yet.');
    return;
  }
  const lossStr = s.latest_rolling_loss !== null ? s.latest_rolling_loss.toFixed(2) : 'n/a';
  console.log(`loss curve (${s.total_episodes} episodes, window ${out.window}): ${out.sparkline || '(flat)'}`);
  console.log(`latest rolling loss: ${lossStr}  trend: ${s.trend}  spend: $${Number(s.total_spend_usd || 0).toFixed(2)}`);
  console.log(`p95 latency: ${s.p95_total_ms}ms  bottleneck: ${s.top_bottleneck || 'none'}  dispatched: ${s.dispatched_count}  failed: ${s.failed_count}`);
}

function printEventLine(ev) {
  const stamp = ev.at ? String(ev.at).slice(11, 19) : '--------';
  console.log(`${stamp}  ${String(ev.type || 'event').padEnd(10)} ${ev.member || '?'}  ${ev.card_id || ''}  ${ev.text || ''}`.trimEnd());
}

function fail(caught, json) {
  const error = feed.asFeedError(caught);
  if (!error) throw caught;
  if (json) console.log(JSON.stringify({ version: feed.FEED_VERSION, ok: false, error: error.toJSON() }, null, 2));
  else console.error(`error: ${error.message}`);
  return 1;
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
  if (!ELEMENT_ACTIONS.has(sub)) {
    return decisionFeed.run(args, { cwd, env, deps });
  }

  let root;
  try {
    root = feed.projectRoot(cwd);
  } catch (caught) {
    return fail(caught, json);
  }

  try {
    if (sub === 'next') {
      const out = focusPayload(root, { filter: flags.filter || 'all', env });
      if (json) console.log(JSON.stringify(out, null, 2));
      else printFocus(out);
      return 0;
    }

    if (sub === 'post') {
      const text = positional.slice(1).join(' ').trim();
      const out = ops.postIdempotent(root, {
        text,
        as: flags.as || null,
        ask: flags.ask === true,
        idKey: flags.id || null,
        env,
        deps,
      });
      if (flags['id-only']) console.log(out.card_id || '');
      else if (json) console.log(JSON.stringify(out, null, 2));
      else console.log(`${out.replayed ? 'existing' : 'posted'} ${out.card_id}`);
      return 0;
    }

    if (sub === 'wait') {
      let cardId = positional[1];
      if (!cardId) {
        const current = focusPayload(root, { filter: 'all', env, preferDecision: true });
        if (!current.focus) throw new feed.FeedError(404, 'no active card to wait on.');
        cardId = current.focus.id;
      }
      const timeoutMs = ops.parseDuration(flags.timeout, 300000);
      const intervalMs = ops.parseDuration(flags.interval, 200);
      const out = await ops.waitCard(root, cardId, { after: flags.after || null, timeoutMs, intervalMs, env });
      if (json) console.log(JSON.stringify(out, null, 2));
      else if (out.waited && out.reply) console.log(`${out.reply.author ? out.reply.author.name : 'reply'}: ${out.reply.text}`);
      else if (out.waited) console.log(`updated ${cardId} (${out.card ? out.card.state : out.reason})`);
      else console.error(`timed out waiting on ${cardId}`);
      return out.waited ? 0 : 1;
    }

    if (sub === 'tail') {
      const limit = Number.parseInt(flags.limit, 10) || 20;
      const follow = flags.follow === true;
      const timeoutMs = ops.parseDuration(flags.timeout, 30000);
      const intervalMs = ops.parseDuration(flags.interval, 250);
      await ops.tailEvents(root, {
        limit,
        since: flags.since || null,
        follow,
        timeoutMs,
        intervalMs,
        onEvent: (ev) => {
          if (json) console.log(JSON.stringify(ev));
          else printEventLine(ev);
        },
      });
      return 0;
    }

    if (sub === 'claim') {
      const leaseMs = ops.parseDuration(flags.lease, 300000);
      const waitMs = ops.parseDuration(flags.wait, 0);
      const intervalMs = ops.parseDuration(flags.interval, 200);
      const out = await ops.claimCard(root, { as: flags.as, leaseMs, waitMs, intervalMs, env });
      if (json) console.log(JSON.stringify(out, null, 2));
      else if (out.claimed) console.log(`${out.card.id}  leased to ${out.lease.holder} until ${out.lease.expires_at}  ${out.card.title}`);
      else console.log('no claimable card right now.');
      return out.claimed ? 0 : 1;
    }

    if (sub === 'complete') {
      const cardId = positional[1];
      const text = positional.slice(2).join(' ').trim();
      const out = ops.completeCard(root, cardId, { as: flags.as, proof: flags.proof, text, env, deps });
      if (json) console.log(JSON.stringify(out, null, 2));
      else console.log(`completed ${cardId}`);
      return 0;
    }

    if (sub === 'curve') {
      const out = ops.loadCurve(root, { file: flags.file || null, limit: flags.limit, window: flags.window });
      if (json) console.log(JSON.stringify(out, null, 2));
      else printCurve(out);
      return 0;
    }

    if (sub === 'cmd') {
      const action = positional[1] || 'list';
      if (action === 'list') {
        const out = cmds.listCommands(root);
        if (json) console.log(JSON.stringify(out, null, 2));
        else for (const c of out.commands) console.log(`/${c.name.padEnd(14)} ${c.builtin ? '[builtin]' : '[custom] '} ${c.description || c.command || ''}`.trimEnd());
        return 0;
      }
      if (action === 'add') {
        const name = positional[2];
        const shell = positional.slice(3).join(' ').trim();
        const timeoutMs = ops.parseDuration(flags.timeout, 60000);
        const out = cmds.addCommand(root, { name, command: shell, description: flags.description || '', timeoutMs });
        if (json) console.log(JSON.stringify(out, null, 2));
        else console.log(`registered /${out.command.name}`);
        return 0;
      }
      if (action === 'remove' || action === 'rm') {
        const out = cmds.removeCommand(root, positional[2]);
        if (json) console.log(JSON.stringify(out, null, 2));
        else console.log(out.removed ? `removed /${out.name}` : `not found: /${out.name}`);
        return 0;
      }
      throw new feed.FeedError(400, 'usage: atris element cmd add <name> "<shell>" | list | remove <name>');
    }

    if (sub === 'run') {
      const name = positional[1];
      if (!name) throw new feed.FeedError(400, 'usage: atris element run /<name> [<card>] [--as <member>] [--json]');
      const cardId = positional[2] || null;
      const out = await cmds.runSlashCommand(root, name, { cardId, as: flags.as || null, env, deps });
      if (json) console.log(JSON.stringify(out, null, 2));
      else console.log(`${out.receipt} (${out.card_id})`);
      return out.passed ? 0 : 1;
    }

    if (sub === 'schedule') {
      const action = positional[1] || 'list';
      const nowMs = flags.now ? Date.parse(flags.now) : Date.now();
      if (Number.isNaN(nowMs)) throw new feed.FeedError(400, `invalid --now timestamp: ${flags.now}`);
      if (action === 'list') {
        const out = sched.listSchedules(root);
        if (json) console.log(JSON.stringify(out, null, 2));
        else if (!out.schedules.length) console.log('no schedules set.');
        else for (const s of out.schedules) console.log(`${s.id.padEnd(20)} every ${s.every.padEnd(6)} @${s.to}  next ${s.next_run_at}  "${s.message}"`);
        return 0;
      }
      if (action === 'add') {
        const message = positional.slice(2).join(' ').trim();
        const out = sched.addSchedule(root, { id: flags.id || null, every: flags.every, to: flags.to, message, nowMs });
        if (json) console.log(JSON.stringify(out, null, 2));
        else console.log(`scheduled ${out.schedule.id} every ${out.schedule.every} -> @${out.schedule.to} (next ${out.schedule.next_run_at})`);
        return 0;
      }
      if (action === 'remove' || action === 'rm') {
        const out = sched.removeSchedule(root, positional[2]);
        if (json) console.log(JSON.stringify(out, null, 2));
        else console.log(out.removed ? `removed schedule ${out.id}` : `not found: ${out.id}`);
        return 0;
      }
      if (action === 'tick') {
        const out = sched.tickSchedules(root, { nowMs, env, deps });
        if (json) console.log(JSON.stringify(out, null, 2));
        else if (!out.count) console.log('no schedules due.');
        else for (const f of out.fired) console.log(`fired ${f.id} -> @${f.to} (${f.card_id})`);
        return 0;
      }
      throw new feed.FeedError(400, 'usage: atris element schedule add --every 1h --to <member> "<msg>" | list | remove <id> | tick');
    }

    if (sub === 'inspect') {
      const port = flags.port !== undefined ? Number.parseInt(flags.port, 10) : 4100;
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw new feed.FeedError(400, `invalid port: ${flags.port}`);
      }
      const instance = await inspect.startInspector(root, { port, host: '127.0.0.1', env, deps });
      if (json) console.log(JSON.stringify({ version: feed.FEED_VERSION, url: instance.url, port: instance.port }));
      else console.log(`element inspector running at ${instance.url} (ctrl+c to stop)`);
      if (flags['no-open'] !== true && process.platform === 'darwin' && !deps.skipOpen) {
        try { require('child_process').spawn('open', [instance.url], { detached: true, stdio: 'ignore' }).unref(); } catch { /* ignore */ }
      }
      if (deps.returnAfterStart) return 0;
      await new Promise((resolve) => {
        const stop = () => instance.close().then(resolve);
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
      });
      return 0;
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
        if (!out.focus) throw new feed.FeedError(404, 'no active card to talk on.');
        cardId = out.focus.id;
      }
      if (!message) throw new feed.FeedError(400, 'usage: atris element talk [<card>] "<words>"');
      return decisionFeed.run(['talk', cardId, message, ...forwardedFlags], { cwd, env, deps });
    }

    return decisionFeed.run(args, { cwd, env, deps });
  } catch (caught) {
    return fail(caught, json);
  }
}

function runFromCli(args) {
  Promise.resolve().then(() => run(args)).then((code) => { process.exitCode = code; }, (error) => {
    console.error(`error: ${String(error && error.message || error).split('\n')[0]}`);
    process.exitCode = 1;
  });
}

module.exports = { focusPayload, pickFocusCard, run, runFromCli };
