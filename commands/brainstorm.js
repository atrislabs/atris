'use strict';

const fs = require('fs');
const path = require('path');
const { getLogPath, ensureLogDirectory, createLogFile } = require('../lib/journal');
const { addInboxIdea } = require('../lib/file-ops');
const { wantsJson } = require('../lib/noninteractive');
const { compactErrorPayload, compactSuccessPayload, printCliJson } = require('../lib/cli-json');

function printHelp() {
  console.log('');
  console.log('Usage: atris brainstorm "<idea>" [--json]');
  console.log('');
  console.log('Description:');
  console.log('  Capture an idea to today\'s inbox and exit.');
  console.log('  Never waits on a prompt. Headless.');
  console.log('');
  console.log('Options:');
  console.log('  --json       Print a JSON receipt.');
  console.log('  --cloud      Accepted. Capture stays local.');
  console.log('  --no-cloud   Force local-only mode.');
  console.log('  --yes        Accepted. Always non-interactive.');
  console.log('');
}

function topicFromArgs(args) {
  return args.filter((arg) => !String(arg).startsWith('-')).join(' ').trim() || null;
}

function journalRel(logFile) {
  return path.relative(process.cwd(), logFile) || logFile;
}

function printCaptured(id, text, rel, args) {
  const inboxId = `I${id}`;
  if (wantsJson(args)) {
    const payload = compactSuccessPayload({
      action: 'captured',
      ids: {
        id,
        inbox_id: inboxId,
        text,
        journal: rel,
      },
      next_command: 'atris plan',
    });
    printCliJson(payload, payload, args);
    return;
  }
  console.log(`captured ${inboxId}: ${text}`);
  console.log(`journal: ${rel}`);
  console.log('Next: atris plan');
}

function printIdeaRequired(rel, args) {
  if (wantsJson(args)) {
    const payload = compactErrorPayload({
      reason: 'idea_required',
      detail: 'brainstorm needs an idea on the command line',
      next_command: 'atris brainstorm "<idea>"',
    });
    printCliJson(payload, payload, args);
    return;
  }
  console.log('brainstorm captures an idea on the command line and exits.');
  console.log(`journal: ${rel}`);
  console.log('Next: atris brainstorm "<idea>"');
}

async function brainstormAtris() {
  const args = process.argv.slice(3);
  if (args.includes('--help') || args.includes('-h') || args[0] === 'help') {
    printHelp();
    return;
  }

  const targetDir = path.join(process.cwd(), 'atris');
  if (!fs.existsSync(targetDir)) {
    throw new Error('atris/ folder not found. Run "atris init" first.');
  }

  ensureLogDirectory();
  const { logFile, dateFormatted } = getLogPath();
  if (!fs.existsSync(logFile)) {
    createLogFile(logFile, dateFormatted);
  }

  const idea = topicFromArgs(args);
  const rel = journalRel(logFile);

  // Named explore path: capture and exit. A TTY must not open a wizard.
  // Scar 2026-08-24: wrote I1, then hung on "Describe the desired outcome".
  if (idea) {
    const newId = addInboxIdea(logFile, idea);
    printCaptured(newId, idea, rel, args);
    return;
  }

  printIdeaRequired(rel, args);
}

module.exports = {
  brainstormAtris,
};
