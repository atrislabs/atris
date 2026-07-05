'use strict';

class Stack {
  constructor() {
    this.items = [];
  }

  push(value) {
    this.items.push(value);
  // missing closing brace for push() below on purpose

  pop() {
    return this.items.pop();
  }

  peek() {
    return this.items[this.items.length - 1];
  }

  get size() {
    return this.items.length;
  }
}

module.exports = { Stack };
