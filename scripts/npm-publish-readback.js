#!/usr/bin/env node
// Reads back an npm release by its exact version, never the latest tag.
//
// npm accepts a publish, prints "Your package is being processed", and shows
// the version some minutes later. That gap was 3 to 10 minutes for most
// releases and 25 or 55 minutes for others with the same tarball shape
// (3.83.3 and 3.83.4 took 55). So an accepted publish counts as shipped, and
// whatever needs the version visible waits in its own job.
//
//   node scripts/npm-publish-readback.js wait <version> [--minutes 90] [--every-seconds 30]
//   node scripts/npm-publish-readback.js decide <version> --publish-status N --publish-output F
//       --view-status N --view-stdout F --view-stderr F

const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const PACKAGE = 'atris';

function textOf(result) {
  return `${(result && result.stdout) || ''}\n${(result && result.stderr) || ''}`;
}

function classifyPublish(result) {
  const text = textOf(result);
  if (result && result.status === 0) {
    return { accepted: true, processing: /being processed/i.test(text), reason: null };
  }
  const errorLine = text.split('\n')
    .map((line) => line.trim())
    .find((line) => line.startsWith('npm error ') && !/^npm error (code|A complete log)/.test(line));
  return {
    accepted: false,
    processing: false,
    reason: errorLine ? errorLine.replace(/^npm error /, '') : `npm publish exited ${result ? result.status : 'without a status'}`,
  };
}

function classifyView(version, result) {
  if (result && result.status === 0) {
    let shown = '';
    try { shown = String(JSON.parse(result.stdout || '""')); } catch { shown = String(result.stdout || '').trim(); }
    return shown === version ? 'visible' : 'missing';
  }
  const text = textOf(result);
  if (text.includes('E404') || text.includes('No match found')) return 'missing';
  return 'unknown';
}

function readExactVersion(version, runner = spawnSync) {
  const result = runner('npm', ['view', `${PACKAGE}@${version}`, 'version', '--json'], { encoding: 'utf8' });
  return classifyView(version, result);
}

function sleepMs(ms) {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Polls the exact version until it shows or the window ends.
function waitForVersion(version, runner = spawnSync, options = {}) {
  const everyMs = Math.max(0, Number(options.everySeconds ?? 30) * 1000);
  const windowMs = Math.max(0, Number(options.minutes ?? 90) * 60000);
  const tries = everyMs ? Math.floor(windowMs / everyMs) + 1 : 1;
  const sleep = options.sleep || sleepMs;
  const log = options.log || ((line) => process.stderr.write(`${line}\n`));
  let state = 'missing';
  let loggedMinute = 0;
  for (let attempt = 1; attempt <= tries; attempt += 1) {
    state = readExactVersion(version, runner);
    if (state === 'visible') return { state, tries: attempt };
    if (attempt < tries) {
      const minute = Math.floor((attempt * everyMs) / 60000);
      if (minute - loggedMinute >= 5) {
        loggedMinute = minute;
        log(`waiting for npm to show ${PACKAGE}@${version}, ${minute} minutes so far`);
      }
      sleep(everyMs);
    }
  }
  return { state, tries };
}

function decide(version, publish, viewState) {
  const verdict = classifyPublish(publish);
  if (!verdict.accepted) {
    return { exitCode: 1, visible: false, line: `npm rejected ${PACKAGE}@${version}: ${verdict.reason}` };
  }
  if (viewState === 'visible') {
    return { exitCode: 0, visible: true, line: `npm shows ${PACKAGE}@${version}.` };
  }
  return {
    exitCode: 0,
    visible: false,
    line: `npm accepted ${PACKAGE}@${version} and is still processing it, so it is not visible yet. the release counts as shipped; the registry listing job waits for it.`,
  };
}

function flag(args, name, fallback = null) {
  const i = args.indexOf(name);
  return i === -1 || i + 1 >= args.length ? fallback : args[i + 1];
}

function readFileOrEmpty(file) {
  try { return file ? fs.readFileSync(file, 'utf8') : ''; } catch { return ''; }
}

function main(args = process.argv.slice(2)) {
  const [command, version] = args;
  if (!version || !['wait', 'decide'].includes(command)) {
    process.stderr.write('usage: npm-publish-readback.js wait <version> [--minutes N] [--every-seconds S]\n');
    process.stderr.write('       npm-publish-readback.js decide <version> --publish-status N --publish-output F --view-status N --view-stdout F --view-stderr F\n');
    return 2;
  }
  if (command === 'wait') {
    const result = waitForVersion(version, spawnSync, {
      minutes: flag(args, '--minutes', 90),
      everySeconds: flag(args, '--every-seconds', 30),
    });
    if (result.state === 'visible') {
      process.stdout.write(`npm shows ${PACKAGE}@${version}.\n`);
      return 0;
    }
    process.stderr.write(`npm still does not show ${PACKAGE}@${version}; skipping the steps that need it.\n`);
    return 1;
  }
  const publish = { status: Number(flag(args, '--publish-status', 1)), stdout: '', stderr: readFileOrEmpty(flag(args, '--publish-output')) };
  const view = {
    status: Number(flag(args, '--view-status', 1)),
    stdout: readFileOrEmpty(flag(args, '--view-stdout')),
    stderr: readFileOrEmpty(flag(args, '--view-stderr')),
  };
  const outcome = decide(version, publish, classifyView(version, view));
  (outcome.exitCode === 0 ? process.stdout : process.stderr).write(`${outcome.line}\n`);
  return outcome.exitCode;
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = {
  classifyPublish,
  decide,
  readExactVersion,
  waitForVersion,
};
