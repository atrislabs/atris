'use strict';

// `atris done`: the one command a person runs after their coding agent built
// the thing. It names what was built, lands it through the real task path
// (`task ready --verify` then `task accept`, same gates agents face), and ends
// with a short credits roll and the file to open.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { argsWantHelp } = require('../lib/noninteractive');
const {
  buildFirstMinute,
  firstTalkBuildCommand,
  firstTalkBuilder,
  folderName,
  humanStarterTask,
  isFreshWorkspace,
  listBuiltSince,
  loadLocalTasks,
  mainBuiltFile,
  orderBuilt,
  personName,
  speakFirstMinute,
  spokenBuiltList,
  taskStartedAt,
} = require('../lib/first-minute');

const ATRIS_BIN = path.join(__dirname, '..', 'bin', 'atris.js');
const DONE_SCHEMA = 'atris.one_lap.v1';

// What a page has, in plain words, for the first tag found.
const HTML_MARKS = [
  ['<form', 'the form'],
  ['<h1', 'the heading'],
  ['<title', 'the page title'],
  ['<main', 'the main section'],
  ['<body', 'the page body'],
  ['<html', 'the page'],
];

function doneUsage() {
  return 'Usage: atris done [<task>] [--json]';
}

function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function spokenTitle(task) {
  return String((task && task.title) || 'this').replace(/\s+/g, ' ').trim().replace(/[.,;:!?]+$/g, '');
}

function readHead(root, file) {
  try {
    const buf = fs.readFileSync(path.join(root, file));
    return buf.subarray(0, 65536);
  } catch {
    return null;
  }
}

// A check that fails when the built file is gone or no longer holds what was
// built, so it clears the weak-verifier and empty-folder gates honestly.
function verifierFor(root, files) {
  const ordered = orderBuilt(files);
  for (const file of ordered) {
    const head = readHead(root, file);
    if (!head || !head.length || head.includes(0)) continue;
    const text = head.toString('utf8');
    if (/\.html?$/i.test(file)) {
      const lower = text.toLowerCase();
      const mark = HTML_MARKS.find(([tag]) => lower.includes(tag));
      if (mark) {
        return {
          command: `grep -qi ${shQuote(mark[0])} ${shQuote(file)}`,
          plain: `${file} has ${mark[1]}`,
          file,
        };
      }
    }
    const word = (text.match(/[A-Za-z][A-Za-z0-9_-]{3,}/) || [])[0];
    if (word) {
      return {
        command: `grep -qF ${shQuote(word)} ${shQuote(file)}`,
        plain: `${file} says "${word}"`,
        file,
      };
    }
  }
  const file = ordered.find((name) => {
    const head = readHead(root, name);
    return head && head.length;
  });
  if (!file) return null;
  return {
    command: `grep -qa . ${shQuote(file)}`,
    plain: `${file} is there and not empty`,
    file,
  };
}

// One sentence the ready gate accepts: what the person can do now and why.
function resultSentence(task) {
  const { explainResult } = require('../lib/autoland');
  const title = spokenTitle(task).replace(/[.!?]/g, '').slice(0, 100).trim();
  const candidates = [
    `You can now open ${title} and use it yourself, so it is real instead of only a plan.`,
    'You can now open what you asked for here and use it yourself, so it is real instead of only a plan.',
  ];
  return candidates.find((line) => explainResult(line, { allowCommandMention: true }).ok) || candidates[1];
}

function openCommand(file) {
  const target = /^[\w./-]+$/.test(file) ? file : shQuote(file);
  if (process.platform === 'darwin') return `open ${target}`;
  if (process.platform === 'win32') return `start ${target}`;
  return `xdg-open ${target}`;
}

function buildCommandFor(task, builder) {
  const pick = builder !== undefined ? builder : firstTalkBuilder();
  // Test runners skip the machine probe; name the default builder so the line stays runnable.
  return firstTalkBuildCommand(pick === undefined ? 'claude' : pick, spokenTitle(task));
}

