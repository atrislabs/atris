#!/usr/bin/env python3
"""
Standalone verifier for a claimed counterexample to Hajos' conjecture on
cycle decompositions of Eulerian graphs.

Conjecture: every simple connected Eulerian graph on n vertices decomposes
into at most floor((n-1)/2) edge-disjoint cycles.

Certificate format (plain text): one edge per line, "u v" (integers).
Comment lines starting with '#' ignored.

The verifier:
  1. checks the graph is simple, connected, all degrees even (Eulerian);
  2. computes t = floor((n-1)/2);
  3. decides EXACTLY whether a decomposition of E into <= t edge-disjoint
     cycles exists, via exhaustive branch-and-bound (pure python, no
     dependence on any search code). If ortools is present it ALSO
     cross-checks with a CP-SAT model (independent second method).

Output:
  PASS  -> the graph IS a counterexample (no decomposition into <= t cycles)
  FAIL  -> not a counterexample (a decomposition into <= t cycles is exhibited,
           or the graph is not simple/connected/Eulerian)
"""
import sys
from math import inf

sys.setrecursionlimit(100000)


def read_graph(path):
    edges = set()
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith('#'):
                continue
            parts = line.split()
            u, v = int(parts[0]), int(parts[1])
            if u == v:
                raise ValueError("self-loop %d" % u)
            e = (min(u, v), max(u, v))
            if e in edges:
                raise ValueError("multi-edge %s" % (e,))
            edges.add(e)
    verts = sorted({x for e in edges for x in e})
    remap = {v: i for i, v in enumerate(verts)}
    edges = sorted((remap[u], remap[v]) for (u, v) in edges)
    return len(verts), edges


def is_connected(n, edges):
    adj = [[] for _ in range(n)]
    for u, v in edges:
        adj[u].append(v)
        adj[v].append(u)
    seen = [False] * n
    stack = [0]
    seen[0] = True
    cnt = 1
    while stack:
        x = stack.pop()
        for y in adj[x]:
            if not seen[y]:
                seen[y] = True
                cnt += 1
                stack.append(y)
    return cnt == n


def degrees(n, edges):
    d = [0] * n
    for u, v in edges:
        d[u] += 1
        d[v] += 1
    return d


# ---------- exact decision: decomposition into <= t cycles? ----------
# Branch and bound: always cover the lowest-indexed remaining edge by a
# simple cycle through it; enumerate such cycles by DFS, recurse.
# Lower bound on cycles needed for remaining graph R:
#   max( ceil(maxdeg(R)/2), ceil(|R| / #active_vertices) )
# Memoize infeasible (frozenset(R), budget) states.

