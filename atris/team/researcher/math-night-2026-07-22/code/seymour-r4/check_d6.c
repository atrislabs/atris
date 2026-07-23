/* Independent Seymour second-neighborhood checker over digraph6 input.
 * Reads digraph6 lines (from nauty's directg -o) on stdin, n <= 30.
 * For each digraph: counterexample iff EVERY vertex v has |N++(v)| < |N+(v)|.
 * Prints any counterexample loudly; prints totals at the end.
 * No 2-cycle / loop check needed for directg -o output, but we check anyway
 * (cheap) so the tool stands alone as a verifier.
 */
#include <stdio.h>
#include <stdint.h>
#include <string.h>

int main(void) {
    char line[1 << 12];
    uint64_t total = 0, cex = 0, badformat = 0, digons = 0;
    while (fgets(line, sizeof line, stdin)) {
        char *p = line;
        if (*p == '&') p++;             /* digraph6 header */
        else { badformat++; continue; }
        int n = *p - 63; p++;
        if (n < 1 || n > 30) { badformat++; continue; }
        uint32_t row[30];
        memset(row, 0, sizeof row);
        int nbits = n * n, bit = 0;
        for (; bit < nbits; p++) {
            int c = *p;
            if (c < 63 || c > 126) { break; }
            int v = c - 63;
            for (int k = 5; k >= 0 && bit < nbits; k--, bit++) {
                if ((v >> k) & 1) {
                    int i = bit / n, j = bit % n;
                    row[i] |= (1u << j);
                }
            }
        }
        if (bit < nbits) { badformat++; continue; }
        total++;
        /* loop / digon check */
        int ok = 1;
        for (int i = 0; i < n && ok; i++) {
            if (row[i] & (1u << i)) ok = 0;
            for (int j = i + 1; j < n; j++)
                if ((row[i] >> j & 1) && (row[j] >> i & 1)) { ok = 0; break; }
        }
        if (!ok) { digons++; continue; }
        /* Seymour check */
        int allviolate = 1;
        for (int v = 0; v < n; v++) {
            uint32_t Np = row[v];
            uint32_t Npp = 0, t = Np;
            while (t) { int u = __builtin_ctz(t); t &= t - 1; Npp |= row[u]; }
            Npp &= ~(Np | (1u << v));
            if (__builtin_popcount(Npp) >= __builtin_popcount(Np)) { allviolate = 0; break; }
        }
        if (allviolate) {
            cex++;
            printf("COUNTEREXAMPLE (digraph6): %s", line);
            fflush(stdout);
        }
    }
    fprintf(stderr, "checked=%llu counterexamples=%llu digon_or_loop=%llu badformat=%llu\n",
            (unsigned long long)total, (unsigned long long)cex,
            (unsigned long long)digons, (unsigned long long)badformat);
    return cex ? 10 : 0;
}
