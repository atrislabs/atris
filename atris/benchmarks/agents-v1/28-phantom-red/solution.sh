set -eu
cat > retry.js <<'JS'
'use strict';

function backoffMs(attempt) {
  return 100 * 2 ** (attempt - 1);
}

module.exports = { backoffMs };
JS
