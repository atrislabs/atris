#!/usr/bin/env bash
# atris computer pr: one shared copy of each repo, one light working folder per run.
#   prepare <owner> <name> <branch> [base]  makes a run folder on a new branch (safe to call twice)
#   finish <run_dir> <branch>               pushes the branch, then removes the folder
#   abort <run_dir>                         removes the folder, keeps any commits
# Everything lives under ROOT. Nothing outside it is ever deleted.
set -eu
ROOT="${ATRIS_PR_ROOT:-/workspace/repos/.atris-pr}"
REMOTE_BASE="${ATRIS_PR_REMOTE_BASE:-https://github.com}"
STALE_MINUTES="${ATRIS_PR_STALE_MINUTES:-360}"
LOCK_WAIT="${ATRIS_PR_LOCK_WAIT:-900}"
MIRRORS="$ROOT/mirrors"
RUNS="$ROOT/runs"
LOCK_HELD=""
export GIT_TERMINAL_PROMPT=0

say() { printf '%s\n' "$*"; }
die() { say "PR_SCRIPT_ERROR=$*" >&2; exit 1; }

[ "$(basename "$ROOT")" = ".atris-pr" ] || die "ROOT must end in .atris-pr, got $ROOT"

hash_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum | cut -c1-64; else shasum -a 256 | cut -c1-64; fi
}

# The file is named pr-<first 12 of its hash>.sh. A copy that was changed in any
# way (other than line endings or trailing spaces) refuses to run.
selfcheck() {
  want="$(basename "$0" .sh)"
  want="${want#pr-}"
  got="$(tr -d '\r' < "$0" | awk '{sub(/[ \t]+$/, ""); a[NR]=$0} END {n=NR; while (n>0 && a[n]=="") n--; for (i=1; i<=n; i++) print a[i]}' | hash_of | cut -c1-12)"
  [ "$want" = "$got" ] || die "script check failed (file hash $got, name says $want); write the file again exactly"
}

# git with the GitHub token passed for this one command only, never stored.
g() {
  if [ -n "${GITHUB_TOKEN:-}" ]; then
    git -c "http.extraheader=Authorization: Basic $(printf 'x-access-token:%s' "$GITHUB_TOKEN" | base64 | tr -d '\n')" "$@"
  else
    git "$@"
  fi
}

lock() {
  if command -v flock >/dev/null 2>&1; then
    exec 9>"$1"
    flock -w "$LOCK_WAIT" 9 || die "another run held the repo lock for over $LOCK_WAIT seconds; try again later"
    LOCK_HELD="flock"
  else
    waited=0
    until mkdir "$1.d" 2>/dev/null; do
      if [ -n "$(find "$1.d" -maxdepth 0 -mmin +60 2>/dev/null)" ]; then rmdir "$1.d" 2>/dev/null || true; continue; fi
      waited=$((waited + 1))
      [ "$waited" -lt "$LOCK_WAIT" ] || die "another run held the repo lock for over $LOCK_WAIT seconds; try again later"
      sleep 1
    done
    LOCK_HELD="$1.d"
  fi
}

unlock() {
  if [ "$LOCK_HELD" = "flock" ]; then exec 9>&-; elif [ -n "$LOCK_HELD" ]; then rmdir "$LOCK_HELD" 2>/dev/null || true; fi
  LOCK_HELD=""
}

lock_for_mirror() { printf '%s.lock' "${1%.git}"; }

# Remove run folders where nothing changed for STALE_MINUTES. Only inside RUNS.
sweep() {
  mkdir -p "$RUNS" "$MIRRORS"
  removed=0
  for d in "$RUNS"/*/; do
    [ -d "$d" ] || continue
    d="${d%/}"
    if [ -z "$(find "$d" -mmin "-$STALE_MINUTES" -print -quit 2>/dev/null)" ]; then
      rm -rf -- "$d"
      removed=$((removed + 1))
    fi
  done
  if [ "$removed" -gt 0 ]; then
    for m in "$MIRRORS"/*.git; do
      [ -d "$m" ] || continue
      lock "$(lock_for_mirror "$m")"
      git -C "$m" worktree prune
      unlock
    done
    say "SWEPT=$removed old run folders"
  fi
}

# Old full clones from before this script: report their size, never touch them.
old_clones() {
  parent="$(dirname "$ROOT")"
  n=0
  kb=0
  for c in "$parent"/*/; do
    c="${c%/}"
    [ -e "$c/.git" ] || continue
    n=$((n + 1))
    s="$(du -sk "$c" 2>/dev/null | awk '{print $1}')"
    kb=$((kb + ${s:-0}))
  done
  if [ "$n" -gt 0 ]; then
    say "OLD_CLONES=$n full copies use about $((kb / 1024)) MB in $parent (left alone)"
  fi
}

