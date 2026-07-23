#!/usr/bin/env python3
"""Standalone verifier for a claimed counterexample to Vizing's conjecture.

Certificate file format (plain text):
    G <n_G>
    u v        (one edge per line, 0-indexed)
    ...
    H <n_H>
    u v
    ...
    CLAIM <gamma_G> <gamma_H> <gamma_product>

The verifier computes gamma(G), gamma(H) by exhaustive search (increasing
cardinality, bitmask closed neighborhoods) and gamma(G box H) BOTH by
CP-SAT (ortools, with optimality status) AND, independently, by an
ILP-free exhaustive/branch-and-bound written here from scratch.
It prints PASS iff gamma(G box H) < gamma(G) * gamma(H)  (i.e. the
conjecture is VIOLATED), else FAIL (conjecture holds on this pair).

Usage: python3 verify.py certificate.txt
"""
import sys
from itertools import combinations


def parse(path):
    lines = [ln.strip() for ln in open(path) if ln.strip() and not ln.startswith('#')]
    i = 0
    graphs = {}
    claim = None
    while i < len(lines):
        tok = lines[i].split()
        if tok[0] in ('G', 'H'):
            name, n = tok[0], int(tok[1])
            i += 1
            edges = []
            while i < len(lines) and lines[i].split()[0] not in ('G', 'H', 'CLAIM'):
                a, b = map(int, lines[i].split())
                edges.append((a, b))
                i += 1
            graphs[name] = (n, edges)
        elif tok[0] == 'CLAIM':
            claim = tuple(map(int, tok[1:4]))
            i += 1
        else:
            raise ValueError('bad line: ' + lines[i])
    return graphs['G'], graphs['H'], claim


def closed_nbhd_masks(n, edges):
    N = [1 << v for v in range(n)]
    for a, b in edges:
        N[a] |= 1 << b
        N[b] |= 1 << a
    return N


def gamma_bruteforce(n, edges):
    """Exact domination number by exhaustive search over subsets, smallest first."""
    N = closed_nbhd_masks(n, edges)
    full = (1 << n) - 1
    for k in range(1, n + 1):
        for S in combinations(range(n), k):
            m = 0
            for v in S:
                m |= N[v]
            if m == full:
                return k
    raise RuntimeError('unreachable')


def box_product(nG, eG, nH, eH):
    """Cartesian product. Vertex (g,h) -> g*nH + h."""
    n = nG * nH
    edges = []
    for g in range(nG):
        for a, b in eH:
            edges.append((g * nH + a, g * nH + b))
    for h in range(nH):
        for a, b in eG:
            edges.append((a * nH + h, b * nH + h))
    return n, edges


def gamma_cpsat(n, edges, ub_hint=None):
    """Exact domination number via ortools CP-SAT; asserts OPTIMAL status."""
    from ortools.sat.python import cp_model
    adj = [set([v]) for v in range(n)]
    for a, b in edges:
        adj[a].add(b)
        adj[b].add(a)
    m = cp_model.CpModel()
    x = [m.NewBoolVar(f'x{v}') for v in range(n)]
    for v in range(n):
        m.AddAtLeastOne([x[u] for u in adj[v]])
    m.Minimize(sum(x))
    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = 600
    solver.parameters.num_search_workers = 8
    st = solver.Solve(m)
    assert st == cp_model.OPTIMAL, f'CP-SAT not optimal (status {st})'
    return int(solver.ObjectiveValue())


def gamma_branch_bound(n, edges, ub):
    """Independent exact check: prove no dominating set of size < ub exists,
    and find one of size ub, via depth-first branch and bound on bitmasks.
    Returns exact gamma. Written independently of CP-SAT."""
    N = closed_nbhd_masks(n, edges)
    full = (1 << n) - 1
    best = [ub]
    # order vertices by degree descending for better branching
    order = sorted(range(n), key=lambda v: -bin(N[v]).count('1'))
    Nmax = max(bin(N[v]).count('1') for v in range(n))

    import sys as _s
    _s.setrecursionlimit(10000)

    from functools import lru_cache

    def search(dominated, count):
        if dominated == full:
            if count < best[0]:
                best[0] = count
            return
        undominated = full & ~dominated
        # lower bound: ceil(#undominated / max closed nbhd size)
        u = bin(undominated).count('1')
        if count + (u + Nmax - 1) // Nmax >= best[0]:
            return
        # pick lowest undominated vertex; some vertex in N[v] must be chosen
        v = (undominated & -undominated).bit_length() - 1
        cands = [w for w in range(n) if N[w] >> v & 1]
        cands.sort(key=lambda w: -bin(N[w] & undominated).count('1'))
        for w in cands:
            search(dominated | N[w], count + 1)

    search(0, 0)
    return best[0]


def main():
    (nG, eG), (nH, eH), claim = parse(sys.argv[1])
    gG = gamma_bruteforce(nG, eG)
    gH = gamma_bruteforce(nH, eH)
    nP, eP = box_product(nG, eG, nH, eH)
    gP_sat = gamma_cpsat(nP, eP)
    gP_bb = gamma_branch_bound(nP, eP, ub=gP_sat + 1)
    print(f'gamma(G)          = {gG}   (brute force, n={nG})')
    print(f'gamma(H)          = {gH}   (brute force, n={nH})')
    print(f'gamma(G box H)    = {gP_sat}   (CP-SAT optimal, n={nP})')
    print(f'gamma(G box H)    = {gP_bb}   (independent branch-and-bound)')
    if gP_sat != gP_bb:
        print('FAIL: the two independent product computations disagree!')
        sys.exit(2)
    if claim:
        print(f'claimed: {claim}, computed: {(gG, gH, gP_sat)}',
              '(match)' if claim == (gG, gH, gP_sat) else '(MISMATCH)')
    print(f'test: gamma(GboxH)={gP_sat}  vs  gamma(G)*gamma(H)={gG * gH}')
    if gP_sat < gG * gH:
        print('PASS: VIZING CONJECTURE VIOLATED')
    else:
        print('FAIL: conjecture holds on this pair (no violation)')


if __name__ == '__main__':
    main()
