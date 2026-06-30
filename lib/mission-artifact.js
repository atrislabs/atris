'use strict';

const fs = require('fs');
const path = require('path');

function stampIso() {
  return new Date().toISOString();
}

function toPosixPath(value) {
  return String(value || '').split(path.sep).join('/');
}

function safeSegment(value) {
  return String(value || 'mission')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120) || 'mission';
}

function missionArtifactPaths(mission, root = process.cwd()) {
  const dir = path.join(root, 'atris', 'runs', safeSegment(mission?.id || mission?.slug || 'mission'));
  const indexMd = path.join(dir, 'index.md');
  const indexHtml = path.join(dir, 'index.html');
  const blocksJson = path.join(dir, 'blocks.json');
  const rawJson = path.join(dir, 'raw.json');
  return {
    dir,
    indexMd,
    indexHtml,
    blocksJson,
    rawJson,
    relativeDir: toPosixPath(path.relative(root, dir)),
    relativeIndexMd: toPosixPath(path.relative(root, indexMd)),
    relativeIndexHtml: toPosixPath(path.relative(root, indexHtml)),
    relativeBlocksJson: toPosixPath(path.relative(root, blocksJson)),
    relativeRawJson: toPosixPath(path.relative(root, rawJson)),
  };
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function readJsonFile(filePath) {
  if (!filePath) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function readProofReceipt(proof, root) {
  const raw = String(proof || '').trim();
  if (!raw) return null;
  return readJsonFile(path.isAbsolute(raw) ? raw : path.join(root, raw));
}

function readMissionEvents(missionId, root) {
  const file = path.join(root, '.atris', 'state', 'mission_events.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((event) => event && event.mission_id === missionId)
    .sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')));
}

function firstEventTime(events, type, fallback = '') {
  return events.find((event) => event.type === type)?.at || fallback || null;
}

function oneLine(value, fallback = '') {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return fallback;
  return text.length > 220 ? `${text.slice(0, 217).replace(/\s+\S*$/, '')}...` : text;
}

function firstUsefulReceiptLine(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^[-*]\s*/, ''))
    .filter(Boolean)
    .filter((line) => !/^#+\s*(receipt|summary|result|final answer)\b/i.test(line))
    .find((line) => line.length > 8) || '';
}

function receiptWorkSummary(receipt) {
  const result = receipt?.result || {};
  const tick = result.tick || {};
  return oneLine(
    tick.summary
      || tick.atris2?.summary
      || tick.claude?.summary
      || firstUsefulReceiptLine(tick.atris2?.receipt_text)
      || firstUsefulReceiptLine(tick.claude?.receipt_text)
      || result.summary
      || '',
    'a proof receipt for this mission',
  );
}

function verifierSummary(mission, receipt) {
  const verifier = mission?.verifier_result || receipt?.result?.verifier_result || {};
  if (verifier.passed === true) {
    return {
      title: 'Verifier passed',
      body: `We checked it with ${oneLine(verifier.command || mission?.verifier || 'the configured verifier')}.`,
      meaning: 'The proof is not just a claim; it passed the recorded check.',
      status: 'done',
    };
  }
  if (mission?.completion_gate?.source === 'no_verifier') {
    return {
      title: 'Proof file saved',
      body: 'We saved the proof file for this completed mission.',
      meaning: 'This is ready for human inspection; repeat runs should save the same check command every time.',
      status: 'watch',
    };
  }
  return null;
}

function timelineItem(order, title, body, meaning, at = null, status = 'done') {
  return { order, title, body: oneLine(body), meaning: oneLine(meaning), at, status };
}

function buildTimeline(mission, { proof = '', proofReceipt = null, events = [], continuationGoal = null } = {}) {
  const items = [];
  items.push(timelineItem(
    1,
    'Mission started',
    `We named the outcome: ${mission.objective}.`,
    'This turned the ask into one durable mission Atris can keep running.',
    firstEventTime(events, 'mission_started', mission.created_at),
  ));

  if (mission.native_goal_ack?.objective) {
    items.push(timelineItem(
      items.length + 1,
      'Goal set',
      `We set the visible goal: ${mission.native_goal_ack.objective}.`,
      'The work in Codex now matches the mission the operator sees.',
      mission.native_goal_ack.acknowledged_at || firstEventTime(events, 'native_goal_acknowledged'),
    ));
  }

  if (mission.xp_task?.ref) {
    items.push(timelineItem(
      items.length + 1,
      'Task claimed',
      `We attached ${mission.xp_task.ref} to ${mission.owner}.`,
      'The work has a durable owner and a human review gate.',
      firstEventTime(events, 'mission_task_spine_attached'),
    ));
  }

  if (proof || proofReceipt) {
    items.push(timelineItem(
      items.length + 1,
      'Goal 1 done',
      `We produced ${receiptWorkSummary(proofReceipt)}.`,
      proof ? `The inspectable proof is ${proof}.` : 'The proof is stored in mission state.',
      proofReceipt?.at || mission.last_tick_at || null,
    ));
  }

  const verifier = verifierSummary(mission, proofReceipt);
  if (verifier) {
    items.push(timelineItem(
      items.length + 1,
      verifier.title,
      verifier.body,
      verifier.meaning,
      mission.verifier_result?.finished_at || proofReceipt?.at || null,
      verifier.status,
    ));
  }

  if (continuationGoal?.mission?.objective) {
    items.push(timelineItem(
      items.length + 1,
      'Next goal queued',
      `Atris queued the next mission: ${continuationGoal.mission.objective}.`,
      'The mission loop can keep compounding without hiding the completed proof.',
      continuationGoal.mission.created_at || null,
      'next',
    ));
  }

  items.push(timelineItem(
    items.length + 1,
    'Mission accomplished',
    `${mission.objective} is complete.`,
    'The operator can inspect the timeline, open the proof, then accept or revise.',
    mission.completed_at || firstEventTime(events, 'mission_completed'),
  ));

  return items;
}

function buildMissionArtifactBlocks(mission, options = {}) {
  const root = options.root || process.cwd();
  const proof = options.proof || mission.proof || mission.receipt_path || '';
  const proofReceipt = options.proofReceipt || readProofReceipt(proof, root);
  const events = options.events || readMissionEvents(mission.id, root);
  const paths = missionArtifactPaths(mission, root);
  const timeline = buildTimeline(mission, { proof, proofReceipt, events, continuationGoal: options.continuationGoal });
  const nextAction = mission.xp_task?.ref
    ? 'Review the timeline and proof, then human-accept the task if it matches what you wanted.'
    : 'Review the timeline and proof, then pick the next customer-facing move.';

  return {
    schema: 'atris.mission_artifact_blocks.v1',
    mission_id: mission.id,
    objective: mission.objective,
    owner: mission.owner || null,
    generated_at: stampIso(),
    artifact: {
      dir: paths.relativeDir,
      index_md: paths.relativeIndexMd,
      index_html: paths.relativeIndexHtml,
      blocks_json: paths.relativeBlocksJson,
      raw_json: paths.relativeRawJson,
    },
    landing: {
      changed: options.completion?.landing?.happened || `${mission.objective} is complete.`,
      proof: proof || null,
      artifact: paths.relativeIndexHtml,
      next: nextAction,
    },
    blocks: [
      {
        type: 'landing',
        title: 'Mission landing',
        changed: options.completion?.landing?.happened || `${mission.objective} is complete.`,
        checked: options.completion?.landing?.checked || '',
        proof: proof || '',
        artifact: paths.relativeIndexHtml,
      },
      {
        type: 'timeline',
        title: 'Timeline',
        items: timeline,
      },
      {
        type: 'proof',
        title: 'Proof',
        links: [
          { label: 'Timeline page', path: paths.relativeIndexHtml },
          { label: 'Markdown', path: paths.relativeIndexMd },
          { label: 'Blocks', path: paths.relativeBlocksJson },
          { label: 'Raw', path: paths.relativeRawJson },
          ...(proof ? [{ label: 'Machine receipt', path: proof }] : []),
        ],
      },
      {
        type: 'next_action',
        title: 'Next',
        body: nextAction,
      },
    ],
  };
}

function renderMarkdown(blocks) {
  const timeline = blocks.blocks.find((block) => block.type === 'timeline')?.items || [];
  const proof = blocks.blocks.find((block) => block.type === 'proof')?.links || [];
  const next = blocks.blocks.find((block) => block.type === 'next_action')?.body || blocks.landing.next;
  const lines = [
    '# Mission timeline',
    '',
    blocks.objective,
    '',
    'This is the human view. Raw JSON stays available, but the story comes first.',
    '',
    '## Timeline',
    '',
  ];
  for (const item of timeline) {
    lines.push(`${item.order}. **${item.title}**`);
    lines.push(`   ${item.body}`);
    lines.push(`   What it meant: ${item.meaning}`);
    if (item.at) lines.push(`   Time: ${item.at}`);
    lines.push('');
  }
  lines.push('## Proof', '');
  for (const link of proof) lines.push(`- ${link.label}: \`${link.path}\``);
  lines.push('', '## Next', '', next, '');
  return lines.join('\n');
}

function renderHtml(blocks) {
  const timeline = blocks.blocks.find((block) => block.type === 'timeline')?.items || [];
  const proof = blocks.blocks.find((block) => block.type === 'proof')?.links || [];
  const next = blocks.blocks.find((block) => block.type === 'next_action')?.body || blocks.landing.next;
  const rows = timeline.map((item) => `
        <li>
          <div class="step-number">${escapeHtml(item.order)}</div>
          <div class="step-body">
            <p class="step-title">${escapeHtml(item.title)}</p>
            <p>${escapeHtml(item.body)}</p>
            <p class="meaning">What it meant: ${escapeHtml(item.meaning)}</p>
            ${item.at ? `<p class="time">${escapeHtml(item.at)}</p>` : ''}
          </div>
        </li>`).join('');
  const proofRows = proof.map((link) => `<li><span>${escapeHtml(link.label)}</span><code>${escapeHtml(link.path)}</code></li>`).join('');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Mission timeline</title>
  <style>
    :root {
      --bone: oklch(96% 0.012 75);
      --bone-2: oklch(93% 0.014 72);
      --ink: oklch(22% 0.015 55);
      --ink-soft: oklch(35% 0.012 55);
      --ink-faint: oklch(55% 0.010 60);
      --clay: oklch(58% 0.13 45);
      --ochre: oklch(72% 0.09 75);
      --line: oklch(88% 0.010 70);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: radial-gradient(circle at 75% 0%, oklch(91% 0.035 72), transparent 32rem), var(--bone);
      color: var(--ink);
      font-family: "Hanken Grotesk", Avenir Next, sans-serif;
      line-height: 1.6;
    }
    main {
      width: min(1120px, calc(100% - clamp(2rem, 10vw, 10rem)));
      margin: 0 auto;
      padding: clamp(3rem, 7vw, 7rem) 0;
    }
    h1 {
      max-width: 12ch;
      margin: 0;
      font-family: Spectral, Georgia, serif;
      font-size: clamp(3rem, 8vw, 7rem);
      font-weight: 700;
      line-height: 0.95;
      letter-spacing: 0;
    }
    .objective {
      max-width: 52ch;
      margin: 1.25rem 0 0;
      color: var(--ink-soft);
      font-size: clamp(1.15rem, 1rem + 0.5vw, 1.45rem);
    }
    .timeline {
      list-style: none;
      margin: clamp(3rem, 7vw, 6rem) 0 0;
      padding: 0;
      border-top: 1px solid var(--line);
    }
    .timeline li {
      display: grid;
      grid-template-columns: 4rem minmax(0, 1fr);
      gap: clamp(1rem, 3vw, 3rem);
      padding: clamp(1.25rem, 3vw, 2.5rem) 0;
      border-bottom: 1px solid var(--line);
    }
    .step-number {
      width: 2.4rem;
      height: 2.4rem;
      display: grid;
      place-items: center;
      border: 1px solid color-mix(in oklch, var(--clay), var(--ink) 18%);
      border-radius: 999px;
      color: var(--clay);
      font-weight: 700;
      font-variant-numeric: tabular-nums;
    }
    .step-title {
      margin: 0 0 0.3rem;
      font-family: Spectral, Georgia, serif;
      font-size: clamp(1.45rem, 1.1rem + 1vw, 2.2rem);
      font-weight: 700;
      line-height: 1.15;
    }
    p { margin: 0.35rem 0 0; }
    .meaning { color: var(--ink-soft); }
    .time {
      color: var(--ink-faint);
      font-family: "JetBrains Mono", monospace;
      font-size: 0.85rem;
    }
    .proof {
      margin-top: clamp(3rem, 7vw, 6rem);
      padding-top: 1.5rem;
      border-top: 2px solid var(--ink);
    }
    h2 {
      margin: 0 0 1rem;
      font-family: Spectral, Georgia, serif;
      font-size: clamp(1.8rem, 1.2rem + 2vw, 3rem);
      line-height: 1.1;
    }
    .proof ul { list-style: none; margin: 0; padding: 0; }
    .proof li {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 1rem;
      padding: 0.7rem 0;
      border-bottom: 1px solid var(--line);
    }
    code {
      color: var(--clay);
      font-family: "JetBrains Mono", monospace;
      font-size: 0.9rem;
      word-break: break-word;
    }
    .next {
      max-width: 52ch;
      margin-top: clamp(2rem, 5vw, 4rem);
      color: var(--ink-soft);
      font-size: 1.1rem;
    }
    @media (max-width: 680px) {
      main { width: min(100% - 2rem, 1120px); padding: 2.5rem 0; }
      .timeline li { grid-template-columns: 1fr; gap: 0.75rem; }
      .proof li { display: block; }
      .proof code { display: block; margin-top: 0.25rem; }
    }
  </style>
</head>
<body>
  <main>
    <h1>Mission timeline</h1>
    <p class="objective">${escapeHtml(blocks.objective)}</p>
    <ol class="timeline">${rows}
    </ol>
    <section class="proof">
      <h2>Proof</h2>
      <ul>${proofRows}</ul>
    </section>
    <p class="next">${escapeHtml(next)}</p>
  </main>
</body>
</html>
`;
}

function writeMissionArtifact(mission, options = {}) {
  const root = options.root || process.cwd();
  const paths = missionArtifactPaths(mission, root);
  const proof = options.proof || mission.proof || mission.receipt_path || '';
  const proofReceipt = options.proofReceipt || readProofReceipt(proof, root);
  const events = options.events || readMissionEvents(mission.id, root);
  const blocks = buildMissionArtifactBlocks(mission, {
    ...options,
    root,
    proof,
    proofReceipt,
    events,
  });
  const raw = {
    schema: 'atris.mission_artifact_raw.v1',
    generated_at: blocks.generated_at,
    mission,
    completion: options.completion || null,
    proof,
    proof_receipt: proofReceipt,
    events,
    continuation_goal: options.continuationGoal || null,
  };
  fs.mkdirSync(paths.dir, { recursive: true });
  fs.writeFileSync(paths.indexMd, renderMarkdown(blocks), 'utf8');
  fs.writeFileSync(paths.indexHtml, renderHtml(blocks), 'utf8');
  fs.writeFileSync(paths.blocksJson, JSON.stringify(blocks, null, 2) + '\n', 'utf8');
  fs.writeFileSync(paths.rawJson, JSON.stringify(raw, null, 2) + '\n', 'utf8');
  return {
    dir: paths.relativeDir,
    index_md: paths.relativeIndexMd,
    index_html: paths.relativeIndexHtml,
    blocks_json: paths.relativeBlocksJson,
    raw_json: paths.relativeRawJson,
    timeline_count: blocks.blocks.find((block) => block.type === 'timeline')?.items?.length || 0,
  };
}

module.exports = {
  buildMissionArtifactBlocks,
  missionArtifactPaths,
  writeMissionArtifact,
};
