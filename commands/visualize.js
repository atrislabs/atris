const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { getLogPath } = require('../lib/journal');
const { ensureValidCredentials } = require('../utils/auth');
const { apiRequestJson } = require('../utils/api');
const { loadConfig } = require('../utils/config');

const DEFAULT_MODEL = 'gpt-image-2';
const DEFAULT_SIZE = '1536x1024';
const DEFAULT_QUALITY = 'high';

function legacyVisualizeInbox() {
  const { logFile } = getLogPath();

  if (!fs.existsSync(logFile)) {
    console.log('✗ No journal entry for today. Run "atris log" to create one.');
    process.exit(1);
  }

  const logContent = fs.readFileSync(logFile, 'utf8');
  const inboxMatch = logContent.match(/## Inbox\n([\s\S]*?)(?=\n##|$)/);
  if (!inboxMatch || !inboxMatch[1].trim()) {
    console.log('✗ No items in Inbox. Add ideas to your journal first.');
    process.exit(1);
  }

  const inboxItems = inboxMatch[1]
    .trim()
    .split('\n')
    .filter(line => line.match(/^- \*\*I\d+:/))
    .map(line => {
      const match = line.match(/^- \*\*I\d+:\s+(.+)$|^- \*\*I\d+:\*\*\s*(.+)$/);
      return match ? (match[1] || match[2]) : line;
    });

  if (inboxItems.length === 0) {
    console.log('✗ No formatted inbox items. Use format: - **I#: Description**');
    process.exit(1);
  }

  console.log('');
  console.log('┌─────────────────────────────────────────────────────────────┐');
  console.log('│ Atris Visualize — Break Down & Approval Gate                │');
  console.log('└─────────────────────────────────────────────────────────────┘');
  console.log('');

  inboxItems.forEach((item, idx) => {
    console.log(`\n📌 Idea ${idx + 1}: ${item}`);
    console.log('─────────────────────────────────────────');
    console.log('AGENT PROMPT TEMPLATE:\n');
    console.log('1. Break this idea into 3-4 concrete steps.');
    console.log('2. Create ASCII diagram showing flow/structure.');
    console.log('3. Get user approval before creating task.\n');
    console.log('EXAMPLE ASCII (for UI ideas):');
    console.log('```');
    console.log('  Journal Entry');
    console.log('       ↓');
    console.log('  Extract Ideas');
    console.log('       ↓');
    console.log('  Visualize Plan');
    console.log('       ↓');
    console.log('  User Approval');
    console.log('       ↓');
    console.log('  Create Task');
    console.log('```\n');
  });

  console.log('─────────────────────────────────────────');
  console.log('✓ Ready to pass to agents with approval gate enabled.');
  console.log('');
}

function parseVisualizeArgs(args = []) {
  const options = {
    model: DEFAULT_MODEL,
    size: DEFAULT_SIZE,
    quality: DEFAULT_QUALITY,
    outputFormat: 'png',
    dryRun: false,
    open: false,
    timeoutMs: 180000,
  };
  const promptParts = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') {
      promptParts.push(...args.slice(i + 1));
      break;
    }
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--open') options.open = true;
    else if (arg === '--no-open') options.open = false;
    else if (arg === '--raw') options.raw = true;
    else if (arg === '--agent' && args[i + 1]) options.agentId = args[++i];
    else if (arg.startsWith('--agent=')) options.agentId = arg.slice('--agent='.length);
    else if (arg === '--model' && args[i + 1]) options.model = args[++i];
    else if (arg.startsWith('--model=')) options.model = arg.slice('--model='.length);
    else if (arg === '--size' && args[i + 1]) options.size = args[++i];
    else if (arg.startsWith('--size=')) options.size = arg.slice('--size='.length);
    else if (arg === '--quality' && args[i + 1]) options.quality = args[++i];
    else if (arg.startsWith('--quality=')) options.quality = arg.slice('--quality='.length);
    else if (arg === '--out' && args[i + 1]) options.out = args[++i];
    else if (arg.startsWith('--out=')) options.out = arg.slice('--out='.length);
    else if (arg === '--timeout' && args[i + 1]) options.timeoutMs = Number(args[++i]) * 1000;
    else if (arg.startsWith('--timeout=')) options.timeoutMs = Number(arg.slice('--timeout='.length)) * 1000;
    else if (arg === '--format' && args[i + 1]) options.outputFormat = args[++i];
    else if (arg.startsWith('--format=')) options.outputFormat = arg.slice('--format='.length);
    else promptParts.push(arg);
  }

  return { prompt: promptParts.join(' ').trim(), options };
}

