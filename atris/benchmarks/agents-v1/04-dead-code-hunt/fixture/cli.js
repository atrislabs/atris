'use strict';

const { renderTemplate, renderAttr } = require('./render');

const html = renderTemplate('<p>{{name}}</p>', { name: process.argv[2] || 'world' });
const attr = renderAttr('data-id', process.argv[3] || '1');
console.log(`${html} ${attr}`);
