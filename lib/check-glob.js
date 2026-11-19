'use strict';

// atris check globs. They match the whole path from the repo root. `*` stays
// inside one folder, `**/` spans any number of folders, `?` is one character,
// `{a,b}` is either, and a glob ending in `/` means everything under that folder.

const compiled = new Map();

function globBody(text) {
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '*') {
      if (text[i + 1] === '*') {
        if (text[i + 2] === '/') { out += '(?:.*/)?'; i += 2; } else { out += '.*'; i += 1; }
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') {
      out += '[^/]';
    } else if (ch === '{') {
      const close = text.indexOf('}', i);
      if (close === -1) { out += '\\{'; continue; }
      const options = text.slice(i + 1, close).split(',').map(globBody);
      out += `(?:${options.join('|')})`;
      i = close;
    } else {
      out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return out;
}

function globToRegExp(glob) {
  const key = String(glob || '');
  if (!compiled.has(key)) {
    let text = key.trim().replace(/^\.\//, '');
    if (text.endsWith('/')) text += '**';
    compiled.set(key, new RegExp(`^${globBody(text)}$`));
  }
  return compiled.get(key);
}

function globsMatch(globs, file) {
  return (globs || []).some((glob) => globToRegExp(glob).test(file));
}

function firstMatch(globs, files) {
  return files.find((file) => globsMatch(globs, file)) || null;
}

module.exports = { globToRegExp, globsMatch, firstMatch };