function showVisualizeHelp() {
  console.log('');
  console.log('Usage: atris visualize <prompt> [options]');
  console.log('');
  console.log('Generate a Slack/deck-ready business visual from workspace context.');
  console.log('');
  console.log('Options:');
  console.log('  --model <name>     Image model (default: gpt-image-2)');
  console.log('  --size <WxH>       Output size (default: 1536x1024)');
  console.log('  --quality <level>  Quality (default: high)');
  console.log('  --out <path>       Save path (default: atris/reports/visuals/<slug>.png)');
  console.log('  --agent <id>       Agent id for backend image endpoint');
  console.log('  --dry-run          Print generated prompt without calling the backend');
  console.log('  --open             Open the saved PNG after generation');
  console.log('  --raw              Send your prompt as-is, without workspace prompt shaping');
  console.log('');
  console.log('No prompt keeps the legacy inbox visualization helper.');
  console.log('');
}

function readTextIfExists(filePath, maxChars) {
  try {
    if (!fs.existsSync(filePath)) return '';
    return fs.readFileSync(filePath, 'utf8').slice(0, maxChars);
  } catch {
    return '';
  }
}

function readBusinessMeta(cwd = process.cwd()) {
  const businessPath = path.join(cwd, '.atris', 'business.json');
  try {
    if (!fs.existsSync(businessPath)) return {};
    return JSON.parse(fs.readFileSync(businessPath, 'utf8'));
  } catch {
    return {};
  }
}

function findRelevantContextFiles(cwd, prompt) {
  const roots = [
    path.join(cwd, 'atris', 'context'),
    path.join(cwd, 'atris', 'wiki'),
  ];
  const words = new Set(
    prompt.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 4)
  );
  const files = [];

  function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.md')) files.push(full);
    }
  }

  roots.forEach(walk);
  return files
    .map(file => {
      const rel = path.relative(cwd, file);
      const haystack = rel.toLowerCase();
      let score = 0;
      for (const word of words) {
        if (haystack.includes(word)) score += 3;
      }
      const body = readTextIfExists(file, 1200).toLowerCase();
      for (const word of words) {
        if (body.includes(word)) score += 1;
      }
      return { file, rel, score };
    })
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 4);
}

function collectWorkspaceContext(prompt, cwd = process.cwd()) {
  const business = readBusinessMeta(cwd);
  const chunks = [];
  if (business.name || business.slug) {
    chunks.push(`Workspace: ${business.name || business.slug} (${business.slug || 'no-slug'})`);
  }

  const mapSnippet = readTextIfExists(path.join(cwd, 'atris', 'MAP.md'), 1400);
  if (mapSnippet) chunks.push(`MAP excerpt:\n${mapSnippet}`);

  const todoSnippet = readTextIfExists(path.join(cwd, 'atris', 'TODO.md'), 1000);
  if (todoSnippet) chunks.push(`TODO excerpt:\n${todoSnippet}`);

  const relevant = findRelevantContextFiles(cwd, prompt);
  for (const item of relevant) {
    chunks.push(`${item.rel}:\n${readTextIfExists(item.file, 900)}`);
  }

  return chunks.join('\n\n---\n\n').slice(0, 6000);
}

function classifyArtifact(prompt) {
  const p = prompt.toLowerCase();
  if (/security|compliance|soc2|soc 2|questionnaire|risk|posture/.test(p)) return 'security posture';
  if (/wbr|weekly|metric|metrics|revenue|p&l|pnl|forecast|dashboard/.test(p)) return 'metric story';
  if (/onboard|setup|connect|workflow|process|flow|steps|how to/.test(p)) return 'workflow';
  if (/architecture|system|infra|stack|api|database|service/.test(p)) return 'architecture';
  if (/compare|comparison|versus|\bvs\b|tradeoff/.test(p)) return 'comparison';
  if (/status|update|recap|progress|roadmap/.test(p)) return 'status update';
  return 'business explainer';
}

function slugify(input) {
  return String(input || 'visual')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 54) || 'visual';
}

function defaultOutputPath(prompt, cwd = process.cwd()) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const visualsDir = fs.existsSync(path.join(cwd, 'atris'))
    ? path.join(cwd, 'atris', 'reports', 'visuals')
    : path.join(cwd, 'visuals');
  return path.join(visualsDir, `${slugify(prompt)}-${stamp}.png`);
}

function resolveOutputPath(out, prompt, cwd = process.cwd()) {
  if (!out) return defaultOutputPath(prompt, cwd);
  return path.isAbsolute(out) ? out : path.join(cwd, out);
}

function buildImagePrompt(userPrompt, options = {}, cwd = process.cwd()) {
  if (options.raw) return userPrompt;

  const artifactType = classifyArtifact(userPrompt);
  const context = collectWorkspaceContext(userPrompt, cwd);
  const contextBlock = context ? `\nWorkspace context to respect:\n${context}\n` : '';

  return `Use case: productivity-visual
Asset type: Slack-shareable and deck-ready business artifact
Artifact type: ${artifactType}
Primary request: ${userPrompt}
${contextBlock}
Design requirements:
- Create a polished, modern SaaS-style visual on a clean light background.
- Use business-appropriate typography, generous spacing, and a restrained palette.
- Make the visual useful at Slack preview size: large labels, short text, no tiny paragraphs.
- Prefer a clear structure: flow, comparison, architecture diagram, metric story, or status map depending on the request.
- If rendering text, keep it concise and accurate; do not invent unsupported names, numbers, claims, or logos.
- Do not use real third-party logos unless the user explicitly asks.
- Avoid decorative stock-art scenes. The output should feel like a usable work artifact.
- Include enough visual hierarchy that a busy operator can understand it in 5 seconds.
`;
}

