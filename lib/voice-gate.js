'use strict';

const {
  dejargon,
  hasAgentJargon,
  operatorReady,
  voicePatterns,
} = require('./autoland');

const EM_DASH = /\u2014/;
const JARGON = /\b(?:idempotent|deterministic|substrate|orchestration|invariant|canonical|materialize|heuristic)\b/gi;
const JARGON_SUGGESTIONS = {
  idempotent: 'safe to repeat',
  deterministic: 'predictable',
  substrate: 'base',
  orchestration: 'coordination',
  invariant: 'rule that must stay true',
  canonical: 'standard',
  materialize: 'create',
  heuristic: 'rule of thumb',
};
const NUMBER_WORDS = [
  'no', 'one', 'two', 'three', 'four', 'five', 'six',
  'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
];

function numberWord(n) {
  return NUMBER_WORDS[n] || String(n);
}

function globalPattern(pattern) {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  return new RegExp(pattern.source, flags);
}

function findingsFor(text, pattern, rule, why) {
  const findings = [];
  for (const match of String(text || '').matchAll(globalPattern(pattern))) {
    findings.push({ rule, why, snippet: match[0] });
  }
  return findings;
}

function scanWords(text) {
  const value = String(text || '');
  const findings = findingsFor(value, EM_DASH, 'em-dash', 'use plain punctuation');
  if (hasAgentJargon(value)) {
    findings.push(...findingsFor(
      value,
      voicePatterns.agentJargon,
      'agent-jargon',
      'replace internal syntax with plain words',
    ));
  }
  findings.push(...findingsFor(
    value,
    voicePatterns.rawUlid,
    'raw-ulid',
    'name the item instead of showing its database id',
  ));
  findings.push(...findingsFor(
    value,
    voicePatterns.filePath,
    'file-path',
    'describe the proof instead of exposing an internal file location',
  ));
  findings.push(...findingsFor(
    value,
    voicePatterns.shellCommand,
    'shell-command',
    'turn command syntax into a human action',
  ));
  return findings;
}

function paragraphsFor(text) {
  return String(text || '')
    .trim()
    .split(/\r?\n(?:[ \t]*\r?\n)+/)
    .map(paragraph => paragraph.trim())
    .filter(Boolean);
}

function sentenceCount(text) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (!value) return 0;
  const endings = value.match(/[.!?]+(?=\s|$)/g) || [];
  return endings.length + (/[.!?]+$/.test(value) ? 0 : 1);
}

function scanShape(text) {
  const paragraphs = paragraphsFor(text);
  const findings = [];
  for (const paragraph of paragraphs) {
    if (sentenceCount(paragraph) > 2) {
      findings.push({
        rule: 'dense-block',
        why: 'add a blank line after every two sentences',
        snippet: paragraph,
      });
    }
  }
  if (paragraphs.length > 3) {
    findings.push({
      rule: 'too-many-ideas',
      why: 'split this into messages with no more than three paragraphs each',
      snippet: paragraphs.slice(3).join('\n\n'),
    });
  }
  for (const match of String(text || '').matchAll(JARGON)) {
    const suggestion = JARGON_SUGGESTIONS[match[0].toLowerCase()];
    findings.push({
      rule: 'jargon',
      why: `replace "${match[0]}" with "${suggestion}"`,
      snippet: match[0],
    });
  }
  return findings;
}

function scanText(text) {
  return [...scanWords(text), ...scanShape(text)];
}

function cleanEmDashes(text) {
  return String(text || '')
    .replace(/\s*\u2014\s*/g, ', ')
    .replace(/^,\s*/, '')
    .replace(/,\s*$/, '.')
    .replace(/([.!?])\s*,\s*/g, '$1 ')
    .replace(/,\s*([,.;:!?])/g, '$1');
}

function cleanAfterRemoval(text) {
  return String(text || '')
    .replace(/\(\s*\)/g, '')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/([:;,])\s*([.!?])/g, '$2')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function titleCanReplaceId(title) {
  const value = String(title || '').trim();
  return Boolean(value) && (operatorReady(value) || !hasAgentJargon(value));
}

