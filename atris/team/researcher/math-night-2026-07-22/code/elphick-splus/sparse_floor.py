#!/usr/bin/env python3
"""Exact floors of s+-(n-1), s--(n-1) over connected graphs with m edges,
streaming geng -c n m:m."""
import subprocess, sys
import numpy as np
from exhaustive import g6_batch_to_adj

def run(n, m):
    proc = subprocess.Popen(['/opt/homebrew/bin/geng','-c','-q',str(n),f'{m}:{m}'],
                            stdout=subprocess.PIPE, bufsize=1<<22)
    minp = minm = np.inf; bp=bm=b''; count=0; buf=b''
    while True:
        data = proc.stdout.read(1<<22)
        if not data and not buf: break
        data = buf + data
        cut = data.rfind(b'\n')
        buf = data[cut+1:]
        lines = [l for l in data[:cut].split(b'\n') if l]
        if not lines: continue
        A = g6_batch_to_adj(lines, n)
        ev = np.linalg.eigvalsh(A)
        sp = (np.where(ev>1e-9,ev,0)**2).sum(1)-(n-1)
        sm = (np.where(ev<-1e-9,ev,0)**2).sum(1)-(n-1)
        count += len(lines)
        i=int(np.argmin(sp))
        if sp[i]<minp: minp,bp=sp[i],lines[i]
        i=int(np.argmin(sm))
        if sm[i]<minm: minm,bm=sm[i],lines[i]
    print(f'n={n} m={m}: {count} graphs; floor s+m={minp:.6e} ({bp.decode()}); '
          f'floor s-m={minm:.6e} ({bm.decode()})', flush=True)

n = int(sys.argv[1])
for dm in [int(x) for x in sys.argv[2:]]:
    run(n, n-1+dm)
