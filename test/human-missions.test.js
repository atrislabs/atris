'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  HUMAN_STATES,
  stableMissionKey,
  missionCard,
  renderMissionCard,
  missionProofPayload,
  renderProofCard,
  askCommand,
  currentMissionCommand,
  proofCommand,
  approveCommand,
  stopCommand,
  answerCommand,
  checkCommand,
  readyCommand,
} = require('../commands/human-missions');
const { withReceiptVoice } = require('../lib/cloud-mission');

const cliPath = path.resolve(__dirname, '..', 'bin', 'atris.js');

function outputCapture() {
  const stdout = [];
  const stderr = [];
  return {
    stdout,
    stderr,
    log: (line) => stdout.push(String(line)),
    error: (line) => stderr.push(String(line)),
    setProcessExitCode: false,
  };
}

function credentials() {
  return { token: 'test-token', user_id: 'user-1' };
}

test('mission key is stable across whitespace and case', () => {
  assert.equal(
    stableMissionKey('user-1', 'business-1', '  Make   It Clear '),
    stableMissionKey('user-1', 'business-1', 'make it clear'),
  );
  assert.notEqual(
    stableMissionKey('user-1', 'business-1', 'make it clear'),
    stableMissionKey('user-1', 'business-2', 'make it clear'),
  );
});

test('ask sends the one-mission fields and prints one JSON card', async () => {
  const calls = [];
  const receipts = [];
  const output = outputCapture();
  const code = await askCommand([
    'Make', 'the', 'home', 'page', 'clearer', '--budget', '2', '--json',
  ], {
    ...output,
    root: '/tmp/atris-human-command-test',
    businessId: 'business-1',
    loadCredentials: credentials,
    appendCloudMissionReceipt: (_root, receipt) => receipts.push(receipt),
    apiRequestJson: async (pathname, options) => {
      calls.push({ pathname, options });
      return {
        ok: true,
        status: 200,
        data: { task_id: 'mission-1', status: 'pending', lane: 'fast' },
      };
    },
  });

  assert.equal(code, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].pathname, '/atris2/missions');
  assert.deepEqual(calls[0].options.body, {
    text: withReceiptVoice('Make the home page clearer'),
    lane: 'fast',
    business_id: 'business-1',
    idempotency_key: stableMissionKey('user-1', 'business-1', 'Make the home page clearer'),
    budget_usd: 2,
  });
  assert.equal(receipts.length, 1);
  const card = JSON.parse(output.stdout.join('\n'));
  assert.deepEqual(card, {
    mission_id: 'mission-1',
    title: 'Make the home page clearer',
    state: 'ready',
    progress_pct: 0,
    working_on: 'Waiting to start',
    next: 'Start the work',
    elapsed_s: 0,
    cost_usd: 0,
    budget_usd: 2,
    needs: null,
  });
  assert.deepEqual(output.stderr, []);
});

test('ask restates plain words and still sends an empty optional budget', async () => {
  const output = outputCapture();
  let sentBody = null;
  const code = await askCommand(['Make the headline clearer'], {
    ...output,
    businessId: 'business-1',
    loadCredentials: credentials,
    appendCloudMissionReceipt: () => {},
    apiRequestJson: async (_pathname, options) => {
      sentBody = options.body;
      return { ok: true, status: 200, data: { task_id: 'mission-plain', status: 'pending' } };
    },
  });

  assert.equal(code, 0);
  assert.equal(sentBody.budget_usd, null);
  assert.equal(output.stdout[0], "I understood: Make the headline clearer. I'm starting now.");
  assert.match(output.stdout.join('\n'), /Ready: Ready to begin your work/);
});

test('mission without a subcommand prints the current mission card as JSON', async () => {
  const output = outputCapture();
  const code = await currentMissionCommand(['--json'], {
    ...output,
    loadCredentials: credentials,
    apiRequestJson: async (pathname) => {
      assert.equal(pathname, '/atris2/missions/current');
      return {
        ok: true,
        status: 200,
        data: {
          mission_id: 'mission-current',
          title: 'Update the service page',
          state: 'working',
          progress_pct: 40,
          working_on: 'Rewriting the opening',
          next: 'Check every price',
          elapsed_s: 31,
          cost_usd: 0.42,
          budget_usd: 2,
          needs: null,
        },
      };
    },
  });

  assert.equal(code, 0);
  assert.equal(JSON.parse(output.stdout.join('\n')).state, 'working');
});

