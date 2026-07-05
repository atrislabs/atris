// atris write — guided writing sessions (plan-do-review for prose).
//
// The contract: the human types every word of the draft. Atris structures the
// session (outline beats with states), tracks progress against the plan, and
// reviews against the taste gate (writing policy + slop detector). It NEVER
// writes or rewrites prose — review output is suggestions, not edits.
//
// Session = a folder of plain markdown, so the same files open in the web and
// desktop editors with no extra format:
//   atris/writing/<slug>/plan.md    outline beats: [ ] empty, [~] drafted, [x] passed
//   atris/writing/<slug>/draft.md   the piece — human-only territory
//
// Usage:
//   atris write start "<topic>" [--dump "raw ideas"] [--beats "a | b | c"]
//   atris write status [slug]     progress: which beats are landed
//   atris write review [slug]     taste gate: policy checklist + slop scan (read-only)
//   atris write pass <n> [slug]   mark beat n passed (human calls it, not the AI)
//   atris write list              list sessions
//
// Zero external deps (Node built-ins only) — repo contract.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { scanFile, RULES, loadProjectRules } = require('./slop');

const WRITING_DIR = path.join('atris', 'writing');
const DEFAULT_BEATS = ['Hook', 'Thesis', 'Evidence', 'Counterpunch', 'Landing'];
const STATE_ICON = { ' ': '·', '~': '◐', x: '●' };
const STATE_WORD = { ' ': 'empty', '~': 'drafted', x: 'passed' };

function slugify(topic) {
  return topic.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'untitled';
}

function sessionDir(slug, root = process.cwd()) {
  return path.join(root, WRITING_DIR, slug);
}

