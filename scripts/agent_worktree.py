#!/usr/bin/env python3
"""Compatibility wrapper for older agent worktree instructions.

Use the canonical Atris CLI:
  atris worktree start --agent <agent> --task "<task>"
"""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="scripts/agent_worktree.py",
        description="Compatibility wrapper around `atris worktree start`.",
    )
    subcommands = parser.add_subparsers(dest="command", required=True)

    create = subcommands.add_parser("create", help="Create an Atris agent worktree.")
    owner = create.add_mutually_exclusive_group(required=True)
    owner.add_argument("--agent")
    owner.add_argument("--member")
    create.add_argument("--task", required=True)
    create.add_argument("--base")
    create.add_argument("--path")
    create.add_argument("--branch")
    create.add_argument("--claim", action="store_true")
    return parser


def main(argv: list[str]) -> int:
    args = build_parser().parse_args(argv)
    repo_root = Path(__file__).resolve().parents[1]
    atris_bin = repo_root / "bin" / "atris.js"

    # Run the Node CLI directly so this wrapper works before a global `atris`
    # binary is on PATH.
    command = ["node", str(atris_bin), "worktree", "start"]
    display = ["atris", "worktree", "start"]
    if args.member:
        command += ["--member", args.member]
        display += ["--member", args.member]
    else:
        command += ["--agent", args.agent]
        display += ["--agent", args.agent]
    command += ["--task", args.task]
    display += ["--task", args.task]
    if args.base:
        command += ["--base", args.base]
        display += ["--base", args.base]
    if args.path:
        command += ["--path", args.path]
        display += ["--path", args.path]
    if args.branch:
        command += ["--branch", args.branch]
        display += ["--branch", args.branch]
    if args.claim:
        command.append("--claim")
        display.append("--claim")

    print("compat: scripts/agent_worktree.py maps to:")
    print(f"  {' '.join(display)}")
    result = subprocess.run(command)
    return int(result.returncode or 0)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
