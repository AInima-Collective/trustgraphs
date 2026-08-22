"""Weighted-prior semantics, per packages/weighted-prior-core/src/rank.rs::next_iteration.
Float version (rounding is irrelevant to the qualitative question)."""
def wp_calculate(nodes, outgoing, prior, damping=0.85, iters=400):
    cur={v: prior.get(v,0.0) for v in nodes}
    tot=sum(cur.values()); cur={k:v/tot for k,v in cur.items()}
    pw=sum(prior.values())
    for _ in range(iters):
        new={v:0.0 for v in nodes}
        dangling=0.0
        for src in nodes:
            budget=damping*cur[src]
            row={t:w for t,w in outgoing.get(src,{}).items() if t!=src and w>0}
            if not row: dangling+=budget; continue
            den=sum(row.values())
            for t,w in row.items(): new[t]+=budget*w/den
        pb=(1-damping)+dangling
        for a,w in prior.items():
            if a in new: new[a]+=pb*w/pw
        cur=new
    return cur
