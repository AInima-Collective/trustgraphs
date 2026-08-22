"""Candidate designs for negative vouching, each measured rather than argued.

All share one shape: an accusation's force is its AUTHOR'S standing, so the accusation
weight is itself an output of the metric. That makes the whole thing a fixed point, solved
by an outer loop (rank -> recompute discounts -> rank), damped for stability.
"""
from sparse import rank

def evidence_discount(pos, neg, standing, lam=1.0, maxw=10.0):
    """Weighted-evidence discount: what share of the standing-weighted evidence about v is positive.
    d_v = P_v / (P_v + lam * A_v).  Scale-free, always in (0,1], never negative."""
    P, A = {}, {}
    for a, es in pos.items():
        s = standing.get(a, 0.0)
        for t, w in es.items():
            if t != a: P[t] = P.get(t, 0.0) + s * (w / maxw)
    for a, es in neg.items():
        s = standing.get(a, 0.0)
        for t, w in es.items():
            if t != a: A[t] = A.get(t, 0.0) + s * (w / maxw)
    out = {}
    for v in set(P) | set(A):
        p, n = P.get(v, 0.0), A.get(v, 0.0)
        out[v] = 1.0 if (p + lam * n) <= 0 else p / (p + lam * n)
    return out

def solve(nodes, pos, neg, seeds, mode='none', lam=1.0, outer=12, relax=0.5, **kw):
    """mode: none | inbound | outflow | both | subtractive"""
    if mode == 'subtractive':
        signed = {a: dict(es) for a, es in pos.items()}
        for a, es in neg.items():
            for t, w in es.items(): signed.setdefault(a, {})[t] = -w
        return rank(nodes, signed, seeds, **kw), None
    standing = rank(nodes, pos, seeds, **kw)
    if mode == 'none':
        return standing, None
    disc = None
    for _ in range(outer):
        d = evidence_discount(pos, neg, standing, lam)
        if disc is None: disc = d
        else: disc = {k: (1 - relax) * disc.get(k, 1.0) + relax * d.get(k, 1.0) for k in set(disc) | set(d)}
        inb = disc if mode in ('inbound', 'both') else None
        outf = disc if mode in ('outflow', 'both') else None
        standing = rank(nodes, pos, seeds, inbound_discount=inb, outflow_penalty=outf, **kw)
    return standing, disc
