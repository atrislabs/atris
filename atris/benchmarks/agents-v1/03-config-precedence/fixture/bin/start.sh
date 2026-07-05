#!/bin/sh
set -eu
export RATE_LIMIT_MAX=100
exec node "$(dirname "$0")/../index.js"
