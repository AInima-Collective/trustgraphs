from tg import *
def A(i): return '0x'+format(i,'040x')

def community(h=10, dense=True):
    out={}; seed=A(1); mem=[A(100+i) for i in range(h)]
    out[seed]={m:50*S for m in mem}
    for i,m in enumerate(mem):
        out[m]={mem[(i+1)%h]:50*S}
        if dense: out[m][seed]=50*S
    return out, seed, mem

def add_socks(out,n,base=900000):
    socks=[A(base+i) for i in range(n)]
    for i,s in enumerate(socks): out[s]={socks[(i+1)%n]:50*S}
    return socks

print("P14 vs the multiplier bug — outsider bloc share at trust_share = 0.15")
print("(the mass the multiplier invents is honest-side flow, so it *hides* the open gate)\n")
for dense,label in [(True,'seed-reciprocating community'),(False,'chain community (no back-vouch to seed)')]:
    print(f"  {label}")
    print(f"    {'socks':>6} {'mult=2 (shipped)':>18} {'mult=1 (conserving)':>21} {'mult=1 + F15':>14}")
    for n in [10,50,200,1000]:
        row=[]
        for mult,f15 in [(2.0,False),(1.0,False),(1.0,True)]:
            out,seed,mem=community(dense=dense); socks=add_socks(out,n)
            cfg=Cfg(trust_share=0.15, trust_multiplier=mult, seeds={seed}, f15=f15)
            sc=calculate(graph_nodes(out),out,cfg)
            row.append(pct(sum(sc.get(s,0) for s in socks)))
        print(f"    {n:>6} {row[0]:>17.2f}% {row[1]:>20.2f}% {row[2]:>13.2f}%")
    print()

print("Convergence — does the iteration ever reach tolerance?")
print(f"  {'multiplier':>11} {'d*mult':>8} {'iterations':>11} {'converged':>10}")
for mult in [1.0,1.1,1.17,1.2,2.0,4.0]:
    out,seed,mem=community(); add_socks(out,10)
    cfg=Cfg(trust_share=1.0, trust_multiplier=mult, seeds={seed})
    _,it,conv=calculate(graph_nodes(out),out,cfg,return_iters=True)
    print(f"  {mult:>11.2f} {0.85*mult:>8.3f} {it:>11} {str(conv):>10}")

print("\nDoes the answer depend on max_iterations when it never converges?")
out,seed,mem=community(); add_socks(out,10)
for mi in [50,100,200,400]:
    cfg=Cfg(trust_share=1.0, trust_multiplier=2.0, seeds={seed}, max_iterations=mi)
    sc=calculate(graph_nodes(out),out,cfg)
    print(f"  max_iterations={mi:>4}  seed={pct(sc[seed]):.4f}%  member0={pct(sc[mem[0]]):.4f}%")
