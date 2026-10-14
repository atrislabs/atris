#!/usr/bin/env node
'use strict';

// Machine readings for an engine a shell script launches, written to the
// caller's Atris workspace like every other engine run.
//   engine-reading.js start <engine> <task> <pid>        prints a token
//   engine-reading.js end <engine> <task> <token> <status>  prints the kill cause, if any
// The token is the run id and the start time, so the end can say how long it ran.
// The pid is the calling script's, which outlives this helper, so a sweep
// closes the run only once the script itself is gone.
// A shell sees a SIGKILL as exit 137 and an alarm as 142. Outside an Atris
// workspace (no atris/ folder) it writes nothing and prints nothing.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { recordEngineResource } = require('../../lib/engine-resource');

const [phase, engine, task, tokenOrPid, status] = process.argv.slice(2);
const root = process.cwd();

if (fs.existsSync(path.join(root, 'atris'))) {
  if (phase === 'start') {
    const id = crypto.randomUUID();
    recordEngineResource(root, { phase: 'start', engine, task, run_id: id }, { pid: Number(tokenOrPid) });
    process.stdout.write(`${id}@${Date.now()}`);
  } else if (phase === 'end' && tokenOrPid) {
    const [runId, startedAt] = tokenOrPid.split('@');
    const code = Number(status);
    const signal = code === 137 ? 'SIGKILL' : null;
    const timedOut = code === 142;
    const error = code && !signal && !timedOut ? `exited ${code}` : '';
    const durationMs = Math.max(0, Date.now() - Number(startedAt));
    const entry = recordEngineResource(root, { phase: 'end', engine, task, run_id: runId, signal, timed_out: timedOut, error, duration_ms: durationMs });
    if (entry && entry.cause) process.stdout.write(entry.cause);
  }
}
