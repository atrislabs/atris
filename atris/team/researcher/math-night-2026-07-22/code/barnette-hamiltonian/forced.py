#!/usr/bin/env python3
"""
Edge-force analysis: for each edge e of a Barnette-class graph,
  dead      = no Hamiltonian cycle contains e      (IN-query UNSAT)
  mandatory = every Hamiltonian cycle contains e   (OUT-query UNSAT)
Either would give a Tutte-style fragment for assembling a counterexample
(glue three around a central vertex). Prints any hits loudly.

Usage: forced.py cert1.txt [...]   or   forced.py --pc file.pc  (planar_code)
"""
import sys
import verify
from kelmans import ham_with

def analyze(n, adj, name):
    edges = sorted(set(tuple(sorted((v, w))) for v in adj for w in adj[v]))
    dead, mandatory = [], []
    for e in edges:
        if not ham_with(n, adj, [e], []):
            dead.append(e)
        if not ham_with(n, adj, [], [e]):
            mandatory.append(e)
    if dead:      print(f"*** DEAD EDGES in {name} (n={n}): {dead}")
    if mandatory: print(f"*** MANDATORY EDGES in {name} (n={n}): {mandatory}")
    return dead, mandatory

def read_pc(path):
    data = open(path, 'rb').read()
    i = 0
    if data.startswith(b'>>'):
        i = data.index(b'<<') + 2
    while i < len(data):
        n = data[i]; i += 1
        adj = {v: set() for v in range(n)}
        for v in range(n):
            while data[i] != 0:
                adj[v].add(data[i]-1); i += 1
            i += 1
        yield n, adj

def main():
    args = sys.argv[1:]
    tot_dead = tot_mand = graphs = 0
    if args and args[0] == '--pc':
        for idx, (n, adj) in enumerate(read_pc(args[1])):
            d, m = analyze(n, adj, f"{args[1]}#{idx}")
            tot_dead += len(d); tot_mand += len(m); graphs += 1
    else:
        for path in args:
            n, adj = verify.read_graph(path)
            d, m = analyze(n, adj, path)
            tot_dead += len(d); tot_mand += len(m); graphs += 1
    print(f"analyzed {graphs} graphs: dead={tot_dead} mandatory={tot_mand}")

if __name__ == "__main__":
    main()
