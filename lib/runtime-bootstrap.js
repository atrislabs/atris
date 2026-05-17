const fs = require('fs');
const path = require('path');

function getAtrisPackageVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    return pkg.version || null;
  } catch {
    return null;
  }
}

function writeRuntimeReceipt(workspaceRoot, fields = {}) {
  const stateDir = path.join(workspaceRoot, '.atris', 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const receipt = {
    schema: 'atris.runtime.v1',
    scope: fields.scope || 'local',
    boundary: fields.boundary || 'manual',
    atris_version: fields.atris_version || getAtrisPackageVersion(),
    install_status: fields.install_status || 'recorded',
    sync_status: fields.sync_status || 'recorded',
    updated_at: fields.updated_at || new Date().toISOString(),
    ...fields,
  };
  const filePath = path.join(stateDir, 'runtime.json');
  fs.writeFileSync(filePath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  return { filePath, receipt };
}

function shellQuote(value) {
  return `'${String(value || '').replace(/'/g, `'\\''`)}'`;
}

function buildRemoteAtrisBootstrapCommand(options = {}) {
  const boundary = options.boundary || 'computer-wake';
  const businessSlug = options.businessSlug || '';
  const workspaceId = options.workspaceId || '';
  const businessId = options.businessId || '';

  return [
    'set +e',
    'WORKSPACE="/workspace"',
    'STATE_DIR="$WORKSPACE/.atris/state"',
    'mkdir -p "$STATE_DIR"',
    'RUNTIME_FILE="$STATE_DIR/runtime.json"',
    'sanitize() { printf "%s" "$1" | tr "\\n\\r" "  " | sed "s/[\\\\\\\"]/ /g" | cut -c1-160; }',
    'version_text() { if command -v atris >/dev/null 2>&1; then atris version 2>/dev/null || atris --version 2>/dev/null || true; fi; }',
    'BEFORE="$(sanitize "$(version_text)")"',
    '[ -n "$BEFORE" ] || BEFORE="missing"',
    'INSTALL_STATUS="skipped"',
    'SYNC_STATUS="skipped"',
    'RECOVERY_COMMAND=""',
    'if [ "${ATRIS_SKIP_RUNTIME_BOOTSTRAP:-}" = "1" ]; then',
    '  INSTALL_STATUS="skipped_env"',
    'elif command -v npm >/dev/null 2>&1; then',
    '  if npm install -g atris@latest >/tmp/atris-runtime-bootstrap-npm.log 2>&1; then',
    '    INSTALL_STATUS="installed_latest"',
    '  else',
    '    INSTALL_STATUS="failed"',
    '    RECOVERY_COMMAND="npm install -g atris@latest"',
    '  fi',
    'else',
    '  INSTALL_STATUS="failed_no_npm"',
    '  RECOVERY_COMMAND="install node/npm, then npm install -g atris@latest"',
    'fi',
    'AFTER="$(sanitize "$(version_text)")"',
    '[ -n "$AFTER" ] || AFTER="missing"',
    'if command -v atris >/dev/null 2>&1 && [ -d "$WORKSPACE/atris" ]; then',
    '  if (cd "$WORKSPACE" && ATRIS_SKIP_UPDATE_CHECK=1 atris update >/tmp/atris-runtime-bootstrap-sync.log 2>&1); then',
    '    SYNC_STATUS="synced"',
    '  else',
    '    SYNC_STATUS="failed"',
    '  fi',
    'fi',
    'UPDATED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"',
    `BOUNDARY=${shellQuote(boundary)}`,
    `BUSINESS_SLUG=${shellQuote(businessSlug)}`,
    `BUSINESS_ID=${shellQuote(businessId)}`,
    `WORKSPACE_ID=${shellQuote(workspaceId)}`,
    'cat > "$RUNTIME_FILE" <<JSON',
    '{',
    '  "schema": "atris.runtime.v1",',
    '  "scope": "remote-business-computer",',
    '  "boundary": "$BOUNDARY",',
    '  "business_slug": "$BUSINESS_SLUG",',
    '  "business_id": "$BUSINESS_ID",',
    '  "workspace_id": "$WORKSPACE_ID",',
    '  "atris_before": "$BEFORE",',
    '  "atris_after": "$AFTER",',
    '  "install_status": "$INSTALL_STATUS",',
    '  "sync_status": "$SYNC_STATUS",',
    '  "recovery_command": "$RECOVERY_COMMAND",',
    '  "updated_at": "$UPDATED_AT"',
    '}',
    'JSON',
    'echo "atris_runtime_bootstrap install=$INSTALL_STATUS version=$AFTER sync=$SYNC_STATUS receipt=.atris/state/runtime.json"',
    'if [ -n "$RECOVERY_COMMAND" ]; then echo "recovery=$RECOVERY_COMMAND"; fi',
    'exit 0',
  ].join('\n');
}

module.exports = {
  buildRemoteAtrisBootstrapCommand,
  getAtrisPackageVersion,
  writeRuntimeReceipt,
};
