#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TODO_PATH="$ROOT/atris/TODO.md"

if [ ! -f "$TODO_PATH" ]; then
  echo "missing atris/TODO.md" >&2
  exit 1
fi

node - "$TODO_PATH" <<'NODE'
const fs = require('fs');

const todoPath = process.argv[2];
const content = fs.readFileSync(todoPath, 'utf8');

const slugMatch = content.match(/## Endgame[\s\S]*?\*\*Slug:\*\*\s*([a-z0-9-]+)/i);
if (!slugMatch) {
  console.error('missing active endgame slug');
  process.exit(1);
}

const backlogMatch = content.match(/## Backlog\n([\s\S]*?)(?=\n##\s|$)/);
if (!backlogMatch) {
  console.error('missing backlog section');
  process.exit(1);
}

const lines = backlogMatch[1].split('\n');
const tasks = [];
let current = null;

for (const line of lines) {
  const taskMatch = line.match(/^- \*\*([A-Z]\d+[a-z]?):\*\* (.+?) \[endgame\]\s*$/);
  if (taskMatch) {
    current = {
      id: taskMatch[1],
      title: taskMatch[2].trim(),
      verify: ''
    };
    tasks.push(current);
    continue;
  }

  if (!current) continue;
  const verifyMatch = line.match(/^\s+\*\*Verify:\*\*\s+`(.+)`\s*$/);
  if (verifyMatch) {
    current.verify = verifyMatch[1].trim();
    current = null;
  }
}

if (tasks.length === 0) {
  console.error('no queued [endgame] tasks found in backlog');
  process.exit(1);
}

const next = tasks[0];
process.stdout.write(`${JSON.stringify({
  slug: slugMatch[1],
  id: next.id,
  title: next.title,
  verify: next.verify
}, null, 2)}\n`);
NODE
