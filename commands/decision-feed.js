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

function standingYes() {
  return require('../lib/feed-standing-yes');
}

const VALUE_FLAGS = new Set([
  '--filter', '--limit', '--cursor', '--since', '--as', '--title', '--why', '--body', '--detail',
  '--visual', '--kind', '--lane', '--note', '--story', '--reason', '--card', '--proof', '--text', '--engine', '--choose', '--member', '--wait', '--cards', '--goal',
  '--reply',
  '--session', '--ask', '--append-b64', '--failed',
]);
const BOOL_FLAGS = new Set(['--first', '--last', '--stream', '--no-call', '--ask', '--retry', '--run', '--tagged', '--independent', '--confirm', '--dry-run', '--undo', '--done', '--needs-sign-in']);

function parse(args) {
  const positional = [];
  const flags = {};
  const story = [];
  const waiting = args.find((arg) => !String(arg).startsWith('-')) === 'waiting';
  let json = false;
  for (let i = 0; i < args.length; i += 1) {
    const token = String(args[i]);
    if (token === '--json') { json = true; continue; }
    if (token === '--help' || token === '-h') { flags.help = true; continue; }
    if (BOOL_FLAGS.has(token) && !(waiting && token === '--ask')) { flags[token.slice(2)] = true; continue; }
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
  `                          (the main list drops finished work and notes quiet for ${feed.FRESH_HOURS} hours; they stay under their own filter)`,
  '       atris feed pass <card> [<card> ...] [--cards \'[{"id":...,"seen":false}]\']   (scrolled past; three passes park an idea, a passed result is read; cards under 10 seconds old or never seen are left alone)',
  '       atris feed theme [--json]',
  '       atris feed theme set "<one plain sentence>"',
  '       atris feed propose --as <member> --title "<title>" --why "<how it moves the goal>"',
  '                          [--body "<text>"] [--detail "<technical notes>"] [--visual \'<json>\']',
  '                          [--kind proposal|question] [--lane money|billing|...] [--story "<line>"]',
  '       atris feed decide <card> approve|dismiss [--note "<text>"]',
  '       atris feed dismiss <card> [<card> ...] [--undo]',
  '                          (takes cards off your feed: an idea or question waiting for you is dismissed as with decide;',
  '                          any other card is hidden for you only and shows under --filter dismissed. --undo brings it back)',
  '       atris feed unqueue <card>   take approved work off the waiting line; the card comes back to you, approve again to re-add it',
  '       atris feed move <card> --first|--last|--to <place>   move approved work within the waiting line (1 is next)',
  '       atris feed waiting set --session <id> --ask "<one or two plain sentences>" [--title "<window name>"] [--engine <name>]',
  '       atris feed waiting clear --session <id>',
  '       atris feed waiting list [--json]',
  '       atris feed talk <card> "<message>" [--stream] [--as <member>]   or   atris feed talk <card> --choose <id>',
  '                          (the card\'s member answers at once, one tool-free turn on its model; --stream prints it as it comes)',
  '       atris feed talk --member <name> [--independent] [--engine <id>] [--stream] [--json] -- <card> ["<words>"]',
  '                          (any awake member answers on any card, one turn counted like a ping; your words, when given, are saved',
  '                          first as your comment, once; the answer is saved as the member\'s comment. Only a person can ask.',
  '                          --independent: the member reads only your words, not what teammates said, for its own view)',
  '       atris feed replies <card> [--limit N]   every comment on a card, oldest first (at most 500)',
  '       atris feed messages <card>',
  '       atris feed revise <card> --as <member> [--title ...] [--why ...] [--body ...] [--detail ...] [--visual ...]',
  '       atris feed more                     (wakes up to 3 ON members to look for ideas: a ping with reason scroll)',
  '       atris feed settings [set default-engine <id>]   the one default model for members with none of their own',
  '       atris feed settings set member-engine <member> <id|none>   the model one member uses in the feed. With no choice the feed',
  '                          runs on Codex on this computer when it is signed in, else Atris 2 Fast; Fable and Claude Code run only when you pick them here.',
  '       atris feed engines                  the models usable on this computer right now (the Atris models: atris-fast, atris-pro, atris-max)',
  '       atris feed members                  the team: on or off, model in effect, last active, what it is doing; [cloud on|off] when the cloud wake switch disagrees',
  '       atris feed member on|off <name>          also sets waking on notes in the cloud, in a business folder',
  '       atris feed ping [<member>] [--reason scroll|heartbeat|event|refresh|more] [--stream]',
  '                          (members think up ideas in one fast turn each, up to 3 at once; --stream prints cards as they are written)',
  '       atris feed settings set local-pings-per-day <n> | cloud-pings-per-day <n> | member-gap-seconds <n>',
  '       atris feed settings set standing-yes on|off | standing-yes-per-day <n>   (off by default; when on, a proposal',
  '                          a teammate backs, with no guarded lane, you never talked on or scrolled past, starts by',
  '                          itself as if you approved it, at most <n> a day, default 3; 0 turns it off)',
  '       atris feed emit --as <member> idea|question --title "..." --why "..." | progress --card <card> "<line>"',
  '                          | result --card <card> --proof "<what you ran and what it showed>" ["<plain line>"]',
  '       atris feed events [--limit N]        the stream of what members put in the feed',
  '       atris feed say "<one or two plain sentences>" [--as <member>] [--ask]',
  '                          (a short note in the feed, yours unless --as names a team member; with --ask, a question anyone can answer)',
  '       atris feed clear --confirm           delete feed posts and comments; keep project tasks',
  '       atris feed scrub-keys [--dry-run]    counts saved comments, posts, events and member logs that hold a password',
  '                          or key; without --dry-run replaces each with a short marker (never prints the text)',
  '       atris feed react <card> 👍|❤️|😂|🔥|👀 [--as <member>]   (taps that reaction on or off, as you unless --as)',
  '       atris feed reply <card> "<text>" [--as <member>]          (a comment on any card, at most 1000 characters)',
  '                          (yours naming @<member> asks each named, awake member to answer it once, right away, in the',
  '                          comments; --json says who in "tagged". A tag asks for an answer, never starts the work)',
  '       atris feed discuss <card> [--retry] [--stream]',
  '                          (Atris reads your post, or your newest comment on it, with the project and the team, picks up to',
  '                          two awake members whose roles fit, and asks each for its own view as a comment. Once for each thing',
  '                          you write, one round at a time, at most 5 rounds a card; --retry runs a failed round again)',
  '       atris feed work <card> --reply <comment> [--retry]',
  '                          (turns a teammate\'s comment on the card into work: proposed as that member\'s idea and approved by you,',
  '                          the same yes as approve, with every guard it has; its state and result show on this card. One task per',
  '                          comment; --retry starts it again only after it failed. A comment that is only "@member do it" does the same.)',
  '       atris feed start <folder> [--engine <id>] [--goal "<one plain sentence>"]',
  '                          (set up a folder of projects, add a starter team when it has none, turn it on, set the goal, first ping)',
  '       atris feed setup [--stream] [--json] [--engine <id>]',
  '                          (set up this project while you watch: the starter team joins one card at a time, the project is read',
  '                          by plain rules into a few cards of what was found, then at most three questions, one at a time.',
  '                          A reply on a question is saved in the project lessons; no model is used. Safe to run again.',
  '                          --stream --json prints one line per step, then {"type":"done",...})',
  '       atris feed setup skip [<card>]      skip the setup question waiting for you; nothing is saved',
  '       atris feed doctor [--no-call]       before a demo: what is ready, what is not, and the one thing to do (exits 1 when not ready)',
  '       atris feed repair                   put right runs, replies and approvals left half done; says what it fixed',
  '       atris feed turns [--json]           with ATRIS_FEED_TURNS=caller, the questions for an Atris model waiting for someone else',
  '                          to ask them, oldest first, and whether a teammate is still thinking. The feed never asks the model itself then.',
  '       atris feed turns show <id> --json   one waiting question, in full',
  '       atris feed turns answer <id> --append-b64 <text in base64>   add to its answer (as many times as needed)',
  '       atris feed turns answer <id> --done | --failed "<one plain sentence>" [--needs-sign-in]   finish it',
  '       atris feed notes [--member <name>]  what the owner taught the team in card conversations; notes forget <id> removes one',
  '',
  'Ideas wait for a person. Approve hands the idea to its team member and starts it',
  `in the background (at most ${feed.FEED_MAX_RUNNING} at once; the rest wait in order).`,
];

function textCard(card) {
  const note = card.kind === 'post' || card.kind === 'ask';
  const waiting = card.source.type === 'session';
  const campaign = card.source.type === 'campaign' ? card.campaign : null;
  const mark = waiting ? 'waiting' : note ? card.kind : card.needs_decision ? (campaign ? 'answer' : 'decide') : campaign ? 'campaign' : card.state;
  const lines = [`${mark.length < 8 ? mark.padEnd(8) : `${mark} `}${card.title}`];
  if (waiting || campaign) lines.push(`        ${card.body}`);
  // A campaign's card carries what happened last, newest at the bottom.
  if (campaign && Array.isArray(card.steps)) for (const step of card.steps.slice(-5)) lines.push(`          ${step.who}${step.engine ? ` (${step.engine})` : ''}: ${step.text}`);
  if (card.why) lines.push(`        why: ${card.why}`);
  if (card.kind === 'result' || card.proof.status !== 'none') lines.push(`        proof: ${card.proof.status}`);
  if (card.run && card.run.status === 'queued') lines.push(`        waiting to start, number ${card.run.position} in line`);
  lines.push(`        ${card.author.name} · ${card.id}`);
  const count = card.reply_count || 0;
  const social = [(card.reactions || []).map((r) => `${r.emoji} ${r.count}`).join(' '), count ? `${count} repl${count === 1 ? 'y' : 'ies'}` : '']
    .filter(Boolean).join(' · ');
  if (social) lines.push(`        ${social}`);
  for (const reply of card.replies || []) lines.push(`          ${reply.author.name}${reply.kind ? ` (${reply.kind})` : ''}: ${reply.text}`);
  if (card.outcome) {
    lines.push(`        outcome: ${card.outcome.answer}`);
    lines.push(`        next: ${card.outcome.next} (${card.outcome.owner.type === 'user' ? 'yours' : `${card.outcome.owner.name} has it next`})`);
    if (card.outcome.needs_you) lines.push(`        needs you: ${card.outcome.needs_you.question}${card.outcome.needs_you.choices.length ? ` [${card.outcome.needs_you.choices.join(' | ')}]` : ''}`);
  }
  return lines.join('\n');
}

function printText(command, out, { streamed = false } = {}) {
  if (command === 'setup') {
    if (!streamed) for (const entry of out.steps) console.log(entry.text);
    const waiting = out.asks.waiting;
    console.log(waiting ? `set up. waiting on your answer: ${waiting.text}` : 'set up. nothing is waiting on you.');
    return;
  }
  if (command === 'clear') {
    console.log('Feed cleared. Project tasks and activity records remain.');
    return;
  }
  if (command === 'waiting') {
    if (out.skipped) {
      console.log('skipped: background member run.');
      return;
    }
    if (Array.isArray(out.waiting)) {
      for (const entry of out.waiting) console.log(`${entry.title || 'Chat window'} (${entry.session}): ${entry.ask}`);
      if (!out.waiting.length) console.log('no chats waiting');
    } else if (out.waiting) console.log('chat is waiting for your answer.');
    return;
  }
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
  if (command === 'discuss') {
    const d = out.discussion;
    if (!d) { console.log('nothing started.'); return; }
    const names = d.picks.map((p) => `${p.member} (${p.status})`).join(', ');
    console.log(d.message || (names ? `Atris asked ${names}.` : `Atris is ${d.status === 'choosing' ? 'choosing who should answer' : d.status}.`));
    if (out.replayed) console.log('(already started for these words; nothing was asked again)');
    if (out.queued) console.log('(a round is running; your newest words get the next one)');
    return;
  }
  if (command === 'work') {
    const w = out.work;
    if (!w) { console.log('nothing started.'); return; }
    console.log(`${w.member}: ${w.message || w.status}${out.replayed ? ' (already asked; nothing new was started)' : ''}`);
    return;
  }
  if (command === 'messages') {
    for (const message of out.messages) console.log(`${message.from.name}: ${message.text}`);
    if (out.reply_pending) console.log('(waiting for the team member to answer)');
    if (!out.messages.length) console.log('no messages yet');
    return;
  }
  if (command === 'decide' && out.ask_id) {
    console.log(out.answered ? `answered. the campaign has your answer: ${out.answer}` : 'not closed: only a person can answer this.');
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
    else if (outcome.reason === 'standing_mission_confirmed') console.log('confirmed. these words carry your yes again.');
    else console.log(`approved. not started: ${outcome.reason || 'unknown'}`);
    return;
  }
  if (command === 'ask') {
    console.log(`${out.reply.author.name}: ${out.reply.text}`);
    return;
  }
  if (command === 'replies') {
    for (const reply of out.replies) console.log(`${reply.author.name}: ${reply.text}`);
    if (!out.replies.length) console.log('no comments yet');
    if (out.truncated) console.log(`(${out.reply_count + (out.dropped || 0) - out.replies.length} older comment(s) not shown)`);
    return;
  }
  if (command === 'talk' && out.ask_id) {
    printText('decide', out);
    return;
  }
  if (command === 'talk') {
    if (out.reply) console.log(`${out.reply.from.name}: ${out.reply.text}`);
    else console.log(out.reply_skipped || 'sent.');
    return;
  }
  if (command === 'members') {
    const { mismatchMark } = require('../lib/wake-sync');
    for (const m of out.members) console.log(`${m.on ? 'on ' : 'off'}  ${m.name.padEnd(14)} ${m.engine_name}${m.engine_available ? '' : ' (cannot run here)'}${m.doing ? `  · ${m.doing}` : ''}${mismatchMark(m)}`);
    return;
  }
  if (command === 'member') {
    printText('members', out);
    if (out.cloud && out.cloud.line) console.log(out.cloud.line);
    return;
  }
  if (command === 'engines') {
    for (const e of out.engines) console.log(`${e.available ? 'ready' : '-    '}  ${e.id.padEnd(14)} ${e.name} (${e.kind})${e.reason ? `: ${e.reason}` : ''}`);
    console.log(`default for members with none of their own: ${out.engine_in_effect}`);
    return;
  }
  if (command === 'settings') {
    console.log(`default model: ${out.engine_in_effect}${out.default_engine ? '' : ' (picked for you: Codex on this computer when it is signed in, else Atris 2 Fast)'}${out.engine_available ? '' : `, cannot run here: ${out.engine_reason}`}`);
    const standing = out.standing_yes;
    if (standing) {
      const today = standing.count_readable ? `${standing.started_today} of ${standing.per_day} started today` : 'today\'s count cannot be read, so nothing starts';
      console.log(standing.on ? `standing yes: on, ${today}` : `standing yes: off (turn on with: atris feed settings set standing-yes on)`);
    }
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
  if (command === 'dismiss') {
    const done = out.restored || out.dismissed || [];
    console.log(`${out.restored ? 'brought back' : 'dismissed'} ${done.length}.`);
    for (const skip of out.skipped) console.log(`not done: ${skip.id}: ${skip.reason}`);
    return;
  }
  if (command === 'more') {
    console.log(out.reason);
    return;
  }
  if (command === 'scrub-keys') {
    const f = out.found;
    const where = `${f.comments} comment, ${f.posts} post, ${f.events} event and ${f.member_logs} member log entries`;
    console.log(out.total === 0 ? 'no saved password or key found.' : out.dry_run ? `found ${where} holding a password or key. run without --dry-run to replace them.` : `replaced ${out.replaced}: ${where}.`);
    return;
  }
  if (out.card) {
    console.log(textCard(out.card));
    // Why a setup answer was not kept, in the words the desktop shows under the card.
    const note = (out.setup && out.setup.lesson_error) || out.setup_error;
    if (command === 'reply' && note) console.log(note);
    if (command === 'reply' && Array.isArray(out.tagged) && out.tagged.length) console.log(`asked ${out.tagged.join(' and ')} to answer.`);
    if (command === 'reply' && out.tag_note) console.log(out.tag_note);
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
    if (sub === 'setup') {
      // Set the project up while the feed watches: team, a read, then questions.
      // --stream --json: one JSON line per step as it happens, then the summary.
      const setupLib = require('../lib/feed-setup');
      if (positional[1] === 'skip') {
        const skipped = setupLib.skip(feed.projectRoot(context.cwd || process.cwd()), positional[2] || flags.card || null, { env, deps });
        if (json) console.log(JSON.stringify(skipped, null, 2));
        else console.log(`skipped.${skipped.next ? ` next question: ${skipped.next.text}` : ' no more questions.'}`);
        return 0;
      }
      if (positional[1]) throw new feed.FeedError(400, `unknown setup command: ${positional[1]}`);
      const onStep = !flags.stream ? null : json
        ? (event) => write(`${JSON.stringify(event)}\n`)
        : (event) => write(`${event.text}\n`);
      let out;
      try {
        out = await setupLib.setup(context.cwd || process.cwd(), { env, deps, engine: flags.engine, onStep });
      } catch (error) {
        const known = feed.asFeedError(error);
        if (flags.stream && json && known) {
          write(`${JSON.stringify({ type: 'error', ok: false, error: known.toJSON() })}\n`);
          return 1;
        }
        throw error;
      }
      if (flags.stream && json) write(`${JSON.stringify({ type: 'done', ...out })}\n`);
      else if (json) console.log(JSON.stringify(out, null, 2));
      else printText('setup', out, { streamed: Boolean(flags.stream) });
      return 0;
    }
    if (sub === 'start') {
      const out = await team().start(positional[1] || context.cwd || process.cwd(), { env, deps, engine: flags.engine, goal: flags.goal });
      if (json) console.log(JSON.stringify(out, null, 2));
      else printText('start', out);
      return 0;
    }
    const root = feed.projectRoot(context.cwd || process.cwd());
    let out;
    if (sub === 'cards') {
      out = feed.listCards(root, { filter: flags.filter || 'all', limit: flags.limit, cursor: flags.cursor, since: flags.since, env });
    } else if (sub === 'waiting') {
      const action = positional[1];
      if ((action === 'set' || action === 'clear') && env.ATRIS_AGENT_PROOF_ONLY === '1') {
        out = { version: feed.FEED_VERSION, skipped: true, reason: 'background_member_run' };
      } else if (action === 'set') out = feed.setWaiting(root, { session: flags.session, ask: flags.ask, title: flags.title, engine: flags.engine });
      else if (action === 'clear') out = feed.clearWaiting(root, flags.session);
      else if (action === 'list') out = feed.listWaiting(root);
      else throw new feed.FeedError(400, 'usage: atris feed waiting set|clear|list');
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
      // A teammate backing an idea can make it able to start by the standing yes.
      if (out.merged) standingYes().standingYesQuietly(root, { env, deps });
    } else if (sub === 'decide') {
      const [, card, choice] = positional;
      if (!card || !choice) throw new feed.FeedError(400, 'usage: atris feed decide <card> approve|dismiss [--note "<text>"]');
      // A campaign question answered here also reaches the campaign's cloud copy when it has one.
      const campaigns = require('../lib/campaign-feed');
      out = campaigns.isCardId(card) && choice === 'approve' && flags.note
        ? await campaigns.answerAskSynced(root, card, flags.note, { env, deps })
        : feed.decide(root, card, choice, { note: flags.note, env, deps });
    } else if (sub === 'pass') {
      // --cards '[{"id": "...", "seen": false}]' lets the screen say which cards were never on screen.
      let items = positional.slice(1);
      if (flags.cards) {
        try { items = items.concat(JSON.parse(flags.cards)); } catch { throw new feed.FeedError(400, 'cards must be JSON, like [{"id": "task:...", "seen": false}]'); }
      }
      out = feed.passCards(root, items, { env });
    } else if (sub === 'dismiss') {
      out = feed.dismissCards(root, positional.slice(1), { env, deps, undo: flags.undo === true });
    } else if (sub === 'unqueue') {
      out = feed.unqueueCard(root, positional[1], { env });
    } else if (sub === 'move') {
      const to = flags.first ? 'first' : flags.last ? 'last' : flags.to;
      out = feed.moveCard(root, positional[1], { to, env });
    } else if (sub === 'talk') {
      const card = positional[1];
      if (!card) throw new feed.FeedError(400, flags.member !== undefined ? 'usage: atris feed talk --member <name> -- <card> ["<words>"]' : 'usage: atris feed talk <card> "<message>"');
      // --stream --json: one JSON event per line (saved, chunk, reply, revision, done).
      // --stream alone: the answer's words as they come. --json alone: the final answer.
      const onEvent = !flags.stream ? null : json
        ? (event) => write(`${JSON.stringify(event)}\n`)
        : (event) => { if (event.type === 'chunk') write(event.text); else if (event.type === 'done') write('\n'); };
      try {
        if (flags.member !== undefined) {
          // Any awake member answers on any card; the answer is saved as its comment.
          if (flags.as || flags.choose) throw new feed.FeedError(400, '--member cannot be used with --as or --choose.');
          command = 'ask';
          out = await team().askMember(root, { member: flags.member, cardId: card, text: flags.text || positional.slice(2).join(' '), independent: flags.independent === true, engine: flags.engine, env, deps, onEvent });
        } else {
          out = await feed.talk(root, card, positional.slice(2).join(' '), { as: flags.as, choose: flags.choose, env, deps, onEvent });
        }
      } catch (error) {
        const known = feed.asFeedError(error);
        if (flags.stream && json && known) {
          write(`${JSON.stringify({ type: 'error', ok: false, error: known.toJSON() })}\n`);
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
        if (!positional[2] || positional[3] === undefined) throw new feed.FeedError(400, 'usage: atris feed settings set default-engine <id> | member-engine <member> <id|none> | local-pings-per-day <n> | cloud-pings-per-day <n> | member-gap-seconds <n> | standing-yes on|off | standing-yes-per-day <n>');
        if (positional[2] === 'default-engine') out = team().setDefaultEngine(root, positional[3], { env });
        else if (positional[2] === 'member-engine') out = team().setMemberEngine(root, positional[3], positional[4], { env });
        else if (['standing-yes', 'standing-yes-per-day'].includes(positional[2])) out = standingYes().setStandingYes(root, positional[2], positional[3], { env });
        else out = team().setLimit(root, positional[2], positional[3], { env });
      } else if (positional[1]) {
        throw new feed.FeedError(400, `unknown settings command: ${positional[1]}`);
      } else {
        out = team().settingsView(root, { env });
      }
    } else if (sub === 'engines') {
      out = { version: feed.FEED_VERSION, engines: team().listEngines({ env }), ...team().settingsView(root, { env }) };
    } else if (sub === 'members') {
      // One on/off per member, marked when the cloud note-wake switch disagrees.
      const sync = require('../lib/wake-sync');
      out = sync.markMembers(team().listMembers(root, { env }), await sync.cloudSwitches(root, deps));
    } else if (sub === 'member') {
      const [, onOff, name] = positional;
      if (!['on', 'off'].includes(onOff) || !name) throw new feed.FeedError(400, 'usage: atris feed member on|off <name>');
      out = team().setOn(root, name, onOff === 'on', { env });
      // The same switch in the cloud, best effort: the local one already flipped.
      out.cloud = await require('../lib/wake-sync').setCloudWake(root, String(name).trim(), onOff === 'on', deps);
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
    } else if (sub === 'clear') {
      out = room().clear(root, { env, confirmed: flags.confirm === true });
    } else if (sub === 'scrub-keys') {
      out = require('../lib/feed-scrub').scrubKeys(root, { dryRun: flags['dry-run'] === true });
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
    } else if (sub === 'replies') {
      if (!positional[1]) throw new feed.FeedError(400, 'usage: atris feed replies <card> [--limit N]');
      out = room().replies(root, positional[1], { limit: flags.limit, env });
    } else if (sub === 'discuss') {
      const host = require('../lib/feed-host');
      if (flags.run) {
        // Internal: the background half that discuss starts.
        if (!positional[1] || !positional[2]) throw new feed.FeedError(400, 'usage: atris feed discuss --run <card> <round>');
        if (flags.tagged) await host.runTagged(root, positional[1], positional[2], { env, deps });
        else await host.runRound(root, positional[1], positional[2], { env, deps });
        return 0;
      }
      if (!positional[1]) throw new feed.FeedError(400, 'usage: atris feed discuss <card> [--retry]');
      const onEvent = flags.stream ? (event) => write(`${JSON.stringify(event)}\n`) : null;
      out = await host.discuss(root, positional[1], { retry: flags.retry === true, inline: Boolean(flags.stream), env, deps, onEvent: onEvent || undefined });
      if (flags.stream) {
        write(`${JSON.stringify({ type: 'end', ...out })}\n`);
        return 0;
      }
    } else if (sub === 'work') {
      if (!positional[1] || !flags.reply) throw new feed.FeedError(400, 'usage: atris feed work <card> --reply <comment id> [--retry]');
      out = require('../lib/feed-work').startWork(root, positional[1], { replyId: flags.reply, retry: flags.retry === true, env, deps });
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
    } else if (sub === 'turns') {
      // The caller makes the model call; this computer keeps the files (lib/feed-turns.js). Always JSON.
      const result = require('../lib/feed-turns').command(root, positional.slice(1), flags);
      console.log(JSON.stringify(result.out));
      return result.code;
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
  } catch (caught) {
    // A busy task store answers with error.busy true, so a caller can retry
    // instead of reading the silence as a tool too old to have the command.
    const error = feed.asFeedError(caught);
    if (!error) throw caught;
    if (json) console.log(JSON.stringify({ version: feed.FEED_VERSION, ok: false, error: error.toJSON() }, null, 2));
    else console.error(`error: ${error.message}`);
    return error.status === 400 && command === 'unknown' ? 2 : 1;
  }
}

const DECISION_SUBCOMMANDS = new Set(['cards', 'theme', 'propose', 'decide', 'pass', 'dismiss', 'unqueue', 'move', 'talk', 'messages', 'revise', 'more', 'run', 'help',
  'waiting',
  'settings', 'engines', 'members', 'member', 'ping', 'think', 'emit', 'events', 'start', 'doctor', 'repair', 'notes',
  'say', 'react', 'reply', 'replies', 'discuss', 'work', 'clear', 'setup', 'scrub-keys', 'turns']);

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
function firstPositional(args = []) {
  for (let i = 0; i < args.length; i += 1) {
    const token = String(args[i]);
    if (token === '--') return args[i + 1] !== undefined ? String(args[i + 1]) : undefined;
    if (token.startsWith('--')) {
      const eq = token.indexOf('=');
      const name = eq > 0 ? token.slice(0, eq) : token;
      if (VALUE_FLAGS.has(name) && eq < 0) i += 1;
      continue;
    }
    if (token.startsWith('-')) continue;
    return token;
  }
  return undefined;
}

function route(args = [], { isTTY = false } = {}) {
  const first = firstPositional(args);
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

module.exports = { LEGACY_BARE_NOTICE, handles, route, run, runFromCli, textCard };
