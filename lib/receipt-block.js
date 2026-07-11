'use strict';

const { historicalLandingText } = require('./autoland');

function compactLine(value) {
  return String(value == null ? '' : value)
    .replace(/\s+/g, ' ')
    .trim();
}

function asciiLine(value) {
  return compactLine(value)
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/[^\S\r\n]+/g, ' ');
}

function lowerLine(value) {
  return asciiLine(value).toLowerCase();
}

function trimPunctuation(value) {
  return asciiLine(value).replace(/[.!?:;,]+$/g, '').trim();
}

function truncateLine(value, max = 180) {
  const text = asciiLine(value);
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 3)).trimEnd()}...`;
}

function landing(receipt) {
  const value = receipt && receipt.result && receipt.result.landing;
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function result(receipt) {
  const value = receipt && receipt.result;
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function verifierResult(receipt) {
  const res = result(receipt);
  const value = res.verifier_result || res.tick?.verifier_result || null;
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function changedText(receipt) {
  const land = landing(receipt);
  const res = result(receipt);
  const text = land.changed
    || land.happened
    || res.tick?.summary
    || res.tick?.claude?.summary
    || res.tick?.atris2?.receipt_text
    || res.summary
    || receipt?.objective
    || 'mission receipt recorded';
  return lowerLine(text);
}

function statusText(receipt) {
  const land = landing(receipt);
  const res = result(receipt);
  const status = land.status || res.status || res.tick?.status || (res.passed === true ? 'proof_ready' : '');
  return lowerLine(status || 'recorded');
}

function scaleText(receipt) {
  const res = result(receipt);
  const worktree = res.worktree || res.tick?.worktree || {};
  const changedCount = Number(
    worktree.new_since_baseline_count
    || worktree.new_dirty_count
    || worktree.dirty_count
    || 0,
  );
  if (Number.isFinite(changedCount) && changedCount > 0) {
    return changedCount === 1 ? '1 changed file' : `${changedCount} changed files`;
  }

  const tickCount = Number(res.tick_count || 0);
  if (Number.isFinite(tickCount) && tickCount > 0) {
    return tickCount === 1 ? '1 tick' : `${tickCount} ticks`;
  }

  const ranTicks = Number(res.ran_ticks || 0);
  if (Number.isFinite(ranTicks) && ranTicks > 0) {
    return ranTicks === 1 ? '1 ran tick' : `${ranTicks} ran ticks`;
  }

  if (res.tick || res.kind === 'mission_tick' || res.kind === 'mission_run_tick') return '1 tick';
  return '1 receipt';
}

function directProofText(value) {
  const text = lowerLine(value);
  const ran = trimPunctuation(text).match(/^i ran (.+)$/);
  return ran ? `${ran[1]} passed` : text;
}

function proofText(receipt) {
  const land = landing(receipt);
  const verifier = verifierResult(receipt);
  if (land.checked) return directProofText(land.checked);
  if (land.tested) return directProofText(land.tested);
  if (verifier) {
    const command = lowerLine(verifier.command || receipt?.verifier || 'configured verifier');
    return `${command} ${verifier.passed ? 'passed' : 'failed'}`;
  }
  if (result(receipt).passed === true) return 'receipt says verifier passed';
  if (receipt?.at) return `receipt saved at ${lowerLine(receipt.at)}`;
  return 'receipt is present';
}

function nextText(receipt) {
  const text = landing(receipt).next || result(receipt).next || '';
  return lowerLine(text);
}

function renderEmailLine(receipt) {
  const what = historicalLandingText(trimPunctuation(changedText(receipt)), 130);
  const scale = scaleText(receipt);
  const proof = historicalLandingText(trimPunctuation(proofText(receipt)), 90);
  return `${what}; ${scale}; we know because ${proof}.`;
}

function renderMorningCardRow(receipt) {
  return `- mission: ${renderEmailLine(receipt).replace(/\.$/, '')}`;
}

function renderPageSection(receipt) {
  const next = nextText(receipt);
  const lines = [
    '## mission receipt',
    '',
    `- what: ${truncateLine(trimPunctuation(changedText(receipt)), 160)}`,
    `- how big: ${scaleText(receipt)}`,
    `- how we know: ${truncateLine(trimPunctuation(proofText(receipt)), 160)}`,
    `- status: ${statusText(receipt)}`,
  ];
  if (receipt?.mission_id) lines.push(`- mission: ${lowerLine(receipt.mission_id)}`);
  if (next) lines.push(`- next: ${truncateLine(trimPunctuation(next), 160)}`);
  return lines.join('\n');
}

function renderCard(receipt) {
  const status = statusText(receipt);
  const what = truncateLine(trimPunctuation(changedText(receipt)), 64);
  const scale = scaleText(receipt);
  const proof = truncateLine(trimPunctuation(proofText(receipt)), 88);
  return {
    kind: 'statement',
    headline: what,
    text: what,
    kicker: `${status} mission receipt`,
    sub: `${scale}; ${proof}`,
    brand: 'atris',
    size: 'og',
    theme: 'atris',
  };
}

module.exports = {
  renderCard,
  renderPageSection,
  renderEmailLine,
  renderMorningCardRow,
};
