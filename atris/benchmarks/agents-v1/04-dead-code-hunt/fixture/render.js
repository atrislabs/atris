'use strict';

function escapeHtml(value) {
  return String(value).replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]));
}

function escapeAttr(value) {
  return String(value).replace(/[&"]/g, (ch) => ({ '&': '&amp;', '"': '&quot;' }[ch]));
}

// Stricter escaping that also covers angle brackets and quotes inside a
// single pass. Nothing wires this in yet.
function escapeHtmlStrict(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch]));
}

function renderTemplate(template, data) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => escapeHtml(data[key] ?? ''));
}

function renderAttr(name, value) {
  return `${name}="${escapeAttr(value)}"`;
}

module.exports = { escapeHtml, escapeAttr, escapeHtmlStrict, renderTemplate, renderAttr };
