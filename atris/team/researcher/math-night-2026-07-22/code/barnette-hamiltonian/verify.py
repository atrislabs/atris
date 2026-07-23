#!/usr/bin/env python3
"""
Standalone verifier for a claimed counterexample to Barnette's conjecture.

Certificate format (text file):
  line 1: n
  next n lines: "v: a b c"  (0-indexed adjacency list)

A PASS (counterexample) requires ALL of:
  1. simple graph, all degrees exactly 3 (cubic)
  2. bipartite (BFS 2-coloring)
  3. planar (networkx check_planarity, Boyer-Myrvold)
  4. 3-connected (networkx node_connectivity == 3, n > 4)
  5. NO Hamiltonian cycle, certified two independent ways:
       (a) SAT encoding of Hamiltonian cycle -> UNSAT (pysat/Glucose3)
       (b) pure-python DFS backtracking with pruning -> no cycle found
Prints PASS only if the graph is in the Barnette class AND non-Hamiltonian.
Prints FAIL otherwise, with the reason (including a Hamiltonian cycle if found).
"""
import sys
from itertools import combinations

def read_graph(path):
    with open(path) as f:
        toks = f.read().split('\n')
    lines = [l.strip() for l in toks if l.strip() and not l.strip().startswith('#')]
    n = int(lines[0])
    adj = {i: set() for i in range(n)}
    for l in lines[1:1+n]:
        left, right = l.split(':')
        v = int(left)
        for w in right.split():
            w = int(w)
            if w == v:
                raise ValueError(f"self-loop at {v}")
            adj[v].add(w)
    # symmetry check
    for v in adj:
        for w in adj[v]:
            if v not in adj[w]:
                raise ValueError(f"asymmetric edge {v}-{w}")
    return n, adj

def check_cubic(n, adj):
    bad = [v for v in range(n) if len(adj[v]) != 3]
    return (not bad), f"degrees!=3 at {bad[:5]}" if bad else "all degrees 3"

def check_bipartite(n, adj):
    color = {}
    for s in range(n):
        if s in color: continue
        color[s] = 0
        stack = [s]
        while stack:
            v = stack.pop()
            for w in adj[v]:
                if w not in color:
                    color[w] = 1 - color[v]
                    stack.append(w)
                elif color[w] == color[v]:
                    return False, f"odd cycle through edge {v}-{w}", None
    return True, "2-colorable", color

def check_planar(n, adj):
    import networkx as nx
    G = nx.Graph()
    G.add_nodes_from(range(n))
    for v in adj:
        for w in adj[v]:
            G.add_edge(v, w)
    ok, _ = nx.check_planarity(G)
    return ok, "planar" if ok else "NOT planar", G

def check_3connected(G):
    import networkx as nx
    k = nx.node_connectivity(G)
    return k == 3, f"node_connectivity={k}"

def ham_sat(n, adj):
    """Return (has_ham, cycle_or_None). SAT encoding: pick 2 incident edges/vertex,
    then ban subtours lazily."""
    from pysat.solvers import Glucose3
    from pysat.card import CardEnc, EncType
    edges = sorted(set(tuple(sorted((v, w))) for v in adj for w in adj[v]))
    evar = {e: i+1 for i, e in enumerate(edges)}
    top = len(edges)
    cnf = []
    for v in range(n):
        inc = [evar[tuple(sorted((v, w)))] for w in adj[v]]
        # exactly 2 of 3: at least two <=> no two can both be false; at most 2 <=> not all three
        for a, b in combinations(inc, 2):
            cnf.append([a, b])          # at least 2 true among 3
        cnf.append([-x for x in inc])   # at most 2
    s = Glucose3(bootstrap_with=cnf)
    while True:
        if not s.solve():
            return False, None
        model = set(l for l in s.get_model() if l > 0)
        chosen = [e for e in edges if evar[e] in model]
        # extract cycles of the 2-factor
        nbr = {v: [] for v in range(n)}
        for a, b in chosen:
            nbr[a].append(b); nbr[b].append(a)
        seen = set()
        cycles = []
        for v in range(n):
            if v in seen: continue
            cyc = [v]; seen.add(v)
            prev, cur = None, v
            while True:
                nxt = [w for w in nbr[cur] if w != prev]
                nxt = nxt[0]
                if nxt == v: break
                cyc.append(nxt); seen.add(nxt)
                prev, cur = cur, nxt
            cycles.append(cyc)
        if len(cycles) == 1:
            return True, cycles[0]
        # ban shortest subtour
        cyc = min(cycles, key=len)
        cedges = [evar[tuple(sorted((cyc[i], cyc[(i+1) % len(cyc)])))] for i in range(len(cyc))]
        s.add_clause([-x for x in cedges])

