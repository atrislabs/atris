'use strict';

const { addTaste, listTaste } = require('../lib/taste-lessons');

const VALID_FLAGS = new Set(['--why', '--scope', '--example']);

function usage(stdout = process.stdout) {
  stdout.write([
    'usage: atris taste keep|kill|more "<subject>" --why "<reason>" [--scope writing|design|code|any] [--example path]',
    '       atris taste list [--scope writing|design|code|any]',
    '',
  ].join('\n'));
}

function flagValue(args, flag) {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${flag} needs a value`);
  return value;
}

function rejectUnknownArgs(args, positionalCount) {
  for (let index = positionalCount; index < args.length; index += 1) {
    const value = args[index];
    if (!value.startsWith('--')) continue;
    if (!VALID_FLAGS.has(value)) throw new Error(`unknown option: ${value}`);
    index += 1;
  }
}

function renderTaste(entries, stdout = process.stdout, filtered = false) {
  if (!entries.length) {
    stdout.write(`${filtered ? 'no taste lessons match this scope.' : 'no taste lessons have been recorded yet.'}\n`);
    return;
  }

  for (const entry of entries) {
    stdout.write(`the operator's verdict is ${entry.verdict} for "${entry.subject}".\n`);
    stdout.write(`the reason is: ${entry.why}\n`);
    stdout.write(`this applies to ${entry.scope}.\n`);
    if (entry.example) stdout.write(`the example is ${entry.example}.\n`);
    stdout.write(`this was added on ${entry.added}.\n\n`);
  }
}

function tasteCommand(args = [], options = {}) {
  const stdout = options.stdout || process.stdout;
  const stderr = options.stderr || process.stderr;
  const root = options.root || process.cwd();
  const [subcommand, ...rest] = args;

  if (!subcommand) {
    renderTaste(listTaste({ root }), stdout);
    stdout.write('\n');
    usage(stdout);
    return 0;
  }
  if (subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
    usage(stdout);
    return 0;
  }

  try {
    if (subcommand === 'list') {
      rejectUnknownArgs(rest, 0);
      const scope = flagValue(rest, '--scope');
      renderTaste(listTaste({ root, scope }), stdout, !!scope);
      return 0;
    }

    if (!['keep', 'kill', 'more'].includes(subcommand)) {
      stderr.write(`unknown taste verdict: ${subcommand}.\n`);
      usage(stderr);
      return 2;
    }

    rejectUnknownArgs(rest, 1);
    const subject = rest[0];
    const why = flagValue(rest, '--why');
    const scope = flagValue(rest, '--scope') || 'any';
    const example = flagValue(rest, '--example');
    const entry = addTaste({
      verdict: subcommand,
      subject,
      why,
      scope,
      example,
      added: new Date().toISOString().slice(0, 10),
      root,
    });
    stdout.write(`saved the operator's ${entry.verdict} verdict for "${entry.subject}".\n`);
    return 0;
  } catch (error) {
    stderr.write(`taste could not continue: ${error.message}.\n`);
    usage(stderr);
    return 2;
  }
}

module.exports = { tasteCommand };
