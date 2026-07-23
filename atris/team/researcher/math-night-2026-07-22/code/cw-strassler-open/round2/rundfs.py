#!/usr/bin/env python3
"""Drive the C branch-and-bound DFS over every orbit system of a target CW(n,k).

For each (q,h) system with orbit count <= max_orbits (affine included), write
the dfs input, run ./dfs with a per-system time cap, record COMPLETE/INCOMPLETE.
Solutions accumulate in dfs_out.txt (exact-checked in C, re-verified externally).

usage: rundfs.py n k [max_orbits] [per_system_cap_s] [T]
"""
import sys, subprocess, time, os, shutil
import numpy as np
from search2 import orbit_systems


def gen_input(n, k, q, h, orbs, T):
    m = len(orbs)
    t_arr = np.arange(n)
    Ihat = np.zeros((m, n), dtype=np.complex128)
    for i, o in enumerate(orbs):
        Ihat[i] = np.exp(2j * np.pi * (np.array(o)[:, None] * t_arr[None, :]) / n).sum(axis=0)
    reps = []
    seen = set()
    for t in range(1, n):
        if t in seen:
            continue
        o = set()
        y = t
        while y not in o:
            o.add(y)
            y = (y * q) % n if q else n  # q=0 (subgroup mode) -> all t
        if q:
            seen |= o
        else:
            seen.add(t)
        reps.append(t)
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
    max_orbits = int(sys.argv[3]) if len(sys.argv) > 3 else 48
    cap = int(sys.argv[4]) if len(sys.argv) > 4 else 900
    T = int(sys.argv[5]) if len(sys.argv) > 5 else 12
    t0 = time.time()
    outdir = f"dfsrun_{n}_{k}"
    os.makedirs(outdir, exist_ok=True)
    shutil.copy("dfs", os.path.join(outdir, "dfs"))
    nsys = ncomp = 0
    incomplete = []
    for q, h, orbs in orbit_systems(n, max_orbits, affine=True):
        nsys += 1
        inp = gen_input(n, k, q, h, orbs, T)
        st = time.time()
        r = subprocess.run(["./dfs", str(cap)], input=inp, capture_output=True,
                           text=True, cwd=outdir)
        tail = [l for l in r.stderr.strip().split("\n") if l][-1] if r.stderr else "?"
        status = "COMPLETE" if r.returncode == 0 else ("TIMECAP" if r.returncode == 3 else f"rc={r.returncode}")
        if status == "COMPLETE":
            ncomp += 1
        else:
            incomplete.append((q, h, len(orbs)))
        print(f"  q={q} h={h} m={len(orbs)}: {status} [{tail}] {time.time()-st:.1f}s",
              flush=True)
    print(f"CW({n},{k}) cdfs pass: {nsys} systems, {ncomp} complete, "
          f"incomplete={incomplete}, t={time.time()-t0:.0f}s", flush=True)


if __name__ == "__main__":
    main()
