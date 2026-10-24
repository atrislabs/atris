'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const missionArtifact = require('../lib/mission-artifact');

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-mission-artifact-'));
}

test('missionArtifactPaths keeps the run folder inside the root', () => {
  const root = tempRoot();
  try {
    const messy = missionArtifact.missionArtifactPaths({ id: 'Ship it: now/please?' }, root);
    assert.strictEqual(messy.relativeDir, 'atris/runs/Ship-it-now-please');
    assert.strictEqual(messy.relativeIndexMd, 'atris/runs/Ship-it-now-please/index.md');
    assert.strictEqual(messy.relativeIndexHtml, 'atris/runs/Ship-it-now-please/index.html');
    assert.strictEqual(messy.relativeBlocksJson, 'atris/runs/Ship-it-now-please/blocks.json');
    assert.strictEqual(messy.relativeRawJson, 'atris/runs/Ship-it-now-please/raw.json');
    assert.strictEqual(messy.dir, path.join(root, 'atris', 'runs', 'Ship-it-now-please'));

    const traversal = missionArtifact.missionArtifactPaths({ id: '../../etc/passwd' }, root);
    assert.strictEqual(traversal.relativeDir, 'atris/runs/..-..-etc-passwd');
    assert.strictEqual(path.basename(traversal.dir), '..-..-etc-passwd');
    assert.ok(traversal.dir.startsWith(path.join(root, 'atris', 'runs') + path.sep));

    assert.strictEqual(
      missionArtifact.missionArtifactPaths({ id: '///' }, root).relativeDir,
      'atris/runs/mission',
    );
    assert.strictEqual(
      missionArtifact.missionArtifactPaths({}, root).relativeDir,
      'atris/runs/mission',
    );
    assert.strictEqual(
      missionArtifact.missionArtifactPaths({ slug: 'Night Shift' }, root).relativeDir,
      'atris/runs/Night-Shift',
    );
    assert.strictEqual(
      missionArtifact.missionArtifactPaths({ id: 'a'.repeat(200) }, root).relativeDir,
      `atris/runs/${'a'.repeat(120)}`,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('writeMissionArtifact writes the timeline, proof, and escaped page', () => {
  const root = tempRoot();
  try {
    const objectiveWords = Array.from({ length: 40 }, (_, index) => `word${String(index).padStart(2, '0')}`);
    const objective = objectiveWords.join(' ');
    const mission = {
      id: 'ship/alpha?',
      objective,
      owner: 'ada',
      created_at: '2026-01-01T00:00:00.000Z',
      completed_at: '2026-01-03T00:00:00.000Z',
      native_goal_ack: {
        objective: 'Show <landing> & "page"\'',
        acknowledged_at: '2026-01-01T01:00:00.000Z',
      },
      xp_task: { ref: 'TASK-9' },
      verifier: 'node --test decoy.test.js',
      verifier_result: {
        passed: true,
        command: 'node --test test/alpha.test.js',
        finished_at: '2026-01-02T12:00:00.000Z',
      },
    };
    const proof = 'proofs/receipt.json';
    fs.mkdirSync(path.join(root, 'proofs'), { recursive: true });
    fs.writeFileSync(path.join(root, proof), JSON.stringify({
      at: '2026-01-02T08:00:00.000Z',
      result: {
        summary: 'DECOY_RESULT_SUMMARY should not win',
        tick: {
          summary: 'landed the page',
          atris2: { summary: 'DECOY_ATRIS2_SUMMARY', receipt_text: 'DECOY_RECEIPT_LINE is not the story' },
          claude: { summary: 'DECOY_CLAUDE_SUMMARY' },
        },
      },
    }), 'utf8');
    const eventsDir = path.join(root, '.atris', 'state');
    fs.mkdirSync(eventsDir, { recursive: true });
    fs.writeFileSync(path.join(eventsDir, 'mission_events.jsonl'), [
      JSON.stringify({ mission_id: 'other', type: 'mission_started', at: '1999-01-01T00:00:00.000Z' }),
      'not-json',
      '',
      JSON.stringify({ mission_id: 'ship/alpha?', type: 'mission_started', at: '2026-01-04T00:00:00.000Z' }),
      JSON.stringify({ mission_id: 'ship/alpha?', type: 'mission_task_spine_attached', at: '2026-01-01T02:00:00.000Z' }),
      JSON.stringify({ mission_id: 'ship/alpha?', type: 'mission_started', at: '2026-01-01T00:00:00.000Z' }),
    ].join('\n'), 'utf8');

    const written = missionArtifact.writeMissionArtifact(mission, {
      root,
      proof,
      completion: {
        landing: {
          happened: 'The page is live.',
          checked: 'node --test test/alpha.test.js',
        },
      },
      continuationGoal: {
        mission: {
          objective: 'Write the follow-up note',
          created_at: '2026-01-03T01:00:00.000Z',
        },
      },
    });

    assert.deepStrictEqual(written, {
      dir: 'atris/runs/ship-alpha',
      index_md: 'atris/runs/ship-alpha/index.md',
      index_html: 'atris/runs/ship-alpha/index.html',
      blocks_json: 'atris/runs/ship-alpha/blocks.json',
      raw_json: 'atris/runs/ship-alpha/raw.json',
      timeline_count: 7,
    });

    const blocks = JSON.parse(fs.readFileSync(path.join(root, written.blocks_json), 'utf8'));
    const raw = JSON.parse(fs.readFileSync(path.join(root, written.raw_json), 'utf8'));
    const markdown = fs.readFileSync(path.join(root, written.index_md), 'utf8');
    const html = fs.readFileSync(path.join(root, written.index_html), 'utf8');
    const startedBody = `We named the outcome: ${objectiveWords.slice(0, 27).join(' ')}...`;

    assert.strictEqual(blocks.schema, 'atris.mission_artifact_blocks.v1');
    assert.strictEqual(blocks.mission_id, 'ship/alpha?');
    assert.strictEqual(blocks.objective, objective);
    assert.strictEqual(blocks.owner, 'ada');
    assert.match(blocks.generated_at, /^\d{4}-\d{2}-\d{2}T/);
    assert.strictEqual(blocks.landing.changed, 'The page is live.');
    assert.strictEqual(blocks.landing.proof, proof);
    assert.strictEqual(blocks.landing.artifact, written.index_html);
    assert.strictEqual(
      blocks.landing.next,
      'Review the timeline and proof, then human-accept the task if it matches what you wanted.',
    );
    assert.deepStrictEqual(
      blocks.blocks.map((block) => block.type),
      ['landing', 'timeline', 'proof', 'next_action'],
    );
    assert.strictEqual(blocks.blocks[0].checked, 'node --test test/alpha.test.js');
    assert.deepStrictEqual(
      blocks.blocks[1].items.map((item) => ({
        order: item.order,
        title: item.title,
        status: item.status,
        at: item.at,
      })),
      [
        { order: 1, title: 'Mission started', status: 'done', at: '2026-01-01T00:00:00.000Z' },
        { order: 2, title: 'Goal set', status: 'done', at: '2026-01-01T01:00:00.000Z' },
        { order: 3, title: 'Task claimed', status: 'done', at: '2026-01-01T02:00:00.000Z' },
        { order: 4, title: 'Goal 1 done', status: 'done', at: '2026-01-02T08:00:00.000Z' },
        { order: 5, title: 'Verifier passed', status: 'done', at: '2026-01-02T12:00:00.000Z' },
        { order: 6, title: 'Next goal queued', status: 'next', at: '2026-01-03T01:00:00.000Z' },
        { order: 7, title: 'Mission accomplished', status: 'done', at: '2026-01-03T00:00:00.000Z' },
      ],
    );
    assert.strictEqual(blocks.blocks[1].items[0].body, startedBody);
    assert.strictEqual(blocks.blocks[1].items[1].body, 'We set the visible goal: Show <landing> & "page"\'.');
    assert.strictEqual(blocks.blocks[1].items[2].body, 'We attached TASK-9 to ada.');
    assert.strictEqual(blocks.blocks[1].items[3].body, 'We produced landed the page.');
    assert.strictEqual(blocks.blocks[1].items[3].meaning, 'The inspectable proof is proofs/receipt.json.');
    assert.strictEqual(
      blocks.blocks[1].items[4].body,
      'We checked it with node --test test/alpha.test.js.',
    );
    assert.strictEqual(
      blocks.blocks[1].items[4].meaning,
      'The proof is not just a claim; it passed the recorded check.',
    );
    assert.strictEqual(
      blocks.blocks[1].items[5].body,
      'Atris queued the next mission: Write the follow-up note.',
    );
    assert.deepStrictEqual(
      blocks.blocks[2].links.map((link) => link.label),
      ['Timeline page', 'Markdown', 'Blocks', 'Raw', 'Machine receipt'],
    );
    assert.strictEqual(blocks.blocks[2].links[4].path, proof);

    assert.strictEqual(raw.schema, 'atris.mission_artifact_raw.v1');
    assert.strictEqual(raw.generated_at, blocks.generated_at);
    assert.strictEqual(raw.proof, proof);
    assert.strictEqual(raw.proof_receipt.result.tick.summary, 'landed the page');
    assert.strictEqual(raw.events.length, 3);
    assert.strictEqual(raw.events[0].at, '2026-01-01T00:00:00.000Z');
    assert.strictEqual(raw.continuation_goal.mission.objective, 'Write the follow-up note');
    assert.ok(fs.readFileSync(path.join(root, written.blocks_json), 'utf8').endsWith('\n'));

    assert.ok(markdown.startsWith('# Mission timeline\n\n'));
    assert.ok(markdown.includes(objective));
    assert.ok(markdown.includes(startedBody));
    assert.ok(markdown.includes('- Machine receipt: `proofs/receipt.json`'));
    assert.ok(markdown.includes('## Next'));
    assert.ok(!markdown.includes('DECOY_RESULT_SUMMARY'));
    assert.ok(!markdown.includes('DECOY_RECEIPT_LINE'));
    assert.ok(!markdown.includes('1999-01-01'));

    assert.ok(html.startsWith('<!doctype html>'));
    assert.ok(html.includes(`<p class="objective">${objective}</p>`));
    assert.ok(html.includes('We set the visible goal: Show &lt;landing&gt; &amp; &quot;page&quot;&#39;.'));
    assert.ok(!html.includes('Show <landing>'));
    assert.ok(html.includes('<p class="next">Review the timeline and proof, then human-accept the task if it matches what you wanted.</p>'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('writeMissionArtifact records a saved proof when no verifier ran', () => {
  const root = tempRoot();
  try {
    const mission = {
      id: 'plain',
      objective: 'Save the note',
      owner: 'sam',
      created_at: '2026-02-01T00:00:00.000Z',
      completed_at: '2026-02-02T00:00:00.000Z',
      completion_gate: { source: 'no_verifier' },
    };
    const written = missionArtifact.writeMissionArtifact(mission, { root });
    const blocks = JSON.parse(fs.readFileSync(path.join(root, written.blocks_json), 'utf8'));
    const raw = JSON.parse(fs.readFileSync(path.join(root, written.raw_json), 'utf8'));
    const items = blocks.blocks.find((block) => block.type === 'timeline').items;
    const links = blocks.blocks.find((block) => block.type === 'proof').links;

    assert.strictEqual(written.timeline_count, 3);
    assert.deepStrictEqual(items.map((item) => item.title), [
      'Mission started',
      'Proof file saved',
      'Mission accomplished',
    ]);
    assert.strictEqual(items[0].at, '2026-02-01T00:00:00.000Z');
    assert.strictEqual(items[1].status, 'watch');
    assert.strictEqual(items[1].body, 'We saved the proof file for this completed mission.');
    assert.strictEqual(
      items[1].meaning,
      'This is ready for human inspection; repeat runs should save the same check command every time.',
    );
    assert.strictEqual(items[1].at, null);
    assert.strictEqual(items[2].body, 'Save the note is complete.');
    assert.strictEqual(
      blocks.landing.next,
      'Review the timeline and proof, then pick the next customer-facing move.',
    );
    assert.strictEqual(blocks.landing.changed, 'Save the note is complete.');
    assert.strictEqual(blocks.landing.proof, null);
    assert.deepStrictEqual(links.map((link) => link.label), [
      'Timeline page',
      'Markdown',
      'Blocks',
      'Raw',
    ]);
    assert.deepStrictEqual(raw.events, []);
    assert.strictEqual(raw.proof_receipt, null);
    assert.strictEqual(raw.proof, '');
    assert.ok(!fs.existsSync(path.join(root, '.atris', 'state', 'mission_events.jsonl')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
