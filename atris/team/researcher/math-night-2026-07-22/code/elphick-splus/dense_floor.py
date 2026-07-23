#!/usr/bin/env python3
"""Floor of s+/- margins over complements of all graphs with <= k edges
(dense corner near K_n), streaming geng n 0:k (disconnected allowed;
complement connectivity checked)."""
import subprocess, sys
import numpy as np
from exhaustive import g6_batch_to_adj

def run(n, k):
    proc = subprocess.Popen(['/opt/homebrew/bin/geng','-q',str(n),f'0:{k}'],
                            stdout=subprocess.PIPE, bufsize=1<<20)
    minp = minm = np.inf; bp=bm=b''; count=0; buf=b''
    J = np.ones((n,n)) - np.eye(n)
    while True:
        data = proc.stdout.read(1<<20)
        if not data and not buf: break
        data = buf + data
        cut = data.rfind(b'\n')
        buf = data[cut+1:]
        lines = [l for l in data[:cut].split(b'\n') if l]
        if not lines: continue
        A = J[None,:,:] - g6_batch_to_adj(lines, n)  # complements
        # connectivity: complement of <=k-edge graph on n>=k+2 vertices is connected
        ev = np.linalg.eigvalsh(A)
        sp = (np.where(ev>1e-9,ev,0)**2).sum(1)-(n-1)
        sm = (np.where(ev<-1e-9,ev,0)**2).sum(1)-(n-1)
        count += len(lines)
        i=int(np.argmin(sp))
        if sp[i]<minp: minp,bp=sp[i],lines[i]
        i=int(np.argmin(sm))
        if sm[i]<minm: minm,bm=sm[i],lines[i]
    print(f'n={n} co-edges<={k}: {count} graphs; floor s+m={minp:.4e}; '
          f'floor s-m={minm:.6e} at co-graph {bm.decode()}', flush=True)

for n in [int(x) for x in sys.argv[1:]]:
    run(n, n//2 + 3)