function gateForHuman(text, opts = {}) {
  const shapeIssues = scanShape(text);
  let cleaned = cleanEmDashes(text);
  cleaned = dejargon(cleaned, { preserveTickets: true });
  if (titleCanReplaceId(opts.title)) {
    cleaned = cleaned.replace(globalPattern(voicePatterns.rawUlid), '');
  }
  cleaned = cleanAfterRemoval(cleaned);
  const issues = [...scanWords(cleaned), ...shapeIssues];
  return { ok: issues.length === 0, text: cleaned, issues };
}

const LANDING_PARTICIPLE_WHY = {
  avoiding: 'it avoids',
  cutting: 'it cuts',
  eliminating: 'it eliminates',
  giving: 'it gives',
  keeping: 'it keeps',
  making: 'it makes',
  preventing: 'it prevents',
  reducing: 'it reduces',
  removing: 'it removes',
  saving: 'it saves',
  stopping: 'it stops',
};

// A landing sentence written for a human already carries its own why
// ("..., so operators keep deciding instead of waiting"). Split that clause
// out so "why it matters" quotes the work instead of a canned line; return
// null when the sentence has no real why.
function landingWhyClause(sentence) {
  const text = String(sentence || '').replace(/\s+/g, ' ').trim();
  const finish = (change, why) => {
    const cleanChange = String(change || '').replace(/[,;:]+$/, '').trim();
    const cleanWhy = String(why || '').trim();
    if (!cleanChange || !cleanWhy) return null;
    return {
      change: /[.!?]$/.test(cleanChange) ? cleanChange : `${cleanChange}.`,
      why: /[.!?]$/.test(cleanWhy) ? cleanWhy : `${cleanWhy}.`,
    };
  };
  const connective = text.match(/^(.{12,}?),?\s+(?:so(?:\s+that)?|because|which means)\s+(.{8,}?)[.!?]?$/i);
  if (connective) return finish(connective[1], connective[2]);
  const participles = Object.keys(LANDING_PARTICIPLE_WHY).join('|');
  const participial = text.match(new RegExp(`^(.{12,}?),\\s+(${participles})\\s+(.{4,}?)[.!?]?$`, 'i'));
  if (participial) {
    return finish(participial[1], `${LANDING_PARTICIPLE_WHY[participial[2].toLowerCase()]} ${participial[3]}`);
  }
  return null;
}

// Canned reasons older composers wrote into durable receipts. Treat them as
// absent so the reader sees the work's own why or nothing at all.
const RETIRED_FILLER_REASON = new RegExp([
  '^It makes the result understandable before a human accepts or rejects it\\.$',
  '^It proves the workflow works in the place people actually use it\\.$',
  '^It turns the mission into a concrete result a human can accept, reject, or run again\\.$',
  '^It turns the task title into a concrete result the human can approve\\.$',
  '^It gives the human a repeatable check before approval\\.$',
  '^It keeps real-world side effects behind a clear human decision\\.$',
  '^It keeps private data out of the fast human decision screen\\.$',
  '^It lets the operator see the next command without hunting\\.$',
  '^It stops old approvals from running after their context has gone stale\\.$',
  '^This makes the work easier to judge\\.$',
].join('|'));

function isRetiredFillerReason(text) {
  return RETIRED_FILLER_REASON.test(String(text || '').replace(/\s+/g, ' ').trim());
}