test('proof prints the last mission proof payload and human check labels', async () => {
  const proof = {
    goal: 'Update the service page',
    changed: ['service descriptions'],
    kept_same: ['prices', 'product IDs'],
    checks: [
      { name: 'prices_unchanged', passed: true },
      { name: 'product_ids_unchanged', passed: true },
    ],
    elapsed_s: 75,
    cost_usd: 0.45,
  };
  const request = async (pathname) => {
    assert.equal(pathname, '/atris2/missions/current');
    return {
      ok: true,
      status: 200,
      data: {
        mission_id: 'mission-proof',
        title: proof.goal,
        state: 'done',
        result: { proof },
      },
    };
  };

  const jsonOutput = outputCapture();
  const jsonCode = await proofCommand(['--json'], {
    ...jsonOutput,
    loadCredentials: credentials,
    apiRequestJson: request,
  });
  assert.equal(jsonCode, 0);
  assert.deepEqual(JSON.parse(jsonOutput.stdout.join('\n')), proof);

  const textOutput = outputCapture();
  const textCode = await proofCommand([], {
    ...textOutput,
    loadCredentials: credentials,
    apiRequestJson: request,
  });
  assert.equal(textCode, 0);
  assert.deepEqual(textOutput.stdout, renderProofCard(missionProofPayload({ result: { proof } })));
  assert.match(textOutput.stdout.join('\n'), /Checks passed:\n- Prices unchanged\n- Product IDs unchanged/);
  assert.match(textOutput.stdout.join('\n'), /Time: 1m 15s\nCost: \$0\.45/);
});

