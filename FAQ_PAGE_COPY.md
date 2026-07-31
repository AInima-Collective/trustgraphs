# trustgraphs FAQ page copy

Route `/faq`, linked from the footer. `[brackets]` are design direction, not copy.
Same voice rules as the landing page: short declaratives, no em-dashes, no jargon before
it's defined.

---

**Page title:** Questions

**Standfirst:** What people ask before they trust a scoreboard.

`[one column, ruled rows, questions open on click. no hero.]`

**Question groups**, as headings and as the nav links above them: Basics · Trust and gaming ·
Running a network · Status

`[they were only ever `##` headings in this file, which is document structure rather than
declared copy. They ship as three strings each: the heading, the nav link, and the section's
assistive label.]`

**Group nav, above the questions (assistive):** Question groups

**Permalink on each answer (assistive):** Link to this answer: <the question>

---

## Basics

**What is an attestation?**
A signed public statement about someone, recorded on-chain through the Ethereum Attestation
Service. A vouch is one kind. You can revoke it later.

**Who picks the starting accounts?**
Your community does, when the network is created. They anchor the whole graph, so choosing
them well is the real work. Changing them later is a settings change only the network’s
admin wallet can make.

`["Everything downstream is math" was refuted twice over. The seed set lives inside the
params commitment, and setParamsHash is held by the admin wallet from birth with no
timelock, so the seeds can be re-pinned for the next round. And setZkVerifier sits with the
same wallet, so downstream of the seed pick is a key that can replace the thing checking the
maths. The wizard already concedes the first half: "Changing this list later means editing
your network's settings by hand."]`

**How often do scores update?**
In rounds. Each round freezes the set of vouches at a cut-off, someone proves the new
scores, and the result goes on-chain. Every network sets its own pace, and a settled round is never recalculated as long as your
network keeps a schedule.

---

## Trust and gaming

**Can someone buy a high score?**
Not with money. Buying score means getting genuinely trusted people to vouch for you. What
no algorithm stops is a trusted person vouching badly, which is a problem every community
already has.

**Why don’t bot armies work?**
Score comes from trust flowing out of the starting accounts. A thousand bots vouching for
each other form an island with lots of arrows and nothing flowing in, so none of those
vouches earns any trust. They do still land on the scoreboard. Every account that is not one
of your starting accounts gets an equal slice of whatever head start you did not reserve
for them, and the create form reserves 15% by default, so a big enough island can hold a
real share. Set “Head start for your starting accounts” to 100% and an island nobody
vouched for from outside holds nothing.

**Is my data private?**
No. Vouches, rules, code, and scores are all public. That is what makes the scoreboard
checkable by anyone.

**Then what does the zero-knowledge proof hide?**
Nothing. It isn’t there for privacy. It’s there so a whole scoreboard can be verified in
one cheap on-chain check instead of everyone recomputing millions of scores.

**How do you know a prover didn’t leave someone out?**
The chain keeps a running commitment to every attestation as it lands. A proof only
verifies if it consumed exactly that set, so a prover can’t quietly drop the vouches they
dislike or add ones that never happened.

---

## Running a network

**Who can create one?**
Anyone. It takes one transaction and nobody approves it.

**What does it cost?**
Proving costs real money, so each network has a tank to pay whoever produces its
scoreboard, once someone sets its per-round limit. Networks we curate will be proven at our
expense. Pricing for everyone else is still being worked out.

**Do I have to run a server?**
Only if nobody else proves your rounds. Proving is permissionless, so anyone can freeze a
round and land the result, and no operator can lock you out. Today that mostly means you or
us: a tank cannot pay a bounty until someone sets its per-round limit with a direct
contract call, and the networks we curate will be proven at our expense. If every machine we
run vanished, anyone could recompute the scores of a network created through the app from
what is on the chain, and prove them.

**Can I use the scores somewhere else?**
Yes. A vouching network’s scoreboard downloads as CSV or JSON, and any contract can check
one account’s score against the on-chain root, given the score and its proof.

---

## Status

**Is this ready for production?**
No. The proof loop is built and runs end to end on a test chain, though the on-chain proof
check is still a stand-in and no real proof has been produced yet. The pieces around it are
not finished. A network created through the app is governed by one wallet: the timelock
that should hold those powers exists but is not wired up yet. More attestation sources are
in progress.

**Has it been audited?**
Not by an outside firm. Point a network at something you can afford to get wrong.

**Where do I read the details?**
The code and the design docs are open. Start with the plain-language explainer, then the
algorithm spec.

`[link out to the repo, docs/ELI5.md, docs/ALGORITHM.md]`
