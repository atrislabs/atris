':' //; exec node "$0" "$@"
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const target = path.join(process.cwd(), 'commands', 'autopilot.js');
const anchor = "- Stay in scope. Don't touch files outside the task boundary.\n${SHARED_CHECKOUT_GIT_CONTRACT}\n\nRead these files first:\n";
const replacement = "- Stay in scope. Don't touch files outside the task boundary.\n${SHARED_CHECKOUT_GIT_CONTRACT}\n\nBefore reading the file list, state the business stake this task protects or unlocks in one sentence.\n\nRead these files first:\n";

const source = fs.readFileSync(target, 'utf8');
const count = source.split(anchor).length - 1;
if (count !== 1) {
  console.error(`anchor not found exactly once in ${target}: ${count}`);
  process.exit(1);
}

fs.writeFileSync(target, source.replace(anchor, replacement), 'utf8');
