':' //; exec node "$0" "$@"
'use strict';

// Lesson policy-proof-verify-command: proofs naming a runnable verify command
// were accepted 99/99 at the human gate; evidence-less proofs stall. Teach the
// tick receipt to demand one.

const fs = require('node:fs');
const path = require('node:path');

const target = path.join(process.cwd(), 'commands', 'mission.js');
const anchor = '(1) the exact files edited / commands run / artifacts produced — name them, (2) the metric of progress';
const replacement = '(1) the exact files edited / commands run / artifacts produced — name them, (1b) one verify command a reviewer can rerun to check the work, (2) the metric of progress';

const source = fs.readFileSync(target, 'utf8');
const count = source.split(anchor).length - 1;
if (count !== 1) {
  console.error(`anchor not found exactly once in ${target}: ${count}`);
  process.exit(1);
}

fs.writeFileSync(target, source.replace(anchor, replacement), 'utf8');