test('a missing current route uses plain words and says what to do next', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-human-mission-empty-'));
  try {
    const output = outputCapture();
    const code = await currentMissionCommand(['--json'], {
      ...output,
      root,
      loadCredentials: credentials,
      apiRequestJson: async () => ({
        ok: false,
        status: 404,
        data: { detail: 'Not Found' },
        error: 'Not Found',
      }),
    });

    assert.equal(code, 1);
    assert.deepEqual(JSON.parse(output.stdout.join('\n')), {
      ok: false,
      error: 'Atris could not find a running mission.',
      did: 'Nothing changed.',
      next: 'Start one with: atris ask "what you want"',
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a missing current route can fall back to the desk next', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-human-mission-desk-'));
  try {
    fs.mkdirSync(path.join(root, 'atris'), { recursive: true });
    fs.mkdirSync(path.join(root, '.atris', 'state'), { recursive: true });
    fs.writeFileSync(path.join(root, '.atris', 'state', 'tasks.projection.json'), JSON.stringify({
      schema: 'atris.task_projection.v1',
      tasks: [{
        id: 'task-map',
        display_id: 'TH1',
        title: 'generate map.md — scan codebase',
        status: 'open',
        created_at: 1,
        updated_at: 1,
      }],
    }, null, 2));

    const missing = outputCapture();
    const missingCode = await currentMissionCommand([], {
      ...missing,
      root,
      fallbackOnMissing: true,
      loadCredentials: credentials,
      apiRequestJson: async () => ({
        ok: false,
        status: 404,
        data: { detail: 'Not Found' },
        error: 'Not Found',
      }),
    });
    assert.equal(missingCode, 0);
    assert.match(missing.stdout.join('\n'), /generate map\.md/i);
    assert.match(missing.stdout.join('\n'), /ready to claim/);
    assert.match(missing.stdout.join('\n'), /atris task claim TH1 --as /);
    assert.doesNotMatch(missing.stdout.join('\n') + missing.stderr.join('\n'), /could not find a running mission|Start one with|business\.json|--mission|atris ask/);

    const live = outputCapture();
    const liveCode = await currentMissionCommand(['--json'], {
      ...live,
      root,
      fallbackOnMissing: true,
      loadCredentials: credentials,
      apiRequestJson: async (pathname) => {
        assert.equal(pathname, '/atris2/missions/current');
        return {
          ok: true,
          status: 200,
          data: {
            mission_id: 'mission-live',
            title: 'Keep the live mission visible',
            state: 'working',
            progress_pct: 20,
          },
        };
      },
    });
    assert.equal(liveCode, 0);
    assert.equal(JSON.parse(live.stdout.join('\n')).mission_id, 'mission-live');
    assert.doesNotMatch(live.stdout.join('\n'), /ready to claim|generate map/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('bare mission keeps local status but uses the cloud card without local state', () => {
  const localRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-human-mission-local-'));
  const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-human-mission-cloud-'));
  try {
    const stateDir = path.join(localRoot, '.atris', 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'missions.jsonl'), `${JSON.stringify({
      schema: 'atris.mission.v1',
      id: 'mission-local',
      objective: 'Keep the local mission status',
      owner: 'test-owner',
      status: 'running',
      created_at: '2026-08-07T12:00:00Z',
      updated_at: '2026-08-07T12:01:00Z',
    })}\n`);

    const env = (home) => ({
      ...process.env,
      HOME: home,
      ATRIS_SKIP_UPDATE_CHECK: '1',
      ATRIS_NO_INTERACTIVE: '1',
    });
    const local = spawnSync(process.execPath, [cliPath, 'mission', '--json'], {
      cwd: localRoot,
      encoding: 'utf8',
      env: env(localRoot),
    });
    assert.equal(local.status, 0, local.stderr || local.stdout);
    const localPayload = JSON.parse(local.stdout);
    assert.equal(localPayload.action, 'mission_status');
    assert.equal(localPayload.missions[0].id, 'mission-local');

    const cloud = spawnSync(process.execPath, [cliPath, 'mission', '--json'], {
      cwd: emptyRoot,
      encoding: 'utf8',
      env: env(emptyRoot),
    });
    assert.equal(cloud.status, 2, cloud.stderr || cloud.stdout);
    const cloudPayload = JSON.parse(cloud.stdout);
    assert.equal(cloudPayload.next_action, 'atris "what do you want here?"');
    assert.equal(cloudPayload.reason, 'this folder is empty');
    assert.doesNotMatch(cloud.stdout, /business\.json|not signed in|--mission/);
    assert.equal(cloudPayload.action, undefined);

    const roomRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-human-mission-room-'));
    fs.mkdirSync(path.join(roomRoot, 'atris'), { recursive: true });
    const room = spawnSync(process.execPath, [cliPath, 'mission'], {
      cwd: roomRoot,
      encoding: 'utf8',
      env: env(roomRoot),
    });
    const minute = spawnSync(process.execPath, [cliPath], {
      cwd: roomRoot,
      encoding: 'utf8',
      env: env(roomRoot),
    });
    assert.equal(room.status, 0, room.stderr || room.stdout);
    assert.equal(minute.status, 0, minute.stderr || minute.stdout);
    assert.equal(room.stdout.trim(), minute.stdout.trim());
    assert.doesNotMatch(room.stdout + room.stderr, /business\.json|atris ask|could not find a running mission|not signed in|--mission/);
    fs.rmSync(roomRoot, { recursive: true, force: true });
  } finally {
    fs.rmSync(localRoot, { recursive: true, force: true });
    fs.rmSync(emptyRoot, { recursive: true, force: true });
  }
});

test('approve approves the current item waiting for the user', async () => {
  const calls = [];
  const output = outputCapture();
  const code = await approveCommand(['--json'], {
    ...output,
    businessId: 'business-1',
    loadCredentials: credentials,
    apiRequestJson: async (pathname, options) => {
      calls.push({ pathname, options });
      if (pathname.endsWith('/current')) {
        return {
          ok: true,
          status: 200,
          data: {
            mission_id: 'mission-approve',
            title: 'Publish the update',
            state: 'your_turn',
            needs: { question: 'Publish now?', options: ['yes', 'no'] },
          },
        };
      }
      return {
        ok: true,
        status: 200,
        data: { mission_id: 'mission-approve', title: 'Publish the update', state: 'working' },
      };
    },
  });

  assert.equal(code, 0);
  assert.equal(calls[1].pathname, '/mission-control/missions/mission-approve/approve');
  assert.deepEqual(calls[1].options.body, {});
  assert.equal(JSON.parse(output.stdout.join('\n')).state, 'working');
});

test('stop stops the current mission', async () => {
  const calls = [];
  const output = outputCapture();
  const code = await stopCommand(['--json'], {
    ...output,
    businessId: 'business-1',
    loadCredentials: credentials,
    apiRequestJson: async (pathname, options) => {
      calls.push({ pathname, options });
      if (pathname.endsWith('/current')) {
        return {
          ok: true,
          status: 200,
          data: { mission_id: 'mission-stop', title: 'Stop this', state: 'working' },
        };
      }
      return {
        ok: true,
        status: 200,
        data: { mission_id: 'mission-stop', title: 'Stop this', state: 'stopped' },
      };
    },
  });

  assert.equal(code, 0);
  assert.equal(calls[1].pathname, '/mission-control/missions/mission-stop/stop');
  assert.equal(JSON.parse(output.stdout.join('\n')).state, 'stopped');
});

test('mission answer sends text to the current mission', async () => {
  const calls = [];
  const output = outputCapture();
  const code = await answerCommand(['Use', 'the', 'shorter', 'version', '--json'], {
    ...output,
    businessId: 'business-1',
    loadCredentials: credentials,
    apiRequestJson: async (pathname, options) => {
      calls.push({ pathname, options });
      if (pathname.endsWith('/current')) {
        return {
          ok: true,
          status: 200,
          data: {
            mission_id: 'mission-answer',
            title: 'Choose the copy',
            state: 'your_turn',
            needs: { question: 'Which version?', options: ['shorter', 'longer'] },
          },
        };
      }
      return {
        ok: true,
        status: 200,
        data: { mission_id: 'mission-answer', title: 'Choose the copy', state: 'working' },
      };
    },
  });

  assert.equal(code, 0);
  assert.equal(calls[1].pathname, '/mission-control/missions/mission-answer/answer');
  assert.deepEqual(calls[1].options.body, { answer: 'Use the shorter version' });
});

test('check prints fetched check results as JSON', async () => {
  const output = outputCapture();
  const code = await checkCommand(['mission-checked', '--json'], {
    ...output,
    loadCredentials: credentials,
    apiRequestJson: async (pathname, options) => {
      assert.equal(pathname, '/mission-control/missions/mission-checked');
      assert.equal(options.method, 'GET');
      return {
        ok: true,
        status: 200,
        data: {
          mission_id: 'mission-checked',
          result: { checks: [{ name: 'Prices unchanged', passed: true }] },
        },
      };
    },
  });

  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(output.stdout.join('\n')), {
    mission_id: 'mission-checked',
    passed: true,
    checks: [{ name: 'Prices unchanged', passed: true }],
  });
});

test('ready reports only capabilities that its probes found', async () => {
  const output = outputCapture();
  const code = await readyCommand(['--json'], {
    ...output,
    businessId: 'business-1',
    loadCredentials: credentials,
    apiRequestJson: async (pathname) => {
      if (pathname === '/ai-computer/user/status') {
        return { ok: true, status: 200, data: { status: 'running', version: '1.0' } };
      }
      if (pathname === '/atris2/health') return { ok: true, status: 200, data: { ready: true } };
      return { ok: false, status: 404, data: { detail: 'Mission not found' }, error: 'Mission not found' };
    },
  });

  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(output.stdout.join('\n')), {
    ready: true,
    cli_version: require('../package.json').version,
    computer_version: '1.0',
    can_run_missions: true,
    can_check_work: true,
    can_make_proof: true,
  });
});

test('ready does not claim remote features without sign-in or route proof', async () => {
  const output = outputCapture();
  const code = await readyCommand(['--json'], {
    ...output,
    businessId: 'business-1',
    loadCredentials: () => null,
    apiRequestJson: async () => ({ ok: true, status: 200, data: { version: '1.0' } }),
  });

  assert.equal(code, 1);
  const payload = JSON.parse(output.stdout.join('\n'));
  assert.deepEqual(payload, {
    ready: false,
    cli_version: require('../package.json').version,
    computer_version: null,
    can_run_missions: false,
    can_check_work: false,
    can_make_proof: true,
  });
});

test('all six wire states render with the required human names', () => {
  for (const [wire, human] of Object.entries(HUMAN_STATES)) {
    const card = missionCard({ mission_id: wire, title: wire, state: wire });
    assert.equal(renderMissionCard(card)[1].split(':')[0], human);
    assert.equal(renderMissionCard(card)[1].split(': ').slice(1).join(': ').split(/\s+/).length, 5);
  }
});

test('public command help is wired through the CLI', () => {
  const commands = [
    ['ask', '--help'],
    ['approve', '--help'],
    ['stop', '--help'],
    ['ready', '--help'],
    ['check', '--help'],
    ['proof', '--help'],
    ['mission', 'answer', '--help'],
  ];
  for (const args of commands) {
    const result = spawnSync(process.execPath, [cliPath, ...args], {
      cwd: path.resolve(__dirname, '..'),
      encoding: 'utf8',
      env: { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1' },
    });
    assert.equal(result.status, 0, `${args.join(' ')}\n${result.stderr}\n${result.stdout}`);
    assert.match(result.stdout, /Usage: atris/);
    if (args[0] === 'proof') assert.match(result.stdout, /Usage: atris proof \[--json\]/);
  }
});
