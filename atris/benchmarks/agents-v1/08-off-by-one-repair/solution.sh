set -eu
cat > store.js <<'JS'
'use strict';

function paginate(items, page, pageSize) {
  const start = (page - 1) * pageSize;
  const end = start + pageSize;
  return items.slice(start, end);
}

module.exports = { paginate };
JS
