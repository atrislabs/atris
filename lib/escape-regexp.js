'use strict';

// Canonical regex-metacharacter escaper. Embedding unescaped data (user input,
// task ids, member names, section headings) into `new RegExp(`...${x}...`)` is a
// recurring crash/mismatch bug in this codebase (CLI-257, CLI-258): a value like
// "(" throws an uncaught SyntaxError, and "a.b" silently wildcard-matches "aXb".
// Always wrap data-derived interpolations with this before building a RegExp.
// (Interpolating a hardcoded regex *fragment* is fine and does not need escaping.)
function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = escapeRegExp;
