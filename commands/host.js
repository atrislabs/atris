'use strict';

const { hostAction } = require('../lib/host');
const { apiRequestJson } = require('../utils/api');
const { loadCredentials, decodeJwtClaims } = require('../utils/auth');

function parse(argv) {
  const options = {};
  const positionals = [];
  const flags = new Set(['id', 'name', 'team', 'manager', 'door', 'now', 'started', 'question', 'event-id', 'from', 'text', 'reply-to', 'reply-to-ref', 'ref', 'decision', 'patch', 'expected-revision', 'source', 'evidence', 'reason', 'activity', 'as', 'when', 'at', 'room', 'slack-business', 'limit']);
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (item === '--json') { options.json = true; continue; }
    if (item === '--dry-run') { options.dryRun = true; continue; }
    if (item.startsWith('--')) {
      const key = item.slice(2);
      if (!flags.has(key) || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`invalid --${key} value`);
      options[key.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = argv[++i];
    } else positionals.push(item);
  }
  return { options, positionals };
}

async function hostDeliver(root, options = {}, deps = {}) {
  const { room, slack_business_id: businessId, messages } = hostAction(root, 'delivery');
  if (!businessId) throw new Error('slack business id is missing; run atris host setup --slack-business <business id>');
  if (room === 'personal') throw new Error('host delivery is for group rooms only');
  if (options.limit != null && !/^(0|[1-9]\d*)$/.test(options.limit)) throw new Error('limit must be a non-negative integer');
  const eligible = messages.filter((message) => /^slack:[UW][A-Z0-9]+$/.test(message.door || '') && message.draft !== true);
  const selected = eligible.slice(0, options.limit == null ? undefined : Number(options.limit));
  const result = { sent: 0, skipped: messages.length - eligible.length, failed: 0 };
  if (options.dryRun) {
    result.would_send = selected.map((message) => ({ id: message.id, to: message.door.slice(6), kind: message.kind, text: String(message.text).replace(/\s+/g, ' ').slice(0, 80) }));
    return result;
  }
  if (!selected.length) return result;
  const credentials = (deps.loadCredentials || loadCredentials)();
  if (!credentials?.token || credentials.source === 'agent_token_file' || decodeJwtClaims(credentials.token)?.type === 'agent_access') {
    throw new Error('log in as an Atris user with atris login before delivering');
  }
  const request = deps.apiRequestJson || apiRequestJson;
  for (const message of selected) {
    try {
      const response = await request(`/business/${encodeURIComponent(businessId)}/host/slack/send`, {
        method: 'POST', token: credentials.token, retries: 0,
        body: { slack_user_id: message.door.slice(6), text: message.text, host_message_id: message.id },
      });
      if (!response.ok) throw new Error(`${response.status ? `http ${response.status}` : 'network error'}: ${response.error || 'request failed'}`);
      if (typeof response.data?.ts !== 'string' || !response.data.ts.trim()) throw new Error('response is missing a Slack timestamp');
      hostAction(root, 'sent', { id: message.id, ref: response.data.ts });
      result.sent += 1;
    } catch (error) {
      result.failed = 1;
      result.failure = { id: message.id, reason: error.message };
      break;
    }
  }
  return result;
}

function human(command, result) {
  if (command === 'deliver') return result.would_send
    ? [...result.would_send.map((message) => `${message.to} ${message.kind}: ${message.text}`), `dry run: ${result.would_send.length} would send, ${result.skipped} skipped`].join('\n')
    : `host delivery: ${result.sent} sent, ${result.skipped} skipped, ${result.failure ? `failed ${result.failure.id}: ${result.failure.reason}` : '0 failed'}`;
  if (command === 'room') return result.text;
  if (command === 'import') return `import complete: ${result.added} added, ${result.skipped} skipped, ${result.refused} refused, ${result.links_added} links added, ${result.links_skipped} links skipped`;
  if (command === 'due') return result.length ? result.map((entry) => `${entry.name} (${entry.id}) is due for a question.`).join('\n') : 'no questions due';
  if (command === 'outbox') return result.length ? result.map((entry) => `${entry.id} ${entry.kind} to ${entry.to}: ${entry.text}`).join('\n') : 'outbox empty';
  if (command === 'schedule') return result.length ? result.map((entry) => `${entry.attempt_id}: ${entry.names.a} (${entry.a}) and ${entry.names.b} (${entry.b}), ${entry.activity}`).join('\n') : 'no introductions need scheduling';
  if (command === 'people') {
    if (!result.length) return 'no active people';
    return result.map((entry) => {
      const fields = ['into_lately', 'going_for', 'great_at', 'wants_to_meet', 'worth_celebrating']
        .map((key) => `  ${key.replaceAll('_', ' ')}: ${entry[key]}`).join('\n');
      return `${entry.name} (${entry.id})\n  team: ${entry.team || 'none'}\n  manager: ${entry.manager_id || 'none'}\n  status: ${entry.status}\n  can be introduced: ${entry.can_be_introduced ? 'yes' : 'no'}\n${fields}`;
    }).join('\n');
  }
  if (command === 'view') return [...result.cards.map((entry) => entry.card), result.own ? `Your private record:\n${JSON.stringify(result.own, null, 2)}` : ''].filter(Boolean).join('\n');
  if (command === 'receive') return result.duplicate ? 'event already recorded' : `${result.kind} recorded for ${result.id}`;
  return `${command} complete: ${JSON.stringify(result)}`;
}

function hostCommand(argv = process.argv.slice(3), root = process.cwd(), deps = {}) {
  let jsonOutput = argv.includes('--json');
  try {
    const [command, ...rest] = argv;
    if (!command || command === '--help' || command === '-h') {
      const usage = 'usage: atris host setup|join|import|leave|pause|resume|forget|due|ask|receive|card|link|propose|people|outbox|deliver|sent|room|view|schedule|scheduled [options]';
      console.log(jsonOutput ? JSON.stringify({ usage }) : usage);
      return;
    }
    const { options, positionals } = parse(rest);
    jsonOutput = options.json;
    const args = { ...options };
    if (command === 'import') args.file = positionals[0];
    if (['leave', 'pause', 'resume', 'forget', 'ask', 'card', 'sent', 'scheduled'].includes(command)) args.id = positionals[0];
    if (['link', 'propose'].includes(command)) { args.a = positionals[0]; args.b = positionals[1]; }
    if (command === 'receive') args.eventId = options.eventId;
    if (command === 'deliver') return hostDeliver(root, args, deps).then((result) => {
      console.log(jsonOutput ? JSON.stringify(result) : human(command, result));
      if (result.failed) process.exitCode = 1;
    }).catch((error) => {
      console.error(jsonOutput ? JSON.stringify({ error: error.message }) : `host: ${error.message}`);
      process.exitCode = 1;
    });
    const result = hostAction(root, command, args);
    console.log(jsonOutput ? JSON.stringify(result) : human(command, result));
  } catch (error) {
    console.error(jsonOutput ? JSON.stringify({ error: error.message }) : `host: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { hostCommand, hostDeliver, parse };