valid_name() {
  case "$1" in
    ''|.*|*[!A-Za-z0-9._-]*) die "bad repo part: $1" ;;
  esac
}

valid_branch() {
  git check-ref-format --branch "$1" >/dev/null 2>&1 || die "bad branch name: $1"
}

prepare_failed() {
  status=$?
  if [ -n "${run_dir:-}" ] && [ -d "$run_dir" ]; then
    git -C "$mirror" worktree remove --force "$run_dir" >/dev/null 2>&1 || rm -rf -- "$run_dir"
    git -C "$mirror" branch -D "$branch" >/dev/null 2>&1 || true
    git -C "$mirror" worktree prune
  fi
  unlock
  exit "$status"
}

# The branch is already here, so this is a second prepare for the same run (the
# first call was slow or cut off and the caller tried again). Hand back the same
# folder when it holds no work, clear one that was never finished, and refuse
# to touch a branch or folder that has work in it.
existing_run() {
  taken="branch $branch already exists on this computer; use a new branch name"
  git -C "$mirror" merge-base --is-ancestor "refs/heads/$branch" "refs/remotes/origin/$base" 2>/dev/null || die "$taken"
  old="$(git -C "$mirror" worktree list --porcelain | awk -v b="refs/heads/$branch" '/^worktree / {w=substr($0, 10)} /^branch / {if (substr($0, 8) == b) {print w; exit}}')"
  found=""
  [ -z "$old" ] || found="$RUNS/$(basename "$old")"
  case "$found" in *..*) found="" ;; esac
  if [ -n "$found" ] && [ -d "$found" ]; then
    gd="$(git -C "$found" rev-parse --absolute-git-dir 2>/dev/null || true)"
    if [ -n "$gd" ] && [ -f "$gd/atris-base" ]; then
      changes="$(git -C "$found" status --porcelain 2>/dev/null)" || changes="unreadable"
      [ -z "$changes" ] || die "$taken"
      reuse="$found"
      return 0
    fi
    run_dir="$found"
    git -C "$mirror" worktree remove --force "$run_dir" >/dev/null 2>&1 || rm -rf -- "$run_dir"
    run_dir=""
  fi
  git -C "$mirror" worktree prune
  git -C "$mirror" branch -D "$branch" >/dev/null 2>&1 || die "$taken"
}

prepare() {
  [ "$#" -ge 3 ] || die "usage: prepare <owner> <name> <branch> [base]"
  owner="$1"; name="$2"; branch="$3"; base="${4:-}"
  valid_name "$owner"; valid_name "$name"; valid_branch "$branch"
  [ -z "$base" ] || valid_branch "$base"
  sweep
  old_clones
  mirror="$MIRRORS/${owner}__${name}.git"
  run_dir=""
  trap prepare_failed EXIT
  trap 'exit 130' INT TERM
  lock "$(lock_for_mirror "$mirror")"
  if [ ! -d "$mirror" ]; then
    git init --bare --quiet "$mirror"
    git -C "$mirror" remote add origin "$REMOTE_BASE/$owner/$name.git"
  fi
  g -C "$mirror" fetch --prune --quiet origin || die "could not fetch $owner/$name"
  default="$(g -C "$mirror" ls-remote --symref origin HEAD | awk '/^ref:/ {sub("refs/heads/", "", $2); print $2; exit}')"
  [ -n "$default" ] || die "could not read the default branch of $owner/$name"
  [ -n "$base" ] || base="$default"
  git -C "$mirror" rev-parse --verify --quiet "refs/remotes/origin/$base^{commit}" >/dev/null || die "branch $base is not on the remote"
  reuse=""
  if git -C "$mirror" rev-parse --verify --quiet "refs/heads/$branch" >/dev/null; then
    existing_run
  fi
  if [ -n "$reuse" ]; then
    unlock
    trap - EXIT INT TERM
    say "RUN_DIR=$reuse"
    say "BASE=$base"
    say "DEFAULT_BRANCH=$default"
    return 0
  fi
  slug="$(printf '%s' "$name--$branch" | tr -c 'A-Za-z0-9._-' '-' | cut -c1-80)"
  run_dir="$(mktemp -d "$RUNS/$slug.XXXXXX")"
  git -C "$mirror" worktree add --quiet --no-track -b "$branch" "$run_dir" "refs/remotes/origin/$base"
  git -C "$run_dir" rev-parse HEAD > "$(git -C "$run_dir" rev-parse --absolute-git-dir)/atris-base"
  unlock
  trap - EXIT INT TERM
  say "RUN_DIR=$run_dir"
  say "BASE=$base"
  say "DEFAULT_BRANCH=$default"
}