function listSessions(root = process.cwd()) {
  const dir = path.join(root, WRITING_DIR);
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names
    .filter((n) => fs.existsSync(path.join(dir, n, 'plan.md')))
    .map((n) => ({ slug: n, mtime: fs.statSync(path.join(dir, n, 'plan.md')).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
}

function resolveSlug(maybeSlug, root = process.cwd()) {
  if (maybeSlug && fs.existsSync(path.join(sessionDir(maybeSlug, root), 'plan.md'))) return maybeSlug;
  if (maybeSlug) return null;
  const sessions = listSessions(root);
  return sessions.length ? sessions[0].slug : null;
}

// Parse plan.md → { topic, beats: [{ n, state, title }] }
function readPlan(slug, root = process.cwd()) {
  const text = fs.readFileSync(path.join(sessionDir(slug, root), 'plan.md'), 'utf8');
  const topic = (text.match(/^# plan: (.+)$/m) || [, slug])[1];
  const beats = [];
  const re = /^- \[([ ~x])\] (\d+)\. (.+)$/gm;
  let m;
  while ((m = re.exec(text)) !== null) beats.push({ state: m[1], n: +m[2], title: m[3].trim() });
  return { topic, beats, text };
}

function writePlanStates(slug, beats, root = process.cwd()) {
  const file = path.join(sessionDir(slug, root), 'plan.md');
  let text = fs.readFileSync(file, 'utf8');
  for (const b of beats) {
    text = text.replace(new RegExp(`^- \\[[ ~x]\\] ${b.n}\\. `, 'm'), `- [${b.state}] ${b.n}. `);
  }
  fs.writeFileSync(file, text);
}

// Words the human has typed under each `## beat` heading in draft.md.
function draftWordCounts(slug, beats, root = process.cwd()) {
  let text = '';
  try { text = fs.readFileSync(path.join(sessionDir(slug, root), 'draft.md'), 'utf8'); } catch {}
  const lines = text.split('\n');
  const counts = new Map(beats.map((b) => [b.n, 0]));
  let current = null;
  for (const line of lines) {
    const h = line.match(/^## (.+)$/);
    if (h) {
      const beat = beats.find((b) => h[1].trim().toLowerCase() === b.title.toLowerCase());
      current = beat ? beat.n : null;
      continue;
    }
    if (current !== null) {
      const words = line.trim().split(/\s+/).filter(Boolean).length;
      counts.set(current, counts.get(current) + words);
    }
  }
  return counts;
}

// Sync beat states from the draft: empty→drafted when words land. Never downgrades passed.
function syncStates(slug, root = process.cwd()) {
  const plan = readPlan(slug, root);
  const counts = draftWordCounts(slug, plan.beats, root);
  let changed = false;
  for (const b of plan.beats) {
    const words = counts.get(b.n) || 0;
    if (b.state === ' ' && words > 0) { b.state = '~'; changed = true; }
    if (b.state === '~' && words === 0) { b.state = ' '; changed = true; }
  }
  if (changed) writePlanStates(slug, plan.beats, root);
  return { ...plan, counts };
}

function start(argv, root = process.cwd()) {
  const topic = argv.find((a) => !a.startsWith('-'));
  if (!topic) { console.error('  usage: atris write start "<topic>" [--dump "..."] [--beats "a | b | c"]'); return 2; }
  const flag = (name) => { const i = argv.indexOf(name); return i !== -1 ? argv[i + 1] : null; };
  const dump = flag('--dump');
  const beatsArg = flag('--beats');
  const beats = beatsArg ? beatsArg.split('|').map((s) => s.trim()).filter(Boolean) : DEFAULT_BEATS;

  const slug = slugify(topic);
  const dir = sessionDir(slug, root);
  if (fs.existsSync(path.join(dir, 'plan.md'))) { console.error(`  session already exists: ${slug} (atris write status ${slug})`); return 2; }
  fs.mkdirSync(dir, { recursive: true });

  const dumpLines = dump ? dump.split(/\n|(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean).map((s) => `- ${s}`) : ['- (dump raw ideas here)'];
  const plan = [
    `# plan: ${topic}`, '',
    '## Dump', ...dumpLines, '',
    '## Outline',
    ...beats.map((b, i) => `- [ ] ${i + 1}. ${b}`), '',
    '## Gate',
    '- review: atris write review runs the taste checklist + slop scan',
    '- pass: you call `atris write pass <n>` when a beat holds up — the AI never calls it', '',
  ].join('\n');
  const draft = [`# ${topic}`, '', ...beats.flatMap((b) => [`## ${b}`, '']), ''].join('\n');

  fs.writeFileSync(path.join(dir, 'plan.md'), plan);
  fs.writeFileSync(path.join(dir, 'draft.md'), draft);

  console.log(`\n  ✓ session started: ${slug}`);
  console.log(`    plan:  ${path.relative(root, path.join(dir, 'plan.md'))}`);
  console.log(`    draft: ${path.relative(root, path.join(dir, 'draft.md'))}  ← you write here, every word`);
  console.log(`\n  beats: ${beats.join(' → ')}`);
  console.log(`  next: open the draft, land a beat, then \`atris write status\`\n`);
  return 0;
}

function status(argv, root = process.cwd()) {
  const slug = resolveSlug(argv.find((a) => !a.startsWith('-')), root);
  if (!slug) { console.error('  no writing session found. start one: atris write start "<topic>"'); return 2; }
  const { topic, beats, counts } = syncStates(slug, root);
  const done = beats.filter((b) => b.state === 'x').length;
  const drafted = beats.filter((b) => b.state === '~').length;
  const totalWords = [...counts.values()].reduce((a, b) => a + b, 0);

  console.log(`\n  ${topic}  (${slug})`);
  console.log(`  ${beats.map((b) => STATE_ICON[b.state]).join(' ')}   ${done} passed · ${drafted} drafted · ${totalWords} words\n`);
  for (const b of beats) {
    const words = counts.get(b.n) || 0;
    console.log(`  ${STATE_ICON[b.state]} ${String(b.n).padStart(2)}. ${b.title.padEnd(24)} ${STATE_WORD[b.state].padEnd(8)} ${words ? `${words} words` : ''}`);
  }
  const next = beats.find((b) => b.state === ' ') || beats.find((b) => b.state === '~');
  if (next) console.log(`\n  next: ${next.state === ' ' ? 'write' : 'review'} "${next.title}"${next.state === '~' ? ` — then \`atris write pass ${next.n}\` if it holds` : ''}\n`);
  else console.log(`\n  all beats passed. run \`atris write review\` for the final gate.\n`);
  return 0;
}

function review(argv, root = process.cwd()) {
  const json = argv.includes('--json');
  const slug = resolveSlug(argv.find((a) => !a.startsWith('-')), root);
  if (!slug) { console.error('  no writing session found. start one: atris write start "<topic>"'); return 2; }
  const { topic, beats, counts } = syncStates(slug, root);
  const draftPath = path.join(sessionDir(slug, root), 'draft.md');
  const findings = scanFile(draftPath, RULES.concat(loadProjectRules(root)));
  const empty = beats.filter((b) => (counts.get(b.n) || 0) === 0);

  if (json) {
    console.log(JSON.stringify({
      slug, topic, ok: findings.length === 0 && empty.length === 0,
      beats: beats.map((b) => ({ n: b.n, title: b.title, state: STATE_WORD[b.state], words: counts.get(b.n) || 0 })),
      slop: findings.map((f) => ({ line: f.line, rule: f.rule, why: f.why, snippet: f.snippet })),
    }, null, 2));
    return findings.length || empty.length ? 1 : 0;
  }

  console.log(`\n  review: ${topic}\n`);
  if (empty.length) {
    console.log(`  ⚠ ${empty.length} beat${empty.length === 1 ? '' : 's'} still empty: ${empty.map((b) => b.title).join(', ')}`);
  }
  if (findings.length) {
    console.log(`\n  slop tells (fix them yourself — atris never edits your draft):`);
    for (const f of findings) console.log(`  ✗ draft.md:${f.line}  ${f.rule.padEnd(16)} ${f.why}`);
  } else {
    console.log(`  ✓ slop scan clean`);
  }
  console.log(`\n  human passes (atris/policies/writing.md):`);
  console.log(`  - read it out loud: mark stumbles, boredom, and the parts you speed up`);
  console.log(`  - voice check: would someone recognize this as yours, blind?`);
  console.log(`  - one-sentence test: can you state the core insight in one line?`);
  console.log(`  - would you send it to someone you respect?`);
  console.log(`\n  when a beat holds up: atris write pass <n>\n`);
  return findings.length || empty.length ? 1 : 0;
}

function pass(argv, root = process.cwd()) {
  const n = parseInt(argv[0], 10);
  if (!n) { console.error('  usage: atris write pass <beat-number> [slug]'); return 2; }
  const slug = resolveSlug(argv[1], root);
  if (!slug) { console.error('  no writing session found.'); return 2; }
  const plan = readPlan(slug, root);
  const beat = plan.beats.find((b) => b.n === n);
  if (!beat) { console.error(`  no beat ${n} in ${slug}`); return 2; }
  const counts = draftWordCounts(slug, plan.beats, root);
  if ((counts.get(n) || 0) === 0) { console.error(`  beat ${n} "${beat.title}" has no words yet — write it first`); return 2; }
  beat.state = 'x';
  writePlanStates(slug, plan.beats, root);
  console.log(`  ● passed: ${n}. ${beat.title}`);
  return 0;
}

function list(root = process.cwd()) {
  const sessions = listSessions(root);
  if (!sessions.length) { console.log('\n  no writing sessions yet. start one: atris write start "<topic>"\n'); return 0; }
  console.log('');
  for (const s of sessions) {
    const { topic, beats } = readPlan(s.slug, root);
    console.log(`  ${beats.map((b) => STATE_ICON[b.state]).join('')}  ${s.slug.padEnd(32)} ${topic}`);
  }
  console.log('');
  return 0;
}

// ---- coach: intelligent, proactive, gets the writer going. Never writes prose. ----

// Deterministic question bank: the offline coach. One pointed question beats a blank page.
const BEAT_QUESTIONS = {
  hook: 'What is the moment this became a problem for you? Start there, in one sentence.',
  thesis: 'Say your point out loud in one sentence, like you are telling a friend. Type exactly that.',
  evidence: 'What did you actually see happen? Name the specific thing, not the category.',
  counterpunch: 'What would a smart skeptic say back? Steelman it, then answer in your own words.',
  landing: 'What should the reader do or believe differently now? Say it plainly and stop.',
};
const GENERIC_QUESTION = (title) => `What is the one thing "${title}" has to say for the piece to work? Answer in your own words.`;

function dumpSeeds(planText) {
  const m = planText.match(/## Dump\n([\s\S]*?)(\n## |$)/);
  if (!m) return [];
  return m[1].split('\n').map((l) => l.replace(/^- /, '').trim()).filter((l) => l && !l.startsWith('(dump'));
}

function coachLogPath(slug, root) { return path.join(sessionDir(slug, root), 'coach.md'); }

function appendCoachNote(slug, note, root = process.cwd()) {
  const file = coachLogPath(slug, root);
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const header = fs.existsSync(file) ? '' : `# coach log\n\nStyle lessons and session notes. This is the training data for your voice.\n`;
  fs.appendFileSync(file, `${header}\n## ${stamp}\n${note.trim()}\n`);
}

function claudeAvailable() {
  try { return spawnSync('claude', ['--version'], { timeout: 8000 }).status === 0; } catch { return false; }
}

function coachPrompt({ topic, beats, counts, findings, planText, draftText, currentBeat }) {
  return [
    'You are a writing coach inside atris write. HARD RULES:',
    '- You NEVER write, rewrite, or suggest replacement prose for the draft. Not one sentence.',
    '- You coach: point at what the writer did well IN THEIR OWN WORDS, ask one question, teach one style lesson.',
    '- Be warm and direct. No em dashes. No hype words. Sentence case. Under 140 words total.',
    '',
    'Output EXACTLY these three sections:',
    'CHEER: quote the writer\'s single best sentence from the draft verbatim and say specifically why it works. If the draft is empty, cheer the strongest dump line instead.',
    `QUESTION: one pointed question to get the next words out for the beat "${currentBeat}". A question they answer in their own voice.`,
    'LESSON: one concrete, reusable style observation about THIS writer (pattern you see in their words, good or fixable). One sentence.',
    '',
    `Topic: ${topic}`,
    `Beats: ${beats.map((b) => `${b.title}(${STATE_WORD[b.state]},${counts.get(b.n) || 0}w)`).join(' ')}`,
    findings.length ? `Slop findings: ${findings.map((f) => `${f.rule}@${f.line}`).join(', ')}` : 'Slop scan: clean',
    '',
    '--- plan.md ---', planText,
    '--- draft.md ---', draftText || '(empty)',
  ].join('\n');
}

function coach(argv, root = process.cwd()) {
  const offline = argv.includes('--offline');
  const slug = resolveSlug(argv.find((a) => !a.startsWith('-')), root);
  if (!slug) { console.error('  no writing session found. start one: atris write start "<topic>"'); return 2; }
  const { topic, beats, counts, text: planText } = syncStates(slug, root);
  const draftFile = path.join(sessionDir(slug, root), 'draft.md');
  let draftText = ''; try { draftText = fs.readFileSync(draftFile, 'utf8'); } catch {}
  const findings = scanFile(draftFile, RULES.concat(loadProjectRules(root)));
  const current = beats.find((b) => b.state === ' ') || beats.find((b) => b.state === '~') || beats[beats.length - 1];
  const done = beats.filter((b) => b.state === 'x').length;
  const totalWords = [...counts.values()].reduce((a, b) => a + b, 0);

  console.log(`\n  coach · ${topic}`);
  console.log(`  ${beats.map((b) => STATE_ICON[b.state]).join(' ')}   ${totalWords} words in, ${done}/${beats.length} beats passed\n`);

  if (!offline && claudeAvailable()) {
    const prompt = coachPrompt({ topic, beats, counts, findings, planText, draftText, currentBeat: current.title });
    const res = spawnSync('claude', ['-p', prompt], { encoding: 'utf8', timeout: 120000, maxBuffer: 1024 * 1024 });
    const out = (res.stdout || '').trim();
    if (res.status === 0 && /QUESTION:/.test(out)) {
      console.log(out.split('\n').map((l) => `  ${l}`).join('\n'));
      const lesson = (out.match(/LESSON:\s*([\s\S]*?)$/m) || [])[1];
      if (lesson) appendCoachNote(slug, `- lesson: ${lesson.trim()}`, root);
      console.log(`\n  your move: answer under "## ${current.title}" in draft.md, then \`atris write status\`\n`);
      return 0;
    }
    console.log('  (claude coach unavailable, falling back to the offline coach)\n');
  }

  // Offline coach: still proactive, still gets you going. Seeds + one question.
  const seeds = dumpSeeds(planText);
  if (totalWords > 0) {
    console.log(`  you have ${totalWords} words down. that is a draft in motion, keep it moving.`);
  } else if (seeds.length) {
    console.log('  your raw material (pick the line with the most heat and start there):');
    for (const s of seeds.slice(0, 4)) console.log(`    · ${s}`);
  }
  const q = BEAT_QUESTIONS[current.title.toLowerCase()] || GENERIC_QUESTION(current.title);
  console.log(`\n  next beat: ${current.title}`);
  console.log(`  question: ${q}`);
  if (findings.length) console.log(`\n  while you are in there: ${findings.length} slop tell${findings.length === 1 ? '' : 's'} to fix in your own words (atris write review for the list)`);
  console.log(`\n  your move: answer under "## ${current.title}" in draft.md, then \`atris write status\`\n`);
  return 0;
}

function help() {
  console.log(`
  atris write — guided writing sessions (you write every word; atris structures + reviews)

    atris write start "<topic>" [--dump "..."] [--beats "a | b | c"]
    atris write coach [slug]      the coach: cheers your best line, asks the next question (--offline for no-LLM)
    atris write status [slug]     progress against the outline (beats landed)
    atris write review [slug]     taste gate: slop scan + writing-policy passes (read-only)
    atris write pass <n> [slug]   mark beat n passed — the human calls it
    atris write list              all sessions

  sessions are plain markdown in atris/writing/<slug>/ — the same files open
  in the web and desktop editors. atris never writes or edits your draft.
`);
  return 0;
}

function writeCommand(argv) {
  const sub = argv[0];
  if (sub === 'start') return start(argv.slice(1));
  if (sub === 'coach' || sub === 'kick') return coach(argv.slice(1));
  if (sub === 'status') return status(argv.slice(1));
  if (sub === 'review') return review(argv.slice(1));
  if (sub === 'pass') return pass(argv.slice(1));
  if (sub === 'list') return list();
  if (!sub) return listSessions().length ? status([]) : help();
  if (sub === 'help' || sub.startsWith('-')) return help();
  // `atris write "some topic"` sugar → start
  return start(argv);
}

module.exports = { writeCommand, start, status, review, pass, coach, dumpSeeds, listSessions, readPlan, draftWordCounts, syncStates, slugify };
