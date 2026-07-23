#!/usr/bin/env python3
"""Generate dfs.c input for one orbit system of CW(n,k).

usage: gendfs.py n k q h [T] > input.txt
Picks T pruning frequencies (dual-orbit representatives with smallest total
|z| mass => tightest suffix bounds), orders orbits by descending character
mass so bounds bite early.
"""
import sys
import numpy as np
from search2 import orbit_systems


def main():
    n, k, q, h = (int(x) for x in sys.argv[1:5])
    T = int(sys.argv[5]) if len(sys.argv) > 5 else 10
    target = None
    for q2, h2, orbs in orbit_systems(n, 100, affine=True):
        if q2 == q and h2 == h:
            target = orbs
            break
    assert target is not None, f"system q={q} h={h} not found"
    orbs = target
    m = len(orbs)
    t_arr = np.arange(n)
    Ihat = np.zeros((m, n), dtype=np.complex128)
    for i, o in enumerate(orbs):
        Ihat[i] = np.exp(2j * np.pi * (np.array(o)[:, None] * t_arr[None, :]) / n).sum(axis=0)
    # dual orbit reps: t ~ q*t mod n (character constraints repeat on these
    # orbits only when h==0; for h>0 just use all t and pick greedily)
    reps = []
    seen = set()
    for t in range(1, n):
        if t in seen:
            continue
        o = set()
        y = t
        while y not in o:
            o.add(y)
            y = (y * q) % n
        seen |= o
        reps.append(t)
    mass = {t: float(np.sum(np.abs(Ihat[:, t]))) for t in reps}
    picks = sorted(reps, key=lambda t: mass[t])[:T]
    # orbit order: descending total |z| over picked freqs
    score = [(-float(np.sum(np.abs(Ihat[i, picks]))), i) for i in range(m)]
    order = [i for _, i in sorted(score)]
    print(n, k, m, len(picks))
    print(" ".join(str(len(orbs[i])) for i in order))
    for t in picks:
        row = [str(t)]
        for i in order:
            z = Ihat[i, t]
            row.append(f"{z.real:.17g} {z.imag:.17g}")
        print(" ".join(row))
    for i in order:
        print(len(orbs[i]), " ".join(str(x) for x in orbs[i]))
    sys.stderr.write(f"system n={n} k={k} q={q} h={h} m={m} T={len(picks)} "
                     f"freqs={picks}\n")


if __name__ == "__main__":
    main()
