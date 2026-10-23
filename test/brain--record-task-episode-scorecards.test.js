'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { recordTaskEpisodeScorecards } = require('../commands/brain');

function setupIsolatedEnv() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-brain-scorecards-'));
  process.env.HOME = root;
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('ATRIS_')) {
      delete process.env[key];
    }
  }
  return root;
}

function cleanupIsolatedEnv(root) {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors
  }
}

test('recordTaskEpisodeScorecards: empty workspace returns zero scorecards', () => {
  const root = setupIsolatedEnv();
  try {
    const result = recordTaskEpisodeScorecards({ root });

    assert.strictEqual(result.taskEpisodes, 0);
    assert.strictEqual(result.written, 0);
    assert.deepStrictEqual(result.scorecards, []);
    assert.strictEqual(result.stateRoot, root);

    const scorecardsPath = path.join(root, '.atris', 'state', 'scorecards.jsonl');
    assert.strictEqual(fs.existsSync(scorecardsPath), false);
  } finally {
    cleanupIsolatedEnv(root);
  }
});

test('recordTaskEpisodeScorecards: normal input enriches episode and writes scorecard', () => {
  const root = setupIsolatedEnv();
  try {
    const stateDir = path.join(root, '.atris', 'state');
    fs.mkdirSync(stateDir, { recursive: true });

    fs.writeFileSync(
      path.join(root, '.atris', 'business.json'),
      JSON.stringify({ slug: 'rocket-lab', business_id: 'biz-101', workspace_id: 'ws-202' }),
      'utf8'
    );

    const taskEpisode = {
      schema: 'atris.task_episode.v1',
      episode_id: 'ep-flight-01',
      task_id: 'task-engine-check',
      created_at: '2026-03-15T10:00:00.000Z',
      state: {
        title: 'Check booster valves',
        tag: 'propulsion',
        metadata: { built_by: 'carol' },
      },
      action: { actor: 'dave' },
      reward: { value: 1.0, source: 'task_review' },
      lesson: 'Always purge nitrogen lines',
      proof: 'pressure check passed',
    };

    fs.writeFileSync(
      path.join(stateDir, 'task_episodes.jsonl'),
      JSON.stringify(taskEpisode) + '\n',
      'utf8'
    );

    const taskProjection = {
      tasks: [
        {
          id: 'task-engine-check',
          review: {
            landing: {
              happened: 'Valves purged and tested',
              checked: 'Pressure gauge at 300 psi',
              tested: 'Static flow confirmed',
              decision: 'approved',
            },
            approval_status: 'accepted',
            human_revision_count: 0,
            human_revision_note: null,
          },
        },
      ],
    };

    fs.writeFileSync(
      path.join(stateDir, 'tasks.projection.json'),
      JSON.stringify(taskProjection),
      'utf8'
    );

    const result = recordTaskEpisodeScorecards({ root });

    assert.strictEqual(result.taskEpisodes, 1);
    assert.strictEqual(result.written, 1);
    assert.strictEqual(result.scorecards.length, 1);

    const scorecard = result.scorecards[0];
    assert.strictEqual(scorecard.schema, 'atris.brain.task_scorecard.v1');
    assert.strictEqual(scorecard.type, 'scorecard');
    assert.strictEqual(scorecard.scorecard_id, 'task-scorecard-ep-flight-01');
    assert.strictEqual(scorecard.source_episode_id, 'ep-flight-01');
    assert.strictEqual(scorecard.workspace, 'rocket-lab');
    assert.strictEqual(scorecard.business_id, 'biz-101');
    assert.strictEqual(scorecard.workspace_id, 'ws-202');
    assert.strictEqual(scorecard.task_id, 'task-engine-check');
    assert.strictEqual(scorecard.task_title, 'Check booster valves');
    assert.strictEqual(scorecard.task_tag, 'propulsion');
    assert.strictEqual(scorecard.actor, 'dave');
    assert.strictEqual(scorecard.builder, 'carol');
    assert.strictEqual(scorecard.reward, 1.0);
    assert.strictEqual(scorecard.reward_source, 'task_review');
    assert.strictEqual(scorecard.lesson, 'Always purge nitrogen lines');
    assert.strictEqual(scorecard.proof, 'pressure check passed');
    assert.strictEqual(scorecard.episode_created_at, '2026-03-15T10:00:00.000Z');
    assert.strictEqual(scorecard.approval_status, 'accepted');
    assert.strictEqual(typeof scorecard.ts, 'string');
    assert.ok(scorecard.review_landing !== null);
    assert.strictEqual(scorecard.review_landing.decision, 'approved');
    assert.strictEqual(scorecard.landing_quality.has_decision, true);
    assert.strictEqual(scorecard.landing_quality.completeness, 1);

    const scorecardsPath = path.join(stateDir, 'scorecards.jsonl');
    const writtenRows = fs.readFileSync(scorecardsPath, 'utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line));
    assert.strictEqual(writtenRows.length, 1);
    assert.strictEqual(writtenRows[0].scorecard_id, 'task-scorecard-ep-flight-01');

    // Edge case: Idempotent re-run skips writing when landing already exists
    const rerunResult = recordTaskEpisodeScorecards({ root });
    assert.strictEqual(rerunResult.taskEpisodes, 1);
    assert.strictEqual(rerunResult.written, 0);
    assert.deepStrictEqual(rerunResult.scorecards, []);

    const rowsAfterRerun = fs.readFileSync(scorecardsPath, 'utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line));
    assert.strictEqual(rowsAfterRerun.length, 1);
  } finally {
    cleanupIsolatedEnv(root);
  }
});

test('recordTaskEpisodeScorecards: filters non-v1 schema and dedupes multiple episodes to latest', () => {
  const root = setupIsolatedEnv();
  try {
    const stateDir = path.join(root, '.atris', 'state');
    fs.mkdirSync(stateDir, { recursive: true });

    const episodes = [
      {
        schema: 'atris.task_episode.legacy',
        episode_id: 'ep-ignored',
        task_id: 'task-telemetry',
      },
      {
        schema: 'atris.task_episode.v1',
        episode_id: 'ep-early',
        task_id: 'task-telemetry',
        created_at: '2026-01-01T00:00:00.000Z',
        state: {
          title: 'Telemetry stream',
          tag: 'avionics',
          claimed_by: 'eve',
        },
        reward: { value: 0.3 },
      },
      {
        schema: 'atris.task_episode.v1',
        episode_id: 'ep-late',
        task_id: 'task-telemetry',
        created_at: '2026-01-02T00:00:00.000Z',
        state: {
          title: 'Telemetry stream v2',
          tag: 'avionics',
          claimed_by: 'eve',
        },
        reward: { value: 0.9 },
      },
    ];

    fs.writeFileSync(
      path.join(stateDir, 'task_episodes.jsonl'),
      episodes.map(e => JSON.stringify(e)).join('\n') + '\n',
      'utf8'
    );

    const result = recordTaskEpisodeScorecards({ root });

    assert.strictEqual(result.taskEpisodes, 2);
    assert.strictEqual(result.written, 1);
    assert.strictEqual(result.scorecards.length, 1);

    const scorecard = result.scorecards[0];
    assert.strictEqual(scorecard.source_episode_id, 'ep-late');
    assert.strictEqual(scorecard.reward, 0.9);
    assert.strictEqual(scorecard.builder, 'eve');
    assert.strictEqual(scorecard.workspace, path.basename(root));
  } finally {
    cleanupIsolatedEnv(root);
  }
});

test('recordTaskEpisodeScorecards: throws when options argument is missing', () => {
  assert.throws(
    () => recordTaskEpisodeScorecards(),
    TypeError
  );
});
