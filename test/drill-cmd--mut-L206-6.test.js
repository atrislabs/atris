'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runDrill } = require('../commands/drill');

function installStub(resolved, exports) {
  const previous = require.cache[resolved];
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports,
  };
  return previous;
}

test('tick verified rejects a mission run whose first tick has no drill touch', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drill-cmd-mut-L206-6-'));
  const savedCwd = process.cwd();
  const savedEnv = { ...process.env };
  const stubs = [
    [require.resolve('../commands/init'), { initAtris() {} }],
    [require.resolve('../commands/wish'), {
      wishCommand() {
        return 1;
      },
      readWishes() {
        return [{ status: 'needs_input', text: 'fix auth' }];
      },
    }],
    [require.resolve('../commands/task'), {
      delegateTask() {
        return { task_id: 'task-1' };
      },
    }],
    [require.resolve('../lib/task-db'), {
      open() {
        return {};
      },
      claimTask() {
        return { claimed: true };
      },
      getTask() {
        return { status: 'claimed' };
      },
      close() {},
    }],
    [require.resolve('../commands/mission'), {
      startMission() {
        return {
          mission: {
            id: 'mission-1',
            runner: 'drill',
            verifier: 'node -e "process.exit(0)"',
          },
        };
      },
      missionCommand() {
        console.log(JSON.stringify({
          ok: true,
          action: 'mission_run',
          ran_ticks: 1,
          ticks: [{ drill: false }],
        }));
      },
    }],
  ];
  const previousModules = stubs.map(([resolved, exports]) => [resolved, installStub(resolved, exports)]);

  for (const key of Object.keys(process.env)) {
    if (key.startsWith('ATRIS_')) delete process.env[key];
  }
  process.env.HOME = root;
  process.env.USERPROFILE = root;
  process.chdir(root);

  try {
    const result = await runDrill({ reporter() {} });
    assert.deepEqual(
      result.stages.map((stage) => ({
        name: stage.name,
        ok: stage.ok,
        error: stage.error || null,
      })),
      [
        { name: 'sandbox ready', ok: true, error: null },
        { name: 'wish captured', ok: true, error: null },
        { name: 'task claimed', ok: true, error: null },
        { name: 'mission started', ok: true, error: null },
        { name: 'tick verified', ok: false, error: 'drill runner did not record a touch' },
      ],
    );
    assert.equal(result.pass, false);
  } finally {
    for (const [resolved, previous] of previousModules) {
      if (previous) require.cache[resolved] = previous;
      else delete require.cache[resolved];
    }
    process.chdir(savedCwd);
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) delete process.env[key];
    }
    Object.assign(process.env, savedEnv);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
