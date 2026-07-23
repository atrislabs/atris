#!/usr/bin/env python3
"""Standalone verifier for Gallai path-decomposition counterexample candidates.

Certificate format: text file, lines "u v" (one edge per line, integers).
Blank lines and lines starting with '#' ignored.

The verifier implements the conjecture's property DIRECTLY:
  Gallai: every connected simple graph on n vertices decomposes into
  at most ceil(n/2) edge-disjoint (simple) paths.

It decides, exactly, whether a decomposition of the edge set into at most
t = ceil(n/2) simple paths exists, via a SAT encoding with lazy
monochromatic-cycle cuts (each cut is globally valid, so UNSAT => no
decomposition exists).

Output:
  PASS  -> candidate IS a counterexample (no decomposition into ceil(n/2) paths)
  FAIL  -> conjecture holds on this graph (an explicit decomposition is printed
           and re-checked structurally by independent pure-python code)
"""
import sys
from math import ceil
from itertools import combinations

from pysat.solvers import Cadical153
from pysat.card import CardEnc, EncType
from pysat.formula import IDPool


def read_edges(path):
    edges = []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith('#'):
                continue
            parts = line.split()
            u, v = int(parts[0]), int(parts[1])
            if u == v:
                raise ValueError(f"self-loop {u}")
            e = (min(u, v), max(u, v))
            if e in edges:
                raise ValueError(f"duplicate edge {e}")
            edges.append(e)
    return edges


def is_connected(vertices, edges):
    if not vertices:
        return False
    adj = {v: [] for v in vertices}
    for u, v in edges:
        adj[u].append(v)
        adj[v].append(u)
    seen = {next(iter(vertices))}
    stack = [next(iter(vertices))]
    while stack:
        x = stack.pop()
        for y in adj[x]:
            if y not in seen:
                seen.add(y)
                stack.append(y)
    return seen == set(vertices)


def check_is_path(comp_vertices, comp_edges):
    """Pure-python structural check that (comp_vertices, comp_edges) is a simple path."""
    if len(comp_edges) != len(comp_vertices) - 1:
        return False
    deg = {v: 0 for v in comp_vertices}
    for u, v in comp_edges:
        deg[u] += 1
        deg[v] += 1
    if any(d > 2 for d in deg.values()):
        return False
    if sum(1 for d in deg.values() if d == 1) != 2 and len(comp_vertices) > 1:
        return False
    return is_connected(set(comp_vertices), comp_edges)


def components_of(edge_list):
    """Connected components of a subgraph given by an edge list.
    Returns list of (vertexset, edgelist)."""
    adj = {}
    for u, v in edge_list:
        adj.setdefault(u, []).append(v)
        adj.setdefault(v, []).append(u)
    seen = set()
    comps = []
    for s in adj:
        if s in seen:
            continue
        stack = [s]
        seen.add(s)
        cv = {s}
        while stack:
            x = stack.pop()
            for y in adj[x]:
                if y not in seen:
                    seen.add(y)
                    cv.add(y)
                    stack.append(y)
        ce = [(u, v) for (u, v) in edge_list if u in cv]
        comps.append((cv, ce))
    return comps