function taskRefOf(task) {
  return String((task && (task.display_id || task.legacy_ref || task.id)) || '').trim();
}

function findTask(tasks, ref) {
  const want = String(ref || '').trim().toLowerCase();
  if (!want) return null;
  return tasks.find((task) => [task.display_id, task.legacy_ref, task.id]
    .some((value) => value && String(value).toLowerCase() === want))
    || tasks.find((task) => task.id && String(task.id).toLowerCase().startsWith(want))
    || null;
}

function pickTask(tasks, person) {
  const starter = humanStarterTask(tasks, person);
  if (starter) return starter;
  const who = String(person || '').trim();
  const mine = tasks
    .filter((task) => (task.status === 'claimed' || task.status === 'review')
      && (!who || String(task.claimed_by || '') === who))
    .sort((a, b) => Number(b.updated_at || 0) - Number(a.updated_at || 0));
  return mine[0] || null;
}

function runAtris(root, args) {
  const result = spawnSync(process.execPath, [ATRIS_BIN, ...args], {
    cwd: root,
    env: process.env,
    encoding: 'utf8',
    timeout: 240000,
  });
  let json = null;
  try {
    json = JSON.parse(String(result.stdout || '').trim());
  } catch {
    json = null;
  }
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
    json,
  };
}

function failureLine(step) {
  const text = `${step.stderr}\n${step.stdout}`;
  if (step.json && (step.json.detail || step.json.reason)) {
    return String(step.json.detail || step.json.reason).split('\n')[0];
  }
  const line = text.split('\n').map((s) => s.trim()).find(Boolean);
  return line || `exit ${step.status}`;
}

function liveTask(root, id) {
  try {
    const taskDb = require('../lib/task-db');
    const db = taskDb.open();
    return taskDb.getTask(db, id);
  } catch {
    return null;
  }
}

function receiptFromProof(proof) {
  const match = String(proof || '').match(/Receipt:\s*(\S+\.json)/);
  return match ? match[1] : '';
}

