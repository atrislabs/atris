'use strict';

// Fast, zero-dependency team member matcher. Scores members from MEMBER.md,
// MISSION.md, SOUL.md, active mission files, and live progress board rows so
// natural-language queries resolve to the right member in a few milliseconds.

const fs = require('fs');
const path = require('path');
const { readBoard } = require('./member-board');
const { memberRefusalReason } = require('./member-type');

const SKIP_TEAM_DIRS = new Set(['_template', '_archive', '_archived', 'archive', 'archived']);
const EXPERIMENT_STATUSES = new Set(['experimental', 'one-off']);
const TERMINAL_MISSION_STATUSES = new Set([
  'complete',
  'completed',
  'done',
  'stopped',
  'failed',
  'cancelled',
  'canceled',
  'archived',
]);

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'guy', 'girl', 'person', 'people', 'member', 'members',
  'teammate', 'who', 'whom', 'whose', 'what', 'which', 'does', 'do', 'did',
  'doing', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'that', 'this',
  'these', 'those', 'for', 'with', 'without', 'and', 'or', 'but', 'if', 'of',
  'in', 'on', 'at', 'to', 'from', 'by', 'into', 'onto', 'upon', 'about',
  'please', 'pls', 'some', 'any', 'work', 'working', 'job', 'task', 'thing',
  'things', 'stuff', 'one', 'ones', 'can', 'could', 'would', 'should', 'will',
  'me', 'my', 'we', 'our', 'you', 'your', 'it', 'its', 'they', 'them', 'their',
  'someone', 'somebody', 'anyone', 'anybody', 'have', 'has', 'had', 'get',
  'got', 'wake', 'up',
]);

const FILE_EXT_RE = /\b([a-z0-9_-]{2,})\.(js|ts|tsx|jsx|cjs|mjs|py|md|json|sh|css|html|go|rs)\b/gi;

const STEM_FAMILIES = [
  new Set(['interact', 'interaction', 'interactions', 'interactive', 'interface', 'interfaces']),
];

const IDEA_ARCHETYPE_RULES = [
  {
    slugs: ['auto-improver', 'improver'],
    pattern: /\b(flaky|slow\s+tests?|broken\s+tests?|recurring|repeat|regression|crash\w*|self[- ]improv\w*|speed|fix\s+bugs?)\b/i,
    reason: 'handles recurring errors, regressions, and slow or flaky tests',
  },
  {
    slugs: ['validator', 'orb'],
    pattern: /\b(review\w*|audit\w*|validat\w*|verif\w*|check\w*|quality|slop|security|gates?)\b/i,
    reason: 'reviews changes, checks quality and slop, and blocks weak work before merge',
  },
  {
    slugs: ['architect'],
    pattern: /\b(architect\w*|migrations?|schemas?|api\s+design|refactor\w*|boundar(?:y|ies)|folders?|worktrees?|files?|structure|protect\w*)\b/i,
    reason: 'judges architecture, file structure, and multi-file design before code changes',
  },
  {
    slugs: ['interface-dev', 'frontend-dev'],
    pattern: /\b(interfaces?|interactions?|interactive|ui|desktop|editor|toolbar|views?|screens?|components?|frontend|design)\b/i,
    reason: 'owns the interface, desktop views, and user interactions',
  },
  {
    slugs: ['navigator', 'task-planner'],
    pattern: /\b(roadmap|plan|planning|specs?|break\s+down|map|where\s+is|navigate|navigation)\b/i,
    reason: 'maps the codebase and breaks ideas into clear steps',
  },
  {
    slugs: ['customer-lead', 'gtm-engineer'],
    pattern: /\b(customers?|churn|retention|onboarding|support|feedback|gtm|outbound|sales|revenue)\b/i,
    reason: 'turns customer and gtm signals into clear commitments and next moves',
  },
  {
    slugs: ['researcher', 'scout', 'signal-scout'],
    pattern: /\b(research\w*|benchmarks?|investigat\w*|compar\w*|stud(?:y|ies)|signals?|survey)\b/i,
    reason: 'researches options, signals, and grounded evidence',
  },
  {
    slugs: ['youtube-lead'],
    pattern: /\b(youtube|videos?|captions?|transcripts?)\b/i,
    reason: 'owns youtube workflows, transcripts, and video notes',
  },
  {
    slugs: ['voice-owner'],
    pattern: /\b(voice|audio|speech|talk\w*|mic|microphone)\b/i,
    reason: 'owns voice, audio, and speech interactions',
  },
  {
    slugs: ['release-sentinel', 'launcher'],
    pattern: /\b(releases?|publish\w*|tags?|deploy\w*|launch\w*|dmg)\b/i,
    reason: 'handles releases, publishing, and launch checks',
  },
  {
    slugs: ['harness-engineer'],
    pattern: /\b(harness|hooks?|runtime|execution|pytest|backend)\b/i,
    reason: 'owns the execution harness, hooks, and backend runtime',
  },
  {
    slugs: ['executor', 'builder', 'codex-executor'],
    pattern: /\b(build\w*|implement\w*|features?|add|wire|create|ship\w*|code|update|cli|commands?|terminal|shell)\b/i,
    strongPattern: /\b(cli|commands?|terminal|shell)\b/i,
    fallbackBuild: true,
    reason: 'builds and tests concrete product and cli changes',
  },
];

