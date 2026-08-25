'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function playbookFile(root = process.cwd()) {
  return path.join(root, '.atris', 'state', 'playbook.json');
}

function readPlaybook(root = process.cwd()) {
  try {
    const value = JSON.parse(fs.readFileSync(playbookFile(root), 'utf8'));
    return { version: 1, rules: Array.isArray(value.rules) ? value.rules : [] };
  } catch (err) {
    if (err.code === 'ENOENT') return { version: 1, rules: [] };
    throw err;
  }
}

function writePlaybook(playbook, root = process.cwd()) {
  const file = playbookFile(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(playbook, null, 2)}\n`);
}

function optionValue(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return null;
  if (!args[index + 1] || args[index + 1].startsWith('--')) {
    throw new Error(`${name} needs a value`);
  }
  return args[index + 1];
}

function printHelp(output) {
  output('usage: atris playbook [show] [--family <family>] [--json]');
  output('       atris playbook add <family> <rule> [--source <source>]');
  output('       atris playbook inject [--family <family>]');
  output('       atris playbook remove <id>');
  output('       atris playbook verify <id> --with <score> --without <score> [--method <method>]');
}

function filteredRules(playbook, family) {
  return family ? playbook.rules.filter((entry) => entry.family === family) : playbook.rules;
}

function playbookCommand(args = [], options = {}) {
  const root = options.root || process.cwd();
  const output = options.output || console.log;
  const now = options.now || (() => new Date().toISOString());
  const makeId = options.makeId || (() => crypto.randomUUID().slice(0, 8));
  const subcommand = args[0] && !args[0].startsWith('--') ? args[0] : 'show';
  const rest = subcommand === 'show' && args[0] !== 'show' ? args : args.slice(1);

  if (args.includes('--help') || args.includes('-h') || subcommand === 'help') {
    printHelp(output);
    return 0;
  }

  const playbook = readPlaybook(root);
  if (subcommand === 'show') {
    const family = optionValue(rest, '--family');
    const rules = filteredRules(playbook, family);
    if (rest.includes('--json')) {
      output(JSON.stringify({ version: 1, rules }, null, 2));
      return 0;
    }
    if (rules.length === 0) {
      output('no style rules saved');
      return 0;
    }
    const families = [...new Set(rules.map((entry) => entry.family))];
    for (const name of families) {
      output(`${name}:`);
      for (const entry of rules.filter((rule) => rule.family === name)) {
        const state = entry.quarantined ? ' (quarantined)' : '';
        output(`- ${entry.id}: ${entry.rule}${state}`);
      }
    }
    return 0;
  }

  if (subcommand === 'add') {
    const family = rest[0];
    const rule = rest[1];
    if (!family || !rule || family.startsWith('--') || rule.startsWith('--')) {
      throw new Error('add needs a family and rule');
    }
    const duplicate = playbook.rules.find((entry) => entry.family === family && entry.rule === rule);
    if (duplicate) {
      output(`rule already exists: ${duplicate.id}`);
      return 0;
    }
    const entry = {
      id: makeId(),
      family,
      rule,
      source: optionValue(rest, '--source') || '',
      verified: null,
      created_at: now(),
    };
    playbook.rules.push(entry);
    writePlaybook(playbook, root);
    output(`rule added: ${entry.id}`);
    return 0;
  }

  if (subcommand === 'inject') {
    const family = optionValue(rest, '--family');
    const rules = filteredRules(playbook, family).filter((entry) => !entry.quarantined);
    if (rules.length === 0) return 0;
    output('Workspace style rules (follow every rule that applies):');
    for (const entry of rules) output(`- ${entry.rule}`);
    return 0;
  }

  if (subcommand === 'remove') {
    const id = rest[0];
    if (!id) throw new Error('remove needs a rule id');
    const index = playbook.rules.findIndex((entry) => entry.id === id);
    if (index === -1) throw new Error(`rule not found: ${id}`);
    playbook.rules.splice(index, 1);
    writePlaybook(playbook, root);
    output(`rule removed: ${id}`);
    return 0;
  }

  if (subcommand === 'verify') {
    const id = rest[0];
    const rawScoreWith = optionValue(rest, '--with');
    const rawScoreWithout = optionValue(rest, '--without');
    const scoreWith = Number(rawScoreWith);
    const scoreWithout = Number(rawScoreWithout);
    if (!id) throw new Error('verify needs a rule id');
    if (rawScoreWith === null || rawScoreWithout === null ||
        !Number.isFinite(scoreWith) || !Number.isFinite(scoreWithout)) {
      throw new Error('verify needs numeric --with and --without scores');
    }
    const entry = playbook.rules.find((rule) => rule.id === id);
    if (!entry) throw new Error(`rule not found: ${id}`);
    entry.verified = {
      method: optionValue(rest, '--method') || 'replay',
      score_with: scoreWith,
      score_without: scoreWithout,
      at: now(),
    };
    if (scoreWith < scoreWithout) entry.quarantined = true;
    else delete entry.quarantined;
    writePlaybook(playbook, root);
    output(entry.quarantined ? `rule quarantined: ${id}` : `rule verified: ${id}`);
    return 0;
  }

  throw new Error(`unknown playbook command: ${subcommand}`);
}

module.exports = { playbookCommand, playbookFile, readPlaybook };
