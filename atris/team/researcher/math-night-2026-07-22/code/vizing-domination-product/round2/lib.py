"""Round-2 shared library: graph gens, exact gamma, LP gamma_f with certified dual bound."""
import random
from fractions import Fraction
from itertools import combinations


def closed_masks(n, edges):
    N = [1 << v for v in range(n)]
    for a, b in edges:
        N[a] |= 1 << b
        N[b] |= 1 << a
    return N


def gamma_exact(n, edges, cap=None):
    """Exact domination number, brute force smallest-first. Fine for n<=16."""
    N = closed_masks(n, edges)
    full = (1 << n) - 1
    top = cap if cap else n
    for k in range(1, top + 1):
        for S in combinations(range(n), k):
            m = 0
            for v in S:
                m |= N[v]
            if m == full:
                return k
    return top + 1  # gamma > cap


def gamma_f_lp(n, edges):
    """Fractional domination number via GLOP. Returns (float value, dual list)."""
    from ortools.linear_solver import pywraplp
    adj = [set([v]) for v in range(n)]
    for a, b in edges:
        adj[a].add(b)
        adj[b].add(a)
    s = pywraplp.Solver.CreateSolver('GLOP')
    x = [s.NumVar(0, 1, f'x{v}') for v in range(n)]
    cons = []
    for v in range(n):
        c = s.Add(sum(x[u] for u in adj[v]) >= 1)
        cons.append(c)
    s.Minimize(sum(x))
    st = s.Solve()
    assert st == pywraplp.Solver.OPTIMAL, f'GLOP status {st}'
    duals = [c.dual_value() for c in cons]
    return s.Objective().Value(), duals


def certified_lb(n, edges, duals):
    """Turn LP duals into an exact-arithmetic lower bound on gamma_f (hence gamma).

    Duals y_v >= 0 form a fractional closed-neighborhood packing iff for every
    vertex u: sum_{v in N[u]} y_v <= 1. Then gamma >= gamma_f >= sum y.
    We clip negatives, then scale down by max row sum if needed. All checks in
    Fraction arithmetic so the resulting bound is PROVEN, not float-trusted.
    """
    adj = [set([v]) for v in range(n)]
    for a, b in edges:
        adj[a].add(b)
        adj[b].add(a)
    y = [max(Fraction(0), Fraction(d).limit_denominator(10**9)) for d in duals]
    worst = Fraction(0)
    for u in range(n):
        row = sum(y[v] for v in adj[u])
        if row > worst:
            worst = row
    if worst > 1:
        y = [v / worst for v in y]
    # re-verify packing feasibility exactly
    for u in range(n):
        assert sum(y[v] for v in adj[u]) <= 1, 'packing check failed'
    return sum(y)  # Fraction: certified lower bound on gamma_f <= gamma


def box_product(nG, eG, nH, eH):
    n = nG * nH
    edges = []
    for g in range(nG):
        for a, b in eH:
            edges.append((g * nH + a, g * nH + b))
    for h in range(nH):
        for a, b in eG:
            edges.append((a * nH + h, b * nH + h))
    return n, edges


# ---------------- generators ----------------

def circulant(n, S):
    edges = set()
    for v in range(n):
        for s in S:
            a, b = v, (v + s) % n
            edges.add((min(a, b), max(a, b)))
    return n, sorted(edges)


def gen_petersen(n, k):
    """GP(n,k): 2n vertices."""
    edges = []
    for i in range(n):
        edges.append((i, (i + 1) % n))          # outer cycle
        edges.append((i, n + i))                # spokes
        edges.append((n + i, n + (i + k) % n))  # inner
    ded = set((min(a, b), max(a, b)) for a, b in edges)
    return 2 * n, sorted(ded)


def kneser(n, k):
    verts = list(combinations(range(n), k))
    idx = {v: i for i, v in enumerate(verts)}
    edges = []
    for i, a in enumerate(verts):
        for j in range(i + 1, len(verts)):
            if not (set(a) & set(verts[j])):
                edges.append((i, j))
    return len(verts), edges


def random_graph(n, m, rng):
    all_e = [(a, b) for a in range(n) for b in range(a + 1, n)]
    return n, rng.sample(all_e, m)


def graph_key(n, edges):
    return (n, tuple(sorted((min(a, b), max(a, b)) for a, b in edges)))


def is_connected(n, edges):
    adj = [[] for _ in range(n)]
    for a, b in edges:
        adj[a].append(b)
        adj[b].append(a)
    seen = {0}
    stack = [0]
    while stack:
        v = stack.pop()
        for u in adj[v]:
            if u not in seen:
                seen.add(u)
                stack.append(u)
    return len(seen) == n