run_parts() {
  case "$1" in
    "$RUNS"/*) ;;
    *) die "not a run folder: $1" ;;
  esac
  case "$1" in *..*) die "not a run folder: $1" ;; esac
  [ -d "$1" ] || die "run folder is gone: $1"
  mirror="$(cd "$1" && cd "$(git rev-parse --git-common-dir)" && pwd)"
  gitdir="$(git -C "$1" rev-parse --absolute-git-dir)"
  base_commit="$(cat "$gitdir/atris-base" 2>/dev/null || true)"
  cur="$(git -C "$1" rev-parse --abbrev-ref HEAD)"
}

# Remove the run folder. Drop the branch when its work is safe elsewhere
# (pushed) or there is none; otherwise keep it so no commit is lost.
remove_run() {
  keep="$1"
  lock "$(lock_for_mirror "$mirror")"
  git -C "$mirror" worktree remove --force "$run_dir" >/dev/null 2>&1 || rm -rf -- "$run_dir"
  git -C "$mirror" worktree prune
  if [ "$keep" = "keep" ]; then
    say "KEPT_BRANCH=$cur (its commits are saved in $mirror)"
  else
    git -C "$mirror" branch -D "$cur" >/dev/null 2>&1 || true
  fi
  unlock
  say "REMOVED=$run_dir"
}

finish_exit() {
  status=$?
  unlock
  if [ "$pushed" = 1 ] || [ "$no_change" = 1 ]; then remove_run drop; else remove_run keep; fi
  exit "$status"
}

finish() {
  [ "$#" -eq 2 ] || die "usage: finish <run_dir> <branch>"
  run_dir="$1"; branch="$2"
  run_parts "$run_dir"
  [ "$cur" = "$branch" ] || die "the run folder is on $cur, not $branch"
  if [ -n "$(git -C "$run_dir" status --porcelain)" ]; then
    die "there are changes not committed yet; commit them, then run finish again"
  fi
  head="$(git -C "$run_dir" rev-parse HEAD)"
  pushed=0
  no_change=0
  trap finish_exit EXIT
  trap 'exit 130' INT TERM
  if [ "$head" = "$base_commit" ]; then
    no_change=1
    say "NO_CHANGES=1"
    exit 3
  fi
  lock "$(lock_for_mirror "$mirror")"
  g -C "$run_dir" push --quiet origin "refs/heads/$branch:refs/heads/$branch" || die "push of $branch failed"
  unlock
  pushed=1
  say "PUSHED=$branch"
  say "COMMIT=$head"
}

abort() {
  [ "$#" -eq 1 ] || die "usage: abort <run_dir>"
  run_dir="$1"
  run_parts "$run_dir"
  if [ "$(git -C "$run_dir" rev-parse HEAD)" = "$base_commit" ]; then remove_run drop; else remove_run keep; fi
}

selfcheck
cmd="${1:-}"
[ "$#" -eq 0 ] || shift
case "$cmd" in
  prepare) prepare "$@" ;;
  finish) finish "$@" ;;
  abort) abort "$@" ;;
  *) die "usage: prepare | finish | abort" ;;
esac
