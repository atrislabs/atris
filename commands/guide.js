'use strict';

const { INTENTS, matchIntent } = require('../lib/intents');

function printAlternatives(alternatives, limit) {
  const nearest = alternatives.slice(0, limit);
  if (!nearest.length) return;
  console.log('you might also mean:');
  nearest.forEach((intent) => console.log(`"${intent.say[0]}"`));
}

function guideCommand(args = []) {
  const json = args.includes('--json');
  const words = args.filter((arg) => arg !== '--json').join(' ').trim();

  if (!words) {
    if (json) {
      console.log(JSON.stringify({ intents: INTENTS }, null, 2));
      return 0;
    }
    INTENTS.forEach((intent) => {
      console.log(`"${intent.say[0]}"  ->  ${intent.plain}`);
    });
    return 0;
  }

  const result = matchIntent(words);
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return result.intent ? 0 : 1;
  }

  if (!result.intent) {
    console.log('not sure yet. ask one question, then try again');
    printAlternatives(result.alternatives, 3);
    return 1;
  }

  console.log(result.intent.plain);
  console.log(result.intent.do);
  printAlternatives(result.alternatives, 2);
  return 0;
}

module.exports = { guideCommand };
