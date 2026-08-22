# Scoring simulation

The measurements behind [`../SCORING_NEXT_STEPS.md`](../SCORING_NEXT_STEPS.md). Pure `python3`,
no dependencies, no network except one dataset download.

`tg.py` is an integer-faithful port of `packages/pagerank-core/src/pagerank.rs::calculate_generic`,
written from the Rust rather than from any other model. It reproduces `test/golden/trust-graph.json`
byte-for-byte, which is the check that makes every other number here worth reading:

```
python3 -c "
from tg import *
A=lambda i: '0x'+format(i,'02x')*20
out={A(1):{A(2):50*S}, A(2):{A(3):75*S}, A(3):{A(1):90*S}}
sc,it,conv=calculate(graph_nodes(out), out, Cfg(seeds={A(1),A(3)}), return_iters=True)
print('iterations', it, 'converged', conv)"
# iterations 100 converged False   <- the shipped vector never settles
```

| file | what it measures |
|---|---|
| `tg.py` | the integer core, plus each candidate change behind a flag |
| `sparse.py` | float engine for graphs too large for the O(n²) core; agrees with `tg.py` to 1e-4 |
| `neg.py` | complaint scoring: the weight-of-evidence discount and its fixed-point solve |
| `withheld.py` | the withheld share, so removed standing is tracked instead of normalised away |
| `otc.py` | loader for the Bitcoin OTC signed web of trust |
| `p14.py`, `p14b.py` | the admission gate, and how the boost hides it |
| `probes.py` | founder floor, the cost of vouching, closed-loop gain, seed divisor |
| `probes2.py` | whether the closed-loop gain is about head count or the return path |
| `probes3.py` | the earned-balance bootstrap cliff, founder count, decay, boost |
| `tradeoff.py` | the damping × decay trade-off table |
| `complaint_weight.py` | what a network chooses when it sets the complaint weight |
| `wp.py`, `wp_probe.py` | the same probes against `weighted-prior-core` semantics |

The dataset is not vendored. Fetch it once:

```
curl -sL https://snap.stanford.edu/data/soc-sign-bitcoinotc.csv.gz | gunzip > otc.csv
```

Kumar, Spezzano, Subrahmanian & Faloutsos, Bitcoin OTC web of trust (Stanford SNAP).
5,881 accounts, 35,592 signed ratings, 10% negative.
