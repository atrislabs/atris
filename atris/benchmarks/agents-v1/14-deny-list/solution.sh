set -eu
cat > render.js <<'JS'
'use strict';

const { label } = require('./labels');

function renderStatus(code) {
  return label(String(code).toLowerCase());
}

module.exports = { renderStatus };
JS
