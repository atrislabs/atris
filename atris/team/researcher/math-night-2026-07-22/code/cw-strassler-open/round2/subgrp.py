#!/usr/bin/env python3
"""Non-cyclic subgroup orbit search for CW(n,k).

Cyclic systems <q> with huge candidate counts were deferred by search2.
Solutions invariant under a LARGER subgroup H > <q> live in a coarser orbit
partition (fewer orbits) and become exhaustively searchable. This misses
solutions invariant only under the cyclic group, but fully covers the
"doubly-invariant" corner of every deferred system.

Enumerates ALL subgroups of Z_n^* (closure of generator subsets, BFS dedupe),
skips cyclic ones (already handled by search2), and runs the exact same
search_system pipeline (h=0 only) on each partition within caps.
"""
import sys, time
from math import gcd
from search2 import search_system


def all_subgroups(n):
    units = [u for u in range(1, n) if gcd(u, n) == 1]

    def closure(gens):
        S = {1}
        frontier = [1]
        while frontier:
            x = frontier.pop()
            for g in gens:
                y = (x * g) % n
                if y not in S:
                    S.add(y)
                    frontier.append(y)
        return frozenset(S)

    subs = {frozenset([1])}
    frontier = [frozenset([1])]
    while frontier:
        H = frontier.pop()
        for u in units:
            if u in H:
                continue
            H2 = closure(set(H) | {u})
            if H2 not in subs:
                subs.add(H2)
                frontier.append(H2)
    return subs


def is_cyclic(H, n):
    Hs = set(H)
    for g in H:
        S = {1}
        y = g
        while y not in S:
            S.add(y)
            y = (y * g) % n
        if S == Hs:
            return True
    return False


def orbits_of_subgroup(n, H):
    seen = [False] * n
    orbs = []
    for x in range(n):
        if not seen[x]:
            o = sorted({(x * g) % n for g in H})
            for y in o:
                seen[y] = True
            orbs.append(o)
    return orbs


def run(n, k, max_orbits=45, cand_cap=2_000_000_000):
    t0 = time.time()
    subs = all_subgroups(n)
    noncyc = [H for H in subs if len(H) > 1 and not is_cyclic(H, n)]
    print(f"CW({n},{k}): {len(subs)} subgroups of Z_{n}^*, {len(noncyc)} non-cyclic", flush=True)
    seen_part = set()
    found_all = []
    deferred = []
    for H in sorted(noncyc, key=len):
        orbs = orbits_of_subgroup(n, H)
        if len(orbs) > max_orbits:
            continue
        key = frozenset(frozenset(o) for o in orbs)
        if key in seen_part:
            continue
        seen_part.add(key)
        gens_desc = f"|H|={len(H)}"
        print(f" subgroup {gens_desc} m={len(orbs)}", flush=True)
        f, complete, nc = search_system(n, k, 0, 0, orbs, cand_cap=cand_cap)
        found_all += f
        if not complete:
            deferred.append((gens_desc, len(orbs), nc))
    print(f"CW({n},{k}) subgroup pass done: found={len(found_all)}, "
          f"deferred={deferred}, t={time.time()-t0:.0f}s", flush=True)


if __name__ == "__main__":
    n, k = int(sys.argv[1]), int(sys.argv[2])
    run(n, k)
