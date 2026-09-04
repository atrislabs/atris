#!/bin/sh
set -eu

task_id=$(atris task list --status open --json | node -e "let input = ''; process.stdin.on('data', chunk => input += chunk); process.stdin.on('end', () => process.stdout.write(JSON.parse(input).tasks[0].id));")
atris task claim "$task_id" --as bench >/dev/null
printf '%s\n' 'atris next'
