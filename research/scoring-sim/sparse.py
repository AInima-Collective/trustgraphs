"""Sparse float engine with the same semantics as pagerank.rs, plus negative-vouch variants.
Validated against the integer port (tg.py) on small graphs."""
from collections import deque

def bfs(outgoing, seeds):
    dist, q = {}, deque()
    for s in seeds:
        if s not in dist: dist[s]=0; q.append(s)
    while q:
        c=q.popleft(); d=dist[c]
        for nb in outgoing.get(c,{}):
            if nb not in dist: dist[nb]=d+1; q.append(nb)
    return dist

def rank(nodes, outgoing, seeds, damping=0.85, decay=0.8, trust_share=1.0,
         multiplier=1.0, iters=200, tol=1e-12, gated=True,
         inbound_discount=None, outflow_penalty=None):
    """gated=True is the reachability-gated endowment (the backport).
    inbound_discount[v] in [0,1]: multiplies every contribution ARRIVING at v.
    outflow_penalty[v] in [0,1]: multiplies everything v passes ON."""
    nodes=list(nodes); seeds=set(seeds)
    dist=bfs(outgoing, seeds)
    reach=set(dist)
    regs=[v for v in nodes if v not in seeds and (v in reach or not gated)]
    init={}
    for v in nodes:
        if v in seeds: init[v]=trust_share/len(seeds)
        elif v in regs: init[v]=(1-trust_share)/len(regs) if regs else 0.0
        else: init[v]=0.0
    cur=dict(init)
    # precompute per-source normalised rows with decay
    rows={}
    for a,es in outgoing.items():
        tot=sum(w for t,w in es.items() if t!=a and w>0)
        if tot<=0: continue
        d=decay**dist[a] if a in dist else 0.0
        if d==0: continue
        m=multiplier if a in seeds else 1.0
        if outflow_penalty: d*= outflow_penalty.get(a,1.0)
        rows[a]=[(t, (w*m/tot)*d) for t,w in es.items() if t!=a and w>0]
    for _ in range(iters):
        new={v:(1-damping)*init[v] for v in nodes}
        for a,row in rows.items():
            ca=cur.get(a,0.0)
            if ca==0: continue
            for t,coef in row:
                if t not in reach and gated: continue
                add=damping*ca*coef
                if inbound_discount: add*=inbound_discount.get(t,1.0)
                new[t]=new.get(t,0.0)+add
        for v in nodes:
            if gated and v not in reach: new[v]=(1-damping)*init[v]
        delta=max(abs(new[v]-cur[v]) for v in nodes)
        cur=new
        if delta<tol: break
    tot=sum(cur.values())
    return {k:(v/tot if tot else 0.0) for k,v in cur.items()} 
