#!/usr/bin/env python3
"""Round-3 driver: exhaust every orbit system of CW(n,k) with the sharded C DFS.

usage: rundfs3.py n k [--sg] [--max-orbits M] [--full-cap S] [--shard-cap S]
                      [--giant-budget S] [--deadline S] [--T T] [--shard-depth D]

Per system: run dfs2 full-mode with a CPU cap. If it hits the cap, split into
3^D prefix shards and run them sequentially, each with its own CPU cap, until
the per-system budget or the global deadline runs out. Coverage is exact:
COMPLETE, SHARDED-COMPLETE, PARTIAL(shards done/total + capped shard list), or
SKIPPED (deadline).
--sg searches non-cyclic subgroup partitions (doubly-invariant restriction)
instead of cyclic/affine systems.
"""
import sys, os, time, shutil, subprocess

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "round2"))
from search2 import orbit_systems  # noqa: E402
from rundfs import gen_input       # noqa: E402
from subgrp import all_subgroups, is_cyclic, orbits_of_subgroup  # noqa: E402


def systems_cyclic(n, max_orbits):
    for q, h, orbs in orbit_systems(n, max_orbits, affine=True):
        yield (f"q={q} h={h}", orbs)


def systems_sg(n, max_orbits):
    subs = [H for H in all_subgroups(n) if len(H) > 1 and not is_cyclic(H, n)]
    seen = set()
    for H in sorted(subs, key=len):
        orbs = orbits_of_subgroup(n, H)
        if len(orbs) > max_orbits:
            continue
        key = frozenset(frozenset(o) for o in orbs)
        if key in seen:
            continue
        seen.add(key)
        yield (f"|H|={len(H)}", orbs)


def main():
    args = sys.argv[1:]
    n, k = int(args[0]), int(args[1])
    opts = {"--max-orbits": 45, "--full-cap": 120, "--shard-cap": 60,
            "--giant-budget": 1500, "--deadline": 10**9, "--T": 16,
            "--shard-depth": 8}
    sg = "--sg" in args
    for o in list(opts):
        if o in args:
            opts[o] = int(args[args.index(o) + 1])
    t0 = time.time()
    deadline = t0 + opts["--deadline"]
    tag = "sg" if sg else "cyc"
    outdir = f"dfsrun3_{tag}_{n}_{k}"
    os.makedirs(outdir, exist_ok=True)
    shutil.copy("dfs2", os.path.join(outdir, "dfs2"))

    def run_dfs(inp, cap, D=0, S=0):
        r = subprocess.run(["./dfs2", str(cap), str(D), str(S)], input=inp,
                           capture_output=True, text=True, cwd=outdir)
        tail = [l for l in r.stderr.strip().split("\n") if l][-1] if r.stderr else "?"
        if "SOLUTION FOUND" in r.stderr:
            print(f"!!!!! SOLUTION FOUND in {outdir}/dfs_out.txt !!!!!", flush=True)
        return r.returncode, tail

    gen = systems_sg(n, opts["--max-orbits"]) if sg else systems_cyclic(n, opts["--max-orbits"])
    # materialize and sort: small systems first so their completeness locks in
    all_sys = [(name, orbs) for name, orbs in gen]
    all_sys.sort(key=lambda x: len(x[1]))
    results = []
    for name, orbs in all_sys:
        m = len(orbs)
        if time.time() > deadline:
            results.append((name, m, "SKIPPED-DEADLINE", ""))
            print(f"  {name} m={m}: SKIPPED (deadline)", flush=True)
            continue
        inp = gen_input(n, k, 0, 0, orbs, opts["--T"]) if sg else None
        if not sg:
            inp = gen_input(n, k, 0, 0, orbs, opts["--T"])
        st = time.time()
        rc, tail = run_dfs(inp, opts["--full-cap"])
        if rc == 0:
            results.append((name, m, "COMPLETE", tail))
            print(f"  {name} m={m}: COMPLETE [{tail}] {time.time()-st:.1f}s", flush=True)
            continue
        if rc != 3:
            results.append((name, m, f"ERROR rc={rc}", tail))
            print(f"  {name} m={m}: ERROR rc={rc} [{tail}]", flush=True)
            continue
        # giant: shard it
        D = min(opts["--shard-depth"], m - 2)
        tot = 3 ** D
        budget_end = min(time.time() + opts["--giant-budget"], deadline)
        done = 0
        capped = []
        stopped = None
        for S in range(tot):
            if time.time() > budget_end:
                stopped = S
                break
            rc2, _ = run_dfs(inp, opts["--shard-cap"], D, S)
            if rc2 == 0:
                done += 1
            else:
                capped.append(S)
        if stopped is None and not capped:
            results.append((name, m, "SHARDED-COMPLETE", f"D={D} shards={tot}"))
            print(f"  {name} m={m}: SHARDED-COMPLETE D={D} {tot} shards "
                  f"{time.time()-st:.1f}s", flush=True)
        else:
            det = (f"D={D} done={done}/{tot} capped={len(capped)} "
                   f"stopped_at={stopped}")
            results.append((name, m, "PARTIAL", det))
            print(f"  {name} m={m}: PARTIAL {det} {time.time()-st:.1f}s", flush=True)
    ncomp = sum(1 for r in results if "COMPLETE" in r[2])
    print(f"==== CW({n},{k}) {tag} round3: {len(results)} systems, "
          f"{ncomp} complete, t={time.time()-t0:.0f}s ====", flush=True)
    for name, m, status, det in results:
        if "COMPLETE" not in status:
            print(f"  UNFINISHED {name} m={m} {status} {det}", flush=True)


if __name__ == "__main__":
    main()