// One table turns every landing/refusal reason code into a plain sentence a
// fried reader can act on: what happened, and what unblocks it. JSON output
// keeps the raw codes; only human text goes through here. Fragments carry no
// trailing period because callers stitch them into their own sentences.
const LANDING_REASON_SENTENCES = {
  accept_all_but_protected: 'the accept-everything policy covers it, so it lands unless a protected lane applies',
  already_auto_accepted: 'it already landed on its own earlier, nothing left to do',
  autoland_policy_missing_owner: 'the self-landing policy has no owner recorded, turn it on again to set one',
  autoland_policy_off: 'self-landing is off, so everything waits for you',
  certified_independent_review: 'an independent reviewer certified it, so it can land',
  certified_strict_verify: 'it is certified and its recorded check passed, so it can land',
  dead_exports: 'the change leaves behind code nothing calls, delete what the hygiene check names and re-certify',
  declared_protected_lane: 'it touches a protected lane, so it waits for your decision',
  forced_completion_needs_human: 'it was pushed to done without proof, so only a human can accept it',
  insufficient_review_passes: 'it has not been reviewed enough times yet, one more pass unblocks it',
  judge_equals_worker: 'built and judged by the same actor, hand the review to someone else',
  mission_xp_requires_end_to_end_receipt: 'the proof does not show the whole flow working start to finish, attach that receipt or move it back to do',
  needs_independent_reviewer: 'built and judged by the same actor, a review from someone else unblocks it',
  needs_second_actor_review: 'the same actor built and reviewed it, someone else has to look before it lands',
  needs_second_reviewer_or_third_pass: 'it needs one more independent check first',
  no_verify_command: 'no check command was given, add one so the work can prove itself',
  not_agent_certified: 'no reviewer has certified it yet, a second review unblocks it',
  not_in_review: 'it is not up for review yet, finish the work and move it to review first',
  probation_needs_review: 'the builder is still earning trust, so a human look is required before it lands',
  proof_not_executed: 'the proof was written but never actually run, execute the check and record what it showed',
  proof_required: 'no proof was given, say what was run and what it showed',
  proof_unmerged_or_draft_pr_boundary: 'its proof points at an unmerged draft, merge it or prove the work another way',
  receipt_verifier_failed: 'a saved receipt failed its re-check, fix what it names and re-certify',
  strict_verify_missing: 'no recorded check command to re-run, add one and re-certify',
  untagged_protected_lane_text: 'the description reads like protected-lane work without the tag, tag it or decide it yourself',
  verification_pending: 'the recorded check has not been re-run yet, the next hourly pass runs it',
  verifier_is_builder: 'the re-check actor built this row, another actor must re-check',
  verify_command_not_allowed: 'its recorded check is not on the list this machine may run alone, run it yourself to unblock',
  verify_failed: 'its check command failed on re-run, fix the failure and re-certify',
  verify_passed: 'its check command passed on re-run',
  verify_unrunnable: 'its check command could not even start, fix the command and re-certify',
  verify_workdir_missing: 'the folder its check was recorded in is gone, re-run the check from a real folder',
  verify_worktree_missing: 'the folder its check needs is gone, rebuild it or run the check by hand',
  weak_proof: 'the proof is too thin to trust, cite a command, receipt, or approval',
};

const DENIED_TAG_SENTENCES = {
  billing: 'it touches money, so it is your decision',
  deploy: 'it is a deploy, so it is your decision',
  security: 'it touches security, so it is your decision',
  customer: 'it is customer-facing, so it is your decision',
  external: 'it is outward-facing, so it is your decision',
  feedback: 'it answers customer feedback, so it is your decision',
};

function plainLandingReason(reason) {
  const code = String(reason || '').trim();
  if (!code) return 'no reason was recorded, re-run the review to get one';
  if (LANDING_REASON_SENTENCES[code]) return LANDING_REASON_SENTENCES[code];
  const denied = code.match(/^denied_tag_(.+)$/);
  if (denied) {
    return DENIED_TAG_SENTENCES[denied[1]]
      || `it is tagged ${denied[1].replace(/_/g, ' ')}, a protected lane, so it is your decision`;
  }
  const approval = code.match(/^approval_(.+)$/);
  if (approval) return `a human already marked it ${approval[1].replace(/_/g, ' ')}, so it will not land on its own`;
  // Unknown codes still never leak snake_case to a human.
  return code.replace(/_/g, ' ');
}

module.exports = {
  gateForHuman,
  isRetiredFillerReason,
  landingWhyClause,
  numberWord,
  plainLandingReason,
  scanText,
};
