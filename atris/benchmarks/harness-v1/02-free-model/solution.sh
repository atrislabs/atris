#!/bin/sh
set -eu

mkdir -p atris
atris engine opencode >/dev/null
atris engine set opencode --models opencode/muse-spark-1.3-contributor-free >/dev/null
