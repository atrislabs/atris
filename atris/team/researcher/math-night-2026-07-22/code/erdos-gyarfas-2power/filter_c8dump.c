/* filter.c — stream graph6 on stdin, decide existence of simple cycles of
 * exact lengths 4, 8, 16 (powers of 2 that fit in n<=31 for cubic graphs).
 * Prints graph6 lines of graphs having NO cycle of length 4, 8, or 16.
 * Stats to stderr: total, no-C4, no-C4&C8, survivors (no C4/C8/C16).
 *
 * Exact method: for each start vertex s (canonical minimum of the cycle),
 * DFS over simple paths using only vertices >= s, close back to s at exactly
 * L edges. BFS-distance pruning (remaining steps < dist back to s => prune),
 * parity pruning ((rem - dist) must be even in bipartite-free sense? NO —
 * not valid in general graphs, omitted). Mirrors verify.py exactly.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>

#define MAXV 62
static int n;
static int deg[MAXV];
static int adj[MAXV][MAXV]; /* adjacency lists */
static uint64_t nbr[MAXV];  /* neighbor bitmasks */

/* parse graph6 (short form, n <= 62). returns 0 on success */
static int parse_g6(const char *s) {
    int i, j, k;
    const unsigned char *p = (const unsigned char *)s;
    if (*p == '>') { /* skip header if present */
        if (strncmp((const char*)p, ">>graph6<<", 10) == 0) p += 10; else return -1;
    }
    if (*p < 63 || *p == 126) return -1;
    n = *p - 63; p++;
    if (n > MAXV) return -1;
    memset(deg, 0, sizeof deg);
    memset(nbr, 0, sizeof nbr);
    int nbits = n * (n - 1) / 2;
    int bit = 0;
    unsigned char c = 0;
    for (j = 1; j < n; j++) {
        for (i = 0; i < j; i++) {
            if (bit % 6 == 0) {
                c = *p++;
                if (c < 63 || c > 126) return -1;
                c -= 63;
            }
            if (c & (1 << (5 - (bit % 6)))) {
                adj[i][deg[i]++] = j;
                adj[j][deg[j]++] = i;
                nbr[i] |= 1ULL << j;
                nbr[j] |= 1ULL << i;
            }
            bit++;
        }
    }
    (void)nbits;
    return 0;
}

/* BFS distances from s within allowed mask */
static int dist[MAXV];
static void bfs(int s, uint64_t allowed) {
    int q[MAXV], head = 0, tail = 0, v, i, w;
    for (v = 0; v < n; v++) dist[v] = 1000;
    dist[s] = 0; q[tail++] = s;
    while (head < tail) {
        v = q[head++];
        for (i = 0; i < deg[v]; i++) {
            w = adj[v][i];
            if ((allowed >> w) & 1 && dist[w] == 1000) {
                dist[w] = dist[v] + 1;
                q[tail++] = w;
            }
        }
    }
}

/* exact: does graph contain a simple cycle of exactly L edges? */
static int path[70], iterpos[70];
static uint64_t onpath;
static int has_cycle(int L) {
    int s;
    for (s = 0; s + L <= n; s++) {
        uint64_t allowed = ~0ULL << s; /* vertices >= s */
        bfs(s, allowed);
        int depth = 0;          /* edges used so far == path length - 1 */
        path[0] = s; iterpos[0] = 0;
        onpath = 1ULL << s;
        while (depth >= 0) {
            int v = path[depth];
            if (iterpos[depth] >= deg[v]) {
                onpath &= ~(1ULL << v);
                depth--;
                continue;
            }
            int w = adj[v][iterpos[depth]++];
            if (w < s) continue;
            int rem = L - depth - 1; /* edges remaining after stepping to w */
            if (w == s) {
                if (rem == 0) return 1;
                continue;
            }
            if ((onpath >> w) & 1) continue;
            if (rem == 0) continue;
            if (dist[w] > rem) continue;
            depth++;
            path[depth] = w;
            iterpos[depth] = 0;
            onpath |= 1ULL << w;
        }
        /* note: onpath cleanup handled by loop */
    }
    return 0;
}

int main(int argc, char **argv) {
    char line[4096];
    long total = 0, noc4 = 0, noc8 = 0, noc16 = 0, noc32 = 0;
    int verbose = (argc > 1 && strcmp(argv[1], "-v") == 0);
    while (fgets(line, sizeof line, stdin)) {
        size_t len = strlen(line);
        while (len && (line[len-1] == '\n' || line[len-1] == '\r')) line[--len] = 0;
        if (!len) continue;
        if (parse_g6(line) != 0) { fprintf(stderr, "PARSE-ERROR: %s\n", line); exit(3); }
        total++;
        if (verbose) {
            int c4 = has_cycle(4), c8 = has_cycle(8);
            int c16 = (n >= 16) ? has_cycle(16) : 0;
            printf("%s %d %d %d\n", line, c4, c8, c16);
            continue;
        }
        if (has_cycle(4)) continue;
        noc4++;
        if (has_cycle(8)) continue;
        noc8++;
        { printf("%s\n", line); fflush(stdout); } if (16 <= n && has_cycle(16)) continue;
        noc16++;
        if (32 <= n && has_cycle(32)) continue;
        noc32++;
        printf("%s\n", line);
        fflush(stdout);
    }
    fprintf(stderr, "STATS total=%ld noC4=%ld noC4C8=%ld noC4C8C16=%ld noC4C8C16C32=%ld\n",
            total, noc4, noc8, noc16, noc32);
    return 0;
}
