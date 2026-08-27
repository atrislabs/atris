'use strict';

const { argsWantHelp } = require('../lib/noninteractive');
const {
  laterNotePath,
  listUserVisibleWork,
  personName,
  renderLaterRemember,
  spokenLaterNote,
  writeLaterNote,
} = require('../lib/first-minute');

function laterUsage() {
  return 'Usage: atris later "<sentence>"';
}

function laterSentence(args = []) {
  return spokenLaterNote((Array.isArray(args) ? args : [])
    .filter((arg) => !String(arg).startsWith('-'))
    .join(' '));
}

function laterAtris(args = process.argv.slice(3), {
  root = process.cwd(),
  log = console.log,
} = {}) {
  const list = Array.isArray(args) ? args : [];
  if (argsWantHelp(list)) {
    log(laterUsage());
    return 0;
  }
  const sentence = laterSentence(list);
  if (!sentence) {
    log(laterUsage());
    return 2;
  }
  writeLaterNote(root, sentence);
  const files = listUserVisibleWork(root);
  log('');
  log(renderLaterRemember({
    person: personName(),
    sentence,
    files,
    root,
  }));
  return 0;
}

module.exports = {
  laterAtris,
  laterNotePath,
  laterSentence,
  laterUsage,
};