function cleanReason(text) {
  return String(text || '')
    .replace(/\s*(?:\u2014|--+)\s*/g, ', ')
    .replace(/,\s*,+/g, ',')
    .replace(/\s+/g, ' ')
    .trim();
}

function compactSentence(text, max = 90) {
  const clean = cleanReason(text);
  if (clean.length <= max) return clean.replace(/[,:;]+$/, '');
  const cut = clean.slice(0, Math.max(0, max - 3));
  const lastSpace = cut.lastIndexOf(' ');
  const base = (lastSpace > max * 0.5 ? cut.slice(0, lastSpace) : cut).trim().replace(/[,:;]+$/, '');
  return `${base}...`;
}

function ideaNamesMember(text, slug) {
  if (!text || !slug) return false;
  const escaped = String(slug).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/-/g, '[-\\s]+');
  return new RegExp(`(^|[^a-z0-9-])${escaped}($|[^a-z0-9-])`, 'i').test(String(text));
}

function parseFrontmatter(content) {
  const match = String(content || '').match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;
  const yaml = match[1];
  const result = {};
  let currentKey = null;

  for (const line of yaml.split(/\r?\n/)) {
    const listMatch = line.match(/^\s+-\s+(.+)$/);
    if (listMatch && currentKey) {
      if (!Array.isArray(result[currentKey])) result[currentKey] = [];
      result[currentKey].push(listMatch[1].trim());
      continue;
    }
    const nestedMatch = line.match(/^\s+([a-z_-]+):\s*(.*)$/);
    if (nestedMatch && currentKey && typeof result[currentKey] === 'object' && !Array.isArray(result[currentKey])) {
      const val = nestedMatch[2].trim();
      result[currentKey][nestedMatch[1]] = val === 'true' ? true : val === 'false' ? false : val || true;
      continue;
    }
    const kvMatch = line.match(/^([a-z_-]+):\s*(.*)$/);
    if (kvMatch) {
      currentKey = kvMatch[1];
      const val = kvMatch[2].trim();
      if (val === '') {
        result[currentKey] = {};
      } else if (val.startsWith('[') && val.endsWith(']')) {
        const inner = val.slice(1, -1).trim();
        result[currentKey] = inner
          ? inner.split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean)
          : [];
      } else {
        const quoted = val.match(/^(["'])([\s\S]*)\1$/);
        result[currentKey] = quoted ? quoted[2] : val;
      }
    }
  }
  return result;
}

function stripBoilerplate(markdown) {
  return String(markdown || '')
    .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/^##\s+How To Choose Goals[\s\S]*$/im, ' ')
    .replace(/^\s*\((?:Define|Replace|Empty|One sentence)[^)]*\)\s*$/gim, ' ');
}

function extractFirstParagraph(markdown) {
  const body = stripBoilerplate(markdown);
  const lines = body.split(/\r?\n/);
  const collected = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      if (collected.length > 0) break;
      continue;
    }
    if (line.startsWith('#') || line.startsWith('>') || /^---+$/.test(line) || line.startsWith('```') || line.startsWith('│') || line.startsWith('┌') || line.startsWith('└')) {
      if (collected.length > 0) break;
      continue;
    }
    if (/^replace with\b/i.test(line)) continue;
    collected.push(line);
  }
  return collected.join(' ').trim();
}

