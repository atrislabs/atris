'use strict';

// `atris clarity` — interview the operator for how they work, write it down once.
// The interview moves one question at a time so you stay in flow. The result is
// a durable profile (.atris/clarity.json + atris/CLARITY.md) that agents read.

const readline = require('readline');
const {
  QUESTIONS,
  KEYS,
  mergeProfile,
  isEmptyProfile,
  renderClarityMd,
  readProfile,
  writeProfile,
  profilePaths,
} = require('../lib/clarity');

function parseSets(args) {
  const answers = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--set' && args[i + 1]) {
      const eq = args[i + 1].indexOf('=');
      if (eq > 0) {
        const key = args[i + 1].slice(0, eq).trim();
        const val = args[i + 1].slice(eq + 1).trim();
        if (KEYS.includes(key)) answers[key] = val;
      }
      i++;
    }
  }
  return answers;
}

function ask(rl, question) {
  return new Promise((resolve) => rl.question(question, (a) => resolve(a)));
}

async function clarityCommand(args = [], root = process.cwd()) {
  const sub = args[0];
  const stamp = new Date().toISOString();

  if (args.includes('--help') || args.includes('-h') || sub === 'help') {
    console.log('');
    console.log('Usage: atris clarity [show|--json|--set key=value|--reset]');
    console.log('');
    console.log('Interview the operator for how they work, once. Agents read the result.');
    console.log('');
    console.log('  atris clarity                 Run the interview (one question at a time)');
    console.log('  atris clarity show            Show the current profile');
    console.log('  atris clarity --json          Print the profile as JSON');
    console.log('  atris clarity --set voice=plain   Set one field without prompting');
    console.log('  atris clarity --reset         Clear the profile');
    console.log('');
    console.log(`Fields: ${KEYS.join(', ')}`);
    console.log('');
    return 0;
  }

  if (args.includes('--reset')) {
    writeProfile(root, { updated_at: stamp });
    console.log('clarity profile reset.');
    return 0;
  }

  const existing = readProfile(root);

  if (args.includes('--json')) {
    console.log(JSON.stringify(existing, null, 2));
    return 0;
  }

  if (sub === 'show') {
    console.log(renderClarityMd(existing));
    return 0;
  }

  // Non-interactive set: write fields and exit.
  const sets = parseSets(args);
  if (Object.keys(sets).length) {
    const merged = mergeProfile(existing, sets, stamp);
    const { md } = writeProfile(root, merged);
    console.log(`saved ${Object.keys(sets).join(', ')} to ${md.replace(`${root}/`, '')}`);
    return 0;
  }

  // Interactive interview. Only on a terminal, so spawns never hang.
  if (!process.stdin.isTTY) {
    console.log(renderClarityMd(existing));
    if (isEmptyProfile(existing)) {
      console.log('Run `atris clarity` in a terminal to fill this in, or use --set key=value.');
    }
    return 0;
  }

  console.log('');
  console.log('clarity interview. plain answers, one at a time. enter to keep the current value.');
  console.log('');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answers = {};
  for (const { key, q } of QUESTIONS) {
    const current = existing[key] ? ` [${existing[key]}]` : '';
    // eslint-disable-next-line no-await-in-loop
    const a = (await ask(rl, `${q}${current}\n> `)).trim();
    if (a) answers[key] = a;
    console.log('');
  }
  rl.close();

  const merged = mergeProfile(existing, answers, stamp);
  const { md } = writeProfile(root, merged);
  console.log('clarity saved. agents will read it from:');
  console.log(`  ${md.replace(`${root}/`, '')}`);
  console.log('');
  console.log(renderClarityMd(merged));
  return 0;
}

module.exports = { clarityCommand, parseSets };
