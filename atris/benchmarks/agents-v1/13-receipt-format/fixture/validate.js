'use strict';

function isEmail(value) {
  const text = String(value).trim();
  return /^[^\s@]+@[a-z]+$/.test(text);
}

module.exports = { isEmail };
