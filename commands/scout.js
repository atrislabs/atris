// atris scout — dispatch cheap Haiku subagents for search/context questions.
// Mirrors Claude Code's built-in subagent pattern: read-only, bounded report,
// main session never pays for the exploration.
//
//   atris scout "where is credit deduction wired?"
//   atris scout "q1" "q2" "q3"          # parallel scouts
//   atris scout --dir ../atrisos-web "where is the proxy middleware?"
//   atris scout --model sonnet "..."     # judgment call, not a lookup

const { spawn } = require('child_process');
const path = require('path');

const READ_ONLY_TOOLS = [
  'Read', 'Glob', 'Grep',
  'Bash(ls:*)', 'Bash(cat:*)', 'Bash(head:*)', 'Bash(tail:*)',
  'Bash(rg:*)', 'Bash(find:*)', 'Bash(git log:*)', 'Bash(git show:*)',
  'Bash(atris status:*)', 'Bash(atris task list:*)', 'Bash(atris mission status:*)',
].join(',');

const MODELS = { haiku: 'haiku', sonnet: 'sonnet', opus: 'opus' };

function scoutPrompt(question, dir) {
  return [
    `You are a read-only scout in ${dir}. You NEVER write, edit, or run mutating commands.`,
    `Search order: index files first (atris/MAP.md, atris/TODO.md, README) via targeted reads, then grep. Cheap reads only.`,
    ``,
    `Question: ${question}`,
    ``,
    `Answer in at most 30 lines. Lead with the answer, cite file:line for every claim, list what you did NOT check.`,
  ].join('\n');
}

function runScout(question, { dir, model, timeoutMs }) {
  return new Promise((resolve) => {
    const child = spawn('claude', [
      '-p', scoutPrompt(question, dir),
      '--model', model,
      '--allowedTools', READ_ONLY_TOOLS,
    ], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });

    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ question, ok: false, text: `timed out after ${timeoutMs / 1000}s` });
    }, timeoutMs);

    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ question, ok: false, text: `failed to spawn claude: ${e.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && out.trim()) resolve({ question, ok: true, text: out.trim() });
      else resolve({ question, ok: false, text: (err.trim() || out.trim() || `exit ${code}`) });
    });
  });
}

async function scoutCommand(argv) {
  const args = [...argv];
  const questions = [];
  let dir = process.cwd();
  let model = MODELS.haiku;
  let timeoutMs = 180000;

  while (args.length) {
    const a = args.shift();
    if (a === '--dir') dir = path.resolve(args.shift() || '.');
    else if (a === '--model') model = MODELS[args.shift()] || MODELS.haiku;
    else if (a === '--timeout') timeoutMs = (parseInt(args.shift(), 10) || 180) * 1000;
    else if (a === '--help' || a === '-h') { showHelp(); return 0; }
    else questions.push(a);
  }

  if (!questions.length) { showHelp(); return 1; }

  console.log(`\n  scouting with ${questions.length} ${model} agent${questions.length > 1 ? 's' : ''} in ${dir}\n`);
  const started = Date.now();
  const results = await Promise.all(questions.map((q) => runScout(q, { dir, model, timeoutMs })));

  for (const r of results) {
    console.log(`  ── ${r.ok ? '✓' : '✗'} ${r.question}`);
    console.log(r.text.split('\n').map((l) => `     ${l}`).join('\n'));
    console.log('');
  }
  console.log(`  done in ${Math.round((Date.now() - started) / 1000)}s\n`);
  return results.every((r) => r.ok) ? 0 : 1;
}

function showHelp() {
  console.log(`
  atris scout — cheap read-only subagents for search & context questions

  usage:
    atris scout "<question>" ["<question>" ...]     parallel scouts, one per question
    atris scout --dir <path> "<question>"           scout a different repo
    atris scout --model sonnet "<question>"         upgrade the model (default: haiku)
    atris scout --timeout 300 "<question>"          seconds per scout (default: 180)

  scouts are read-only: they can read files, grep, and run safe atris/git
  read commands. they answer in ≤30 lines with file:line citations.
`);
}

module.exports = { scoutCommand };