async function resolveAgentId(token, explicitAgentId) {
  if (explicitAgentId) return { id: explicitAgentId, label: explicitAgentId };

  const agentsResult = await apiRequestJson('/agent/my-agents', { method: 'GET', token });
  const agents = agentsResult.data?.my_agents || agentsResult.data?.agents || [];
  const activeAgents = agents.filter(agent => agent.status !== 'inactive' && agent.id);
  const agentById = new Map(activeAgents.map(agent => [agent.id, agent]));
  const fromAccessible = (agentId, fallbackLabel) => {
    if (!agentId || !agentById.has(agentId)) return null;
    const agent = agentById.get(agentId);
    return { id: agent.id, label: agent.name || fallbackLabel || agent.id };
  };

  const config = loadConfig();
  const configAgent = fromAccessible(config.agent_id, config.agent_name);
  if (configAgent) return configAgent;

  const business = readBusinessMeta();
  const localBusinessAgent = fromAccessible(business.agent_id, business.agent_name);
  if (localBusinessAgent) return localBusinessAgent;

  if (business.slug) {
    const list = await apiRequestJson('/business/', { method: 'GET', token });
    const businesses = Array.isArray(list.data) ? list.data : [];
    const match = businesses.find(b => b.slug === business.slug || b.name === business.name);
    const agentId = match?.agent_id || match?.default_agent_id || match?.agent?.id;
    const businessAgent = fromAccessible(agentId, match?.agent_name || match?.agent?.name);
    if (businessAgent) return businessAgent;
  }

  if (activeAgents.length === 1) return { id: activeAgents[0].id, label: activeAgents[0].name || activeAgents[0].id };
  if (activeAgents.length > 1) return { id: activeAgents[0].id, label: activeAgents[0].name || activeAgents[0].id };

  throw new Error('No agent found. Run "atris agent" or pass --agent <agent_id>.');
}

function writeImageFile(base64Image, outputPath) {
  const clean = String(base64Image || '').replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, '');
  if (!clean) throw new Error('Backend returned no image data.');
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, Buffer.from(clean, 'base64'));
}

function maybeOpenImage(outputPath) {
  if (process.platform === 'darwin') spawnSync('open', [outputPath], { stdio: 'ignore' });
  else if (process.platform === 'win32') spawnSync('cmd', ['/c', 'start', '', outputPath], { stdio: 'ignore' });
  else spawnSync('xdg-open', [outputPath], { stdio: 'ignore' });
}

async function generateVisual(prompt, options = {}) {
  const outputPath = resolveOutputPath(options.out, prompt);
  const imagePrompt = buildImagePrompt(prompt, options);

  if (options.dryRun) {
    console.log('Atris Visualize dry run');
    console.log(`Model:  ${options.model}`);
    console.log(`Size:   ${options.size}`);
    console.log(`Output: ${outputPath}`);
    console.log('');
    console.log(imagePrompt.trim());
    return { outputPath, imagePrompt, dryRun: true };
  }

  const ensured = await ensureValidCredentials(apiRequestJson);
  const creds = ensured.error ? null : ensured.credentials;
  if (!creds?.token) {
    const detail = ensured.detail || ensured.error;
    throw new Error(detail ? `Authentication failed: ${detail}. Run "atris login".` : 'Not logged in. Run "atris login".');
  }

  const agent = await resolveAgentId(creds.token, options.agentId);
  console.log(`Generating visual with ${options.model} via agent ${agent.label}...`);

  const result = await apiRequestJson(`/agent/${agent.id}/image/generate`, {
    method: 'POST',
    token: creds.token,
    timeoutMs: options.timeoutMs,
    body: {
      prompt: imagePrompt,
      n: 1,
      size: options.size,
      model: options.model,
      quality: options.quality,
      output_format: options.outputFormat,
    },
  });

  if (!result.ok) {
    throw new Error(`Image generation failed (${result.status}): ${result.error || result.text || 'unknown error'}`);
  }

  const image = result.data?.images?.[0];
  writeImageFile(image, outputPath);
  console.log(`Saved: ${outputPath}`);
  if (options.open) maybeOpenImage(outputPath);
  return { outputPath, imagePrompt, model: result.data?.model_used || options.model };
}

async function visualizeAtris(args = process.argv.slice(3)) {
  const { prompt, options } = parseVisualizeArgs(args);
  if (options.help) {
    showVisualizeHelp();
    return;
  }
  if (!prompt) {
    legacyVisualizeInbox();
    return;
  }
  await generateVisual(prompt, options);
}

module.exports = {
  visualizeAtris,
  parseVisualizeArgs,
  buildImagePrompt,
  classifyArtifact,
  resolveOutputPath,
  generateVisual,
};