function stemVariants(word) {
  const w = String(word || '').toLowerCase().trim();
  const out = new Set();
  if (!w) return out;
  out.add(w);

  const addCandidate = (stem) => {
    if (stem && stem.length >= 3) out.add(stem);
  };

  if (w.endsWith('ions') && w.length > 6) {
    addCandidate(w.slice(0, -1));
    addCandidate(w.slice(0, -4));
    addCandidate(`${w.slice(0, -4)}e`);
  }
  if (w.endsWith('ion') && w.length > 5) {
    addCandidate(w.slice(0, -3));
    addCandidate(`${w.slice(0, -3)}e`);
  }
  if (w.endsWith('ive') && w.length > 5) {
    addCandidate(w.slice(0, -3));
    addCandidate(`${w.slice(0, -3)}e`);
  }
  if (w.endsWith('ies') && w.length > 4) {
    addCandidate(`${w.slice(0, -3)}y`);
  }
  if (w.endsWith('ing') && w.length > 5) {
    const base = w.slice(0, -3);
    addCandidate(base);
    addCandidate(`${base}e`);
    if (base.length >= 4 && base[base.length - 1] === base[base.length - 2]) {
      addCandidate(base.slice(0, -1));
    }
  }
  if (w.endsWith('es') && w.length > 4) {
    addCandidate(w.slice(0, -1));
    addCandidate(w.slice(0, -2));
  }
  if (w.endsWith('s') && !w.endsWith('ss') && w.length > 3) {
    addCandidate(w.slice(0, -1));
  }
  if ((w.endsWith('er') || w.endsWith('or')) && w.length > 4) {
    addCandidate(w.slice(0, -2));
    addCandidate(w.slice(0, -1));
  }
  if (w.endsWith('ed') && w.length > 4) {
    addCandidate(w.slice(0, -2));
    addCandidate(w.slice(0, -1));
  }

  for (const family of STEM_FAMILIES) {
    for (const v of Array.from(out)) {
      if (family.has(v)) {
        for (const peer of family) out.add(peer);
        break;
      }
    }
  }

  return out;
}

function tokenizeQuery(query) {
  const raw = String(query || '').toLowerCase();
  const dottedByBase = new Map();
  const scrubbed = raw.replace(FILE_EXT_RE, (full, base) => {
    const lowerFull = full.toLowerCase();
    const lowerBase = base.toLowerCase();
    if (!dottedByBase.has(lowerBase)) dottedByBase.set(lowerBase, new Set());
    dottedByBase.get(lowerBase).add(lowerFull);
    return ` ${lowerBase} `;
  });

  const tokens = [];
  const seen = new Set();
  for (const part of scrubbed.split(/[^a-z0-9]+/)) {
    if (part.length < 2) continue;
    if (STOP_WORDS.has(part)) continue;
    if (seen.has(part)) continue;
    seen.add(part);
    const variants = stemVariants(part);
    if (dottedByBase.has(part)) {
      for (const dotted of dottedByBase.get(part)) variants.add(dotted);
    }
    tokens.push({ token: part, variants });
  }
  return tokens;
}

