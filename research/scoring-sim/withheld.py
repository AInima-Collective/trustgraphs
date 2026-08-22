"""Same engine, but the mass a complaint destroys is TRACKED rather than renormalised away.
It sits in a 'withheld' slot that counts in the denominator and receives no payout."""
from collections import deque
from sparse import bfs

def rank_wh(nodes, outgoing, seeds, damping=0.85, decay=0.8, iters=300, tol=1e-13,
            inbound_discount=None, withhold=True):
    nodes=list(nodes); seeds=set(seeds)
    dist=bfs(outgoing,seeds); reach=set(dist)
    init={v:(1.0/len(seeds) if v in seeds else 0.0) for v in nodes}
    cur=dict(init); wh=0.0
    rows={}
    for a,es in outgoing.items():
        tot=sum(w for t,w in es.items() if t!=a and w>0)
        if tot<=0: continue
        d=decay**dist[a] if a in dist else 0.0
        if d==0: continue
        rows[a]=[(t,(w/tot)*d) for t,w in es.items() if t!=a and w>0]
    for _ in range(iters):
        new={v:(1-damping)*init[v] for v in nodes}; nwh=0.0
        for a,row in rows.items():
            ca=cur.get(a,0.0)
            if ca==0: continue
            for t,coef in row:
                if t not in reach: continue
                add=damping*ca*coef
                if inbound_discount:
                    d=inbound_discount.get(t,1.0)
                    if withhold: nwh+=add*(1-d)
                    add*=d
                new[t]=new.get(t,0.0)+add
        delta=max(abs(new[v]-cur[v]) for v in nodes)
        cur=new; wh=nwh
        if delta<tol: break
    tot=sum(cur.values())+(wh if withhold else 0.0)
    out={k:(v/tot if tot else 0.0) for k,v in cur.items()}
    return out, (wh/tot if tot else 0.0)
