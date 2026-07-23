#!/usr/bin/env python3
"""Exhaustive check of s+ >= n-1 and s- >= n-1 over all connected graphs
of a given order, streaming from nauty geng, batched numpy eigensolves."""
import subprocess, sys
import numpy as np

GENG = '/opt/homebrew/bin/geng'


def g6_batch_to_adj(lines, n):
    """Vectorized graph6 -> adjacency matrices (B, n, n) for fixed n < 63."""
    nb = (n * (n - 1) // 2 + 5) // 6
    raw = np.frombuffer(b''.join(lines), dtype=np.uint8).reshape(-1, nb + 1)
    assert np.all(raw[:, 0] == n + 63)
    bits = np.unpackbits((raw[:, 1:] - 63).astype(np.uint8), axis=1,
                         bitorder='big').reshape(-1, nb * 8)
    # each byte carries 6 bits in positions 2..7 (big-endian of value<64)
    sel = np.arange(nb * 8).reshape(nb, 8)[:, 2:].ravel()
    bits = bits[:, sel][:, :n * (n - 1) // 2]
    B = bits.shape[0]
    A = np.zeros((B, n, n), dtype=np.float64)
    iu = []
    for j in range(1, n):
        for i in range(j):
            iu.append((i, j))
    iu = np.array(iu)
    A[:, iu[:, 0], iu[:, 1]] = bits
    A[:, iu[:, 1], iu[:, 0]] = bits
    return A


def run(n, batch=65536, report_top=5):
    proc = subprocess.Popen([GENG, '-c', '-q', str(n)], stdout=subprocess.PIPE)
    best = []  # (margin, which, g6)
    count = 0
    minp = minm = np.inf
    while True:
        lines = []
        for _ in range(batch):
            l = proc.stdout.readline()
            if not l:
                break
            lines.append(l.strip() + b'\n'[0:0])
        if not lines:
            break
        lines2 = [l.rstrip() for l in [x for x in lines]]
        A = g6_batch_to_adj([l + b'' for l in lines2], n)
        ev = np.linalg.eigvalsh(A)
        pos = np.where(ev > 1e-9, ev, 0.0)
        neg = np.where(ev < -1e-9, ev, 0.0)
        sp = (pos ** 2).sum(axis=1)
        sm = (neg ** 2).sum(axis=1)
        mp = sp - (n - 1)
        mm = sm - (n - 1)
        count += len(lines2)
        bi = np.argmin(mp)
        if mp[bi] < minp:
            minp = mp[bi]
            bestp = lines2[bi]
        bi = np.argmin(mm)
        if mm[bi] < minm:
            minm = mm[bi]
            bestm = lines2[bi]
        if minp < -1e-7 or minm < -1e-7:
            print('VIOLATION CANDIDATE FOUND')
    print(f'n={n}: {count} connected graphs')
    print(f'  min s+ - (n-1) = {minp:.3e}  at {bestp.decode()}')
    print(f'  min s- - (n-1) = {minm:.3e}  at {bestm.decode()}')
    return minp, minm


if __name__ == '__main__':
    for n in [int(x) for x in sys.argv[1:]] or range(4, 10):
        run(n)