function buildTextIndex(text) {
  const lower = String(text || '').toLowerCase();
  const words = lower.split(/[^a-z0-9]+/).filter((w) => w.length >= 2);
  return { lower, words, wordSet: new Set(words) };
}

function tokenMatchesIndex(tokenObj, index) {
  if (!index || (!index.words.length && !index.lower)) return false;
  for (const v of tokenObj.variants) {
    if (v.includes('.')) {
      if (index.lower.includes(v)) return true;
      continue;
    }
    if (index.wordSet.has(v)) return true;
    if (v.length >= 4) {
      for (const w of index.words) {
        if (w.length >= 4 && (w.startsWith(v) || v.startsWith(w))) return true;
      }
    }
  }
  return false;
}

function countTokenMatches(tokens, index) {
  let count = 0;
  for (const tokenObj of tokens) {
    if (tokenMatchesIndex(tokenObj, index)) count += 1;
  }
  return count;
}

function readOptionalFile(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function loadActiveMissionObjectives(repoRoot) {
  const byOwner = new Map();
  const candidates = [];

  const considerMission = (mission) => {
    if (!mission || typeof mission !== 'object') return;
    const owner = String(mission.owner || '').trim().toLowerCase();
    const objective = String(mission.objective || mission.title || '').trim();
    if (!owner || !objective) return;
    if (/^decide and start the next useful mission after:/i.test(objective)) return;
    const status = String(mission.status || 'running').trim().toLowerCase();
    if (TERMINAL_MISSION_STATUSES.has(status)) return;
    const rank = status === 'running' || status === 'active' ? 2 : 1;
    const ts = Date.parse(mission.last_tick_at || mission.updated_at || mission.created_at || '') || 0;
    candidates.push({ id: mission.id || '', owner, objective, rank, ts });
  };

  const missionsDir = path.join(repoRoot, '.atris', 'state', 'missions');
  try {
    const files = fs.readdirSync(missionsDir);
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(missionsDir, file), 'utf8'));
        if (Array.isArray(parsed)) {
          for (const item of parsed) considerMission(item);
        } else {
          considerMission(parsed);
        }
      } catch {}
    }
  } catch {}

  const missionsJsonl = path.join(repoRoot, '.atris', 'state', 'missions.jsonl');
  try {
    if (fs.existsSync(missionsJsonl)) {
      const latestById = new Map();
      const rawLines = fs.readFileSync(missionsJsonl, 'utf8').split(/\r?\n/);
      for (const line of rawLines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed && typeof parsed === 'object') {
            latestById.set(parsed.id || `${latestById.size}`, parsed);
          }
        } catch {}
      }
      for (const item of latestById.values()) considerMission(item);
    }
  } catch {}

  candidates.sort((a, b) => {
    if (a.rank !== b.rank) return b.rank - a.rank;
    return b.ts - a.ts;
  });

  for (const item of candidates) {
    if (!byOwner.has(item.owner)) {
      byOwner.set(item.owner, item.objective);
    }
  }
  return byOwner;
}

function dispatchTier(slug, frontmatter = {}) {
  const status = String(frontmatter.status || '').trim().toLowerCase();
  if (status === 'parked' || memberRefusalReason(slug, frontmatter)) return 2;
  if (EXPERIMENT_STATUSES.has(status)) return 1;
  return 0;
}