def solve_leq_t(n, edges, t, node_limit=None):
    """Return (True, decomposition) if E decomposes into <= t cycles,
    (False, None) if provably not, raises RuntimeError on node_limit hit."""
    m = len(edges)
    eidx = {e: i for i, e in enumerate(edges)}
    full = frozenset(range(m))
    fail_cache = {}  # frozenset(remaining) -> max budget known infeasible
    nodes = [0]

    def lb(rem):
        if not rem:
            return 0
        deg = {}
        for i in rem:
            u, v = edges[i]
            deg[u] = deg.get(u, 0) + 1
            deg[v] = deg.get(v, 0) + 1
        mx = max(deg.values())
        act = len(deg)
        b1 = (mx + 1) // 2
        b2 = -(-len(rem) // act)  # ceil
        return max(b1, b2)

    def cycles_through(rem, e0):
        """Yield simple cycles (as frozensets of edge indices) containing
        edge e0, using only edges in rem. Longest first is preferred, so we
        generate all and sort by length descending... but that can explode.
        Instead: DFS yielding cycles as found, ordered by neighbor degree
        heuristic; caller iterates lazily."""
        u0, v0 = edges[e0]
        adj = {}
        for i in rem:
            a, b = edges[i]
            adj.setdefault(a, []).append((b, i))
            adj.setdefault(b, []).append((a, i))
        # DFS path from v0 back to u0 not reusing vertices, not using e0
        path_edges = [e0]
        visited = {u0, v0}

        def dfs(x):
            for (y, i) in adj[x]:
                if i == e0 or i in used_e:
                    continue
                if y == u0:
                    yield frozenset(path_edges + [i])
                elif y not in visited:
                    visited.add(y)
                    path_edges.append(i)
                    used_e.add(i)
                    yield from dfs(y)
                    used_e.discard(i)
                    path_edges.pop()
                    visited.discard(y)

        used_e = set()
        yield from dfs(v0)

    def rec(rem, budget):
        nodes[0] += 1
        if node_limit and nodes[0] > node_limit:
            raise RuntimeError("node limit exceeded")
        if not rem:
            return []
        if budget <= 0:
            return None
        if lb(rem) > budget:
            return None
        cached = fail_cache.get(rem)
        if cached is not None and budget <= cached:
            return None
        e0 = min(rem)
        # cycles through e0. For small graphs, materialize and try longest
        # first (greedy toward few cycles). For dense graphs full
        # materialization explodes; iterate lazily (DFS naturally yields
        # deep/long cycles early).
        if len(rem) <= 45:
            cyc_iter = sorted(cycles_through(rem, e0), key=len, reverse=True)
        else:
            cyc_iter = cycles_through(rem, e0)
        found_any = False
        for cyc in cyc_iter:
            found_any = True
            sub = rec(rem - cyc, budget - 1)
            if sub is not None:
                return [cyc] + sub
        if not found_any:
            pass  # no cycle through e0 at all -> infeasible below
        fail_cache[rem] = max(fail_cache.get(rem, -1), budget)
        return None

    res = rec(full, t)
    if res is None:
        return False, None
    # convert to vertex cycles for display
    decomp = []
    for cyc in res:
        es = [edges[i] for i in sorted(cyc)]
        decomp.append(es)
    return True, decomp


def check_decomposition(n, edges, decomp):
    """Independently confirm decomp is a partition of E into simple cycles."""
    all_e = []
    for es in decomp:
        # each cycle: every vertex touched exactly twice, connected
        deg = {}
        for (u, v) in es:
            deg[u] = deg.get(u, 0) + 1
            deg[v] = deg.get(v, 0) + 1
        if any(d != 2 for d in deg.values()):
            return False
        # connectivity of the cycle
        verts = list(deg)
        adj = {x: [] for x in verts}
        for (u, v) in es:
            adj[u].append(v)
            adj[v].append(u)
        seen = {verts[0]}
        st = [verts[0]]
        while st:
            x = st.pop()
            for y in adj[x]:
                if y not in seen:
                    seen.add(y)
                    st.append(y)
        if len(seen) != len(verts):
            return False
        all_e.extend((min(u, v), max(u, v)) for (u, v) in es)
    return sorted(all_e) == sorted(edges) and len(all_e) == len(set(all_e))


def cpsat_check(n, edges, t, timeout=600):
    """Optional independent cross-check with ortools CP-SAT (circuit model).
    Returns True (feasible), False (infeasible), or None (unavailable)."""
    try:
        from ortools.sat.python import cp_model
    except ImportError:
        return None
    m = len(edges)
    model = cp_model.CpModel()
    x = {}  # (slot, edge) -> bool: edge in slot's cycle
    for s in range(t):
        arcs = []
        arclit = {}
        for i, (u, v) in enumerate(edges):
            a = model.NewBoolVar(f"a{s}_{i}")
            b = model.NewBoolVar(f"b{s}_{i}")
            arcs.append((u, v, a))
            arcs.append((v, u, b))
            xe = model.NewBoolVar(f"x{s}_{i}")
            model.Add(a + b == 1).OnlyEnforceIf(xe)
            model.Add(a + b == 0).OnlyEnforceIf(xe.Not())
            x[(s, i)] = xe
            arclit[i] = (a, b)
        for vtx in range(n):
            loop = model.NewBoolVar(f"l{s}_{vtx}")
            arcs.append((vtx, vtx, loop))
        model.AddCircuit(arcs)
    for i in range(m):
        model.Add(sum(x[(s, i)] for s in range(t)) == 1)
    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = timeout
    solver.parameters.num_search_workers = 8
    st = solver.Solve(model)
    if st == cp_model.OPTIMAL or st == cp_model.FEASIBLE:
        return True
    if st == cp_model.INFEASIBLE:
        return False
    return None


def main():
    if len(sys.argv) < 2:
        print("usage: verify.py <certificate-edge-list> [--node-limit N]")
        sys.exit(2)
    path = sys.argv[1]
    n, edges = read_graph(path)
    m = len(edges)
    t = (n - 1) // 2
    print(f"graph: n={n} vertices, m={m} edges, bound t=floor((n-1)/2)={t}")
    deg = degrees(n, edges)
    if any(d % 2 for d in deg):
        print("FAIL: not Eulerian (odd degree present)", deg)
        sys.exit(1)
    if not is_connected(n, edges):
        print("FAIL: graph not connected")
        sys.exit(1)
    print("simple/connected/even-degree checks: ok. degrees =", deg)
    feasible, decomp = solve_leq_t(n, edges, t)
    if feasible:
        ok = check_decomposition(n, edges, decomp)
        print(f"decomposition into {len(decomp)} <= {t} cycles found; "
              f"independent partition re-check: {'ok' if ok else 'BROKEN'}")
        for c in decomp:
            print("  cycle:", c)
        cs = cpsat_check(n, edges, t)
        if cs is not None:
            print("cp-sat cross-check says feasible:", cs)
        print("FAIL: conjecture HOLDS for this graph (not a counterexample)")
        sys.exit(1)
    else:
        print(f"exhaustive branch-and-bound: NO decomposition into <= {t} cycles")
        cs = cpsat_check(n, edges, t)
        print("cp-sat cross-check (True=feasible/False=infeasible/None=n/a):", cs)
        if cs is True:
            print("FAIL: cross-check disagreement -- do not trust")
            sys.exit(1)
        print("PASS: counterexample verified (min cycle decomposition > t)")
        sys.exit(0)


if __name__ == "__main__":
    main()