def ham_backtrack(n, adj, limit_nodes=500_000_000):
    """Independent exhaustive method: edge in/out propagation search
    (pure python, written independently of the SAT encoding).
    Each vertex must have exactly 2 IN edges; IN edges form paths; closing a
    cycle shorter than n is forbidden. Branch on an undecided edge at a path
    end. Exhaustive: returns (False, None) only after full exhaustion."""
    edges = sorted(set(tuple(sorted((v, w))) for v in adj for w in adj[v]))
    eidx = {e: i for i, e in enumerate(edges)}
    inc = {v: [eidx[tuple(sorted((v, w)))] for w in adj[v]] for v in range(n)}
    m = len(edges)
    UNK, IN, OUT = 0, 1, 2
    nodes = 0

    def propagate(st, oend, plen, todo):
        """apply forced assignments; return False on contradiction, 'HAM' if
        a Hamiltonian cycle is completed, True otherwise. st/oend/plen mutated."""
        while todo:
            e, val = todo.pop()
            if st[e] == val: continue
            if st[e] != UNK: return False
            u, v = edges[e]
            if val == IN:
                if sum(1 for f in inc[u] if st[f] == IN) >= 2: return False
                if sum(1 for f in inc[v] if st[f] == IN) >= 2: return False
                au, av = oend[u], oend[v]
                if au == v:  # closing the path with ends u,v
                    if plen[u] == n-1:
                        st[e] = IN
                        return 'HAM'
                    return False
                st[e] = IN
                L = plen[au] + plen[av] + 1
                oend[au], oend[av] = av, au
                plen[au] = plen[av] = L
                # anti-closure between new ends
                if L < n-1:
                    p = tuple(sorted((au, av)))
                    if p in eidx and st[eidx[p]] == UNK:
                        todo.append((eidx[p], OUT))
            else:
                st[e] = OUT
            for x in (u, v):
                nin = sum(1 for f in inc[x] if st[f] == IN)
                nout = sum(1 for f in inc[x] if st[f] == OUT)
                need, avail = 2 - nin, 3 - nin - nout
                if need > avail: return False
                if need == avail and need > 0:
                    for f in inc[x]:
                        if st[f] == UNK: todo.append((f, IN))
                if nin > 2: return False
        return True

    def solve(st, oend, plen):
        nonlocal nodes
        nodes += 1
        if nodes > limit_nodes: raise RuntimeError("node limit")
        be = -1
        for v in range(n):
            nin = sum(1 for f in inc[v] if st[f] == IN)
            if nin == 1:
                for f in inc[v]:
                    if st[f] == UNK: be = f; break
                if be >= 0: break
        if be < 0:
            for f in range(m):
                if st[f] == UNK: be = f; break
        if be < 0:
            return False  # fully decided but never closed a HC
        for val in (IN, OUT):
            st2, oe2, pl2 = st[:], oend[:], plen[:]
            r = propagate(st2, oe2, pl2, [(be, val)])
            if r == 'HAM': return (st2)
            if r:
                r2 = solve(st2, oe2, pl2)
                if r2 is not False: return r2
        return False

    r = solve([UNK]*m, list(range(n)), [0]*n)
    if r is False:
        return False, None
    chosen = [edges[i] for i in range(m) if r[i] == IN]
    # rebuild cycle order for reporting
    nbr = {v: [] for v in range(n)}
    for a, b in chosen: nbr[a].append(b); nbr[b].append(a)
    cyc = [0]; prev = None
    while True:
        nxt = [w for w in nbr[cyc[-1]] if w != prev]
        if not nxt: break
        w = nxt[0]
        if w == 0: break
        prev = cyc[-1]; cyc.append(w)
    return True, cyc

def main():
    if len(sys.argv) != 2:
        print("usage: verify.py certificate.txt"); sys.exit(2)
    n, adj = read_graph(sys.argv[1])
    print(f"n = {n}")
    ok, msg = check_cubic(n, adj); print(f"cubic: {msg}")
    if not ok: print("FAIL (not cubic)"); sys.exit(1)
    ok, msg, _ = check_bipartite(n, adj); print(f"bipartite: {msg}")
    if not ok: print("FAIL (not bipartite)"); sys.exit(1)
    ok, msg, G = check_planar(n, adj); print(f"planar: {msg}")
    if not ok: print("FAIL (not planar)"); sys.exit(1)
    ok, msg = check_3connected(G); print(f"3-connected: {msg}")
    if not ok: print("FAIL (not 3-connected)"); sys.exit(1)
    has1, cyc1 = ham_sat(n, adj)
    print(f"SAT hamiltonicity: {'HAMILTONIAN' if has1 else 'UNSAT (no Hamiltonian cycle)'}")
    has2, cyc2 = ham_backtrack(n, adj)
    print(f"backtrack hamiltonicity: {'HAMILTONIAN' if has2 else 'no Hamiltonian cycle'}")
    if has1 != has2:
        print("FAIL (methods disagree — verifier bug, investigate)"); sys.exit(1)
    if has1:
        print(f"hamiltonian cycle: {cyc1}")
        print("FAIL — graph is in the Barnette class but IS Hamiltonian (conjecture holds here)")
        sys.exit(1)
    print("PASS — counterexample to Barnette's conjecture: 3-connected cubic planar bipartite, non-Hamiltonian (certified by SAT and backtracking independently)")
    sys.exit(0)

if __name__ == "__main__":
    main()