function loadTeamCandidatesFromRepo(repoRoot, isLocal, excludeSet, boardByMember) {
  const teamDir = path.join(repoRoot, 'atris', 'team');
  let entries = [];
  try {
    entries = fs.readdirSync(teamDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const missionObjectives = loadActiveMissionObjectives(repoRoot);
  const candidates = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const slug = entry.name;
    if (slug.startsWith('.') || slug.startsWith('_') || SKIP_TEAM_DIRS.has(slug)) continue;
    if (excludeSet.has(slug.toLowerCase())) continue;

    const memberDir = path.join(teamDir, slug);
    const memberFile = path.join(memberDir, 'MEMBER.md');
    const memberRaw = readOptionalFile(memberFile);
    if (!memberRaw) continue;

    const fm = parseFrontmatter(memberRaw) || {};
    const rawRole = String(fm.role || '').trim();
    const role = rawRole && !/^replace with\b/i.test(rawRole) && rawRole !== '(no role)' ? rawRole : '';
    const rawDesc = String(fm.description || '').trim();
    const fmDesc = rawDesc && !/^replace with\b/i.test(rawDesc) ? rawDesc : '';
    const firstParagraph = extractFirstParagraph(memberRaw);
    const description = fmDesc || firstParagraph;

    const skills = Array.isArray(fm.skills) ? [...fm.skills] : [];
    try {
      const skillDirs = fs.readdirSync(path.join(memberDir, 'skills'), { withFileTypes: true });
      for (const s of skillDirs) {
        if (s.isDirectory() && !s.name.startsWith('.') && !skills.includes(s.name)) {
          skills.push(s.name);
        }
      }
    } catch {}

    const missionText = stripBoilerplate(readOptionalFile(path.join(memberDir, 'MISSION.md')));
    const soulText = stripBoilerplate(readOptionalFile(path.join(memberDir, 'SOUL.md')));
    const liveObjective = missionObjectives.get(slug.toLowerCase()) || '';
    const boardRow = boardByMember.get(slug) || null;
    const boardJob = String(boardRow?.job || '').trim();
    const boardStep = String(boardRow?.step || '').trim();

    candidates.push({
      slug,
      role: role || 'Team Member',
      searchableRole: role,
      description,
      firstParagraph,
      skills,
      missionText,
      soulText,
      liveObjective,
      boardRow,
      boardJob,
      boardStep,
      frontmatter: fm,
      tier: dispatchTier(slug, fm),
      repoRoot,
      isLocal,
    });
  }

  return candidates;
}

function gatherCandidates(options, boardByMember) {
  const resolvedRoot = path.resolve(options.root || process.cwd());
  const excludeSet = new Set();
  if (options.exclude) {
    for (const item of options.exclude) {
      if (item) excludeSet.add(String(item).trim().toLowerCase());
    }
  }

  const allCandidates = [
    ...loadTeamCandidatesFromRepo(resolvedRoot, true, excludeSet, boardByMember),
  ];

  if (options.includeWorkspace) {
    const parent = path.dirname(resolvedRoot);
    let entries = [];
    try {
      entries = fs.readdirSync(parent, { withFileTypes: true });
    } catch {}
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const siblingRoot = path.resolve(parent, entry.name);
      if (siblingRoot === resolvedRoot) continue;
      if (!fs.existsSync(path.join(siblingRoot, 'atris', 'team'))) continue;
      allCandidates.push(...loadTeamCandidatesFromRepo(siblingRoot, false, excludeSet, boardByMember));
    }

    const seenSlugs = new Set(allCandidates.map((c) => c.slug.toLowerCase()));
    for (const [memberName, row] of boardByMember.entries()) {
      const slug = String(memberName || '').trim();
      if (!slug || slug.startsWith('.') || slug.startsWith('_') || SKIP_TEAM_DIRS.has(slug)) continue;
      if (excludeSet.has(slug.toLowerCase()) || seenSlugs.has(slug.toLowerCase())) continue;
      seenSlugs.add(slug.toLowerCase());
      allCandidates.push({
        slug,
        role: 'Team Member',
        searchableRole: '',
        description: '',
        firstParagraph: '',
        skills: [],
        missionText: '',
        soulText: '',
        liveObjective: '',
        boardRow: row,
        boardJob: String(row?.job || '').trim(),
        boardStep: String(row?.step || '').trim(),
        frontmatter: {},
        tier: row?.state === 'working' ? 0 : 1,
        repoRoot: resolvedRoot,
        isLocal: false,
      });
    }
  }

  return allCandidates;
}