// The receipt is the record. Say on it that the person who owned this work
// accepted it themselves, through `atris done`.
function stampOwnerAccept(root, receiptPath, { owner, actor }) {
  if (!receiptPath) return false;
  const file = path.resolve(root, receiptPath);
  try {
    const receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
    receipt.accepted = {
      by: actor || owner || null,
      owner: owner || null,
      self_accepted: true,
      via: 'atris done',
      note: 'the human owner accepted their own work',
      at: new Date().toISOString(),
    };
    fs.writeFileSync(file, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

function renderCredits({ title, built, checked, receipt, next }) {
  return [
    '',
    `  ${title}`,
    '',
    `  built     ${spokenBuiltList(built)}`,
    `  checked   ${checked}, passed`,
    `  signed    ${receipt || 'the task record'}`,
    '',
    `next: ${next}`,
  ].join('\n');
}

function emit(asJson, log, payload, text) {
  if (asJson) log(JSON.stringify(payload, null, 2));
  else log(text);
}

function doneAtris(args = process.argv.slice(3), {
  root = process.cwd(),
  log = console.log,
  builder,
} = {}) {
  const list = Array.isArray(args) ? args : [];
  if (argsWantHelp(list)) {
    log(doneUsage());
    return 0;
  }
  const asJson = list.includes('--json');
  const ref = list.find((arg) => !String(arg).startsWith('-')) || '';

  if (isFreshWorkspace(root)) {
    return speakFirstMinute({ root, fresh: true, asJson, log });
  }

  const person = personName();
  const tasks = loadLocalTasks(root);
  const task = ref ? findTask(tasks, ref) : pickTask(tasks, person);

  if (!task) {
    const minute = buildFirstMinute({ root, builder });
    const reason = ref ? `nothing here is called ${ref}` : 'nothing of yours is in progress here';
    // Already shipped: say so, the same way bare atris does.
    const text = !ref && minute.shipped ? `\n${minute.text}` : `\n${reason}.\n\nnext: ${minute.nextCommand}`;
    emit(asJson, log, {
      schema: DONE_SCHEMA,
      ok: false,
      status: 'stuck',
      reason,
      next_action: minute.nextCommand,
    }, text);
    return asJson ? 2 : 0;
  }

  const title = spokenTitle(task);
  if (task.status === 'done') {
    emit(asJson, log, {
      schema: DONE_SCHEMA,
      ok: true,
      status: 'already_done',
      reason: `${title} is already done`,
      next_action: buildFirstMinute({ root, builder }).nextCommand,
    }, `\n${title} is already done.\n\nnext: ${buildFirstMinute({ root, builder }).nextCommand}`);
    return 0;
  }
  if (!['open', 'claimed', 'review'].includes(task.status)) {
    emit(asJson, log, {
      schema: DONE_SCHEMA,
      ok: false,
      status: 'stuck',
      reason: `${title} is ${task.status}`,
      next_action: `atris task show ${taskRefOf(task)}`,
    }, `\n${title} is ${task.status}.\n\nnext: atris task show ${taskRefOf(task)}`);
    return asJson ? 2 : 0;
  }

  const built = orderBuilt(listBuiltSince(root, taskStartedAt(task)));
  if (!built.length) {
    const next = buildCommandFor(task, builder);
    emit(asJson, log, {
      schema: DONE_SCHEMA,
      ok: true,
      status: 'nothing_new',
      reason: `nothing new here since you started ${title}`,
      task: { display_id: task.display_id || null, title: task.title },
      built: [],
      next_action: next,
    }, `\nnothing new here since you started ${title}.\n\nnext: ${next}`);
    return 0;
  }

  const verify = verifierFor(root, built);
  const fail = (reason, next) => {
    emit(asJson, log, {
      schema: DONE_SCHEMA,
      ok: false,
      status: 'stuck',
      reason,
      task: { display_id: task.display_id || null, title: task.title },
      built,
      next_action: next,
    }, `\n${title} has new work, but ${reason}.\n\nnext: ${next}`);
    return 1;
  };
  if (!verify) return fail('nothing built has content to check yet', buildCommandFor(task, builder));

  let current = liveTask(root, task.id) || task;
  if (current.status !== 'review') {
    const ready = runAtris(root, [
      'task', 'ready', task.id,
      '--verify', verify.command,
      '--result', resultSentence(task),
      '--json',
    ]);
    if (!ready.ok) {
      return fail(`the check did not pass (${failureLine(ready)})`, `atris task show ${taskRefOf(task)}`);
    }
    current = liveTask(root, task.id) || current;
  }
  const receipt = receiptFromProof(current && current.metadata && current.metadata.latest_agent_proof);

  const accept = runAtris(root, ['task', 'accept', task.id, '--json']);
  if (!accept.ok) {
    const why = failureLine(accept);
    const waiting = /agent_proof_only|cannot accept/i.test(`${why} ${accept.stderr} ${accept.stdout}`);
    return fail(
      waiting ? 'it is checked and waiting on a person to accept it' : `accept did not go through (${why})`,
      `atris task accept ${taskRefOf(task)}`,
    );
  }
  const actor = (accept.json && accept.json.episode && (accept.json.episode.actor || accept.json.episode.reviewer)) || '';
  const stamped = stampOwnerAccept(root, receipt, { owner: task.claimed_by || person, actor });

  const main = mainBuiltFile(built);
  const next = openCommand(main);
  emit(asJson, log, {
    schema: DONE_SCHEMA,
    ok: true,
    status: 'done',
    reason: `${title} is done`,
    task: { display_id: task.display_id || null, title: task.title },
    built,
    checked: { command: verify.command, plain: verify.plain, passed: true },
    receipt: receipt || null,
    owner_accepted: stamped,
    next_action: next,
  }, renderCredits({ title, built, checked: verify.plain, receipt, next }));
  return 0;
}

module.exports = {
  doneAtris,
  resultSentence,
  verifierFor,
  openCommand,
};
