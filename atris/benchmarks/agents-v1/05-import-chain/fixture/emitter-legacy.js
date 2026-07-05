'use strict';

class EventEmitter {
  constructor() {
    this.handlers = {};
  }

  on(event, fn) {
    if (!this.handlers[event]) this.handlers[event] = [];
    this.handlers[event].push(fn);
  }

  emit(event, ...args) {
    (this.handlers[event] || []).forEach((fn) => fn(...args));
  }
}

module.exports = { EventEmitter };
