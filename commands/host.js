'use strict';

const { hostAction } = require('../lib/host');

function parse(argv) {
  const options = {};
  const positionals = [];
  const flags = new Set(['id', 'name', 'team', 'manager', 'door', 'now', 'question', 'event-id', 'from', 'text', 'reply-to', 'reply-to-ref', 'ref', 'decision', 'patch', 'expected-revision', 'source', 'evidence', 'reason', 'activity', 'as', 'when']);
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (item === '--json') { options.json = true; continue; }
    if (item.startsWith('--')) {
      const key = item.slice(2);
      if (!flags.has(key) || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`invalid --${key} value`);
      options[key.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = argv[++i];
    } else positionals.push(item);
  }
  return { options, positionals };
}

function human(command, result) {
  if (command === 'room') return result.text;
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

function hostCommand(argv = process.argv.slice(3), root = process.cwd()) {
  let jsonOutput = argv.includes('--json');
  try {
    const [command, ...rest] = argv;
    if (!command || command === '--help' || command === '-h') {
      const usage = 'usage: atris host join|leave|pause|resume|forget|due|ask|receive|card|link|propose|people|outbox|sent|room|view|schedule|scheduled [options]';
      console.log(jsonOutput ? JSON.stringify({ usage }) : usage);
      return;
    }
    const { options, positionals } = parse(rest);
    jsonOutput = options.json;
    const args = { ...options };
    if (['leave', 'pause', 'resume', 'forget', 'ask', 'card', 'sent', 'scheduled'].includes(command)) args.id = positionals[0];
    if (['link', 'propose'].includes(command)) { args.a = positionals[0]; args.b = positionals[1]; }
    if (command === 'receive') args.eventId = options.eventId;
    const result = hostAction(root, command, args);
    console.log(jsonOutput ? JSON.stringify(result) : human(command, result));
  } catch (error) {
    console.error(jsonOutput ? JSON.stringify({ error: error.message }) : `host: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { hostCommand };