def decide_path_decomposition(vertices, edges, t, solver_cls=Cadical153, verbose=False):
    """Return a list of t' <= t paths (each a list of edges) decomposing edges,
    or None if no decomposition into <= t paths exists (exact)."""
    verts = sorted(vertices)
    n = len(verts)
    m = len(edges)
    pool = IDPool()
    y = {(e, c): pool.id(('y', e, c)) for e in range(m) for c in range(t)}
    used = {(v, c): pool.id(('u', v, c)) for v in verts for c in range(t)}
    nonempty = {c: pool.id(('ne', c)) for c in range(t)}
    inc = {v: [] for v in verts}
    for e, (a, b) in enumerate(edges):
        inc[a].append(e)
        inc[b].append(e)

    cnf = []
    # each edge exactly one color
    for e in range(m):
        lits = [y[(e, c)] for c in range(t)]
        cnf.append(lits)
        for l1, l2 in combinations(lits, 2):
            cnf.append([-l1, -l2])
    # used[v][c] <-> OR of incident edge colors
    for v in verts:
        for c in range(t):
            lits = [y[(e, c)] for e in inc[v]]
            for l in lits:
                cnf.append([-l, used[(v, c)]])
            cnf.append([-used[(v, c)]] + lits)
    # nonempty[c] <-> OR_e y[e][c]
    for c in range(t):
        lits = [y[(e, c)] for e in range(m)]
        for l in lits:
            cnf.append([-l, nonempty[c]])
        cnf.append([-nonempty[c]] + lits)
    # degree <= 2 per vertex per color
    for v in verts:
        for c in range(t):
            lits = [y[(e, c)] for e in inc[v]]
            if len(lits) > 2:
                am = CardEnc.atmost(lits=lits, bound=2, vpool=pool,
                                    encoding=EncType.seqcounter)
                cnf.extend(am.clauses)
    # single-path count: E_c = V_c - nonempty_c
    # encoded as: sum_e y[e][c] + sum_v NOT used[v][c] + nonempty[c] == n
    for c in range(t):
        lits = [y[(e, c)] for e in range(m)] + \
               [-used[(v, c)] for v in verts] + [nonempty[c]]
        eq = CardEnc.equals(lits=lits, bound=n, vpool=pool,
                            encoding=EncType.totalizer)
        cnf.extend(eq.clauses)
    # color symmetry breaking: edge j may take color c>0 only if some earlier
    # edge takes color c-1 (prefix variables)
    pre = {}
    for c in range(t):
        for j in range(m):
            pre[(j, c)] = pool.id(('p', j, c))
            cnf.append([-y[(j, c)], pre[(j, c)]])
            if j > 0:
                cnf.append([-pre[(j - 1, c)], pre[(j, c)]])
            body = [y[(j, c)]] + ([pre[(j - 1, c)]] if j > 0 else [])
            cnf.append([-pre[(j, c)]] + body)
    for c in range(1, t):
        cnf.append([-y[(0, c)]])  # edge 0 is color 0 ... (implied but explicit)
        for j in range(1, m):
            cnf.append([-y[(j, c)], pre[(j - 1, c - 1)]])

    with solver_cls(bootstrap_with=cnf) as s:
        rounds = 0
        while True:
            rounds += 1
            if not s.solve():
                return None
            model = set(l for l in s.get_model() if l > 0)
            classes = [[] for _ in range(t)]
            for e in range(m):
                for c in range(t):
                    if y[(e, c)] in model:
                        classes[c].append(edges[e])
                        break
            # find monochromatic cycle components; block them
            cuts = 0
            for c in range(t):
                if not classes[c]:
                    continue
                for cv, ce in components_of(classes[c]):
                    if len(ce) >= len(cv):  # contains a cycle (deg<=2 => is a cycle)
                        idxs = [edges.index(e) for e in ce]
                        for cc in range(t):
                            s.add_clause([-y[(ei, cc)] for ei in idxs])
                        cuts += 1
            if cuts == 0:
                return [cl for cl in classes if cl]
            if verbose:
                print(f"  round {rounds}: added {cuts} cycle cuts", file=sys.stderr)


def main():
    if len(sys.argv) != 2:
        print("usage: verify.py <certificate-edge-list>")
        sys.exit(2)
    edges = read_edges(sys.argv[1])
    vertices = sorted(set(x for e in edges for x in e))
    n = len(vertices)
    m = len(edges)
    t = ceil(n / 2)
    print(f"n = {n} vertices, m = {m} edges, Gallai bound ceil(n/2) = {t}")
    if not is_connected(set(vertices), edges):
        print("FAIL: graph is not connected (conjecture only concerns connected graphs)")
        sys.exit(1)
    result = decide_path_decomposition(set(vertices), edges, t, verbose=True)
    if result is None:
        print(f"no decomposition into <= {t} paths exists (exact SAT decision, UNSAT)")
        print("PASS: candidate IS a counterexample to Gallai's conjecture")
        sys.exit(0)
    else:
        # independent structural re-check of the found decomposition
        all_e = sorted([tuple(sorted(e)) for cl in result for e in cl])
        assert all_e == sorted(edges), "decomposition does not partition edge set!"
        for cl in result:
            comps = components_of(cl)
            assert len(comps) == 1, "class not connected!"
            cv, ce = comps[0]
            assert check_is_path(cv, ce), "class is not a simple path!"
        print(f"decomposition into {len(result)} <= {t} paths EXISTS:")
        for i, cl in enumerate(result):
            print(f"  path {i}: {cl}")
        print("FAIL: conjecture HOLDS on this graph (not a counterexample)")
        sys.exit(1)


if __name__ == '__main__':
    main()
