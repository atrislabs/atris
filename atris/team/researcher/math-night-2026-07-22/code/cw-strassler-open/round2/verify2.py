#!/usr/bin/env python3
"""Second, independent verifier: builds the full n x n circulant matrix from the
first row and checks A @ A^T == k * I in exact integer arithmetic (numpy int64
matmul, values bounded by n so no overflow). Independent code path from
verify.py's PAF loop.
"""
import sys
import numpy as np


def main():
    txt = open(sys.argv[1]).read().replace(",", " ").split()
    n, k = int(txt[0]), int(txt[1])
    a = [int(x) for x in txt[2:]]
    assert len(a) == n, f"expected {n} entries, got {len(a)}"
    assert all(e in (-1, 0, 1) for e in a), "entries not ternary"
    A = np.empty((n, n), dtype=np.int64)
    for i in range(n):
        # row i is right-cyclic shift of row 0 by i
        A[i] = np.roll(a, i)
    G = A @ A.T
    target = k * np.eye(n, dtype=np.int64)
    if np.array_equal(G, target):
        print(f"PASS2: A A^T = {k} I exactly (full {n}x{n} matrix check)")
        sys.exit(0)
    else:
        diff = np.argwhere(G != target)
        print(f"FAIL2: {len(diff)} entries differ; first: {diff[:5].tolist()}")
        sys.exit(1)


if __name__ == "__main__":
    main()
