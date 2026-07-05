#!/usr/bin/env bash
# Materialize distribution/hermes-tap/ as a standalone, push-ready git repo.
# Usage: bash distribution/publish-tap.sh [dest-dir]
set -euo pipefail

SRC="$(cd "$(dirname "$0")/hermes-tap" && pwd)"
DEST="${1:-/private/tmp/hermes-tap}"

if [ ! -f "$SRC/README.md" ]; then
  echo "tap source not found at $SRC" >&2
  exit 1
fi

rm -rf "$DEST"
mkdir -p "$DEST"
cp -R "$SRC/." "$DEST/"

cd "$DEST"
git init -q
git add .
git commit -q -m "Atris agent skills tap: atris, autopilot, wiki, engines"

echo "tap ready at $DEST"
echo "next: cd $DEST && gh repo create atrislabs/hermes-tap --public --source=. --push"
