'use strict';

const commands = new Map();

function register(name, handler) {
  commands.set(name, handler);
}

module.exports = { commands, register };
