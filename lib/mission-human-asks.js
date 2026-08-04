'use strict';

function normalizeHumanAsk(ask) {
  if (typeof ask === 'string') {
    return { text: ask, answered_at: null };
  }
  if (!ask || typeof ask !== 'object' || Array.isArray(ask)) {
    return { text: String(ask || ''), answered_at: null };
  }
  return {
    ...ask,
    text: String(ask.text || ''),
    answered_at: ask.answered_at || null,
  };
}

function normalizeHumanAsks(asks) {
  return Array.isArray(asks) ? asks.map(normalizeHumanAsk) : [];
}

function openHumanAsks(asks) {
  return normalizeHumanAsks(asks).filter((ask) => ask.text.trim() && !ask.answered_at);
}

module.exports = {
  normalizeHumanAsks,
  openHumanAsks,
};
