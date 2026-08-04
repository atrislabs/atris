// Shared JSON file read/write so every call site fails the same way.
//
// Bare `JSON.parse(fs.readFileSync(...))` drifted across commands: some sites
// caught, some returned null, some returned {}. These two helpers keep the
// tolerant shape in one place.

const fs = require('fs');
const path = require('path');

/**
 * Read and parse a JSON file, returning `fallback` when it is missing or corrupt.
 * @param {string} filePath
 * @param {*} [fallback=null]
 * @returns {*}
 */
function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

/**
 * Write a value as pretty JSON with a trailing newline, creating parent dirs.
 * @param {string} filePath
 * @param {*} value
 * @param {{ indent?: number }} [options]
 * @returns {string} the path written
 */
function writeJson(filePath, value, { indent = 2 } = {}) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, indent) + '\n', 'utf8');
  return filePath;
}

module.exports = { readJson, writeJson };