function resolveBoardMap(options, now) {
  const boardByMember = new Map();
  let rows = Array.isArray(options.boardRows) ? options.boardRows : null;
  if (!rows) {
    try {
      const readOpts = { now, all: true };
      if (options.progressDir) readOpts.dir = options.progressDir;
      rows = readBoard(readOpts);
    } catch {
      rows = [];
    }
  }
  for (const row of rows) {
    if (row && row.member && !boardByMember.has(row.member)) {
      boardByMember.set(row.member, row);
    }
  }
  return { boardByMember, boardRows: rows };
}

function outranksCandidate(candidate, best) {
  if (!best) return true;
  if (candidate.tier !== best.tier) return candidate.tier < best.tier;
  if (candidate.score !== best.score) return candidate.score > best.score;
  if (candidate.isLocal !== best.isLocal) return candidate.isLocal;
  if (candidate.ruleRank !== best.ruleRank) return candidate.ruleRank < best.ruleRank;
  if (candidate.hasSkills !== best.hasSkills) return candidate.hasSkills;
  return candidate.member.localeCompare(best.member) < 0;
}

function matchMember(query, options = {}) {
  const text = String(query || '').trim();
  const preferActive = options.preferActive !== false;
  const now = typeof options.now === 'number' ? options.now : Date.now();
  const { boardByMember } = resolveBoardMap(options, now);
  const candidates = gatherCandidates(options, boardByMember);
  if (!candidates.length) return null;

  const cleanPreferred = String(options.preferredMember || '').trim().toLowerCase();
  if (cleanPreferred) {
    const preferred = candidates.find((c) => c.slug.toLowerCase() === cleanPreferred);
    if (preferred) {
      return {
        member: preferred.slug,
        role: preferred.role || 'Team Member',
        reason: 'selected directly by you',
        score: 100,
        tier: preferred.tier,
        repoRoot: preferred.repoRoot,
      };
    }
  }

  if (!text) return null;

  const tokens = tokenizeQuery(text);
  const candidateSlugSet = new Set(candidates.map((c) => c.slug));
  const hasSpecializedRuleMatch = IDEA_ARCHETYPE_RULES.some(
    (rule) => !rule.fallbackBuild && rule.pattern.test(text) && rule.slugs.some((s) => candidateSlugSet.has(s))
  );

  let best = null;

  for (const candidate of candidates) {
    const { slug } = candidate;
    const named = ideaNamesMember(text, slug);
    const tier = named && candidate.tier === 1 ? 0 : candidate.tier;

    let domainRule = null;
    let ruleRank = 99;
    for (const rule of IDEA_ARCHETYPE_RULES) {
      const idx = rule.slugs.indexOf(slug);
      if (idx === -1) continue;
      if (rule.fallbackBuild) {
        const matchesStrong = rule.strongPattern && rule.strongPattern.test(text);
        const matchesGeneral = !hasSpecializedRuleMatch && rule.pattern.test(text);
        if (matchesStrong || matchesGeneral) {
          domainRule = rule;
          ruleRank = idx;
          break;
        }
      } else if (rule.pattern.test(text)) {
        domainRule = rule;
        ruleRank = idx;
        break;
      }
    }

    const objectiveIndex = buildTextIndex(candidate.liveObjective);
    const jobIndex = buildTextIndex(candidate.boardJob);
    const stepIndex = buildTextIndex(candidate.boardStep);
    const liveIndex = buildTextIndex(`${candidate.liveObjective} ${candidate.boardJob} ${candidate.boardStep}`);
    const slugRoleIndex = buildTextIndex(`${slug} ${candidate.searchableRole}`);
    const bodyIndex = buildTextIndex(
      `${candidate.description} ${candidate.firstParagraph} ${candidate.skills.join(' ')} ${candidate.missionText} ${candidate.soulText}`
    );

    const liveMatches = countTokenMatches(tokens, liveIndex);
    const slugRoleMatches = countTokenMatches(tokens, slugRoleIndex);
    const bodyMatches = countTokenMatches(tokens, bodyIndex);

    const nameScore = named ? 60 : 0;
    const domainScore = domainRule ? 30 : 0;
    const liveScore = liveMatches * 12;
    const slugRoleScore = slugRoleMatches * 10;
    const bodyScore = bodyMatches * 6;

    const signalScore = nameScore + domainScore + liveScore + slugRoleScore + bodyScore;
    if (signalScore <= 0) continue;

    let activeBoost = 0;
    if (preferActive && candidate.boardRow) {
      const row = candidate.boardRow;
      const aliveOrWorking = Boolean(row.alive || row.state === 'working');
      const ageMin = row.at ? Math.max(0, (now - row.at) / 60000) : Infinity;
      activeBoost = (aliveOrWorking ? 2 : 0) + (ageMin <= 15 ? 1 : 0);
    }

    const customBoost = typeof options.scoreBoost === 'function' ? Number(options.scoreBoost(slug) || 0) : 0;
    const totalScore = signalScore + activeBoost + customBoost;

    let reason = '';
    if (named) {
      reason = 'named directly';
    } else if (domainRule && !domainRule.fallbackBuild && domainScore > liveScore) {
      reason = domainRule.reason;
    } else if (liveMatches > 0) {
      let liveSource = candidate.liveObjective || candidate.boardJob || candidate.boardStep;
      if (candidate.liveObjective && countTokenMatches(tokens, objectiveIndex) > 0) {
        liveSource = candidate.liveObjective;
      } else if (candidate.boardJob && countTokenMatches(tokens, jobIndex) > 0) {
        liveSource = candidate.boardJob;
      } else if (candidate.boardStep && countTokenMatches(tokens, stepIndex) > 0) {
        liveSource = candidate.boardStep;
      }
      reason = `working on: ${compactSentence(liveSource, 80)}`;
    } else if (domainRule) {
      reason = domainRule.reason;
    } else if (candidate.description) {
      reason = compactSentence(candidate.description, 90);
    } else {
      reason = `fits ${candidate.role || slug} responsibilities`;
    }

    const entry = {
      member: slug,
      role: candidate.role || 'Team Member',
      reason: cleanReason(reason),
      score: totalScore,
      signalScore,
      tier,
      fit: named ? 3 : domainRule ? 2 : 1,
      repoRoot: candidate.repoRoot,
      isLocal: candidate.isLocal,
      ruleRank,
      hasSkills: candidate.skills.length > 0,
    };

    if (outranksCandidate(entry, best)) {
      best = entry;
    }
  }

  if (!best) return null;

  return {
    member: best.member,
    role: best.role,
    reason: best.reason,
    score: best.score,
    tier: best.tier,
    fit: best.fit,
    repoRoot: best.repoRoot,
  };
}

function matchMembers(queries, options = {}) {
  if (!Array.isArray(queries)) return [];
  const now = typeof options.now === 'number' ? options.now : Date.now();
  const { boardRows } = resolveBoardMap(options, now);
  const excluded = new Set();
  if (options.exclude) {
    for (const item of options.exclude) {
      if (item) excluded.add(String(item).trim().toLowerCase());
    }
  }

  const results = [];
  for (const query of queries) {
    const matched = matchMember(query, {
      ...options,
      now,
      boardRows,
      exclude: excluded,
    });
    if (matched && matched.member) {
      excluded.add(matched.member.toLowerCase());
    }
    results.push(matched);
  }
  return results;
}

module.exports = {
  IDEA_ARCHETYPE_RULES,
  ideaNamesMember,
  matchMember,
  matchMembers,
  stemVariants,
  tokenizeQuery,
};
