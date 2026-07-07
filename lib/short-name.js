'use strict';

const FILLER_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'claim',
  'for',
  'from',
  'in',
  'is',
  'of',
  'on',
  'or',
  'please',
  'pls',
  'that',
  'the',
  'these',
  'this',
  'those',
  'to',
  'via',
  'with',
]);

function displayNumber(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : 0;
}

function nextRecordNumber(records = []) {
  const max = records.reduce((largest, record) => Math.max(largest, displayNumber(record && record.n)), 0);
  return max + 1;
}

function shortId(id) {
  const text = String(id || '').trim();
  if (!text) return 'unknown';
  return text.length <= 8 ? text : text.slice(-8);
}

function meaningfulWords(text, limit = 3) {
  const words = String(text || '')
    .toLowerCase()
    .match(/[a-z0-9][a-z0-9']*/g) || [];
  return words
    .filter((word) => !FILLER_WORDS.has(word))
    .slice(0, limit);
}

function shortRecordLabel(record, text, options = {}) {
  const number = displayNumber(record && record.n);
  const words = meaningfulWords(text, options.wordLimit || 3);
  if (!number) {
    return words.length ? words.join(' ') : shortId(record && record.id);
  }
  const suffix = words.length ? ` ${words.join(' ')}` : '';
  return `#${number}${suffix}`;
}

function shortRecordRef(record) {
  const number = displayNumber(record && record.n);
  return number ? String(number) : shortId(record && record.id);
}

function recordMatchesRef(record, ref, options = {}) {
  if (!record) return false;
  const raw = String(ref || '').trim();
  if (!raw) return false;
  const withoutHash = raw.startsWith('#') ? raw.slice(1) : raw;
  const wantedNumber = displayNumber(withoutHash);
  if (wantedNumber) return displayNumber(record.n) === wantedNumber;
  const id = String(record.id || '').trim();
  if (!id) return false;
  if (id === raw || id === withoutHash) return true;
  if (options.prefix !== false && (id.startsWith(raw) || id.startsWith(withoutHash))) return true;
  if (options.suffix !== false && (id.endsWith(raw) || id.endsWith(withoutHash))) return true;
  return false;
}

module.exports = {
  displayNumber,
  meaningfulWords,
  nextRecordNumber,
  recordMatchesRef,
  shortId,
  shortRecordLabel,
  shortRecordRef,
};
