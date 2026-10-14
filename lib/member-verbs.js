'use strict';

// The three plain member verbs: run, wake, sleep. This file only decides
// which older command a verb means; the handlers that do the work are passed
// in, so tests can check the routing without starting anything.
//
//   atris member run "<job>"          picks the member and runs the job
//   atris member run <name> "<job>"   runs that member, as before
//   atris member wake 5               keeps up to 5 members working
//   atris member wake a b             keeps just a and b working
//   atris member wake a               one wake for a, as before (--keep keeps it working)

const fs = require('fs');
const path = require('path');

const SLUG = /^[a-z0-9][a-z0-9._-]*$/i;
const IGNITE_FLAGS = ['--ignite', '--wait', '--sync'];

const WAKE_USAGE = [
  'wake members three ways:',
  '  atris member wake 5                    keep up to 5 members working',
  '  atris member wake navigator executor   keep just these members working',
  '  atris member wake navigator            one work step now (add --keep to keep it working)',
];

// A member is a folder in atris/team with a MEMBER.md (or an older flat
// <name>.md card).
function isTeamMember(root, name) {
  const clean = String(name == null ? '' : name).trim();
  if (!SLUG.test(clean)) return false;
  const team = path.join(root, 'atris', 'team');
  return fs.existsSync(path.join(team, clean, 'MEMBER.md')) || fs.existsSync(path.join(team, `${clean}.md`));
}

// The words before the first flag.
function leadingWords(args) {
  const words = [];
  for (const arg of args) {
    const text = String(arg == null ? '' : arg);
    if (text.startsWith('-')) break;
    words.push(text);
  }
  return words;
}

// handlers: { root, run(name, ...args), dispatch(...args) }
function memberRunVerb(args, handlers) {
  const first = args[0];
  if (first == null || String(first).startsWith('-') || isTeamMember(handlers.root, first)
    || (handlers.aliasOf && isTeamMember(handlers.root, handlers.aliasOf(first)))) {
    return handlers.run(first, ...args.slice(1));
  }
  const ignite = args.some((arg) => IGNITE_FLAGS.includes(arg));
  return handlers.dispatch(...args, ...(ignite ? [] : ['--ignite']));
}

// handlers: { wake(name, ...args), up(...args), print(line) }
async function memberWakeVerb(args, handlers) {
  const print = handlers.print || ((line) => console.log(line));
  if (!args.length) {
    for (const line of WAKE_USAGE) print(line);
    return { ok: true, usage: true };
  }
  const words = leadingWords(args);
  const flags = args.slice(words.length);
  const keep = flags.includes('--keep');
  const rest = flags.filter((flag) => flag !== '--keep');
  if (words.length === 1 && /^[1-9]\d*$/.test(words[0])) {
    return handlers.up('--max', words[0], ...rest);
  }
  if (words.length >= 2 || (words.length === 1 && keep)) {
    return handlers.up('--only', words.join(','), ...rest);
  }
  const result = await handlers.wake(args[0], ...args.slice(1));
  if (words.length === 1 && !args.includes('--json')) {
    print(`to keep ${words[0]} working: atris member wake ${words[0]} --keep`);
  }
  return result;
}

module.exports = {
  memberRunVerb,
  memberWakeVerb,
};
