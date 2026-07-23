#!/usr/bin/env python3
"""Standalone verifier for circulant weighing matrix certificates.

Certificate file format (plain text):
  line 1: n k            (integers)
  line 2: n whitespace/comma-separated entries, each in {-1,0,1}
Optionally the entries may span multiple lines.

Checks, in exact integer arithmetic (no floats):
  1. length == n, all entries in {-1,0,+1}
  2. number of nonzero entries == k
  3. periodic autocorrelation PAF(s) = sum_i a_i * a_{(i+s) mod n} == 0
     for every s = 1..n-1   (PAF(0) == k automatically from check 2)

Prints PASS if the vector is a valid first row of a CW(n,k), else FAIL,
together with the computed quantities.  Also reports whether the CW is
"proper" (support not contained in a nontrivial coset progression d*Z_{n/d},
i.e. not a(x)=b(x^d) pattern up to equivalence) -- informational only.
"""
import sys


def paf(a, n):
    return [sum(a[i] * a[(i + s) % n] for i in range(n)) for s in range(n)]


def is_multiple_of_smaller(a, n):
    """Heuristic properness check: does some equivalent vector have support
    inside dZ_{n} for a divisor d>1?  We check all translates and all unit
    multipliers (decimations) -- exact, exhaustive over the equivalence group."""
    support = [i for i in range(n) if a[i] != 0]
    if not support:
        return False
    divs = [d for d in range(2, n + 1) if n % d == 0]
    from math import gcd
    units = [u for u in range(1, n) if gcd(u, n) == 1]
    for u in units:
        dec = [0] * n
        for i in range(n):
            dec[(u * i) % n] = a[i]
        for t in range(n):
            sup = [(i + t) % n for i in range(n) if dec[i] != 0]
            for d in divs:
                if all(s % d == 0 for s in sup):
                    return True
    return False


def main():
    if len(sys.argv) != 2:
        print("usage: verify.py certificate.txt")
        sys.exit(2)
    txt = open(sys.argv[1]).read().replace(",", " ").split()
    n, k = int(txt[0]), int(txt[1])
    entries = [int(x) for x in txt[2:]]
    print(f"claimed: CW(n={n}, k={k})")
    ok = True
    if len(entries) != n:
        print(f"FAIL: got {len(entries)} entries, expected n={n}")
        sys.exit(1)
    if any(e not in (-1, 0, 1) for e in entries):
        print("FAIL: entries not all in {-1,0,+1}")
        sys.exit(1)
    nz = sum(1 for e in entries if e != 0)
    print(f"nonzero entries: {nz} (need {k})")
    if nz != k:
        ok = False
    p = paf(entries, n)
    bad = [(s, p[s]) for s in range(1, n) if p[s] != 0]
    print(f"PAF(0) = {p[0]}")
    if bad:
        ok = False
        print(f"nonzero autocorrelations at {len(bad)} shifts; first few: {bad[:8]}")
    else:
        print("all n-1 nontrivial periodic autocorrelations are exactly 0")
    if ok:
        print("PASS: valid CW({},{})".format(n, k))
        if n <= 250:
            mult = is_multiple_of_smaller(entries, n)
            print("proper: {}".format("no (equivalent to b(x^d), improper)" if mult else "yes"))
    else:
        print("FAIL")
        sys.exit(1)


if __name__ == "__main__":
    main()
