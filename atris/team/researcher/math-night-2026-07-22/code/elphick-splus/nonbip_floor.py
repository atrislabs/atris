#!/usr/bin/env python3
"""Exact floors of s+-(n-1) and s--(n-1) over connected NON-bipartite
graphs of order n, streaming geng -c (bipartite excluded via geng? no:
filter by eigenvalue symmetry is unsafe; use 2-coloring on the batch)."""
import subprocess, sys
import numpy as np
from exhaustive import g6_batch_to_adj

def run(n):
    proc = subprocess.Popen(['/opt/homebrew/bin/geng','-c','-q',str(n)], stdout=subprocess.PIPE)
    minp = minm = np.inf; bp = bm = None; count=0
    while True:
        lines = [l.rstrip() for l in [proc.stdout.readline() for _ in range(65536)] if l]
        if not lines: break
        A = g6_batch_to_adj(lines, n)
        ev = np.linalg.eigvalsh(A)
        # bipartite iff spectrum symmetric: for integer adjacency, test sum |ev + reversed| small
        sym = np.abs(ev + ev[:, ::-1]).max(axis=1) < 1e-6
        sp = (np.where(ev>1e-9,ev,0)**2).sum(1) - (n-1)
        sm = (np.where(ev<-1e-9,ev,0)**2).sum(1) - (n-1)
        nb = ~sym
        count += int(nb.sum())
        if nb.any():
            idx = np.where(nb)[0]
            i = idx[np.argmin(sp[idx])]
            if sp[i] < minp: minp, bp = sp[i], lines[i]
            i = idx[np.argmin(sm[idx])]
            if sm[i] < minm: minm, bm = sm[i], lines[i]
    print(f'n={n}: {count} connected non-bipartite graphs')
    print(f'  floor s+-(n-1) = {minp:.9f} at {bp.decode()}')
    print(f'  floor s--(n-1) = {minm:.9f} at {bm.decode()}')

for n in [int(x) for x in sys.argv[1:]]:
    run(n)
