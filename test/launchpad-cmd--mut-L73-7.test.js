'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const [run] = Object.values(require('../commands/launchpad'));

test('counts certified review task when agent review pass threshold is met', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'run-card-'));
  const origCwd = process.cwd();
  const origHome = process.env.HOME;
  process.env.HOME = tmp;

  fs.mkdirSync(path.join(tmp, 'atris'));
  fs.mkdirSync(path.join(tmp, '.atris', 'state'), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, '.atris', 'state', 'tasks.projection.json'),
    JSON.stringify({
      tasks: [
        {
          id: 'task-1',
          title: 'Review landing candidate',
          status: 'review',
          review: {
            agent_review_pass_count: 2,
          },
        },
      ],
    })
  );

  let out = '';
  const origLog = console.log;
  console.log = (...args) => {
    out += args.join(' ') + '\n';
  };

  try {
    process.chdir(tmp);
    run(['--json']);
  } finally {
    console.log = origLog;
    process.chdir(origCwd);
    process.env.HOME = origHome || tmp;
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  const payload = JSON.parse(out);
  assert.strictEqual(payload.counts.review_certified, 1);
});
