#!/usr/bin/env python3
"""Drive the C DFS over non-cyclic subgroup orbit partitions of Z_n^*.
usage: rundfs_sg.py n k [max_orbits] [cap_s] [T]
"""
import sys, subprocess, time, os, shutil
import numpy as np
from subgrp import all_subgroups, is_cyclic, orbits_of_subgroup


def gen_input_generic(n, k, orbs, T):
    m = len(orbs)
    t_arr = np.arange(n)
    Ihat = np.zeros((m, n), dtype=np.complex128)
    for i, o in enumerate(orbs):
        Ihat[i] = np.exp(2j * np.pi * (np.array(o)[:, None] * t_arr[None, :]) / n).sum(axis=0)
    reps = list(range(1, n))
    mass = {t: float(np.sum(np.abs(Ihat[:, t]))) for t in reps}
    picks = sorted(reps, key=lambda t: mass[t])[:T]
    score = [(-float(np.sum(np.abs(Ihat[i, picks]))), i) for i in range(m)]
    order = [i for _, i in sorted(score)]
    lines = [f"{n} {k} {m} {len(picks)}"]
    lines.append(" ".join(str(len(orbs[i])) for i in order))
    for t in picks:
        row = [str(t)]
        for i in order:
            z = Ihat[i, t]
            row.append(f"{z.real:.17g} {z.imag:.17g}")
        lines.append(" ".join(row))
    for i in order:
        lines.append(f"{len(orbs[i])} " + " ".join(str(x) for x in orbs[i]))
    return "\n".join(lines) + "\n"


def main():
    n, k = int(sys.argv[1]), int(sys.argv[2])
    max_orbits = int(sys.argv[3]) if len(sys.argv) > 3 else 60
    cap = int(sys.argv[4]) if len(sys.argv) > 4 else 900
    T = int(sys.argv[5]) if len(sys.argv) > 5 else 12
    outdir = f"dfsrun_sg_{n}_{k}"
    os.makedirs(outdir, exist_ok=True)
    shutil.copy("dfs", os.path.join(outdir, "dfs"))
    t0 = time.time()
    subs = [H for H in all_subgroups(n) if len(H) > 1 and not is_cyclic(H, n)]
    print(f"{len(subs)} non-cyclic subgroups", flush=True)
    seen_part = set()
    incomplete = []
    nsys = 0
    for H in sorted(subs, key=len):
        orbs = orbits_of_subgroup(n, H)
        if len(orbs) > max_orbits:
            continue
        key = frozenset(frozenset(o) for o in orbs)
        if key in seen_part:
            continue
        seen_part.add(key)
        nsys += 1
        inp = gen_input_generic(n, k, orbs, T)
        st = time.time()
        r = subprocess.run(["./dfs", str(cap)], input=inp, capture_output=True,
                           text=True, cwd=outdir)
        tail = [l for l in r.stderr.strip().split("\n") if l][-1] if r.stderr else "?"
        status = "COMPLETE" if r.returncode == 0 else ("TIMECAP" if r.returncode == 3 else f"rc={r.returncode}")
        if status != "COMPLETE":
            incomplete.append((len(H), len(orbs)))
        print(f"  |H|={len(H)} m={len(orbs)}: {status} [{tail}] {time.time()-st:.1f}s",
              flush=True)
    print(f"CW({n},{k}) subgroup cdfs: {nsys} systems, incomplete={incomplete}, "
          f"t={time.time()-t0:.0f}s", flush=True)


if __name__ == "__main__":
    main()
