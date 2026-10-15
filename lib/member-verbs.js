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
const { isDurationPhrase, parseDurationWindow } = require('./member-up');

const SLUG = /^[a-z0-9][a-z0-9._-]*$/i;
const IGNITE_FLAGS = ['--ignite', '--wait', '--sync'];
const VALUE_FLAGS = new Set([
  '--max',
  '--only',
  '--for',
  '--duration',
  '--hours',
  '--minutes',
  '--engine',
  '--model',
  '--timeout-ms',
]);
const DURATION_FLAGS = new Set(['--for', '--duration', '--hours', '--minutes']);

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

// Separates positional words from flags, keeping value-taking flags paired with
// their following argument.
function splitWakeArgs(args) {
  const words = [];
  const flags = [];
  for (let i = 0; i < args.length; i += 1) {
    const text = String(args[i] == null ? '' : args[i]);
    if (text.startsWith('-')) {
      flags.push(text);
      if (VALUE_FLAGS.has(text) && i + 1 < args.length) {
        flags.push(String(args[i + 1] == null ? '' : args[i + 1]));
        i += 1;
      }
    } else {
      words.push(text);
    }
  }
  return { words, flags };
}

function hasDurationFlag(flags) {
  return flags.some((flag) => {
    const text = String(flag || '');
    if (DURATION_FLAGS.has(text)) return true;
    const eq = text.indexOf('=');
    return eq > 0 && DURATION_FLAGS.has(text.slice(0, eq));
  });
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

// handlers: { root, matchMember(text, opts), wake(name, ...args), up(...args), print(line) }
async function memberWakeVerb(args, handlers) {
  const print = handlers.print || ((line) => console.log(line));
  if (!args.length) {
    for (const line of WAKE_USAGE) print(line);
    return { ok: true, usage: true };
  }
  const { words, flags } = splitWakeArgs(args);
  const durationWords = [];
  const memberWords = [];
  for (const word of words) {
    if (isDurationPhrase(word)) durationWords.push(word);
    else memberWords.push(word);
  }
  const keep = flags.includes('--keep');
  const rest = flags.filter((flag) => flag !== '--keep');
  const flagsHaveDuration = hasDurationFlag(rest);
  const parsedDuration = durationWords.length > 0
    ? parseDurationWindow(durationWords.join(' '))
    : null;
  const upFlags = [
    ...rest,
    ...(parsedDuration && !flagsHaveDuration ? ['--for', parsedDuration.label] : []),
  ];
  if (memberWords.length === 1 && /^[1-9]\d*$/.test(memberWords[0])) {
    return handlers.up('--max', memberWords[0], ...upFlags);
  }
  if (memberWords.length === 0 && (durationWords.length > 0 || flagsHaveDuration)) {
    return handlers.up(...upFlags);
  }
  const seen = new Set(
    memberWords.filter((word) => handlers.root && isTeamMember(handlers.root, word))
  );
  const resolved = memberWords.map((word) => {
    if (handlers.root && isTeamMember(handlers.root, word)) {
      seen.add(word);
      return word;
    }
    if (typeof handlers.matchMember === 'function') {
      const matched = handlers.matchMember(word, { exclude: new Set(seen) });
      const slug = typeof matched === 'string'
        ? matched.trim()
        : String((matched && matched.member) || '').trim();
      const reason = matched && typeof matched === 'object'
        ? String(matched.reason || matched.role || '').trim()
        : '';
      if (slug) {
        seen.add(slug);
        if (slug !== word) {
          if (!args.includes('--json')) {
            print(`matched "${word}" to ${slug}${reason ? ` (${reason})` : ''}`);
          }
          return slug;
        }
      }
    }
    seen.add(word);
    return word;
  });
  const uniqueResolved = Array.from(new Set(resolved));
  if (
    uniqueResolved.length >= 2
    || memberWords.length >= 2
    || (uniqueResolved.length === 1 && (keep || durationWords.length > 0 || flagsHaveDuration))
  ) {
    return handlers.up('--only', uniqueResolved.join(','), ...upFlags);
  }
  const target = resolved.length === 1 ? resolved[0] : args[0];
  const result = await handlers.wake(target, ...(resolved.length === 1 ? flags : args.slice(1)));
  if (resolved.length === 1 && !args.includes('--json')) {
    print(`to keep ${target} working: atris member wake ${target} --keep`);
  }
  return result;
}

module.exports = {
  memberRunVerb,
  memberWakeVerb,
};
