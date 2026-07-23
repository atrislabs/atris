#!/usr/bin/env python3
"""One geng res/mod slice of connected graphs on n vertices; chunked I/O."""
import subprocess, sys
import numpy as np
from exhaustive import g6_batch_to_adj

n, res, mod = int(sys.argv[1]), int(sys.argv[2]), int(sys.argv[3])
proc = subprocess.Popen(['/opt/homebrew/bin/geng','-c','-q',str(n),f'{res}/{mod}'],
                        stdout=subprocess.PIPE, bufsize=1<<22)
minp = minm = np.inf; bp = bm = b''; count = 0
buf = b''
CH = 1 << 22
while True:
    data = proc.stdout.read(CH)
    if not data:
        if buf: lines = buf.split(b'\n'); buf = b''
        else: break
    else:
        data = buf + data
        cut = data.rfind(b'\n')
        buf = data[cut+1:]
        lines = data[:cut].split(b'\n')
    lines = [l for l in lines if l]
    if not lines:
        if not data: break
        continue
    A = g6_batch_to_adj(lines, n)
    ev = np.linalg.eigvalsh(A)
    sp = (np.where(ev>1e-9,ev,0)**2).sum(1) - (n-1)
    sm = (np.where(ev<-1e-9,ev,0)**2).sum(1) - (n-1)
    count += len(lines)
    i = int(np.argmin(sp))
    if sp[i] < minp: minp, bp = sp[i], lines[i]
    i = int(np.argmin(sm))
    if sm[i] < minm: minm, bm = sm[i], lines[i]
    if minp < -1e-7 or minm < -1e-7:
        print('VIOLATION CANDIDATE', bp, bm, flush=True)
print(f'slice {res}/{mod} n={n}: {count} graphs; '
      f'min s+m={minp:.3e} at {bp.decode()}; min s-m={minm:.3e} at {bm.decode()}')
