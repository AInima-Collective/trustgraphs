import csv
def load(path='otc.csv'):
    rows=[]
    for a,b,r,t in csv.reader(open(path)):
        rows.append((int(a),int(b),int(r),float(t)))
    return rows
def build(rows, mode='positive_only'):
    """mode: positive_only = today's mechanism (negatives are simply absent)."""
    pos, neg = {}, {}
    for a,b,r,t in rows:
        if a==b: continue
        if r>0: pos.setdefault(a,{})[b]=float(r)
        elif r<0: neg.setdefault(a,{})[b]=float(-r)
    return pos, neg
def nodes_of(*graphs):
    ns=set()
    for g in graphs:
        for a,es in g.items(): ns.add(a); ns.update(es)
    return sorted(ns)
