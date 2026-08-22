"""What a network is choosing when it sets the complaint weight.

Four things move together as the weight rises: how much a single justified complaint
registers, how much a single unjustified one costs its victim, what a minority bloc can
do, and how much of the pool goes unspent.
"""
from withheld import rank_wh
from neg import evidence_discount

SEED='seed'; MEM=[f'm{i}' for i in range(9)]
def world(socks_for=None, n_socks=0):
    o={SEED:{m:1.0 for m in MEM}}
    for m in MEM: o[m]={x:1.0 for x in MEM+[SEED] if x!=m}
    ss=[]
    if socks_for:
        ss=[f'sock{i}' for i in range(n_socks)]
        for s in ss: o[socks_for][s]=1.0; o[s]={socks_for:1.0}
    return o, ss

def solve(o, neg, lam):
    ns=sorted(set([SEED])|set(o)|{t for es in o.values() for t in es})
    sc,_=rank_wh(ns,o,{SEED}); wh=0.0
    if lam<=0: return sc,0.0
    for _ in range(14):
        d=evidence_discount(o,neg,sc,lam=lam,maxw=1.0)
        sc,wh=rank_wh(ns,o,{SEED},inbound_discount=d,withhold=True)
    return sc,wh

o,_=world()
base,_=solve(o,{},0)
b=base['m0']
print("A nine-member network. 'm0' is the account complaints are made about.\n")
print(f"  {'weight':>7} {'1 complaint':>13} {'3 complaints':>14} {'6 complaints':>14} {'8 of 8':>10} {'pool unspent':>14}")
print(f"  {'':>7} {'':>13} {'(a third)':>14} {'(two thirds)':>14} {'':>10} {'at 3 complaints':>16}")
for lam in [0,0.5,1,2,3,5,10,20,50]:
    row=[]
    for k in (1,3,6,8):
        neg={m:{'m0':1.0} for m in MEM[1:1+k]}
        sc,wh=solve(o,neg,lam)
        row.append(100*sc['m0'])
        if k==3: unspent=100*wh
    print(f"  {lam:>7} {row[0]:>12.2f}% {row[1]:>13.2f}% {row[2]:>13.2f}% {row[3]:>9.2f}% {unspent:>13.2f}%")
print(f"\n  (no complaints at all: {100*b:.2f}%)")

print("\n\nThe same dial, seen as griefing exposure: share of standing one member can remove.\n")
print(f"  {'weight':>7} {'removed by one member':>23} {'removed by a hundred fabricated accounts':>42}")
for lam in [0.5,1,2,3,5,10,20,50]:
    neg={ 'm1':{'m0':1.0} }
    sc,_=solve(o,neg,lam); one=100*(b-sc['m0'])/ (100*b) *100
    o2,ss=world(socks_for='m1', n_socks=100)
    ref,_=solve(o2,{},lam if lam>0 else 1)
    negs={s:{'m0':1.0} for s in ss}
    sc2,_=solve(o2,negs,lam)
    many=100*(ref['m0']-sc2['m0'])/ref['m0']
    print(f"  {lam:>7} {one:>22.1f}% {many:>41.1f}%")
