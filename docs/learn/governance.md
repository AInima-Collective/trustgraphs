# How the rules change

Rules that give out money and votes will eventually need updating, and "who gets to
change the scoring rules?" is its own attack surface. If an insider could quietly retune
the algorithm, every guarantee on the other pages would be worthless. This page explains
how trustgraphs is designed to change without anyone moving the goalposts on you.

## Versions are sealed

A published version of the rules is never edited. Changes ship as a new version alongside
the old one, and everyone can see both. There is no "same rules, silently different
behavior": if the scoring you signed up for changes, it changes under a new version you
can point at, compare, and choose to follow or not.

## Small dials move fast, big changes move slow

Not every change is the same size, so not every change takes the same path:

- **Small dials.** Routine tuning (adjusting a weight, rotating a seed account) happens
  within hard, pre-agreed limits after a short delay. The limits are checked by the
  contracts themselves, so "routine tuning" can't smuggle in a rewrite.
- **Big changes.** Changing the algorithm itself requires a public dress rehearsal and a
  long waiting period, so nobody wakes up to a different scoring system.

## See the impact before it lands

A proposed rules change isn't just described, it's demonstrated: the new rules score
everyone in parallel with the old ones, so you can see exactly how the change would move
each account's score before it takes effect. You judge the change by its actual effect on
the actual scoreboard, not by its pitch.

## Exit before effect

No change takes effect before the people affected have had time to object, switch
versions, or leave. The waiting periods exist precisely so that exit is always possible
first: a community that dislikes where the rules are going can walk away with its history
intact, and that standing threat is itself what keeps rule-changers honest.

## The emergency brake

Genuine bugs happen, so an emergency brake exists. But it is deliberately one-directional:
it can only stop the machine, never change the rules. An emergency can pause scoring; it
cannot be used as a fast lane to push through a change that would otherwise have to wait.

## What's running today

One honest caveat: only part of this is running today. Sealed, governed parameter
versions are built, including the preview that shows how a proposed change would move
everyone's scores before it takes effect. The rest of the machinery, including the slow
path for changing the algorithm itself, is **designed but not yet implemented**. The full
design is in [`UPGRADE_GOVERNANCE.md`](../../research/UPGRADE_GOVERNANCE.md).

---

Next: [Honest limits](./limits.md), the things no amount of governance design solves.
