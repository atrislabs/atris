#!/usr/bin/env python3
"""Deterministic repair around near-miss states.

Repeatedly: collect many good=1 states via short SA, then for each try
ALL single pair-moves, and all 2-move combos where at least one move touches
the offending vertex. Reports if any reaches good=0.
"""
import sys, time
import numpy as np
from local_search import score, anneal, rng

def all_states(old):
    return [s for s in [(0,0),(1,0),(0,1)] if s != old]

def try_repair(A):
    n = A.shape[0]
    g, s = score(A)
    pairs = [(i, j) for i in range(n) for j in range(i+1, n)]
    # single moves
    for (i, j) in pairs:
        old = (A[i,j], A[j,i])
        for st in all_states(old):
            A[i,j], A[j,i] = st
            g2, s2 = score(A)
            if g2 == 0:
                return A.copy()
            A[i,j], A[j,i] = old
    # two moves: first touches the bad vertex
    out = A.sum(1)
    P2 = (A.astype(np.int16) @ A.astype(np.int16)) > 0
    spp = (P2 & ~A.astype(bool) & ~np.eye(n, dtype=bool)).sum(1)
    bad = [v for v in range(n) if spp[v] >= out[v]]
    touch = [(i, j) for (i, j) in pairs if i in bad or j in bad]
    for (i, j) in touch:
        old1 = (A[i,j], A[j,i])
        for st1 in all_states(old1):
            A[i,j], A[j,i] = st1
            for (k, l) in pairs:
                if (k, l) == (i, j):
                    continue
                old2 = (A[k,l], A[l,k])
                for st2 in all_states(old2):
                    A[k,l], A[l,k] = st2
                    g2, s2 = score(A)
                    if g2 == 0:
                        return A.copy()
                A[k,l], A[l,k] = old2
            A[i,j], A[j,i] = old1
    return None

if __name__ == '__main__':
    n = int(sys.argv[1])
    total_secs = float(sys.argv[2]) if len(sys.argv) > 2 else 300
    t_end = time.time() + total_secs
    tried = 0
    while time.time() < t_end:
        g, s, A = anneal(n, 15)
        if A is None:
            continue
        if g == 0:
            np.savetxt(f'cert_polish_n{n}.txt', A, fmt='%d', delimiter='')
            print(f"FOUND during anneal n={n}"); sys.exit(0)
        if g <= 2:
            tried += 1
            R = try_repair(A)
            if R is not None:
                np.savetxt(f'cert_polish_n{n}.txt', R, fmt='%d', delimiter='')
                print(f"FOUND by repair n={n}"); sys.exit(0)
    print(f"n={n}: polished {tried} good=1 states, none repairable to good=0", flush=True)
